# FROZEN CONTRACTS — runtime-productionization

Every interface two contexts (or two packages) both touch, pinned before execution.
**Executors implement these verbatim. Changes require owner sign-off via a `blockers`
entry — never a unilateral edit.** Where a contract names an existing symbol, the
citation is the source of truth for its current shape.

## A. The invariant (restated)

At most one process may hold a write connection to a given store, and that process is
the one activated on the store's socket. Violations must fail loudly (structured error,
refused start), never silently.

## B. Storage error taxonomy (BL-124)

All storage-layer failures surfaced by any `memory_*` tool use this shape — a raw
driver exception (`SqliteError`, ENOENT, …) reaching a caller is a defect:

```jsonc
{ "code": "E_BUSY" | "E_IO" | "E_ALLOWLIST" | "E_DEDUP" | "E_NOT_FOUND" | "E_STORE_MISMATCH",
  "message": "human-readable",
  "retryable": true | false,          // E_BUSY: true; E_DEDUP: see §F; others: false
  "retry_after_ms": 250,              // present iff retryable
  "details": { }                      // optional, code-specific (E_DEDUP: existing_uid)
}
```

`E_DEDUP` and `E_NOT_FOUND` keep their existing semantics (memory-core today).
`E_STORE_MISMATCH` is new: schema/artifact/embed-model stamp mismatch at open (§G).

## C. Write path (BL-118, 125, 129)

- Every connection: `PRAGMA busy_timeout = 3000`, `journal_mode = WAL`,
  `synchronous = NORMAL`. Read-only connections additionally `query_only = ON`.
- All mutations route through ONE in-process write queue (single connection, FIFO,
  group commit permitted). Queue overflow → `E_BUSY {retryable:true}`.
- `memory_write_batch({db_path|store, items: [<memory_write payload>...]})` →
  `{results: [{ok:true, episode_uid} | {ok:false, code, message}] }` — one queue entry;
  chunked transactions allowed; per-item `E_DEDUP` is `ok:false, code:"E_DEDUP"` with
  `details.existing_uid`, and is NOT a batch failure.
- Idempotency: optional `client_request_id` (string ≤128) on `memory_write` and per
  batch item. Replay of a known id returns the original result with `"replayed": true`.
  Ledger: table `request_ledger(request_id TEXT PRIMARY KEY, episode_uid TEXT,
  created_at)`, pruned >7 days on the checkpoint tick.

## D. Package dependency direction (must not change)

```
apps/sox → {install-engine, host-registry, host-runtime, manifest, service-proxy}
memory-server (ext) → {memory-core, mcp-runtime, service-proxy}
memory-core → {graph-store, vector-store, hybrid-search, analysis, embedding-provider}
mcp-runtime → host-runtime
analysis → {vector-store, graph-store}
hybrid-search → {embedding-provider, graph-store, vector-store}
embedding-provider, service-proxy → leaves (node builtins only)
```
`@adhd/sox-ingest` stays `private:true`. No upward or circular edges.

## E. Embedding provider extension (BL-147, owner-reusability constraint)

`@adhd/sox-embedding-provider` gains (implemented there, consumed everywhere):

```ts
interface EmbeddingHealth {
  configured: string;      // e.g. 'fastembed:bge-base-en-v1.5'
  active: string | null;   // null until warm — NEVER a placeholder model name
  state: 'uninitialized' | 'warming' | 'real' | 'hash-fallback' | 'error';
  dimensions: number | null;
  last_error: string | null;
}
provider.health(): EmbeddingHealth
```

One shared worker-thread ONNX host lives in this package; memory-core’s
`embedWorker.ts`, hybrid-search’s `cross-encoder.ts` worker, and claim-verification’s
`worker.ts` migrate onto it. memory-core deletes `embed.ts` and keeps only a ping/stats
adapter over `provider.health()`. `SOX_EMBED_BACKEND` env compat: `auto|real|hash` maps
to provider config `{type:'fastembed'} / {type:'fastembed', strict} / {type:'hash'}`.

## F. Outbox + watermark (BL-126, 127)

