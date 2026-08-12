/**
 * telemetry-crash-durability.spec.ts — BL-365.
 *
 * The claim under test is not "records reach the file eventually". It is
 * "records are on disk at the instant the process dies without warning".
 * Those differ by everything that matters: a *hang* loses nothing (the process
 * is alive and a stream drains), while a SIGKILL, a panic, or a power cut loses
 * exactly the window the log exists to describe. The host lost power
 * mid-backfill on 2026-07-30 (BL-338), so this is not hypothetical.
 *
 * A test that wrote records and then read the file back IN THE SAME PROCESS
 * would pass against the broken implementation, because a graceful exit flushes.
 * So each case spawns a real child that writes N records through the real
 * `log.*` API and then `SIGKILL`s ITSELF — no exit handlers, no flush, no
 * chance to clean up — and the parent counts what survived on disk.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let childScript: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bl365-'));
  childScript = join(dir, 'crash-child.cjs');
  // The child imports the COMPILED telemetry module and uses the real `log`
  // API — not a hand-rolled writer — so the test exercises the shipping path.
  writeFileSync(
    childScript,
    `const { log } = require(process.argv[2]);
     const n = parseInt(process.argv[3], 10);
     for (let i = 0; i < n; i++) log.info('bl365.record', { seq: i });
     process.kill(process.pid, 'SIGKILL');   // hard crash: no flush, no handlers
    `,
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Resolve the built telemetry module the child will require. */
function telemetryModulePath(): string {
  const built = join(__dirname, '..', 'dist', 'telemetry.js');
  return built;
}

/**
 * Spawn a child that writes `n` records then SIGKILLs itself.
 * Returns how many records are on disk afterwards.
 */
function survivorsAfterSigkill(n: number, logDir: string, sync: boolean | null): number {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SOX_MEMORY_LOG_DIR: logDir,
    SOX_MEMORY_LOG_COMPONENT: 'bl365',
  };
  if (sync !== null) env['SOX_MEMORY_LOG_SYNC'] = sync ? '1' : '0';

  try {
    execFileSync(process.execPath, [childScript, telemetryModulePath(), String(n)], {
      env,
      stdio: 'ignore',
      timeout: 20_000,
    });
  } catch {
    // SIGKILL means a non-zero exit — that is the point of the test.
  }

  if (!existsSync(logDir)) return 0;
  let total = 0;
  for (const f of readdirSync(logDir)) {
    if (!f.startsWith('bl365-') || !f.endsWith('.jsonl')) continue;
    const body = readFileSync(join(logDir, f), 'utf8');
    total += body.split('\n').filter((l) => l.includes('bl365.record')).length;
  }
  return total;
}

describe('BL-365 — telemetry survives a hard crash', () => {
  it.each([100, 1000, 10000])(
    'all %i records are on disk after SIGKILL (default = durable)',
    (n) => {
      const logDir = join(dir, `default-${n}`);
      // Default, with SOX_MEMORY_LOG_SYNC unset — the shipped configuration.
      // Before BL-365 this measured 0 survivors at every N.
      expect(survivorsAfterSigkill(n, logDir, null)).toBe(n);
    },
    30_000,
  );

  it('explicit SOX_MEMORY_LOG_SYNC=1 survives SIGKILL', () => {
    const logDir = join(dir, 'explicit-sync');
    expect(survivorsAfterSigkill(1000, logDir, true)).toBe(1000);
  }, 30_000);

  it('NEGATIVE CONTROL: SOX_MEMORY_LOG_SYNC=0 loses records — the pre-BL-365 behaviour', () => {
    // This is what makes the assertions above meaningful. If buffered mode also
    // survived, the test would be measuring something other than durability
    // (e.g. the OS flushing fast enough on this machine) and every green above
    // would be uninformative.
    const logDir = join(dir, 'buffered');
    const survived = survivorsAfterSigkill(10000, logDir, false);
    expect(survived).toBeLessThan(10000);
  }, 30_000);

  it('a GRACEFUL exit loses nothing in either mode — isolating what actually changed', () => {
    // Proves the defect was specific to hard kills. A test that only checked
    // the graceful path would have passed against the broken implementation,
    // which is precisely why this defect survived unnoticed.
    const gracefulScript = join(dir, 'graceful-child.cjs');
    writeFileSync(
      gracefulScript,
      `const { log } = require(process.argv[2]);
       for (let i = 0; i < 500; i++) log.info('bl365.record', { seq: i });
      `,
    );
    for (const [label, sync] of [['sync', '1'], ['buffered', '0']] as const) {
      const logDir = join(dir, `graceful-${label}`);
      execFileSync(process.execPath, [gracefulScript, telemetryModulePath()], {
        env: {
          ...process.env,
          SOX_MEMORY_LOG_DIR: logDir,
          SOX_MEMORY_LOG_COMPONENT: 'bl365',
          SOX_MEMORY_LOG_SYNC: sync,
        },
        stdio: 'ignore',
        timeout: 20_000,
      });
      let total = 0;
      for (const f of readdirSync(logDir)) {
        total += readFileSync(join(logDir, f), 'utf8')
          .split('\n')
          .filter((l) => l.includes('bl365.record')).length;
      }
      expect(total, `${label} graceful exit`).toBe(500);
    }
  }, 30_000);
});
