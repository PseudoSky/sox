# Content-First Architecture — Session Handoff / Resume

> **For resuming work after a session compaction.** Current state of the content-first research + proxy development, what's proven, what's broken, what's next.

**Last updated:** 2026-08-04 (CF/RF experiment complete + corruption hardening)
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
- **Agents:** `SDLC-RF` (`model: proxy/rf`) and `SDLC-CF` (`model: proxy/cf`) — identical chained-flow prompts (todo-list driven), differ only in proxy model routing
- **Removed:** `backlog-manager-cf/rf`, `backlog-triage-cf/rf`, `cf-chain-dispatcher`

### This session (2026-08-04) — experiment COMPLETE + corruption hardening

**⚠ Replay-attribution attempt FAILED (declared a loss).** An attempt to test
whether the architect's PATCH-vs-TEMPLATE decision was caused by persona
placement (replaying captured decision contexts with placement as the only
variable) failed: wrong boundary, harness parameter drift (extra tools array,
`reasoning_effort:'none'`, low max_tokens vs the captured 32000), worktree
leakage (fork read the live cf_fresh solution), and — fatally — the "sptail"
variant appended the persona to the last USER message (index 1) instead of the
TRUE last message, i.e. it tested the CF-pre bug placement, not v4. The
corrected one-shot runs (n=1) did not reproduce the originals: cf-pre reproduced
PATCH under both placements; cf-fixed reproduced TEMPLATE under NEITHER,
including the exact v4 true-tail config with identical trajectory+evidence+params.
Full failure analysis: **§5d**. Do not reuse the harness; the honest conclusion
is the decision is trajectory/sampling-dependent, not attributable to placement
at n=1.

**Option C persona placement (commit `41b6b13`).** v3 of the persona anchor:
- v1 (last-user-message): cache decayed 61→28→13% across handoffs (persona on buried 'Go' message invalidated all tool history)
- v2 (actual-last-message): cache held 80-95% but persona re-appended each turn → model re-asserted identity every turn ("I'm now the product agent"), ~4.4K wasted tokens/turn
- **v3 (Option C): persona on the true last message at stage boundaries (handoffTask set) → only tail changes → cache holds; persona on last USER message on continuation turns → stable, no re-assertion.** Verified live: within-stage 99.9%, handoff recovers in 2 turns, no identity noise.

**Mid-stage persona corruption bug — ROOT CAUSE FOUND.** `resolveSessionPersona` treated a detection FAILURE (resolveAgent → null on frontmatter-stripped SP) as an agent change, nulling `activeAgent` mid-typescript. Result: 21 turns of real typescript work (edits, nx gates, commits — verified via opencode DB tool calls) logged as `(unassigned)`, inflating the SDLC-CF recon stage from 4 turns/79K to 25 turns/4M tokens. **Fixed**: detection failure now preserves `activeAgent`; only a POSITIVE detection of a different agent triggers a change.

**Corruption hard-fail checks (corruptionCheck + scanForSPResiduals).** The proxy now KILLS ITSELF (process.exit(1)) on:
- any mid-stage persona change not authorized by a handoff (the 142K-token cache-break scenario)
- multiple `--- Role ---` markers in one conversation
- a marker on a non-target message
- the active persona body leaking onto a non-target message
45/45 tests pass. A replay test of the real session logs is the remaining gate (was being dispatched when this doc was updated).

**RF dispatcher redesign.** SDLC-RF is now a chain DISPATCHER: `task: allow`, explicit dispatch loop (dispatch → wait → mark todo → next), never stops until Final Review. Completed the full 5-stage chain: product → architect → typescript → review → final review.

### Proven
- Cross-agent conversation cache reuse **confirmed working** on live CF chain (`0377c94e`: product→typescript→researcher, 62-73% first-turn reuse)
- Handoff penalty formula verified: `new_agent_cached ≈ prev_total - prev_persona - user_text` (deviation <500 tokens for researcher handoff)
- **CF vs RF experiment COMPLETE** — see §5a for the full comparison

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

