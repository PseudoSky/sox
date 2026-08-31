/**
 * (BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001) The store-concurrency
 * contract — the ONE source of truth for which concurrency mode each backend
 * mandates, and the verification that enforces it.
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 *
 * ADR-0012 mandates multiprocess WAL for Turso: multiple processes hold
 * concurrent write connections to one store file, writers serialized through
 * the `-tshm` coordinator sidecar. There is NO opt-out (ADR-0015 removed the
 * `experimental: { multiprocessWal: false }` escape hatch). Before this module
 * the mandate was only half-enforced: the turso adapter forced `multiprocess_wal`
 * on via an inline experiments literal AND a hardcoded
 * `capabilities.multiprocessWrite: true` — two independent sources of truth,
 * zero verification, and a driver upgrade that silently dropped the flag would
 * open fine and lose cross-process coordination with no call-site contract or
 * gate.
 *
 * This module is the ENFORCEMENT half: a backend resolves to exactly ONE mode,
 * every open either declares that mode explicitly or resolves the verified
 * default, and a local-file writable turso open VERIFIES the `-tshm`
 * coordinator exists post-open rather than trusting the driver to have enabled
 * it. `capabilities.multiprocessWrite` and the `multiprocess_wal` experiments
 * flag are now DERIVED from `walMode` — there is no independent hardcode left
 * to drift.
 *
 * The concurrency mode is typed config (`AdapterConfig.concurrencyMode`), never
 * a new `SOX_*` env toggle (ADR-0013).
 *
 * @module
 */

import { existsSync } from 'node:fs';

// ── Types ────────────────────────────────────────────────────────────────────

/** A backend's store-open concurrency mode. Exactly one mode is valid per
 *  backend (see {@link VALID_CONCURRENCY_MODES}); there is no "auto" and no
 *  opt-out. */
export type StoreConcurrencyMode = 'multiprocess-wal' | 'single-writer';

/** The store backends the contract covers. */
export type StoreBackend = 'sqlite' | 'turso';

// ── Mode resolution ──────────────────────────────────────────────────────────

/**
 * The valid concurrency modes per backend. Turso mandates `multiprocess-wal`
 * (ADR-0012 — concurrent cross-process writers over one store file); SQLite
 * (better-sqlite3) is a single synchronous in-process connection and mandates
 * `single-writer`. A mode outside this table is rejected by
 * {@link assertValidConcurrencyMode}.
 */
export const VALID_CONCURRENCY_MODES: Record<StoreBackend, readonly StoreConcurrencyMode[]> = {
  sqlite: ['single-writer'],
  turso: ['multiprocess-wal'],
};

/**
 * The ONE source of truth for "what mode does this backend run under". Returns
 * the mandated mode; there is no backend whose mode is unspecified.
 */
export function resolveConcurrencyMode(backend: StoreBackend): StoreConcurrencyMode {
  return backend === 'turso' ? 'multiprocess-wal' : 'single-writer';
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * (BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001) Thrown when a backend is
 * opened with a concurrency mode outside {@link VALID_CONCURRENCY_MODES} — the
 * compile-time contract made run-time: a caller cannot silently opt a backend
 * into (or out of) its mandated mode.
 */
export class EInvalidConcurrencyMode extends Error {
  public readonly code = 'E_INVALID_CONCURRENCY_MODE';

  constructor(
    public readonly backend: StoreBackend,
    public readonly mode: string,
  ) {
    super(
      `[BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001] invalid concurrency mode "${mode}" ` +
        `for backend "${backend}" — valid modes: ${VALID_CONCURRENCY_MODES[backend].join(', ')}. ` +
        `There is no opt-out; the mode is the mandated one (ADR-0012).`,
    );
    this.name = 'EInvalidConcurrencyMode';
  }
}

/**
 * Assert `mode` is a valid concurrency mode for `backend`. Throws
 * {@link EInvalidConcurrencyMode} otherwise. Every adapter open calls this
 * after resolving its mode, so a mismatched declaration fails loudly at open
 * rather than silently degrading the store's coordination guarantees.
 */
export function assertValidConcurrencyMode(backend: StoreBackend, mode: StoreConcurrencyMode): void {
  if (!VALID_CONCURRENCY_MODES[backend].includes(mode)) {
    throw new EInvalidConcurrencyMode(backend, mode);
  }
}

// ── Sidecar verification ─────────────────────────────────────────────────────

/**
 * (BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001) Thrown when a writable
 * local-file turso open mandated `multiprocess-wal` but the `-tshm` coordinator
 * sidecar did not appear after open — the driver did not actually enable the
 * mandated cross-process WAL coordination. This is the verification gate the
 * mandate was missing: an open that cannot prove the coordinator exists refuses
 * rather than proceed unverified (the exact class of silent regression a driver
 * upgrade could have introduced).
 */
export class EWalModeUnverified extends Error {
  public readonly code = 'E_WAL_MODE_UNVERIFIED';

  constructor(public readonly dbPath: string) {
    super(
      `[BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001] multiprocess WAL was mandated for ` +
        `"${dbPath}" (ADR-0012) but the "-tshm" coordinator sidecar did not appear after open — ` +
        `the driver did not enable the mandated cross-process WAL coordination. Refusing to ` +
        `proceed unverified.`,
    );
    this.name = 'EWalModeUnverified';
  }
}

/**
 * Verify that the `-tshm` coordinator sidecar exists beside `dbPath` — the
 * filesystem-observable proof that Turso's multiprocess WAL coordination is
 * live (the `-tshm` is maintained only while a Turso connection holds the
 * store). Polls briefly because the sidecar is created by the first write,
 * which the open ceremony has already issued by the time this runs; the poll
 * absorbs filesystem sync latency, not the creation itself.
 *
 * Returns `true` as soon as the sidecar is observed, `false` if it never
 * appears within `attempts × pollMs`. Never throws.
 */
export async function verifyMultiprocessWalSidecar(
  dbPath: string,
  opts: { pollMs?: number; attempts?: number } = {},
): Promise<boolean> {
  const pollMs = opts.pollMs ?? 100;
  const attempts = opts.attempts ?? 5;
  const sidecarPath = dbPath + '-tshm';
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (existsSync(sidecarPath)) return true;
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
  return false;
}
