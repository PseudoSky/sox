# FJ Mode Design — Fork-Join Proxy Mode (v0.1, DESIGN)

> **Status:** v1 IMPLEMENTED (2026-08-05) — routing + preset-set endpoint +
> per-turn fork via the CF rewrite + seed-then-warm execute + concat join +
> per-fork cache metrics. Judge join = STUBBED switch (wired, falls back to
> concat). See "v1 implementation" note in §3.4 and §3.3.
> **Parent:** `docs/research/content-first/RESUME.md` (content-first research)
> **Builds on:** `fork-join-cost-model.md`, `fork-join-round-model.md`,
> `fork-join-sequence-model.md`, `cache-performance-model.md`,
> `fork-join-architecture-from-plan.md` — the *theory*; and
> `experiments/SDLC-v0.0.1.md` — the *measurements* that exposed what the
> theory never tested.
>
> A third proxy model: `proxy/fj` — fork-join. The preset agent set runs on
> **each turn** of a single session, forked from the shared conversation,
> their outputs joined back into the response opencode sees.

---

## 0. TL;DR

`proxy/fj` = the third arm. Per turn, the proxy forks the shared conversation
across a **preset agent set** (configurable per session, like `/v1/session/agent`
configures the active persona). Each fork appends that agent's persona suffix,
runs against the provider (seed first → warm rest), and the N outputs are
joined — either raw-concatenated or via a judge pass (switchable). The joined
result is the turn's response and becomes the next turn's shared prefix.

**Why this specific shape:** the fork-join docs predict 87-96% savings and
97.5-99.8% cache hits for the *parallel fork* regime — and v0.0.1 measured
*only the sequential chain*, where the parallel-fork claim is **entirely
untested**. FJ mode is the instrument that tests the docs' central claim in
its native shape: N agents, one shared prefix, per-fork cache accounting.

---

## 1. What the theory promises vs. what v0.0.1 measured

### 1.1 The fork-join claim (from the docs)

| Doc | Claim |
|---|---|
| cost-model | $O(1)$ context-load for $O(N)$ role perspectives; asymptotic CF/RF cost ratio → 7.8% |
| cost-model §5 | 1 cold seed + N-1 **warm** TTFT (~150ms vs ~600ms) |
| round-model | 24 cold starts (RF, ~186K) vs 1 cold + 23 warm (CF, ~24K) |
| cache-performance | 97.5-99.8% per-agent hit after seed; marginal agent cost ≈ $\bar{R} + P_i$ |
| architecture-from-plan | diverge → filter → converge pipeline; 5 features UNCONTESTED in literature |

### 1.2 What v0.0.1 actually measured (sequential regime)

| | Docs' fork-join (parallel) | v0.0.1 (sequential chain) |
|---|---|---|
| Shape | N forks off one context | product→architect→typescript→review |
| Per-agent cost | $R_i + O_i$ (after seed) | accumulated context + persona + $O_i$ |
| Cache hit | 97.5-99.8% | 92.8% / 95.6% / 97.1% |
| What confounds | — | agent behavior over turns, narration tax, wipe bug |

**The parallel fork claim — the strongest, most novel one — has never been
run against a real provider.** FJ mode is the missing instrument.

### 1.3 Why the fork shape is a *cleaner* experiment than the chain

In a fork, every agent sees byte-identical input: same shared context $H$,
different suffix $R_i$. The ONLY variables are (a) the suffix and (b) sampling.
No design freedom, no solution divergence (CF-pre regex-patch vs CF-fresh
canonical-template was impossible to attribute), no stage-0 acceptance-criteria
drift. With golden outputs + temperature 0 + n≥5, the fork isolates the pure
cache geometry the docs predict — the thing the chain could never isolate.

---

## 2. The design question: does per-turn multi-perspective make sense?

The docs model a **one-shot fork**: load the artifact once, N agents analyze
it once, collect N analyses. The user's ask is different and harder: the
preset set runs on **every turn**. When is that *actually* worth N× output?

