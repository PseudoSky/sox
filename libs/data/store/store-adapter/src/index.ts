export * from './types.js';
export * from './errors.js';
export * from './retry.js';
export * from './sqlite-adapter.js';
export * from './turso-adapter.js';
export * from './mock-adapter.js';
export * from './factory.js';
export * from './vector-dialect.js';
export * from './fts-dialect.js';
export * from './fts-ops.js';
// (BUG-017) `storeQuiescence` is the liveness probe every cross-engine repair
// must consult before a writable CLASSIC open of a Turso-owned store. It is
// exported because consumers outside this package own such repairs too
// (memory-core's vec0/FTS-residue drops), and the alternatives are both worse:
// a private reimplementation of the lease-scan is the very anti-pattern BUG-017
// closed off, and probing indirectly through `deleteSchemaRowsViaBetterSqlite3`
// costs a real WRITABLE classic open on the HEALTHY path — doubling the exact
// operation whose frequency is the confirmed corruption driver. This is a pure
// filesystem scan: zero opens.
export * from './store-lease.js';
export * from './adapter-meta.js';
export * from './integrity.js';
export * from './integrity-status.js';
export * from './migration.js';
export * from './preflight.js';
export * from './fts-orphan-guard.js';
export * from './engine-guard.js';
export * from './sidecar-retention.js';

/**
 * (PERF/CORRECTNESS) Canonical store identity — the ONE definition of "are these
 * two path spellings the same store?".
 *
 * Exported because consumers key MAPS and CACHES on the store path, and a Map
 * key gets no symlink resolution from the OS. `memory-core`'s WriteQueue keyed
 * its checkpoint ledger on the caller's RAW spelling while compaction looked it
 * up via `adapter.config.dbPath`, which openDb had already canonicalized. On
 * macOS that is `/var/folders/...` vs `/private/var/folders/...` — the lookup
 * missed 100% of the time, so the double-checkpoint guard NEVER fired and
 * compaction issued a redundant `wal_checkpoint(TRUNCATE)` right after the
 * WriteQueue had already run one. Redundant TRUNCATE checkpoints are the
 * operation implicated in the turso #7833 corruption class, so a silent keying
 * mismatch was actively increasing exposure to it.
 *
 * Anything that stores per-store state under a path key must canonicalize with
 * THIS function rather than reimplementing it.
 */
export { canonicalDbPath } from './path-identity.js';
