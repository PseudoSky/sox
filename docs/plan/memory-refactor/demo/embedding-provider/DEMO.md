# @adhd/sox-embedding-provider — Live Demo & Acceptance Script

> Real local embeddings in one `npm i` — no API keys, no account, swap models by config, loud-fail by design.

**What this is.** A presentation-grade walkthrough of `@adhd/sox-embedding-provider` that doubles as its acceptance test. Follow it top to bottom and you will (a) experience the package the way a brand-new user would and (b) prove every capability works, with exact commands, exact data, and pass/fail checks. It is the contract for what "done" means: if it is demonstrated here, it must work; if it must work, it is demonstrated here.

---

## 0 · How to Read This Script

**Legend**

| Marker | Meaning |
|---|---|
| 🎬 **Scene** | The story beat — what is happening and why the persona cares. Read this aloud in a demo. |
| ▶️ **Do** | The exact action to take (command or code snippet) with literal input data. |
| 👀 **Expect** | The exact observable result. Volatile parts shown as ⟨…⟩. |
| ✅ **Verify** | Binary pass/fail assertions. Tick each only if it is literally true. |
| 🔗 **Proves** | Requirement and capability IDs this beat satisfies. |
| 📎 **Source** | What grounds this step — spec section, doc, file, or URL. |
| ⟦U#⟧ | An **unresolved stub**: a value guessed because the context did not specify it. Logged in `UNRESOLVED.md` beside this file. |
| ⚠️ **Edge / 🛟 Recovery** | A deliberately adversarial or failure-then-recover beat. |

**Conventions**
- All commands run from the `embedding-demo/` working directory created in §2.4, unless stated otherwise.
- Values shown as ⟨like-this⟩ vary per run; the assertion next to them states what stays invariant.
- The surface is an ESM SDK: every snippet uses `node --input-type=module -e '...'`.
- Tokens shown as ⟦U#⟧ are interfaces this script had to guess; each is listed in `UNRESOLVED.md` beside this file.
- All sample text is fictional and safe for embedding.

---

## 1 · Cold Open — The Hook

🎬 **Scene.** Alex is building semantic search over 4 000 documentation pages. Every RAG tutorial says "call the embedding API." That means an account, a per-call bill, rate limits, and vectors that silently change when the provider updates its model. Alex needs reproducible, local, model-agnostic embeddings she can run in CI with zero network dependency and upgrade by flipping one config argument. `@adhd/sox-embedding-provider` is a standalone npm package — ≥3 local models spanning three dim sizes, batch-first, swap-by-config, and loud-fail by design. She installs it, runs two lines, and has a real `Float32Array` in thirty seconds.

> **The promise we will prove in the next 15 minutes:** embed a corpus fully in-process with no API key; swap models by changing one argument and watch `dim` change; confirm the deterministic provider returns byte-identical vectors across process restarts.

🔗 **Proves (framing):** REQ-006 · REQ-008 · CAP-001 · CAP-002
📎 **Source:** `docs/plan/memory-refactor/SCOPE.md` Part A (value proposition) + `USE_CASES.md` UC-EMB-1…5

---

## 2 · Cast, World & Cold-Start Setup

### 2.1 Meet Alex

Alex is a backend engineer at a developer-tools startup. She owns the indexing pipeline for a RAG-powered documentation search product. She needs real semantic embeddings for indexing, byte-identical vectors for CI snapshot tests, and the ability to upgrade the embedding model without rewriting pipeline code. The stakes: 4 000 docs go live in two weeks and the current hash-based stubs are burning her search quality.

### 2.2 The Canonical Demo Dataset

```js
// All beats use only these fixtures — no other data invented mid-demo.
const TEXT_A = 'the cat sat on the mat';                       // everyday prose
const TEXT_B = 'quarterly financial derivatives report';        // unrelated technical domain

const DOCS = [
  'TypeScript adds a static type system to JavaScript, enabling compile-time error detection.',
  'SQLite is a self-contained, serverless SQL engine embedded in the library itself.',
  'Embeddings are dense numeric vectors that encode semantic meaning in a fixed-length space.',
  'Vector similarity search finds items whose embeddings are geometrically closest to a query.',
];
```

### 2.3 Prerequisites

