#!/usr/bin/env python3
"""
agent-transcript-scan.py — scan agent transcripts for destructive and
escape-the-project command patterns, and for the cross-agent chains that turn a
harmless-looking write into machine damage.

WHY THIS EXISTS
  A dispatch wave left subagent F2 running
      ln -sf "$(which node)" "$SCRATCHPAD/bin/skillspector"
  and subagent F1 then ran
      printf '#!/bin/sh\n...\nexit 127\n' > "$SCRATCHPAD/bin/skillspector"
  Eight seconds apart. Neither brief mentioned that scratchpad. The `>` followed
  the symlink chain into ~/dot/bin/node and overwrote the running Node binary.
  Every owner-global guard ("don't rm -rf the machine", "stay in your worktree")
  was satisfied — because the dangerous operation was a WRITE THROUGH A SYMLINK,
  and no single command looks destructive.

  So this scanner does not just match bad commands. It builds a link map across
  every transcript in the scan set and reports a write whose destination is a
  link another agent planted (rule R7). That correlation is the whole point.

USAGE
  agent-transcript-scan.py <file.jsonl|dir> [...]        # text report
  agent-transcript-scan.py --transcripts ~/.claude/projects/<p>/<s>/subagents
  agent-transcript-scan.py --project ~/dev/repo <dir>    # resolve escapes
  agent-transcript-scan.py --json <dir>                  # CI / machine output
  agent-transcript-scan.py --only R1,R7 <dir>            # filter rules
  agent-transcript-scan.py --list-rules

RULES (id — severity — what)
  R1 rm-var            high   rm with a variable target (flag: -r, inline-assign,
                              RHS not tmp, trailing slash, var not set in-cmd)
  R2 rm-broad          high   recursive rm of / , $HOME, an absolute root-ish
                              path, or glob ending in /* or ~/*
  R3 symlink-external  high   ln -s whose TARGET leaves the project: $(which X)/
                              $(command -v X), an absolute path outside, or ../..
  R4 symlink-shadow    high   a link NAME matches a real command on PATH
                              (node, python, rg, git, ...) — a landmine for any
                              `PATH=$dir:$PATH` the repo later sets up
  R5 write-outside     med    Write/Edit file_path or a shell redirect destination
                              resolves outside the project root
  R6 redirect-bare     med    `>`/`>>` onto a path in a shared scratch/tmp dir with
                              no `[ -L ]`/`[ -e ]` guard (redirect follows links)
  R7 redirect-link     CRIT   a redirect destination matches a symlink created in
                              ANOTHER transcript (the incident: link→write chain)
  R8 git-destructive   high   git reset --hard, git stash, git add -A / add .
  R9 var-offset        low    warning as evidence: a path assigned to a variable
                              inline in a compound command (needless indirection
                              that hides what the target is)

Only Claude Code transcript JSONL shapes are parsed (nested message.content
tool_use blocks). Detection is heuristic and conservative: it reports, it does
not block. Exit code is 0 unless --fail-on <severity> is given.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field, asdict
from typing import Iterable

SEVERITY_ORDER = {"low": 1, "med": 2, "high": 3, "CRIT": 4}

# Names that, if used as a symlink label, are landmines for a later PATH prepend.
EXECUTABLE_NAMES = {
    "node", "nodejs", "npm", "npx", "pnpm", "yarn", "python", "python3", "pip",
    "ruby", "go", "cargo", "rustc", "java", "git", "rg", "grep", "find", "ls",
    "cat", "sh", "bash", "zsh", "env", "make", "tsc", "tsx", "deno", "bun",
    "docker", "kubectl", "jq", "sed", "awk", "curl", "wget", "skillspector",
}
TMP_DIRS = re.compile(r"^(/tmp|/private/tmp|/var/tmp|\$TMPDIR|/private/var/folders)")
SEG_SPLIT = re.compile(r"&&|\|\||;|\n|\|(?!=)")
ASSIGN_RE = re.compile(r"(?:^|[;&|\s])(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=")
ASSIGN_KV_RE = re.compile(r"(?:^|[;&|\s])(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=([^\s;&|]*)")


def kv_assigns(cmd: str) -> dict:
    a = {}
    for m in ASSIGN_KV_RE.finditer(cmd):
        a[m.group(1)] = m.group(2).strip("'\"")
    return a


@dataclass
class Finding:
    rule: str
    severity: str
    file: str
    idx: int
    ts: str
    agent: str
    summary: str
    command: str = ""
    evidence: str = ""
    project: str = ""


@dataclass
class Doc:
    path: str
    agent: str
    project: str
    events: list = field(default_factory=list)   # (idx, ts, cwd, tools)
    links: dict = field(default_factory=dict)    # normalized dest-path -> (target, idx)


def load_transcript(path: str, project_override: str = "") -> Doc:
    agent = os.path.basename(path).replace("agent-", "").replace(".jsonl", "")
    events, links = [], {}
    cwds = Counter()
    try:
        fh = open(path)
    except OSError:
        return Doc(path, agent, project_override)
    for idx, line in enumerate(fh):
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        ts = rec.get("timestamp", "")
        cwd = rec.get("cwd", "")
        if cwd:
            cwds[cwd] += 1
        tools = []
        msg = rec.get("message")
        content = msg.get("content") if isinstance(msg, dict) else None
        if isinstance(content, list):
            for blk in content:
                if isinstance(blk, dict) and blk.get("type") == "tool_use":
                    tools.append((blk.get("name", ""), blk.get("input", {}) or {}))
        if tools:
            events.append((idx, ts, cwd, tools))
        for name, inp in tools:
            if name == "Bash":
                for dest, target in bash_links(inp.get("command", "")):
                    links[dest] = (target, idx)
    project = project_override or (cwds.most_common(1)[0][0] if cwds else "")
    # A cc subagent project root is the worktree, not the session dir; keep cwd.
    return Doc(path, agent, project, events, links)


def norm(p: str) -> str:
    p = p.strip().strip("'\"").rstrip("/")
    return os.path.normpath(os.path.expanduser(p)) if p else p


SUBST = re.compile(r"\$\([^()]*\)|\$\{[^}]*\}")


def tokenize(seg: str) -> list[str]:
    """Split a shell segment on whitespace but keep $(...) as one token."""
    subs = []

    def _m(m):
        subs.append(m.group(0))
        return f"\x00{len(subs) - 1}\x00"

    out = []
    for t in SUBST.sub(_m, seg).split():
        m = re.fullmatch(r"\x00(\d+)\x00", t)
        out.append(subs[int(m.group(1))] if m else t)
    return out


def bash_links(cmd: str) -> list[tuple[str, str]]:
    """Return (link_path, target) for each ln -s in a shell command."""
    assigns = kv_assigns(cmd)
    out = []
    for seg in SEG_SPLIT.split(cmd):
        toks = tokenize(seg)
        for i, tk in enumerate(toks):
            if tk == "ln":
                j = i + 1
                while j < len(toks) and toks[j].startswith("-"):
                    j += 1
                if j + 1 < len(toks):
                    dest = expand_vars(toks[j + 1], assigns)
                    out.append((norm(dest), expand_vars(toks[j], assigns)))
    return out


def redirect_dests(seg: str, assigns: dict | None = None) -> list[str]:
    """Bare >/>> destinations in a segment, variable-expanded where possible."""
    if assigns is None:
        assigns = kv_assigns(seg)
    out = []
    for m in re.finditer(r"(?<![0-9>])>>?\s*([^\s;&|]+)", seg):
        d = expand_vars(m.group(1).strip().strip("'\""), assigns)
        out.append(d)
    return out


def expand_vars(path: str, assigns: dict) -> str:
    """Expand a leading/embedded $VAR or ${VAR} using inline assignments."""
    def _r(m):
        return assigns.get(m.group(1) or m.group(2), m.group(0))
    return re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)", _r, path)


def rhs_of(cmd: str, var: str) -> str | None:
    m = None
    for mm in re.finditer(r"(?:^|[;&|\s])(?:export\s+)?" + re.escape(var) + r"=(.*)", cmd, re.S):
        m = SEG_SPLIT.split(mm.group(1))[0].strip()
    return m


def resolves_outside(target: str, project: str) -> bool:
    if not target:
        return False
    if "$(" in target or "`" in target:
        return True
    t = norm(target)
    if not t.startswith("/"):
        # relative: does it climb above the project root?
        if project and os.path.isabs(project):
            joined = os.path.normpath(os.path.join(project, t))
            return not joined.startswith(os.path.normpath(project))
        return t.startswith("../")
    if project and os.path.isabs(project):
        return not t.startswith(os.path.normpath(project))
    return not bool(TMP_DIRS.match(t))


def scan_bash(cmd: str, f: Finding, project: str) -> Iterable[Finding]:
    assigns = set(ASSIGN_RE.findall(cmd))
    cmd_assigns = kv_assigns(cmd)
    for seg in SEG_SPLIT.split(cmd):
        # --- R1/R2 rm ---
        m = re.search(r"\brm\b", seg)
        if m:
            toks = re.sub(r"[()]", " ", seg).split()
            for i, tk in enumerate(toks):
                if tk != "rm":
                    continue
                flags, j = [], i + 1
                while j < len(toks) and toks[j].startswith("-") and toks[j] != "--":
                    flags.append(toks[j]); j += 1
                tgts = [t for t in toks[j:] if t not in ("&&", "||", ";", "|")]
                fs = " ".join(flags)
                recursive = bool(re.search(r"-[a-zA-Z]*[rR]", fs))
                for t in tgts:
                    tt = t.strip().strip("'\"")
                    vm = re.match(r"^\$\{?([A-Za-z_][A-Za-z0-9_]*)", tt)
                    if vm:
                        var = vm.group(1)
                        rhs = rhs_of(cmd, var)
                        inline = var in assigns
                        trailing = tt.endswith("/") or tt.endswith("/*")
                        danger = recursive and (
                            trailing or not inline
                            or (rhs is not None and not TMP_DIRS.match(norm(rhs)) and not re.search(r"mktemp", rhs))
                            or rhs is None
                        )
                        sev = "high" if danger else ("med" if recursive else "low")
                        why = []
                        if recursive: why.append("-r")
                        if trailing: why.append("trailing-slash (unset var => rm -rf /)")
                        if not inline: why.append("var not set in this command")
                        if rhs and not TMP_DIRS.match(norm(rhs)) and not re.search(r"mktemp", rhs):
                            why.append(f"RHS not tmp: {rhs}")
                        yield Finding("R1-rm-var", sev, f.file, f.idx, f.ts, f.agent,
                                      f"rm {fs} {tt}" + (f"  [{'; '.join(why)}]" if why else ""),
                                      command=seg.strip()[:300], evidence=f"var={var} rhs={rhs!r}", project=project)
                    if recursive and re.search(r"^/($|\*)|^~/?($|\*)|^\$HOME/?($|\*)|^/\*", tt):
                        yield Finding("R2-rm-broad", "high", f.file, f.idx, f.ts, f.agent,
                                      f"recursive rm of a root/home path: {tt}",
                                      command=seg.strip()[:300], project=project)
        # --- R3/R4 ln -s ---
        for dest, target in bash_links(seg):
            label = os.path.basename(dest)
            ext = resolves_outside(target, project)
            subst_bin = bool(re.search(r"\$\((which|command -v)\b", target))
            benign = target.endswith("node_modules") and label == "node_modules"
            if (ext or subst_bin) and not benign:
                yield Finding("R3-symlink-external", "high", f.file, f.idx, f.ts, f.agent,
                              f"ln -s {target} -> {label}: target leaves the project",
                              command=seg.strip()[:300],
                              evidence=("$(which)/$(command -v) binary substitution" if subst_bin else "resolves outside project"),
                              project=project)
            elif benign:
                yield Finding("R3-symlink-external", "low", f.file, f.idx, f.ts, f.agent,
                              f"workspace node_modules link (benign): {target} -> {label}",
                              command=seg.strip()[:300], project=project)
            if label in EXECUTABLE_NAMES:
                yield Finding("R4-symlink-shadow", "high", f.file, f.idx, f.ts, f.agent,
                              f"symlink named '{label}' (a real command) -> {target}",
                              command=seg.strip()[:300], project=project)
        # --- R5/R6 redirects ---
        guarded = ("[ -L" in cmd) or ("[ -e" in cmd) or ("[ -f" in cmd)
        for dest in redirect_dests(seg, cmd_assigns):
            nd = norm(dest)
            if nd.startswith("/dev/"):
                continue
            if TMP_DIRS.match(nd) and not guarded:
                yield Finding("R6-redirect-bare", "med", f.file, f.idx, f.ts, f.agent,
                              f"unguarded redirect into a shared dir: > {dest}",
                              command=seg.strip()[:300], project=project)
            elif resolves_outside(dest, project) and not TMP_DIRS.match(nd):
                yield Finding("R5-write-outside", "med", f.file, f.idx, f.ts, f.agent,
                              f"redirect destination resolves outside project: {dest}",
                              command=seg.strip()[:300], project=project)
        # --- R8 git destructive ---
        if re.search(r"\bgit\s+reset\s+--hard", seg) or re.search(r"\bgit\s+stash\s+(?!list|show)", seg):
            yield Finding("R8-git-destructive", "high", f.file, f.idx, f.ts, f.agent,
                          f"destructive git: {seg.strip()[:80]}", command=seg.strip()[:300], project=project)
        if re.search(r"\bgit\s+add\s+(-A|--all|\.)\s*$", seg):
            yield Finding("R8-git-destructive", "high", f.file, f.idx, f.ts, f.agent,
                          f"staging sweep: {seg.strip()[:80]}", command=seg.strip()[:300], project=project)
        # --- R9 var-offset evidence ---
        if "=" in seg and ("rm " in seg or "ln -s" in seg) and len(assigns) >= 1:
            for var in assigns:
                if re.search(r"\$\{?" + re.escape(var) + r"\b", seg):
                    yield Finding("R9-var-offset", "low", f.file, f.idx, f.ts, f.agent,
                                  f"inline path variable hides the target: {var}=…", command=seg.strip()[:200], project=project)


def scan_writes(tools, f: Finding, project: str) -> Iterable[Finding]:
    for name, inp in tools:
        if name in ("Write", "Edit", "MultiEdit", "NotebookEdit"):
            fp = inp.get("file_path") or inp.get("notebook_path") or ""
            if fp and resolves_outside(fp, project) and not TMP_DIRS.match(norm(fp)) and not norm(fp).startswith("/dev/"):
                yield Finding("R5-write-outside", "med", f.file, f.idx, f.ts, f.agent,
                              f"{name} outside project: {fp}", evidence=f"file_path={fp}", project=project)


def scan_doc(doc: Doc, only: set) -> list[Finding]:
    out = []
    for idx, ts, cwd, tools in doc.events:
        proj = doc.project or cwd
        base = Finding("", "", doc.path, idx, ts, doc.agent, "", project=proj)
        for name, inp in tools:
            if name == "Bash":
                out.extend(scan_bash(inp.get("command", ""), base, proj))
            else:
                out.extend(scan_writes([(name, inp)], base, proj))
    if only:
        out = [x for x in out if x.rule.split("-")[0] in only]
    return out


def cross_chain(docs: list[Doc]) -> list[Finding]:
    """R7: a redirect destination that is a symlink planted in another transcript."""
    linkmap = {}   # dest path -> (target, file, idx, ts, agent)
    for d in docs:
        for dest, (target, idx) in d.links.items():
            ts = next((e[1] for e in d.events if e[0] == idx), "")
            linkmap.setdefault(dest, (target, d.path, idx, ts, d.agent))
    findings = []
    for d in docs:
        for idx, ts, cwd, tools in d.events:
            for name, inp in tools:
                if name != "Bash":
                    continue
                cmd = inp.get("command", "")
                cassigns = kv_assigns(cmd)
                for seg in SEG_SPLIT.split(cmd):
                    for dest in redirect_dests(seg, cassigns):
                        dest = norm(dest)
                        hit = linkmap.get(dest)
                        if hit and hit[1] != d.path:
                            target, sfile, sidx, sts, sagent = hit
                            findings.append(Finding(
                                "R7-redirect-link", "CRIT", d.path, idx, ts, d.agent,
                                f"write through a symlink planted by another agent: > {dest}  (link -> {target})",
                                command=cmd.strip()[:300],
                                evidence=f"link planted by {os.path.basename(sfile)} idx {sidx} @ {sts} ({sagent})",
                                project=d.project))
    return findings


def iter_inputs(paths: list[str]) -> list[str]:
    files = []
    for p in paths:
        if os.path.isdir(p):
            for root, _, names in os.walk(p, followlinks=False):
                for n in names:
                    if n.endswith(".jsonl") and (n.startswith("agent-") or "/" not in n):
                        files.append(os.path.join(root, n))
        elif p.endswith(".jsonl"):
            files.append(p)
    return sorted(set(files))


def render(findings, docs, args, out):
    sev_rank = SEVERITY_ORDER
    counts = Counter(x.rule for x in findings)
    by_sev = Counter(x.severity for x in findings)
    out.write("=" * 78 + "\n")
    out.write("AGENT TRANSCRIPT SCAN\n")
    out.write(f"  transcripts : {len(docs)}\n")
    out.write(f"  findings    : {len(findings)}   " +
              "  ".join(f"{s}={by_sev[s]}" for s in ("CRIT", "high", "med", "low") if by_sev[s]) + "\n")
    out.write("=" * 78 + "\n\n")
    if counts:
        out.write("BY RULE\n")
        for r, c in counts.most_common():
            top = max((x.severity for x in findings if x.rule == r), key=lambda s: sev_rank[s])
            out.write(f"  {top:>4}  {c:>4}  {r}\n")
        out.write("\n")
    order = sorted(findings, key=lambda x: (-sev_rank[x.severity], x.rule, x.file, x.idx))
    for x in order:
        out.write(f"[{x.severity:>4}] {x.rule}  {os.path.basename(x.file)}#{x.idx}  {x.ts}\n")
        out.write(f"        agent={x.agent}  project={x.project}\n")
        out.write(f"        {x.summary}\n")
        if x.command:
            out.write(f"        cmd: {x.command}\n")
        if x.evidence:
            out.write(f"        evi: {x.evidence}\n")
        out.write("\n")
    return order


def main(argv=None):
    ap = argparse.ArgumentParser(description="Scan agent transcripts for destructive/escape patterns.")
    ap.add_argument("paths", nargs="*", help="transcript .jsonl files or directories")
    ap.add_argument("--transcripts", default="", help="directory to walk for *.jsonl transcripts")
    ap.add_argument("--project", default="", help="project root used to resolve outside-writes")
    ap.add_argument("--only", default="", help="comma list of rule prefixes, e.g. R1,R7")
    ap.add_argument("--fail-on", default="", choices=["", "low", "med", "high", "CRIT"])
    ap.add_argument("--json", action="store_true", dest="as_json")
    ap.add_argument("--out", default="")
    ap.add_argument("--list-rules", action="store_true")
    args = ap.parse_args(argv)

    if args.list_rules:
        for line in __doc__.split("RULES (id")[1].splitlines()[:12]:
            print(line)
        return 0

    paths = list(args.paths)
    if args.transcripts:
        paths.append(args.transcripts)
    files = iter_inputs(paths)
    if not files:
        print("no transcripts found (pass .jsonl files or a dir)", file=sys.stderr)
        return 2

    only = {x.strip() for x in args.only.split(",") if x.strip()}
    docs = [load_transcript(p, args.project) for p in files]
    findings = []
    for d in docs:
        findings.extend(scan_doc(d, only))
    if not only or "R7" in only:
        findings.extend(cross_chain(docs))

    buf = open(args.out, "w") if args.out else sys.stdout
    if args.as_json:
        json.dump({"files": [d.path for d in docs],
                   "counts": dict(Counter(x.rule for x in findings)),
                   "findings": [asdict(x) for x in findings]}, buf, indent=2)
        buf.write("\n")
    else:
        render(findings, docs, args, buf)
    if args.out:
        buf.close()
        print(f"report written: {args.out}  ({len(findings)} findings)")

    if args.fail_on:
        thr = SEVERITY_ORDER[args.fail_on]
        if any(SEVERITY_ORDER[x.severity] >= thr for x in findings):
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
