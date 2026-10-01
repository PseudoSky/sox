# SPEC — Embedding model tier: one machine-wide, work-driven drainer

**Status:** DRAFT for implementation (2026-09-27). Implementation starts only after the owner approves
ADR-0023 (segment S0).
**Author:** architect (spec only; this document ships no code).
**Research:** `.research-trace/2026-09-27-embedding-runner-funnel.md` (verdict "A, modified").
**Governing ADRs:** 0020 (D1, D3, D5 stand), 0022 (§2, §3, §5 stand), 0013 (no env toggles),
0012 (compute-only), 0006/0019 (bundling and lazy natives), 0005/0021 (publishing, registry is
release-only). ADR-0023 (text in §11) amends ADR-0020 D2 and D4, and amends ADR-0022 §1's default,
§4, and its Consequences.

Backlog ids are placeholders (`BL-TIER-xx`). The dispatcher files them through `backlog-operator`
before dispatch and substitutes the real ids into test names.

---

## 0. Summary

There is **one embedding drainer per machine** (per user, per model/contract/EP key). It is the model
tier: the only process that loads the ONNX model. Every consumer **enqueues** embedding work into it:
the memory-server (launchd), short-lived backlog CLI/MCP processes, test suites and agent worktrees.
The drainer owns the model and batches across everything queued, using lanes, per-client fairness, a
token budget and length buckets. It delivers each result back to the connection that enqueued it,
which is exactly today's funnel contract: the consumer applies the vector to its own store, and the
drainer never opens a store. The drainer lives while its queue has work and retires `W` after the
queue empties.

When an enqueue finds no live drainer, it spawns one through `ensureBackend`'s O_EXCL lock. A drainer
built from a newer **released package version** (semver, stamped into the build from
`package.json`) takes over through drain-on-newer: the incumbent finishes its queue and hands the
socket to a successor. Unreleased worktree code carries the version of the release it branched from,
so it can never drain production.

The fastembed wrapper is replaced by `onnxruntime-node` used directly. The runner keeps the same
`.onnx` file, the same tokenizer and the same pooling. It also keeps the current prefix asymmetry, so
the 9,313 stored vectors stay valid. The per-build host, its ONNX child process and the adaptive
child pool (BL-575) are deleted.

---

## 1. Ground truth this spec is built on (read, not assumed)

| # | Fact | Evidence |
|---|---|---|
| F1 | `embed` means fastembed `queryEmbed`, which prepends `"query: "`. `embedBatch` means `embed()`, with no prefix. | `libs/data/embed/embedding-provider/src/fastembedProcessHost.ts:512`, `:340`; `node_modules/.pnpm/fastembed@2.1.0/.../lib/esm/fastembed.js:262-263` |
| F2 | The prefix is decided by the **wire method**, not the provider method. When any text in a batch slice is over the chunk threshold, the whole slice goes through `embedSingle`, and so gets `"query: "`. Each chunk of a long text also gets `"query: "`, and the chunks are then mean-pooled. | `src/fastembed.ts:131-147`, `:159-171` |
| F3 | Pooling takes the CLS token (token 0 of `last_hidden_state`) and applies L2 normalisation with ε=1e-12. The model file is `model_optimized.onnx`, loaded with `graphOptimizationLevel:'all'` and `token_type_ids` fed. | `fastembed.js:33-37`, `:72-81`, `:224-255` |
| F4 | fastembed pads **every** sequence to a fixed 512 tokens: `setPadding({maxLength})` maps to `PaddingStrategy::Fixed`. A 20-token query computes 512 positions. | `fastembed.js:105-110`; `@anush008/tokenizers/src/tokenizer.rs:78` |
| F5 | `onnxruntime-node`'s `session.run()` is **synchronous on the JS thread** (it is `setImmediate`, then a synchronous binding call). An in-process run blocks the event loop. | `node_modules/.pnpm/onnxruntime-node@1.24.3/.../dist/backend.js` `run()` |
| F6 | Today's key contains `buildId`, and `buildId` hashes `process.versions.modules`, so Node-ABI-split hosts never share. The key also uses `ep` = the unresolved `'auto'`. | `src/embedHostConfig.ts:202-210`, `:303-306`; `src/funnelClient.ts:342` |
| F7 | The delivery contract today: the consumer sends a request over UDS and gets the vector back **on that connection**, then applies it to its own store. The host is compute-only. | ADR-0020 D3; `src/funnelClient.ts:146-224` |
| F8 | Each consumer's durable record of "this needs embedding" lives in **its own store**. In memory-core it is the transactional outbox plus the heal tick. In backlog it is a bounded in-flight drain, with unsettled work written as durable `embedding_failed` rows and repaired by a backfill. | `libs/memory-core/src/embed-pipeline.ts:1-20`; adhd `entrypoint/backlog/src/write/embed-drain.ts:1-50`, `src/store/graph-backlog-store.ts:149-160,230-240` |
| F9 | `serveBackend` handlers receive only the request, with no connection identity. Frames are dispatched concurrently (`void onFrame`). | `libs/service-proxy/src/backend.ts:33-35`, `:141` |
| F10 | `dialBackend` calls `onConnect` **before** `flushQueue()`. It requeues sent-but-unanswered requests and replays them on reconnect. It never spawns. | `libs/service-proxy/src/dial.ts:152-163`, `:181-186` |
| F11 | `ensureBackend` readiness is `handshakeBackend`: it sends `{method:'ping'}` and accepts **any** response. A death by signal before ready is stamped `(signal SIGKILL)`, and the client retries once through a fresh ensure. | `libs/service-proxy/src/ensure-backend.ts:147-190`; `src/funnelClient.ts:446-456` |
| F12 | Telemetry covers 2026-09-26 to 09-27 (44.5 h): 293 host spawns (non-test: 194); peak concurrent hosts 3; median host life 77 s; one request p50 was `work_ms` 856 against `cpu_ms` 414. | `~/.adhd/sox-ecosystem/embed-host/logs/*.jsonl` (analysis in §9.3) |
| F13 | adhd pins `@adhd/sox-embedding-provider ^0.6.0` (lock: a single 0.6.0), `@adhd/sox-hybrid-search ^0.5.0` and `@adhd/sox-semantic ^0.1.8`. In sox, the dependents are memory-core 0.11.2, hybrid-search 0.5.0, semantic 0.1.8 and claim-verification 0.1.5, all at `workspace:^`. Changesets has `updateInternalDependencies: "patch"`. | adhd `entrypoint/backlog/package.json:21-22,39`; sox `.changeset/config.json` |
| F14 | memory-server declares `fastembed ^2.1.0` and `onnxruntime-node 1.21.0` and bundles with `--external fastembed --external onnxruntime-node`. | `extensions/bundles/sox-memory-bundle/members/memory-server/package.json:23-24`, `project.json:18` |
| F15 | The model on disk is `~/.cache/sox/models/fast-bge-base-en-v1.5/model_optimized.onnx`, 228,454,902 bytes. | `ls -la` |

---

## 2. Architecture

```
 consumer process (memory-server | backlog CLI/MCP | test | worktree)
   FastembedProvider (routing unchanged, F2)
     └─ ModelTierClient  ── enqueue(kind, texts, lane) ──►  UDS  <machine-wide socket dir>/<hash(key)>
          ▲  delivery = the JSON-RPC response on the same connection (F7 contract, kept)
          │  consumer applies the vector to ITS OWN store (unchanged)
          │
 drainer process (detached, unsupervised, ONE per key)             ADR-0020 D1
   modelTierServer: hello gate → queue (lanes, DRR, buckets) → batch
     main thread: socket, handshake, tokenizer, scheduler, reap
     ONE worker_thread: onnxruntime-node session (F5: run() blocks its thread)
   retires W after the queue empties; never with work queued        ADR-0022 §1
   holds NO store connection                                        ADR-0020 D3
```

### 2.1 Queue semantics (owner correction, made normative)

1. **The enqueue is the request frame, and the delivery is its response.** `model.enqueue` puts the
   items in the drainer's queue. The drainer answers when every item of that enqueue is embedded.
   A consumer that does not wait (it exits, or its bounded drain gives up) closes its connection. The
   drainer then **cancels that connection's unstarted items** and drops any results still to be
   delivered. The drainer cancels unstarted items (O6); backlog re-embeds them via its heal tick.
2. **The drainer queue is in memory and is not the durable record.** Durability lives where it lives
   today, in each consumer's store (F8). memory-core's outbox and heal tick re-enqueue missing
   vectors. Backlog writes unsettled work as `embedding_failed`, and its backfill re-enqueues it. No
   work is lost silently.
3. **Retirement never drops queued work.** The reap arms only when the queue is empty and no batch is
   in flight. It fires `W` after the last batch completes. The empty-check, the flip to `retiring` and
   the listener close all happen in **one synchronous tick**, so no enqueue can be accepted and then
   dropped. An enqueue that races the flip is answered `-32001 TIER_RETIRING`, and the client
   re-ensures (spawning a successor) and re-sends.
4. **A drainer that dies mid-queue does not lose connected consumers' work.** Each consumer's dial
   layer requeues its unanswered enqueues (F10). Its `onDisconnect` re-ensures a successor through
   `ensureBackend` (F11). On the new connection the hello is re-sent first (§4.3), then the
   unanswered enqueues are replayed. Embedding is idempotent, so a replayed enqueue is simply embedded
   again. Replay is bounded by the dial give-up (10 s) plus one client-level retry. Work whose
   consumer has already exited dies with the drainer and is recovered through §2.1.2.
5. **Drain-on-newer finishes the queue and hands off** (§4.5). The incumbent stops admitting work,
   closes its listener so a successor can bind at once, **finishes every item already queued**,
   delivers the results on the still-open connections, and retires. New work goes to the successor.

### 2.2 Singleton key and socket location

```
embedding-model:v<MODEL_TIER_PROTOCOL>:<modelFileSha[0..16)>:<VECTOR_CONTRACT_ID>:<resolvedEp>
```

- **Excluded** by design: the JS build id, the Node ABI, the runner (ORT) version and the cache dir.
  The same model file shares one drainer whatever cache dir holds it.
- **`modelFileSha` is a pinned constant** in the model manifest (`MODEL_CONFIGS[model].onnxSha256`).
  The client computes the key with **zero file I/O**, which matters: a short-lived CLI must not hash
  a 228 MB file. The drainer verifies the real file against the pin once per spawn, caching the
  result in a stat-keyed stamp file, and fails with a typed error on a mismatch.
- `resolvedEp` is `'cpu' | 'coreml' | 'cuda' | 'dml'`, never `'auto'` (this fixes F6).
- **The socket directory is machine-wide and independent of `SOX_ECOSYSTEM_HOME`:**
  `join(homedir(), '.adhd', 'run', 'embedding-model')`. The drainer holds no data (ADR-0012, ADR-0020
  D3), so a data-root sandbox must not fork it. Tests and worktrees with a sandboxed data root still
  share the real drainer. ADR-0023 D3 records the departure from ADR-0004's "socket under the data
  root". The stub drainer used by lifecycle tests **refuses** to bind in this directory (§6).
- `host: 'private'` (ADR-0020 D4, typed) runs the same drainer under the key suffix
  `:private:<consumerPid>`. It stays explicit, is not shared, and never falls back silently.

### 2.3 Vector contract (preserved exactly)

`VECTOR_CONTRACT_ID = 'cls-l2e12-qembed-v1'`:
- CLS pooling;
- L2 normalisation with ε=1e-12;
- truncation at `min(512, model_max_length)`;
- the prefix rule `model.enqueue{kind:'embed'}` → `"query: " + text` and `{kind:'embedBatch'}` → `text`.

The prefix is applied **before** tokenisation and coalescing, so items of both kinds can share one
ORT run. Padding changes from fixed-512 (F4) to **batch-longest with the attention mask**. CLS under
the mask is invariant to pad positions up to float noise, which is why the gate is cosine ≥ 0.999
rather than equality. `FastembedProvider`'s routing (F2) stays **byte-identical**.

---

## 3. Files