- Node.js ≥ 20 (LTS) — `node --version` must print `v20` or higher
- npm ≥ 9 — `npm --version` must print `9` or higher
- An empty working directory (created in §2.4)
- Internet access for the first `npm install` (ONNX weights download on first model warmup; subsequent runs use the local cache)

### 2.4 Cold Start — From Nothing to Running

▶️ **Do**
```bash
mkdir embedding-demo && cd embedding-demo
npm init -y
npm install @adhd/sox-embedding-provider
# Confirm: no @adhd runtime deps in the installed package (ADR-0006 gate)
npm ls --depth=1 2>/dev/null | grep "@adhd" || echo "zero @adhd runtime deps — ADR-0006 OK"
# Smoke-import
node --input-type=module -e "import { resolveProvider } from '@adhd/sox-embedding-provider'; console.log('import OK');"
```

👀 **Expect**
```
zero @adhd runtime deps — ADR-0006 OK
import OK
```

✅ **Verify**
- [ ] `zero @adhd runtime deps — ADR-0006 OK` is printed (the grep found nothing — no `@adhd` packages in runtime deps)
- [ ] `import OK` is printed (ESM named import resolves)

🔗 **Proves:** REQ-010 · CAP-001
📎 **Source:** `docs/decisions/0006-public-bundles-private-and-di-for-live-objects.md` §Consequences ("no `@adhd/sox-*` in runtime `dependencies`"); `docs/plan/memory-refactor/scripts/pack-smoke.mjs` §embedding-provider (import pattern)

---

## 3 · The Journey

### Act 1 — First Contact: Resolve a Provider and Embed Text

Alex opens the package README, copies two lines, and runs them. No config file, no auth step. She has a real vector within thirty seconds of `npm install`.

#### 1.1 · Resolve the Real Provider and Inspect Metadata   (happy)

🎬 **Scene.** Alex resolves the default in-process embedding provider and embeds her first document. She checks the provider metadata to understand what model she will be indexing with and confirms the returned vector is the right type and length.

▶️ **Do**
```bash
node --input-type=module -e "
import { resolveProvider } from '@adhd/sox-embedding-provider';
const provider = await resolveProvider({ backend: 'real' });
const vec = await provider.embed('the cat sat on the mat');
console.log('providerId:            ', provider.providerId);
console.log('modelId:               ', provider.modelId);
console.log('dim:                   ', provider.dim);
console.log('isDeterministic:       ', provider.isDeterministic);
console.log('isRemote:              ', provider.isRemote);
console.log('embed() is Float32Array:', vec instanceof Float32Array);
console.log('embed() length === dim: ', vec.length === provider.dim);
"
```

👀 **Expect**
```
providerId:             ⟨backend identifier, e.g. fastembed⟩
modelId:                ⟨default model name, e.g. BAAI/bge-small-en-v1.5⟩
dim:                    384
isDeterministic:        false
isRemote:               false
embed() is Float32Array: true
embed() length === dim:  true
```

✅ **Verify**
- [ ] `providerId` is a non-empty string
- [ ] `modelId` is a non-empty string
- [ ] `dim` is `384`
- [ ] `isDeterministic` is `false`
- [ ] `isRemote` is `false`
- [ ] `embed() is Float32Array: true`
- [ ] `embed() length === dim: true`

🔗 **Proves:** REQ-005 · REQ-006 · REQ-007 · CAP-001 · CAP-002 · CAP-008
📎 **Source:** `docs/plan/memory-refactor/scripts/pack-smoke.mjs` §embedding-provider (`real.embed()`, `real.dim` checks); `docs/plan/memory-refactor/SCOPE.md` Part A (provider metadata shape `{providerId, modelId, dim, isDeterministic, isRemote}`); SCOPE.md Part D ("bge-small 384" as the default dim); ⟦U2⟧ default model name string and `providerId` value inferred — see UNRESOLVED.md

#### 1.2 · Cosine of Unrelated Texts Proves Real Embeddings   (happy)

🎬 **Scene.** Alex embeds two semantically unrelated sentences to verify she has *real* embeddings, not a hash stub. A real model consistently separates distant domains; a random or hash function would not. This is the sanity gate the pack-smoke script enforces.

