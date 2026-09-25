# SPEC — Embedding Funnel: a peer-spawned, self-reaping shared ONNX host (NO managed service)

Architect: architect (spec only). Date: 2026-09-22.
Repos: `sox-ecosystem` (provider + service-proxy, primary) and `adhd` (consumer: `entrypoint/backlog`).
**Supersedes `SPEC-EMBEDDING-HOST.md` (REJECTED by owner — "I do not approve a managed service for embedding").** The launchd/supervised `extensions/services/embedding-host` design is withdrawn; nothing in this document is supervised.
ADR catalog checked (`sox-ecosystem/docs/decisions/`, 0001–0018). ADR-0012 authoritative; ADR-0013, ADR-0007 D3, ADR-0004, ADR-0006/0016, ADR-0011, ADR-0015 load-bearing.
**Read-only on code. One spec doc written. No implementation authorized by this document.**

## Summary

Make the existing per-process singleton `getSharedFastembedProcess()` **host-aware** so that N consumer processes share ONE fastembed host per `(model, execution-provider)` **without any supervised daemon**. The host is a plain detached Node process **spawned on demand by the first consumer** through the already-shipped, race-tested `ensureBackend()` O_EXCL singleton spawn-lock (`libs/service-proxy`), and it **reaps itself** as a work-driven drainer ([ADR-0022](docs/decisions/0022-embedding-funnel-is-a-work-driven-drainer.md)): it retires `idleGraceMs` (default 60 s) after its last completed work; connections never keep it alive. The two halves of the user's remembered "debouncing drainer" map cleanly onto primitives: **`ensureBackend` = funnel-to-1** (collapses a thundering herd of spawn attempts to one), **work-driven retirement = the drainer** (retires the host `W` after its last completed work). No env toggle, no supervisor, no `KeepAlive`; the host is compute-only and holds **no store connection** (ADR-0012). The funnel lives entirely inside `@adhd/sox-embedding-provider`, so consumers need no call-site change.

## Part 1 — archaeology (what the mechanism was, where it lives, the diff)

- **No cross-process debouncing drainer exists in `backlog` — on any branch, in any history.** What exists is *per-process*: `entrypoint/backlog/src/store/embed-queue.ts` (on `main`) tracks a per-store `WeakMap<GraphBacklogStore, Set<Promise>>` and `flushEmbeds()` drains it (`embed-queue.ts:45,90-97`); the unmerged `feat/backlog-hard-replacement` branch re-keys the same shape per-adapter (`src/write/embed-drain.ts`, added `b335c0ae`) plus a write-layer `src/write/embedding-observer.ts`. Both are in-process; neither crosses a process boundary.
- **The intended cross-process funnel was SPECIFIED but NEVER WIRED.** `docs/spec/backlog/PLUGIN_ARCHITECTURE.md:75,116` — "`ensureBackend` … O_EXCL singleton spawn-lock — many consumer processes collapse to ONE daemon" / "all consumers collapse to ONE ONNX process per model per host"; `entrypoint/backlog/RAG-SPEC.md:17` — "the embedding daemon … backlog is a client via the `embedding-remote` plugin." That plugin **never existed in any revision**; `@adhd/sox-service-proxy` is **not a dependency of backlog at all**. So the "funnel to 1 across all procs" was designed and delegated upstream, never consumed.
- **`111c19bd`** (`chore(backlog): delete the dead RAG modules and the embed drain`) exists **only on `feat/backlog-hard-replacement`** — not on `main`. The caller's "deleted at `111c19bd^`" describes the branch's pre-deletion state.
- **Provider side:** `getSharedFastembedProcess()` is a module-level per-process singleton (`sharedFastembedProcess.ts:1623,1654-1662`) → forks N hosts. The adaptive pool's debounced shrink (`SHRINK_IDLE_MS=60_000`, "not a rapid drain to `minSize`", `:1509-1544`) is **in-process/demand-based** (`pendingCount` = this process's in-flight requests). `refForPending()`/`unrefIfIdle()` (`:532-543`) ref-counts **this client's own requests**, not consumers. `fastembedLock.ts` is **not a lock** (path/payload helpers only); the real claim (`fastembedProcessHost.ts:134-212`) is non-atomic `existsSync`/`readFileSync`/`writeFileSync` and **advisory-only** — it never blocks a fork, always overwrites, intended purely as a loud warning. `checkAndClaimFastembedLock()`'s result is discarded (`:280`).
- **The reusable funnel primitive already exists and is peer-spawned, not managed:** `ensureBackend()` (`ensure-backend.ts:309-352`) — `fs.openSync(lockPath,'wx')` atomic O_EXCL spawn lock keyed by the singleton key (`:226-234`), stale-lock reclaim (`:242-262`), dispositions `already-live|spawned|adopted-after-wait|failed`, `detached:true` + `child.unref()` so the backend **outlives the spawner** (`:408-424`), readiness handshake, no supervisor. It has **no refcount and no last-consumer teardown** — that is the net-new part.
- **The exact gap:** the funnel's *coordination* half exists (`ensureBackend`); the funnel's *lifecycle* half (host-aware accessor + debounced self-teardown) was never built, and backlog never consumed the coordination half.

