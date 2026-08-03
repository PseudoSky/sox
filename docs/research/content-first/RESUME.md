# Content-First Architecture — Session Handoff / Resume

> **For resuming work after a session compaction.** Current state of the content-first research + proxy development, what's proven, what's broken, what's next.

**Last updated:** 2026-08-03 (end of session)
**Branch:** `wip/turso-live-metrics`
**Proxy:** port 3333, bind `127.0.0.1`, model `deepseek-v4-flash`

---

## 1. Session Summary — What We Did

### Proxy fixes (4 commits)
- `96185ef` **Never empty position-0.** When opencode SP has no agent-body prefix (bare base in a chained session), `splitSystemPrompt` returned `shared=''` → position-0 system message emptied → provider prefix cache destroyed. Fall back to full opencode SP. Before: `sharedSysLen=0` on 100% of typescript/review turns. After: `sharedSysLen=54409` stable.
- `be2d312` **CF instructions at position 0.** Handoff recipe + session id moved from per-turn persona tail to cached anchor. Saves ~268 tokens/turn.
- `8c11661` **Restore persona-as-last-user-suffix.** Reverted `bc7de01`'s trailing-system-message. Persona appended to last user message (RESUME.md §2 design). This is the structure that produced 82-93% cross-agent first-turn cache reuse in sessions `03c0c039c` and `03c3312d1`.
- `35eb9a1` **Remove pendingInput injection + add 6 per-request metrics.** Handoff task embedded in persona suffix (warm handoff) or omitted (cold handoff). No redundant user message injection. Added `shared_chars`, `persona_chars`, `context_chars`, `persona_turns`, `persona_ctx_chars` to turn logs.
- `5995bc3` **Embed handoff task in persona suffix** — explicit trigger without separate message.
- `a6f990c` **Document warm/cold handoff modes** in CF instructions.
- `41ad4cb` **Repeated-read monitoring** — tracks file read/write per session, logs `repeated_reads` events for cross-agent knowledge detection.
- `59f38d9` **Bind 127.0.0.1** — no auth on this proxy.
- `8c883c3` **Robust session detection + monitoring** in experiment script.

### Experiment framework
- **`experiments/SDLC-v0.0.1.md`** — hypothesis, expected metrics, results template
- **`run-sdlc-experiment.sh`** — launches both arms in parallel, monitors proxy logs, runs aggregator
- **`aggregate-session.mjs`** — per-stage and aggregate metrics from session logs
- **Agents:** `SDLC-RF` (`model: proxy/rf`) and `SDLC-CF` (`model: proxy/cf`) — monolithic SDLC agents, identical prompts, differ only in proxy model
- **Removed:** `backlog-manager-cf/rf`, `backlog-triage-cf/rf`, `cf-chain-dispatcher`

### Proven
- Cross-agent conversation cache reuse **confirmed working** on live CF chain (`0377c94e`: product→typescript→researcher, 62-73% first-turn reuse)
- Handoff penalty formula verified: `new_agent_cached ≈ prev_total - prev_persona - user_text` (deviation <500 tokens for researcher handoff)
- CF monolithic run: 111 turns, 14.6M tokens, 99.1% savings, delivered `acceptance.md` + `spec.md` + `review.md`

---

## 2. Proxy Architecture (Current)

**File: `proxy/cf-proxy.mjs`** — session-aware content-first proxy

### Endpoints
- `POST /v1/chat/completions` — OpenAI-compatible, session-aware, streaming
- `POST /v1/session/agent` — warm/cold persona switch
- `GET /v1/session/:id` — session state
- `GET /v1/agents` — agent registry
- `POST /v1/chat/fork` — content-first fork
- `GET /v1/health` — health check

### Rewrite (CF mode)
```
[0] system: shared boilerplate + CF instructions    ← position 0, cache anchor
[1..n] history (untouched)
[last user]: original + "\n\n--- Role ---\n[Task: <handoff>]\n<persona body>"
```
- Shared never empties (falls back to full opencode SP)
- Persona as last-user-message suffix (proven cache reuse structure)
- Warm handoff: `Task: <input>` embedded between marker and persona body
- Cold handoff: persona body only, no task

