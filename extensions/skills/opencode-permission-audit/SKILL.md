# opencode Permission Audit

Audit why an opencode agent gets prompted for permission (or has calls blocked), then fix the
agent's `permission.bash` map and prove the fix. Ships `scripts/opencode-permission-scan.py`.

## When to use

Any time an agent prompts too often, a dispatched subagent's command fails with a permission
error, or a call comes back "The user rejected permission…" / "…specified a rule which prevents
you…". Typical trigger: "every command this agent runs prompts me".

## Step 1 — Run the scanner

```sh
python3 <skill-dir>/scripts/opencode-permission-scan.py --agent <id> --out /tmp/<id>-perms.txt
```

- Omit `--agent` (or pass no names) to cover every agent. `--agents-dir` overrides
  `~/.config/opencode/agents`; `--export path.tsv` writes raw rows
  (`agent, ts, request_id, permission, cwd, session, outcome, answer, wasted_ms, trigger, confidence, script`).
- `--rank` stops after the leaderboard (fast triage across many agents). `--format json` emits the
  whole report as structured JSON. `--since`/`--until` window the events; `--split <ISO>` adds a
  before/after leaderboard. `--no-cache` bypasses the parsed-log cache (the cache only hits on a
  quiesced log, since its key includes the live file's mtime).
- **Constraints:** `rg`, never grep/find. Never unbounded `select data from part` (the DB is
  ~24 GB; a single Read part is ~958 lines). Read the report the tool writes — do not re-derive
  it from the DB by hand.

## Step 2 — Read the verdict

Read the report's **SUMMARY** table (prompt count, wasted time, sessions affected, deny/auto-reject
counts) and **SECTION 7 — AGENT BASH MAP & FIX SUGGESTION**, which prints the agent's installed
map, a verdict, the guardrails it fails to restate, the segments that trigger prompts, and a drop-in
`permission.bash` block.

Before the numbered sections, the report leads with a **LEADERBOARD** — per agent: prompts,
sessions prompted/total, asks-per-session, %-sessions, wasted sum/median, and low-confidence
attribution count. Sections: 0 WASTED TIME · 1 PROMPTS (+1b FOREIGN) · 2 SESSIONS · 3 ANSWER
EVIDENCE · 4 DENY SUMMARY (rule × agent) · 4b DENY CATALOG · 5 AUTO-REJECTS · 6 permission-family
error shapes · 7 BASH MAP & FIX SUGGESTION · 8 AGENT RULE INVENTORY (each session's agent ruleset,
from `message=created`).

Attribution confidence is per prompt: `HIGH` when every recent stream line in the ask's `run` named
the same agent, else `LOW` (interleaved run) — a LOW-confidence agent row means the count may
over-attribute.

The verdict is `DEFECT` when the map's catch-all is `ask` — with `"*": "ask"` every segment the map
does not name prompts, and because a bash call is evaluated as one unit (see dynamics below) a
single unnamed `echo`/`tail`/`rg`/`ls` asks the WHOLE call.

If Section 7 is not enough, get the live effective ruleset directly: **trigger one denied command
and read the error — the error embeds the ENTIRE merged ruleset**. That is the cheapest way to read
what an agent is actually running under.

## Step 3 — Apply the fix

Replace the agent's `permission.bash` with the suggested block: a leading **`"*": "allow"`**
catch-all, then the agent's own ask/deny entries, then every guardrail the map had been shadowing —
**guardrails LAST**, because last-match-wins. Never leave `"*": "ask"` first.

Edit the extension source (`extensions/agents/<id>/extension.json` → `agent.permission.bash`), bump
`version` and `render.claude.version` together, install to each declared host, and verify the
deployed file at `~/.config/opencode/agents/<id>.md`.

## Step 4 — Prove it with a temp probe agent

Do not trust the source; run the real runtime.

1. Write a temp agent to `~/.config/opencode/agents/<id>-probe.md` carrying the candidate map
   (`permission: {read: allow, bash: {...}}`) and a one-line body telling it to run each given
   command, one bash call each, and report OK/FAILED.
2. `opencode run --agent <id>-probe "$(cat <commands-file>)"`.
3. Non-interactive `ask` auto-rejects, so the outcome is binary: allowed commands run, ask/deny
   commands fail. Expect the agent's real command batches to run unprompted and its guardrail
   patterns to still block.
4. Delete the temp probe agent afterwards.

## Cheatsheet — inspecting opencode

Verified against opencode **1.18.32**. Version gates behavior — re-check `opencode --version` first.

| Path | Holds |
|---|---|
| `~/.local/share/opencode/opencode.db` (+`-shm`,`-wal`) | SQLite ~24 GB — sessions, messages, parts, events, projects, kv |
| `~/.local/share/opencode/log/opencode.log` | SINGLE log, no rotation — the runtime event stream |
| `~/.local/share/opencode/storage/` | `migration/`, `session_diff/`, `plugin/` |
| `~/.local/state/opencode/` | `kv.json`, `locks/`, `model.json`, `prompt-history.jsonl` — no permission store |
| `~/.config/opencode/` | `agents/`, `skills/`, `refs/`, `opencode.json` |

Rule: **DB for content, LOG for behavior, storage/ for per-session, opencode.json for config.**
Read the DB read-only: `sqlite3 "file:$HOME/.local/share/opencode/opencode.db?mode=ro" "<SQL>"`.
There is no `question` table; the `permission` table is the persisted per-project allow-rule store,
not a request log.

Log line grammar (`timestamp=<ISO> level=INFO run=<id> message=<kind> <k=v…>`):

- `message=asking id=per_<ID> permission=<kind> patterns=[…]` — the ask. Field is `id=per_`, never
  grep bare `per_` (`per_page`/`cost_per_step` false positives).
- `message=evaluated permission=<kind> pattern=<input> action.permission=<kind> action.pattern=<rule> action.action=<allow|ask|deny>`
  — every rule check.
- `message=stream … session.id=ses_<ID> small=false agent=<agent> mode=all` — the rolling attribution
  anchor (`run=` is a long-lived server-process id shared by interleaved sessions).
- `message=created id=ses_<ID> … directory=<abs path> … agent=<agent> permission="[{…}]"` — carries
  the session's cwd, agent, and ruleset; no DB join needed.

Ask requests are **not** in the DB (in-memory event only), and **the user's reply to an ask is
recorded nowhere** — the answer must be inferred from the DB tool-part outcome (`status=completed`
⇒ ran ⇒ allowed; `The user rejected permission…` ⇒ rejected; `The user has specified a rule which
prevents…` ⇒ denied by rule).

### Permissioning — the dynamics

- Effective rule list is **[built-in `{"*":"allow"}`] then [global `opencode.json`] then [agent map]**.
  **Last match wins.**
- Because the agent map comes last, an agent that declares its own `bash` map owns every segment; any
  segment it does not name falls to its own catch-all. A leading `"*"` in the map **shadows every
  global rule the map does not restate** — so an agent map must restate the global guardrails LAST.
- A bash call is evaluated as **one atomic unit** (segments split on `;`/`&&`/`|`): if any segment
  resolves to `ask` or `deny`, the WHOLE call is refused and nothing runs.
- In any non-interactive run (`opencode run`, a dispatched subagent) an `ask` is **auto-rejected**,
  so a prompt is not a pause — it is a FAILED call.
- In 1.18.32 "Always allow" persists nowhere durable (the `permission` table stays empty); durable
  project-scoped persistence is a V2.0.x feature. Encode durable rules in `opencode.json` instead.
