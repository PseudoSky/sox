# @adhd/sox-embedding-provider

## 0.6.2

### Patch Changes

- fdd0566: Backend Unix sockets are only bound or dialed inside a verified-private directory
  (BL-4041c6e0). The tier-3 socket path for an over-long socket directory is now
  `/tmp/sox-<uid>/p-<16hex>.sock` — fixed and TMPDIR-independent, so every peer
  derives the same path — instead of `$TMPDIR/sox-uds/…` or `/tmp/s-<hex>.sock`.
  `serveBackend` creates the directory 0700 and refuses (`E_UDS_DIR_UNSAFE`, no
  bind) when it is a symlink, not a directory, owned by another uid, group/other
  writable, or — for the `/tmp/sox-<uid>` root — not exactly 0700. `dialBackend`,
  `probeSocketLive`, `handshakeBackend` and `ensureBackend` refuse to connect into
  such a directory; the refusal is non-retryable (no re-dial, `ensureBackend`
  returns `errorCode: 'E_UDS_DIR_UNSAFE'`, the embedding funnel raises a
  `PermanentEmbeddingError`). New exports: `udsFallbackRoot`,
  `ensurePrivateSocketDir`, `assertPrivateSocketDir`, `isUdsDirUnsafeError`.

  Data-root directories are now created 0700 (`mkdirDataDir`), so they are private
  even under umask 002. `soxe` and the embedding funnel repair their own run dirs
  at start with the new `tightenOwnedSocketDir`: it removes group/other write
  through a single O_NOFOLLOW descriptor and skips anything it cannot prove is
  yours. An `E_UDS_DIR_UNSAFE` refusal now carries a `reason` (`foreign`,
  `own-writable`, `fallback-mode`) with a matching remediation, and no message
  suggests a recursive delete (BL-6233c1c2).

- Updated dependencies [ba7a546]
- Updated dependencies [fdd0566]
  - @adhd/sox-service-proxy@0.5.0

## 0.6.1

### Patch Changes

- 09a8beb: Recall's query-embed budget now follows the embed host, not only this process's last-success stamp (819a416b). `FunneledFastembedClient.warm` is true only while a live host connection has served an init/embed since connecting, and `FastembedProvider.readiness()` reports `{ warm, pending }`. Recall gives the 12 s cold budget when the host is not warm (retired, died, reset, never spawned) or when embeds are already queued ahead of the query (the 2026-09-26 first-recall-after-restart degradation: warm host, query queued behind a write and a heal embed, lost the 3 s race by 212 ms). A single cold-start timeout (no success yet, idle exit, host not warm) no longer opens the vec breaker (two consecutive ones do); a contended timeout still opens it at once, and the timeout guard settles after the poll phase so a reply already delivered during a main-thread stall is not reported as a timeout.

## 0.6.0

### Minor Changes

- 73474ba: Embedding host protocol v2: requests carry the model identity, the host owns
  its model init, and the host key includes a content build id (ADR-0022;
  dc73d9b6, 2fe52b0f).

  - Every `init`/`embed`/`embedBatch` request the funnel client forwards now
    carries `{model, cacheDir}`. The host loads its own model (eagerly at startup
    and on demand, memoized, re-armed after `embedding.reset`), so a host that
    never saw a client's `init` — a successor the dial layer replays to, or a
    pool a peer just reset — still serves the request. A request naming a
    different model or cache dir is refused `-32602` and surfaces as
    `PermanentEmbeddingError`.
  - The singleton key is now
    `embedding-host:v2:<buildId>:<model>:<ep>:<cacheDirDigest>`. `buildId`
    (`computeEmbedHostBuildId`) digests the host module bytes, the Node ABI and
    the arch, so two builds on one machine get two hosts and a consumer never
    dials a foreign build. A host started with a build id that is not its own
    exits 3.
  - The host takes its identity from argv (`encodeEmbedHostArgs` /
    `parseEmbedHostArgs`), not env. `EMBED_HOST_IDLE_GRACE_ENV` is removed;
    `resolveEmbedHostIdleGraceMs()` no longer reads `SOX_EMBED_HOST_IDLE_GRACE_MS`.
    `embedHostSingletonKey()` takes a fourth `buildId` argument.
  - `embedding.health` reports `protocol`, `buildId`, `hostInstanceId` and
    `modelLoaded`.