▶️ **Do**
```bash
node --input-type=module -e "
import { resolveProvider } from '@adhd/sox-embedding-provider';
const provider = await resolveProvider({ backend: 'real' });
const a = await provider.embed('the cat sat on the mat');
const b = await provider.embed('quarterly financial derivatives report');
function cosine(x, y) {
  let d = 0, nx = 0, ny = 0;
  for (let i = 0; i < x.length; i++) { d += x[i]*y[i]; nx += x[i]*x[i]; ny += y[i]*y[i]; }
  return d / (Math.sqrt(nx) * Math.sqrt(ny));
}
const cos = cosine(a, b);
console.log('cosine(TEXT_A, TEXT_B):', cos.toFixed(4));
console.log('semantically distinct (< 0.5):', cos < 0.5);
"
```

👀 **Expect**
```
cosine(TEXT_A, TEXT_B): ⟨a value between 0 and 1, expected < 0.5⟩
semantically distinct (< 0.5): true
```

✅ **Verify**
- [ ] `semantically distinct (< 0.5): true` — the model returns meaningful semantic vectors, not random or hash-based ones

🔗 **Proves:** REQ-006 · CAP-002
📎 **Source:** `docs/plan/memory-refactor/scripts/pack-smoke.mjs` §embedding-provider (literal check: `if (!(cos < 0.5)) throw new Error('cosine-sanity failed')` — this is the ground-truth assertion)

### Act 2 — Batch Corpus Embedding

Alex's pipeline needs to embed 4 000 docs. Per-call embedding at N×latency is the footgun. The batch API processes documents in configurable chunks through an async generator, keeping the runner's memory footprint flat.

#### 2.1 · Batch-Embed a Document Corpus   (happy)

🎬 **Scene.** Alex feeds her four canonical docs through `embedBatch` with a `batchSize` of 2, consuming the async generator. She verifies every output vector has the correct dim and is a `Float32Array`.

▶️ **Do**
```bash
node --input-type=module -e "
import { resolveProvider } from '@adhd/sox-embedding-provider';
const provider = await resolveProvider({ backend: 'real' });
const docs = [
  'TypeScript adds a static type system to JavaScript, enabling compile-time error detection.',
  'SQLite is a self-contained, serverless SQL engine embedded in the library itself.',
  'Embeddings are dense numeric vectors that encode semantic meaning in a fixed-length space.',
  'Vector similarity search finds items whose embeddings are geometrically closest to a query.',
];
const vectors = [];
for await (const vec of provider.embedBatch(docs, { batchSize: 2 })) {
  vectors.push(vec);
}
console.log('vectors produced:', vectors.length);
console.log('dims consistent:', [...new Set(vectors.map(v => v.length))].join(','));
console.log('all Float32Array:', vectors.every(v => v instanceof Float32Array));
"
```

👀 **Expect**
```
vectors produced: 4
dims consistent: 384
all Float32Array: true
```

✅ **Verify**
- [ ] `vectors produced: 4` — one vector per input document
- [ ] `dims consistent: 384` — all output vectors share the provider's `dim`
- [ ] `all Float32Array: true` — correct element type throughout

🔗 **Proves:** REQ-001 · CAP-001 · CAP-003
📎 **Source:** `docs/plan/memory-refactor/SCOPE.md` Part A ("batch `string[]→async generator`") + Part D ("batch embed API … async generator of Float32[], default batchSize 256"); `USE_CASES.md` UC-EMB-1; ⟦U3⟧ `provider.embedBatch(texts, {batchSize})` method name and async-generator return type inferred — see UNRESOLVED.md

### Act 3 — Deterministic Provider for CI

The team's CI pipeline runs on ephemeral machines. Alex cannot afford a model download on every build, and she needs byte-identical vectors for snapshot tests. The `hash` backend gives her exactly that.

#### 3.1 · Resolve Hash Provider and Verify Metadata   (happy)

🎬 **Scene.** Alex switches to the deterministic provider by changing one argument. She confirms `isDeterministic` is true and that the provider still satisfies the same embed contract.

▶️ **Do**
```bash
node --input-type=module -e "
import { resolveProvider } from '@adhd/sox-embedding-provider';
const det = await resolveProvider({ backend: 'hash' });
console.log('isDeterministic:', det.isDeterministic);
console.log('isRemote:       ', det.isRemote);
console.log('has embed fn:   ', typeof det.embed === 'function');
const v = await det.embed('the cat sat on the mat');
console.log('embed OK, dim:  ', v.length);
console.log('is Float32Array:', v instanceof Float32Array);
"
```

