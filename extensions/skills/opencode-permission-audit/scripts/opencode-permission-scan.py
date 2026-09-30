#!/usr/bin/env python3
"""
opencode-permission-scan.py — extract every permission prompt (and its answer) that
opencode raised, per agent, with the exact script/pattern, the working directory, and
catalogs of denials / auto-rejects.

Reusable scanner. Point it at opencode's log + DB. Default target agent: git-manager.

WHY TWO SOURCES
  opencode 1.18.32 does NOT persist permission asks in its DB:
    - `permission` table = the durable allow-rule store (empty pre-V2.0.x), NOT a request log
    - no `question` table; 0 permission-typed rows in `event`; no permission part type
    - asks are an in-memory event-bus event (`permission.asked`) consumed by the TUI
  So:
    ASK (the prompt)      -> text log  ~/.local/share/opencode/log/opencode.log
                             `message=asking id=per_... permission=<kind> patterns=[...]`
    ANSWER (what you did) -> DB `part` tool outcome (status=completed => ran => yes;
                             state.error 'user rejected permission' => no;
                             'a rule which prevents' => denied-by-rule)
    CWD (working dir)     -> log `message=created ... directory=<path>` (also DB session.directory)
    AGENT attribution     -> log `message=stream ... session.id=ses_... agent=<agent>`
                             rolling anchor: asks carry only `run=`, and a run hosts many
                             interleaved sessions, so the agent is the agent of the most
                             recent `message=stream` line of the same run.

HONESTY: the log never records your click. The ANSWER here is INFERRED from the DB tool
outcome, exactly as stated in the task ("I obviously said yes if the tool proceeded to run").

USAGE
  python3 opencode-permission-scan.py                         # all agents, write temp file
  python3 opencode-permission-scan.py --agent git-manager      # one agent
  python3 opencode-permission-scan.py --agent git-manager dispatcher
  python3 opencode-permission-scan.py --out /tmp/perm.txt
  python3 opencode-permission-scan.py --export /tmp/perms.tsv  # raw rows (agent, script, answer)
  python3 opencode-permission-scan.py --include-foreign        # asks raised by other agents
                                                               # whose script mentions a target

--agent takes a LIST of agent names; omit it (or pass no names) to cover EVERY agent.
--export writes the raw rows machine-readably: .json => JSON array, .csv => CSV, else TSV.
  Columns: agent, ts, request_id, permission, cwd, session, outcome, answer, wasted_ms, script.
"""

import argparse
import bisect
import glob
import json
import os
import re
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict

HOME = os.path.expanduser("~")
DEFAULT_LOG = os.path.join(HOME, ".local/share/opencode/log/opencode.log")
DEFAULT_DB = os.path.join(HOME, ".local/share/opencode/opencode.db")
DEFAULT_AGENTS_DIR = os.path.join(HOME, ".config/opencode/agents")

# ---------------------------------------------------------------- line parsing

LINE_RE = re.compile(r"^timestamp=(\S+) level=(\w+) run=(\S+) message=(\S+)(.*)$")


def field(rest, key):
    """Extract key=value from a log line remainder.

    Handles opencode's two shapes: a bare token (`run=abc`) and a double-quoted,
    backslash-escaped value (`patterns="[\"a\",\"b\"]"`). Returns None if absent.
    """
    m = re.search(re.escape(key) + r"=", rest)
    if not m:
        return None
    i = m.end()
    if i < len(rest) and rest[i] == '"':
        j = i + 1
        buf = []
        while j < len(rest):
            c = rest[j]
            if c == "\\" and j + 1 < len(rest):
                buf.append(rest[j + 1])
                j += 2
                continue
            if c == '"':
                return "".join(buf)
            buf.append(c)
            j += 1
        return "".join(buf)
    return re.split(r"\s", rest[i:] + " ", maxsplit=1)[0]


def parse_patterns(raw):
    """patterns value is a JSON array of shell segments (already unescaped by field())."""
    if not raw:
        return []
    try:
        v = json.loads(raw)
        return v if isinstance(v, list) else [raw]
    except Exception:
        return [raw]


