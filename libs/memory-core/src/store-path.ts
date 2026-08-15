/**
 * store-path.ts — canonical store identity for memory-core's per-store maps.
 *
 * WHY THIS FILE EXISTS (and why it is not just an import)
 *
 * Every per-store cache in this package keys on the database path: WriteQueue's
 * `instances`/`pending`/checkpoint ledger, and embed-pipeline's `pipelineStates`.
 * A `Map` key is a STRING, and a string gets no symlink resolution from the OS —
 * unlike a filesystem call, where `/var/x` and `/private/var/x` land on the same
 * inode. So two spellings of one store were two different entries.
 *
 * That was not theoretical. `WriteQueue` stored its checkpoint timestamp under
 * the caller's raw path while `compaction.ts` looked it up via
 * `adapter.config.dbPath` — which `openDb` had already canonicalized. On macOS
 * the lookup missed 100% of the time, so the "did the WriteQueue just
 * checkpoint?" guard never fired and every compaction pass issued a REDUNDANT
 * `wal_checkpoint(TRUNCATE)`. Redundant TRUNCATE checkpoints are the operation
 * implicated in the turso #7833 corruption class, so the mismatch was quietly
 * increasing exposure on a store that has been corrupted twice this month.
 *
 * WHY A LAZY REQUIRE RATHER THAN A STATIC IMPORT
 *
 * `@adhd/sox-store-adapter` is a lazy-loaded library here — memory-core imports
 * its TYPES statically but its VALUES through `await import(...)` (see db.ts),
 * and `tools/eslint-local` enforces that with "Static imports of lazy-loaded
 * libraries are forbidden". The rule exists because that package reaches native
 * bindings, and pulling it in eagerly at module scope changes load behaviour for
 * every consumer of memory-core.
 *
 * But these call sites are SYNCHRONOUS — they compute a Map key inside a static
 * method — so `await import()` is not available. A cached lazy `require` is the
 * one shape that satisfies both constraints: no eager module-scope load, and a
 * synchronous call.
 *
 * WHY NOT REIMPLEMENT THE NORMALIZATION HERE
 *
 * Because a second definition of "are these the same store?" is exactly the bug
 * this file exists to prevent. `canonicalDbPath` (realpath of the dirname +
 * basename, memoized, ENOENT-tolerant) is the single source of truth; this is a
 * thin accessor to it, not a copy of it.
 */

type CanonFn = (dbPath: string) => string;

let cached: CanonFn | null = null;

/**
 * The canonical identity of a store path — the ONE answer to "are these two
 * spellings the same store?". Use this for every per-store map key in this
 * package.
 */
export function canonicalStorePath(dbPath: string): string {
  if (cached === null) {
    // Deliberate lazy load — see the module doc above. A static import trips the
    // lazy-loaded-library lint rule, and these call sites cannot await.
    const mod = require('@adhd/sox-store-adapter') as {
      canonicalDbPath?: CanonFn;
    };
    if (typeof mod.canonicalDbPath !== 'function') {
      // Fail LOUDLY rather than silently degrading to raw-string keys — a silent
      // fallback here would reintroduce the exact split-key bug, invisibly.
      throw new Error(
        'store-path: @adhd/sox-store-adapter did not export canonicalDbPath. ' +
          'Per-store maps cannot be keyed safely without it; refusing to fall back ' +
          'to raw path strings (that is the BUG this module exists to prevent).',
      );
    }
    cached = mod.canonicalDbPath;
  }
  return cached(dbPath);
}
