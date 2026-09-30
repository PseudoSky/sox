#!/usr/bin/env python3
"""
opencode-permission-scan.py — extract every permission prompt (and its answer) that
opencode raised, per agent, with the exact script/pattern, the working directory, and
catalogs of denials / auto-rejects. Rank agents against each other, inventory the
effective ruleset each agent ran under, and suggest the minimal `permission.bash`
change that removes the prompts.

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
    RULESET (per session) -> log `message=created ... permission="[{...}]"` — the agent's
                             effective bash map, no file read needed.

HONESTY: the log never records your click. The ANSWER here is INFERRED from the DB tool
outcome, exactly as stated in the task ("I obviously said yes if the tool proceeded to run").
Attribution confidence is HIGH only when every recent `message=stream` line in the ask's
`run` named the same agent; a long-lived run that hosted several agents yields LOW.

USAGE
  python3 opencode-permission-scan.py                          # every agent, temp file
  python3 opencode-permission-scan.py --agent git-manager
  python3 opencode-permission-scan.py --agent git-manager dispatcher
  python3 opencode-permission-scan.py --rank                    # leaderboard only
  python3 opencode-permission-scan.py --rank --format json
  python3 opencode-permission-scan.py --since 2026-09-29T00:00 --until 2026-09-30T12:00
  python3 opencode-permission-scan.py --split 2026-09-30T16:00   # before/after a change
  python3 opencode-permission-scan.py --out /tmp/perm.txt --export /tmp/perms.tsv
  python3 opencode-permission-scan.py --include-foreign           # asks raised by others
  python3 opencode-permission-scan.py --no-cache                  # ignore the log cache

--agent takes a LIST of agent names; omit it (or pass no names) to cover EVERY agent.
--since/--until window asks/denies/sessions (ISO8601; `Z` or local). --split splits the
leaderboard before/after an instant. --rank prints only the leaderboard. --format json
emits the structured result. --export writes raw rows: .json => JSON array, .csv => CSV,
else TSV. Columns: agent, ts, request_id, permission, cwd, session, outcome, answer,
wasted_ms, trigger, confidence, script.

REPORT SECTIONS
  SUMMARY · LEADERBOARD · 0 WASTED TIME · 1 PROMPTS · 1b FOREIGN · 2 SESSIONS
  3 ANSWER EVIDENCE · 4 DENY SUMMARY · 4b DENY CATALOG · 5 AUTO-REJECTS
  6 ERROR SHAPES · 7 BASH MAP & FIX SUGGESTION · 8 AGENT RULE INVENTORY
"""

import argparse
import bisect
import csv
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict, deque
from datetime import datetime

HOME = os.path.expanduser("~")
DEFAULT_LOG = os.path.join(HOME, ".local/share/opencode/log/opencode.log")
DEFAULT_DB = os.path.join(HOME, ".local/share/opencode/opencode.db")
DEFAULT_AGENTS_DIR = os.path.join(HOME, ".config/opencode/agents")
DEFAULT_CACHE_DIR = os.path.join(HOME, ".cache/opencode-permission-scan")
CONF_WINDOW = 8          # stream lines inspected for attribution confidence
CACHE_VERSION = 2        # bump when the scanned record shape changes

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


def _iso_ms(ts):
    """ISO8601 -> epoch milliseconds, or None. Accepts trailing Z and bare dates."""
    if not ts:
        return None
    t = ts.strip()
    if t.endswith("Z"):
        t = t[:-1] + "+0000"
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S%z",
                "%Y-%m-%dT%H:%M%z", "%Y-%m-%dT%H:%M:%S.%f",
                "%Y-%m-%dT%H:%M", "%Y-%m-%d"):
        try:
            return int(datetime.strptime(t, fmt).timestamp() * 1000)
        except Exception:
            continue
    return None


def read_log(path):
    """Yield (lineno, ts, run, kind, rest) for every parseable line."""
    with open(path, "r", errors="replace") as fh:
        for n, line in enumerate(fh, 1):
            m = LINE_RE.match(line)
            if m:
                yield n, m.group(1), m.group(3), m.group(4), m.group(5)


# ---------------------------------------------------------------- wildcard match

_WILD_CACHE = {}


def wild_match(pattern, s):
    """opencode's rule match: `*` matches any run; everything else is literal."""
    if pattern == "*":
        return True
    rx = _WILD_CACHE.get(pattern)
    if rx is None:
        esc = re.escape(pattern).replace(r"\*", ".*").replace(r"\?", ".")
        try:
            rx = re.compile("^" + esc + "$")
        except Exception:
            rx = re.compile("^" + re.escape(pattern) + "$")
        _WILD_CACHE[pattern] = rx
    return bool(rx.match(s))


# ---------------------------------------------------------------- log scan

