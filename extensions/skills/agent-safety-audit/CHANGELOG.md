# Changelog

## 0.5.0

- **Renamed** the skill `opencode-permission-audit` → **`agent-safety-audit`**, to reflect the
  increased scope: it now covers both permission-prompt auditing and destructive/escape transcript
  scanning, on both hosts. Extension `id`, package name
  (`@adhd/sox-extension-agent-safety-audit`), title, `README.md`, and `SKILL.md` heading all follow.
  Re-install under the new id (`soxe install agent-safety-audit …`); the old id is retired.
- `agent-transcript-scan.py`: `--opencode-db` is now **optional** — a bare `--opencode-db` scans the
  default store (`~/.local/share/opencode/opencode.db`); omitting it entirely leaves the run
  Claude-Code-only. `--opencode-db PATH` still targets a specific store.

## 0.4.0

- `scripts/agent-transcript-scan.py` now reads **opencode** as well as Claude Code. opencode keeps
  no per-agent files — every tool call is a `part` row in one SQLite DB
  (`~/.local/share/opencode/opencode.db`) — so a new ingestion path loads `bash`/`write`/`edit` parts
  (joined to `session` for `agent` + `directory`) and feeds the same R1–R9 engine. Each session
  becomes one `Doc`, so **R7 chains span hosts and sessions**.
- CLI: `--opencode-db PATH`, `--agent a,b` (narrow), `--since`/`--until` (bound the scan — the 24 GB
  DB has no index help). A `--transcripts` dir of Claude Code `.jsonl` files and `--opencode-db` can
  be given together.
- Fix: tz-naive `--since`/`--until` values are now interpreted as **UTC** (they previously used local
  time, silently shifting the window by the machine offset).

## 0.3.0

- New scanner `scripts/agent-transcript-scan.py`: scans Claude Code transcript `.jsonl` files (a file
  or a directory tree) for destructive and escape-the-project command patterns, with rules R1–R9
  (`rm` with a variable target, broad/recursive `rm`, symlinks that target a binary outside the
  project, symlink names that shadow a real `PATH` command, writes/redirects outside the project,
  unguarded redirects into a shared scratch dir, a redirect written *through* a symlink another
  transcript planted, destructive git, and inline path variables that hide a target).
- **R7 (`redirect-link`, CRIT)** is the cross-agent rule: it builds a link map across every
  transcript in the scan set and flags a write whose destination is a symlink some other agent
  created. This is the shape that caused a machine-wide Node-binary overwrite — an `ln -sf
  "$(which node)" …/skillspector` in one subagent and a `printf … > …/skillspector` in another, 80 s
  apart, in a shared scratchpad; neither command alone looks destructive, so no per-command guard
  fired.
- CLI: positional files/dirs, `--transcripts DIR`, `--project ROOT` (resolve escapes), `--only
  R1,R7`, `--fail-on <sev>` (CI exit 1), `--json`, `--out FILE`, `--list-rules`. Heuristic and
  conservative — it reports, it does not block.
- `SKILL.md`: new **Step 5 — scan agent transcripts** with the usage examples and the R1–R9 rule
  table; the intro now names both scanners.

## 0.2.1

- Corrected `SKILL.md` to match the runtime: there is **no built-in `{"*": "allow"}`** in the
  permission list. The effective order is global `opencode.json` → agent map (agent last,
  last-match-wins), and **when no rule matches the fall-through default is `ask`** — so an agent
  with no `bash` map prompts on every unnamed segment, and because a bash call is one atomic unit
  the whole compound call fails non-interactively.
- Added the **restart requirement** to the dynamics: config and agent files are read at STARTUP and
  do not hot-reload, so a running server keeps the definition its sessions started with and a fixed
  map still prompts in a session born before the fix.

## 0.2.0

- Scanner: per-agent **LEADERBOARD** (prompts, sessions prompted/total, asks-per-session,
  %-sessions, wasted sum/median, low-confidence count) and **attribution confidence** per prompt
  (`HIGH`/`LOW`) from a rolling window over each `run`'s stream agents.
- Scanner: **triggering-segment** analysis — the segments no observed winning allow pattern covers —
  and a **rule-suggestion engine** folded into Section 7 (suggested allow patterns by prompts
  cleared, plus fall-through segments).
- Scanner: new **Section 4 DENY SUMMARY** (rule × agent) split from the flat 4b DENY CATALOG, and
  **Section 8 AGENT RULE INVENTORY** (each session's agent ruleset, from `message=created`).
- Scanner: `--rank` (leaderboard only), `--format json`, `--since`/`--until`/`--split` windowing,
  a parsed-log cache with `--no-cache`, and `trigger`/`confidence` export columns.
- Scanner perf: Section 6 now derives error shapes from the already-fetched tool parts instead of a
  full-table `LIKE '%ermission%'` scan (~35 s on a 23 GB store, for ~8 rows); all-agents `--rank
  --format json` went from >120 s (timeout) to 19.7 s. Section 6 prints an explicit none-case when
  the scanned sessions have no permission-family error.
- `SKILL.md`: documents the new flags, the leaderboard, confidence, and the renumbered sections;
  the `SECTION 7 — AGENT BASH MAP & FIX SUGGESTION` reference is unchanged.

## 0.1.0

- Initial skill: `scripts/opencode-permission-scan.py` — mines the opencode log and session DB for
  every permission ask (exact script segments, cwd, session, inferred answer), wasted-time deltas
  (overall / approved / rejected), a deny catalog, an auto-reject catalog, all permission-family DB
  error shapes, and a per-agent bash-map verdict with a drop-in corrected `permission.bash` block.
- `SKILL.md`: the audit workflow (scan → read Section 7 verdict → apply the fix → prove with a temp
  probe agent) plus the opencode inspection cheatsheet and the permissioning dynamics.
