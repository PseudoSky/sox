/**
 * (BL-508) Engine-identity marker + foreign-engine guard.
 *
 * ## The problem
 *
 * A single foreign-engine client opening a store owned by the other engine can
 * destroy its WAL coordination state: Turso and better-sqlite3 coordinate a
 * shared WAL through DIFFERENT sidecar conventions (`-tshm` multiprocess-WAL
 * shared-memory files vs `-shm`), so a cross-engine open can leave the store
 * permanently unopenable — or, worse, silently corrupt. The engine used to
 * create a store was previously only discoverable by touching the schema
 * (which itself fails cross-engine — BL-329). This module makes the engine a
 * first-class, cheaply-readable property of the store and refuses the
 * dangerous opens.
 *
 * ## The marker (two layers)
 *
 * 1. **`PRAGMA application_id`** — a 32-bit int in the SQLite header (byte
 *    offset 68). Writable by any engine, readable by ANY engine WITHOUT a
 *    schema-touching statement (verified empirically against a
 *    Tantivy-carrying store copy: the raw pragma reads fine on a store whose
 *    `sqlite_master` throws BL-329's malformed-schema error). Two sox-owned
 *    values, chosen to be human-readable in a hex dump and collision-resistant
 *    (no common tool uses a marker starting with ASCII 'SOX'):
 *
 *    - `0x534F5854` = bytes `'SOXT'` — Turso-owned store
 *    - `0x534F5853` = bytes `'SOXS'` — SQLite-owned store
 *
 *    The final byte is a mnemonic (T/S) rather than a version nibble; if the
 *    scheme ever needs versioning, bump the third byte ('SOY…') — the guard
 *    only matches the exact values above, and an unrecognised nonzero marker
 *    reads as "marked, engine unknown" (safe side: refuses nothing, warns).
 *
 * 2. **`_sox_engine`** — a tiny authoritative row (engine, sox_version,
 *    driver_version, first_opened_at, last_opened_at) written by the owning
 *    adapter on FIRST open only. `application_id` is the cheap fast-path
 *    probe; the row carries the version detail the ping/health surfaces need.
 *
 * Backfill: a store with NO marker (legacy, pre-BL-508) is inferred — Turso
 * if its `sqlite_master` carries `__turso_internal_*` rows, else `_adapter_meta`
 * if present, else (empty schema) the adapter that just created it, else
 * SQLite. The marker is written on the next sox open by the adapter that
 * matches the inference. An inference that contradicts the opening adapter
 * leaves the store unmarked (it is the other engine's store; the sanctioned
 * repair/migration paths decide its fate).
 *
 * ## The guard
 *
 * - `assertStoreEngineSync` / `assertStoreEngine` — refuse when the store's
 *   engine ≠ the caller's expected engine. `E_TURSO_NATIVE_STORE` (extended,
 *   BL-329) when a better-sqlite3 caller meets a Turso-owned store;
 *   `ESqliteNativeStore` (new) for the mirror. Unmarked legacy stores are
 *   ALLOWED (`allowUnmarked` defaults true) so the pre-marker population keeps
 *   working; the backfill stamps them on next open.
 * - Every sox-managed better-sqlite3 open carries an intent:
 *   - `'tooling'` — `SqliteAdapterImpl`'s constructor probe: refuse on a Turso
 *     marker BEFORE opening the writable handle (zero WAL/schema touch).
 *   - `'repair'` — the sanctioned escape hatch (preflight `openSchemaReader`,
 *     memory-core's `dropVec0ViaBetterSqlite3`/`dropFtsResidueViaBetterSqlite3`):
 *     proceeds regardless of marker, but records the detected engine so a
 *     repair of a foreign store is visible, never silent.
 * - Version tracking: the `_sox_engine.sox_version` is compared against the
 *   current store-adapter version on every `assertStoreEngine` call — a
 *   mismatch warns, never refuses.
 *
 * @module
 */