def read_log(path):
    """Yield (lineno, ts, run, kind, rest) for every parseable line."""
    with open(path, "r", errors="replace") as fh:
        for n, line in enumerate(fh, 1):
            m = LINE_RE.match(line)
            if m:
                yield n, m.group(1), m.group(3), m.group(4), m.group(5)


# ---------------------------------------------------------------- log scan

def scan_log(path, agents, all_agents):
    """Replay the log in order, maintaining a per-run rolling agent/session anchor.

    `agents` is a set of agent names to keep (empty when all_agents).
    """
    agents = agents or set()
    run_agent = {}          # run -> current agent (rolling)
    run_session = {}        # run -> current session
    sessions = {}           # ses_id -> {agent, directory, title, run, project}
    asks = []               # permission asks (id=per_)
    questions = []          # question-tool asks (id=que_)
    denies = []             # evaluated ... action.action=deny
    foreign = []            # asks whose script mentions the target but raised by another agent

    for lineno, ts, run, kind, rest in read_log(path):
        if kind == "stream":
            sid = field(rest, "session.id")
            ag = field(rest, "agent")
            if sid:
                run_session[run] = sid
            if ag:
                run_agent[run] = ag
        elif kind == "created":
            sid = field(rest, "id")
            if sid:
                sessions[sid] = {
                    "agent": field(rest, "agent"),
                    "directory": field(rest, "directory"),
                    "title": field(rest, "title"),
                    "run": run,
                    "project": field(rest, "projectID"),
                    "parent": field(rest, "parentID"),
                    "permission": field(rest, "permission"),
                }
        elif kind == "asking":
            rid = field(rest, "id") or ""
            agent = run_agent.get(run)
            rec = {
                "run": run,
                "ts": ts,
                "lineno": lineno,
                "request_id": rid,
                "session": run_session.get(run),
                "agent": agent,
                "permission": field(rest, "permission"),
                "patterns": parse_patterns(field(rest, "patterns")),
            }
            if rid.startswith("que_"):
                rec["questions"] = field(rest, "questions")
                questions.append(rec)
                continue
            asks.append(rec)
            # a foreign ask: mentions a target in its script but raised by another agent
            if not all_agents and agent not in agents:
                if any(any(t in s for t in agents) for s in rec["patterns"]):
                    foreign.append(rec)
        elif kind == "evaluated":
            if field(rest, "action.action") == "deny":
                denies.append({
                    "run": run,
                    "ts": ts,
                    "lineno": lineno,
                    "permission": field(rest, "permission"),
                    "pattern": field(rest, "pattern"),
                    "rule": field(rest, "action.pattern"),
                    "agent": run_agent.get(run),
                    "session": run_session.get(run),
                })
    return sessions, asks, questions, denies, foreign


# ---------------------------------------------------------------- DB scan

