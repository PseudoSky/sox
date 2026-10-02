# SPEC — Embedding Host: one machine-wide sox-owned embedding daemon

Architect: architect (spec only). Date: 2026-09-22.
Repos: `sox-ecosystem` (daemon + provider, primary) and `adhd` (consumer: `entrypoint/backlog`).
ADR catalog checked (all 18, `sox-ecosystem/docs/decisions/`): ADR-0012 authoritative; ADR-0013, ADR-0015, ADR-0004, ADR-0006, ADR-0016 load-bearing.
Research grounding: `researcher` sweep (trace `.research-trace/2026-09-22-resident-embedding-daemon.md`). Verdict: **build** the daemon by wrapping the existing TS `fastembed`/`onnxruntime-node` stack; do **not** integrate a third-party server (TEI = documented fallback only; Infinity/Ollama/llama.cpp/Xinference/LocalAI/vLLM blocked — wrong runtime, GGUF-only, or disproportionate).
**Read-only on code. One spec doc written. No implementation authorized by this document.**

## Summary

Replace the per-OS-process fastembed child (`getSharedFastembedProcess()` → `AdaptiveFastembedProcessPool{minSize:1}` at `sharedFastembedProcess.ts:1654`, which forks one ~219MB `bge-base-en-v1.5` ONNX host per embedding process) with **one long-lived, sox-owned `embedding-host` daemon** that keeps the model resident and serves every consumer over a Unix-domain socket. Consumers stop forking: `getSharedFastembedProcess()` becomes **daemon-aware** — it dials the socket when live and returns the *same* `SharedFastembedClient` shape, so no call site changes; the wire contract is the host's existing `{id, type:'init'|'embed'|'embedBatch'}` messages carried over the framed JSON-RPC UDS from `@adhd/sox-service-proxy`. Supervision reuses `deriveOsUnitSpec` (`background+singleton` → launchd `RunAtLoad`+`KeepAlive`). Failure is honest: a typed `TransientEmbeddingError`, never a silent hang and **never a silent re-fork** (which would recreate the defect invisibly). The decisive **build-over-integrate** constraint is vector identity: the daemon wraps the existing TS `fastembed`/`onnxruntime-node` stack so produced vectors stay bit-identical to the existing index — TEI/Infinity would serve the same model through a different pooling/normalization/quantization runtime (a silent index-corruption risk), and Ollama/llama.cpp cannot load the existing ONNX artifact at all (GGUF-only).

## Files

| Path | Change | Read | Output |
|---|---|---|---|
| `libs/data/embed/embedding-provider/src/fastembedLock.ts` | modify | 120 | 60 |
| `libs/data/embed/embedding-provider/src/daemonClient.ts` | create | 0 | 420 |
| `libs/data/embed/embedding-provider/src/daemon.ts` | create | 0 | 260 |
| `libs/data/embed/embedding-provider/src/sharedFastembedProcess.ts` | modify | 300 | 260 |
| `libs/data/embed/embedding-provider/src/index.ts` | modify | 120 | 120 |
| `extensions/services/embedding-host/extension.json` | create | 0 | 90 |
| `extensions/services/embedding-host/src/index.ts` | create | 0 | 220 |
| `libs/service-proxy/src/socket-path.ts` | modify (embedding singleton key) | 60 | 40 |
| `entrypoint/backlog/src/env.ts` (adhd) | modify | 110 | 90 |
| `entrypoint/backlog/src/store/semantic-search.ts` (adhd) | modify | 230 | 120 |
| `entrypoint/backlog/package.json` (adhd) | modify | 30 | 20 |
| `libs/data/embed/embedding-provider/src/embedding-host-ab.spec.ts` | create | 0 | 200 |

## Interface changes

### `fastembedLock.ts` — `resolveFastembedLockPath()` (BEFORE → AFTER)