| Package / Repo | Path | Change | Read tokens | Output tokens |
|---|---|---|---|---|
| sox docs | docs/decisions/0023-embedding-model-tier-is-a-machine-wide-singleton.md | create | 0 | 2200 |
| sox docs | docs/decisions/0020-embedding-funnel-peer-spawned-self-reaping.md | modify (Status line) | 200 | 80 |
| sox docs | docs/decisions/0022-embedding-funnel-is-a-work-driven-drainer.md | modify (Status line) | 200 | 80 |
| embedding-provider | src/vectorContract.ts | create | 0 | 350 |
| embedding-provider | src/fastembedModels.ts | modify (pin sha, file, archive) | 900 | 350 |
| embedding-provider | src/index.ts | modify (FastEmbedModelConfig, EmbeddingProviderConfig, exports) | 1800 | 600 |
| embedding-provider | src/modelAcquire.ts | create (GCS download, sha verify, stamp) | 600 (fastembed.js:128-200) | 900 |
| embedding-provider | src/onnxRunner.ts | create | 900 (fastembed.js:57-255) | 1100 |
| embedding-provider | src/runnerWorker.ts | create (one worker_thread hosting onnxRunner) | 300 | 500 |
| embedding-provider | src/modelTierProtocol.ts | create (key, hello, codes, decisions, semver precedence) | 0 | 1100 |
| embedding-provider | src/packageVersion.generated.ts | generated at build by `stamp-version`, gitignored, never committed | 0 | 0 |
| embedding-provider | src/packageVersion.spec.ts | create (stamp parity guard) | 0 | 250 |
| embedding-provider | .gitignore | create (ignores `src/packageVersion.generated.ts`) | 0 | 20 |
| embedding-provider | project.json | modify (`stamp-version` target; `build`/`typecheck`/`lint` depend on it; `package.json` in `build` inputs) | 500 | 250 |
| embedding-provider | src/tierScheduler.ts | create (lanes, DRR, buckets, budget, bounds) | 0 | 1400 |
| embedding-provider | src/modelTierServer.ts | create (drainer lifecycle) | 2500 (embedHostMain.ts) | 2200 |
| embedding-provider | src/modelTierMain.ts | create (prod entrypoint) | 300 | 250 |
| embedding-provider | src/modelTierConfig.ts | create from embedHostConfig.ts (socket dir, env scrub, argv) | 3000 | 1300 |
| embedding-provider | src/modelTierClient.ts | create from funnelClient.ts | 3500 | 2000 |
| embedding-provider | src/sharedFastembedProcess.ts | modify (shrink to accessor ~120 lines) | 1500 (1700-1847) | 500 |
| embedding-provider | src/fastembed.ts | modify (lane stamping, EP from config) | 700 | 150 |
| embedding-provider | src/embedHostMain.ts, embedHostConfig.ts, funnelClient.ts, fastembedProcessHost.ts, fastembedLock.ts | delete | 0 | 0 |
| embedding-provider | src/test-support/stubTierMain.ts, stubRunner.ts | create | 400 | 600 |
| embedding-provider | src/test-support/funnelHarness.ts | modify → tierHarness.ts | 1000 | 700 |
| embedding-provider | src/*.spec.ts (the pool, lock and fastembed-child specs) | delete or port (see S5) | 3000 | 3000 |
| embedding-provider | src/vector-compat.e2e.ts, tier-real-model.e2e.ts | create | 400 | 1500 |
| embedding-provider | package.json, project.json, vitest.config.ts, vitest.e2e.config.ts | modify/create | 1200 | 500 |
| embedding-provider | CLAUDE.md, AGENTS.md, README.md, CHANGELOG (via changeset) | modify | 1500 | 700 |
| service-proxy | src/backend.ts | modify (connection context, additive) | 1600 | 400 |
| service-proxy | src/ensure-backend.ts | modify (`supersede`, additive) | 2500 | 600 |
| service-proxy | src/backend-conn-context.spec.ts, ensure-backend-supersede.spec.ts | create | 400 | 1200 |
| memory-server | package.json, project.json | modify (natives, externals) | 400 | 120 |
| memory-core | package.json | modify (drop the unused `fastembed` dep) | 200 | 20 |
| sox root | libs/data/CLAUDE.md (BL-11 section) | modify | 900 | 400 |
| sox root | tools/embedding-tier-report.mjs, tools/embedding-ep-ab.mjs | create | 300 | 1600 |
| sox root | tools/stamp-package-version.mjs | create (generic: package.json `version` → TS constant module) | 0 | 450 |
| sox root | tools/test-bl-tier-s11-version-stamp.mjs | create (red→green for the stamp tool) | 300 | 500 |
| sox root | tools/guards-manifest.mjs | modify (register the stamp test beside `test-bl313-…`, ~line 223) | 400 | 60 |
| sox root | PUBLISHING.md (e2e lane in the dry-run list; post-`changeset version` rebuild and stamp assertion) | modify | 600 | 200 |
| sox root | .changeset/*.md (two files) | create | 0 | 200 |
| adhd | entrypoint/backlog/package.json, pnpm-lock.yaml | modify | 300 | 60 |
| adhd | entrypoint/backlog/src/store/embed-funnel*.e2e.ts, src/test/helpers/embed-funnel-consumer.ts | modify (event names, key) | 2500 | 800 |

---

## 4. Interface changes

### 4.1 `src/vectorContract.ts` (new, pure: zero runtime imports)

```typescript
export type WireKind = 'embed' | 'embedBatch';
export interface VectorContract {
  readonly id: 'cls-l2e12-qembed-v1';
  readonly pooling: 'cls';
  readonly normalize: { kind: 'l2'; epsilon: 1e-12 };
  readonly prefix: { readonly embed: 'query: '; readonly embedBatch: '' };
  readonly padding: 'batch-longest-attention-masked';
}
export const VECTOR_CONTRACT: VectorContract;
export const VECTOR_CONTRACT_ID: VectorContract['id'];
/** The ONLY place a prefix is applied. Called by the drainer at enqueue time, before tokenising. */
export function applyPrefix(kind: WireKind, text: string): string;
/** CLS row i of a [B, L, D] last_hidden_state, L2-normalised with ε=1e-12 (bit-for-bit fastembed.js:33-45). */
export function poolClsL2(data: Float32Array, dims: readonly [number, number, number], row: number): Float32Array;
```

### 4.2 `src/index.ts`: public config and types

```typescript
// BEFORE
export interface FastEmbedModelConfig { modelId: string; hfRepoId: string; dim: number; maxTokens: number; description: string }
export interface EmbeddingProviderConfig { /* … */ host?: EmbedHostMode; idleGraceMs?: number }

// AFTER (additive fields; the 'fastembed' config type literal is KEPT — it names the model layout, and
// adhd's env.ts forwards it verbatim)
export interface FastEmbedModelConfig {
  modelId: string; hfRepoId: string; dim: number; maxTokens: number; description: string;
  /** File under <cacheDir>/<hfRepoId>/ that the runner loads. */
  onnxFile?: 'model_optimized.onnx' | 'model.onnx';
  /** Pinned sha256 of onnxFile — part of the singleton key; null ⇒ the model is not tier-servable (loud). */
  onnxSha256?: string | null;
  /** Cold-cache source. null ⇒ no automatic acquisition (loud error naming the expected path). */
  archive?: { url: string } | null;
}
export type EmbedExecutionProvider = 'auto' | 'cpu' | 'coreml';
export interface EmbeddingProviderConfig {
  /* … unchanged … */
  host?: EmbedHostMode;              // 'shared' | 'private' — unchanged surface (ADR-0020 D4, amended)
  idleGraceMs?: number;              // W; default becomes 120_000 (§9.3)
  /** Typed EP selection (ADR-0013). Replaces the SOX_EMBED_EXECUTION_PROVIDER env var, which is deleted. */
  executionProvider?: EmbedExecutionProvider;
}
```

Removed exports: `FastembedProcessPool`, `AdaptiveFastembedProcessPool`, `AdaptiveFastembedPoolOptions`,
`FastembedBusyError`, `resolveFastembedPoolSize`, `resolveFastembedPoolPin`,
`resolveFastembedPoolCeiling`, `resolveFastembedAdmissionLimit`, `getPrivateFastembedProcess`,
`SharedFastembedProcessClient`, `PrivateFastembedProcess`, `FunneledFastembedClient`
(`index.ts:193-237`). Removing them is a breaking change, so the release is **0.7.0** (O1).

Added exports: `ModelTierClient`, `ModelTierBusyError`, `ModelTierRejectedError`, `VECTOR_CONTRACT_ID`,
`MODEL_TIER_PROTOCOL_VERSION`, `modelTierKey`.

Kept names, so memory-core needs no change: `getSharedFastembedProcess`, `resetSharedFastembedProcess`,
`resetSharedFastembedHost`, `SharedFastembedClient`. `resetSharedFastembedHost` now sends `model.reset`.

### 4.3 `src/modelTierProtocol.ts` (new, pure)

```typescript
export const MODEL_TIER_PROTOCOL_VERSION = 3;
export type ResolvedEp = 'cpu' | 'coreml' | 'cuda' | 'dml';
export type Lane = 'interactive' | 'bulk';
export type RunnerKind = 'onnx' | 'stub';

export function modelTierKey(k: { modelFileSha: string; vectorContractId: string; ep: ResolvedEp; privateForPid?: number }): string;

/** First frame on EVERY connection (sent from dialBackend's onConnect, F10). Must be answered synchronously. */
export interface TierHello {
  protocol: number; vectorContract: string; modelFileSha: string; ep: ResolvedEp;
  clientVersion: string;       // the client's PACKAGE_VERSION (§4.9): released semver of @adhd/sox-embedding-provider
  clientBuild: string;         // telemetry only (entry size:mtime fingerprint; no bytes read)
  expectRunner: RunnerKind;    // 'onnx' unless a test called __configureModelTierForTests (§4.8, §6)
  clientPid: number; clientLabel: string | null;  // SOX_SERVICE_ID or argv[1] basename — telemetry only
}
export interface TierIdentity {
  protocol: number; vectorContract: string; modelFileSha: string; ep: ResolvedEp; runner: RunnerKind;
  version: string;             // the drainer's own PACKAGE_VERSION (§4.9), never taken from argv
  build: string; pid: number; instanceId: string;
  state: 'serving' | 'draining' | 'retiring';
}
export type HelloDecision =
  | { kind: 'accept'; tier: TierIdentity; supersede: boolean }   // supersede ⇔ isNewerRelease(hello.clientVersion, tier.version)
  | { kind: 'reject'; code: typeof ERR.HANDSHAKE_REJECTED; field: keyof TierHello; tier: TierIdentity }
  | { kind: 'draining'; code: typeof ERR.TIER_DRAINING; tier: TierIdentity };
/** Pure: the whole handshake policy. */
export function decideHello(tier: TierIdentity, hello: TierHello): HelloDecision;

/** Parsed SemVer 2.0.0 version. `null` from parseReleaseVersion ⇔ not a valid semver string. */
export interface ReleaseVersion {
  major: number; minor: number; patch: number;
  prerelease: readonly (string | number)[];   // [] for a normal release; build metadata is discarded
}
/** Pure, zero-dependency SemVer 2.0.0 parser (§2 grammar; no leading zeros; no `v` prefix; no ranges). */
export function parseReleaseVersion(v: string): ReleaseVersion | null;
/** SemVer 2.0.0 §11 precedence: -1 | 0 | 1. Build metadata is ignored (`0.7.0+a` equals `0.7.0`). */
export function compareReleaseVersions(a: ReleaseVersion, b: ReleaseVersion): -1 | 0 | 1;
/**
 * The drain-on-newer ordering. True ⇔ `client` parses AND
 *   (`tier` does not parse  OR  compareReleaseVersions(client, tier) === 1).
 * An unparseable client never supersedes; an unparseable incumbent is superseded by any valid client.
 */
export function isNewerRelease(client: string, tier: string): boolean;