👀 **Expect**
```
isDeterministic: true
isRemote:        false
has embed fn:    true
embed OK, dim:   ⟨a fixed positive integer — the hash provider's output dim⟩
is Float32Array: true
```

✅ **Verify**
- [ ] `isDeterministic: true`
- [ ] `isRemote: false`
- [ ] `has embed fn: true` — the hash provider satisfies the same `embed()` contract
- [ ] `embed OK, dim:` shows a positive integer
- [ ] `is Float32Array: true`

🔗 **Proves:** REQ-002 · CAP-001 · CAP-004 · CAP-008
📎 **Source:** `docs/plan/memory-refactor/scripts/pack-smoke.mjs` §embedding-provider (`det.isDeterministic !== true` check); `docs/plan/memory-refactor/SCOPE.md` Part A ("The deterministic variant lives here as a first-class provider"); `USE_CASES.md` UC-EMB-2

#### 3.2 · Cross-Invocation Reproducibility   ⚠️ (edge)

🎬 **Scene.** Alex runs the same embed call twice in separate Node processes with no shared in-process state. If the vectors differ, CI snapshot tests are broken by design. She proves they are byte-identical.

▶️ **Do**
```bash
for i in 1 2; do
  node --input-type=module -e "
    import { resolveProvider } from '@adhd/sox-embedding-provider';
    const det = await resolveProvider({ backend: 'hash' });
    const v = await det.embed('reproducible-vector-test-phrase');
    process.stdout.write(v.slice(0, 4).join(',') + '\n');
  "
done
```

👀 **Expect**
```
⟨four comma-separated floats, e.g. 0.1234,-0.5678,0.9012,-0.3456⟩
⟨the identical four floats⟩
```

✅ **Verify**
- [ ] Both output lines are character-for-character identical — the same text produces the same vector regardless of process restart

🔗 **Proves:** REQ-002 · CAP-004
📎 **Source:** `docs/plan/memory-refactor/SCOPE.md` Part A ("deterministic variant … first-class provider"); `USE_CASES.md` UC-EMB-2 ("same text always yields the same vector across machines")

### Act 4 — Loud-Fail Guard

The production memory server requires *real* embeddings. Silent fallback to a hash vector silently corrupts semantic search and is exactly the BL-87/89 failure class the design guards against. Alex needs to confirm that `backend:'real'` fails loudly instead.

#### 4.1 · Bad Model Name Throws   ⚠️ (edge)

🎬 **Scene.** Alex specifies a non-existent model name to simulate a misconfigured or unavailable model. She confirms the resolver throws a diagnosable error — no silent degradation, no corrupt state, process does not hang.

▶️ **Do**
```bash
node --input-type=module -e "
import { resolveProvider } from '@adhd/sox-embedding-provider';
try {
  await resolveProvider({ backend: 'real', model: 'nonexistent/model-xyz-999' });
  process.stderr.write('ERROR: should have thrown\n');
  process.exit(1);
} catch (err) {
  console.log('threw as expected');
  console.log('message preview:', String(err.message).slice(0, 80));
  process.exit(0);
}
"
echo "exit code: $?"
```

👀 **Expect**
```
threw as expected
message preview: ⟨a human-readable message mentioning the model name or provider failure⟩
exit code: 0
```

✅ **Verify**
- [ ] `threw as expected` is printed — the catch branch ran
- [ ] `message preview` contains a non-empty, non-undefined string
- [ ] `exit code: 0` — process exited cleanly via the catch branch, not via an uncaught exception or hang

🔗 **Proves:** REQ-004 · CAP-005
📎 **Source:** `docs/plan/memory-refactor/SCOPE.md` Part A ("Loud-fail: resolver throws if the configured real provider can't load"); `USE_CASES.md` UC-EMB-4 ("throws a diagnosable error on warmup failure"); ⟦U1⟧ `model` config key name in `resolveProvider()` inferred — see UNRESOLVED.md; ⟦U4⟧ exact error type and message format inferred — see UNRESOLVED.md

#### 4.2 · Recover via Hash Fallback   🛟 (recovery)