### Rewrite (CF mode) — v4 (2026-08-04, fixes the settle-turn floor wipe)
```
[0] system: CF instructions REPLACING the agent body + shared boilerplate  ← cache anchor
[1] user:   "Go" — NEVER touched (no injection into user messages)
[2..N-1] history (untouched, append-only)
[N] tail:  "

--- CF-AGENT:<name>:sha256:<hash> ---
<persona body>
--- /CF-AGENT ---"
```
- **Persona ALWAYS on the TRUE LAST message** — unconditional, every turn. The old
  Option C fell back to "last user message" on tool-continuation turns, but in an
  opencode tool stream the only user message is index 1 ("Go") — so the persona
  jumped from the tail (handoff turn) back to index 1 (settle turn), wiping the
  cache to the 15,232-token floor (turns 6, 17, 34, 89 of ses_035ef41f5; 142K
  charged on turn 67). [inv:persona-always-tail]
- **CF instructions are session-wide BEHAVIOR, not a system prompt** — they are
  injected at position 0 by REPLACING the agent body (which is already extracted
  every turn for attribution), keeping the opencode shared boilerplate. The agent
  body lives ONLY at the tail as the persona anchor — never duplicated in the
  same context (fixes the v2 identity re-assertion noise).
- All injected blocks carry self-describing markers with content hashes
  (`--- CF-System:v4:sha256:... ---` / `--- CF-AGENT:name:sha256:... ---`) so the
  proxy can prove the exact prompt before forwarding.
- Idempotent: never double-append (marker check before every injection).
- Shared never empties (falls back to full opencode SP — regression guard 96185ef).
- Warm handoff: `Task: <input>` embedded inside the persona anchor; cold: body only.
- In-flight predictor: `predictCacheHit(prevForwarded, curForwarded)` compares the
  serialized prefixes and predicts `prompt_cache_hit_tokens` BEFORE the request is
  sent; a predicted mid-stage collapse to the floor triggers `corruptionAbort`.

### Corruption hard-fail checks (2026-08-04)
- `corruptionCheck(session, requested, reason)` — refuses + KILLS the proxy on any persona change not handoff-authorized or matching an active override
- `scanForSPResiduals(messages, activeAgent, targetIdx)` — KILLS on multiple markers, marker on non-target, or persona-body leak
- Handoffs set `session.handoffAuthorized` (one-shot, consumed by next rewrite) — the ONLY legitimate change path
- `[inv:persona-stage-stability]` — the active persona MUST NOT change mid-stage; a swap invalidates the provider prefix cache (measured 142K tokens lost in one turn)

### Metrics (per turn, both CF and RF paths)
`shared_chars`, `persona_chars`, `context_chars`, `persona_turns`, `persona_ctx_chars`, `tokens`, `cached`, `savings_pct`

---

## 3. How to Run