def scan_log(path, agents, all_agents):
    """Replay the log in order, maintaining a per-run rolling agent/session anchor.

    Returns a JSON-serializable dict (cacheable):
      sessions    ses_id -> {agent, directory, title, run, project, parent, permission, time_created}
      asks        [ {run, ts, lineno, request_id, session, agent, permission, patterns, confidence} ]
      questions   question-tool asks (id=que_)
      denies      [ {run, ts, lineno, permission, pattern, rule, agent, session, confidence} ]
      allow_pats  "<agent>\\x1f<permission>" -> {winning_allow_pattern: count}   (excl. bare `*`)
    """
    run_window = defaultdict(lambda: deque(maxlen=CONF_WINDOW))
    run_session = {}
    sessions = {}
    asks, questions, denies = [], [], []
    allow_pats = defaultdict(Counter)

    for lineno, ts, run, kind, rest in read_log(path):
        if kind == "stream":
            sid = field(rest, "session.id")
            ag = field(rest, "agent")
            if sid:
                run_session[run] = sid
            if ag:
                run_window[run].append(ag)
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
                    "time_created": field(rest, "time.created"),
                }
        elif kind == "asking":
            rid = field(rest, "id") or ""
            win = run_window[run]
            agent = win[-1] if win else None
            conf = "HIGH" if len(set(win)) <= 1 else "LOW"
            rec = {
                "run": run,
                "ts": ts,
                "lineno": lineno,
                "request_id": rid,
                "session": run_session.get(run),
                "agent": agent,
                "permission": field(rest, "permission"),
                "confidence": conf,
                "patterns": parse_patterns(field(rest, "patterns")),
            }
            if rid.startswith("que_"):
                rec["questions"] = field(rest, "questions")
                questions.append(rec)
                continue
            asks.append(rec)
        elif kind == "evaluated":
            action = field(rest, "action.action")
            win = run_window[run]
            agent = win[-1] if win else None
            if action == "deny":
                denies.append({
                    "run": run,
                    "ts": ts,
                    "lineno": lineno,
                    "permission": field(rest, "permission"),
                    "pattern": field(rest, "pattern"),
                    "rule": field(rest, "action.pattern"),
                    "agent": agent,
                    "session": run_session.get(run),
                    "confidence": "HIGH" if len(set(win)) <= 1 else "LOW",
                })
            elif action == "allow":
                pat = field(rest, "action.pattern")
                if pat and pat != "*":
                    allow_pats["%s\x1f%s" % (agent or "", field(rest, "permission"))][pat] += 1

    return {
        "sessions": sessions,
        "asks": asks,
        "questions": questions,
        "denies": denies,
        "allow_pats": {k: dict(v) for k, v in allow_pats.items()},
    }


# ---------------------------------------------------------------- parsed-log cache

def _cache_path(log_path):
    st = os.stat(log_path)
    h = hashlib.sha1(("%d|%s|%d|%d" % (CACHE_VERSION, log_path, st.st_size,
                                       st.st_mtime_ns)).encode()).hexdigest()[:16]
    return os.path.join(DEFAULT_CACHE_DIR, h + ".json")


def scan_log_cached(log_path, agents, all_agents, use_cache=True, cache_dir=None):
    """scan_log(), memoized on (log path, size, mtime). Cache is best-effort only."""
    cdir = cache_dir or DEFAULT_CACHE_DIR
    cpath = None
    if use_cache:
        try:
            cpath = _cache_path(log_path)
            with open(cpath) as fh:
                return json.load(fh)
        except Exception:
            cpath = None
    res = scan_log(log_path, agents, all_agents)
    if use_cache and cpath:
        try:
            os.makedirs(cdir, exist_ok=True)
            tmp = cpath + ".tmp"
            with open(tmp, "w") as fh:
                json.dump(res, fh)
            os.replace(tmp, cpath)
        except Exception:
            pass
    return res


# ---------------------------------------------------------------- DB scan

def db_query(db, sql):
    uri = "file:%s?mode=ro" % db
    out = subprocess.run(["sqlite3", "-json", uri, sql], capture_output=True, text=True)
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


def catalog_permission_errors(parts, limit=200):
    """Permission-family error shapes, counts per shape.

    Derived from the tool parts already fetched by scan_db — deliberately NOT a fresh
    DB query: `select ... from part where state.error like '%ermission%'` is a full-table
    scan with a JSON extract per row and costs ~35 s on a 23 GB store, for ~8 rows.
    Scope is the target sessions (i.e. every agent when --all-agents is used)."""
    c = Counter()
    for p in parts:
        err = p.get("error")
        if err and "ermission" in err:
            c[" ".join(err.split())[:120]] += 1
    return [{"err": k, "n": v} for k, v in c.most_common(limit)]


