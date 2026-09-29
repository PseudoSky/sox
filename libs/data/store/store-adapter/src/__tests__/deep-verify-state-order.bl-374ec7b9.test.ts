/**
 * BL-374ec7b9 — the `running` deep-verify state write can never land after the
 * terminal outcome.
 *
 * `executeRun` recorded `running` fire-and-forget (`void writeDeepVerifyState`)
 * right after the fork. A verifier that finishes before that upsert commits
 * lets the terminal write (`ok`) land first, and the late `running` then
 * overwrites it: the durable record claims a pass is running forever, and the
 * `ok` evidence is gone.
 *
 * The race is made deterministic by delaying ONLY the `running` upsert by
 * ~800 ms; the fake verifier answers `ok` immediately.
 *
 * RED (fix disabled — the `running` write not awaited before `recordOutcome`):
 * the final state reads `running`. GREEN: it reads `ok`.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { DEEP_VERIFY_STATE_KEY, _activeDeepVerifyForTest, readDeepVerifyState } from '../deep-verify.js';
import { hasUncleanShutdown } from '../preflight.js';

const require = createRequire(import.meta.url);
const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch (err) {
    process.stderr.write(`[bl-374ec7b9 test] turso driver unavailable: ${String(err)}\n`);
    return false;
  }
})();

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..', '..');
const HOLDER = resolve(HERE, 'fixtures', 'bug019-open-child.ts');
const FAKE_OK = resolve(HERE, 'fixtures', 'deep-verify-fake-ok.mjs');

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bl-374ec7b9-'));
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Leave `dbPath` as a crashed session leaves it (open, then SIGKILL). */
async function crashStore(dbPath: string): Promise<void> {
  const proc = spawn(process.execPath, ['--import', 'tsx', HOLDER, dbPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: PKG_ROOT,
  });
  await new Promise<void>((ready, fail) => {
    let buf = '';
    proc.stdout?.on('data', (d: Buffer) => {
      buf += String(d);
      if (/READY=\d+/.test(buf)) ready();
    });
    proc.on('exit', (code, signal) => {
      if (!/READY=/.test(buf)) fail(new Error(`holder exited early code=${code} signal=${signal}`));
    });
  });
  const exited = new Promise((r) => proc.once('exit', r));
  proc.kill('SIGKILL');
  await exited;
  expect(hasUncleanShutdown(dbPath)).toBe(true);
}

(hasTurso ? describe : describe.skip)('BL-374ec7b9 — the running state never overwrites the outcome', () => {
  it('a slow running-state write still ends with the terminal ok record', async () => {
    const dbPath = join(tmpDir, 'order.db');
    await crashStore(dbPath);

    const proto = TursoAdapterImpl.prototype as unknown as {
      executeRun: (sql: string, params?: unknown[]) => Promise<unknown>;
    };
    const realRun = proto.executeRun;
    proto.executeRun = async function (this: unknown, sql: string, params?: unknown[]) {
      if (
        Array.isArray(params) &&
        params[0] === DEEP_VERIFY_STATE_KEY &&
        typeof params[1] === 'string' &&
        (JSON.parse(params[1]) as { status?: string }).status === 'running'
      ) {
        await new Promise((r) => setTimeout(r, 800));
      }
      return realRun.call(this, sql, params);
    };
    let adapter: TursoAdapterImpl | null = null;
    try {
      adapter = await TursoAdapterImpl.connect({
        dbPath,
        deepVerify: { schedule: 'owner', timeoutMs: 10_000, verifier: { path: FAKE_OK } },
      });
      await adapter.executeGet('SELECT 1 AS x'); // first use = real open, schedules deep
      const run = _activeDeepVerifyForTest(dbPath);
      expect(run).not.toBeNull();
      const outcome = await run!.done;
      expect(outcome?.status).toBe('ok');
      // Let a (buggy) late `running` write land before reading the record.
      await new Promise((r) => setTimeout(r, 1_200));
      expect((await readDeepVerifyState(adapter))?.status).toBe('ok');
    } finally {
      proto.executeRun = realRun;
      await adapter?.close();
    }
  }, 60_000);
});
