/**
 * turso-driver-host-wal.bl-862129b5.test.ts — packet TUR-C, plan `862129b5`.
 *
 * Moving the native driver onto a process-wide worker thread must not perturb
 * the store's multi-process WAL contract:
 *
 *   1. two worker-hosted connections on the SAME path are served by the ONE
 *      process-wide worker (identical `workerThreadId`, `openConnections === 2`),
 *      and both can read/write the shared store;
 *   2. a REAL child process writing alongside the worker-hosted connection
 *      coordinates through the store's `-tshm` multiprocess-WAL map — 500 rows
 *      from the parent's worker-hosted connection plus 500 from the child give
 *      exactly 1000, with `PRAGMA integrity_check` clean.
 *
 * The child exists so the second writer is genuinely out-of-process (its own
 * driver instance, its own pid): an in-process second connection shares the
 * worker's module state and cannot exercise the on-disk coordination this arm
 * is about. It imports the native driver by its resolved absolute path so the
 * fixture need not be a committed file (the host has no test fixtures of its
 * own — the temp script is written at run time and removed with the temp dir).
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
let driverPath: string | undefined;
const hasTurso = (() => {
  try {
    driverPath = require.resolve('@tursodatabase/database');
    return true;
  } catch (err) {
    process.stderr.write(`[turso-driver-host-wal test] driver unavailable: ${String(err)}\n`);
    return false;
  }
})();
const itTurso = hasTurso ? it : it.skip;

type HostModule = typeof import('../turso-driver-host.js');
type Connection = Awaited<ReturnType<HostModule['openTursoConnection']>>;

const HOST_SLOT = Symbol.for('@adhd/sox-store-adapter/turso-driver-host');

interface SlotShape {
  protocol: number;
  host: { _resetForTest(): Promise<void> };
}

function slot(): SlotShape | undefined {
  return (globalThis as unknown as Record<symbol, SlotShape | undefined>)[HOST_SLOT];
}

async function freshHost(): Promise<HostModule> {
  vi.resetModules();
  return (await import('../turso-driver-host.js')) as HostModule;
}

async function resetHost(): Promise<void> {
  const s = slot();
  if (s !== undefined) await s.host._resetForTest();
  delete (globalThis as unknown as Record<symbol, unknown>)[HOST_SLOT];
}

const OPEN_OPTS: Record<string, unknown> = {
  experimental: ['index_method', 'multiprocess_wal'],
  timeout: 5_000,
};

let dir: string;
let seq = 0;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'turso-driver-host-wal-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
afterEach(async () => {
  await resetHost();
});

function dbPath(label: string): string {
  seq += 1;
  return join(dir, `${label}-${seq}.db`);
}

/** Build one `INSERT INTO t (v) VALUES (?),(?)…` statement and its bound values. */
function bulkInsert(n: number, prefix: string): { sql: string; args: string[] } {
  const placeholders = Array.from({ length: n }, () => '(?)').join(',');
  return {
    sql: `INSERT INTO t (v) VALUES ${placeholders}`,
    args: Array.from({ length: n }, (_, i) => `${prefix}${i}`),
  };
}

/**
 * The out-of-process writer. It imports the driver from the absolute path in
 * argv so its own module resolution is irrelevant to where it runs from.
 */
const CHILD_SOURCE = `
import { pathToFileURL } from 'node:url';
const [, , dbPath, driverPath, nRaw] = process.argv;
const n = Number(nRaw);
const mod = await import(pathToFileURL(driverPath).href);
const db = await mod.connect(dbPath, { experimental: ['index_method', 'multiprocess_wal'], timeout: 5000 });
try {
  const placeholders = Array.from({ length: n }, () => '(?)').join(',');
  const values = Array.from({ length: n }, (_, i) => 'c' + i);
  await db.run('INSERT INTO t (v) VALUES ' + placeholders, ...values);
  process.stdout.write(JSON.stringify({ ok: true, inserted: n }) + '\\n');
} finally {
  await db.close();
}
`;

function runChild(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += String(d);
    });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('turso-driver-host — multiprocess WAL across the worker boundary', () => {
  itTurso('two connections on the same path share ONE worker thread', async () => {
    const host = await freshHost();
    const path = dbPath('shared-path');

    const a: Connection = await host.openTursoConnection(path, OPEN_OPTS);
    const b: Connection = await host.openTursoConnection(path, OPEN_OPTS);

    const status = host.getTursoDriverStatus();
    expect(status.openConnections).toBe(2);
    expect(status.workerThreadId).not.toBeNull();
    // Both connections are served by the ONE process-wide worker — the very
    // reason the host is a singleton (a per-connection worker would be two
    // new driver instances against one store).
    expect(host.getTursoDriverStatus().workerThreadId).toBe(status.workerThreadId);

    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await b.run('INSERT INTO t (v) VALUES (?)', 'x');
    const got = await a.get('SELECT COUNT(*) AS n FROM t');
    expect(Number(got?.['n'])).toBe(1);

    await a.close();
    await b.close();
  });

  itTurso('a real child process writes alongside the worker-hosted adapter: 500 + 500 = 1000, integrity ok', async () => {
    const host = await freshHost();
    const path = dbPath('cross-process');
    const conn = await host.openTursoConnection(path, OPEN_OPTS);
    await conn.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');

    // 500 rows from the worker-hosted connection.
    const parentInsert = bulkInsert(500, 'p');
    await conn.run(parentInsert.sql, ...parentInsert.args);

    // 500 rows from a genuine child process holding the same store.
    const scriptPath = join(dir, `wal-child-${seq}.mjs`);
    writeFileSync(scriptPath, CHILD_SOURCE);
    const child = await runChild([scriptPath, path, driverPath as string, '500']);
    expect(
      child.code,
      `child writer failed (code ${String(child.code)}): ${child.stderr || child.stdout}`,
    ).toBe(0);
    expect(child.stdout).toContain('"inserted":500');

    const row = await conn.get('SELECT COUNT(*) AS n FROM t');
    expect(Number(row?.['n'])).toBe(1000);

    const integrity = await conn.all('PRAGMA integrity_check');
    const messages = integrity
      .flatMap((r) => Object.values(r))
      .filter((v): v is string => typeof v === 'string');
    expect(messages).toContain('ok');

    await conn.close();
  });
});
