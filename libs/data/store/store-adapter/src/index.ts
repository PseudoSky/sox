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
export * from './adapter-meta.js';
export * from './integrity.js';
export * from './integrity-status.js';
export * from './migration.js';
export * from './preflight.js';
export * from './fts-orphan-guard.js';
export * from './engine-guard.js';

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
