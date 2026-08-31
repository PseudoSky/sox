/**
 * wal-mode-verification.spec.ts — BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001
 *
 * The enforcement half of the store-concurrency contract: a writable local-file
 * turso open VERIFIES its `-tshm` coordinator sidecar post-open and refuses
 * (`EWalModeUnverified`) when it cannot; the pure helper `verifyMultiprocessWalSidecar`
 * is the poll that runs that check. A readonly open is deliberately EXEMPT —
 * it cannot write, so there is no `-tshm` to verify, and `walModeVerified` reads
 * `null` (honest "not applicable"), never a silent `true`.
 *
 * RED→GREEN (BL-225): before this contract, there was no `verifyMultiprocessWalSidecar`
 * and no `walModeVerified` field at all — the "false on missing path" and
 * "readonly → null" assertions could not even be written against the pre-fix
 * adapter (the symbol did not exist to import).
 *
 * All specs run against a disposable `mkdtemp` sandbox — NEVER against
 * ~/.memory or any live store.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createTursoAdapter } from './factory.js';
import { verifyMultiprocessWalSidecar } from './concurrency-mode.js';

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
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-wal-mode-verification-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-wal-mode-verification-'));
});

function tempPath(label: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpDir, `${label}-${suffix}.db`);
}

// ── Pure helper (deterministic, no driver) ────────────────────────────────────

describe('verifyMultiprocessWalSidecar — the -tshm coordinator poll', () => {
  it('returns false when the -tshm sidecar never appears (missing path)', async () => {
    const dbPath = tempPath('no-sidecar');
    // Never create the -tshm — the poll must give up and return false.
    const verified = await verifyMultiprocessWalSidecar(dbPath, { pollMs: 5, attempts: 3 });
    expect(verified).toBe(false);
  });

  it('returns true as soon as the -tshm sidecar exists', async () => {
    const dbPath = tempPath('with-sidecar');
    writeFileSync(`${dbPath}-tshm`, 'coordinator');
    const verified = await verifyMultiprocessWalSidecar(dbPath, { pollMs: 5, attempts: 1 });
    expect(verified).toBe(true);
  });
});

// ── Readonly exemption (skipped when the turso driver is not installed) ──────

tursoDescribe('TursoAdapterImpl — readonly open is exempt from -tshm verification', () => {
  it('a readonly open reports walModeVerified: null (verification not applicable), never a silent true', async () => {
    const dbPath = tempPath('readonly-exempt');

    // Seed a real writable store so the readonly open has a file to read.
    const w = await createTursoAdapter({ dbPath });
    await w.executeRun('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await w.executeRun('INSERT INTO t (id, v) VALUES (?, ?)', [1, 'x']);
    await w.close();

    const ro = await createTursoAdapter({ dbPath, readonly: true });
    // Trigger the deferred real open (a read is enough — the -tshm verification
    // is skipped for readonly, so the shell's null verdict must survive the open).
    const row = await ro.executeGet<{ c: number }>('SELECT COUNT(*) as c FROM t');
    expect(row?.c).toBe(1);

    expect(ro.capabilities.walMode).toBe('multiprocess-wal');
    expect(ro.capabilities.walModeVerified).toBe(null);

    await ro.close();
  });
});
