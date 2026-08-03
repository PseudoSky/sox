# Content-First Architecture — Session Handoff / Resume

> **For resuming work after a session compaction.** Current state of the content-first research + proxy development, what's proven, what's broken, what's next.

**Last updated:** 2026-08-03
**Branch:** `wip/turso-live-metrics`

**Recent commits (2026-08-03 — cross-agent cache reuse restoration + metrics):**
- `35eb9a1` **Remove pendingInput injection** — handoff tasks read from session_agent_set tool call in conversation (no redundant message); restores monotonic prefix growth across handoffs. Add 6 per-request context metrics to turn logs and console.
- `8c11661` **Restore persona-as-last-user-suffix** — reverted bc7de01's trailing-system-message change; persona appended to last user message per §2 design. Restores the structure that produced 82-93% first-turn cache reuse in 03c0c039c/03c3312d1.
- `be2d312` **Move CF instructions to position 0** — session-constant handoff recipe moved from per-turn tail to cache anchor; saves ~268 tokens/turn.
- `96185ef` **Never empty position-0** — shared anchor falls back to full opencode SP when splitSystemPrompt returns '' (bare base in chained sessions).

---

## 1. Where to pick up

The work is split into two active threads. Read both before continuing.

### Thread A — The thesis (COMPLETE, background)
- `README.md` — core idea, economics, vision
- `content-first-thesis.md` — competitive thesis, moat
- `PATTERNS.md` — 26 patterns (9 agent + 6 SDLC + 7 cross-domain)
- `instruction-hierarchy-experiment.md` — IHE-1 quality experiment (CF ≡ RF proven, d=0.200)
- All cache economics proven: 60-93% savings, 95% real-session hit rate

### Thread B — The proxy (ACTIVE, in progress)
This is where current work lives. **`proxy/cf-proxy.mjs` (port 3333) is the production proxy.** `proxy/cf-chain.mjs` (port 3334) is a separate session-state experiment.

---

## 2. Proxy architecture (current state)

**File: `proxy/cf-proxy.mjs` — 726 lines, session-aware content-first proxy**

### What it does
- OpenAI-compatible server. opencode points at it via the `proxy` provider (`proxy/cf` = content-first rewrite, `proxy/rf` = passthrough)
- Reads opencode's real session id from the **`x-session-id` header** (opencode sends it — verified in raw capture)
- Per-session log files: `proxy-<sessionid>.jsonl`
- Content-first rewrite: shared boilerplate stays at position 0 (cache anchor), agent persona appended as `--- Role ---\n<agent body>` to the last user message
- Session persona tracking: detects agent from opencode's system prompt, persists to session
- API override via `POST /v1/session/agent` — switches the session's active agent
- Virtual `set_session_agent` tool — **CURRENTLY DISABLED** (reverted, see section 4)