🎬 **Scene.** Alex's application layer catches the loud-fail and falls back to the hash provider. Callers own their degradation policy — the package does not silently degrade, it throws so the caller can decide.

▶️ **Do**
```bash
node --input-type=module -e "
import { resolveProvider } from '@adhd/sox-embedding-provider';
let provider;
try {
  provider = await resolveProvider({ backend: 'real', model: 'nonexistent/model-xyz-999' });
} catch (_) {
  console.log('real unavailable — falling back to hash');
  provider = await resolveProvider({ backend: 'hash' });
}
const v = await provider.embed('fallback test');
console.log('provider isDeterministic:', provider.isDeterministic);
console.log('embed worked:            ', v instanceof Float32Array);
"
```

👀 **Expect**
```
real unavailable — falling back to hash
provider isDeterministic: true
embed worked:             true
```

✅ **Verify**
- [ ] `real unavailable — falling back to hash` printed — the caller handled the loud-fail
- [ ] `provider isDeterministic: true` — hash provider resolved successfully after the throw
- [ ] `embed worked: true` — full recovery to a usable embedding state

🔗 **Proves:** REQ-004 · CAP-001 · CAP-004 · CAP-005
📎 **Source:** `docs/plan/memory-refactor/SCOPE.md` Part A loud-fail design; `USE_CASES.md` UC-EMB-4; ⟦U1⟧ `model` config key inferred; ⟦U4⟧ error recovery pattern inferred — see UNRESOLVED.md

---

## 4 · The Climax — Multi-Model Swap: One Arg, Different Dim

Alex's team runs an A/B experiment on search quality and concludes that the 384-dim model lacks recall depth for technical content. They need to upgrade to the 1024-dim model. With `embedding-provider` the switch is a single config argument — not a code change, not a pipeline rewrite. And because `dim` is a live property on the provider, nothing downstream hard-codes it.

▶️ **Do**
```bash
node --input-type=module -e "
import { resolveProvider } from '@adhd/sox-embedding-provider';

const small = await resolveProvider({ backend: 'real', model: 'BAAI/bge-small-en-v1.5' });
const large = await resolveProvider({ backend: 'real', model: 'intfloat/e5-large-v2' });

console.log('=== small model ===');
console.log('modelId:', small.modelId);
console.log('dim:    ', small.dim);

console.log('=== large model ===');
console.log('modelId:', large.modelId);
console.log('dim:    ', large.dim);

console.log('=== dim changed:', small.dim !== large.dim, '===');

function cosine(x, y) {
  let d = 0, nx = 0, ny = 0;
  for (let i = 0; i < x.length; i++) { d += x[i]*y[i]; nx += x[i]*x[i]; ny += y[i]*y[i]; }
  return d / (Math.sqrt(nx) * Math.sqrt(ny));
}

const sA = await small.embed('information retrieval systems');
const sB = await small.embed('cheese and wine pairing guide');
const lA = await large.embed('information retrieval systems');
const lB = await large.embed('cheese and wine pairing guide');

console.log('small cosine (unrelated):', cosine(sA, sB).toFixed(4));
console.log('large cosine (unrelated):', cosine(lA, lB).toFixed(4));
console.log('small vec.length === small.dim:', sA.length === small.dim);
console.log('large vec.length === large.dim:', lA.length === large.dim);
"
```

👀 **Expect**
```
=== small model ===
modelId: ⟨BAAI/bge-small-en-v1.5 or similar⟩
dim:     384
=== large model ===
modelId: ⟨intfloat/e5-large-v2 or similar⟩
dim:     1024
=== dim changed: true ===
small cosine (unrelated): ⟨< 0.5⟩
large cosine (unrelated): ⟨< 0.5⟩
small vec.length === small.dim: true
large vec.length === large.dim: true
```

✅ **Verify**
- [ ] `small.dim` is `384` and `large.dim` is `1024` — both models resolve with their correct dims
- [ ] `dim changed: true` — `dim` reflects the active model, it is not a hard-coded constant anywhere in the caller
- [ ] Both cosine values < 0.5 — both models return meaningful semantic embeddings for these unrelated texts
- [ ] `small vec.length === small.dim: true` and `large vec.length === large.dim: true` — dim metadata is accurate at both sizes
- [ ] The only change between the two `resolveProvider()` calls is the `model` argument — no caller code restructured

