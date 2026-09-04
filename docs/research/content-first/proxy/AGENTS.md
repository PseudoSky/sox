# AGENTS.md — cf/fj proxy project

The content-first (CF) + fork-join (FJ) proxy experiment. **All analysis of
sessions starts with `query.py` — read the logs through it, never by hand.**
It extracts strictly from the per-session JSONL logs: no inference, every
field is a log event.

## Log layout

- `proxy-ses_<session>.jsonl` — one per session; events in order:
  `session_start`, `raw_request` (incoming body), `forward_request` (the
  ACTUAL provider payload — post-rewrite, what the model really saw),
  `raw_response` (verbatim SSE + usage), `turn`/`fj_turn` (metrics).
- `proxy-ses_<session>_fj-<uuid>.jsonl` — one per fork sub-session (isolated
  capture: its own raw events + usage).
- The fj fork of a session `<main>#fj-<uuid>` logs to `proxy-ses_<main>_fj-<uuid>.jsonl`
  (`#` is sanitized to `_`).

## query.py — structured log queries

```bash
python3 query.py sessions                # all session ids, newest first
python3 query.py sessions --last         # newest session id + all fork sub-session ids
python3 query.py turns <session-id>      # per-turn rows for a session + its forks
python3 query.py turns --sessions <a> <b>  # the same over a SET of sessions, chronological
python3 query.py turns --json <id>       # same rows as JSON
```

Per-turn row fields (one row per provider request):

| field | source event |
|---|---|
| `session_id` | log filename |
| `agent` | the persona name in the forwarded payload's `--- CF-AGENT:<name>:sha256:` marker — the agent ACTUALLY sent to the provider. Empty for main turns that run as the base opencode agent (no named persona) |
| `persona_index` | the MESSAGE INDEX of the persona block, READ FROM THE DATA — scan the forwarded messages from the tail and report where the last `CF-AGENT` marker block sits (the appended suffix). Never assumed from `message_count`; a leaked mid-conversation marker reports its actual position |
| `message_count` | `forward_request.messages` length |
| `has_cf_instructions` | position-0 carries `--- CF-Instructions:v4 ---` |
| `has_fj_instructions` | any message carries the FJ handoff trigger text |
| `cached_tokens` | `raw_response.usage.prompt_cache_hit_tokens` |
| `uncached_tokens` | `prompt_tokens − cache_hit` |

Design notes:
- The CF/FJ instructions are **session-id-free** — position 0 is byte-identical
  across sessions and persona transitions (cross-session + cross-persona cache).
  The session id rides the persona tail as `SESSION_ID=…`; recipes use
  `$SESSION_ID`.
- `has_cf_instructions` should be **False** on every fj request (`cf_instructions:
  false` — no injection; extraction only). If it is True, the injection option
  regressed.
- `has_fj_instructions` should be True on main turns (FJ trigger on the persona
  tail) and False on forks (forks carry no FJ text).

## aggregate-session.mjs — per-run CF/RF metrics

```bash
node aggregate-session.mjs <session-id>          # auto-detect CF or RF
node aggregate-session.mjs --cf <session-id>     # aggregate a CF session
node aggregate-session.mjs --rf <dispatcher-id>  # aggregate RF dispatcher + all sub-sessions
node aggregate-session.mjs --json <session-id>   # JSON output
```

Metrics: cached-read % (`prompt_cache_hit_tokens / prompt_tokens`), cache-miss
(writes, charged at miss rate), per-stage time (dead gaps >2 min excluded),
handoff cold-start penalty (sum of first-turn uncached over the chronological
agent-swap sequence).

## Validation

```bash
node verify-cf-instructions.mjs    # 65 assertions on the rewrite + instructions (real code, not a mirror)
```

## Proxy ops

```bash
./restart-cf-proxy.sh              # restart the proxy (port 3333)
curl -s localhost:3333/v1/health   # health check (NOT /v1/chat/fork — legacy, wrong contract)
```

## Guardrails

- Do not touch `bin/soxe` (CLI shim) or the `libs/data` bundle consumers in
  this repo; this project is self-contained under `docs/research/content-first/`.
- The legacy `/v1/chat/fork` endpoint is dead weight (wrong contract, confuses
  the model) — do not rely on it.
- The `fj-judge` agent is DORMANT and has been moved out of the agent registry
  (it caused the main agent to misidentify as the judge); do not re-add it.