```ts
// BEFORE  (os.tmpdir() — launchd /tmp vs shell $TMPDIR → split lock, 755 vs 1 warnings)
return process.env['SOX_FASTEMBED_LOCK_PATH'] ?? join(tmpdir(), 'sox-fastembed-host.lock');
// AFTER   (stable machine-global, ADR-0004 D2 `run/`; env override stays — host config, ADR-0013 D5)
return process.env['SOX_FASTEMBED_LOCK_PATH']
  ?? join(process.env['SOX_ECOSYSTEM_HOME'] ?? join(homedir(), '.adhd', 'sox-ecosystem'),
          'run', 'fastembed-host.lock');
```

### New: `daemonClient.ts`

```ts
/** SharedFastembedClient that proxies to the daemon over UDS. Same shape as the fork-backed client. */
export class DaemonBackedFastembedClient implements SharedFastembedClient {
  constructor(opts: { socketPath: string; dialTimeoutMs?: number });
  request<T>(payload: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal): Promise<T>;
  terminate(): Promise<void>;        // NO-OP — never kill the shared daemon
  get started(): boolean;
}
export function probeDaemon(socketPath: string, timeoutMs?: number): Promise<boolean>;
export function resolveEmbeddingHostSocketPath(): string; // backendSocketPath(key)
```

### New: `daemon.ts` (a real `EmbeddingProvider` over the daemon)

```ts
/** Replaces the zero-vector `RemoteProvider` stub for local use. */
export class DaemonEmbeddingProvider implements EmbeddingProvider {
  constructor(modelId: string, dimensions: number, socketPath: string);
  // embedSingle/embedBatch/warmUp/health → DaemonBackedFastembedClient.request(...)
}
```

### `index.ts` — factory + exports (BEFORE → AFTER)

```ts
// BEFORE: switch (config.type) { case 'fastembed' … case 'remote' … }
// AFTER:  add  case 'daemon': return createDaemonProvider(config);
//         options: { socketPath?: string; dimensions?: number }
export { DaemonBackedFastembedClient, probeDaemon, resolveEmbeddingHostSocketPath } from './daemonClient.js';
export { DaemonEmbeddingProvider } from './daemon.js';
```

### `sharedFastembedProcess.ts` — `getSharedFastembedProcess()` (BEFORE → AFTER)

```ts
// BEFORE
export function getSharedFastembedProcess(): SharedFastembedClient {
  if (_singleton) return _singleton;
  const pin = resolveFastembedPoolPin();
  _singleton = pin !== null ? new FastembedProcessPool(pin)
    : new AdaptiveFastembedProcessPool({ minSize: 1, maxSize: resolveFastembedPoolCeiling() });
  return _singleton;
}
// AFTER (probe-first; typed config decides fork-vs-dial, never an env toggle)
export async function getSharedFastembedProcessAsync(): Promise<SharedFastembedClient> {
  if (_singleton) return _singleton;
  if (await probeDaemon(resolveEmbeddingHostSocketPath()))
    return (_singleton = new DaemonBackedFastembedClient({ socketPath: resolveEmbeddingHostSocketPath() }));
  if (embeddingHostConfig().allowPrivateHost)            // typed config, default false
    return (_singleton = new AdaptiveFastembedProcessPool({ minSize: 1, maxSize: resolveFastembedPoolCeiling() }));
  throw new TransientEmbeddingError(`embedding host not reachable at ${resolveEmbeddingHostSocketPath()}`, 5000);
}
```

## Behavioral changes

### `daemonClient.ts` — transport + failure
- Dial with `dialBackend` (re-dialing, bounded backoff). Map `{type:'init'|'embed'|'embedBatch'}` → JSON-RPC `embedding.init|embedding.embed|embedding.embedBatch` 1:1; reuse `encodeFrame`/`FrameDecoder`.
- **Bounded, never hang:** connect+dial ≤ `dialTimeoutMs` (default 2000); per-request ≤ `timeoutMs ?? 30000`. On socket-absent / dial-exhausted / timeout → throw `TransientEmbeddingError` (retryable, `retryAfterMs`) naming the socket path. No silent retry loop, no infinite wait.
- **Circuit breaker:** a burst of short-lived CLIs must not each pay the full dial timeout against a known-down daemon. After K consecutive failed probes, open the breaker for a short cooldown and fail fast (still a typed `TransientEmbeddingError`), so `backlog` invocations stay snappy while the daemon is down. The breaker never silently forks.
- `terminate()` is a **no-op** — the daemon is shared; a consumer must never kill it.