🔗 **Proves:** REQ-003 · REQ-006 · REQ-007 · REQ-008 · CAP-001 · CAP-002 · CAP-006 · CAP-008
📎 **Source:** `docs/plan/memory-refactor/SCOPE.md` Part A ("Ship ≥3 local fastembed models spanning dims now (e.g. bge-small 384, bge-base 768, e5-large 1024) … dim parameterization is now MANDATORY") + Part D ("multi-model + multi-context from the gate"); `USE_CASES.md` UC-EMB-3; ⟦U1⟧ `model` config key name inferred; ⟦U2⟧ exact model string IDs inferred — see UNRESOLVED.md

---

## 5 · Resilience Sweep — Edges We Didn't Hit in the Story

#### 5.1 · ⚠️ Remote Adapter Conforms to the Same Contract

▶️ **Do**
```bash
node --input-type=module -e "
import { resolveProvider } from '@adhd/sox-embedding-provider';
const remote = await resolveProvider({ backend: 'remote' });
console.log('isRemote:         ', remote.isRemote);
console.log('has embed fn:     ', typeof remote.embed === 'function');
console.log('dim is number:    ', typeof remote.dim === 'number');
console.log('modelId is string:', typeof remote.modelId === 'string');
console.log('isDeterministic:  ', remote.isDeterministic);
"
```
👀 **Expect** — `isRemote: true`, `has embed fn: true`, `dim is number: true`, `modelId is string: true`, `isDeterministic: false`
✅ **Verify**
- [ ] `isRemote: true` — this is the remote adapter, not a local in-process model
- [ ] `has embed fn: true`, `dim is number: true`, `modelId is string: true` — remote adapter satisfies the same contract as local providers
🔗 **Proves:** REQ-007 · REQ-009 · CAP-007 · CAP-008
📎 **Source:** `docs/plan/memory-refactor/SCOPE.md` Part A ("remote provider adapter against the same contract … enough to prove context-agnosticism"); `USE_CASES.md` UC-EMB-3 ("local‖remote contract — the remote adapter conforms to the same contract"); ⟦U5⟧ `{backend:'remote'}` instantiation API inferred — see UNRESOLVED.md

#### 5.2 · ⚠️ dim Metadata Matches Actual Vector Length

▶️ **Do**
```bash
node --input-type=module -e "
import { resolveProvider } from '@adhd/sox-embedding-provider';
const provider = await resolveProvider({ backend: 'real' });
const vec = await provider.embed('dimension-consistency test');
const match = vec.length === provider.dim;
console.log('vec.length:', vec.length, '=== provider.dim:', provider.dim, '->', match);
"
```
👀 **Expect** — `vec.length: 384 === provider.dim: 384 -> true`
✅ **Verify**
- [ ] The trailing `-> true` — `vec.length === provider.dim` holds for every embed call, not just the first
🔗 **Proves:** REQ-006 · REQ-007 · CAP-002 · CAP-008
📎 **Source:** `docs/plan/memory-refactor/scripts/pack-smoke.mjs` §embedding-provider (literal check: `if (a.length !== real.dim) throw new Error('dim mismatch')`)

---

## 6 · Teardown — Back to Zero

`@adhd/sox-embedding-provider` is a pure in-process SDK. It spawns no background processes, opens no persistent sockets, and writes no application data files. The ONNX runtime lifecycle is tied to the provider instance and released by the GC when the process exits. Teardown is removing the demo directory.

▶️ **Do**
```bash
cd ..
rm -rf embedding-demo
ls embedding-demo 2>&1 || true
pgrep -f sox-embedding-provider 2>/dev/null || echo "no lingering processes"
```

👀 **Expect**
```
ls: embedding-demo: No such file or directory
no lingering processes
```

✅ **Verify**
- [ ] `No such file or directory` — the demo directory is fully removed
- [ ] `no lingering processes` — no background processes referencing the package remain

🔗 **Proves:** REQ-010 · CAP-001
📎 **Source:** `docs/plan/memory-refactor/SCOPE.md` Part A (standalone package — no daemon, no persistent state); `docs/decisions/0006-public-bundles-private-and-di-for-live-objects.md` §Decision (zero `@adhd` runtime deps); ⟦U6⟧ provider lifecycle inferred (no explicit `dispose()` required — GC handles ONNX session termination) — see UNRESOLVED.md