def db_query(db, sql):
    uri = "file:%s?mode=ro" % db
    out = subprocess.run(
        ["sqlite3", "-json", uri, sql],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        sys.stderr.write("sqlite3 error: %s\n" % out.stderr.strip())
        return []
    out = out.stdout.strip()
    return json.loads(out) if out else []


def classify_answer(err):
    if not err:
        return "yes (ran)"
    e = err.lower()
    if "the user rejected permission" in e:
        return "NO (rejected)"
    if "a rule which prevents" in e:
        return "no (denied by rule)"
    if "auto-reject" in e:
        return "NO (auto-rejected)"
    return None  # not a permission outcome


def scan_db(db, session_ids):
    """Fetch tool parts for the given sessions and classify each permission outcome."""
    if not session_ids:
        return [], []
    # chunk the IN-list to stay well under SQLite's expression limits
    ids = sorted(session_ids)
    parts = []
    CH = 400
    for i in range(0, len(ids), CH):
        chunk = ids[i:i + CH]
        inlist = ",".join("'%s'" % s for s in chunk)
        sql = (
            "select id, session_id, time_created, "
            "json_extract(data,'$.tool') as tool, "
            "json_extract(data,'$.state.status') as status, "
            "json_extract(data,'$.state.error') as error, "
            "substr(json_extract(data,'$.state.input'),1,600) as input "
            "from part where session_id in (%s) "
            "and json_extract(data,'$.type')='tool' "
            "order by time_created" % inlist
        )
        parts.extend(db_query(db, sql))
    rejected, denied = [], []
    for p in parts:
        ans = classify_answer(p.get("error"))
        if ans == "NO (rejected)":
            rejected.append(p)
        elif ans == "no (denied by rule)":
            denied.append(p)
    return parts, {"rejected": rejected, "denied": denied}


def catalog_all_permission_errors(db, limit=200):
    sql = (
        "select substr(json_extract(data,'$.state.error'),1,120) as err, count(*) as n "
        "from part where json_extract(data,'$.state.error') like '%%ermission%%' "
        "group by err order by n desc limit %d" % limit
    )
    return db_query(db, sql)


# ---------------------------------------------------------------- rendering

def _iso_ms(ts):
    """ISO8601 (with trailing Z) -> epoch milliseconds, or None."""
    try:
        from datetime import datetime
        return int(datetime.strptime(ts.replace("Z", "+0000"),
                                     "%Y-%m-%dT%H:%M:%S.%f%z").timestamp() * 1000)
    except Exception:
        return None


def answer_for_ask(ask, parts):
    """Best-effort: a permission-error tool part in the SAME session within 180s of the ask.

    opencode does not link the ask id to the tool call, so we time-correlate. Absent a
    rejection/denial in that window, the tool proceeded => the user allowed it.
    """
    t0 = _iso_ms(ask["ts"])
    ses = ask.get("session")
    for p in parts:
        if ses and p.get("session_id") != ses:
            continue
        err = p.get("error")
        ans = classify_answer(err)
        if ans in ("NO (rejected)", "no (denied by rule)", "NO (auto-rejected)"):
            tc = p.get("time_created")
            if t0 is None or tc is None or 0 <= (tc - t0) <= 180_000:
                return ans
    return "yes (tool proceeded)"


# ---------------------------------------------------------------- wasted time

def _fmt_dur(ms):
    """Human duration from milliseconds, or '?' when unknown."""
    if ms is None:
        return "?"
    t = int(round(ms / 1000.0))
    if t < 60:
        return "%.1fs" % (ms / 1000.0)
    m, s = divmod(t, 60)
    if m < 60:
        return "%dm%ds" % (m, s)
    h, m = divmod(m, 60)
    return "%dh%dm%ds" % (h, m, s)


def _median(xs):
    if not xs:
        return None
    s = sorted(xs)
    n = len(s)
    return float(s[n // 2]) if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2.0


def answer_bucket(ans):
    """Collapse an answer string to the metric bucket it belongs to."""
    if not ans:
        return None
    return "approved" if ans.startswith("yes") else "rejected"


def norm_outcome(ans):
    """Normalized verdict for the raw export: approved | denied | rejected."""
    if ans and ans.startswith("yes"):
        return "approved"
    if ans and "denied" in ans:
        return "denied"
    return "rejected"


def export_rows(path, rows):
    """Write raw rows machine-readably. .json => JSON, .csv => CSV, else TSV."""
    ext = os.path.splitext(path)[1].lower()
    if ext == ".json":
        with open(path, "w") as fh:
            json.dump(rows, fh, indent=2)
        return
    import csv
    delim = "," if ext == ".csv" else "\t"
    cols = ["agent", "ts", "request_id", "permission", "cwd", "session",
            "outcome", "answer", "wasted_ms", "script"]
    with open(path, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols, delimiter=delim,
                           extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow(r)


def global_bash_rules(path=None):
    """Global `permission.bash` from ~/.config/opencode/opencode.json.

    An agent's own map merges AFTER (and wins) the global config, so a leading agent
    catch-all silently shadows every global rule it does not restate.
    """
    path = path or os.path.join(HOME, ".config", "opencode", "opencode.json")
    try:
        with open(path) as fh:
            cfg = json.load(fh)
    except Exception:
        return []
    bash = (cfg.get("permission") or {}).get("bash") or {}
    return list(bash.items()) if isinstance(bash, dict) else []


def parse_agent_md_bash_map(path):
    """Extract the frontmatter `permission.bash` map from an installed agent .md.

    The header is GENERATED from extension.json at install time, so this reads the
    effective installed map. Returns {pattern: action} or None.
    """
    try:
        with open(path) as fh:
            txt = fh.read()
    except Exception:
        return None
    if not txt.startswith("---"):
        return None
    end = txt.find("\n---", 3)
    fm = txt[3:end if end != -1 else len(txt)]
    m = re.search(r"^\s*bash:\s*$", fm, re.M)
    if not m:
        return None
    rules = {}
    for line in fm[m.end():].splitlines():
        if not line.strip():
            continue
        ind = len(line) - len(line.lstrip())
        if ind <= 2:                      # left the bash block
            break
        mm = re.match(r"^\s*'?([^':]+?)'?\s*:\s*(allow|ask|deny)\s*$", line)
        if mm:
            rules[mm.group(1)] = mm.group(2)
    return rules or None


def load_agent_maps(agents, all_agents, agents_dir):
    """agent -> declared bash map, from the installed `<agents_dir>/<agent>.md`."""
    if all_agents or not agents:
        try:
            names = sorted(f[:-3] for f in os.listdir(agents_dir) if f.endswith(".md"))
        except Exception:
            names = []
    else:
        names = sorted(agents)
    out = {}
    for n in names:
        bmap = parse_agent_md_bash_map(os.path.join(agents_dir, n + ".md"))
        if bmap:
            out[n] = bmap
    return out


def deltas_for(asks_subset, parts):
    """Per prompt: ms from the ask to the NEXT ACTION in the same session.

    'Next action' = the earliest DB tool part recorded for that session strictly after the
    ask timestamp — i.e. how long the run sat stalled on your permission prompt before it
    resumed doing something. None when the ask has no attributable next action.
    """
    by_ses = defaultdict(list)
    for p in parts:
        tc = p.get("time_created")
        if tc:
            by_ses[p["session_id"]].append(tc)
    for k in by_ses:
        by_ses[k].sort()
    pairs = []
    for a in asks_subset:
        t0 = _iso_ms(a["ts"])
        ses = a.get("session")
        d = None
        if t0 is not None and ses in by_ses:
            arr = by_ses[ses]
            i = bisect.bisect_right(arr, t0)
            if i < len(arr):
                d = arr[i] - t0
        pairs.append((a, d))
    return pairs


def wasted_metrics(pairs, parts):
    """(count, sum_ms, median_ms) for the overall / approved / rejected buckets."""
    groups = {"overall": [], "approved": [], "rejected": []}
    for a, d in pairs:
        if d is None:
            continue
        groups["overall"].append(d)
        b = answer_bucket(answer_for_ask(a, parts))
        if b in groups:
            groups[b].append(d)
    return {k: (len(xs), sum(xs) if xs else None, _median(xs))
            for k, xs in groups.items()}


def render(agents, sessions, asks, questions, denies, foreign, parts, catalogs,
           all_agents, include_foreign, agents_dir):
    L = []
    A = L.append
    label = "ALL AGENTS" if all_agents else ",".join(sorted(agents))
    A("=" * 100)
    A("OPENCODE PERMISSION PROMPT REPORT")
    A("agent filter : %s" % ("(all agents)" if all_agents else label))
    A("log          : %s" % DEFAULT_LOG)
    A("db           : %s" % DEFAULT_DB)
    A("=" * 100)
    A("")
    A("NOTE: the log records the ASK; your ANSWER is inferred from the DB tool outcome")
    A("      (status=completed => the tool ran => you allowed it). opencode 1.18.32")
    A("      persists no ask rows and never logs your click.")
    A("")

    mine = asks if all_agents else [a for a in asks if a["agent"] in agents]
    pairs = deltas_for(mine, parts)
    dmap = {a["request_id"]: d for a, d in pairs}
    wm = wasted_metrics(pairs, parts)
    auto = [r for r in catalogs_all if "auto-reject" in (r.get("err") or "").lower()]

    tgt_sessions = {s: m for s, m in sessions.items()
                    if all_agents or m.get("agent") in agents}
    n_prompts = len(mine)
    n_sess = len(tgt_sessions)
    prompted_sess = {a["session"] for a in mine if a.get("session")} & set(tgt_sessions)
    pct_sess = (100.0 * len(prompted_sess) / n_sess) if n_sess else 0.0
    n_completed = sum(1 for p in parts if p.get("status") == "completed")
    n_rejected = len(catalogs.get("rejected", []))
    n_denied = len(catalogs.get("denied", []))

    def _summed(scope):
        _, tot, med = wm[scope]
        return "%s (median %s)" % (_fmt_dur(tot) if tot is not None else "—",
                                   _fmt_dur(med) if med is not None else "—")

    avg_session = None
    _, _tot, _ = wm["overall"]
    if prompted_sess and _tot is not None:
        avg_session = _tot / len(prompted_sess)

    # ---- HEADLINE METRICS (the requested table) ------------------------------
    A("-" * 100)
    A("SUMMARY")
    A("-" * 100)
    rows = [
        ("Metric", "Value"),
        ("Permission prompts (Section 1)", "%d" % n_prompts),
        ("  \u2192 total wasted time", _fmt_dur(_tot) if _tot is not None else "\u2014"),
        ("Sessions (Section 2)", "%d" % n_sess),
        ("  \u2192 pct of sessions with at least one", "%.1f%%" % pct_sess),
        ("  \u2192 avg wasted time per session",
         _fmt_dur(avg_session) if avg_session is not None else "\u2014"),
        ("DB tool parts scanned (Section 3)", "%d" % len(parts)),
        ("  \u2192 completed (allowed)", "%d" % n_completed),
        ("  \u2192 CRITICAL wasted time", _summed("approved")),
        ("  \u2192 rejected", "%d" % n_rejected),
        ("  \u2192 OK wasted time", _summed("rejected")),
        ("  \u2192 denied-by-rule", "%d" % n_denied),
        ("Deny-catalog rows (Section 4, all agents)", "%d" % len(denies)),
        ("Auto-rejects (Section 5)", "%d" % len(auto)),
    ]
    for k, v in rows:
        A("%s\t%s" % (k, v))
    A("")
    A("  CRITICAL wasted time = stall on prompts you APPROVED (pure overhead);")
    A("  OK wasted time = stall on prompts that were rejected/denied (justified).")
    A("")

    A("-" * 100)
    A("SECTION 0 — WASTED TIME  (prompt -> next action in the same session)")
    A("-" * 100)
    A("  scope      prompts   Wasted Sum       Wasted Median")
    for scope in ("overall", "approved", "rejected"):
        n, tot, med = wm[scope]
        A("  %-10s %-9d %-16s %s"
          % (scope, n, _fmt_dur(tot) if tot is not None else "\u2014",
             _fmt_dur(med) if med is not None else "\u2014"))
    A("")
    A("  Wasted = wall-clock the run sat stalled on a permission prompt before its next")
    A("  recorded action (DB tool part). approved = tool proceeded; rejected = any other")
    A("  outcome (rejected / denied-by-rule / auto-rejected).")
    A("")

    A("-" * 100)
    A("SECTION 1 — PERMISSION PROMPTS attributed to %s  (%d)"
      % (label, len(mine)))
    A("-" * 100)
    if not mine:
        A("  (none — no `message=asking` line attributed to this agent)")
    for a in mine:
        ses = a.get("session")
        cwd = sessions.get(ses, {}).get("directory") if ses else None
        A("")
        A("  %s  req=%s" % (a["ts"], a["request_id"]))
        A("    permission : %s" % a["permission"])
        A("    cwd        : %s" % (cwd or "?"))
        A("    session    : %s" % (ses or "?"))
        A("    answer     : %s" % answer_for_ask(a, parts))
        A("    wasted     : %s" % _fmt_dur(dmap.get(a["request_id"])))
        A("    script:")
        for seg in a["patterns"]:
            A("      $ %s" % seg)
    A("")

    if include_foreign:
        A("-" * 100)
        A("SECTION 1b — ASKS raised by OTHER agents whose script MENTIONS %s  (%d)"
          % (label, len(foreign)))
        A("-" * 100)
        for a in foreign:
            A("  %s  agent=%s req=%s cwd=%s" % (a["ts"], a["agent"], a["request_id"],
                                                sessions.get(a.get("session"), {}).get("directory", "?")))
            for seg in a["patterns"]:
                A("      $ %s" % seg)
        A("")

    A("-" * 100)
    A("SECTION 2 — SESSIONS matching %s  (%d)" % (label, len(tgt_sessions)))
    A("-" * 100)
    for s, m in sorted(tgt_sessions.items(), key=lambda kv: kv[1].get("run") or ""):
        A("  %s  agent=%-14s dir=%s" % (s, m.get("agent"), m.get("directory")))
        A("      title: %s" % m.get("title"))
    A("")

    A("-" * 100)
    A("SECTION 3 — ANSWER EVIDENCE from DB tool parts  (%d parts scanned)" % len(parts))
    A("-" * 100)
    A("  status=completed  : %d  (tool ran => you allowed)" % sum(1 for p in parts if p.get("status") == "completed"))
    A("  rejected          : %d" % len(catalogs.get("rejected", [])))
    A("  denied-by-rule    : %d" % len(catalogs.get("denied", [])))
    A("")
    for p in catalogs.get("rejected", []):
        A("  REJECTED  %s  tool=%s" % (p.get("time_created"), p.get("tool")))
        A("      input: %s" % (p.get("input") or "").replace("\n", " ")[:200])
    for p in catalogs.get("denied", []):
        A("  DENIED    %s  tool=%s" % (p.get("time_created"), p.get("tool")))
        A("      input: %s" % (p.get("input") or "").replace("\n", " ")[:200])
    A("")

    A("-" * 100)
    A("SECTION 4 — DENY CATALOG (from log `message=evaluated ... action.action=deny`)  (%d)"
      % len(denies))
    A("-" * 100)
    for d in denies:
        A("  %s  agent=%-14s perm=%-16s rule=%-24s  script=%s"
          % (d["ts"], d["agent"], d["permission"], d["rule"], d["pattern"]))
    A("")

    A("-" * 100)
    A("SECTION 5 — AUTO-REJECT CATALOG (DB parts with an auto-reject permission error)")
    A("-" * 100)
    if auto:
        for r in auto:
            A("  %6d  %s" % (r["n"], r["err"]))
    else:
        A("  (none found — opencode 1.18.32 does not log or persist auto-rejections;")
        A("   a non-interactive `ask` fails the call instead of recording an auto-reject)")
    A("")

    A("-" * 100)
    A("SECTION 6 — ALL permission-family DB error shapes (catalog)")
    A("-" * 100)
    for r in catalogs_all:
        A("  %6d  %s" % (r["n"], r["err"]))
    A("")

    A("-" * 100)
    A("SECTION 7 — AGENT BASH MAP & FIX SUGGESTION  (from %s)" % agents_dir)
    A("-" * 100)
    maps = load_agent_maps(agents, all_agents, agents_dir)
    if not maps:
        A("  (no installed agent .md with a bash map found in %s)" % agents_dir)
    for agent, bmap in sorted(maps.items()):
        catch = bmap.get("*")
        guard = [(p, a) for p, a in bmap.items() if a in ("ask", "deny") and p != "*"]
        A("")
        A("  agent=%s" % agent)
        A("    catch-all : %s" % (catch or "(none — unmatched falls to config/default)"))
        A("    entries   : %d  (allow %d / ask %d / deny %d)"
          % (len(bmap),
             sum(1 for a in bmap.values() if a == "allow"),
             sum(1 for a in bmap.values() if a == "ask"),
             sum(1 for a in bmap.values() if a == "deny")))
        if catch == "ask":
            A("    verdict   : DEFECT — catch-all is `ask`, so EVERY unnamed segment")
            A("                 prompts, and opencode evaluates a bash call as ONE unit:")
            A("                 one unnamed segment (echo/tail/rg/ls) asks the WHOLE call.")
            A("                 Non-interactively that ask auto-rejects => the call FAILS.")
        else:
            A("    verdict   : ok — catch-all is `%s`" % (catch or "absent"))
        missing = [(p, a) for p, a in global_bash_rules()
                   if p not in bmap and a in ("ask", "deny")]
        if missing and catch in ("ask", "allow"):
            A("    MISSING guardrails: global rules this map does NOT restate are")
            A("    shadowed by the catch-all — restate them LAST:")
            for p, a in missing:
                A("      %-30s : \"%s\"," % ('"%s"' % p, a))
        if catch == "ask":
            A("    suggested permission.bash (drop-in — guardrails LAST so they win):")
            A("      \"*\": \"allow\",")
            for p, a in guard:
                A("      %-30s : \"%s\"," % ('"%s"' % p, a))
            for p, a in missing:
                A("      %-30s : \"%s\"," % ('"%s"' % p, a))
        A("")
    A("")

    xrows = []
    for a in mine:
        ses = a.get("session")
        cwd = sessions.get(ses, {}).get("directory") if ses else None
        ans = answer_for_ask(a, parts)
        xrows.append({
            "agent": a.get("agent"),
            "ts": a["ts"],
            "request_id": a["request_id"],
            "permission": a.get("permission"),
            "cwd": cwd,
            "session": ses,
            "outcome": norm_outcome(ans),
            "answer": ans,
            "wasted_ms": dmap.get(a["request_id"]),
            "script": " ; ".join(a["patterns"]),
        })
    return "\n".join(L), xrows


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--agent", nargs="*", default=None,
                    help="agent name(s) to keep; omit (or pass none) for EVERY agent")
    ap.add_argument("--all-agents", action="store_true",
                    help="explicitly cover every agent (same as omitting --agent)")
    ap.add_argument("--include-foreign", action="store_true")
    ap.add_argument("--log", default=DEFAULT_LOG)
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--agents-dir", default=DEFAULT_AGENTS_DIR,
                    help="directory holding installed <agent>.md files (Section 7)")
    ap.add_argument("--out", default=None, help="output file (default: a temp file)")
    ap.add_argument("--export", default=None,
                    help="write raw rows (agent, script, answer) to .json/.csv/TSV")
    args = ap.parse_args()

    if not os.path.exists(args.log):
        sys.exit("log not found: %s" % args.log)

    agents = set(args.agent or [])
    all_agents = args.all_agents or not agents
    slug = "all" if all_agents else "+".join(sorted(agents))

    sessions, asks, questions, denies, foreign = scan_log(
        args.log, agents, all_agents)

    target_sessions = {s for s, m in sessions.items()
                       if all_agents or m.get("agent") in agents}
    parts, catalogs = scan_db(args.db, target_sessions)
    global catalogs_all
    catalogs_all = catalog_all_permission_errors(args.db)

    report, xrows = render(agents, sessions, asks, questions, denies, foreign,
                           parts, catalogs, all_agents, args.include_foreign,
                           args.agents_dir)

    if args.out:
        out = args.out
    else:
        fd, out = tempfile.mkstemp(prefix="opencode-perms-%s-" % slug,
                                   suffix=".txt", dir=tempfile.gettempdir())
        os.close(fd)
    with open(out, "w") as fh:
        fh.write(report)
    print(report[-4000:] if len(report) > 4000 else report)
    print("\n[written] %s  (%d bytes)" % (out, len(report)))

    if args.export:
        export_rows(args.export, xrows)
        print("[exported] %s  (%d rows)" % (args.export, len(xrows)))


if __name__ == "__main__":
    main()