The existing `organizer_queue` table IS the outbox — formalized, not replaced:
ordered by `(priority ASC, seq ASC)`, an item is complete when `done_at` is set;
failed items get `attempts += 1`, `last_error`, and move to `dead` state after 5
attempts (new columns; additive migration). The generic orchestrator lives in
`@adhd/sox-analysis`, signature:

```ts
runOutboxPass(deps: {graph: GraphBackend, vectors: VectorBackend,
                     embed: EmbeddingProvider, queue: OutboxQueue,
                     limits?: {batchRows?: number /*default 50*/}}): Promise<PassReport>
```

No memory schema knowledge inside. Watermark = highest `seq` with `done_at` set,
exposed as `enrichment_watermark` (§H) and awaited via
`memory_flush({await_seq?, timeout_ms=10000})` → `{watermark, caught_up: boolean}`.

## G. Store identity stamp (BL-121, BL-144 residual)

Table `sox_store_meta(key TEXT PRIMARY KEY, value TEXT)` with keys:
`schema_version`, `writer_artifact` (sha256 short), `embed_model`, `embed_dimensions`.
On open-for-write: absent → stamp; mismatch → `E_STORE_MISMATCH` (message names both
sides and the remediation). Embed-model pinning enforcement lives in
`@adhd/sox-vector-store` alongside its existing dimension invariant.

## H. memory_ping response (BL-122, 131)

Extends the current shape — existing keys keep their exact names:

```jsonc
{ "ok": true, "id": "memory-server",
  "artifact": "sha256:…", "short": "…", "host_compat": "…",
  "embed": { /* EmbeddingHealth, §E */ },
  "instance": { "pid": 123, "started_at": "ISO", "transport": ["stdio","uds","http"],
                "instance_id": "<uuid-per-process>" },
  "store":    { "name": "default", "path": "/abs/path", "fingerprint": "sha256:…12",
                "wal_bytes": 0, "last_checkpoint_at": "ISO|null",
                "enrichment_watermark": 0, "queue_depth": 0 }   // store block present when a store is open
}
```
Legacy top-level `embed_model`/`embed_state`/`last_embed_error` keys remain for one
minor version, derived from `embed`.

## I. Config keys (memory-server `config_schema`; soxe cascade → `SOX_CONFIG_*`)

| key | type | default | notes |
|---|---|---|---|
| `activation_posture` | `"always-on" \| "on-demand"` | `"on-demand"` | read at os-unit generation; `soxe config set` triggers the existing restartOsUnit hook |
| `transports` | array of `"stdio" \| "uds" \| "http"` | `["stdio","uds","http"]` | which listeners the backend binds |
| `http_port` | int | `3000` | pinned default so generated `:3000` URLs are correct-by-construction (BL-148); host-config generation MUST read this key, never a literal |
| `bind_address` | string | `"127.0.0.1"` | non-loopback requires `auth_token` set — refuse to start otherwise |
| `auth_token` | string (env-ref, e.g. `${SOX_MEMORY_TOKEN}`) | unset | bearer checked on every HTTP request when bind is non-loopback (or when set) |

## J. Writer lease (BL-128)

File `<store>.writer.lock` beside the db: `flock`-held (not just created) by the writer
for the life of the process, content `{pid, instance_id, acquired_at, artifact}`.
Open-for-write requires acquiring the lease; failure → `E_BUSY` naming the holder.
Graceful shutdown: drain queue → `wal_checkpoint(TRUNCATE)` → release lease.

## K. Baselines (captured BEFORE any deletion — context 02, item RS-0)

`_shared/baselines/enrichment-parity.json`: counters from one full daemon-driven batch
pass over a snapshot copy of a real store (`communities`, `member_of`, `importance_updated`,
`relates_to`, node/edge counts) + the store snapshot's sha256. Phase-2 parity means the
migrated orchestrator over the SAME snapshot is within ±2% on every counter.
`_shared/baselines/write-perf.json`: p50/p99 of 100 sequential `memory_write` calls on
the pre-change build.