---

## 7 · Coverage & Traceability Matrix

### 7.1 Requirements → Beats

| Req ID | Requirement (short) | Proven by beat(s) | Paths covered (H/E/R) | Status |
|---|---|---|---|---|
| REQ-001 | Batch embed via async generator, configurable `batchSize` | Beat 2.1 | H | ☐ |
| REQ-002 | Deterministic provider — same text → same vector, zero model download | Beats 3.1, 3.2 | H, E | ☐ |
| REQ-003 | Model swap via config — `{modelId, dim}` updates, no caller code change | §4 Climax | H | ☐ |
| REQ-004 | `backend:'real'` throws diagnosably on failure; never silent | Beats 4.1, 4.2 | E, R | ☐ |
| REQ-005 | Query-optimized single-embed path; startup cache for hot embeddings | Beat 1.1 (single-embed); startup cache: scope gap (see §7.3) | H | ☐ |
| REQ-006 | `embed(text)→Float32Array` single-embed API | Beats 1.1, 1.2, §4, 5.2 | H | ☐ |
| REQ-007 | Provider metadata: `{providerId, modelId, dim, isDeterministic, isRemote}` | Beats 1.1, 3.1, §4, 5.1, 5.2 | H | ☐ |
| REQ-008 | ≥3 local models spanning dims 384/768/1024, proven model-agnostic | §4 Climax | H | ☐ |
| REQ-009 | Remote provider adapter — same contract, `isRemote:true`, not live | Beat 5.1 | E | ☐ |
| REQ-010 | Standalone `npm i` with zero `@adhd` runtime deps in the published tarball | §2.4 Cold Start, §6 Teardown | H | ☐ |

### 7.2 Capabilities → Beats

| Cap ID | Capability | Proven by beat(s) | Status |
|---|---|---|---|
| CAP-001 | `resolveProvider({backend})` — resolve and warmup provider | §2.4, 1.1, 3.1, 4.1, 4.2, §4, §6 | ☐ |
| CAP-002 | `provider.embed(text)→Float32Array` — single-text embedding | 1.1, 1.2, 3.1, 5.2, §4 | ☐ |
| CAP-003 | `provider.embedBatch(texts, {batchSize})` — async batch embedding | 2.1 | ☐ |
| CAP-004 | Deterministic hash provider — `isDeterministic:true`, stable output | 3.1, 3.2, 4.2 | ☐ |
| CAP-005 | Loud-fail on real-provider failure — throws, never silent | 4.1 | ☐ |
| CAP-006 | Multi-model support — `model` config arg, `dim` reflects active model | §4 Climax | ☐ |
| CAP-007 | Remote provider adapter — `isRemote:true`, same contract as local | 5.1 | ☐ |
| CAP-008 | Provider metadata surface — `providerId`, `modelId`, `dim`, `isDeterministic`, `isRemote` | 1.1, 3.1, §4, 5.1, 5.2 | ☐ |

### 7.3 Unresolved Interfaces & Gaps

6 interface stubs (⟦U1⟧–⟦U6⟧) and 2 scope gaps. Full list in `UNRESOLVED.md`.

Highest-impact to resolve first:
- **⟦U1⟧** — `model` config key name in `resolveProvider()` — affects beats 4.1, 4.2, and the entire §4 Climax.
- **⟦U2⟧** — exact model string IDs for all 3 local models — affects §4 Climax expected output and beats that inspect `modelId`.
- **⟦U3⟧** — `provider.embedBatch(texts, {batchSize})` method location and return type — affects beat 2.1 (the entire batch API path).

---

## 8 · Sign-Off

| Field | Value |
|---|---|
| Environment | ⟨OS / Node version / package version / commit SHA⟩ |
| Run by | ⟨name or agent ID⟩ |
| Date | ⟨date⟩ |
| Beats passed | ⟨X of Y⟩ |
| Requirements proven | ⟨X of Y⟩ |
| Result | ☐ PASS   ☐ FAIL |
| Notes / defects filed | ⟨…⟩ |

> A run is **PASS** only if every ✅ assertion is checked and every requirement in §7 is proven. One unchecked binary assertion = FAIL until resolved.
