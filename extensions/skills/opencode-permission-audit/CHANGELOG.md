# Changelog

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