### Metrics (per turn, both CF and RF paths)
`shared_chars`, `persona_chars`, `context_chars`, `persona_turns`, `persona_ctx_chars`, `tokens`, `cached`, `savings_pct`

---

## 3. How to Run

```bash
# Start proxy (if not running)
cd docs/research/content-first/proxy && ./restart-cf-proxy.sh

# Run experiment
./run-sdlc-experiment.sh \
  --backlog-id BUG-WORKSPACE-GEN-006 \
  --repo ~/dev/node/adhd \
  --timeout 120

# View live metrics — the script polls every 10s, runs aggregator
# Ctrl+C kills ONLY spawned opencode children (never the proxy)

# Post-run analysis
node aggregate-session.mjs <cf-session-id>
node aggregate-session.mjs --rf <rf-session-id>
```

---

## 4. Commits on this branch (2026-08-03 session)

| Commit | What |
|--------|------|
| `96185ef` | Never empty position-0 — shared anchor fallback |
| `be2d312` | CF instructions at position 0 — cached once |
| `8c11661` | Restore persona-as-last-user-suffix — cross-agent cache reuse |
| `3081624` | Update RESUME.md — cross-agent cache reuse restored |
| `35eb9a1` | Remove pendingInput injection + 6 per-request metrics |
| `5995bc3` | Embed handoff task in persona suffix |
| `a6f990c` | Document warm/cold handoff modes |
| `41ad4cb` | Repeated-read monitoring + SDLC session aggregator |
| `fbac582` | run-sdlc-experiment.sh — parallel CF/RF launch + live monitor |
| `cff2bdf` | Make run-sdlc-experiment repo-agnostic |
| `59f38d9` | Bind proxy to 127.0.0.1 |
| `8c883c3` | Robust session detection + simplified monitoring loop |
| `6cf55fb` | Update RESUME.md — experiment framework |

---

## 5. Experiment Framework — SDLC-v0.0.1

**→ [`experiments/SDLC-v0.0.1.md`](./experiments/SDLC-v0.0.1.md)**

Both arms run the same monolithic SDLC prompt. Only difference: `proxy/rf` vs `proxy/cf`.

| | RF | CF |
|---|---|---|
| Agent | `SDLC-RF` | `SDLC-CF` |
| Model | `proxy/rf` (passthrough) | `proxy/cf` (rewrite) |
| Position-0 | Full agent SP (~3K chars) | Shared boilerplate + CF (~63K chars) |
| Persona | None (full SP at pos 0) | Last user message suffix |
| Session | One `opencode run` | One `opencode run` |

### Key comparison metrics
- `shared_chars` — RF: per-agent SP; CF: shared anchor (~63K)
- `persona_chars` — RF: 0; CF: persona body
- `context_chars` — conversation minus shared/persona
- `savings_pct` — RF per-turn SP vs CF cached anchor
- `handoff_penalty` — first-turn uncached (CF should be near 0)

---

## 6. Known Issues

1. **Restart with `restart-cf-proxy.sh`, NEVER `kill $(lsof -ti:3333)`** — kills opencode too.
2. **Commitlint scope warnings** are cosmetic — commits land.
3. **`(passthrough)` / `(unassigned)` agent names** in old sessions — the proxy can't resolve SDLC agent bodies from the opencode SP because frontmatter is stripped. New aggregator maps these to `SDLC-RF`/`SDLC-CF` based on the model field.
4. **Bare-repo worktree isolation** — `git worktree list` is public. External worktrees (`~/dev/.sdlc-experiments/`) are unreachable by `grep -r` from the repo but visible via git commands.
5. **`opencode run` exits after completion** — CF chain handoffs need a persistent session. Current workaround: monolithic agents.

---

## 7. Next Steps

1. **Run the experiment to completion** — both arms, collect metrics
2. **Compare CF vs RF** — fill in `SDLC-v0.0.1.md` results template
3. **Iterate** — `SDLC-v0.0.2.md` with fixes from v0.0.1 notes
4. **Long-term:** fix agent body detection for SDLC agents (frontmatter mismatch)