export interface TierEnqueueParams { kind: WireKind; texts: string[]; lane: Lane }
export interface TierDelivery {
  dim: number; count: number;
  vectorsB64: string;            // little-endian Float32Array(count*dim), base64 — ~5x smaller than JSON number[]
  ep: ResolvedEp; queue_ms: number; work_ms: number; batches: number;
}
export const ERR: {
  readonly TIER_RETIRING: -32001;      // existing code, unchanged client mapping → HostGoneError → re-ensure + retry once
  readonly HANDSHAKE_REQUIRED: -32010; // a work frame before an accepted hello
  readonly HANDSHAKE_REJECTED: -32011; // protocol/contract/sha/ep/runner mismatch → PermanentEmbeddingError; NO private fork
  readonly TIER_DRAINING: -32012;      // handoff in progress → client waits for the successor (bounded) and re-sends
  readonly TIER_BUSY: -32013;          // lane queue full → ModelTierBusyError (Transient, retryAfterMs). NEVER -32001.
  readonly WRONG_PARAMS: -32602;
  readonly RUNNER_ERROR: -32603;
};
// Methods: 'model.hello' | 'model.enqueue' | 'model.init' | 'model.drain' | 'model.reset' | 'model.health'
// Pre-handshake allow-list: 'ping' (ensureBackend readiness, F11) and 'model.health' — answered, never counted as work.
```

### 4.4 `src/tierScheduler.ts` (new, pure: no I/O, no timers; clock injected)

```typescript
export interface SchedulerConfig {
  maxBatchPaddedTokens: number;   // default 16_384 (B × Lmax); tuned by the S7 A/B
  maxBatchItems: number;          // default 64
  maxDelayMs: number;             // default 2; validated 0 ≤ x ≤ 5
  laneCapacity: Record<Lane, number>;   // default { interactive: 512, bulk: 8_192 } items
  drrQuantumTokens: number;       // default 512
  bulkStarvationMs: number;       // default 2_000 — a bulk head older than this is served next
}
export interface SchedItem { itemId: number; ticket: number; connId: number; lane: Lane; tokens: number; enqueuedAt: number }
export interface Batch { items: SchedItem[]; lane: Lane | 'mixed'; paddedTokens: number; maxLen: number }
export class TierScheduler {
  constructor(cfg: SchedulerConfig);
  /** All-or-nothing per enqueue: either every item of the ticket is queued or none is. */
  admit(items: SchedItem[]): { ok: true } | { ok: false; lane: Lane; depth: number; retryAfterMs: number };
  /** Drop a closed connection's UNSTARTED items; returns how many. */
  cancelConnection(connId: number): number;
  /** The next batch to run, or how long to wait before one closes, or null when empty. */
  next(now: number): { batch: Batch } | { waitMs: number } | null;
  depth(): Record<Lane, number>;
  readonly size: number;
}
```

Policy:
1. **Lanes.** Interactive is served strictly first, except that a bulk head older than
   `bulkStarvationMs` is served next.
2. **Fairness.** Within a lane, deficit round-robin across `connId`, charged in tokens.
3. **Length buckets.** Buckets are power-of-two token lengths (32, 64, …, 512). A batch is filled from
   the DRR-selected head's bucket first, then from adjacent buckets while
   `count × maxLen ≤ maxBatchPaddedTokens`.
4. **When a batch closes.** It closes at the token budget, at `maxBatchItems`, or when the oldest
   item's age reaches `maxDelayMs`. With `maxDelayMs = 0` and an idle runner, it closes immediately.

### 4.5 `libs/service-proxy/src/backend.ts` (additive, a patch release)

```typescript
// BEFORE
export type BackendHandler = (request: JsonRpcRequest) => Promise<JsonRpcResponse | undefined> | JsonRpcResponse | undefined;
// AFTER
export interface BackendConnectionContext {
  readonly id: number;                     // monotonic per serveBackend
  readonly openedAt: number;
  readonly state: Map<string, unknown>;    // handler-owned per-connection scratch
  onClose(cb: () => void): void;           // fired once, after the socket closes (client death or server close)
}
export type BackendHandler = (request: JsonRpcRequest, conn: BackendConnectionContext) => Promise<JsonRpcResponse | undefined> | JsonRpcResponse | undefined;
export interface ServeBackendOptions { /* … unchanged … */
  /** Stop accepting connections and unlink the socket (inode-guarded) but KEEP existing connections open. */
}
export interface BackendHandle { socketPath: string; close(): Promise<void>;
  /**
   * NEW: close the listener only (drain-on-newer handoff). Existing sockets keep being served.
   * Resolves AS SOON AS the listener has stopped accepting and the socket path no longer answers —
   * NOT on `server.close()`'s callback, which fires only after every socket closes (backend.ts:237-241)
   * and would therefore wait for the superseder's own connection, deadlocking the handoff. The
   * inode-guarded unlink (unlinkIfStillOurs) is performed immediately after stop-accepting; the
   * later close callback only re-checks it.
   */
  stopAccepting(): Promise<void>;
}
```
Existing handlers ignore the second parameter, so no call site changes. Frames are still dispatched in
arrival order. The drainer's hello handling is synchronous, with no `await` before it writes
`conn.state`, and that alone gives in-order gating. S2 tests this invariant.

### 4.6 `libs/service-proxy/src/ensure-backend.ts` (additive, a patch release)

```typescript
// AFTER — new optional field; new disposition value
export interface EnsureBackendOptions { /* … unchanged … */
  /**
   * Replace a LIVE incumbent under the O_EXCL spawn lock (drain-on-newer). When set, ensureBackend
   * acquires the lock FIRST; if the socket is live it calls requestHandoff(), waits until the socket
   * path stops answering (the incumbent's listener closed — its queue keeps draining on existing
   * connections), then spawns and waits ready, and only then releases the lock. A caller that fails
   * to take the lock behaves exactly as today (waits for live, 'adopted-after-wait').
   */
  supersede?: { requestHandoff(): Promise<void>; vacancyTimeoutMs: number };
}
export type EnsureBackendDisposition = 'already-live' | 'spawned' | 'adopted-after-wait' | 'superseded' | 'failed';
```
Constraint: `vacancyTimeoutMs + readyTimeoutMs < lockTtlMs`. The defaults are 5 s + 10 s < 30 s.

### 4.7 `src/modelTierClient.ts` (replaces `funnelClient.ts`)

```typescript
export class ModelTierBusyError extends TransientEmbeddingError {}      // from -32013, carries retryAfterMs
export class ModelTierRejectedError extends PermanentEmbeddingError {    // from -32011
  readonly field: keyof TierHello; readonly tier: TierIdentity;
}
export class ModelTierClient implements SharedFastembedClient {
  // SharedFastembedClient surface unchanged: request(payload, timeoutMs?, signal?), terminate(), started, warm, pendingCount.
  // Payload mapping (FastembedProvider is NOT touched beyond lane/EP):
  //   {type:'init', model, cacheDir}      → ensure + hello + 'model.init'   → {initOk:true, dim, execution_provider}
  //   {type:'embed', text}                → 'model.enqueue' {kind:'embed', texts:[text], lane:'interactive'} → {embedding}
  //   {type:'embedBatch', texts}          → 'model.enqueue' {kind:'embedBatch', texts, lane:'bulk'}           → {embeddings}
  readonly tierIdentity: TierIdentity | null;
}
```

### 4.8 `src/modelTierConfig.ts` (from `embedHostConfig.ts`)

Kept, renamed only: `buildEmbedHostEnv` → `buildModelTierEnv` (the ADR-0022 §5 allow/deny lists,
byte-identical), `encode/parseEmbedHostArgs` → `encode/parseModelTierArgs`, the typed `host` and
`idleGraceMs` overrides, and `DEFAULT_EMBED_HOST_IDLE_GRACE_MS` → `DEFAULT_MODEL_TIER_IDLE_MS = 120_000`.

The argv flags change:
- removed: `--build-id`;
- added: `--model-sha`, `--contract`, `--ep` (now the resolved EP).

The drainer's version is **not** an argv flag. A drainer reports the `PACKAGE_VERSION` compiled into
its own artifact (§4.9), so a spawner cannot make old code claim to be new.

Deleted: `computeEmbedHostBuildId`, `invalidateEmbedHostBuildId` and the fingerprint memo (the build id
leaves the key); `resolveEmbedHostSocketDir` (replaced by `resolveModelTierSocketDir()`, which uses
the machine-wide directory from §2.2).

**The test seam is a typed, test-only setter, not an env var.** ADR-0013 D1 bans a presence-gated
switch, and "send `expectRunner:'stub'` when an env var is set" is exactly that. The setter follows
the existing `__reset*ForTests` convention:

```typescript
/** TEST-ONLY. Points this process's client at a non-default drainer. Never called by production code. */
export function __configureModelTierForTests(o: {
  entry: string; socketDir: string; expectRunner: RunnerKind;
  /** Overrides the version this client sends in hello (default PACKAGE_VERSION). Used by M6. */
  clientVersion?: string;
} | null): void;
```

The stub drainer (`test-support/stubTierMain.ts`, §6) takes its reported version from the same
harness: `tierHarness.ts` spawns it with `--stub-version=<semver>`, a flag that **only
`stubTierMain.ts` parses**. `parseModelTierArgs` rejects `--stub-version` (exit 4), so the production
entry can never be given a version from outside its artifact. The stub's default is its compiled
`PACKAGE_VERSION`.

`SOX_EMBED_HOST_MAIN` is deleted, and no `SOX_EMBED_TIER_*` env var is introduced. The spawn env's
deny prefix `SOX_EMBED_HOST_*` becomes `SOX_EMBED_TIER_*`, which is defensive only.

**Sidecar references must use the literal form** `join(__dirname, 'modelTierMain.js')` and
`join(__dirname, 'runnerWorker.js')`, because that is the shape `verifySidecarReferences` scans for
(BL-259; `embedHostConfig.ts:552-555`). A reference built through a variable passes the bundle build
and then fails at runtime inside memory-server.

### 4.9 `src/packageVersion.generated.ts` (generated at build time; gitignored)

```typescript
// GENERATED by tools/stamp-package-version.mjs from libs/data/embed/embedding-provider/package.json.
// Do not edit and do not commit (see the package .gitignore). Regenerated by `nx run embedding-provider:stamp-version`.
export const PACKAGE_VERSION: string = '0.7.0';
```

The value is always the package's own `package.json` `version`. That field moves only through
Changesets in the release flow (PUBLISHING.md; CLAUDE.md "never hand-bump a version field"), so a
build's `PACKAGE_VERSION` is the version of the release its tree was cut from, or of the release
being prepared once `changeset version` has run.

**Why a generated source module and not a bundler hook.** The package runs in three compiled forms,
and only a TS source constant reaches all of them:

| Form | Compiler | Reads |
|---|---|---|
| Published npm tarball (adhd), and workspace consumers at runtime | `@adhd/sox-nx:atomic-tsc` (`project.json` `build`) | `dist/*.js` compiled from `src/` |
| memory-server main bundle | esbuild via `tools/bundle-extension.cjs`, resolving the package through `node_modules` to its `dist/index.js` | the tsc `dist/` above |
| memory-server sidecars `modelTierMain.js`, `runnerWorker.js` | esbuild via `bundle-extension.cjs` `discoverSidecars` (`tools/bundle-extension.cjs:216-233`), which resolves `sox.sidecars` against the **source** package root and skips `dist/` (`:199-203`) | `src/*.ts` directly |

- An esbuild `define` in `bundle-extension.cjs` would stamp the **consumer's** build, and the npm
  tarball never passes through that script.
- An atomic-tsc transformer would stamp only the tsc form; the drainer sidecar is compiled by esbuild
  from source and would miss it.
- A runtime `createRequire('../package.json')` resolves against the bundle file inside memory-server
  and reads the wrong package (the BL-313 class of path-relative asset bug).

The generated module sits in `src/`, so tsc compiles it into `dist/packageVersion.generated.js`, and
esbuild inlines it into both the main bundle (through `dist/`) and the sidecars (through `src/`). No
change to `tools/bundle-extension.cjs` or to the atomic-tsc executor is needed.

**The injection step** (`project.json`):

```jsonc
// AFTER (additions only)
"stamp-version": {
  "executor": "nx:run-commands",
  "options": {
    "command": "node tools/stamp-package-version.mjs --package libs/data/embed/embedding-provider --out libs/data/embed/embedding-provider/src/packageVersion.generated.ts",
    "cwd": "."
  },
  "cache": true,
  "inputs": ["{projectRoot}/package.json", "{workspaceRoot}/tools/stamp-package-version.mjs"],
  "outputs": ["{projectRoot}/src/packageVersion.generated.ts"]
},
"build":     { "dependsOn": ["^build", "stamp-version"], "inputs": ["{projectRoot}/src/**/*.ts", "{projectRoot}/tsconfig.lib.json", "{projectRoot}/package.json"], /* rest unchanged */ },
"typecheck": { "dependsOn": ["stamp-version"], /* rest unchanged */ },
"lint":      { "dependsOn": ["stamp-version"], /* rest unchanged */ }
```

A project-level `dependsOn` replaces the `nx.json` `targetDefaults` value instead of merging with it.
`targetDefaults.build.dependsOn` is `["^build"]`, so `build` spells out the union; `typecheck` has no
default and `lint`'s is `null`, so theirs is `stamp-version` alone. `test` keeps its explicit
`["^build", "build"]`.

`test` already depends on `build`, so the file exists before any compile, typecheck, lint or vitest
run in this package. Consumers never read it: `tsconfig.base.json` has no path mapping for
`@adhd/sox-embedding-provider`, so memory-core and the bundlers resolve the package through
`node_modules` to its tsc `dist/` (`dist/packageVersion.generated.{js,d.ts}`). `package.json` is an
explicit `build` input, so a Changesets bump is a cache miss and never serves a `dist/` stamped with
the previous version.

**`tools/stamp-package-version.mjs`** (generic, zero dependencies):

```
node tools/stamp-package-version.mjs --package <projectRoot> --out <file.ts>
```

- Reads `<projectRoot>/package.json` `version`. If it is missing or is not valid SemVer 2.0.0, it
  exits 1 naming the file and the value. A build never ships an unversioned constant.
- Writes the module above atomically (temp file plus rename in the same directory), and only when the
  bytes differ, so an unchanged version does not touch the file's mtime.
- Prints `stamp-package-version: <name>@<version> → <out>`.

---

## 5. Behavioral changes

### 5.1 Drainer lifecycle (`modelTierServer.ts`)

- **Start.**
  1. Parse argv.
  2. Refuse to start (exit 4) if the argv socket dir is not the resolved one. The stub drainer also
     refuses the machine-wide directory (§6).
  3. Write `<socketDir>/tiers/<pid>.json` = `{key, pid, startedAt, version, runner}`. This
     concurrency registry is read by telemetry and removed at exit.
  4. `serveBackend(...)`.
  5. Start the runner worker and load the model **eagerly**. The load counts as work (ADR-0022 §1).
     Load has three steps:
     - verify the sha (stamp file `<onnx>.sox-sha256.json` = `{sha256, size, mtimeMs, ino}`; rehash
       only on a stat change);
     - create the session;
     - run one warm batch.
- **Handshake gate.**
  - Any frame other than `ping` or `model.health` on a connection without an accepted hello gets
    `-32010`.
  - `model.hello` is decided synchronously by `decideHello`, and `accept` stores `conn.state.hello`.
  - `reject` answers `-32011` with `{field, tier}`.
  - `draining` answers `-32012`.
- **Enqueue.** Validate the params, apply `applyPrefix` per item, and tokenise on the main thread, so
  token counts are exact. Then `scheduler.admit` either queues all items or answers `-32013` with
  `retryAfterMs`. The response promise resolves when every item's vector is back, and results are
  re-assembled in input order.
- **Run loop.**
  - `scheduler.next(now)` produces a batch, which goes to the worker as `BigInt64Array`
    ids/mask/type_ids padded to batch-longest.
  - Only **one batch is in flight**, because there is one ORT session. Lane priority therefore takes
    effect only at **batch boundaries**. An interactive item can wait out one running bulk batch, so
    interactive queue-wait p99 is bounded by one bulk batch's `work_ms`. S7 sizes
    `maxBatchPaddedTokens` from measured bulk `work_ms` so that bound stays under the interactive
    latency target, which is ≤ 250 ms on the chosen EP. The target is recorded with the A/B result.
  - A JS-level run error **bisects** the batch to isolate the failing item(s). Only those get
    `-32603`; the rest are delivered.
  - A `model_tier.batch.start` event, carrying item token counts and connIds, is logged **before** the
    run, so a native crash can be attributed.
- **Client death.** `conn.onClose` calls `scheduler.cancelConnection(connId)`. Items already in the
  running batch complete, and their results are discarded.
- **Retire (ADR-0022 §1/§2, kept).**
  - `reapDueInMs({state, inFlightBatches, queued: scheduler.size, lastWorkAt, now, idleWindowMs})`
    returns `null` unless the queue is empty and no batch is in flight.
  - The retire decision runs in one tick: flip to `retiring`, then `handle.close()` (inode-guarded
    unlink). Then the **ORT-safe teardown** below. Then remove the registry entry and exit 0.
- **ORT-safe teardown (BL-426 carried forward). This is mandatory for retire, `model.reset` and
  signals.**
  - The session now lives inside the drainer, not in a disposable child.
    `fastembedProcessHost.ts:554-583` records that an abrupt exit with a live `InferenceSession`
    aborts with `libc++abi … mutex lock failed` (SIGABRT). That happened on both cpu and coreml, even
    after `init` alone.
  - The order is:
    1. The main thread sends `dispose` to the worker.
    2. The worker calls `session.release()` and lets its event loop empty. It **exits by itself**:
       it calls `parentPort.close()` and never `process.exit`.
    3. The main thread awaits the worker's `exit` event, bounded at 10 s. On timeout it logs
       `model_tier.teardown_timeout`.
    4. Only then does the main thread call `process.exit(0)`.
  - **Never `worker.terminate()` a worker holding a live session.** `model.reset` uses the same order
    before it starts a fresh worker.
  - Handshakes, health probes, `ping`, resets and connections are **not** work.
- **`model.reset`** (the heal path from memory-core): terminate and respawn the runner worker, then
  reload the model. The queue is kept, and in-flight items are re-queued at the head. A reset is not
  work.
- **`model.init`** awaits the model load and returns `{dim, execution_provider}`. It is work.
- **Env scrub** (ADR-0022 §5) is unchanged apart from the renamed deny prefix. Provenance travels as
  `--flag=value` argv.

### 5.2 Drain-on-newer (`model.drain`, `ensureBackend.supersede`)

1. A client's hello is accepted with `supersede: true` exactly when
   `isNewerRelease(hello.clientVersion, tier.version)` (§4.3). Both values are `PACKAGE_VERSION`
   strings compiled into each side's artifact (§4.9). The ordering is SemVer 2.0.0 §11 precedence:

   | Client version | Drainer version | Supersede | Why |
   |---|---|---|---|
   | `0.7.1` | `0.7.0` | yes | strictly newer release |
   | `0.7.0` | `0.7.0` | **no** | equal never supersedes, which rules out ping-pong |
   | `0.7.0+abc` | `0.7.0` | **no** | build metadata is ignored, so these are equal |
   | `0.7.0` | `0.7.1` | **no** | older never supersedes; the client adopts the newer drainer (§5.2 step 4) |
   | `0.8.0-next.1` | `0.7.0` | yes | a Changesets prerelease is a published release and orders by precedence |
   | `0.8.0-next.1` | `0.8.0` | **no** | a prerelease precedes its release |
   | `0.8.0-next.2` | `0.8.0-next.1` | yes | prerelease identifiers compare per §11.4 |
   | unparseable or empty | anything | **no** | a dev or unversioned client can never drain a released drainer |
   | `0.7.0` | unparseable or empty | yes | a valid release replaces an unversioned incumbent |

   **Unreleased code never drains production.** A worktree's `package.json` `version` is the one
   Changesets last wrote, so its build stamps the same version as the release it branched from (or an
   older one if it is behind), and "equal never supersedes" applies. No build can stamp an
   unparseable version (`stamp-package-version.mjs` fails the build), so the unparseable rows exist
   only for foreign or corrupted peers and for the M6 test seam.
2. The client calls `ensureBackend({..., supersede: { requestHandoff: () => send('model.drain', {byVersion: PACKAGE_VERSION}),
   vacancyTimeoutMs: 5_000 }})`.
3. The incumbent's `model.drain`:
   - sets `state='draining'`;
   - calls `handle.stopAccepting()`, which unlinks the path inode-guarded and keeps the existing
     sockets;
   - answers the drain.
   From then on, a new `model.enqueue` on an existing connection gets `-32012`, and that client
   re-ensures and reaches the successor. **Every item already queued is finished and delivered.** When
   the queue is empty and no batch is in flight, the incumbent retires at once, without waiting `W`.
4. While the lock is held, older clients that find the path dead fail to take the lock and wait, then
   adopt the successor. Older clients may talk to a newer drainer, because the protocol and contract
   are equal by key. **No old code is respawned during a handoff.**
5. **Handoff overlap.** Two model processes coexist for exactly the incumbent's drain tail. This is
   reported as `model_tier.handoff {overlap_ms, items_finished}`. The metric "concurrent tiers" counts
   **admitting** drainers per key, and that must be 1. Two models coexist briefly when a newer release
   arrives (O3).
6. **Equal-version adoption.** Because equal versions never supersede, whichever build of a version
   spawns first serves every client of that version and older until it retires `W` after its last
   work. A worktree client that finds no live drainer spawns its own build as the machine-wide
   drainer, and production clients of the same version adopt it. That is the accepted cost of O4; the
   `test-e2e` lane (which uses the machine-wide drainer, §6) reaches it on purpose. The drainer's
   `build` fingerprint is logged on `model_tier.spawned` and `model_tier.hello`, so the report can
   attribute which build served which client.

### 5.3 Client (`modelTierClient.ts`)

- **`doEnsure`**:
  1. Resolve the model config and its pinned sha.
  2. Resolve the EP from typed config, or from `DEFAULT_EP[process.platform]` (§9.4).
  3. Compute the key and the socket.
  4. `ensureBackend` (the spawn uses the scrubbed env and argv).
  5. `dialBackend` with `onConnect: () => this.sendHello()`. Because `onConnect` runs before
     `flushQueue` (F10), the hello always precedes replays. The hello's `clientVersion` is
     `PACKAGE_VERSION` (§4.9), or the `clientVersion` override from `__configureModelTierForTests`.
- **Error mapping**:

  | Code | Client behaviour |
  |---|---|
  | -32001 | `HostGoneError` → re-ensure and retry once, inside the caller's deadline (unchanged) |
  | -32010 | send the hello again, then retry once. A repeat is a `PermanentEmbeddingError`. |
  | -32011 | `ModelTierRejectedError`. **Never** a private fork (ADR-0020 D5). |
  | -32012 | wait for the successor (probe and hello with backoff 50→800 ms) within `HOST_READY_TIMEOUT_MS × 2`, then re-send |
  | -32013 | `ModelTierBusyError(retryAfterMs)` |
  | -32602 | `PermanentEmbeddingError` |
  | -32603 | plain `Error(message)`, preserving `FastembedProvider.initModel` retry semantics |

- **Retry once after a pre-ready signal death** (F11) is kept verbatim. Circuit breaker: 3 failures
  open it for 10 s (kept).
- **`terminate()`**:
  - `'shared'`: a no-op (ADR-0020 D5).
  - `'private'`: sends `model.drain`, with no successor.

### 5.4 Model acquisition (`modelAcquire.ts`)

This replaces fastembed's `retrieveModel`, which is dropped along with fastembed.
- It runs **inside the drainer only** (ADR-0022 §3: the host owns init).
- On a cache miss:
  1. Take an O_EXCL lock `<cacheDir>/.<hfRepoId>.acquire.lock`.
  2. Stream `archive.url`
     (`https://storage.googleapis.com/qdrant-fastembed/<hfRepoId>.tar.gz`, the same source as
     `fastembed.js:138`) to a temp file.
  3. Extract it into `<cacheDir>/.<hfRepoId>.tmp-<pid>/`.
  4. **Verify `onnxFile` against the pinned sha before** `rename` into place.