### `sharedFastembedProcess.ts` — daemon-aware
- Probe is cached (TTL ~3s, mirroring the existing competing-host cache) so the hot path pays no per-embed dial.
- **Never auto-spawn the daemon from a consumer** (that recreates per-process forking). Bringing the daemon up is the supervisor's job (`soxe service enable` / `doctor`), never a side effect of an embed.
- Keep the sync `getSharedFastembedProcess()` as a thin throw-if-not-daemon shim for existing callers; migrate `fastembed.ts`/`memory-core/embed.ts` to the async accessor.

### `extensions/services/embedding-host/src/index.ts` — the daemon
- `serveBackend({ socketPath: resolveEmbeddingHostSocketPath(), handler })`; handler = `getSharedFastembedProcessAsync()` — inside the daemon this resolves the fork path (the daemon is the *only* process that forks), so its per-process pool becomes machine-wide.
- Holds the model warm across connections; multiplexes concurrent UDS clients onto the adaptive pool (grow-under-sustained-demand policy already implemented — no new concurrency logic).
- `extension.json`: `type:"service"`, `lifecycle:{background:true,singleton:true}` → launchd `RunAtLoad`+`KeepAlive` via `deriveOsUnitSpec` (`os-unit.ts:313-315`). Activation posture `always-on` (ADR-0007 D3: always-on ships first). **Do not attempt launchd socket activation** for the on-demand path: it requires `launch_activate_socket(3)`, a C API Node cannot call — always-on `KeepAlive` (which implies `RunAtLoad`) is the only viable launchd posture here; `ensureBackend` covers non-launchd/CI contexts.
- Socket path must stay under the macOS `sun_path` limit (~104 bytes): `~/.adhd/sox-ecosystem/run/embedding-host.sock` (~51 chars) is safe.

### `entrypoint/backlog` (adhd) — consumer
- `env.ts`: `embedding.provider` default `'fastembed'` → `'daemon'`; add `embedding.daemonSocket` (host-config path, ADR-0013 D5). `embedding.enabled` **stays default `false`**. `ADHD_BACKLOG_EMBEDDING_PROVIDER` stays — closed-union *selection* (ADR-0013 border, allowed).
- `semantic-search.ts`: `bootstrapSemanticBackend` passes `provider:'daemon'`. **Remove the eager warmup** — `createEmbeddingProvider` must not `embedSingle('warmup')` at construction (today `index.ts:245-249` forks a host on every store-opening verb, incl. `query --input '{"view":"projects"}'`). Construction becomes lazy; the daemon owns warm residency. On provider failure → existing typed `failure.reason:'provider_failed'`, return `null`, RAG unconfigured — **no hang, no crash**.
- `package.json`: optionalDep `@adhd/sox-embedding-provider` `^0.4.0` → `^0.5.1`; rebuild + reinstall the global CLI (frozen build).

## Independent segments

| # | Segment | Files | Depends | Read | Output |
|---|---|---|---|---|---|
| A | Lock-path fix | `fastembedLock.ts` | — | 120 | 60 |
| B | Daemon client + provider | `daemonClient.ts`, `daemon.ts` | A | 0 | 680 |
| C | Daemon service | `extensions/services/embedding-host/*` | B | 80 | 310 |
| D | Daemon-aware singleton | `sharedFastembedProcess.ts`, `index.ts` | B | 200 | 380 |
| E | backlog consumer | `entrypoint/backlog/src/{env.ts,store/semantic-search.ts,package.json}` | D | 340 | 230 |
| F | 25–50× A/B + reword | `embedding-host-ab.spec.ts`, host/lock doc comments | — | 40 | 200 |

## Execution strategies (for weaker executors)

**A** — In `fastembedLock.ts`, replace the `tmpdir()` branch of `resolveFastembedLockPath()` exactly as shown; add `homedir` to the `node:os` import. Do NOT touch `FastembedLockInfo`, `normalizeFastembedService`, or the writer/reader in `fastembedProcessHost.ts`/`sharedFastembedProcess.ts`. `SOX_FASTEMBED_LOCK_PATH` override stays.