- 4e6d92e: The embedding host is a work-driven drainer (ADR-0022; 68a4bf68).

  The host retires `idleGraceMs` after its last completed init/embed/embedBatch
  once nothing is in flight and its pool has no pending requests. Connection
  count is no longer an input, so a permanently connected consumer (the memory
  front shim) no longer makes the host immortal, and health probes do not extend
  its life. `DEFAULT_EMBED_HOST_IDLE_GRACE_MS` is now 60 000. Retirement is
  ordered: the listener closes (in the same tick as the decision) before the
  private pool is terminated, and a request that arrives after the flip is
  answered `-32001` so the client retries on a successor. SIGTERM/SIGINT retire
  the same way. `embedding.health` adds `state`, `lastWorkAgoMs` and
  `reapDueInMs`.

  Keep-warm is removed with its env knobs (`SOX_EMBED_KEEPWARM_MS`,
  `SOX_EMBED_KEEPWARM_ACTIVE_WINDOW_MS`) and its exports from the `./embed-host`
  subpath (`resolveEmbedKeepWarmMs`, `shouldSkipKeepWarmTick`,
  `nextKeepWarmIntervalMs`, `resolveEmbedKeepWarmActiveWindowMs`,
  `KEEPWARM_SLOW_MS`). New exports there: `reapDueInMs`, `EmbedHostState`,
  `ERR_HOST_RETIRING`, `ERR_WRONG_MODEL`, `checkRequestIdentity`.

### Patch Changes