- A model with `archive: null` (bge-m3, codexembed-400m) or `onnxSha256: null` fails loud, naming the
  expected path. That is no regression: fastembed 2.1.0 cannot fetch those models either.
- The cold budget is unchanged: `warmupTimeoutMs(false)`.

### 5.5 Deleted behaviour (with its env knobs, per ADR-0013)

- **Modules:** the per-build host (`embedHostMain.ts`), the forked ONNX child
  (`fastembedProcessHost.ts`), the adaptive and fixed pools, and `FastembedBusyError`. The advisory
  lock `fastembedLock.ts` goes too: the tier concurrency registry and the `peak concurrent tiers`
  metric replace its observability role.
- **Env knobs:** `SOX_EMBED_EXECUTION_PROVIDER`, `SOX_EMBED_POOL_SIZE`,
  `SOX_EMBED_POOL_ADMISSION_LIMIT`, `SOX_FASTEMBED_POOL_GROUP`, `SOX_FASTEMBED_SERVICE`,
  `SOX_FASTEMBED_HOST_PATH` and `SOX_EMBED_HOST_MAIN`.
- `onnxStderrFilter.ts` stays only if the runner worker's stderr needs it. Decide that by `rg` in S5,
  and delete it if it is unreferenced.

---

## 6. Test strategy: stub by default, real model in an explicit e2e lane

- **Default `nx test embedding-provider`** loads no model and needs no `onnxruntime-node`.
  - The pure modules (contract, protocol, scheduler, config) are unit-tested directly.
  - The lifecycle specs run the **real `modelTierServer.ts`** through
    `test-support/stubTierMain.ts`. The harness selects it with the typed test-only setter
    `__configureModelTierForTests({entry, socketDir: <per-test tmp>, expectRunner: 'stub'})` (§4.8),
    and `null` resets it. No env var is involved.
  - `stubRunner.ts` returns deterministic unit vectors: a sha256-seeded PRNG over the **prefixed**
    text. The prefix rule can therefore be asserted without a model, because
    `embed('x') ≠ embedBatch(['x'])`.
  - The stub drainer reports `runner:'stub'` and exits 4 if its socket dir is the machine-wide
    default.
  - The client sends `expectRunner:'stub'` only after that setter is called, and a mismatch is
    `-32011`. Together with the stub drainer's refusal of the machine-wide directory, that makes two
    independent locks keeping stub vectors out of production.
- **New `test-e2e` target** (`vitest.e2e.config.ts`, `src/**/*.e2e.ts`). It holds the real model, the
  vector-compat gate and the real-drainer lifecycle, and it uses the **machine-wide drainer** (the
  owner requirement: tests share the one model process).
  - It is **not** in `test.dependsOn`. It is made reachable through the PUBLISHING.md dry-run list
    (S9) and the S8 smoke, which keeps it out of the dead-config class seen in adhd 98142eab.
- **Consumers:** memory-core and memory-server tests keep `_setEmbedProviderForTest()`, and adhd keeps
  `fake-embedding-provider.ts`. Their real-model suites (adhd `*.e2e.ts`) now share the machine
  drainer instead of spawning per-build hosts.

---

## 7. Handshake and queue failure matrix

| # | Scenario | Drainer behaviour | Client behaviour | Queued work outcome | Test (red→green) |
|---|---|---|---|---|---|
| M1 | Drainer dies **mid-batch** (SIGKILL/OOM) | — (the `batch.start` event already names the item token counts and connIds) | The dial requeues unanswered enqueues. `onDisconnect` with `_sent>0` re-ensures and spawns a successor. `onConnect` sends the hello first, then the replay. | Every connected consumer's items are re-embedded by the successor, bounded by the dial give-up (10 s) plus one client retry. Items of already-exited consumers are recovered through §2.1.2. | `BL-TIER-M1-drainer-sigkill-mid-batch.spec.ts` (stub runner with `delayMs`; kill -9 the drainer; assert all 3 clients get vectors identical to a clean run) |
| M2 | Drainer dies **before ready** (signal) | — | `ensureBackend` returns `failed (signal SIGKILL)` → `HostGoneError` → **exactly one** fresh ensure (F11). | The request is served by the second spawn. A second death surfaces a typed error. | Port `2fadb3cd-inflight-survives-host-death.spec.ts` |
| M3 | **Client dies** mid-request | `conn.onClose` → `cancelConnection` drops its unstarted items. Its in-batch items complete and are discarded. Other clients are unaffected. | — | That consumer's durable store record (F8) re-enqueues later. | `BL-TIER-M3-client-death-cancels.spec.ts` (assert `scheduler.size` drops, other client delivered, `model_tier.cancelled{items}`) |
| M4 | **Drain in progress plus a new client** | The listener is closed and the path unlinked. A new connection cannot reach the incumbent. A new enqueue on an old connection gets `-32012`. | A new client's `ensureBackend` finds the path dead and the lock held (by the superseder), so it waits and adopts the successor. An old-connection client on `-32012` waits for the successor, then re-sends. | The incumbent finishes 100% of its queued items. New items land on the successor. No item is admitted by both. | `BL-TIER-M4-drain-plus-new-client.spec.ts` (queue 200 bulk items on v1; v2 client supersedes; v1 client enqueues during drain; assert v1's 200 delivered by the incumbent pid and the new enqueue by the successor pid) |
| M5 | **Stale drainer, old protocol** | A protocol bump changes the key and so the socket: a v3 client never dials a v2 socket. Old per-build `embedding-host:v2:*` hosts retire on their own `W`. | — | — | `BL-TIER-M5-protocol-in-key.spec.ts` (keys differ across protocol) + a defence-in-depth `decideHello` unit (protocol mismatch → reject `field:'protocol'`) |
| M6 | Stale drainer, **same protocol, older released version** | Hello accepted with `supersede:true` → M4 path | `ensureBackend({supersede})` | Handoff with the queue finished | `BL-TIER-M6-drain-on-newer.spec.ts` (stub drainer spawned with `--stub-version=0.7.0`; client A with `clientVersion:'0.7.1'` supersedes: assert `disposition:'superseded'`, exactly one admitting drainer afterwards, no respawn of 0.7.0. Negative cases on a fresh 0.7.0 drainer: clients with `'0.7.0'`, `'0.7.0+wt'`, `'0.6.9'` and `''` each get `supersede:false` and the incumbent pid is unchanged) |
| M7 | **Contract / sha / EP / runner mismatch** on hello | `-32011 {field, tier}` | `ModelTierRejectedError`; **no** private fork | — | `decideHello` table test, one row per field |
| M8 | A frame **before** hello | `-32010` (`ping` and `model.health` still answered: readiness F11) | Send the hello again, retry once | — | `BL-TIER-M8-handshake-gate.spec.ts` (includes: `ensureBackend` readiness passes without a hello) |
| M9 | Enqueue races the retire flip | `-32001 TIER_RETIRING` (the flip and close happen in one tick) | re-ensure, re-send once | Never accepted and dropped | Port `68a4bf68-reap-on-work.spec.ts` + a race case |
| M10 | Queue full | `-32013 {retryAfterMs}` | `ModelTierBusyError`; **no** re-ensure | Nothing admitted (all-or-nothing per enqueue) | scheduler unit + `BL-TIER-M10-busy-not-host-gone.spec.ts` (assert no spawn attempt) |
| M11 | A runner JS error on one item | Bisect; only the failing item gets `-32603` | `Error(message)` for that request only | Co-batched items from other clients are delivered | `BL-TIER-M11-bisect.spec.ts` (stub runner throws on one marker text) |
| M12 | A replayed enqueue after a drainer death, with a draining successor | `-32012` on the successor | Wait for that successor's successor, bounded | Finished by whichever drainer admits it | covered by M1 + M4 fixtures composed |

---

## 8. Independent segments

**Parallel groups** (the file sets within a group are disjoint):

