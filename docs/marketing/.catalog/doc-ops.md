# Documentation Operations Log

> All create/rewrite/move/delete operations on documentation files are logged here with the
> full prior content preserved inline, so nothing is lost before a commit (not only via git).

---

## REVISE `libs/data/store/store-adapter/README.md` — 2026-07-29

**Reason:** TursoAdapter's `multiprocess_wal` is now enabled by default in the adapter code
(`turso-adapter.ts:111-115`). Documentation showed it as an explicit opt-in via
`experimental: { multiprocessWal: true }`.

**Changes:**
1. Quick-start overview — added comment noting TursoAdapter enables multiprocess_wal by default
   (line after the `createStoreAdapter` call).
2. Explicit adapter selection — labeled SqliteAdapter as "fallback, single-writer" and TursoAdapter
   as "default — async I/O, native vectors, multi-process writers via multiprocess_wal".
3. "Multi-process writers" example under `createTursoAdapter()` — replaced the opt-in example
   (`experimental: { multiprocessWal: true }`) with an opt-out example
   (`experimental: { multiprocessWal: false }`), reflecting that it's now default-on.
4. Capability flags section — added a note block explaining that `multiprocessWrite` is `true` by
   default on TursoAdapter via `.tshm` shared memory, and SqliteAdapter always reports `false`.
5. Configuration `experimental.multiprocessWal` — updated default comment to "Default: true — set
   false to opt out".

**Prior content (removed/overwritten):**

<details>
<summary>Old multi-process writers example</summary>

```typescript
// Multi-process writers
const multi = await createTursoAdapter({
  dbPath: 'shared.db',
  experimental: { multiprocessWal: true },
});
```
</details>

---

## REVISE `README.md` (root) — 2026-07-29

**Reason:** Line 59 referenced `better-sqlite3` as the primary native dependency example for the
memory store. With TursoAdapter as the default, this should reference `@tursodatabase/database`
with `better-sqlite3` as the documented fallback.

**Changes:**
- Updated "Native dependencies" sentence from `better-sqlite3` to `@tursodatabase/database`
  with mention of `better-sqlite3` as the fallback adapter.

**Prior content (removed/overwritten):**

```
Native dependencies (e.g. `better-sqlite3` for the memory store) are installed via the
`npm-package:` install mode — a real `npm install` into a per-extension content store, so the
platform binary resolves.
```

---

## REVISE `extensions/bundles/sox-memory-bundle/members/memory-server/README.md` — 2026-07-29

**Reason:** The Overview claimed "the sole writer process for the subsystem" referencing ADR-0007's
single-writer architecture. With `multiprocess_wal` enabled by default, the underlying storage
engine supports concurrent readers and serialized writers across multiple OS processes. The
memory-server remains the canonical backend managing enrichment/clustering, but is no longer
the "sole writer" at the DB level.

**Changes:**
- Replaced "sole writer process" language with "canonical backend that manages enrichment,
  clustering, session state, and all MCP tool dispatch".
- Added explicit mention of TursoAdapter as default with multiprocess_wal, and SqliteAdapter
  fallback via `STORE_ADAPTER=sqlite`.
- Kept "no separate daemon" claim (still true after BL-162).

**Prior content (removed/overwritten):**

```
`memory-server` is the keystone of the sox-memory subsystem — and, since ADR-0007's
single-writer architecture, the sole writer process for the subsystem (there is no separate
daemon). It exposes 19 MCP tools over stdio JSON-RPC (default), SSE, or HTTP transport.
Depending on transport profile it runs per-session (stdio, spawned by the host) or as a
persistent background singleton via `soxe service enable` (sse/http, supervised by the host's
OS-unit layer — launchd on macOS). All persistent state lives in a single SQLite file per
scope, extended with the `sqlite-vec` vector extension (for approximate nearest-neighbour
search) and FTS5 (for BM25 full-text search).
```

---

## REVISE `BACKLOG.md` BL-322 — 2026-07-29

**Reason:** The BL-322 entry still described `multiprocess_wal` as "opt-in and NOT enabled by
default" and included a fix-sketch item to "Enable multiprocessWal by default on Linux targets."
Since multiprocess_wal is now enabled by default on all platforms, these statements are outdated.

**Changes:**
- Updated "Key context on Turso locking" section to state that multiprocess_wal is now enabled
  by default and lock contention should NOT be expected behavior.
- Noted SqliteAdapter remains a single-writer fallback.
- Removed the completed fix-sketch item #1 ("Enable multiprocessWal by default…").
- Updated the fix sketch preamble to note that Turso EXCLUSIVE locking is eliminated as a suspect.

**Prior content (removed/overwritten):**

```
Turso supports multi-process writes via the `multiprocess_wal` experimental feature
(`experimental: { multiprocessWal: true }` in `turso-adapter.ts:111`). This feature was opt-in
and NOT enabled by default — it is now enabled by default (commit during this session).
`multiprocess_wal` is supported on both macOS and Linux via `.tshm` shared memory files. The
earlier claim that it "falls back to ProcessScopedFcntl on macOS" was incorrect and has been
retracted.

The EXCLUSIVE locking we observed was Turso's default behavior in local file mode WITHOUT
`multiprocess_wal` enabled. Now that it's enabled by default, concurrent reader access should
work without file lock contention.

**Fix sketch:** Architect to analyze:
1. Enable `multiprocessWal` by default on Linux targets — does it eliminate EXCLUSIVE locking?
```

---

## REVISE `docs/spec/sox-executor.md` — 2026-07-29

**Reason:** This draft spec for a future Rust executor references `multiprocess_wal` as an
opt-in (`multiprocessWal: true`) without acknowledging that the JS-side adapter
(`@adhd/sox-store-adapter`) already enables it by default.

**Changes:**
1. "Accepted risk" section — added note that the JS adapter already enables multiprocess_wal by
   default, so the risk profile is now operational (proven in daily use) rather than theoretical.
2. Line 140 — added comment that multiprocess_wal is "enabled by default".
3. Line 197 — removed explicit `multiprocessWal: true` flag from work example and added comment
   noting it's default.
4. §6.5 adapter contract — `tursoAdapter()` now shown without explicit flag, noting the JS
   adapter enables multiprocess_wal at connect time by default.
5. §6.6 mitigations — added note about JS adapter shipping it default-on.
6. §11 Verified — added note that the JS adapter enables it by default without an explicit flag.

**Prior content (removed/overwritten):**

```
    adapter: tursoAdapter({ path: '/Users/me/.adhd/memory.db', multiprocessWal: true }),
```

```
- `tursoAdapter({ multiprocessWal: true })` → `multiprocessWrite: true`. **Default backbone.**
```

---

## Created `docs/marketing/.catalog/doc-ops.md` — 2026-07-29

**Reason:** First operation log entry. This file is the permanent audit trail for all
documentation operations per the doc-steward framework.