### Key verified behaviors (all tested)
1. Agent SP detection on first message: ✅ (architect detected from real SP)
2. Manual dropdown swap detection: ✅ (architect → review → refactor → typescript all detected)
3. API override via `/v1/session/agent`: ✅
4. Foreign-SP leak fix: ✅ (override holds against re-sent dropdown SP; releases on catch-up)
5. True streaming: ✅ (reverted from blocking; the blocking path hung with opencode's max_tokens=32000)

### Config / provider registration
`opencode.json` has the `proxy` provider with models `rf` (passthrough) and `cf` (rewrite). Global config at `~/.config/opencode/opencode.json` also has it.

---

## 3. Commits on this branch (chronological)

| Commit | What |
|--------|------|
| `1ae3251` | Session-aware proxy + chain experiments (initial) |
| `7546767` | Strip `stream_options` from blocking upstream calls (fix: Upstream 400) |
| `8367caf` | Revert to true streaming (fix: blocking path hung with max_tokens=32000) |
| `2e6bcf5` | Add persona-application verification log |
| `ddec69d` | **Fix foreign-SP leak** — override holds until dropdown catches up |
| `96185ef` | **Never empty position-0** — shared anchor fallback for bare base SPs |
| `be2d312` | **Move CF instructions to position 0** — cached once, zero per-turn waste |
| `8c11661` | **Restore persona-as-last-user-suffix** — cross-agent cache reuse (reverts bc7de01 trailing-system regression) |

**The proxy on 3333 matches the §2 design.**

---

## 4. Session id discovery — problem RESOLVED IN DESIGN (see §7 options)

**Background:** When the agent called `POST /v1/session/agent` to switch to `typescript` (log: `session_agent_set: typescript` at 19:02:05 in `proxy-ses_03c3312d1ffeebNMmJC5HoZ7Lg.jsonl`), how did it learn its own session id? We established:
- opencode does NOT expose the session id to bash env vars (user-confirmed)
- The session id appears nowhere in stored logs / tool results we can see
- The agent's actual discovery method was fragile (grep session files, guess from context)

**The design insight (verified against code `cf-proxy.mjs:563-571`):** the proxy is a stateful *request* observer. Every turn, opencode sends full history (incl. previous `tool_calls` + `tool` results) to `/v1/chat/completions`, and the session is bound via the `x-session-id` **header** on that request. **The agent never needs to know its session id** — any switch the agent triggers is visible in the *next* request's history, and the proxy already knows which session that history belongs to. This reframes both requested solutions (see §7).

---

## 5. What was reverted / disabled (do not re-enable blindly)

### The virtual `set_session_agent` tool — DISABLED, and the approach is superseded
- Was implemented, then reverted in `8367caf`
- **Why:** the virtual tool required a *blocking* upstream call (to intercept the tool call before streaming to the client). With opencode's `max_tokens: 32000`, the blocking path waited for the FULL response before streaming → appeared hung / never completed
- The fix attempt (strip `stream_options`, 7546767) fixed the 400 but not the hang
- **Root cause, not just the hang:** opencode executes tools **client-side**. The proxy cannot synthesize a tool result into a stream the client already owns. Any interception-based design fights the client.
- **Do NOT re-enable as-is.** The correct replacement is request-history observation (Option 1 in §7): the proxy reacts to tool calls in the *next* request's history instead of intercepting the stream.

### The chain proxy (`cf-chain.mjs`, port 3334)
- Separate experiment for session-state chained agent switching (triage → judge → implement → review)
- Has its own bugs (session id lookup, tool preservation) — NOT production-ready
- The main proxy (3333) is the one to use

---

## 6. Known issues / gotchas

1. **Restart the proxy with `restart-cf-proxy.sh`, NEVER `kill $(lsof -ti:3333)`.** The port-based kill has killed the opencode service TWICE: `lsof -i:3333` matches both the listener (proxy) AND any client — opencode holds a live client connection to 3333 during an active session, so `lsof -ti:3333` returns both PIDs and `kill $(...)` kills both. The safe script kills by exact process identity (`pgrep -f "^node cf-proxy\.mjs$"`), which can never match opencode. See `proxy/restart-cf-proxy.sh` for the documented procedure.
2. **Per-session logs** are gitignored (`proxy/.gitignore` ignores `*.jsonl`) — session data is ephemeral, not committed
3. **Commitlint scope warning** is cosmetic (scope `research` not in the allowed list) — commits still land
4. **The `rewrite:` debug line** in stderr (`personaApplied=true sharedSysLen=N`) verifies the persona actually reached the forwarded messages — check it when debugging persona application
5. **Cache block minimum:** DeepSeek needs ~1,024 tokens before cache engages. Short conversations show 0 cache — expected, not a bug. Real sessions hit 95-99%+
6. **Content dilution:** at 60K+ token contexts, a ~3K-token persona suffix is a small signal — the model may "not notice" the agent switch even though the SP is verifiably applied. This is a model-behavior property, not a proxy bug.
7. **Uniform metrics schema (since `ab7ca0f`):** both RF and CF arms log the same per-turn fields — `{agent, turns, passthrough, tokens, cached, output, savings_pct, model}` — so per-agent cache comparison is direct. RF turns resolve the agent name from the opencode SP via `resolveAgent`.
8. **Spec-hiding is INCOMPLETE unless files are deleted from disk, not just reset from git (2026-08-02, FIXED).** The FEAT-002 spec was "moved into the worktree" via `git reset --soft` on the bare repo — this removed the commit from `main`'s history but **left the files on disk** at `/Users/nix/dev/node/adhd/docs/apigen/design-notes/`. A CF-run product agent found them via `ls docs/apigen/design-notes/` and read the impl-spec, contaminating that run. **Fix applied:** deleted the files from the bare-repo path (they remain in the `feat-002-ir-cache` worktree branch, verified). Rule: to hide a spec, delete from disk AND reset from history.
9. **The bare-repo git trap (2026-08-02, OPEN).** `/Users/nix/dev/node/adhd` is a **bare repo** with worktrees. Agents that run `git status` / `git diff` there get "fatal: this operation must be run in a work tree", then probe `.git/config` (bare=true) and `ls .worktrees/` to understand the layout — which is how the CF product agent incidentally listed the RF run's worktrees (`chain-20260802-181829`, etc.) and `git worktree list`. The worktree discovery was a side effect of debugging the bare-repo layout, not a deliberate copy attempt — but **worktree isolation is structurally advisory**: `git worktree list` is a public read command no prompt rule can fully prevent. Documented risk, not yet fixed.

---

## 7. Immediate next steps (priority order)

**Decision on session-id discovery (user: "either tool-call switching handled by the proxy correctly, OR the endpoint resolves the session id without the agent specifying it"):**

- **Option 1 (RECOMMENDED) — In-band switch via magic bash command.** Agent runs `bash: cf-switch <agent>`. opencode executes it (bash always exists, no env dep). The NEXT `/v1/chat/completions` request carries that tool call in history; the proxy detects `cf-switch <agent>` in `tool_calls[].arguments.command`, applies the switch exactly like the endpoint does, and rewrites the tool result to `✓ switched active agent to <agent>` so the model sees success and continues in the new persona. Session id never transmitted by the agent — the request is already header-bound. No interception, no buffering, no hang. One-turn latency is inherent & fine. **NOT YET IMPLEMENTED.**
- **Option 2 — Session handle injected into context.** ✅ **IMPLEMENTED + VERIFIED.** `renderCFInstructions(sessionId)` bakes the session id + handoff curl recipe into every forwarded turn. The agent learns its session id from its own context. `/v1/session/agent` accepts full id (handle support not yet added — full id only).
- **Option 3 — Phantom tool in forwarded `tools` list.** Not implemented.
- **Option 4 — Single-active-session fallback.** Not implemented.

**FIXES SHIPPED (2026-08-02, commit pending):**
1. **Shared-split bug (the empty-system bug):** `rewriteToContentFirst` now derives `shared` from the **opencode SP** (`splitSystemPrompt(opencodeSP || system)`) and `agentRole` from the **persona body** (`splitSystemPrompt(personaSP || opencodeSP || system)`) — they were wrongly conflated via `personaSP || system`, which yielded `shared=''` once a session agent was active, destroying the system message AND the cache anchor. Verified: real-turn replay now yields `sharedSysLen=38033`, was `0`.
2. **Persona placement (the perception bug):** the persona is now a **trailing SYSTEM message** (`--- Role ---\n<persona>` + CF prompt), NOT a suffix on the last user message. A model reads system-role content as its governing role; user-role content reads as "text you pasted". Verified live: `personaApplied=true`, user message left clean, tool chain intact.
3. **Handoff-with-input path:** now routes through `rewriteToContentFirst` (consistent trailing-system persona) + fixes latent `session.lastTools` never-set bug (was passing `undefined`; now `|| []`).

**Debug log line now reports both invariants:** `rewrite: activeAgent=? personaApplied=true sharedSysLen=38033 agentRoleTokens=...` — check `sharedSysLen>0` on real opencode turns to confirm the anchor survives.

Implementation order (remaining):
1. **Option 1** — magic bash switch (`cf-switch <agent>` detection in request history).
2. **Request-body logging** for `/v1/session/agent` (log the exact `sessionId`/`agent` the caller sent).
3. Option 3 only if opencode's unknown-tool handling checks out clean.
4. **Long-term:** context pruning on agent switch to fight dilution (collapse prior agent's turns into a summary so the new persona isn't buried at 60K tokens).

---

## 8. Key files map

| File | Purpose |
|------|---------|
| `proxy/cf-proxy.mjs` | **Production proxy** — session-aware, streaming, content-first (3333) |
| `proxy/cf-chain.mjs` | Chain experiment — session-state persona handoffs (3334, not prod) |
| `~/.config/opencode/agents/cf-chain-dispatcher.md` | **RF-mode chain conductor** — dispatches product→architect→typescript→review through `proxy/rf`, reproducing the CF chain externally (the RF A/B arm) |
| `proxy/README.md` | Proxy harness docs — dual-model A/B, logging schema |
| `scripts/verify-chain-mechanism.mjs` | 12-check session mechanism test |
| `scripts/test-chain-*.mjs` | Chain tests (experimental) |
| `opencode.json` | `proxy` provider (`rf`/`cf` models) |
| `README.md` | Thesis overview + document map |
| `PATTERNS.md` | 26 patterns |
| `instruction-hierarchy-experiment.md` | IHE-1 quality experiment |
| `sessions/*.json` | Raw experimental session data |

---

## 9. RF vs CF — how to run the same task both ways

The same multi-agent task (e.g. product → architect → typescript → review) runs
in both modes; the difference IS the measurement:

- **CF (`proxy/cf`)** — one session, self-handoff. The proxy appends the
  persona as a trailing system message and swaps it on `/v1/session/agent`.
  Position-0 shared anchor stays cached: ~99% reuse across handoffs (verified:
  `ses_03bd61c17ffe1osvDE8wZAzV5c`, 148 turns, 3 handoffs, 90-99% savings).
- **RF (`proxy/rf`)** — external sequencing required. The persona is the full
  system prompt at position 0; a model cannot switch itself, so the
  **`cf-chain-dispatcher`** agent dispatches the chain as its own opencode
  agents through `proxy/rf` — product selects a feature, architect specs it,
  typescript implements it, review verifies it — forwarding each stage's
  output to the next. **The dispatcher creates a fresh, uniquely-named
  worktree before dispatching anything** (random slug, branched from main)
  and passes that exact opaque path to every stage, so stage agents cannot
  discover other worktrees (e.g. a prior CF run's `feat-002-ir-cache` with
  the full implementation) and copy code from them. Architect writes the
  spec inside the worktree, never on main.

**Fairness:** the dispatcher receives only the process description (dispatch
product → architect → typescript → review through `proxy/rf`, one fresh
worktree) and the agent registry — the same information the CF prompt injects
into a CF session. It does not receive the chain's answers, deliverable
formats, or termination rules from any prior run.

**Observed behavioral divergence — claim/lock (2026-08-02):** the CF run's
product agent **claimed** its selected feature via the backlog CLI
(`backlog claim-item --repo adhd --human-id FEAT-002 --by
"product:feat002-pipeline-20260802"` — verified in the session log + item
state). The RF run's product agent **selected** FEAT-APIGEN-TS-TYPE-CODEGEN-001
but did **not** claim it (item still OPEN, `claimedBy: None`, no claim note —
verified in the DB). Neither prompt mentions claiming, so the divergence is
agent initiative, not prompt content. **Interpretation: the CF run understood
the mission better** — locking the chosen item is the mission-completing
action (it prevents double-picking and leaves an audit trail); RF's product
agent stopped at "select and state a decision." This is a behavioral-quality
signal beyond the cache economics, and it compounds the A/B: the arms
differ not just in cache reuse but in how completely each agent executes the
intended workflow. Worth probing in a follow-up (e.g. whether the RF arm's
failure to claim correlates with the thinner stage prompts or with the
external-sequencing structure).

**To run the A/B:** run the same task with the `cf-chain-dispatcher` agent
(RF arm) and through the CF self-handoff chain (CF arm); compare
`rf_cached/input` vs `cf_cached/input` per stage from the `proxy-ses_*.jsonl`
logs. The delta is the content-first thesis on identical work.

## 8. Experiment Framework — SDLC-v0.0.1

The experiment design, expected metrics, hypothesis, results template, and
iteration process are documented in:

**→ [`experiments/SDLC-v0.0.1.md`](./experiments/SDLC-v0.0.1.md)**

### Summary

**Flow:** product (acceptance criteria) → architect (spec) → typescript (implement)
→ review (verify) → [correct?] → product (final sign-off)

**Isolation:** worktrees under `~/dev/.sdlc-experiments/arm-{cf,rf}/` outside the
repo. No shared state writes. Banned writes to `~/.adhd/`, repo, or shared paths.
Both arms start chroot'd to their worktree.

**Feature:** pre-written to `<worktree>/FEATURE.md` at experiment setup. Same
feature for both arms. Product writes acceptance criteria to docs/ (not backlog).

**Hypothesis:** CF will show 80–99% cross-agent first-turn cache reuse vs RF's
near-0%; lower per-run SP loading overhead (same 63K anchor per turn vs per-agent
SPs); faster handoff recovery; equivalent-quality deliverables.

**Metrics collected per stage:** turns, tokens, cached, savings%, first-turn
cached/savings, shared_chars, persona_chars, context_chars, persona_turns,
persona_ctx_chars, SP loading overhead (shared_chars × turns for CF).

**Aggregate metrics:** total tokens, handoff penalty (uncached tokens at first
turns), SP loading overhead (chars), correction loops, review verdict.

**Iteration:** each run writes results to the versioned file, notes improvements,
then increments to `SDLC-v0.0.2.md`. RESUME.md points to latest.

### Per-Turn CF Overhead (Aggregated from FEAT-002 Run)

From session `03a14105a` (182 turns across architect/typescript/review):

| Agent | Turns | Shared Chars | Shared/Turn | Tokens |
|-------|-------|-------------|-------------|--------|
| architect | 16 | 1,007,040 | 62,940 | 1.2M |
| typescript | 154 | 9,692,760 | 62,940 | 29.6M |
| review | 12 | 755,280 | 62,940 | 3.4M |

**Total CF overhead:** ~11.5M chars of shared anchor loaded across 182 turns.
This is the per-turn cost of the position-0 system prompt — identical for every
agent. In RF, each agent loads its own full SP (67–71K chars) per session, with
no cross-session reuse except generic boilerplate.

### Cross-Agent Knowledge Detection (Stretch)

Current thinking on automated signals (qualitative for v0.0.1):
- **Re-read ratio:** typescript opens files architect already read (low = good)
- **Reference pattern:** agent cites "per the spec..." vs re-discovers
- **File access count:** fewer unique reads = context sufficient
- **First-turn tool calls:** starts with prior agent's output (good) vs re-reads source

See `SDLC-v0.0.1.md` for full experimental design, templates, and iteration process.