**B** — Create `daemonClient.ts` and `daemon.ts` exactly per the interface block. Import `dialBackend`, `encodeFrame`, `FrameDecoder`, `probeSocketLive`, `backendSocketPath` from `@adhd/sox-service-proxy` (dependency-free leaf — no cycle). `DaemonBackedFastembedClient.request()` must translate the existing payload shapes only; do not invent new fields. `terminate()` returns `Promise.resolve()`.

**C** — Scaffold `extensions/services/embedding-host` via the manifest convention of `extensions/bundles/sox-memory-bundle/members/memory-server/extension.json` (copy the `lifecycle` block shape: `{background:true,singleton:true}`). Entrypoint: 40 lines max — `serveBackend` + a handler that forwards to `getSharedFastembedProcessAsync()`. NEVER add an env-var activation toggle.

**D** — Add `getSharedFastembedProcessAsync()` beside the existing sync function; do NOT delete the sync one (external callers). Add `embeddingHostConfig()` reading typed config only (`{allowPrivateHost:boolean, socketPath?:string}`). Add `case 'daemon'` to the factory switch. Never let the probe throw — absent daemon ⇒ typed error.

**E** — Change only the three named files. In `semantic-search.ts` do NOT restructure `bootstrapSemanticBackend` beyond the provider arg and removing the eager warmup; leave the vector-space probe, dim check, and failure taxonomy untouched. Rebuild: `npx nx build backlog` then reinstall the global bin (frozen build).

**F** — Extend the existing harness (`bl575-adaptive-pool.spec.ts`, `hol-pool-benchmark.spec.ts`): 1 host vs 2 concurrent hosts, `SOX_EMBED_EXECUTION_PROVIDER` default (CoreML) **and** forced `cpu`; record p50/p99. If the ratio is not reproducible, **reword** the 25–50× claims at `sharedFastembedProcess.ts:71` and `fastembedProcessHost.ts:177-179` to the measured number.

## Test cases

**Unit (`embedding-provider`)**
- `resolveFastembedLockPath()` returns a path under `SOX_ECOSYSTEM_HOME/run/` with `TMPDIR` set to `/tmp` **and** to `/var/folders/...` → identical (kills the split-lock). `SOX_FASTEMBED_LOCK_PATH` still wins.
- `probeDaemon(socket)` false for a non-existent path; `DaemonBackedFastembedClient.request()` with no daemon throws `TransientEmbeddingError` **within** the dial bound (asserts elapsed < bound+slack — no hang).
- `terminate()` on a daemon-backed client does NOT close/kill the daemon socket.
- `createEmbeddingProvider({type:'daemon'})` does not fork a child (assert no `fastembedProcessHost` pid spawned) and does not warm.
- `getSharedFastembedProcessAsync()` returns `DaemonBackedFastembedClient` when a stub daemon is live, else throws when `allowPrivateHost:false`.

**Integration (teeth)**
- Spawn the real daemon, connect **N=5** concurrent consumers, embed from all; assert **exactly one** `fastembedProcessHost` child exists machine-wide (the negative control: before the fix, 5 consumers ⇒ 5 hosts — the test must go RED on the pre-fix build).
- `kill -9` the daemon mid-request → every consumer gets a typed `TransientEmbeddingError`; restart the daemon → next request succeeds (no silent hang, no orphan fork).
- Backlog: `query --input '{"view":"projects"}'` with RAG enabled spawns **zero** embedding hosts (today it spawns one).
- `filter.grep` (keyword/FTS) path works with the daemon stopped — semantic inputs answer `rag_not_configured`, graph ops unaffected.

**Acceptance**
- Run `npx nx affected -t test` for `embedding-provider`, `service-proxy`, `host-runtime`; targeted `npx nx test backlog` on the adhd side. No `--skip-nx-cache`. Trust exit codes.
- Live: 30 min of normal agent traffic → ≤1 embedding host, zero `competing_host_detected`, embed p50 within the pre-defect band.

## ADR implications