| Group | Segments | Precondition |
|---|---|---|
| G0 | S0 | owner approval of ADR-0023 (the text is in §11) |
| G1 | S1, S2, S3, S11 | G0 approved |
| G2 | S4 | S1, S2, S3, S11 |
| G3 | S5 | S4 |
| G4 | S6, S7, S8 | S5 |
| G5 | S9 (release: a human runs the publish step) | G4 green, S1 gate green |
| G6 | S10 (adhd) | S9 published |

| Id | Title | Files | Group | Tier | Risk |
|---|---|---|---|---|---|
| S0 | ADR-0023 + Status lines | docs/decisions/0023-…, 0020, 0022 | G0 | haiku | LOW |
| S1 | Vector contract, manifest pins, model acquisition, ONNX runner, **compat gate** | vectorContract.ts, fastembedModels.ts, modelAcquire.ts, onnxRunner.ts, runnerWorker.ts, vector-compat.e2e.ts, package.json (deps) | G1 | opus | **HIGH** (vector validity) |
| S2 | service-proxy: connection context, `stopAccepting`, `ensureBackend.supersede` | libs/service-proxy/src/{backend.ts, ensure-backend.ts, index.ts}, 2 new specs, changeset | G1 | opus | MED (shared by the memory-server shim) |
| S3 | Protocol, key, semver ordering, scheduler (pure) | modelTierProtocol.ts, tierScheduler.ts, their specs | G1 | opus | MED |
| S4 | Drainer server, prod main, stub main and runner | modelTierServer.ts, modelTierMain.ts, modelTierConfig.ts, test-support/{stubTierMain,stubRunner,tierHarness}.ts, M1-M12 specs | G2 | opus | **HIGH** |
| S5 | Client, accessor, provider wiring, deletions, spec port | modelTierClient.ts, sharedFastembedProcess.ts, fastembed.ts, index.ts, deleted modules and their specs, package.json `sox.sidecars` | G3 | opus | **HIGH** |
| S6 | Test lanes | project.json (`test-e2e`), vitest.config.ts, vitest.e2e.config.ts, `*.e2e.ts` moves, tier-real-model.e2e.ts | G4 | sonnet | LOW |
| S7 | Telemetry report, EP A/B harness (BL-331), W re-derivation | tools/embedding-tier-report.mjs, tools/embedding-ep-ab.mjs | G4 | sonnet | LOW |
| S8 | sox consumers and docs: memory-server natives and externals, memory-core dep, CLAUDE.md BL-11, smoke | memory-server/{package.json,project.json}, memory-core/package.json, libs/data/CLAUDE.md, embedding-provider/{CLAUDE,AGENTS,README}.md | G4 | sonnet | MED (bundle, live service) |
| S9 | Release | .changeset/*.md, PUBLISHING.md (e2e lane line, post-version rebuild + stamp assertion) | G5 | sonnet + human | MED (irreversible publish) |
| S10 | adhd consumption and live cutover verification | adhd entrypoint/backlog/package.json, pnpm-lock.yaml, embed-funnel e2e + helper | G6 | sonnet | MED |
| S11 | Build-time version injection (`PACKAGE_VERSION`) | tools/stamp-package-version.mjs, tools/test-bl-tier-s11-version-stamp.mjs, tools/guards-manifest.mjs, embedding-provider/{project.json, .gitignore, src/packageVersion.spec.ts} | G1 | sonnet | MED (every drain-on-newer decision reads it) |

**Common rules for every segment:**
- Build and test only through nx targets (`npx nx build|test|lint|typecheck <project>`), and quote
  `node tools/check-suite-tree-state.mjs --project <p>` with each result.
- Commit by pathspec.
- Never write `registry/index.json` (ADR-0021).
- No empty catch blocks; log through `@adhd/sox-telemetry`.
- A segment is DONE only with each named test having been **seen red with the fix disabled and green
  with it restored** (BL-225).
- The machine was at load 128 when this spec was written. Run heavy suites in an isolated worktree,
  and do not run a real-model e2e when the load average is above 16.

### S0 — ADR-0023 (G0, haiku, LOW)
1. Only after the owner approves: create `docs/decisions/0023-embedding-model-tier-is-a-machine-wide-singleton.md`
   with §11.1 verbatim.
2. Replace the **Status** line of ADR-0020 with the §11.2 text, and that of ADR-0022 with the §11.3
   text. Do not touch their bodies.
3. Commit the three paths by pathspec.

**Done:** the three files match §11; `git show --stat` lists exactly those three.

### S1 — Runner and vector-compat gate (G1, opus, HIGH)
**Required context:**
- `fastembed.js:57-127` and `:195-265` (init, tokenizer, embed);
- `fastembedProcessHost.ts:277-346` (the EP list, `loadModel`, `collectEmbeddings`);
- `fastembedModels.ts` (whole file, 104 lines);
- `src/fastembed.ts:131-173`.

Do NOT read the pool code.

1. `vectorContract.ts` exactly as in §4.1. `poolClsL2` must reproduce `fastembed.js:33-45` (the
   `getEmbeddings` slice `[i*L*D, i*L*D + D)`, then `normalize`).
2. `fastembedModels.ts`: add `onnxFile`, `onnxSha256` and `archive` for `bge-small-en-v1.5`,
   `bge-base-en-v1.5` and `multilingual-e5-large`.
   - Compute the pins with `shasum -a 256 ~/.cache/sox/models/<hfRepoId>/model_optimized.onnx` for
     each model present on disk.
   - A model not on disk keeps `onnxSha256: null` and is loud-unservable until someone pins it.
   - Set `archive: null` for bge-m3 and codexembed-400m.
3. `onnxRunner.ts`:
   - Create it with `createOnnxRunner({modelDir, onnxFile, ep, maxLength})`.
   - Resolve `onnxruntime-node` and `@anush008/tokenizers` through a **non-literal lazy import**
     (ADR-0019 D2/D3).
   - Port the tokenizer setup from `fastembed.js:84-127` **except `setPadding`** (the runner pads to
     batch-longest itself).
   - Use `executionProviders: [ep, 'cpu']` and `graphOptimizationLevel: 'all'`.
   - Feed `token_type_ids`, except for multilingual-e5-large (`fastembed.js:229-231`).
   - API:
     - `tokenize(texts) → {ids: Int32Array[], lens}` (runs on the drainer's main thread);
     - `run(batch: {ids, mask, typeIds: BigInt64Array; B; L}) → Float32Array[]` (runs in the worker).
4. `runnerWorker.ts`: exactly one `worker_threads.Worker` per drainer hosts the session. Messages are
   `load`, `run` and `dispose`. Tensors cross as transferables.
5. `modelAcquire.ts` per §5.4.
6. `package.json`:
   - `onnxruntime-node`: pin **exactly** the version `@huggingface/transformers` resolves (1.24.3 in
     the current lock), so the tree carries one ORT. If the compat gate fails on 1.24.3, pin 1.21.0.
     The gate decides.
   - Add `@anush008/tokenizers` `0.0.0` (fastembed's resolved version) and `tar ^7`.
   - Move `fastembed` to **devDependencies**; it is the gate's oracle only.
   - Run `pnpm install` and commit `pnpm-lock.yaml` in the same change.
7. **Gate `src/vector-compat.e2e.ts` (`BL-TIER-S1-vector-compat`):**
   - **Corpus:** 500 committed deterministic texts in `src/test-support/compat-corpus.json`, covering
     lengths 1–6,000 characters: ≥ 60 over 2,048 characters (which hit the chunk path), ≥ 40 in mixed
     batch slices, plus unicode, code and whitespace-only.
   - **Oracle:** a `SharedFastembedClient` backed directly by fastembed in a child process (ORT
     1.21.0). `embed` maps to `queryEmbed`, and `embedBatch` maps to `embed(texts, 256)`.
   - **Candidate:** a `ModelTierClient` against the real drainer (after S5; until then, the S1 runner
     called directly through the same prefix and pool functions).
   - **Driver:** the same `FastembedProvider` code with each client injected (`fastembed.ts:80`
     accepts `sharedClient`). Routing is therefore compared end-to-end.
   - **Paths:**
     - (a) 500 `embedSingle`;
     - (b) `embedBatch` in slices of 256;
     - (c) (b) from **4 concurrent clients** with shuffled lengths, so real coalescing and bucketing
       are exercised;
     - (d) long texts (chunk and mean-pool).
   - **Pass criteria:**
     - per-item cosine ≥ 0.999 for **every** item on every path (min, not mean);
     - `input_ids` of the new tokenizer, truncated to real tokens, **exactly equal** to fastembed's
       for all 500;
     - both sides on the same resolved EP, which is the EP that produced the stored vectors. On this
       machine that is `coreml` today (confirm C2).
   - **Informational, not a blocker:** recall@10 overlap on the corpus.
8. Informational script `tools/embedding-compat-stored.mjs`:
   - Open `~/.memory/memory.db` **read-only**, sample 200 nodes that have vectors, and re-embed their
     stored text through the path memory-core used (`embedSingle`).
   - Report the cosine distribution against the stored vectors. This checks the assumption behind the
     prefix.

**Done (S1 is partial by construction):**
- Paths (a), (b) and (d), plus token-id equality, are green on the default EP, with their numbers in
  the commit message. The candidate here is the S1 runner called directly through `applyPrefix` and
  `poolClsL2`.
- Path (c), the coalesced 4-client run, **cannot** run before the drainer exists. It is owned by S5's
  done-state, and S1 must not claim it.
- `nx typecheck embedding-provider` is green.
- `pnpm why onnxruntime-node` shows exactly one version among embedding-provider's production deps.

### S2 — service-proxy additive changes (G1, opus, MED)
**Required context:** `backend.ts:1-219` and `ensure-backend.ts:190-476`.
1. `BackendConnectionContext` per §4.5.
   - Allocate `conn` in `net.createServer`'s callback.
   - Pass it to `opts.handler(req, conn)`.
   - Fire the `onClose` callbacks after `sockets.delete`, each in its own `try`, logged through `diag`.
2. `BackendHandle.stopAccepting()`:
   - Call `server.close()` without destroying `sockets`, then run `unlinkIfStillOurs` (the inode
     guard, `backend.ts:286`).
   - Do **not** call `onClientCountChange(0)`.
   - A later `close()` destroys the remaining sockets and is idempotent.
   - Apply the same to the inherited-fd path, with no unlink.
3. `ensureBackend` `supersede` per §4.6, plus the `'superseded'` disposition.
   - Take the lock before probing when `supersede` is set.
   - Release it in `finally`.
4. Changeset `@adhd/sox-service-proxy: patch`: additive only, under the PUBLISHING.md
   "patch-for-additive" exception.

**Tests (red→green):**
- `backend-conn-context.spec.ts` (`BL-TIER-S2-conn`):
  - the handler sees stable ids per connection and distinct ids across connections;
  - `onClose` fires once, including when the server closes;
  - two frames on one connection handled synchronously observe the first frame's state write;
  - existing specs are unchanged and green.
- `448f9d93-…spec.ts` is extended: `stopAccepting` never unlinks a successor's socket.
- `BL-TIER-S2-stop-accepting-no-deadlock`:
  - `stopAccepting()` **resolves while a client connection is still open**;
  - a new connect to the path then fails (ECONNREFUSED/ENOENT);
  - the open connection is still served (a request round-trips after `stopAccepting` resolved).
- `ensure-backend-supersede.spec.ts` (`BL-TIER-S2-supersede`):
  - the incumbent's `requestHandoff` runs under the lock;
  - a concurrent plain `ensureBackend` returns `adopted-after-wait` onto the **successor** pid;
  - a vacancy timeout returns `failed` and releases the lock;
  - no second spawn.

**Done:** `nx test service-proxy` is green; `gitnexus_impact` on `serveBackend` and `ensureBackend`
is reported in the PR, and its callers need no edits.

### S3 — Protocol, key, semver ordering, scheduler (G1, opus, MED)
**Required context:** none beyond §4.3–§4.4 and the §5.2 ordering table.
1. `modelTierProtocol.ts` per §4.3, including `decideHello`, `modelTierKey`, `parseReleaseVersion`,
   `compareReleaseVersions` and `isNewerRelease`.
   - The module stays pure: it does **not** import `packageVersion.generated.ts`. `decideHello` takes
     both versions as data; the drainer (S4) and client (S5) supply their own `PACKAGE_VERSION`.
   - `parseReleaseVersion` implements the SemVer 2.0.0 §9–§10 grammar exactly: numeric identifiers
     without leading zeros, non-empty dot-separated prerelease identifiers of `[0-9A-Za-z-]`,
     `+build` metadata accepted and discarded. No `v` prefix, no ranges, no whitespace trimming.
     No `semver` dependency (none exists in the workspace, and the module must stay zero-import).
   - **No source-digest lock.** Under O4 the ordering key is the released version, so a behavioural change to the drainer
     reaches drain-on-newer only when it is released, and a release happens only through a changeset
     that bumps `package.json` `version` (PUBLISHING.md). Nothing forces a changeset for a
     behaviour-only change: `scripts/check-changeset-surface.ts` fails only on `dist/*.d.ts` surface
     changes. Deciding that a drainer change warrants a release is a release-review act. S11's
     `BL-TIER-S11-stamp-parity` is the mechanical guard, and it guards the other link: the stamped
     constant always equals `package.json` `version`.
2. `tierScheduler.ts` per §4.4.

**Tests:**
- `tierScheduler.spec.ts` (`BL-TIER-S3-sched`):
  - interactive preempts bulk;
  - a bulk head older than 2 s is served;
  - DRR: a 4,096-token client and a 64-token client alternate by tokens;
  - buckets: 30×20-token and 2×500-token items never share a batch while the budget binds;
  - budget/items/delay closure;
  - `maxDelayMs` outside 0–5 → `TypeError`;
  - admit is all-or-nothing, with `retryAfterMs > 0` when full;
  - `cancelConnection` removes only unstarted items;
  - property test (fast-check if present, otherwise a seeded loop): no item lost, none duplicated,
    and per-ticket order preserved over 10k random ops.
- `modelTierProtocol.spec.ts`:
  - one `decideHello` row per field;
  - `BL-TIER-S3-semver-order`: every row of the §5.2 ordering table through `decideHello`, asserting
    `supersede`; plus the SemVer 2.0.0 §11 example chain
    `1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta < 1.0.0-beta.2 < 1.0.0-beta.11 < 1.0.0-rc.1 < 1.0.0`
    through `compareReleaseVersions` in both argument orders;
  - `parseReleaseVersion` returns `null` for `''`, `'v0.7.0'`, `'0.7'`, `'01.0.0'`, `'0.7.0-'`,
    `'0.7.0-01'`, `' 0.7.0'`, and `isNewerRelease` is `false` whenever the client string is one of
    them;
  - the key excludes cacheDir, ABI and build (identical key under two different `process.versions.modules`).

### S4 — Drainer (G2, opus, HIGH)
**Required context:** `embedHostMain.ts` in full (464 lines), and `embedHostConfig.ts:357-543`
(env scrub and argv).
1. `modelTierConfig.ts` per §4.8, moving the env scrub byte-identical.
2. `modelTierServer.ts` exports `runModelTier({argv, runnerFactory, versionOverride}: {argv: readonly string[];
   runnerFactory: (a: ModelTierSpawnArgs) => TierRunner;
   /** STUB-ONLY: set by stubTierMain.ts from --stub-version; modelTierMain.ts never passes it. */
   versionOverride?: string})`, which implements §5.1–§5.2.
   `reapDueInMs` keeps its pure-function shape (`embedHostMain.ts:75-85`), with `poolPending`
   replaced by `queued`.
   The drainer's `TierIdentity.version` is `PACKAGE_VERSION` imported from
   `./packageVersion.generated.js` (§4.9, produced by S11); `runModelTier` never reads a version from
   argv or env.
3. `modelTierMain.ts`: the entrypoint guard (reuse the `isEntrypoint` pattern, `embedHostMain.ts:446-457`)
   calls `runModelTier` with the ONNX runner factory.
4. `test-support/stubTierMain.ts` and `stubRunner.ts` per §6. `stubRunner` takes `{delayMs, throwOn,
   initDelayMs}`. `stubTierMain.ts` alone parses `--stub-version=<semver>` and passes it to
   `runModelTier` as `versionOverride` (step 2, §4.8); `tierHarness.ts`
   exposes it as `spawnStubTier({version})`.
5. Telemetry events per §9.1.
6. Tests, all using the stub:
   - the M1, M3, M4, M6, M8, M9, M10 and M11 specs from §7;
   - `BL-TIER-S4-retire-never-drops`: a 500-item queue with W=50 ms. The drainer does not retire
     until the queue is delivered, then retires within W+50 ms.
   - Ports of `68a4bf68-reap-on-work`, `17a83623-embed-host-lifecycle-telemetry` and
     `6660076e-embed-host-env-scrub` to the drainer, with event names renamed.
   - `BL-TIER-S4-teardown-order` (stub): retire, `model.reset` and SIGTERM each send `dispose`, await
     the worker's `exit` event, then exit. The spec asserts the event order from telemetry and asserts
     that `worker.terminate` is never called with a session live (spy).
7. **Required real-ORT port (e2e lane, written here, required green in S5's done-state):**
   `BL-TIER-S4-bl426-ort-teardown.e2e.ts` ports `fastembedProcessHost-bl426-shutdown.spec.ts`. On
   **both** `cpu` and `coreml` it runs a real drainer through three cycles: load then retire,
   load/embed then `model.reset` then retire, and load then SIGTERM. Each cycle asserts exit code 0
   and **no** `libc++abi` or `mutex lock failed` text in the drainer's stderr log.

**Done:** every listed spec is red→green; `rg "embedHostMain" src` finds only files slated for S5
deletion.

### S5 — Client, accessor, deletions (G3, opus, HIGH)
**Required context:** `funnelClient.ts` in full, `sharedFastembedProcess.ts:225-273` and
`:1700-1847`, `index.ts:180-260`, `fastembed.ts:60-130`.
1. `modelTierClient.ts` per §4.7 and §5.3, starting from `funnelClient.ts`. Keep:
   - the circuit breaker;
   - the retry-once;
   - the `warm` / `_servedOnConn` semantics (819a416b);
   - `resetHost` → `model.reset`.
2. `sharedFastembedProcess.ts`:
   - Keep `SharedFastembedClient`, `getSharedFastembedProcess`, `resetSharedFastembedProcess` and
     `__resetSharedFastembedProcessForTests`.
   - `'private'` → `new ModelTierClient({ privateForPid: process.pid })`.
   - Delete everything else in the file: the pool classes, the pool sizing, the competing-host
     detection and the child-process client.
3. `fastembed.ts`:
   - `embedSingle` sends `{type:'embed', text}` exactly as today; the client stamps
     `lane:'interactive'`. `embedBatch` is likewise unchanged; the client stamps `lane:'bulk'`.
   - `executionProvider` flows from `createEmbeddingProvider` config into the module-level typed
     override. Mirror `configureEmbedHostHost`: add `configureModelTierEp()`.
4. `index.ts`: the export changes in §4.2.
5. Delete `embedHostMain.ts`, `embedHostConfig.ts`, `funnelClient.ts`, `fastembedProcessHost.ts` and
   `fastembedLock.ts`.
   - Update `package.json` `sox.sidecars` to `["src/embedWorker.ts", "src/sharedOnnxWorker.ts",
     "src/modelTierMain.ts", "src/runnerWorker.ts"]`.
   - Update `sidecarExternals` to `["onnxruntime-node", "@anush008/tokenizers"]`.
   - The `exports` subpath `./embed-host` becomes `./model-tier` → `dist/modelTierMain.js`.
6. **Specs.**
   - Delete the specs whose subject no longer exists: `bl575-adaptive-pool`, `hol-pool-*`,
     `bl432-queue-depth`, `fastembedLock`, `fastembedProcessHost-*`,
     `sharedFastembedProcess-competing-host-cache`, `sharedFastembedProcess-leak`,
     `cfe12302-fastembed-lock-and-child-telemetry`, `bug021-respawn-reinit`,
     `bl-5124be6c-execution-provider-reinit`, `bug-memoryserver-shutdown-leaks-fastembed-child-001`,
     `bl410-standalone-exit-survives-load`, `2fe52b0f-rebuild-under-running-spawner`,
     `dc73d9b6-2fe52b0f-protocol-v2-host-owned-init`.
   - First grep each for an invariant that still applies (for example "a reset never bricks peers"),
     and **port** any such invariant to a drainer spec rather than dropping it. List every port or
     drop, with its reason, in the commit body.
   - `fastembedProcessHost-bl426-shutdown.spec.ts` is **never** dropped. Its invariant ("an ORT
     session must not see an abrupt exit") moves into the drainer as S4 item 7, and it must be green
     before this file is deleted.
   - Port `2fadb3cd`, `819a416b`, `embed-funnel.spec.ts` and `embedding-provider.spec.ts` to the stub
     drainer.
7. **Done:**
   - `rg -n "fastembed'" src --glob '!*.e2e.ts' --glob '!test-support/**'` returns only the
     `type:'fastembed'` config literal;
   - `rg -n "SOX_EMBED_EXECUTION_PROVIDER|SOX_EMBED_POOL|SOX_FASTEMBED_|SOX_EMBED_HOST_MAIN|SOX_EMBED_TIER_MAIN|SOX_EMBED_TIER_SOCKET_DIR" libs apps extensions --glob '!**/dist/**'`
     returns nothing outside CHANGELOG and ADRs;
   - **The vector-compat gate is fully green against the real drainer.** Run
     `npx nx run embedding-provider:test-e2e` (with S6's lane config; if S6 has not landed, run the two
     e2e files directly through that config). All four paths (a)–(d) must pass, with the candidate
     being `ModelTierClient` against a **real** drainer. Path (c) must show more than one `connId` in
     the same `model_tier.batch` event, which proves coalescing actually happened.
     `BL-TIER-S4-bl426-ort-teardown.e2e.ts` must also be green on both EPs. This is the first point at
     which the HIGH-risk vector check runs end-to-end. **It must not first run at release.**
   - `nx build,lint,typecheck,test embedding-provider` is green;
   - memory-core `nx typecheck` is green without source edits.

### S6 — Test lanes (G4, sonnet, LOW)
1. Add the `test-e2e` target to `project.json` (`dependsOn: ["^build","build"]`,
   `vitest run --config libs/data/embed/embedding-provider/vitest.e2e.config.ts`) with **no**
   `passWithNoTests`.
2. Make `vitest.config.ts` exclude `**/*.e2e.ts`. `vitest.e2e.config.ts` includes only `**/*.e2e.ts`.
3. Move each real-model spec to `*.e2e.ts`: `vector-compat`, `tier-real-model` (the real drainer:
   spawn, hello, embed, retire), and any ported spec that loads the model.
4. **Guard `BL-TIER-S6-default-lane-no-model.spec.ts`:**
   - Run the default lane's module graph behind an ESM resolve hook (the ADR-0019 reference pattern,
     `libs/data/search/semantic/src/optional-loadability.spec.ts`).
   - It throws on `onnxruntime-node`, `@anush008/tokenizers` or `fastembed`.
   - It asserts that no default-lane spec resolves them.

### S7 — Telemetry report and EP A/B (G4, sonnet, LOW)
1. `tools/embedding-tier-report.mjs [--days N] [--json]` reads
   `~/.adhd/sox-ecosystem/embed-host/logs/*.jsonl`. The drainer keeps service label `embed-host` so
   the log dir and history persist (confirm C4). It reports the §9.2 metrics, and includes the §9.3
   merged-stream W simulation as `--simulate-w 60,90,120,180,300`.
2. `tools/embedding-ep-ab.mjs` (BL-331, never run before):
   - Refuse to run when the 1-minute load average is above 8.
   - Spawn the real drainer **directly by argv** (`node dist/modelTierMain.js --socket=<tmpdir>/a.sock
     --ep=<ep> …`, built with the exported `encodeModelTierArgs`), once per EP (`cpu`, `coreml`),
     sequentially. Drive it with a `ModelTierClient` configured through
     `__configureModelTierForTests({entry, socketDir: <tmpdir>, expectRunner: 'onnx'})`, so it never
     touches the machine-wide drainer.
   - Drive a fixed workload: 200 interactive singles at Poisson 5/s, plus 20 bulk batches of 256 from
     the compat corpus.
   - Sample the drainer's RSS and CPU% every 500 ms (from `ps -o rss,%cpu`), and use the drainer's own
     `work_ms`.
   - Write `docs/plan/embedding-model-tier/ep-ab-<date>.json` with the load average before and after.
3. **Decision rule (normative):** the default EP for darwin is the one with the lower **steady RSS**,
   unless the other EP's interactive `work_ms` p99 is at least 1.5× better **and** its steady RSS is
   no more than 25 % higher.
   - Record the outcome by setting `DEFAULT_EP.darwin` in `modelTierConfig.ts`.
   - If that changes the EP, re-run the S1 gate on the **cross-EP** pair: stored-producing EP against
     the new default.

### S8 — sox consumers and docs (G4, sonnet, MED)
1. memory-server `package.json`:
   - drop `fastembed`;
   - set `onnxruntime-node` to S1's pin;
   - add `@anush008/tokenizers`.
2. memory-server `project.json` build command: drop `--external fastembed` and add
   `--external @anush008/tokenizers` (keep `--external onnxruntime-node`).
3. memory-core `package.json`: drop the `fastembed` dependency (after `rg` confirms it has no import),
   then run `pnpm install` and commit the lockfile.
4. Rewrite `libs/data/CLAUDE.md`'s BL-11 section and the package CLAUDE.md, AGENTS.md and README for
   the drainer. Update the sidecar list the bundler must emit to `embedWorker.js`, `sharedOnnxWorker.js`,
   `modelTierMain.js` and `runnerWorker.js`.
5. `npx nx build memory-server`, then `rm -rf dist/smoke && node scripts/smoke-test.mjs`, which must
   report `summary.failed === 0`.
   - **Version injection reached both esbuild forms** (§4.9): with
     `V=$(jq -r .version libs/data/embed/embedding-provider/package.json)`, the memory-server
     `dist/modelTierMain.js` (sidecar, compiled from `src/`) and `dist/index.js` (main bundle,
     inlined from the tsc `dist/`) each contain the literal `"$V"` next to `PACKAGE_VERSION`
     (`rg -n "PACKAGE_VERSION" <file>` shows the stamped value).
   - Live: the drainer's first `model_tier.spawned` event after the restart in step 6 carries
     `version = $V`, and the memory-server client's `model_tier.hello` carries `client_version = $V`.
6. Restart memory-server (`soxe service disable memory-server` → `enable … --node-path=<stable node>`)
   and verify:
   - a `model_tier.spawned` event has `spawner_service` = memory-server;
   - `memory_ping` is ok;
   - after ≥ 30 min of use, `tools/embedding-tier-report.mjs` shows `peak admitting tiers per key = 1`.

### S9 — Release (G5, sonnet plus a human for the publish step, MED)
1. Changesets:
   - `@adhd/sox-embedding-provider: minor` → **0.7.0** (breaking removals, O1). The body names the
     removed exports, the deleted env vars, the new `executionProvider`, the default W of 120 s, and
     the machine-wide socket dir.
   - `@adhd/sox-service-proxy: patch`.
2. PUBLISHING.md, "Local dry-run" block: add
   `npx nx run embedding-provider:test-e2e   # vector-compat gate; required when embedding-provider is in the set`.
3. Gates, **before** `changeset version`:
   - `npx nx affected -t build,lint,test,typecheck --base=origin/main`
   - `npx nx run embedding-provider:test-e2e`
   - `pnpm run check-publishable`
   - `pnpm run check-changeset-surface`
   - `pnpm changeset status`
   - `pnpm run cascade-plan`: **expect** embedding-provider 0.7.0 and service-proxy patch, plus
     dependents: memory-core, hybrid-search, semantic and claim-verification patches (F13;
     `updateInternalDependencies: patch`). Any divergence means stop and investigate.
   - `npm pack --dry-run --json` in each package dir: the tarball contains `dist/modelTierMain.js`,
     `dist/runnerWorker.js` and `dist/packageVersion.generated.js`, and no `fastembedProcessHost.js`.
   - `bash scripts/acceptance/clean-room-smoke.sh`.
4. Publish from a **clean clone of `main`**, not a worktree (PUBLISHING.md:247), following the
   "Publish to PUBLIC npm" block verbatim. A human runs `changeset version`, `release:prepared` and
   the registry steps.
4a. **Rebuild after `changeset version` (PUBLISHING.md edit, this segment).** The gates build
   `dist/` **before** `changeset version`, and `release:prepared` rebuilds only `sox` before
   `changeset publish` (PUBLISHING.md:69-77, :256-261). Without a rebuild, the 0.7.0 tarball would
   ship `dist/packageVersion.generated.js` stamped `0.6.1`, and a 0.7.1 release would then never be
   ordered correctly against it. Add to the "Publish to PUBLIC npm" block, between `pnpm install` and
   `pnpm run release:prepared`:
   ```bash
   npx nx build embedding-provider --skip-nx-cache   # re-stamps PACKAGE_VERSION from the bumped package.json
   node -e "const v=require('./libs/data/embed/embedding-provider/package.json').version;const s=require('fs').readFileSync('libs/data/embed/embedding-provider/dist/packageVersion.generated.js','utf8');if(!s.includes(\"'\"+v+\"'\")){console.error('stale PACKAGE_VERSION, expected '+v);process.exit(1)}"
   ```
   The build writes only ignored paths, so `assert-release-tree-clean` still passes.
5. Post-publish checklist in full. `npm pack @adhd/sox-embedding-provider@0.7.0` → `grep -c
   'model.enqueue' package/dist/modelTierClient.js` is ≥ 1, `package/dist/packageVersion.generated.js`
   exports `'0.7.0'`, and `dependencies` has no `fastembed`.

### S10 — adhd consumption (G6, sonnet, MED)
1. In `/Users/nix/dev/node/adhd` (a git worktree under `.worktrees/`):
   `pnpm --filter @adhd/backlog add @adhd/sox-embedding-provider@^0.7.0 @adhd/sox-hybrid-search@^<cascaded> @adhd/sox-semantic@^<cascaded>`,
   using the versions S9's cascade actually published.
2. `pnpm why @adhd/sox-embedding-provider` must show **exactly one** version (0.7.x). Two copies would
   put two clients in one process, one on the retired v2 host key. That check is the acceptance
   criterion.
3. Update `src/store/embed-funnel.e2e.ts`, `embed-funnel-watchdog.e2e.ts` and
   `src/test/helpers/embed-funnel-consumer.ts` for the drainer's event names (`model_tier.*`), its key
   and its machine-wide socket dir. Read each first; preserve its asserted invariant.
4. adhd gates: `nx affected -t test` (its `test` depends on `e2e`), `typecheck`, `lint`. Commit
   `package.json` and `pnpm-lock.yaml` together.
5. **Live acceptance:**
   - With memory-server (S8) running, run 20 `backlog create` CLIs over 5 minutes and one
     `backlog query` semantic search.
   - `tools/embedding-tier-report.mjs --days 1` shows **one** drainer pid serving `spawner_service`
     memory-server and backlog clients (`model_tier.hello.client_label`), and
     `peak admitting tiers per key = 1`.
   - Zero `embedding_failed` rows from those CLIs.
   - After the last CLI, the drainer exits W (120 s) ± 5 s after its last batch.

### S11 — Build-time version injection (G1, sonnet, MED)
**Required context:** §4.9; `libs/data/embed/embedding-provider/project.json` (whole file, 60 lines);
`tools/guards-manifest.mjs:210-235` (the entry shape). Do NOT read `tools/bundle-extension.cjs` or the
atomic-tsc executor: neither changes (§4.9 explains why).

S11 shares no file with S1, S2 or S3 (S1 owns `package.json`; S11 owns `project.json`), so it runs in
parallel with them. S4 and S5 import its output, so G2 waits for it. S6 edits `project.json` again in
G4, after S11 has landed.

1. `tools/stamp-package-version.mjs` per §4.9: flags `--package <projectRoot>` and `--out <file.ts>`,
   both required (exit 2 with usage otherwise). SemVer validation uses the same grammar as
   `parseReleaseVersion` (§4.3), inlined; the tool must not import from `libs/`, because it runs
   before any `dist/` exists. Atomic write (temp file plus rename); no write when the bytes are
   unchanged. No empty catch: an I/O error is printed with its path and exits 1.
2. `libs/data/embed/embedding-provider/.gitignore`: `src/packageVersion.generated.ts`.
3. `libs/data/embed/embedding-provider/project.json`: add the `stamp-version` target, set
   `build.dependsOn` to `["^build", "stamp-version"]` (keeping the `targetDefaults` edge), add
   `"dependsOn": ["stamp-version"]` to `typecheck` and `lint`, and add
   `{projectRoot}/package.json` to `build.inputs`, exactly as in §4.9. Change nothing else.
4. `src/packageVersion.spec.ts` (`BL-TIER-S11-stamp-parity`): read `package.json` from the package
   root, import `PACKAGE_VERSION` from `./packageVersion.generated.js`, and assert they are equal and
   that `PACKAGE_VERSION` is valid SemVer. This is the guard that the stamped constant never drifts
   from the released version.
5. `tools/test-bl-tier-s11-version-stamp.mjs`, hermetic (a temp dir with a synthetic `package.json`):
   - `version: "0.7.0"` → the out file exports `'0.7.0'`, exit 0;
   - a second run with the same version leaves the out file's mtime unchanged;
   - `version: "0.7.1"` → the out file is rewritten to `'0.7.1'`;
   - `version` missing, `"v0.7.0"` or `"0.7"` → exit 1, the out file is untouched, and stderr names
     the value;
   - no `.tmp` file remains in the out directory after any case.
   Register it in `tools/guards-manifest.mjs` as a Tier 1 entry (hermetic), in the shape of `bl222`
   (`:31-36`): `{ id: 'bl-tier-s11', tier: 1, script: 'test-bl-tier-s11-version-stamp.mjs', watch:
   ['tools/stamp-package-version.mjs', 'tools/test-bl-tier-s11-version-stamp.mjs',
   'libs/data/embed/embedding-provider/project.json'] }`. Guards run only when a watched file changes,
   so an entry without `watch` would never fire.
6. Build proof in an isolated worktree: `rm -f libs/data/embed/embedding-provider/src/packageVersion.generated.ts`,
   then `npx nx build embedding-provider --skip-nx-cache`. The generated file reappears,
   `dist/packageVersion.generated.js` exports the `package.json` version, and `git status --porcelain`
   does not list the generated file (it is ignored). Then run the C7 cache-restore proof (§13).

**Red→green (BL-225):**
- `BL-TIER-S11-stamp-parity`: hand-edit the generated file to `'0.0.1'` → red; run
  `nx run embedding-provider:stamp-version --skip-nx-cache` → green.
- `test-bl-tier-s11-version-stamp.mjs`: replace the SemVer check with `true` → the invalid-version
  cases go red; restore → green.
- Cache-miss proof: with the build cached, change `package.json` `version` in the scratch worktree and
  run `nx build embedding-provider`. The output must say the build ran (not `[existing outputs match
  the cache]`) and `dist/packageVersion.generated.js` must carry the new value. Remove
  `{projectRoot}/package.json` from `build.inputs` → the stale value returns (red); restore → green.
  Discard the scratch worktree afterwards; never commit a hand-edited `version`.

**Done:** all three red→green proofs recorded in the commit body; `nx build,lint,typecheck,test
embedding-provider` green; `node tools/test-bl-tier-s11-version-stamp.mjs` exits 0;
`rg -n "packageVersion.generated" libs/data/embed/embedding-provider/.gitignore` has one hit.

---

## 9. Telemetry and the W decision

### 9.1 Events (service `embed-host`, role `live-service`)
- **Drainer:**

  | Event | Fields |
  |---|---|
  | `model_tier.spawned` | key, version, build, runner, ep, spawner_*, denied_env, concurrent_admitting_same_key, concurrent_total (from `<socketDir>/tiers/`) |
  | `model_tier.model.loaded` | load_ms, sha_verify_ms, sha_cached, ep, rss_mb |
  | `model_tier.hello` | client_pid, client_label, client_version, client_build, outcome, supersede |
  | `model_tier.batch.start` | items, clients, lane, max_len |
  | `model_tier.batch` | items, clients, lanes, tokens, padded_tokens, work_ms, queue_ms_max |
  | `model_tier.metrics` | every 30 s while alive, on an unref'd timer, **not work**: rss_mb, queue_interactive, queue_bulk, inflight, loop_lag_p99_ms |
  | `model_tier.busy` | — |
  | `model_tier.cancelled` | — |
  | `model_tier.drain` | — |
  | `model_tier.handoff` | overlap_ms, items_finished |
  | `model_tier.retire` | reason, lifetime_ms, batches, items |
  | `model_tier.exit` | — |

- **Client:** `embedding_provider.tier_client.ensure {disposition, key, attempt}`, `.supersede`,
  `.retry`, `.rejected {field}`, `.busy`.

### 9.2 Report metrics (`tools/embedding-tier-report.mjs`)
- drainer spawns per day;
- peak concurrent **admitting** drainers per key, which must be 1, with the total also shown;
- handoff overlap;
- `work_ms` p50 and p99 per lane;
- queue depth p50, p99 and max per lane;
- RSS p50 and max;
- lifetime p50;
- a W simulation.

### 9.3 W, decided from the data
The simulation merges work-completion events (`fastembed_process.request.finish`) from every
non-test host serving `bge-base-en-v1.5` into one stream, which is what a single drainer would see.
It covers 2026-09-26 to 09-27: 4,171 completions over 1.85 days.

| W | drainer spawns | spawns/day | idle-resident h/day |
|---|---|---|---|
| 60 s | 145 | 78 | 3.0 |
| 90 s | 102 | 55 | 3.6 |
| **120 s** | **84** | **45** | **4.0** |
| 180 s | 70 | 38 | 4.7 |
| 300 s | 50 | 27 | 5.7 |
| 600 s | 27 | 15 | 7.3 |

A spawn costs about 0.5 s (init p50 467 ms; first real embed 491 ms against 378 ms warm, per the
research trace). Idle residency costs a model's worth of RSS on a machine with swap at 9.2 of 10 GB.

The knee is at **120 s**:
- 60→120 s removes 33 spawns/day for +1.0 idle-hour/day;
- 120→180 s removes only 7 spawns/day for +0.7 h.

**Default `W = 120_000` ms** (`DEFAULT_MODEL_TIER_IDLE_MS`, still typed `idleGraceMs`). S7's report
re-runs this simulation on post-cutover data, where one merged drainer replaces up to 3 split hosts.
If the knee moves, change the constant through a spec'd PR citing the report, not an env var (open
decision O2).

### 9.4 EP default
`DEFAULT_EP = { darwin: <S7 A/B result; 'coreml' until then, which preserves today's behaviour>,
linux: 'cpu', win32: 'cpu' }`. The typed `executionProvider` overrides it. The key always carries the
resolved value.

---

## 10. adhd consumption: the published package shape

- `@adhd/sox-embedding-provider@0.7.0`:
  - `dist/` ships `index.js`, `modelTierClient.js`, `modelTierMain.js` (the `./model-tier` export),
    `runnerWorker.js`, `onnxRunner.js`, `tierScheduler.js`, `modelTierProtocol.js` and
    `vectorContract.js`;
  - `dependencies`: `@adhd/sox-service-proxy`, `@adhd/sox-telemetry`, `@huggingface/transformers`,
    `onnxruntime-node` (exact pin), `@anush008/tokenizers`, `tar`;
  - **no `fastembed`** (devDependency only).
- adhd picks up the drainer purely by upgrading its dependency: `createEmbeddingProvider({type:'fastembed', …})`
  is source-compatible, and the backlog CLI needs no call-site change. Its bounded in-flight drain and
  `embedding_failed` recording (F8) are exactly the "consumer may exit" contract of §2.1.
- **Cascade** (S9 → S10): embedding-provider minor, then dependents' patches (memory-core,
  hybrid-search, semantic, claim-verification). Then adhd bumps all three direct `@adhd/*` embedding
  consumers and proves a single provider copy with `pnpm why`.
- **Transition window:** until adhd upgrades, 0.6.x backlog processes keep spawning per-build v2 hosts
  on the old key, alongside the memory-server's drainer. "Exactly one" holds only from S10 onward.
  That is expected, and the S10 live acceptance measures it.

---

## 11. ADR text (S0 commits it verbatim after owner approval)

### 11.1 `docs/decisions/0023-embedding-model-tier-is-a-machine-wide-singleton.md`

````markdown
# ADR-0023 — Embedding model tier is a machine-wide singleton

**Status:** PROPOSED (2026-09-27) → ACCEPTED on owner approval.
**Owner:** pseudosky.
**Drives:** BL-TIER-* (docs/plan/embedding-model-tier/SPEC.md), BL-331 (EP A/B), BL-575 (adaptive pool — removed).
**Amends:** [ADR-0020](./0020-embedding-funnel-peer-spawned-self-reaping.md) D2 (the ONNX child that
"dies with the host") and D4 (the meaning of `host: 'private'`);
[ADR-0022](./0022-embedding-funnel-is-a-work-driven-drainer.md) §1's default `W`, §4 (the key — superseded),
and its Consequences / What-does-NOT-change clauses on per-build hosts and the adaptive pool.
**Relates to:** ADR-0004 (socket placement — departed from, D3), ADR-0012 (compute-only — upheld),
ADR-0013 (typed config — upheld; EP moves from env to config), ADR-0019 (lazy native imports).

## TL;DR for the next agent

One process per machine loads the embedding model: the **drainer**. Every consumer — memory-server,
the backlog CLI, tests, worktrees — enqueues into it over one UDS and receives its vectors back on the
same connection; the consumer applies them to its own store. The drainer batches everything queued
(lanes, per-client fairness, token budget, length buckets), lives while it has work, and retires `W`
(120 s) after its queue empties. It is keyed by *what the vectors mean* — protocol, model-file sha,
vector contract, execution provider — never by build, Node ABI or runtime version. A drainer from a
newer **released package version** (SemVer precedence) takes over by drain-on-newer: the incumbent
finishes its queue and hands the socket off. Unreleased worktree code never drains production.
Never add a second model-loading process, a per-build key, or an env toggle for any of this.

## Context

- ADR-0022 §4 keyed the host on a content build id that hashes `process.versions.modules`
  (`embedHostConfig.ts:303-306`): the memory-server bundle, the adhd npm dist, every worktree and
  every Node ABI ran its own host — up to 3 concurrent (telemetry 2026-09-26/27), 293 spawns in
  44.5 h, each holding a resident model on a machine at swap 9.2/10 GB.
- Each host forked a private ONNX child and an adaptive child pool (BL-575) — two model-holding
  processes per host at times.
- fastembed pads every input to 512 tokens (`tokenizers.rs:78`, `PaddingStrategy::Fixed`) and exposes
  no session options; it pins onnxruntime-node 1.21.0.
- The owner's intent: exactly one model process per machine, shared by every consumer, alive only
  while there is real work; no permanent daemon, no socket activation (ADR-0020 D1 stands).

## Decision

1. **One drainer per key, machine-wide.** The key is
   `embedding-model:v<PROTOCOL>:<modelFileSha>:<vectorContract>:<resolvedEp>`. It excludes the JS
   build id, the Node ABI, the runner version and the cache dir. `modelFileSha` is a pinned manifest
   constant; the drainer verifies the real file against it. `resolvedEp` is never `auto`.
2. **It is a queue drainer, not an RPC server.** A request frame enqueues; its response delivers.
   Consumers may exit; their unstarted items are cancelled on disconnect; durability stays in each
   consumer's own store (outbox / `embedding_failed`), exactly as before. The drainer holds no store
   connection (ADR-0012, ADR-0020 D3).
3. **The socket lives in a machine-wide per-user directory** (`~/.adhd/run/embedding-model/`),
   independent of `SOX_ECOSYSTEM_HOME`, because a compute-only singleton must not be forked by a data
   sandbox. Stub drainers used by tests may never bind there.
4. **Mandatory first-frame handshake.** `{protocol, vectorContract, modelFileSha, ep, clientVersion}`
   (+ runner kind). A mismatch is a typed rejection; a consumer never falls back to a private fork
   (ADR-0020 D5 upheld).
5. **Drain-on-newer, ordered by released package semver.** Each side's version is the
   `@adhd/sox-embedding-provider` `package.json` `version`, stamped into its artifact at build time
   (`PACKAGE_VERSION`, generated from `package.json` by the package's `stamp-version` nx target that
   `build` depends on) and never taken from argv or env. A client whose version is strictly greater
   by SemVer 2.0.0 precedence asks the incumbent to hand off under the `ensureBackend` spawn lock:
   the incumbent stops accepting, finishes its whole queue on existing connections, and retires; the
   successor binds immediately. Equal versions (build metadata ignored) and older versions never
   supersede. An unparseable client version never supersedes; a valid version supersedes an
   unparseable incumbent. Because `version` moves only through Changesets in the release flow,
   unreleased worktree code stamps the version of the release it branched from and cannot drain
   production.
6. **Work-driven retirement (ADR-0022 §1 kept, default changed).** Retire `W` after the last batch
   completes with an empty queue; connections, handshakes, probes and resets are not work. Default
   `W = 120 s`, chosen from the merged-stream simulation (spawns/day 78 → 45 for +1.0 idle-hour/day).
   `W` stays typed config (`idleGraceMs`).
7. **Runner.** onnxruntime-node used directly, in one worker thread inside the drainer; the same
   `.onnx` file and tokenizer; CLS pooling + L2 (ε 1e-12); the prefix rule `embed → "query: "`,
   `embedBatch → none`, applied before coalescing; batch-longest padding under the attention mask.
   A vector-compat gate (per-item cosine ≥ 0.999 on 500 samples, identical token ids) guards it.
8. **One queue, cross-client batching** replaces the per-host adaptive child pool: two lanes
   (interactive above bulk, with a starvation bound), deficit round-robin by tokens across clients,
   length buckets, a token budget, a 0–5 ms max delay, and a bounded queue with a typed busy error.
9. **`host: 'private'`** (ADR-0020 D4) now means a drainer keyed to the consumer's pid — the same code,
   explicitly unshared.
10. **Execution provider is typed config** (`EmbeddingProviderConfig.executionProvider`); the
    `SOX_EMBED_EXECUTION_PROVIDER` env var is deleted (ADR-0013). The platform default is set by the
    BL-331 A/B rule in the implementation spec.

## Consequences

- One resident model per machine per key. Two admitting drainers for one key is a defect, measured by
  `tools/embedding-tier-report.mjs` (peak admitting tiers per key must be 1). During a drain-on-newer
  handoff two processes coexist for the incumbent's drain tail only.
- A protocol or vector-contract change produces a new key and therefore a second drainer until the old
  one's consumers upgrade — prefer additive, capability-negotiated protocol changes.
- Only a release moves the ordering: a drainer is replaced by drain-on-newer only when a consumer
  built from a newer published version arrives. A behavioural fix to the drainer reaches running
  consumers at the next release, not at the next worktree build.
- Equal versions share a drainer, whichever build spawned it. A worktree client that finds no live
  drainer spawns its own build as the machine-wide drainer, and production clients of the same
  version adopt it until it retires `W` after its last work. The `build` fingerprint on
  `model_tier.spawned` / `model_tier.hello` attributes which build served which client.
- A tree that contains the `changeset version` commit stamps the upcoming version before it is on
  npm. That commit is the release being published (the release flow builds and publishes it from a
  clean clone of `main`, PUBLISHING.md), so the window closes at publish.
- Tests use a stub runner by default; real-model tests live in an explicit `test-e2e` lane that the
  release gate runs.
- `@adhd/sox-embedding-provider` 0.7.0 removes the pool/child exports (breaking); consumers upgrade
  their range.

## What does NOT change

ADR-0020 D1 (peer-spawned, detached, unsupervised; no socket activation), D3 (compute-only), D5
(honest typed failure, no silent private fork, per-process circuit breaker). ADR-0022 §2 (ordered
synchronous retire, inode-guarded unlink), §3 (requests carry identity; the drainer owns model init),
§5 (env scrub; spawner provenance as argv). `ensureBackend`'s O_EXCL spawn lock remains the only spawn
path.

## Evidence

- Telemetry: `~/.adhd/sox-ecosystem/embed-host/logs/embed-host.live-service-2026-09-2{6,7}.jsonl`
  (293 spawns / 44.5 h, peak 3 concurrent; merged-stream W table in the SPEC §9.3).
- `fastembed@2.1.0/lib/esm/fastembed.js:33-37,105-110,224-263`; `@anush008/tokenizers/src/tokenizer.rs:78`.
- `libs/data/embed/embedding-provider/src/embedHostConfig.ts:202-210,303-306`; `funnelClient.ts:342`.
- Research: `.research-trace/2026-09-27-embedding-runner-funnel.md`.
````

### 11.2 ADR-0020 Status line (replacement)

```
**Status:** ACCEPTED (2026-09-22); D2 and D6 SUPERSEDED BY [ADR-0022](./0022-embedding-funnel-is-a-work-driven-drainer.md); D2's ONNX-child ("dies with the host") clause and D4's meaning of `host: 'private'` AMENDED BY [ADR-0023](./0023-embedding-model-tier-is-a-machine-wide-singleton.md).
```

### 11.3 ADR-0022 Status line (replacement)

```
**Status:** ACCEPTED (2026-09-25); §4 SUPERSEDED BY [ADR-0023](./0023-embedding-model-tier-is-a-machine-wide-singleton.md); §1's default `W` (60 s → 120 s), the Consequences clause "two builds on one box run two hosts", and the What-does-NOT-change "adaptive pool policy" AMENDED BY ADR-0023.
```

---

## 12. Owner decisions

| # | Decision | DECIDED |
|---|---|---|
| O1 | Release shape | **0.7.0 minor**: remove the pool/child exports outright (the "no deprecate" directive). adhd must bump its ranges (S10). |
| O2 | `W` | **120 s** (the §9.3 knee): model tier exits 120 s after its last work. |
| O3 | Handoff overlap during drain-on-newer | **Overlap**: the incumbent closes its listener at once and drains its tail while the successor serves new work. Two models are resident briefly, only on a release version bump. |
| O4 | What orders "newer" | **Released package semver**: the released package version decides which process is "newer". Unreleased worktree code will not drain production. |
| O5 | Default EP on darwin | **CoreML** until the A/B test runs. Decided by the S7 A/B rule to preserve today's vectors. |
| O6 | Healing unstarted items on consumer exit | **Keep cancel-on-disconnect and add automatic re-embed to backlog.** Cancel-on-disconnect keeps today's delivery contract (F7) and ADR-0020 D3. Memory-core self-heals through its outbox and heal tick; backlog adds a heal tick for automatic re-embed of unstarted items, separate from the drainer. |

---

## 13. Check-and-confirm items (the executor confirms or denies with evidence before relying on them)

- **C1.** No production launchd plist or `extension.json` sets `SOX_EMBED_EXECUTION_PROVIDER`,
  `SOX_EMBED_POOL_SIZE` or `SOX_EMBED_POOL_ADMISSION_LIMIT`. Grep `~/Library/LaunchAgents/*sox*`
  and `extensions/**/extension.json`.
- **C2.** The EP that produced the 9,313 stored vectors: memory-server's `model.init` telemetry, or
  `embedding_provider.fastembed.execution_provider_forced`. The S1 gate runs on it.
- **C3.** memory-server currently resolves `onnxruntime-node` 1.21.0 for the bundled
  `@huggingface/transformers` rerank path, which expects 1.24.3 (F14). Confirm which version its
  rerank worker loads at runtime before S8 changes the pin.
- **C4.** Keeping the telemetry service label `embed-host` for the drainer, so the log dir and
  history persist. The alternative is `embedding-model`, with the report reading both.
- **C5.** `backendSocketPath(dir, key)` yields a UDS path under 104 bytes for the machine-wide
  directory and the longest key.
- **C6.** `release:prepared` rebuilds only `sox` (PUBLISHING.md:69-77), and the gates build before
  `changeset version` (:52-67), so nothing in today's flow re-stamps `PACKAGE_VERSION` after the
  bump. S9 step 4a adds the rebuild and the artifact assertion. Confirm, before S9, that
  `changeset publish` publishes the on-disk `dist/` without a lifecycle script that would rebuild it
  (embedding-provider's `package.json` has no `scripts` today). Confirm the same for the CI path
  (PUBLISHING.md:120: merging the "Version Packages" PR runs `version`, then a follow-up run calls
  `release:prepared`): that run must build embedding-provider after the bump, or S9 adds the same
  rebuild and assertion to that workflow.
- **C7.** An `nx:run-commands` target with `outputs` restores a gitignored output from the nx cache.
  Prove it in S11: build once, delete `src/packageVersion.generated.ts`, run
  `nx run embedding-provider:stamp-version` **with** the cache, and confirm the file is back and nx
  reports a cache hit.

## 14. Risk register (per segment)

| Segment | Risk | Mitigation |
|---|---|---|
| S1 | A new runner silently shifts vectors, corrupting recall over 9,313 stored vectors | Strict per-item gate on four paths, including coalesced multi-client batches; exact token-id equality; a stored-vector report; the ORT pin decided by the gate |
| S2 | A change to a shared service-proxy lib breaks the memory-server `:3099` shim | Additive-only signatures; all existing specs green; `gitnexus_impact` reported; smoke test in S8 |
| S3 | The scheduler starves or loses items | Property test (no loss, no duplication, order preserved), starvation bound test |
| S3 | A semver comparator bug lets an equal or older build drain production, or blocks a real release from taking over | The §5.2 ordering table and the SemVer §11 precedence chain as table tests; unparseable client ⇒ never supersede |
| S11 | A stale stamp: `dist/` carries the previous version after a Changesets bump, so a new release never drains the old one | `package.json` is an explicit `build` input (cache-miss proof in S11); `BL-TIER-S11-stamp-parity`; S9 step 4a rebuilds after `changeset version` and asserts the artifact; the post-publish tarball check reads it again |
| S11 | The generated file is missing in a fresh clone and typecheck/lint/vitest fail | `build`, `typecheck` and `lint` depend on `stamp-version` and `test` depends on `build`; consumers resolve the package's `dist/` through `node_modules`, never its `src/` |
| S11 | `build.dependsOn` replaces the `^build` default and upstream libs stop building first | `build.dependsOn` is the explicit union `["^build", "stamp-version"]` (§4.9) |
| S4 | A native crash on a poison input loops through respawns | `batch.start` attribution before the run; bisect on JS errors; client retry-once plus the circuit breaker bound respawns |
| S4 | An in-process ORT session aborts on exit (BL-426: SIGABRT, `mutex lock failed`) | Mandatory worker-owned teardown order (§5.1); never `worker.terminate()` a live session; a real-ORT e2e on both EPs is required green in S5 |
| S5 | The HIGH-risk vector check first runs for real at release | S5's done-state requires all four compat paths green against a real drainer, with proof of coalescing |
| S5 | Deleting specs drops a still-valid invariant | A mandatory port-or-drop list with reasons in the commit body |
| S6 | The e2e lane becomes dead config | Wired into the PUBLISHING.md gate (S9); the default-lane no-model guard |
| S7 | An A/B run under load gives the wrong default | The harness refuses above load 8 and records load before and after |
| S8 | A bundle misses a sidecar or a native external | `verifySidecarReferences` fails the build; smoke `failed === 0`; live `memory_ping` |
| S9 | An irreversible publish of a wrong cascade | `cascade-plan` expectation stated up front; clean-clone publish; post-publish tarball checks |
| S10 | Two provider copies in adhd leave the old v2 host alive | `pnpm why` single-version acceptance; live report shows one drainer pid |
