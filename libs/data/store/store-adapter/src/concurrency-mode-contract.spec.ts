/**
 * concurrency-mode-contract.spec.ts — BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001
 *
 * The store-concurrency contract is the ONE source of truth for "which mode
 * does this backend run under": turso mandates `multiprocess-wal` (ADR-0012,
 * no opt-out), sqlite mandates `single-writer`. `capabilities.multiprocessWrite`
 * and the `multiprocess_wal` experiments flag are DERIVED from `capabilities.walMode`
 * — there is no independent hardcode left to drift.
 *
 * RED→GREEN (BL-225): before this contract, a turso adapter hardcoded
 * `multiprocessWrite: true` and an inline `experiments: ['index_method',
 * 'multiprocess_wal']` literal with NO `walMode`/`walModeVerified` fields and
 * NO validation — so `createTursoAdapter({ dbPath, concurrencyMode:
 * 'single-writer' })` would have opened "fine" (the declaration silently
 * ignored), and a bare open reported nothing about whether its `-tshm`
 * coordinator was actually verified. Every "throws"/"verified"/"derived"
 * assertion below fails against that pre-contract code and passes here.
 *
 * All specs run against a disposable `mkdtemp` sandbox — NEVER against
 * ~/.memory or any live store.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createTursoAdapter, createSqliteAdapter } from './factory.js';
import {
  EInvalidConcurrencyMode,
  resolveConcurrencyMode,
  assertValidConcurrencyMode,
  VALID_CONCURRENCY_MODES,
} from './concurrency-mode.js';
import type { StoreConcurrencyMode } from './concurrency-mode.js';

const require = createRequire(import.meta.url);
const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();
const tursoDescribe = hasTurso ? describe : describe.skip;

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-concurrency-contract-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-concurrency-contract-'));
});

function tempPath(label: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpDir, `${label}-${suffix}.db`);
}

// ── Pure resolution/validation (deterministic, no driver) ─────────────────────

describe('concurrency-mode.ts — resolveConcurrencyMode / assertValidConcurrencyMode', () => {
  it('resolveConcurrencyMode returns the mandated mode per backend — no "auto", no unspecified backend', () => {
    expect(resolveConcurrencyMode('turso')).toBe('multiprocess-wal');
    expect(resolveConcurrencyMode('sqlite')).toBe('single-writer');
  });

  it('VALID_CONCURRENCY_MODES is the closed table the resolver implements — turso: multiprocess-wal only, sqlite: single-writer only', () => {
    expect(VALID_CONCURRENCY_MODES.turso).toEqual(['multiprocess-wal']);
    expect(VALID_CONCURRENCY_MODES.sqlite).toEqual(['single-writer']);
  });

  it('assertValidConcurrencyMode accepts the mandated mode and throws EInvalidConcurrencyMode for the forbidden one', () => {
    expect(() => assertValidConcurrencyMode('turso', 'multiprocess-wal')).not.toThrow();
    expect(() => assertValidConcurrencyMode('sqlite', 'single-writer')).not.toThrow();

    expect(() => assertValidConcurrencyMode('turso', 'single-writer')).toThrow(EInvalidConcurrencyMode);
    expect(() => assertValidConcurrencyMode('sqlite', 'multiprocess-wal' as StoreConcurrencyMode)).toThrow(EInvalidConcurrencyMode);
  });

  it('EInvalidConcurrencyMode carries the backend, the offending mode, and the valid modes', () => {
    try {
      assertValidConcurrencyMode('turso', 'single-writer');
      expect.unreachable('expected assertValidConcurrencyMode to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EInvalidConcurrencyMode);
      expect((err as EInvalidConcurrencyMode).code).toBe('E_INVALID_CONCURRENCY_MODE');
      expect((err as EInvalidConcurrencyMode).backend).toBe('turso');
      expect((err as EInvalidConcurrencyMode).mode).toBe('single-writer');
      expect((err as EInvalidConcurrencyMode).message).toContain('multiprocess-wal');
    }
  });
});

// ── SQLite arm (deterministic, no turso driver) ───────────────────────────────

describe('SqliteAdapterImpl — concurrency contract (single-writer only)', () => {
  it('bare open resolves to single-writer: walMode/single-writer + verified true (intrinsic) + multiprocessWrite false', async () => {
    const dbPath = tempPath('sqlite-bare');
    const a = createSqliteAdapter({ dbPath });

    expect(a.capabilities.walMode).toBe('single-writer');
    // sqlite is a single synchronous in-process connection — 'single-writer'
    // is intrinsic, so verification is trivially satisfied (nothing to probe).
    expect(a.capabilities.walModeVerified).toBe(true);
    // DERIVED — not a hardcode.
    expect(a.capabilities.multiprocessWrite).toBe(false);
    expect(a.config.concurrencyMode).toBe('single-writer');

    await a.close();
  });

  it('declaring multiprocess-wal on sqlite throws EInvalidConcurrencyMode BEFORE any file is touched', () => {
    const dbPath = tempPath('sqlite-forbidden');
    expect(() =>
      createSqliteAdapter({ dbPath, concurrencyMode: 'multiprocess-wal' as StoreConcurrencyMode }),
    ).toThrow(EInvalidConcurrencyMode);
    // The throw happens in the constructor, before the file open — no store
    // file, no -wal, no -shm were created.
    expect(existsSync(dbPath)).toBe(false);
  });
});

// ── Turso arm (skipped when the driver is not installed) ─────────────────────

tursoDescribe('TursoAdapterImpl — concurrency contract (multiprocess-wal only)', () => {
  it('bare open resolves to multiprocess-wal: walMode + verified true + -tshm exists + config stamped + multiprocessWrite derived true', async () => {
    const dbPath = tempPath('turso-bare');
    const a = await createTursoAdapter({ dbPath });

    // Trigger the deferred real open (DEBT-003 lazy-connect): the -tshm
    // verification and the capability stamping happen in _openReal().
    await a.executeRun(`CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)`);

    expect(a.capabilities.walMode).toBe('multiprocess-wal');
    expect(a.capabilities.walModeVerified).toBe(true);
    expect(a.capabilities.multiprocessWrite).toBe(true);
    expect(a.config.concurrencyMode).toBe('multiprocess-wal');
    // Filesystem-observable proof the mandate is live, not merely declared.
    expect(existsSync(`${dbPath}-tshm`)).toBe(true);

    await a.close();
  });

  it('declaring single-writer on turso rejects with EInvalidConcurrencyMode (no opt-out — ADR-0012)', async () => {
    const dbPath = tempPath('turso-forbidden');
    await expect(
      createTursoAdapter({ dbPath, concurrencyMode: 'single-writer' }),
    ).rejects.toBeInstanceOf(EInvalidConcurrencyMode);
    // The validation is eager (connect-time), so no store file was created.
    expect(existsSync(dbPath)).toBe(false);
  });
});
