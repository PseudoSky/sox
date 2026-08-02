# Content-First Architecture — Session Handoff / Resume

> **For resuming work after a session compaction.** Current state of the content-first research + proxy development, what's proven, what's broken, what's next.

**Last updated:** 2026-08-02
**Branch:** `wip/turso-live-metrics`

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

**The proxy on 3333 is the committed state = known-good baseline.**

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

1. **The proxy must be running** for `proxy/cf` to work. Start with:
   ```bash
   kill $(lsof -ti:3333) 2>/dev/null; sleep 1
   nohup node docs/research/content-first/proxy/cf-proxy.mjs > /tmp/cf-proxy.log 2>&1 & disown
   ```
2. **Per-session logs** are gitignored (`proxy/.gitignore` ignores `*.jsonl`) — session data is ephemeral, not committed
3. **Commitlint scope warning** is cosmetic (scope `research` not in the allowed list) — commits still land
4. **The `rewrite:` debug line** in stderr (`personaApplied=true agentRoleTokens=N`) verifies the persona actually reached the forwarded messages — check it when debugging persona application
5. **Cache block minimum:** DeepSeek needs ~1,024 tokens before cache engages. Short conversations show 0 cache — expected, not a bug. Real sessions hit 95-99%+
6. **Content dilution:** at 60K+ token contexts, a ~3K-token persona suffix is a small signal — the model may "not notice" the agent switch even though the SP is verifiably applied. This is a model-behavior property, not a proxy bug.

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
| `proxy/README.md` | Proxy harness docs — dual-model A/B, logging schema |
| `scripts/verify-chain-mechanism.mjs` | 12-check session mechanism test |
| `scripts/test-chain-*.mjs` | Chain tests (experimental) |
| `opencode.json` | `proxy` provider (`rf`/`cf` models) |
| `README.md` | Thesis overview + document map |
| `PATTERNS.md` | 26 patterns |
| `instruction-hierarchy-experiment.md` | IHE-1 quality experiment |
| `sessions/*.json` | Raw experimental session data |