```bash
# Start proxy (if not running)
cd docs/research/content-first/proxy && ./restart-cf-proxy.sh

# ⚠️ ALWAYS verify the proxy actually reloaded the current code.
# The proxy loads cf-proxy.mjs + the agent registry ONCE at startup; editing
# the file or an agent .md does NOT hot-reload it. A stale proxy silently
# runs OLD rewrite logic / OLD agent prompts (stale-registry bug, 2026-08-03:
# sessions ran a pre-fix proxy for ~20 turns before the restart). Check:
ps -o lstart= -p $(pgrep -f cf-proxy.mjs | head -1)   # proxy start time
stat -f '%Sm' docs/research/content-first/proxy/cf-proxy.mjs   # file mtime
# The start time MUST be AFTER the file mtime. If it isn't: restart again.

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

Both arms run the same chained-flow SDLC prompt (todo-list driven). Only difference: `proxy/rf` vs `proxy/cf` — RF dispatches each stage as a fresh `task()` subagent context; CF runs stages in one session via proxy persona handoffs.

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

## 5a. Experiment Results — CF vs RF (2026-08-04, COMPLETE)

Both arms ran BUG-WORKSPACE-GEN-006 end-to-end. Cumulative input = sum of per-turn re-sends (LLM statelessness — each turn re-sends the full growing context; neither arm approached the 1M context cap, CF max single-turn 225K, RF 177K).

### CF (1 session, 101 turns, complete)
| Stage | Turns | Input | Uncached | Read% |
|---|---|---|---|---|
| typescript | 54 | 9.0M | 341K | 96.2% |
| architect | 17 | 1.7M | 157K | 90.8% |
| product | 15 | 1.5M | 243K | 84.3% |
| review | 10 | 2.1M | 275K | 86.9% |
| SDLC-CF (recon+orch) | 5 | 277K | 31K | 88.9% |
| **TOTAL** | **101** | **14.6M** | **1.05M** | **92.8%** |

### RF (6 sessions, 212 turns, complete)
| Stage | Turns | Input | Uncached | Read% |
|---|---|---|---|---|
| typescript | 80 | 10.7M | 268K | 97.5% |
| review | 50 | 4.7M | 93K | 98.0% |
| architect | 33 | 2.8M | 93K | 96.7% |
| product | 19 | 1.6M | 79K | 95.1% |
| dispatcher | 18 | 1.0M | 62K | 94.0% |
| final review | 12 | 932K | 43K | 95.4% |
| **TOTAL** | **212** | **21.8M** | **638K** | **97.1%** |

### Headline verdict
| Metric | CF | RF | Winner |
|---|---|---|---|
| Total input | **14.6M** | 21.8M | **CF (−33%)** |
| Total uncached | 1.05M | **638K** | RF |
| Read % | 92.8% | **97.1%** | RF |
| Cross-stage first-turn reuse | **26-61%** | 7-9% | **CF** |

**The honest conclusion**: CF's ONLY win is total input (one session, less re-reading). On cache efficiency (read%, uncached) RF wins. CF's core mechanism — cross-stage context reuse — delivered 26-61% first-turn reuse (below the doc's 80-95% prediction) and the persona-shift at handoffs invalidates large accumulated prefixes (up to 189K in one turn) that RF's isolated sessions never pay. The framework's shared-context benefit is real but smaller than predicted, and its cost (bigger per-turn SP, persona-anchor cache breaks) partially offsets it.

---

## 5b. Authoritative Run Record — session IDs + metric commands (2026-08-04)

> **Recorded so the runs are reproducible: the fresh CF run and any re-aggregation
> use the exact session IDs and commands below. Do not re-derive from memory.**

### RF run (COMPLETE — the successful dispatcher run)
Dispatcher + 5 sub-sessions (all present in `proxy/` as `proxy-ses_*.jsonl`):

| Session ID | Stage |
|---|---|
| `035dd677effeBusfTjza6XePMw` | dispatcher (SDLC-RF orchestration) |
| `035dc5275ffeNzWRkU3EiNKEbQ` | product |
| `035d62d8fffe0Enn6vxhVrzEcl` | architect |
| `035d04dddffeOU152IuV9DgGkx` | typescript |
| `035c3d93dffeZMY8vnaszQiIKD` | review |
| `035bd30eeffeSVXUaytq4iOYnn` | final review |

**Aggregate command:**
```bash
node aggregate-session.mjs --rf 035dd677effeBusfTjza6XePMw
# TOTAL: 212 turns, 21,823,752 tokens, 637,576 uncached, 97.1% read
# Handoff cold-start penalty: 166,395 uncached tokens (swap-seq, excl. first turn)
```

### CF run (session `035ef41f5ffelPfJMW20fe1BAd` — CORRUPTED, superseded)
The old CF run's data is retained for the corruption post-mortem but is NOT the
comparison baseline (mid-stage persona corruption invalidated its cache metrics).
The FRESH CF run on the v4 proxy replaces it.

**Aggregate command:**
```bash
node aggregate-session.mjs --cf 035ef41f5ffelPfJMW20fe1BAd   # OLD corrupted data — reference only
# Fresh CF run: node aggregate-session.mjs --cf <new-session-id>  (fill in after run)
```

### Metric definitions (what the aggregator computes) — v2 terminology (2026-08-04)
- **Tokens** = sum of provider `prompt_tokens` per turn (cumulative input; LLM
  statelessness means each turn re-sends the full growing context)
- **Cached** = sum of `prompt_cache_hit_tokens` per turn
- **CacheW** = sum of `prompt_cache_miss_tokens` per turn — the tokens charged at
  MISS rate and written into the provider cache. (Pre-v2 logs lack the field;
  aggregator falls back to Tokens − Cached.)
- **CachRd** = Cached/Tokens — "cached read pct", the per-session efficiency ratio.
  NOTE: "savings" is NO LONGER used per-session — savings is the CROSS-ARM
  comparison metric (cf vs rf per stage: "-25% tokens, +50% cached reads, ...").
- **Out** = sum of `completion_tokens` (actual output produced)
- **1stRd** = first-turn-after-handoff cached-read pct (the CF framework's
  headline claim: cross-stage context reuse)
- **Time / AvgTrn / Dead** = per-stage wall time, avg turn duration, and dead time
  — gaps > 2min between consecutive turns (server outage / operator pause) are
  EXCLUDED from Time/AvgTrn and reported separately as Dead. Humanized (e.g. "3m 31s").
- **PCtx** = cumulative persona context chars
- **Handoff cold-start penalty** = sum of uncached on first turn of each stage
- **JSON output** (`--json`) also carries `time: {total_ms, avg_turn_ms, dead_ms,
  total_human, avg_turn_human}` for programmatic comparison.

---

## 5c. CF-to-CF Comparison — v4 fix vs pre-fix (2026-08-04, COMPLETE)

Head-to-head on the SAME scenario (fresh `031bd2a82` vs corrupted `035ef41f5`):

### First handoff (product→architect) — the exact case that used to floor-wipe
| Turn | PRE-FIX (cached / sav) | FRESH v4 (cached / sav) |
|---|---|---|
| last of product | 85,248 / 99.9% | 89,728 / 88.9% |
| architect 1st | 25,856 / 30.1% | 95,488 / **96.3%** |
| architect settle | **15,232 / 17.4% ← floor wipe** | 96,000 / 92.2% |
| architect +2 | — | 98,304 / 89.1% |

**The old code floor-wiped on the settle turn (15,232). The v4 code never drops**
**below 88% across the handoff.** Handoff cold-start penalty (swap-sequence, excl.
first turn, corrected 2026-08-04): PRE-FIX 248,151 (389,267 mechanical) vs FRESH
**42,311** — ~6-9x lower. (Earlier mid-run figures 216,723/8,571 were superseded by
the corrected metric.)

### Full-run snapshot
| | PRE-FIX (101 turns, done) | FRESH (24 turns, in progress) |
|---|---|---|
| Input | 14,636,519 | 1,584,228 |
| Cached | 13,589,888 | 1,322,240 |
| Uncached | 1,046,631 | 261,988 |
| Savings | 92.8% | 83.5% (early — ramp-up phase) |
| Wipes | **10 (643,712 tokens re-charged)** | **0** |

### Wipe-tax counterfactual (what the fix is worth)
Pre-fix without its 10 wipes would have scored **97.2%** savings instead of
92.8% — the 643,712 wiped tokens are pure re-charge the v4 rewrite never pays.
Early FRESH savings (83.5%) are below pre-fix (92.8%) ONLY because it is in
the cold ramp-up; its within-stage turns already hit 89-96%, and it has zero
wipe-tax. Extrapolated, FRESH should land at/above the pre-fix's no-wipe
97.2% ceiling once the context accumulates.

---

## 5d. FAILED ATTEMPT — persona-placement replay experiment (2026-08-04, LOSS)

**Verdict: FAILED. The replay harness never correctly reproduced the original
runs' behavior. Declared a loss by the user. Do NOT reuse the harness or trust
any of its classifications. Only the failure analysis below is salvageable.**

### What was attempted

Test whether the architect's approach decision (PATCH vs canonical-TEMPLATE)
was caused by persona *placement* (position 0 vs true-tail), by replaying the
two arms' captured decision contexts against `deepseek-v4-flash` with placement
as the only variable:

- CF-pre decision context: messages 0..74 (75 msgs) of `ses_035ef41f5`
  (decision at msg 75 = "All mechanics confirmed... writing the spec").
- CF-fixed decision context: messages 0..66 (67 msgs) of `ses_031bd2a82`
  (decision at msg 67 = "Is this architecture?... owning the emitted template").
- Variants: `sp0` (persona appended to system prompt) vs `sptail` (persona on
  the TRUE last message — the v4 `[inv:persona-always-tail]` placement).
- Harness: `proxy/cf-replay-{step1,oneshot,continue}.mjs`; logs in `/tmp/cf-replay/`.

### Why it failed (in order of occurrence)

1. **Wrong boundary picked for CF-fixed (first attempt).** Grabbed the request
   at 20:08 (204 msgs) — the REVIEW stage — instead of the architect's decision
   at 19:45-19:46 (msg 67). The 204-msg context was 20 minutes / ~140 messages
   too late. Only the debugger's citation (cf-fresh-031bd2a82.md:2015) + locating
   the `reasoning_content` pin at msg 60→67 fixed the boundary.
2. **Harness parameter drift (user-caught).** v1/v2 sent `max_tokens: 6000`, a
   6-tool `tools` array, and `reasoning_effort: 'none'` — the captured original
   sent `max_tokens: 32000`, NO tools array, NO reasoning suppression (reasoning
   ON is where the architect decided). The replays were a DIFFERENT experiment.
   Fix (v3): exact parameter parity — `max_tokens: 32000`, no tools, no
   reasoning_effort.
3. **Worktree leakage (confound).** The continuation loop executed tools against
   the LIVE `cf-run` worktree, whose current state contains cf_fresh's committed
   template solution. cf-fixed-sptail step 6 read `git diff shared/generator.ts`
   and saw the answer ("The working tree has substantial in-flight changes that
   are not mine"). Any TEMPLATE signal from that fork is contaminated.
4. **Fork divergence.** The replays re-gathered evidence (bash probes, reads)
   the original had already completed, reaching different knowledge states. The
   decision was trajectory-dependent, not reproducible from a static context.
5. **"sptail" was NOT v4's placement (user-caught, fatal).** `buildVariants`
   appended the persona to the last **USER** message — which in an opencode tool
   stream is index 1 ("Go"), the exact CF-pre bug placement that v4 exists to
   fix. The true last message is a tool result (idx 74/66). So the "sptail→PATCH"
   result tested the index-1 placement, not v4's always-tail. Fixed and re-run,
   but only the corrected sptail runs are valid — and they did not reproduce the
   originals either.
6. **Tool-call XML format variance in responses.** The model emitted
   `<parameter name="content" string="true">`, `<｜parameter ...>` (full-width
   pipe U+FF5C), and `<||DSML||parameter>` formats across responses; the
   extractor had to normalize all three to read the SPEC decision artifact.

### The corrected (valid) one-shot results — n=1, NOT statistically meaningful

| Fork | Placement | Replay decision | Original |
|---|---|---|---|
| cf-pre sp0 | system (pos 0) | PATCH | PATCH ✓ |
| cf-pre sptail | TRUE last msg (tool) | PATCH | PATCH ✓ |
| cf-fixed sp0 | system (pos 0) | PATCH | TEMPLATE ✗ |
| cf-fixed sptail | TRUE last msg (tool) | PATCH — short-circuits "NOT ARCHITECTURE" | TEMPLATE ✗ |

**cf-fixed's TEMPLATE was NOT reproducible under ANY placement, INCLUDING the
exact v4 true-tail configuration, with identical trajectory + evidence + exact
parameter parity.** This is the one defensible observation: the original
CF-fixed TEMPLATE decision was not determined by (trajectory + evidence +
persona placement) — the residual is run-to-run reasoning/sampling variance or
something uncapturable in a static replay. It neither confirms nor refutes a
persona-placement effect; with n=1 per cell it cannot.

### What NOT to take from this attempt

- The earlier "sp0→TEMPLATE / sptail→PATCH" matrix (pre-correction) — that
  sptail was index-1 placement, invalid.
- Any TEMPLATE signal from continuation forks (worktree leakage).
- The claim "persona placement shifts the architect's decision" as proven — it
  is at most a hypothesis that n=1 cannot support.

### Salvageable conclusions

1. **The static-context replay method cannot reproduce the original architect's
   decisions** — the decision is trajectory-dependent (depends on the specific
   tool-call sequence and reasoning path), which a frozen snapshot + fresh model
   run cannot capture. This is itself a finding about the experiment method.
2. **cf-fixed's TEMPLATE choice is not explained by persona placement** under
   the exact v4 configuration; consistent with (but not proof of) the earlier
   attribution "quality gap = agent decisions + sampling".
3. **The CF-pre decision (PATCH) reproduced under both placements** — robust to
   placement in this small sample.
4. **For v0.0.2:** if decision attribution matters, the experiment must record
   the model's reasoning path (not just messages) and control sampling
   (temperature=0, multiple seeds), or accept that approach-decisions are
   stochastic per-run and cannot be attributed to the proxy.

**Artifacts (do not trust, do not reuse unmodified):** `proxy/cf-replay-*.mjs`,
`/tmp/cf-replay/*.jsonl`, `/tmp/cf-{pre,fixed}-decision-ctx.json`.

---

## 6. Known Issues

1. **Restart with `restart-cf-proxy.sh`, NEVER `kill $(lsof -ti:3333)`** — kills opencode too., NEVER `kill $(lsof -ti:3333)`** — kills opencode too.
2. **Commitlint scope warnings** are cosmetic — commits land.
3. **`(passthrough)` / `(unassigned)` agent names** in old sessions — the proxy can't resolve SDLC agent bodies from the opencode SP because frontmatter is stripped. New aggregator maps these to `SDLC-RF`/`SDLC-CF` based on the model field.
4. **Bare-repo worktree isolation** — `git worktree list` is public. External worktrees (`~/dev/.sdlc-experiments/`) are unreachable by `grep -r` from the repo but visible via git commands.
5. **Auto-advance depends on two linked fixes** — the chain advances only when (a) the prompt instructs the agent to continue working after a handoff ("do not stop"), and (b) the persona suffix lands on the true last message so the provider prefix cache survives handoffs. Verified on run `03610a02d` (89-90% first-turn cache held across handoffs).
6. **Mid-stage persona corruption (FIXED 2026-08-04, two layers)** — (a) attribution: `resolveSessionPersona` nulled `activeAgent` on detection failure, mislabeling 21 typescript turns as `(unassigned)` (4M phantom tokens). Fixed: detection failure preserves activeAgent. (b) STRUCTURAL: the v4 rewrite makes the floor wipe impossible — the persona is unconditionally on the tail, so no "last user" fallback can ever jump to index 1. Hard-fail `corruptionCheck`/`scanForSPResiduals` kill the proxy on recurrence; the `predictCacheHit` pre-send guard is WARN-ONLY (2026-08-04 — it false-positived on legacy sessions, e.g. ses_03610a02d predicted 183K vs actual 503K; an estimator must not be a kill-switch).
7. **`cf-rewrite.mjs` is the single source of truth** — proxy and tests import the same rewrite module (no duplicated mirror to drift). Real-data fixtures: `fixtures/wipe-pairs-ses-035ef41f5.json` (full bodies of the 3 captured wipe pairs, 1.7MB) replayed through v4 in verify-cf-instructions.mjs (46 tests).
8. **INVESTIGATE (2026-08-04): why did CF-pre beat RF with almost identical behavior?**
   CF-pre (`035ef41f5`) placed the persona at message-array **index 1 ("Go") on 67 of 71
   turns** — verified by replaying the pre-fix Option C rewrite against the exact captured
   message arrays (only the 4 handoff turns put it on the tail). Yet CF-pre shipped the
   SAME fix as RF at **~72% of the cost ($1.35 vs $1.87), half the time, half the turns,
   ⅔ the tokens** — despite *lower* overall cache efficiency (92.8% vs 97.1%) and 10
   wipes (643K re-charged tokens). The hypothesis to test: **CF-pre's win is the
   single-session structure (no per-stage cold start), not the persona placement — the
   persona-at-index-1 "bug" may be behaviorally irrelevant when within-stage turns
   dominate.** If true, the v4 fix's value is reliability (0 wipes, 92-98% handoff reuse),
   not cost — and the CF-vs-RF comparison should control for session structure, not
   rewrite correctness. Cross-ref: SDLC-v0.0.1.md Open Questions Q1/Q2.
9. **Context compaction / history rewrite — NOT yet handled (2026-08-04)** — if opencode
   truncates/summarizes a long conversation (context compaction), the forwarded message
   prefix legitimately collapses. The predictor now WARN-only, so a compaction event
   logs `⚠ CACHE-BLOW WARNING` but does NOT kill the proxy (the deterministic
   corruptionCheck — persona change without handoff — is the only hard-fail, and
   compaction never changes the persona). **Open work:** compaction events should be
   *detected and labeled* (e.g., a `context_compacted` event when a large prefix
   collapse coincides with a message-count drop), so the aggregator can exclude
   compaction turns from the wipe audit instead of misreading them as corruption.
9. **Pre-fix session logs lack `cache_miss`** (field added 2026-08-04) — the
   aggregator falls back to `tokens - cached` for those logs, which is the same
   number when the provider reports no separate write field. Not a correctness
   gap, but old logs can't distinguish "miss charged" from "miss charged AND
   written" if a provider ever differs.
10. **F4 — position-0 anchor non-prefix case: FIXED (2026-08-04).** When the
    agent body is NOT a prefix of opencode's SP, `splitSystemPrompt` now does a
    non-prefix extraction (`method: 'contains'` — searches for the longest agent
    body anywhere in the SP, returns everything else as `shared`), so position 0
    stays byte-stable across handoffs. Old behavior: `shared=''` → full SP
    (incl. agent body) at position 0 → cross-agent reuse degraded. Regression
    test added (verify-cf-instructions.mjs, 65 tests green).
11. **F8 — `predictCacheHit` guard thresholds: FIXED (2026-08-04).** Added tests
    driving the warn-guard inputs (`blow > 20000 && !handoffNow && floorish`)
    across three scenarios: floor collapse (guard fires), legit handoff (does
    NOT fire), normal growth (does NOT fire). Note: the guard is WARN-ONLY by
    design (2026-08-04 — the estimator false-positived on legacy session
    ses_03610a02d and killed the proxy; the deterministic corruptionCheck is
    the only hard-fail). Coverage pins the thresholds that gate the warning.
12. **Raw API responses now logged** — `forwardStream` captures the full SSE `data:` lines + usage into a `raw_response` event per request (RAW_CAPTURE on), so cache accounting is auditable against the exact provider payload.
7. **Session logs from BEFORE the attribution fix** (e.g. `035ef41f5`) have mislabeled turns — the retroactive fix rewrote the file with `_attribution_fixed` markers; backups at `/tmp/cf-session-backup.jsonl`.
8. **Cache write tokens are NOT captured** — the proxy reads DeepSeek's `prompt_cache_hit_tokens` but not cache-write; opencode's DB reports 0. If cache-write matters, add it to `forwardStream`'s usage handling.
9. **RF dispatcher completed the full chain (2026-08-04)** — first valid RF run. All 5 stages dispatched as fresh task() subagents; 6 sessions, 212 turns, 21.8M cumulative input. Earlier RF attempts died at stage 0 (task denied, then wrong worktree + weak prompt).

---

## 7. Next Steps

1. **Do NOT re-attempt the replay-attribution experiment as built** — see §5d; the harness was declared a loss. If decision attribution is ever re-attempted, it must record the model's reasoning path and control sampling (temperature=0, seeds), not replay static contexts.
2. **LIVE E2E: replay the real requests through a fresh proxy** — the final gate before the v4 rewrite is proven: replay `ses_035ef41f5`'s actual captured requests through a throwaway proxy and confirm (a) no floor wipe occurs on the 3 wipe pairs, (b) the mid-stage flip would still kill the server. (This is proxy-behavior verification, distinct from the failed decision-attribution replay.)
3. **Commit the v4 rewrite** — `cf-rewrite.mjs`, `cf-proxy.mjs` (always-tail + predictor + raw-response logging), `verify-cf-instructions.mjs` (46 tests), `fixtures/` — uncommitted.
4. **Fix the aggregator label bug** — the RF header shows "CF Run" in some paths; `resolveAgentName` mapping needs a final pass.
5. **Fill SDLC-v0.0.1.md results template** with §5a numbers.
6. **Decide on cache-write capture** — add `prompt_cache_miss_tokens`/write accounting to the proxy if the experiment needs it.
7. **v0.0.2** — iterate the experiment with the corruption-hardened proxy and corrected attribution.