## Files

| Path | Change | Read | Output |
|---|---|---|---|
| `libs/service-proxy/src/backend.ts` | modify (`onClientCountChange` hook) | 60 | 40 |
| `libs/data/embed/embedding-provider/src/embedHostConfig.ts` | create | 0 | 130 |
| `libs/data/embed/embedding-provider/src/embedHostMain.ts` | create (host entrypoint) | 0 | 220 |
| `libs/data/embed/embedding-provider/src/funnelClient.ts` | create | 0 | 230 |
| `libs/data/embed/embedding-provider/src/sharedFastembedProcess.ts` | modify (split private/funnel accessor) | 120 | 160 |
| `libs/data/embed/embedding-provider/src/index.ts` | modify (typed `host` field + exports) | 60 | 90 |
| `libs/data/embed/embedding-provider/package.json` | modify (dep + `exports` subpath) | 30 | 30 |
| `entrypoint/backlog/src/store/semantic-search.ts` (adhd) | modify (remove eager warmup) | 120 | 60 |
| `entrypoint/backlog/package.json` (adhd) | modify (dep bump) | 20 | 15 |
| `libs/data/embed/embedding-provider/src/embed-funnel.spec.ts` | create (teeth) | 0 | 240 |

## Interface changes

### `service-proxy/src/backend.ts` — `ServeBackendOptions` (BEFORE → AFTER)

```ts
// AFTER — add one optional lifecycle hook (backend.ts's `sockets` Set is the source of truth)
export interface ServeBackendOptions {
  socketPath: string; handler: BackendHandler; onDiagnostic?: (l: string) => void; inheritFd?: number;
  /** NEW: called with the live client-connection count on every connect/disconnect. */
  onClientCountChange?: (active: number) => void;
}
```
Call `opts.onClientCountChange?.(sockets.size)` after `sockets.add(socket)` (backend.ts:106) and after `sockets.delete(socket)` (:121).

### New: `embedHostConfig.ts`

```ts
export interface EmbedHostConfig { host: 'shared' | 'private'; socketDir: string; idleGraceMs: number; }
export function resolveEmbedHostConfig(): EmbedHostConfig;         // typed; host default 'shared'
export function resolveEmbedHostSocketDir(): string;               // SOX_ECOSYSTEM_HOME/run (ADR-0004)
export function embedHostSingletonKey(modelId: string, ep: string, cacheDir: string, buildId: string): string;
// key: embedding-host:v2:<buildId>:<model>:<ep>:<cacheDirDigest>; buildId = computeEmbedHostBuildId(hostMainPath)
export function embedHostSocketPath(cfg: EmbedHostConfig, key: string): string; // backendSocketPath(socketDir,key)
export function resolveEmbedHostMainPath(): string;                // require.resolve('@adhd/sox-embedding-provider/embed-host')
```

### New: `embedHostMain.ts` (the host process — spawned, never supervised)