# ---------------------------------------------------------------- time window

def in_window(ms, since, until):
    if ms is None:
        return True
    if since is not None and ms < since:
        return False
    if until is not None and ms > until:
        return False
    return True


# ---------------------------------------------------------------- answer + timing

def answer_for_ask(ask, parts):
    """Best-effort: a permission-error tool part in the SAME session within 180s of the ask."""
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


def build_part_index(parts):
    """session_id -> sorted list of tool-part time_created (epoch ms)."""
    by_ses = defaultdict(list)
    for p in parts:
        tc = p.get("time_created")
        if tc:
            by_ses[p["session_id"]].append(tc)
    for k in by_ses:
        by_ses[k].sort()
    return by_ses


def deltas_for(asks_subset, by_ses):
    """Per prompt: ms from the ask to the NEXT ACTION in the same session (or None)."""
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


# ---------------------------------------------------------------- formatting

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
    if not ans:
        return None
    return "approved" if ans.startswith("yes") else "rejected"


def norm_outcome(ans):
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
    delim = "," if ext == ".csv" else "\t"
    cols = ["agent", "ts", "request_id", "permission", "cwd", "session",
            "outcome", "answer", "wasted_ms", "trigger", "confidence", "script"]
    with open(path, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols, delimiter=delim, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow(r)


# ---------------------------------------------------------------- agent maps

def global_bash_rules(path=None):
    """Global `permission.bash` from ~/.config/opencode/opencode.json as [(pattern, action)]."""
    path = path or os.path.join(HOME, ".config", "opencode", "opencode.json")
    try:
        with open(path) as fh:
            cfg = json.load(fh)
    except Exception:
        return []
    bash = (cfg.get("permission") or {}).get("bash") or {}
    return list(bash.items()) if isinstance(bash, dict) else []


def parse_agent_md_bash_map(path):
    """Frontmatter `permission.bash` map from an installed agent .md. {pattern: action}."""
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
        if (len(line) - len(line.lstrip())) <= 2:          # left the bash block
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


# ---------------------------------------------------------------- rule coverage

def _coverage_patterns(agent, kind, allow_pats, fallback_maps):
    """Patterns that demonstrably allowed a segment: observed winning allow rules, else
    the agent's declared allow entries. The bare `*` catch-all is never a proof."""
    key = "%s\x1f%s" % (agent or "", kind or "")
    pats = allow_pats.get(key)
    if pats:
        return list(pats.keys())
    bmap = fallback_maps.get(agent) or {}
    return [p for p, a in bmap.items() if a == "allow" and p != "*"]


def triggering_segments(ask, allow_pats, fallback_maps):
    """Segments of the ask that no observed allow rule covers — the ask's real cause."""
    agent = ask.get("agent")
    kind = ask.get("permission")
    pats = _coverage_patterns(agent, kind, allow_pats, fallback_maps)
    out = []
    for seg in ask.get("patterns") or []:
        if not any(wild_match(p, seg) for p in pats):
            out.append(seg)
    return out


def _seg_head(seg, kind):
    """Pattern suggestion for a fallen-through segment."""
    s = seg.strip()
    if kind == "external_directory":
        parts = [p for p in s.split("/") if p]
        return "/" + "/".join(parts[:4]) + "/*" if parts else s
    tok = re.split(r"\s", s, maxsplit=1)[0]
    return ("%s *" % tok) if len(s.split()) > 1 else tok


# ---------------------------------------------------------------- rendering

def _stats_for(ask_subset, sessions, by_ses, ans_of):
    """Per-agent aggregates for the leaderboard."""
    by = defaultdict(list)
    for a in ask_subset:
        by[a.get("agent")].append(a)
    out = {}
    for ag, lst in sorted(by.items(), key=lambda kv: -len(kv[1])):
        pairs = deltas_for(lst, by_ses)
        ds = [d for _, d in pairs if d is not None]
        sess = {a["session"] for a in lst if a.get("session")} & set(sessions)
        tot_sess = sum(1 for m in sessions.values() if m.get("agent") == ag)
        out[ag] = {
            "agent": ag,
            "prompts": len(lst),
            "sessions_prompted": len(sess),
            "sessions_total": tot_sess,
            "pct_sessions": (100.0 * len(sess) / tot_sess) if tot_sess else 0.0,
            "asks_per_session": (len(lst) / len(sess)) if sess else 0.0,
            "wasted_sum": sum(ds) if ds else None,
            "wasted_median": _median(ds),
            "low_confidence": sum(1 for a in lst if a.get("confidence") == "LOW"),
        }
    return out


def _leaderboard_text(L, A, header, stats, split=None):
    A("-" * 100)
    A(header)
    A("-" * 100)
    if split is None:
        A("  %-18s %7s %9s %10s %8s %-13s %-13s %6s"
          % ("agent", "prompts", "sessions", "asks/sess", "%-sess",
             "Wasted Sum", "Wasted Median", "lowcf"))
        for ag, s in stats.items():
            A("  %-18s %7d %9d %10.2f %7.1f%% %-13s %-13s %6d"
              % (ag, s["prompts"], s["sessions_prompted"], s["asks_per_session"],
                 s["pct_sessions"],
                 _fmt_dur(s["wasted_sum"]) if s["wasted_sum"] is not None else "\u2014",
                 _fmt_dur(s["wasted_median"]) if s["wasted_median"] is not None else "\u2014",
                 s["low_confidence"]))
    else:
        lab, before, after = split
        A("  before/after %s" % lab)
        A("  %-18s %17s %17s %21s" % ("agent", "prompts b\u2192a", "ses.prompted b\u2192a",
                                      "wasted-sum b\u2192a"))
        for ag in sorted(set(before) | set(after)):
            b = before.get(ag, {})
            f = after.get(ag, {})
            A("  %-18s %7s \u2192 %-7s %7s \u2192 %-7s %9s \u2192 %-9s"
              % (ag, b.get("prompts", 0), f.get("prompts", 0),
                 b.get("sessions_prompted", 0), f.get("sessions_prompted", 0),
                 _fmt_dur(b.get("wasted_sum")) if b.get("wasted_sum") is not None else "\u2014",
                 _fmt_dur(f.get("wasted_sum")) if f.get("wasted_sum") is not None else "\u2014"))
    A("")
    A("  sessions = sessions of that agent with \u22651 prompt; total = sessions that agent ran.")
    A("  lowcf = prompts whose attribution is LOW confidence (interleaved run).")
    A("")


def render(agents, sessions, asks, questions, denies, parts, catalogs, catalogs_all,
           all_agents, include_foreign, agents_dir, allow_pats, rank_only,
           since_label, until_label, split_ms):
    L = []
    A = L.append
    label = "ALL AGENTS" if all_agents else ",".join(sorted(agents))
    maps = load_agent_maps(agents, all_agents, agents_dir)
    by_ses = build_part_index(parts)
    ans_cache = {}

    def ans_of(a):
        rid = a.get("request_id")
        if rid not in ans_cache:
            ans_cache[rid] = answer_for_ask(a, parts)
        return ans_cache[rid]

    mine = asks if all_agents else [a for a in asks if a["agent"] in agents]
    pairs = deltas_for(mine, by_ses)
    dmap = {a["request_id"]: d for a, d in pairs}
    trig = {a["request_id"]: triggering_segments(a, allow_pats, maps) for a in mine}

    groups = {"overall": [], "approved": [], "rejected": []}
    for a, d in pairs:
        if d is None:
            continue
        groups["overall"].append(d)
        b = answer_bucket(ans_of(a))
        if b in groups:
            groups[b].append(d)
    wm = {k: (len(xs), sum(xs) if xs else None, _median(xs)) for k, xs in groups.items()}

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
        return "%s (median %s)" % (_fmt_dur(tot) if tot is not None else "\u2014",
                                   _fmt_dur(med) if med is not None else "\u2014")

    _, _tot, _ = wm["overall"]
    avg_session = (_tot / len(prompted_sess)) if (prompted_sess and _tot is not None) else None

    A("=" * 100)
    A("OPENCODE PERMISSION PROMPT REPORT")
    A("agent filter : %s" % ("(all agents)" if all_agents else label))
    A("log          : %s" % DEFAULT_LOG)
    A("db           : %s" % DEFAULT_DB)
    if since_label or until_label or split_ms is not None:
        A("window       : since=%s until=%s split=%s"
          % (since_label or "-", until_label or "-",
             split_ms or "-"))
    A("=" * 100)
    A("")
    A("NOTE: the log records the ASK; your ANSWER is inferred from the DB tool outcome")
    A("      (status=completed => the tool ran => you allowed it). opencode 1.18.32")
    A("      persists no ask rows and never logs your click.")
    A("")

    # ---- SUMMARY ------------------------------------------------------------
    A("-" * 100)
    A("SUMMARY")
    A("-" * 100)
    rows = [
        ("Metric", "Value"),
        ("Permission prompts", "%d" % n_prompts),
        ("  \u2192 total wasted time", _fmt_dur(_tot) if _tot is not None else "\u2014"),
        ("  \u2192 low-confidence attributions",
         "%d" % sum(1 for a in mine if a.get("confidence") == "LOW")),
        ("Sessions", "%d" % n_sess),
        ("  \u2192 pct of sessions with at least one", "%.1f%%" % pct_sess),
        ("  \u2192 avg wasted time per session",
         _fmt_dur(avg_session) if avg_session is not None else "\u2014"),
        ("DB tool parts scanned", "%d" % len(parts)),
        ("  \u2192 completed (allowed)", "%d" % n_completed),
        ("  \u2192 CRITICAL wasted time", _summed("approved")),
        ("  \u2192 rejected", "%d" % n_rejected),
        ("  \u2192 OK wasted time", _summed("rejected")),
        ("  \u2192 denied-by-rule", "%d" % n_denied),
        ("Deny rows (Section 4b, all agents)", "%d" % len(denies)),
        ("Auto-rejects (Section 5)", "%d" % len(auto)),
        ("Agents with a bash map (Section 7)", "%d" % len(maps)),
    ]
    for k, v in rows:
        A("%s\t%s" % (k, v))
    A("")
    A("  CRITICAL wasted time = stall on prompts you APPROVED (pure overhead);")
    A("  OK wasted time = stall on prompts that were rejected/denied (justified).")
    A("")

    # ---- LEADERBOARD --------------------------------------------------------
    stats = _stats_for(mine, sessions, by_ses, ans_of)
    if split_ms is not None:
        before = [a for a in mine if (in_window(_iso_ms(a["ts"]), None, split_ms))]
        after = [a for a in mine if (in_window(_iso_ms(a["ts"]), split_ms, None))]
        sb = _stats_for(before, sessions, by_ses, ans_of)
        sa = _stats_for(after, sessions, by_ses, ans_of)
        _leaderboard_text(L, A, "LEADERBOARD \u2014 per-agent permission pressure",
                          stats, split=(split_ms, sb, sa))
    else:
        _leaderboard_text(L, A, "LEADERBOARD \u2014 per-agent permission pressure", stats)

    if rank_only:
        return "\n".join(L), [], _assemble_data(
            label, all_agents, n_prompts, n_sess, pct_sess, _tot, avg_session,
            parts, n_completed, n_rejected, n_denied, denies, auto, catalogs_all,
            stats, wm, [], sessions, tgt_sessions, maps, allow_pats)

    # ---- SECTION 0 ----------------------------------------------------------
    A("-" * 100)
    A("SECTION 0 \u2014 WASTED TIME  (prompt -> next action in the same session)")
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

    # ---- SECTION 1 ----------------------------------------------------------
    A("-" * 100)
    A("SECTION 1 \u2014 PERMISSION PROMPTS attributed to %s  (%d)" % (label, len(mine)))
    A("-" * 100)
    if not mine:
        A("  (none \u2014 no `message=asking` line attributed to this agent)")
    for a in mine:
        ses = a.get("session")
        cwd = sessions.get(ses, {}).get("directory") if ses else None
        tlist = trig.get(a["request_id"]) or []
        A("")
        A("  %s  req=%s" % (a["ts"], a["request_id"]))
        A("    permission : %s" % a["permission"])
        A("    cwd        : %s" % (cwd or "?"))
        A("    session    : %s" % (ses or "?"))
        A("    answer     : %s" % ans_of(a))
        A("    wasted     : %s" % _fmt_dur(dmap.get(a["request_id"])))
        A("    confidence : %s" % a.get("confidence"))
        A("    trigger    : %s" % (" ; ".join(tlist) if tlist else "(none detected)"))
        A("    script:")
        for seg in a["patterns"]:
            A("      $ %s" % seg)
    A("")

    if include_foreign:
        foreign = [a for a in asks
                   if not all_agents and a.get("agent") not in agents
                   and any(any(t in s for t in agents) for s in a["patterns"])]
        A("-" * 100)
        A("SECTION 1b \u2014 ASKS raised by OTHER agents whose script MENTIONS %s  (%d)"
          % (label, len(foreign)))
        A("-" * 100)
        for a in foreign:
            A("  %s  agent=%s req=%s cwd=%s"
              % (a["ts"], a["agent"], a["request_id"],
                 sessions.get(a.get("session"), {}).get("directory", "?")))
            for seg in a["patterns"]:
                A("      $ %s" % seg)
        A("")

    # ---- SECTION 2 ----------------------------------------------------------
    A("-" * 100)
    A("SECTION 2 \u2014 SESSIONS matching %s  (%d)" % (label, len(tgt_sessions)))
    A("-" * 100)
    for s, m in sorted(tgt_sessions.items(), key=lambda kv: kv[1].get("run") or ""):
        A("  %s  agent=%-14s dir=%s" % (s, m.get("agent"), m.get("directory")))
        A("      title: %s" % m.get("title"))
    A("")

    # ---- SECTION 3 ----------------------------------------------------------
    A("-" * 100)
    A("SECTION 3 \u2014 ANSWER EVIDENCE from DB tool parts  (%d parts scanned)" % len(parts))
    A("-" * 100)
    A("  status=completed  : %d  (tool ran => you allowed)"
      % sum(1 for p in parts if p.get("status") == "completed"))
    A("  rejected          : %d" % n_rejected)
    A("  denied-by-rule    : %d" % n_denied)
    A("")
    for p in catalogs.get("rejected", []):
        A("  REJECTED  %s  tool=%s" % (p.get("time_created"), p.get("tool")))
        A("      input: %s" % (p.get("input") or "").replace("\n", " ")[:200])
    for p in catalogs.get("denied", []):
        A("  DENIED    %s  tool=%s" % (p.get("time_created"), p.get("tool")))
        A("      input: %s" % (p.get("input") or "").replace("\n", " ")[:200])
    A("")

    # ---- SECTION 4 ----------------------------------------------------------
    deny_summary = Counter((d.get("agent"), d.get("rule")) for d in denies)
    A("-" * 100)
    A("SECTION 4 \u2014 DENY SUMMARY  (rule \u00d7 agent, from `message=evaluated ... action=deny`)")
    A("-" * 100)
    if not deny_summary:
        A("  (no deny evaluations in the window)")
    A("  %6s  %-18s %s" % ("count", "agent", "rule"))
    for (ag, rule), n in deny_summary.most_common():
        A("  %6d  %-18s %s" % (n, ag, rule))
    A("")

    # ---- SECTION 4b ---------------------------------------------------------
    A("-" * 100)
    A("SECTION 4b \u2014 DENY CATALOG  (%d)" % len(denies))
    A("-" * 100)
    for d in denies:
        A("  %s  agent=%-14s perm=%-16s rule=%-24s  script=%s"
          % (d["ts"], d["agent"], d["permission"], d["rule"], d["pattern"]))
    A("")

    # ---- SECTION 5 ----------------------------------------------------------
    A("-" * 100)
    A("SECTION 5 \u2014 AUTO-REJECT CATALOG (DB parts with an auto-reject permission error)")
    A("-" * 100)
    if auto:
        for r in auto:
            A("  %6d  %s" % (r["n"], r["err"]))
    else:
        A("  (none found \u2014 opencode 1.18.32 does not log or persist auto-rejections;")
        A("   a non-interactive `ask` fails the call instead of recording an auto-reject)")
    A("")

    # ---- SECTION 6 ----------------------------------------------------------
    A("-" * 100)
    A("SECTION 6 \u2014 permission-family DB error shapes (target sessions)")
    A("-" * 100)
    if catalogs_all:
        for r in catalogs_all:
            A("  %6d  %s" % (r["n"], r["err"]))
    else:
        A("  (none \u2014 no tool call in the scanned sessions failed with a permission error.")
        A("   The deny/ask record lives in the LOG; see Sections 4/4b. Run --all-agents for")
        A("   the widest scope.)")
    A("")

    # ---- SECTION 7 ----------------------------------------------------------
    A("-" * 100)
    A("SECTION 7 \u2014 AGENT BASH MAP & FIX SUGGESTION  (from %s)" % agents_dir)
    A("-" * 100)
    if not maps:
        A("  (no installed agent .md with a bash map found in %s)" % agents_dir)
    for agent, bmap in sorted(maps.items()):
        catch = bmap.get("*")
        guard = [(p, a) for p, a in bmap.items() if a in ("ask", "deny") and p != "*"]
        A("")
        A("  agent=%s" % agent)
        A("    catch-all : %s" % (catch or "(none \u2014 unmatched falls to config/default)"))
        A("    entries   : %d  (allow %d / ask %d / deny %d)"
          % (len(bmap),
             sum(1 for a in bmap.values() if a == "allow"),
             sum(1 for a in bmap.values() if a == "ask"),
             sum(1 for a in bmap.values() if a == "deny")))
        if catch == "ask":
            A("    verdict   : DEFECT \u2014 catch-all is `ask`, so EVERY unnamed segment")
            A("                 prompts, and opencode evaluates a bash call as ONE unit:")
            A("                 one unnamed segment (echo/tail/rg/ls) asks the WHOLE call.")
            A("                 Non-interactively that ask auto-rejects => the call FAILS.")
        else:
            A("    verdict   : ok \u2014 catch-all is `%s`" % (catch or "absent"))
        missing = [(p, a) for p, a in global_bash_rules()
                   if p not in bmap and a in ("ask", "deny")]
        if missing and catch in ("ask", "allow"):
            A("    MISSING guardrails: global rules this map does NOT restate are")
            A("    shadowed by the catch-all \u2014 restate them LAST:")
            for p, a in missing:
                A("      %-30s : \"%s\"," % ('"%s"' % p, a))
        # rule-suggestion engine: what actually fell through for this agent
        agent_asks = [a for a in asks if a.get("agent") == agent]
        if agent_asks:
            seg_ct = Counter()
            head_asks = defaultdict(set)
            for a in agent_asks:
                for seg in (trig.get(a["request_id"]) or []):
                    seg_ct[(a.get("permission"), seg)] += 1
                    head_asks[(a.get("permission"), _seg_head(seg, a.get("permission")))].add(a["request_id"])
            if head_asks:
                A("    SUGGESTED allow patterns (would clear N of this window's prompts):")
                for (kind, pat), ids in sorted(head_asks.items(),
                                               key=lambda kv: -len(kv[1]))[:12]:
                    A("      %-30s :  clears %d   [%s]" % ('"%s"' % pat, len(ids), kind))
                A("    FALL-THROUGH SEGMENTS (top 10 by frequency):")
                for (kind, seg), n in seg_ct.most_common(10):
                    A("      %4d  [%s] %s" % (n, kind, seg[:90]))
        if catch == "ask":
            A("    suggested permission.bash (drop-in \u2014 guardrails LAST so they win):")
            A("      \"*\": \"allow\",")
            for p, a in guard:
                A("      %-30s : \"%s\"," % ('"%s"' % p, a))
            for p, a in missing:
                A("      %-30s : \"%s\"," % ('"%s"' % p, a))
        A("")
    A("")

    # ---- SECTION 8 ----------------------------------------------------------
    A("-" * 100)
    A("SECTION 8 \u2014 AGENT RULE INVENTORY  (from `message=created` permission field)")
    A("-" * 100)
    inv = defaultdict(Counter)
    inv_sessions = Counter()
    for m in sessions.values():
        ag = m.get("agent")
        if not ag or (not all_agents and ag not in agents):
            continue
        inv_sessions[ag] += 1
        inv[ag][_ruleset_str(m.get("permission"))] += 1
    if not inv_sessions:
        A("  (no matching sessions)")
    for ag in sorted(inv_sessions, key=lambda a: -inv_sessions[a]):
        A("")
        A("  agent=%s  sessions=%d" % (ag, inv_sessions[ag]))
        for rs, n in inv[ag].most_common():
            A("      %4d\u00d7  %s" % (n, rs))
    A("")

    # ---- export rows --------------------------------------------------------
    xrows = []
    for a in mine:
        ses = a.get("session")
        cwd = sessions.get(ses, {}).get("directory") if ses else None
        ans = ans_of(a)
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
            "trigger": " ; ".join(trig.get(a["request_id"]) or []),
            "confidence": a.get("confidence"),
            "script": " ; ".join(a["patterns"]),
        })

    data = _assemble_data(label, all_agents, n_prompts, n_sess, pct_sess, _tot,
                          avg_session, parts, n_completed, n_rejected, n_denied,
                          denies, auto, catalogs_all, stats, wm, xrows, sessions,
                          tgt_sessions, maps, allow_pats)
    data["deny_summary"] = [{"count": n, "agent": ag, "rule": r}
                            for (ag, r), n in deny_summary.most_common()]
    data["rule_inventory"] = [
        {"agent": ag, "sessions": inv_sessions[ag],
         "rulesets": [{"count": n, "rules": rs} for rs, n in inv[ag].most_common()]}
        for ag in sorted(inv_sessions, key=lambda a: -inv_sessions[a])
    ]
    return "\n".join(L), xrows, data