- **ADR-0012 (authoritative):** the daemon holds **no store connection** — it is compute-only, so it cannot serialize store access. It is never required for graph correctness (grep/FTS always works). Concurrency is preserved by multiplexing clients onto the existing adaptive pool, not by queueing. **Do not** describe the daemon as a serialization point.
- **ADR-0013:** ⚠️ the directive's proposed mitigation (`ADHD_BACKLOG_EMBEDDING_ENABLED=false`) is compliant **only because** it maps to the pre-existing typed field `embedding.enabled` (default `false`, `env.ts:75-85`), which is the *host-injection* layer of a typed config — not a new behavior-switching var. **No new toggle var may be introduced** (e.g. no `ADHD_BACKLOG_EMBEDDING_DAEMON=1`); daemon activation is a typed `embedding.provider` selection + a supervised service, never an env gate. `SOX_FASTEMBED_LOCK_PATH`, `SOX_EMBED_EXECUTION_PROVIDER` are host config / test forcing (kept).
- **ADR-0015:** PROPOSED, never accepted — cited as prior art for the front-shim/`ensureBackend` pattern only. It does **not** authorize code, and this daemon is a *distinct* service from the backlog-store daemon it proposes. Do not conflate.
- **ADR-0004:** lock/socket/pid live under `~/.adhd/sox-ecosystem/run/` (D2) — the stable machine-global path the lock fix depends on.
- **ADR-0006 / 0016:** the daemon crosses as a live object via DI (`getSharedFastembedProcessAsync()`); no duplicated stateful bundle.
- **ADR-0007 D3/D4:** always-on launchd first; `ensureBackend` is the non-supervised fallback owned by the supervisor/doctor, not by consumers.

## Migration / rollout

1. **Immediate mitigation (today, typed config):** set `embedding.enabled=false` (already the default) so no store-opening verb forks a host. Backfill later — **note:** `tools/etl/embed-backfill.ts` **does not exist**; the real path is the `backlog admin` action `embedding_backfill` (`entrypoint/backlog/src/v2/admin.ts:1814`, `src/store/rag-ops.ts:105`; README.md:400-402 shows `admin --input '{"action":"embedding_backfill","params":{"dryRun":true}}'`). Verified present and tested (`src/v2/rag-admin.spec.ts`).
2. Publish `@adhd/sox-embedding-provider` 0.5.x (daemon client/provider + lock fix) — **0.5.1 is published but un-deployed**; the frozen CLI pins `^0.4.0`.
3. Add `extensions/services/embedding-host`; `soxe service enable embedding-host` (launchd always-on).
4. adhd: bump backlog's optionalDep to `^0.5.1`, set `embedding.provider:'daemon'`, rebuild + reinstall the global CLI.
5. Backfill via `admin(embedding_backfill)`; prove/reword the 25–50× claim.
6. Rollback: revert the provider dep + set `embedding.provider:'fastembed'` (private host) — the daemon can stay installed and idle.

## Open questions / required approvals

1. **Owner approval required** before touching `entrypoint/backlog` (adhd repo): ADR-0011 and ADR-0015 both explicitly withhold authorization to edit `@adhd/backlog`. This spec covers it; the dispatch must carry the grant.
2. Transport: UDS+JSON-RPC (reusing `sox-service-proxy`) vs loopback HTTP. Chosen UDS — research confirms UDS-first (no port collisions, 0600 filesystem scoping, stable path) and that the only reason to prefer TCP would be reusing an existing HTTP client, which this repo does not have (the `remote` provider is a zero-vector stub). An OpenAI-compatible `POST /v1/embeddings` + `/health` listener is a **possible later addition** for third-party hosts (aligns with ADR-0007 D4 / ADR-0016 publishability), but is not required by any current consumer. Confirm no cross-host need.
3. Should `getSharedFastembedProcess()` keep a sync signature (throw-if-not-daemon) or migrate all callers (`memory-core/embed.ts:19`, `fastembed.ts`) to the async accessor in one change? Spec assumes the latter.
4. `allowPrivateHost` (fork fallback) default `false` — confirm the CI/dev story (harness spawns the daemon directly).