```ts
// handler methods: embedding.init | embedding.embed | embedding.embedBatch | embedding.reset | embedding.health
export async function runEmbedHost(argv?: readonly string[]): Promise<void>; // identity from argv (parseEmbedHostArgs)
export function reapDueInMs(a: { state; inFlightWork; poolPending; lastWorkAt; now; idleWindowMs }): number | null;
```
Uses `serveBackend({socketPath, handler})`. Every `init`/`embed`/`embedBatch` request carries `{model, cacheDir}`; the host refuses a foreign model with -32602, loads its own model through a memoized `ensureModel` (eagerly at startup, and again after `embedding.reset`), and forwards to `getPrivateFastembedProcess()` — resolving the accessor **at every use** and never the funnel accessor, so there is no recursion. Retirement is work-driven (ADR-0022): `reapDueInMs` returns null while work is in flight or the pool has pending requests, otherwise `lastWorkAt + W − now`. On 0 the host retires in order: flip to `retiring` and `handle.close()` in one tick (the inode-guarded unlink never removes a successor's socket), then terminate the pool, then exit 0. A frame arriving after the flip gets -32001 and the client retries through a fresh ensure.

### New: `funnelClient.ts`

```ts
/** SharedFastembedClient that transparently dials/spawns the peer-shared host. */
export class FunneledFastembedClient implements SharedFastembedClient {
  request<T>(payload: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal): Promise<T>;
  terminate(): Promise<void>;   // NO-OP for 'shared' — never kill the peer host
  get started(): boolean;
  get pendingCount(): number;
}
export async function resetSharedFastembedHost(): Promise<void>; // host `embedding.reset` (or kill+re-ensure)
```

### `sharedFastembedProcess.ts` (BEFORE → AFTER)

```ts
// BEFORE: getSharedFastembedProcess() built the per-process pool directly (lines 1654-1662).
// AFTER:
export function getPrivateFastembedProcess(): SharedFastembedClient { /* the OLD body, unchanged */ }
export function getSharedFastembedProcess(): SharedFastembedClient {
  if (_singleton) return _singleton;
  if (resolveEmbedHostConfig().host === 'private') return (_singleton = getPrivateFastembedProcess());
  return (_singleton = new FunneledFastembedClient());   // lazy: resolves host on first request()
}
```

### `index.ts` — typed config + exports

```ts
export interface EmbeddingProviderConfig { type: string; model: string; options?: Record<string, unknown>;
  host?: 'shared' | 'private'; }   // NEW typed field, default 'shared'; reported in health()
export { FunneledFastembedClient, resetSharedFastembedHost } from './funnelClient.js';
export { getPrivateFastembedProcess } from './sharedFastembedProcess.js';
```

## Behavioral changes

### `funnelClient.ts` — resolve-once, honest failure
- **First `request()`**: probe `probeSocketLive(socketPath)`; if not live → `ensureBackend({socketPath, singletonKey, command: process.execPath, args: [resolveEmbedHostMainPath()], env: {...embedConfig}, stderrLogPath, readyTimeoutMs: 10_000})`. `'failed'` ⇒ throw typed `TransientEmbeddingError` naming the socket (bounded, never hang). Then `dialBackend({socketPath, onDisconnect: re-ensure})` and send JSON-RPC `embedding.request`.
- **Never silently re-fork**: `host:'shared'` (default) never falls back to a private host on failure. `host:'private'` is the explicit CI/diagnostics selection (closed union — ADR-0013 border), reported in `health()`.
- **Circuit breaker**: after K consecutive failed ensures, fail fast for a short cooldown (typed error) so 535 short-lived CLIs/day do not each pay the full 10 s bound.
- `terminate()` is a **no-op** for `'shared'` (the host is shared; a consumer must never kill it).

### `embedHostMain.ts` — work-driven retirement (the drainer, ADR-0022)
- The only inputs are **work**: the host's in-flight init/embed/embedBatch count (incremented synchronously, so it covers the cold-start fork prefix) and the private pool's `pendingCount`. Connections, health probes and resets are not inputs; there is no keep-warm.
- With nothing in flight, the host retires `W` after its last completed work. `W` is typed config (`EmbeddingProviderConfig.idleGraceMs` → `EmbedHostConfig.idleGraceMs`, default `60_000`), forwarded to the host as `--idle-window-ms`.
- Retire: flip to `retiring` + close the listener (destroys client sockets; inode-guarded unlink) → terminate the local pool → exit 0. `detached:false` on the ONNX child means it dies with the host — no orphans.
- The host is spawned with an allowlisted env (no `SOX_SERVICE_ID`, `SOX_CONFIG_*`, `SOX_PERM_*`, `SOX_PROXY_*`, `SOX_TELEMETRY_INIT`, `SOX_EMBED_HOST_*`), so no service's reaper treats it as its own.
- The host **forks the ONNX pool itself**; the pool's own adaptive ceiling (`resolveFastembedPoolCeiling()`) is now computed **once machine-wide**, not N times.

### `entrypoint/backlog` (adhd) — consumer
- **No funnel wiring required**: `semantic-search.ts:362` → `createEmbeddingProvider({type:'fastembed'})` → `fastembed.ts:79` → `getSharedFastembedProcess()`, now host-aware. The funnel is transparent.
- Remove the eager warmup so a read-only verb (`query --input '{"view":"projects"}'`) does not spawn a host: construct the provider lazily on first semantic use. Leave `bootstrapSemanticBackend`'s failure taxonomy (`failure.reason:'provider_failed'` → `null` → RAG unconfigured) untouched.
- `package.json`: bump `@adhd/sox-embedding-provider` to the release carrying this. **ADR-0011 withholds authorization to edit `@adhd/backlog`** — the dispatch must carry the grant.

### `fastembedLock.ts` (advisory, unchanged role)
Its path should move to the stable `SOX_ECOSYSTEM_HOME/run/` dir (kills the `tmpdir()` split-lock) so `'private'` mode's competing-host warning is coherent — but it remains **advisory-only**; the funnel does not depend on it.

## Independent segments

| # | Segment | Files | Depends | Read | Output |
|---|---|---|---|---|---|
| A | `serveBackend` lifecycle hook | `service-proxy/src/backend.ts` | — | 60 | 40 |
| B | Config + socket/singleton resolution | `embedHostConfig.ts` | — | 0 | 130 |
| C | Host process + work-driven retirement | `embedHostMain.ts` | A,B | 0 | 220 |
| D | Funnel client + accessor split | `funnelClient.ts`, `sharedFastembedProcess.ts`, `index.ts`, `package.json` | B,C | 180 | 480 |
| E | backlog consumer | `semantic-search.ts`, `package.json` (adhd) | D | 140 | 75 |
| F | Teeth suite + reword 25–50× claims | `embed-funnel.spec.ts` | C,D | 40 | 240 |

## Execution strategies (weaker executors)

**A** — Add the optional callback only; do not touch the probe/bind/`E_LIVE_SOCKET` logic. Emit it exactly at `sockets.add`/`sockets.delete`. Never make it required.
**B** — Pure functions, zero imports beyond `node:path`/`node:os` and `@adhd/sox-service-proxy`'s `backendSocketPath`. `host` default `'shared'`; read no env toggle.
**C** — 40 lines of glue: `serveBackend` + handler forwarding to `getPrivateFastembedProcess()` + the `onClientCountChange`/`pendingCount` teardown timer. NEVER import `getSharedFastembedProcess()` (recursion). Never add an env activation gate.
**D** — Split the existing accessor into `getPrivateFastembedProcess()` (old body) and the funnel accessor; add `FunneledFastembedClient`. `terminate()` no-ops on `'shared'`. Add `@adhd/sox-service-proxy` as a dep and an `exports` subpath `"./embed-host"` → `dist/embedHostMain.js` (leaf→leaf; no cycle). Keep `SharedFastembedClient`'s shape unchanged.
**E** — Change only the two files; delete the eager `embedSingle('warmup')` at construction and make the backend lazy. Do not restructure the failure taxonomy.
**F** — Extend the existing pool harness; the negative control must go RED on the pre-fix build.

## Test cases (teeth)

- **Funnel-to-1 (headline):** N=5 real concurrent consumer processes each embed once ⇒ assert **exactly one** `embedHostMain` pid and one ONNX child machine-wide. **Negative control:** the pre-fix build spawns 5 — the test MUST be red there.
- **Debounce:** one consumer brings the host up, all clients exit; host exits after ~`idleGraceMs` (await the exit event, no sleep). A second burst inside the grace window reuses the **same host pid** — if grace were 0 it re-spawns and the test goes red.
- **Rendezvous race:** two concurrent `ensureBackend` calls for the embedding singleton ⇒ exactly one host; the loser is `adopted-after-wait`.
- **Crash recovery:** `kill -9` the host mid-request ⇒ every consumer gets a typed `TransientEmbeddingError` within bound; the next request re-ensures and succeeds; no orphan, no hang.
- **Stale socket:** SIGKILL the host leaving the socket file ⇒ the next consumer re-ensures (no `E_LIVE_SOCKET` deadlock).
- **No silent re-fork:** `host:'shared'` + forced `ensureBackend` failure ⇒ consumer throws typed error and forks **zero** hosts; backlog leaves the item FTS-only (vector absent, FTS present).
- **ADR-0012 teeth:** `lsof` on the host pid shows **no** store-db handle (compute-only).
- **Backlog:** `query --input '{"view":"projects"}'` with RAG enabled spawns zero hosts.
- Trust exit codes; run `npx nx affected -t test` for `embedding-provider` + `service-proxy`; no `--skip-nx-cache`.

## ADR implications

- **ADR-0012 (authoritative):** the host is **compute-only** — no store connection, so it cannot serialize store access and must never be described as single-writer or as a store serialization point. Concurrent store writers are unaffected.
- **ADR-0013:** no behavior-switching env var. Host selection is the typed `EmbeddingProviderConfig.host` closed union (default `'shared'`), reported in `health()`. The idle bound is likewise typed config — `EmbeddingProviderConfig.idleGraceMs` → `EmbedHostConfig.idleGraceMs`, which the spawner forwards to the host as `--idle-window-ms` argv; this supersedes D3's env-tuning classification per the owner directive. The socket dir is host config (D5).
- **ADR-0007 D3:** its decision ("activation posture is configuration") is satisfied — this implements the **non-supervised** posture it explicitly names ("The `ensureBackend` spawn path remains the non-supervised fallback"). It **departs from D3's ordering** ("always-on ships first"), which the owner's constraint overrides. **Propose ADR-0019** ("embedding funnel is peer-spawned and self-reaping; no managed service") — drafted only, **not written without owner approval**.
- **ADR-0015:** PROPOSED, never accepted; it proposes a *backlog store* daemon. **Do not conflate** — this is a distinct, compute-only host and this spec does not implement ADR-0015.
- **ADR-0011:** editing `entrypoint/backlog` requires the dispatch to carry the grant.
- **ADR-0004 / 0006 / 0016:** socket under `SOX_ECOSYSTEM_HOME/run/`; the host crosses as a live object via DI (the accessor); no duplicated stateful bundle.

## Open questions

1. **Confirm the peer-spawned host is acceptable** as "not a managed service": it is spawned by a consumer (never supervised), outlives the spawner, and self-reaps after `idleGraceMs`.
2. `idleGraceMs` default (60 s, ADR-0022) vs the cost of a ~200–400 MB host lingering during the grace window.
3. Should `memory-core`'s heal (`reinitEmbedProvider`, BUG-MEMORYSERVER-EMBED-HEAL-NOOPERATOR-001) route through `resetSharedFastembedHost()` (host `embedding.reset`)? Its current `terminate()`-then-refork no longer applies once the accessor is funneled.
4. Provider upgrade staleness: a running host is an old build — should the singleton key include the provider version?
5. Owner approval for ADR-0019, and the ADR-0011 grant to edit `entrypoint/backlog`.