def _ruleset_str(raw):
    """`permission="[{...}]"` -> a compact 'perm=action, perm=action' signature."""
    if not raw:
        return "(empty)"
    try:
        rs = json.loads(raw)
    except Exception:
        return raw[:100]
    if not isinstance(rs, list) or not rs:
        return "(empty)"
    out = []
    for r in rs:
        if not isinstance(r, dict):
            continue
        perm = r.get("permission")
        pat = r.get("pattern")
        act = r.get("action")
        out.append("%s%s=%s" % (perm, "" if pat in (None, "*") else "(%s)" % pat, act))
    return ", ".join(out) if out else "(empty)"


def _assemble_data(label, all_agents, n_prompts, n_sess, pct_sess, _tot, avg_session,
                   parts, n_completed, n_rejected, n_denied, denies, auto, catalogs_all,
                   stats, wm, xrows, sessions, tgt_sessions, maps, allow_pats):
    return {
        "meta": {"agent_filter": label, "all_agents": all_agents,
                 "log": DEFAULT_LOG, "db": DEFAULT_DB, "agents_dir": DEFAULT_AGENTS_DIR},
        "summary": {
            "permission_prompts": n_prompts,
            "total_wasted_ms": _tot,
            "sessions": n_sess,
            "pct_sessions_prompted": round(pct_sess, 2),
            "avg_wasted_per_session_ms": avg_session,
            "parts_scanned": len(parts),
            "completed": n_completed,
            "rejected": n_rejected,
            "denied_by_rule": n_denied,
            "deny_rows": len(denies),
            "auto_rejects": len(auto),
            "agents_with_map": len(maps),
        },
        "leaderboard": list(stats.values()),
        "wasted": {k: {"prompts": v[0], "sum_ms": v[1], "median_ms": v[2]}
                   for k, v in wm.items()},
        "prompts": xrows,
        "sessions": [{"id": s, **m} for s, m in tgt_sessions.items()],
        "denies": denies,
        "auto_rejects": auto,
        "error_shapes": catalogs_all,
        "agent_maps": [{"agent": a, "catch_all": b.get("*"),
                        "allow": sum(1 for x in b.values() if x == "allow"),
                        "ask": sum(1 for x in b.values() if x == "ask"),
                        "deny": sum(1 for x in b.values() if x == "deny")}
                       for a, b in sorted(maps.items())],
        "allow_patterns": allow_pats,
    }


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--agent", nargs="*", default=None,
                    help="agent name(s) to keep; omit (or pass none) for EVERY agent")
    ap.add_argument("--all-agents", action="store_true",
                    help="explicitly cover every agent (same as omitting --agent)")
    ap.add_argument("--include-foreign", action="store_true")
    ap.add_argument("--rank", action="store_true", help="print only the leaderboard")
    ap.add_argument("--format", choices=["text", "json"], default="text")
    ap.add_argument("--since", default=None, help="ISO8601 lower bound (inclusive)")
    ap.add_argument("--until", default=None, help="ISO8601 upper bound (inclusive)")
    ap.add_argument("--split", default=None, help="ISO8601 instant for a before/after leaderboard")
    ap.add_argument("--log", default=DEFAULT_LOG)
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--agents-dir", default=DEFAULT_AGENTS_DIR,
                    help="directory holding installed <agent>.md files (Section 7)")
    ap.add_argument("--no-cache", action="store_true", help="ignore the parsed-log cache")
    ap.add_argument("--out", default=None, help="output file (default: a temp file)")
    ap.add_argument("--export", default=None,
                    help="write raw rows to .json/.csv/TSV")
    args = ap.parse_args()

    if not os.path.exists(args.log):
        sys.exit("log not found: %s" % args.log)

    agents = set(args.agent or [])
    all_agents = args.all_agents or not agents
    slug = "all" if all_agents else "+".join(sorted(agents))
    since = _iso_ms(args.since) if args.since else None
    until = _iso_ms(args.until) if args.until else None
    split = _iso_ms(args.split) if args.split else None
    if args.since and since is None:
        sys.exit("unparseable --since: %s" % args.since)
    if args.until and until is None:
        sys.exit("unparseable --until: %s" % args.until)
    if args.split and split is None:
        sys.exit("unparseable --split: %s" % args.split)

    res = scan_log_cached(args.log, agents, all_agents,
                          use_cache=not args.no_cache)
    asks = [a for a in res["asks"] if in_window(_iso_ms(a["ts"]), since, until)]
    denies = [d for d in res["denies"] if in_window(_iso_ms(d["ts"]), since, until)]
    sessions = {s: m for s, m in res["sessions"].items()
                if in_window(_iso_ms(m.get("time_created")), since, until)}

    target_sessions = {s for s, m in sessions.items()
                       if all_agents or m.get("agent") in agents}
    parts, catalogs = scan_db(args.db, target_sessions)
    catalogs_all = catalog_permission_errors(parts)

    report, xrows, data = render(
        agents, sessions, asks, res["questions"], denies, parts, catalogs, catalogs_all,
        all_agents, args.include_foreign, args.agents_dir, res["allow_pats"],
        args.rank, args.since, args.until, split)

    if args.format == "json":
        blob = json.dumps(data, indent=2, default=str)
        if not args.out:
            fd, args.out = tempfile.mkstemp(prefix="opencode-perms-%s-" % slug,
                                            suffix=".json", dir=tempfile.gettempdir())
            os.close(fd)
        with open(args.out, "w") as fh:
            fh.write(blob)
        print(blob if len(blob) < 8000 else blob[:8000] + "\n…[truncated]")
        print("\n[written] %s  (%d bytes)" % (args.out, len(blob)))
    else:
        if not args.out:
            fd, args.out = tempfile.mkstemp(prefix="opencode-perms-%s-" % slug,
                                            suffix=".txt", dir=tempfile.gettempdir())
            os.close(fd)
        with open(args.out, "w") as fh:
            fh.write(report)
        print(report[-4000:] if len(report) > 4000 else report)
        print("\n[written] %s  (%d bytes)" % (args.out, len(report)))

    if args.export:
        export_rows(args.export, xrows)
        print("[exported] %s  (%d rows)" % (args.export, len(xrows)))


if __name__ == "__main__":
    main()