- 69e9915: Fix (2fe52b0f): `computeEmbedHostBuildId()` no longer trusts a per-process
  memo forever. Services here run straight out of a `dist/` rebuilt in place, so
  a long-lived spawner process can outlive many rebuilds of the host it spawns —
  the "a new build is a new process" assumption behind the old memo was false.
  Every call now re-checks a cheap stat fingerprint (name/size/mtimeMs/ino per
  file) and only re-hashes file bytes when it changed, so a rebuilt host is
  detected without recreating the client. As a backstop, `FunneledFastembedClient`
  now recognises the host's exit-3 "build id mismatch" failure, forces one full
  rehash, and retries once before counting the ensure as failed and tripping the
  circuit breaker — previously it retried the same stale id forever and stayed
  down until the consumer process was restarted. `computeEmbedHostBuildId()` also
  now throws a typed `TransientEmbeddingError` (rather than an untyped ENOENT)
  when the host directory vanishes mid-rebuild-swap.

  Also replaces two untraced empty `catch {}` blocks (`funnelClient.ts`'s
  `resetHost`, `embedHostConfig.ts`'s `resolveEmbedHostMainPath`) with traced
  `@adhd/sox-telemetry` warnings, and updates two stale doc comments that still
  described the pre-ADR-0022 "debounced, ref-counted teardown" / "debounced
  self-reap" lifecycle — the host's actual lifecycle is a work-driven retire
  (`W` after its last completed work; connections are not counted).

- af9a5bc: The BL-331 "another fastembed host process is ALREADY RUNNING" warning names
  only a genuinely competing host (cfe12302).

  The check asked only `kill(pid, 0)`, so it warned about a pid reused by an
  unrelated process, a zombie, and — most often — a member of the SAME host's
  pool after `embedding.reset` started a new pool group. The ONNX child now
  probes the lock holder once with `ps` (state, parent, start time) and
  classifies it (`classifyLockHolder`: self, dead, zombie, pid_reused,
  own_parent, pool_sibling, same_service, competing); only `competing` warns,
  and every other non-trivial verdict is logged as
  `embedding_provider.fastembed.lock_holder_ignored`. The lock now records the
  claimant's `ppid` and `procStartMs`. The parent-side reader
  (`detectCompetingFastembedHost`) applies the same classification without an
  exec on the request path, using the recorded `ppid`. A failed lock claim is
  logged instead of swallowed.

- c7cb336: The embedding host no longer inherits its spawner's identity env (6660076e).

  The host was spawned with the spawner's whole environment, including
  `SOX_SERVICE_ID`, so service teardown (`findOrphansByServiceId`) and the
  OS-truth process scan treated the shared host as memory-server's own process
  and reaped it with memory-server. `buildEmbedHostEnv()` now builds the host env
  from an allowlist (`PATH HOME USER LOGNAME LANG LC_ALL LC_CTYPE TZ TMPDIR
XDG_CACHE_HOME`, the proxy/CA variables a cold model download needs, `NODE_*`,
  `SOX_*`) and denies `SOX_SERVICE_ID`, `SOX_TELEMETRY_INIT`, `SOX_CONFIG_*`,
  `SOX_PERM_*`, `SOX_PROXY_*` and `SOX_EMBED_HOST_*`. Every denied key is logged
  by name (`embedding_provider.funnel.env_denied`) and passed to the host as
  provenance argv. Spawner provenance uses single `--flag=value` argv elements so
  a spawner's entrypoint is never a token the identity reaper matches.

- 0c31031: The embedding host records its whole lifecycle, and retirement can no longer
  end before it finishes (17a83623).

  The host writes `embedding_provider.embed_host.spawned` (build id, protocol,
  host instance id, spawner pid/service/entry, denied env keys, Node ABI),
  `listening`, `model.init{trigger}`, `reap.armed`, `reap.cancelled`,
  `reap.fired` and `exit` to its own `embed-host` jsonl. Retirement now holds
  the event loop open until it exits deliberately: previously, closing the
  listener released the last ref'd handle, so the process could drain and exit
  mid-retire, before the private pool was terminated and before `exit` was
  logged. The lifecycle is verified against a packed artifact (the real publish
  closure installed outside the workspace), and the package's test target now
  builds the package first.

- 0317e72: An in-flight embed survives the death of its host (2fadb3cd).

  The dial layer re-dials the host socket and replays unanswered requests, but
  it never spawns a host, so a request whose host died waited out the 10 s
  give-up and failed `-32001`. The funnel client now re-ensures a successor as
  soon as its connection drops with requests outstanding, retries a host-gone
  failure (`-32001` or a transport error) once within the caller's own timeout,
  and replaces a dial that has been idle-down (stale give-up clock) before a new
  request uses it. New telemetry: `embedding_provider.funnel.reconnected`,
  `.retry`, `.reensure_failed`.

- Updated dependencies [2657cb4]
- Updated dependencies [d03ac1e]
  - @adhd/sox-telemetry@0.3.2
  - @adhd/sox-service-proxy@0.4.4

## 0.5.3

### Patch Changes

- fix(embedding-provider): the funnel host survives an `embedding.reset` and never reaps over in-flight work; the idle bound is typed config.

  `embedHostMain` now resolves `getPrivateFastembedProcess()` at **every** use — a captured reference was terminated by `embedding.reset`, so every later request failed with `shared fastembed process terminated`. The self-reap now gates on the host's own request depth (incremented before the first `await`, decremented in `finally`) instead of the private pool's `pendingCount`, which misses the cold-start fork prefix. `EmbeddingProviderConfig.idleGraceMs` is now the typed surface for the idle bound (default 30 s); the spawner forwards the resolved value to the spawned host via the internal `SOX_EMBED_HOST_IDLE_GRACE_MS` transport.

  `@adhd/sox-service-proxy` guards the optional `onClientCountChange` hook so a throwing observer cannot crash the connection callback.

  Teeth (`embed-funnel.spec.ts`): reset→init+embed (shared + private), mid-work reap survival, a non-default typed grace taking effect, and `terminate()`-is-a-no-op.

- Updated dependencies
  - @adhd/sox-service-proxy@0.4.2

## 0.5.2

### Patch Changes

- ce4e16d: feat(embedding-provider): peer-spawned, self-reaping embedding funnel — N consumer processes share ONE
  ONNX host per `(model, execution-provider, cacheDir)`, with no supervised daemon (ADR-0020).

  `getSharedFastembedProcess()` is now host-aware. By default (`host: 'shared'`) it returns a
  `FunneledFastembedClient` that lazily dials — and, when absent, peer-spawns via `ensureBackend()`'s
  O_EXCL singleton spawn-lock — one detached `embedHostMain` process. The host forwards `embedding.*`
  payloads to its private pool and **reaps itself**: a debounced, ref-counted teardown keyed on live UDS
  client connections (`serveBackend`'s new `onClientCountChange` hook) plus in-flight `pendingCount`
  exits the host `IDLE_GRACE_MS` after the last client leaves. It is compute-only (ADR-0012) — no store
  connection — and never supervised.

  Honest failure: under `host: 'shared'` a failed ensure throws a typed `TransientEmbeddingError` and
  forks **zero** hosts; it never silently falls back to a private host. `terminate()` is a no-op for a
  shared host; `resetSharedFastembedHost()` is the heal path. Host selection is the typed
  `EmbeddingProviderConfig.host` closed union (default `'shared'`, reported in `health().host`), never an
  env toggle (ADR-0013).

  The eager factory warmup is removed, so `createEmbeddingProvider()` is inert — it loads no model and
  spawns no host until the first real embed. A read-only verb therefore spawns zero hosts. The
  25–50× Neural-Engine contention claim is reworded to hypothesis framing (it was never proven; the
  measured cause of the live slowdown was scheduling QoS).

  Teeth (`embed-funnel.spec.ts`): 5 concurrent consumer processes collapse to exactly one host (negative
  control: the pre-fix/private path forks 5 — the headline test goes RED against it); debounce-reuse of
  the same host pid; rendezvous race; crash + stale-socket recovery; no-silent-re-fork; `lsof` proves the
  host holds no store-db handle; provider construction spawns zero hosts.

  `@adhd/sox-service-proxy` gains the optional `ServeBackendOptions.onClientCountChange` lifecycle hook
  (the live client-connection count on every connect/disconnect). Additive and observational — every
  existing caller is unchanged.

- Updated dependencies [ce4e16d]
  - @adhd/sox-service-proxy@0.4.1

## 0.5.1

### Patch Changes

- dde7c65: fix(embedding-provider): record the owning service in the BL-331 fastembed host lock and suppress a
  same-service competing lock (BL-432).

  The advisory fastembed-host lock stored only `{ pid, startedAt, poolGroup? }`, so the BL-331 warning
  named a bare pid and fired on the sequential-CLI false positive — a single service's own earlier or
  second host. `FastembedLockInfo` now carries `service`, resolved from `SOX_FASTEMBED_SERVICE`
  (mirroring `SOX_FASTEMBED_POOL_GROUP`), the warning prints the service name, and a competing lock
  owned by the same service is suppressed rather than warned about. `competing_service` and
  `competing_host_service` are added to telemetry, so genuine cross-service contention is
  distinguishable from the self-contention case.

  `sharedFastembedProcess.ts` threads `SOX_FASTEMBED_SERVICE` into the fork env and surfaces the
  competing service in `detectCompetingFastembedHost`. Writer, reader, and end-to-end telemetry tests
  ship with negative controls.

- Updated dependencies [fa6c724]
  - @adhd/sox-telemetry@0.3.1

## 0.5.0

### Minor Changes

- 884e3e7: Public API surface changed since the last publish.

  Each of these packages has `dist/*.d.ts` differing from the version currently on
  npm, with no changeset recording it — the drift the `check-changeset-surface` gate
  exists to catch. This changeset records it and ships the accumulated surface.

  The READMEs shipped alongside are rewritten and verified: every documented symbol
  is checked against that package's own built declarations, and every example is one
  that was executed against the built artifact.

  `@adhd/sox-memory-core` also corrects three source comments that asserted ADR-0007's
  single-writer architecture as current fact. ADR-0012 supersedes it — the default
  Turso backend runs `multiprocess-wal`, where multiple processes hold concurrent
  write connections to one store file, serialized through a `-tshm` coordinator, with
  no opt-out. Because those comments are emitted into the shipped `.d.ts`, the false
  claim was visible in consumers' editor tooltips.

### Patch Changes

- Updated dependencies [884e3e7]
  - @adhd/sox-telemetry@0.3.0

## 0.4.1

### Patch Changes

- Stop `terminate()` re-forking a fastembed child process (BUG-MEMORYSERVER-SHUTDOWN-LEAKS-FASTEMBED-CHILD-001). `SharedFastembedProcessClient` now carries a permanent `terminated` flag; `ensureProcess()` refuses to fork once shutdown has begun, so a cache-hit warmup retry racing `coordinatedShutdown` can no longer spawn an untracked orphan `fastembedProcessHost.js` child.

## 0.4.0

### Minor Changes

- **graph-store**: `engineIdentity` and `supportsRecursiveCte` now resolve correctly under the adapter's lazy-connect (BL-580/BL-581) — both previously snapshotted at construction, so `engineIdentity` cached `null` permanently and `supportsRecursiveCte` read a value captured before any connection existed. Backup residue is now reclaimed with a bounded sweep. A semicolon inside a SQL comment was being split into a phantom statement. Indexed the predicate the hot queries actually use, across all three DDL surfaces — a 11.9s delete became 15ms.

  **embedding-provider**: fastembed child pooling is concurrency-adaptive with abort plumbing (BL-575/576), breaking embed head-of-line blocking. The pool's grow trigger now has a real time dimension rather than firing on instantaneous depth, and auto-sizing accounts for macOS reclaimable memory — `os.freemem()` excludes inactive/speculative/purgeable pages, so the pool previously sized itself against a number far below the memory actually available.

  **blob-store**: internal workspace dependency ranges float (`workspace:^`) so published consumers are not pinned to an exact internal version.

### Patch Changes

- Updated dependencies
  - @adhd/sox-telemetry@0.2.1

## 0.3.0

### Minor Changes

- d0644be: Add `WARMUP_CACHE_HIT_ATTEMPTS` and `warmupOuterBudgetMs()` exports. A cache-hit fastembed warmup now retries up to `WARMUP_CACHE_HIT_ATTEMPTS` (2) times at the existing tight per-attempt budget (`warmupTimeoutMs(true)`, unchanged from BL-376) instead of giving up after a single attempt — a cold-but-cached load that merely took slightly longer than one tight window (e.g. under OS scheduling pressure) no longer strands the shared fastembed child process mid-load while the caller gives up and forgets it ever asked (BUG-EMBED-WARMUP-CACHEHIT-ASSUMES-FAST-LOAD-001). Cache-miss warmups are unaffected: still exactly one attempt at the existing 180s default budget.

## 0.2.0

### Minor Changes

- 32275f7: Breaking: `warmupTimeoutMs` gained a required, non-optional parameter.

  ```
  -export declare function warmupTimeoutMs(): number;
  +export declare function warmupTimeoutMs(cacheHit: boolean): number;
  ```

  Any consumer calling `warmupTimeoutMs()` with zero arguments — the only legal call under the
  published `0.1.0` signature — now fails to compile. This is a required-parameter addition to an
  existing exported function, not an additive change: the old call site is a type error under the new
  `dist/index.d.ts`, so major is correct regardless of how trivial the call-site fix is (BL-376).

  Also additive in this release (does not affect the bump, recorded for changelog completeness):
  new exports `isPidAlive`, `checkAndClaimFastembedLock` (`fastembedProcessHost.d.ts`), `isModelCached`
  (`index.d.ts`), a new `fastembedLock.d.ts` module exporting `FastembedLockInfo` and
  `resolveFastembedLockPath` (BL-471), a new optional `EmbeddingProviderMetadata.execution_provider?:
string` field, a new `SharedFastembedProcessClient`-accepting constructor overload, and
  telemetry-carrying JSDoc on `request()`/`terminate()` (BL-432/BL-405, comment-only).