### 2.1 Where per-turn forking genuinely earns its keep

**Continuous delta review.** The strongest case: an implementer stage
(typescript, ~54 turns in v0.0.1) where every turn mutates the artifact. Fork
a small reviewer set (correctness, security, scope) that inspects **only the
delta since last turn** — a persistent review committee that never lets a
defect survive more than one turn past introduction.

v0.0.1 evidence this matters: CF-pre shipped a real defect
(`release.version.generatorOptions.packageRoot = '{projectRoot}/dist'` —
generator.ts:179-181, contradicting the reference's source-root convention)
and the review stage *accepted it* (D5: "structurally guaranteed" teeth
without the empirical revert). RF's review was 50 turns, CF-pre's 10 — a
**late, expensive, single gate** that still missed a defect. A per-turn
committee catches it at introduction, when the fix is cheapest.

**Which stages benefit (per-turn is not uniform):**

| Stage | Per-turn fork value | Why |
|---|---|---|
| typescript (implement) | **HIGH** | Every turn writes code; a reviewer catches the regression the same turn it appears |
| architect (spec) | MEDIUM | Spec written in bursts; a "does AC-6 cover entrypoint?" checker at write-time beats end-of-stage |
| product (acceptance) | LOW-MEDIUM | Acceptance is short; fork only at draft time |
| review (verification) | **LOW** | This stage IS the review — forking it is redundant |

**The rule:** fork per-turn when (a) the turn produces a delta worth
inspecting, and (b) a second pair of eyes on that delta is cheap. Fork
outputs must be **short** — the docs' model assumes $R \approx 100$t and
$O \approx 500$t, NOT the 15K-char full personas that produced the v0.0.1
narration tax.

### 2.2 Where per-turn forking does NOT make sense (design guardrails)

1. **No-delta turns** (pure reasoning, planning, tool bookkeeping): nothing
   new to review → skip the fork, act as passthrough. Save the N× output.
2. **Long-form outputs**: if forks write 4K-token essays per turn, output
   cost explodes ($1.10/M output × N × turns). Suffixes must constrain
   format ("reply ≤ 200 tokens: PASS or FLAG + one-line issue").
3. **Stages that ARE the review**: don't fork a reviewer over a reviewer.
4. **Standing-committee context growth**: each turn's joined output appends
   to the shared prefix → conversation grows at N× the single-agent rate.
   Bound it: fork deltas are small; the audit trail is the point.

### 2.3 The concrete worked example (the doc's anchor scenario)

```
BUG-WORKSPACE-GEN-006, typescript stage, fj mode
preset = { correctness-reviewer, security-reviewer }  (2 forks, not 4)

turn 40: typescript edits shared/generator.ts (adds packageRoot override)
  fork 1 (correctness):   "FLAG: packageRoot '{projectRoot}/dist' contradicts
                           source-root convention in apigen-plugin-batch/project.json"
  fork 2 (security):      "PASS"
  join → typescript sees both; fixes the flag same turn.
  cost: 2 × (100t suffix + ~30t output) ≈ 260t vs. the 50-turn late review
  that missed it in v0.0.1.
```

This is the case the docs describe and the chain couldn't deliver: the
artifact is the shared context, the reviewers are cheap warm forks, and the
defect is intercepted at introduction.

---

## 3. Architecture

### 3.1 Model routing

```js
// cf-proxy.mjs, ~line 771 (next to isCFModel)
const isFJModel = /(^|\/)fj$/.test(modelStr) || modelStr === 'fj';
// doPassthrough = PASSTHROUGH || (!isCFModel && !isFJModel)
```

- `proxy/rf` → passthrough (unchanged)
- `proxy/cf` → content-first rewrite (unchanged)
- `proxy/fj` → NEW: fork-join path

### 3.2 Preset set configuration — `POST /v1/session/agent-set`

Mirrors `/v1/session/agent` (line 653) but sets a *set*, not a single agent:

```json
POST /v1/session/agent-set
{ "sessionId": "ses_...", "agents": ["correctness-reviewer", "security-reviewer"] }
```

- Session stores `presetSet: []`; empty → fj behaves as passthrough (no fork).
- Resolved against `AGENTS` registry (cf-proxy.mjs:83-102) via `resolveAgent`.
- `GET /v1/session/:id` returns the preset (line ~629 endpoint already lists agents).
- Optional env default: `FJ_PRESET="correctness-reviewer,security-reviewer"`.

### 3.3 Join mode — switchable

Session field `joinMode: 'concat' | 'judge'` (default `concat`; settable in
the same endpoint or `POST /v1/session/join`). Both implemented; the session
picks. This is the "both, switchable" decision:

- **concat** (default, v1): all N outputs concatenated with
  `--- CF-AGENT:<name>:sha256:... ---` markers. Zero extra calls. The opencode
  main loop reads N perspectives and synthesizes. Per-fork attribution exact.
- **judge** (v2): one extra blocking call — a judge agent reads the N outputs
  + shared context, emits one coherent response (the architecture doc's
  FILTER phase). Cleaner output, +1 call, attribution moved into the judge's
  prompt.

### 3.4 Per-turn fork-join flow

```
inbound chat/completions, model = proxy/fj
  1. session = getSession(sessionId); preset = session.presetSet
     → empty? passthrough.
  2. FORKS = preset.map(agent => rewriteToContentFirst(
        inboundMessages,
        personaSP = agent.systemPrompt,     // per-fork persona
        opencodeSP, cfPrompt, handoffTask,
        agentName = agent.name,             // per-fork marker
        fork = true                          // NEW-MESSAGE persona (not mutation)
     ))
     Position 0 and history are byte-identical across forks (same inbound
     messages, same session-wide CF instructions + shared boilerplate); ONLY
     the persona tail differs. This is the fork-join cache geometry, delivered
     by the existing CF rewrite — forked N times, not reimplemented.
     [inv:persona-new-message] In fork mode the persona is appended as a NEW
     user message, NEVER by mutating an existing message. Appending into a
     `tool`-role message corrupts the content DeepSeek validates against the
     preceding tool_calls, and appending into an assistant message that also
     carries `reasoning_content` + `tool_calls` breaks the reasoning-echo
     pairing → provider 400 "reasoning_content must be passed back" (observed
     2026-08-05, real 36-message session; fixed by new-message append, repro
     30-msg session → 200). A new message keeps every prior message
     byte-identical (reasoning echo intact) and is cache-optimal: the whole
     prior prefix stays cached; only the new message is new compute.
  3. EXECUTE (seed-then-warm — the cache-critical ordering):
       forks[0]        → await forwardBlocking(...)        // cold seed, populates prefix cache
       forks[1..N-1]  → Promise.all(forwardBlocking(...))  // warm, hit the prefix forks[0] cached
  4. JOIN: concat (v1) or judge pass (v2)
  5. Stream the joined text back to opencode as the assistant message
  6. Append joined output to session.context (monotonic prefix growth)
  7. logCall({ event: 'fj_turn', fork_count, join_mode,
       forks: [{agent, tokens_in, cacheHit, tokens_out, warm, latency_ms}] })
```

**Why seed-then-warm and not all-parallel:** if all N hit the provider
simultaneously, they race fork[0]'s prefill and ALL miss — the docs' 97-99%
hit claim requires the prefix cache to be populated *before* forks 2..N
arrive. Seed-first is ~5 lines and is the only way to actually test the
theory's central prediction.

**Why fork through the CF rewrite (not raw suffix append):** the rewrite's
whole design — position-0 anchor byte-identical, persona at the tail, idempotent
markers, corruption checks, cache predictor — is the fork-join cache geometry
parameterized by persona. Forking it N times with different `personaSP`
reuses every invariant (exact per-fork attribution via the
`--- CF-AGENT:<name>:sha256 ---` markers, no double-append, position-0
stability across turns) instead of reimplementing a parallel raw-fork path
that would silently drop them. One refinement: the *instructions block* may
need a fork-aware variant (a reviewer fork should not receive the "hand off
to the next specialist" session language verbatim) — that is a prompt-content
parameter, not a mechanism change.

### 3.5 Metrics (per fork, per turn)

| Metric | Source |
|---|---|
| `tokens_in` / `cacheHit` / `tokens_out` | `forwardBlocking` → `response.provider.tokens` (cf-proxy.mjs:547+) |
| `warm` (i>0) | structural |
| `latency_ms` | per-fork `Date.now()` delta |
| `hit_ratio` | `cacheHit / tokens_in` |
| `join_mode`, `fork_count` | session config |
| `shared_prefix_tokens` | shared context size / 4 |

This is the first time the **parallel fork cache geometry** gets real
provider numbers. The aggregator (`aggregate-session.mjs`) gets an `--fj`
path to tabulate per-fork rows and the per-turn join.

### 3.6 Failure handling

- A fork that fails/errors → log, drop that fork's output, join the rest
  (never fail the turn because one perspective died).
- All forks fail → degrade to passthrough of the original messages.
- `corruptionCheck`/`scanForSPResiduals` (persona markers) apply to the
  *forwarded* messages as today; forks carry their own marker set.

---

## 4. Cost model for the fj regime (standing committee, not one-shot)

The docs model one-shot forks. Per-turn forks are a different regime — the
design doc must state it honestly:

```
Per-turn fj (N forks × T turns):
  input:   H_seed + Σ_turns (Δ_join_t + Σ_i R_i)     ← shared prefix cached; cheap
  output:  N × Σ_turns O_i                            ← THE COST DRIVER
  context: grows N× faster than single-agent (joined outputs append)
```

**Crossover:** fj wins when the shared context is large and fork outputs are
small (review scenario: H=50K, O=1K → fork-join 93% off per the docs). fj
loses when outputs are long and the context is small. **The suffix protocol
(≤200t, PASS-or-FLAG) is what keeps fj in the winning regime** — this is not
an implementation detail, it's the economic precondition. The experiment
must sweep O_i (short vs long fork instructions) to map the crossover.

---

## 5. Experiment plan (deterministic, minimal-variability)

The v0.0.1 lesson: quality was uninterpretable (open-ended task, n=1, stage-0
divergence, reviewer scores). FJ's native shape fixes most of it, and the
golden-transform battery fixes the rest.

### 5.1 Task battery (golden oracles)

Same battery as the v0.0.2 proposal — 4-6 golden-transform tasks (input
fixture → byte-compare against golden output; this repo's generator shapes
are proven fixtures) + 2 hidden-test tasks. **Per-role golden oracle:** each
fork's output is checked against a *per-role* golden (correctness-reviewer
must emit PASS on a correct delta, FLAG on the planted defect).

### 5.2 Cells

| Cell | Variable |
|---|---|
| FJ concat, preset {correctness, security}, short-suffix | baseline fj |
| FJ judge, same preset | join-mode comparison |
| FJ concat, long-suffix (no length constraint) | output-cost crossover |
| RF / CF single-agent, same battery | structural control |
| n ≥ 5 per cell, temperature 0 | sampling control |

### 5.3 Primary metrics

1. **Per-fork cache hit %** — the untested claim, first real numbers.
2. **Defect interception latency** (turns between planted defect and FLAG) —
   the standing-committee value proposition. v0.0.1 shipped a defect the
   review missed; this measures the counterfactual.
3. **Cost per golden match** — tokens/dollar to converge on the golden
   output, distribution over n.
4. **Context growth rate** — N× vs single-agent, and whether it matters.

### 5.4 What this answers that v0.0.1 couldn't

- Is the docs' 97.5-99.8% parallel-fork cache claim real (provider-measured)?
- Does a standing reviewer committee catch defects faster/cheaper than an
  end-of-stage review (the v0.0.1 D5 skip)?
- What's the O_i crossover where fj stops being cheaper than single-agent?
- Pure cache geometry, isolated from solution variance — the clean test.

---

## 6. Implementation sketch (what the build touches)

| File | Change |
|---|---|
| `proxy/cf-proxy.mjs` | `isFJModel` branch (~10 lines); `POST /v1/session/agent-set` (~25); fj handler: fork-build + seed-then-warm execute + join + stream (~60); `fj_turn` logging (~15) |
| `proxy/cf-rewrite.mjs` | (optional) `buildForkSuffix(name, body, protocol)` wrapper; keep buildPersonaSuffix as the single source |
| `proxy/verify-cf-instructions.mjs` | fj tests: routing, preset-set endpoint, seed-then-warm ordering, concat join shape, drop-failed-fork |
| `proxy/mock-upstream.mjs` | extend to serve N concurrent forks (per-fork usage) |
| `proxy/aggregate-session.mjs` | `--fj` path: per-fork + per-turn tables |
| `experiments/SDLC-v0.0.2.md` | results template (cells, metrics, golden battery) |

~100-130 lines of new code in the proxy plus tests. The existing
`/v1/chat/fork` endpoint (line 981) stays as the one-shot manual tool; fj
mode is the per-turn automatic version.

---

## 7. Open questions

1. **Fork-skip heuristic** — how does the proxy detect "no delta worth
   reviewing" (planning turns) without an extra LLM call? Cheap proxy-side
   signal: no new `edit`/`write` tool calls since last turn → skip fork?
2. **Judge prompt design** — the FILTER phase needs a spec; candidate:
   "Synthesize N perspectives into the single best next action, citing
   FLAGs." (v2)
3. **How does opencode's main loop consume N concatenated perspectives** —
   does it actually read them, or does the noise degrade behavior? The
   concat-vs-judge measurement decides.
4. **Fork suffix protocol** — exact wording ("Reply ≤200t: PASS or FLAG:
   <issue> at <file>:<line>") to be tuned in a pilot before the battery.

---

## 8. Relationship to existing artifacts

- **v1 implemented (2026-08-05):** `proxy/fj` routing branch, preset-set
  endpoint (`POST /v1/session/agent {agents:[...], joinMode?}`), per-turn
  fork via `rewriteToContentFirst` per preset agent, seed-then-warm execute,
  concat join, per-fork cache metrics in the `fj_turn` log event, and the
  **judge join as a stubbed switch** (`case 'judge'` wired, logs
  `fj_judge_stub`, falls back to concat). Live-verified: fork-join turn
  executes, per-fork hit ratios recorded (cross-turn shared-prefix hits
  observed: both forks hit the same cached prefix), judge stub fires.
- **Not** a replacement for `/v1/chat/fork` (one-shot manual) — that stays.
- **REUSES the v4 CF rewrite as the fork engine.** Each fork is
  `rewriteToContentFirst(messages, personaSP=agent.systemPrompt, ...)` with a
  different persona — the rewrite's position-0 anchor + always-tail persona is
  literally the fork-join cache geometry, parameterized by persona. Forking
  the rewrite N times inherits every invariant (markers, idempotency,
  corruption checks, predictor) instead of building a parallel raw-fork path.
  The shared prefix stays byte-identical across forks because the rewrite
  only mutates the tail.
- **Fork-aware instructions block** (refinement, not mechanism): the session
  instructions currently say "hand off to the next specialist" — a reviewer
  fork should get fork-appropriate instructions ("you are one of N
  perspectives; reply PASS/FLAG + ≤200t"). Parameterized per mode.
- **The third arm**: RF (passthrough) / CF (rewrite) / FJ (fork-join) — the
  experiment framework's §5 comparison table gains a row.
- **Cross-refs:** RESUME.md §5a (measured numbers this design corrects),
  SDLC-v0.0.1.md Open Questions Q1-Q8 (the confounds this design removes).
