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

## 4. Open problem — the session id discovery question

**The user's question that remains unresolved:** When the agent successfully called `POST /v1/session/agent` to switch to `typescript` (log: `session_agent_set: typescript` at 19:02:05 in `proxy-ses_03c3312d1ffeebNMmJC5HoZ7Lg.jsonl`), how did the agent discover its own session id?

**What we know:**
- The session id `ses_03c3312d1ffeebNMmJC5HoZ7Lg` appears **nowhere** in any stored log content — the model never received it in a visible tool result
- The per-session logger does NOT record the `/v1/session/agent` **request body** — only `event, agent, turns`
- Raw captures (a different session) show the model's real tool calls were `bash` (git), not agent-MCP introspection — so it didn't use `agent_session_list` or `memory_get_session_state`
- The agent's tool call that discovered the session id, and the command it ran, are **not recoverable from current logs**

**What's missing:** The proxy must log the `/v1/session/agent` request body (the exact sessionId + agent the caller used). Without it, we cannot trace how the agent learned its session id.

**Next step for this thread:** Add request-body logging to the `/v1/session/agent` handler (and ideally a `CF_RAW` capture for it), then have the user reproduce the handoff so we can see the exact value and trace where it came from.

---

## 5. What was reverted / disabled (do not re-enable blindly)

### The virtual `set_session_agent` tool — DISABLED
- Was implemented, then reverted in `8367caf`
- **Why:** the virtual tool required a *blocking* upstream call (to intercept the tool call before streaming to the client). With opencode's `max_tokens: 32000`, the blocking path waited for the FULL response before streaming → appeared hung / never completed
- The fix attempt (strip `stream_options`, 7546767) fixed the 400 but not the hang
- **To re-enable:** needs a different approach — intercept the `tool_call` delta *mid-stream* and re-issue, rather than blocking the whole response. Do NOT just flip it back on.

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

1. **Session-id discovery trace** — add `/v1/session/agent` request-body logging to `cf-proxy.mjs`, reproduce the handoff, capture the exact session id the agent used, and trace where it learned it. This closes the open question in section 4.
2. **Re-enable virtual tool properly** — design mid-stream tool_call interception instead of the blocking round-trip (section 5).
3. **Consider injecting the session id into context** — the proxy could append "Your session id is `ses_...`; to hand off, call POST /v1/session/agent" to the forwarded context, removing the agent's need to discover it via tools.
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