import { closeSync, openSync, readSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { log } from '@adhd/sox-telemetry';
import type { StoreAdapter } from './types.js';
import { ETursoNativeStore, ESqliteNativeStore } from './errors.js';

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json') as { version: string };

// ── Engine kinds ────────────────────────────────────────────────────────────

export type EngineKind = 'turso' | 'sqlite';

/**
 * `PRAGMA application_id` value for a Turso-owned store — the 4 ASCII header
 * bytes `'SOXT'` (0x53 0x4F 0x58 0x54).
 */
export const SOX_APP_ID_TURSO = 0x534f5854;

/**
 * `PRAGMA application_id` value for a SQLite-owned store — the 4 ASCII header
 * bytes `'SOXS'` (0x53 0x4F 0x58 0x53).
 */
export const SOX_APP_ID_SQLITE = 0x534f5853;

/** The authoritative companion row (application_id is the fast path). */
export const SOX_ENGINE_TABLE = '_sox_engine';

const SOX_ENGINE_TABLE_DDL = `CREATE TABLE IF NOT EXISTS ${SOX_ENGINE_TABLE} (
  engine TEXT PRIMARY KEY CHECK (engine IN ('turso','sqlite')),
  sox_version TEXT NOT NULL,
  driver_version TEXT NOT NULL,
  first_opened_at TEXT NOT NULL,
  last_opened_at TEXT NOT NULL
)`;

const SELECT_IDENTITY_SQL = `SELECT engine, sox_version, driver_version, first_opened_at, last_opened_at FROM ${SOX_ENGINE_TABLE} LIMIT 1`;

export interface EngineIdentity {
  engine: EngineKind;
  sox_version: string;
  driver_version: string;
  first_opened_at: string;
  last_opened_at: string;
}

export interface EngineGuardResult {
  /** Engine identified by marker (or legacy inference). `null` = unmarked. */
  engine: EngineKind | null;
  /** The `_sox_engine` row when readable, else `null` (legacy/absent). */
  identity: EngineIdentity | null;
  /** Marker `sox_version` ≠ current store-adapter version (warn, not refuse). */
  versionMismatch: boolean;
}

// ── application_id fast-path probe ──────────────────────────────────────────

/**
 * Read the store's `application_id` WITHOUT touching the schema, opening the
 * store through a driver, or touching the WAL — a pure header read.
 *
 * Primary mechanism: a pure header-byte read (fs-level `openSync`/`readSync`
 * at offset 68) — no driver, no locks, no sidecars. This ordering is
 * BL-512-mandated: opening the store with better-sqlite3 — a legacy
 * (stock-SQLite) engine — during a concurrent multiprocess-wal turso connect
 * makes the turso engine refuse the open with "Database is already open
 * without experimental multiprocess WAL in another process" and the write is
 * lost. The adapter previously created exactly that legacy opener on EVERY
 * writable connect by running this probe pragma-first (6 parallel backlog
 * `create-item` processes → 4/18 lost, reproduced live 2026-08-12). The
 * header read identifies any readable SQLite file without ever opening it
 * through a driver, so a multiprocess connect never crosses engines.
 *
 * Caveat (was the fallback's; now on the primary path): in WAL mode the
 * marker write lands in the uncheckpointed `-wal` first, and a pragma would
 * merge WAL+header while a raw byte read of header offset 68 sees the stale
 * pre-marker value until the next checkpoint. The adapter checkpoints
 * TRUNCATE on every writable close (BL-512), so a closed store's header is
 * authoritative; in the mid-session window a stale read degrades to
 * "unmarked" (0), which every guard treats as allowed — it never invents a
 * marker that is not in the header.
 *
 * Fallback: a better-sqlite3 read-only `PRAGMA application_id` when the
 * header read cannot identify the file (not a readable SQLite header). The
 * pragma is WAL-aware, so it can disambiguate files the bytes cannot.
 *
 * Returns `null` when the path is not a readable SQLite file.
 */
export function readApplicationId(dbPath: string): number | null {
  const viaHeader = readApplicationIdFromHeaderBytes(dbPath);
  if (viaHeader !== null) return viaHeader;
  return readApplicationIdViaBetterSqlite3(dbPath);
}

/**
 * Fallback probe: better-sqlite3 read-only `PRAGMA application_id`. Used ONLY
 * when {@link readApplicationIdFromHeaderBytes} cannot identify the file (not
 * a readable SQLite header) but the engine still can. Lazy — better-sqlite3
 * is a soft dependency.
 *
 * (BL-512) This path must NEVER be the per-connect probe on a store that may
 * be under a concurrent multiprocess-wal turso connection: a better-sqlite3
 * open is a legacy (stock-SQLite) opener, and the turso engine refuses a
 * `multiprocess_wal` open while one is live ("Database is already open
 * without experimental multiprocess WAL in another process") — the connect
 * loses the write. Header bytes first, always.
 */
function readApplicationIdViaBetterSqlite3(dbPath: string): number | null {
  try {
    const Database = loadBetterSqlite3();
    const db = new Database(dbPath, { readonly: true });
    try {
      return db.pragma('application_id', { simple: true }) as number;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** PRIMARY probe (BL-512): direct header-byte read (offset 68, big-endian) —
 *  fs-level `openSync`/`readSync`, no driver, no locks, no sidecars — the only
 *  probe safe to run on a store a concurrent multiprocess-wal turso connection
 *  may hold. Returns `null` when the path is not a readable SQLite file; see
 *  {@link readApplicationId} for the WAL-staleness caveat. */
function readApplicationIdFromHeaderBytes(dbPath: string): number | null {
  let fd: number | null = null;
  try {
    fd = openSync(dbPath, 'r');
    const header = Buffer.alloc(100);
    const read = readSync(fd, header, 0, 100, 0);
    if (read < 100) return null; // not a complete SQLite header (or no file)
    if (!header.subarray(0, 16).equals(Buffer.from('SQLite format 3\0', 'latin1'))) {
      return null;
    }
    return header.readUInt32BE(68);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Normalize the different driver shapes of `pragmaGet('application_id')`:
 *  better-sqlite3 returns a bare number; the Turso driver returns
 *  `[{ application_id: n }]` even with `simple: true`. */
export function appIdFromPragmaResult(raw: unknown): number | null {
  const pick = (v: unknown): number | null => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };
  if (typeof raw === 'number') return raw;
  if (Array.isArray(raw) && raw.length > 0) {
    const first = raw[0] as Record<string, unknown> | undefined;
    if (first !== null && typeof first === 'object' && 'application_id' in first) {
      return pick(first.application_id);
    }
  }
  if (raw !== null && typeof raw === 'object' && 'application_id' in (raw as Record<string, unknown>)) {
    return pick((raw as Record<string, unknown>).application_id);
  }
  return null;
}

/** The marker value that claims ownership by `engine`. */
export function applicationIdForEngine(engine: EngineKind): number {
  return engine === 'turso' ? SOX_APP_ID_TURSO : SOX_APP_ID_SQLITE;
}

/** The engine a marker value claims, or `null` for unmarked/unrecognised. */
export function engineForApplicationId(appId: number | null | undefined): EngineKind | null {
  if (appId === SOX_APP_ID_TURSO) return 'turso';
  if (appId === SOX_APP_ID_SQLITE) return 'sqlite';
  return null;
}

// ── Legacy inference ────────────────────────────────────────────────────────

/**
 * Infer the engine of an UNMARKED (legacy) store. Order of evidence:
 * 1. `sqlite_master` carries `__turso_internal_*` rows → Turso (Tantivy).
 * 2. `_adapter_meta.adapter_type` (authoritative for sox-created stores).
 * 3. Empty schema → `null` (fresh file — the opening adapter owns it).
 * 4. Otherwise → SQLite (a pre-existing store with no Turso signal).
 *
 * Synchronous; uses better-sqlite3 read-only + the `writable_schema` escape
 * hatch so the scan works on EITHER engine's store (a Tantivy schema throws
 * BL-329 without it — measured). Returns `null` when unreadable.
 */
export function probeLegacyEngineSync(dbPath: string): EngineKind | null {
  let db: ProbeDatabase | null = null;
  try {
    const Database = loadBetterSqlite3();
    db = new Database(dbPath, { readonly: true });
    db.unsafeMode(true); // MUST precede writable_schema (defensive mode no-ops it)
    db.pragma('writable_schema = ON');

    const rows = db.prepare('SELECT name FROM sqlite_master').all() as { name: string }[];
    if (rows.some((r) => r.name.startsWith('__turso_internal_'))) return 'turso';

    let meta: { value: string } | undefined;
    try {
      meta = db
        .prepare("SELECT value FROM _adapter_meta WHERE key = 'adapter_type'")
        .get() as { value: string } | undefined;
    } catch {
      meta = undefined; // no _adapter_meta table
    }
    if (meta?.value === 'turso' || meta?.value === 'sqlite') return meta.value;

    return rows.length === 0 ? null : 'sqlite';
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // best-effort close on the probe handle
    }
  }
}

/** Async twin of {@link probeLegacyEngineSync}, queried through the OPEN
 *  adapter (no second connection). */
async function probeLegacyEngineViaAdapter(
  adapter: StoreAdapter,
): Promise<EngineKind | null> {
  try {
    const { rows } = await adapter.executeAll<{ name: string }>('SELECT name FROM sqlite_master');
    if (rows.some((r) => r.name.startsWith('__turso_internal_'))) return 'turso';
  } catch {
    // sqlite_master unreadable through this adapter → try _adapter_meta only
  }
  try {
    const meta = await adapter.executeGet<{ value: string }>(
      "SELECT value FROM _adapter_meta WHERE key = 'adapter_type'",
    );
    if (meta?.value === 'turso' || meta?.value === 'sqlite') return meta.value;
  } catch {
    // no _adapter_meta table
  }
  try {
    const count = await adapter.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM sqlite_master');
    if ((count?.c ?? 0) === 0) return null; // fresh file — opening adapter owns it
  } catch {
    return null;
  }
  return 'sqlite';
}

// ── Driver versions ─────────────────────────────────────────────────────────

/**
 * The driver library version that owns the store — `@tursodatabase/database`
 * for Turso, `better-sqlite3` for SQLite. Resolved from each package's
 * package.json without loading native bindings. `'unknown'` on resolution
 * failure (never throws).
 */
function driverVersionFor(engine: EngineKind): string {
  try {
    if (engine === 'turso') {
      // The package's exports map only exposes "." (→ dist/promise.js), so the
      // subpath require would throw; resolve the entry and walk up to the root.
      const entry = require.resolve('@tursodatabase/database');
      const pkgPath = join(dirname(dirname(entry)), 'package.json');
      return (require(pkgPath) as { version?: string }).version ?? 'unknown';
    }
    const pkg = require('better-sqlite3/package.json') as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// ── Marker write (first open only) ──────────────────────────────────────────

/**
 * Process-local "already ensured" set — the connection-local flag that keeps
 * reconnects (SPEC-CONN-RECYCLE `_reconnect` re-runs `connect()`) from
 * rewriting a marker. The persisted marker itself is the durable gate; this
 * set skips even the read on reconnect.
 */
const ensuredInProcess = new Set<string>();

/**
 * Write the engine marker (`application_id` + `_sox_engine` row) — idempotent,
 * cheap, first-open-only. Writes only when the store is unmarked AND this
 * adapter is the store's engine (fresh file, or legacy inference matches).
 * Never throws: a failed marker write degrades to "store stays unmarked"
 * (still openable — unmarked is allowed), with a trace.
 *
 * `fresh` must be `true` when the file did not exist before this open (the
 * opening adapter created it, so it owns it regardless of schema contents).
 */
export async function ensureEngineMarker(
  adapter: StoreAdapter,
  engine: EngineKind,
  dbPath: string | undefined,
  opts: { fresh?: boolean } = {},
): Promise<boolean> {
  if (!dbPath || adapter.config.readonly === true) return false;
  if (ensuredInProcess.has(dbPath)) return false;

  let appId: number | null = null;
  try {
    appId = appIdFromPragmaResult(await adapter.pragmaGet('application_id'));
  } catch {
    // Unreadable pragma — do not write blindly; the store stays unmarked.
  }

  if (appId !== null && appId !== 0) {
    // Already marked by some engine — never rewrite. A marker of the OTHER
    // engine is the cross-engine case; the opener's own refusal logic already
    // ran before this call.
    return false;
  }

  let inferred: EngineKind | null = engine;
  if (opts.fresh !== true) {
    inferred = await probeLegacyEngineViaAdapter(adapter);
    if (inferred !== null && inferred !== engine) {
      // Legacy store owned by the other engine — not ours to stamp. The
      // sanctioned repair/migration paths decide its fate.
      return false;
    }
  }

  try {
    await adapter.exec(`PRAGMA application_id = ${applicationIdForEngine(engine)}`);
    await adapter.exec(SOX_ENGINE_TABLE_DDL);
    const now = new Date().toISOString();
    await adapter.executeRun(
      `INSERT INTO ${SOX_ENGINE_TABLE} (engine, sox_version, driver_version, first_opened_at, last_opened_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(engine) DO UPDATE SET last_opened_at = excluded.last_opened_at`,
      [engine, PKG_VERSION, driverVersionFor(engine), now, now],
    );
    ensuredInProcess.add(dbPath);
    return true;
  } catch (err) {
    log.warn('store_adapter.engine_marker.write_failed', {
      db_path: dbPath,
      engine,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// ── Identity reads ──────────────────────────────────────────────────────────

function normalizeIdentityRow(row: Record<string, unknown> | null | undefined): EngineIdentity | null {
  if (row === null || row === undefined) return null;
  const engine = row.engine;
  if (engine !== 'turso' && engine !== 'sqlite') return null;
  return {
    engine,
    sox_version: String(row.sox_version ?? ''),
    driver_version: String(row.driver_version ?? ''),
    first_opened_at: String(row.first_opened_at ?? ''),
    last_opened_at: String(row.last_opened_at ?? ''),
  };
}

/** Read the `_sox_engine` row through an ALREADY-OPEN adapter — the cheap
 *  surface used by health/ping callers that hold a connection. Returns `null`
 *  when the store predates markers or the row is unreadable. Never throws. */
export async function readEngineIdentityViaAdapter(adapter: StoreAdapter): Promise<EngineIdentity | null> {
  try {
    const row = await adapter.executeGet<Record<string, unknown>>(SELECT_IDENTITY_SQL);
    return normalizeIdentityRow(row);
  } catch {
    return null;
  }
}

/** Read the `_sox_engine` row directly from the file. Synchronous — used by
 *  sync open paths (graph-store) that must not await. Works on EITHER engine's
 *  store via the better-sqlite3 `writable_schema` escape hatch (a Tantivy
 *  schema throws BL-329 without it — measured). Returns `null` when unmarked
 *  or unreadable. Never throws. */
export function getEngineIdentitySync(dbPath: string): EngineIdentity | null {
  let db: ProbeDatabase | null = null;
  try {
    const Database = loadBetterSqlite3();
    db = new Database(dbPath, { readonly: true });
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    const row = db.prepare(SELECT_IDENTITY_SQL).get() as Record<string, unknown> | undefined;
    return normalizeIdentityRow(row);
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // best-effort close on the probe handle
    }
  }
}

/** Read the `_sox_engine` row from the file through the engine the marker
 *  identifies (async — uses each engine's own driver for the read). Falls back
 *  to {@link getEngineIdentitySync} when the engine driver cannot open.
 *  Returns `null` when the store is unmarked or the row is absent.
 *
 *  (BL-512) The header read that decides the engine can be STALE in the
 *  uncheckpointed-WAL window: the marker write lands in the `-wal` first and
 *  the header byte at offset 68 keeps the pre-marker value (0) until the next
 *  checkpoint (the adapter TRUNCATE-checkpoints on every writable close, but
 *  mid-session the header still says 0). So a `null` engine here must not be
 *  treated as "unmarked" outright — a live turso connection may hold the
 *  store with the marker still in its WAL. The identity read already opens
 *  the file with a driver, so for the null/unmarked case it tries the
 *  WAL-aware TURSO driver read (the correct engine for a multiprocess store —
 *  never the legacy better-sqlite3 opener) and only then falls back to the
 *  better-sqlite3 sync read. */
export async function getEngineIdentity(dbPath: string): Promise<EngineIdentity | null> {
  const engine = engineForApplicationId(readApplicationId(dbPath));
  if (engine === 'sqlite') return getEngineIdentitySync(dbPath);
  if (engine === 'turso' || engine === null) {
    // 'turso': the marker says so. 'null': header unmarked — either genuinely
    // unmarked (legacy/fresh) or a stale-header turso store mid-session; the
    // turso driver read disambiguates (WAL-merged), and a genuinely unmarked
    // store simply has no `_sox_engine` row.
    try {
      const { connect } = await import('@tursodatabase/database');
      const db = await connect(dbPath, {
        readonly: true,
        experimental: ['index_method', 'multiprocess_wal'],
        // (BL-512) Same bounded busy timeout as the adapter: a read-only open
        // landing in another process's close()-TRUNCATE window must WAIT out
        // the transient lock rather than fail — otherwise this falls through
        // to `getEngineIdentitySync`, which opens the store with the legacy
        // better-sqlite3 engine (the exact mixed-engine hazard this module
        // exists to prevent).
        timeout: 5000,
      });
      try {
        const row = (await db.get(SELECT_IDENTITY_SQL)) as Record<string, unknown> | undefined;
        return normalizeIdentityRow(row);
      } finally {
        await db.close();
      }
    } catch {
      // Turso driver cannot read it (a genuine SQLite-owned store, a
      // newer-SQLite file, or a transient failure) — the better-sqlite3 sync
      // read is the legacy engine's own path.
      return getEngineIdentitySync(dbPath);
    }
  }
  return getEngineIdentitySync(dbPath);
}

// ── Version-compat warning ──────────────────────────────────────────────────

/**
 * (BL-508) Warn (never refuse) when the store's marker `sox_version` differs
 * from the current store-adapter version — the store was written by a
 * different sox client generation. Data-only surfaces report it via
 * {@link EngineGuardResult.versionMismatch}; this is the audible side.
 */
export function warnOnEngineVersionMismatch(identity: EngineIdentity): void {
  if (identity.sox_version === PKG_VERSION || identity.sox_version === 'unknown') return;
  log.warn('store_adapter.engine_marker.version_mismatch', {
    marker_sox_version: identity.sox_version,
    current_sox_version: PKG_VERSION,
    engine: identity.engine,
  });
}

// ── The refusal guard ───────────────────────────────────────────────────────

/**
 * Thrown by `assertStoreEngine*` when a store carries NO engine marker and the
 * caller demanded fail-closed behaviour (`allowUnmarked: false`).
 */
export class EEngineUnmarked extends Error {
  public readonly code = 'E_SOX_STORE_UNMARKED';
  constructor(public readonly dbPath: string) {
    super(
      `[BL-508] "${dbPath}" carries no engine marker and this open requires one ` +
        `(allowUnmarked=false) — refusing to proceed against an unidentified engine.`,
    );
    this.name = 'EEngineUnmarked';
  }
}

/**
 * The synchronous foreign-engine guard: refuse when the store's marker says
 * the OTHER engine vs `expected`. Refusal throws the typed error for the
 * direction of the mismatch (`ETursoNativeStore` for a better-sqlite3 caller
 * meeting a Turso-owned store; `ESqliteNativeStore` for the mirror) BEFORE
 * any write or WAL touch — the probe is a pure header read. Unmarked legacy
 * stores are allowed unless `allowUnmarked: false`: the marker is the ONLY
 * "store says" signal the guard trusts — legacy inference (who stamps the
 * backfill) is `ensureEngineMarker`'s job, and an unmarked store is a
 * pre-marker population that predates the guard, never a mismatch.
 */
export function assertStoreEngineSync(
  dbPath: string,
  expected: EngineKind,
  opts: { allowUnmarked?: boolean } = {},
): EngineGuardResult {
  const allowUnmarked = opts.allowUnmarked ?? true;
  const engine = engineForApplicationId(readApplicationId(dbPath));

  if (engine === null) {
    if (allowUnmarked) return { engine: null, identity: null, versionMismatch: false };
    throw new EEngineUnmarked(dbPath);
  }
  if (engine === expected) {
    return { engine, identity: null, versionMismatch: false };
  }
  if (engine === 'turso' && expected === 'sqlite') {
    throw new ETursoNativeStore(dbPath, null, { detectedEngine: 'turso' });
  }
  throw new ESqliteNativeStore(dbPath, 'sqlite');
}

/**
 * The async guard: {@link assertStoreEngineSync} plus the authoritative
 * `_sox_engine` row and the version-compat warning. Refusal semantics are
 * identical to the sync form.
 */
export async function assertStoreEngine(
  dbPath: string,
  expected: EngineKind,
  opts: { allowUnmarked?: boolean } = {},
): Promise<EngineGuardResult> {
  const sync = assertStoreEngineSync(dbPath, expected, opts); // throws on mismatch
  if (sync.engine === null) return sync;

  const identity = await getEngineIdentity(dbPath);
  const versionMismatch =
    identity !== null && identity.sox_version !== PKG_VERSION && identity.sox_version !== 'unknown';
  if (versionMismatch) warnOnEngineVersionMismatch(identity);
  return { engine: sync.engine, identity, versionMismatch };
}

// ── better-sqlite3 lazy loader (soft dependency — same pattern as
//    sqlite-adapter.ts / preflight.ts) ───────────────────────────────────────

/** The structural shape of a better-sqlite3 Database this module uses. */
interface ProbeDatabase {
  pragma(sql: string, opts?: { simple?: boolean }): unknown;
  unsafeMode(on: boolean): void;
  prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
  close(): void;
}

type BetterSqlite3Constructor = new (p: string, o?: { readonly?: boolean }) => ProbeDatabase;

let cachedDatabaseConstructor: BetterSqlite3Constructor | undefined;
function loadBetterSqlite3(): BetterSqlite3Constructor {
  if (cachedDatabaseConstructor === undefined) {
    cachedDatabaseConstructor = require('better-sqlite3') as BetterSqlite3Constructor;
  }
  return cachedDatabaseConstructor;
}
