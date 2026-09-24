/**
 * bl-5b2fc7a2-serve-noproxy-signal-forward.spec.ts
 *
 * BL 5b2fc7a2-8a94-4c7a-a769-cd90b03e69d1 / docs/spec/service-lifecycle.md
 * `[contract:signal]`.
 *
 * In no-proxy mode (the log-tee default), `cmdServe` spawns the served
 * process as a grandchild with `stdio: ['inherit','inherit','pipe']` and
 * (pre-fix) installed NO SIGTERM/SIGHUP/SIGINT handler of its own. SIGTERM-ing
 * the `soxe serve` pid left the grandchild running and holding its store
 * lease forever.
 *
 * This is a real end-to-end reproduction: it spawns the actual built CLI
 * (`bin/soxe serve <fixture> --no-proxy`), lets the fixture grandchild report
 * its own pid, SIGTERMs the middle `soxe serve` process, and asserts the
 * grandchild pid is gone (ESRCH) within the grace period.
 *
 * RED (pre-fix, `cmdServe`'s log-tee branch has no signal handler): the
 * grandchild is still alive well past the grace period — `pidAlive` stays
 * true and the test times out waiting for it to go false.
 * GREEN (post-fix, `createServeChildSignalForwarder` wired into the log-tee
 * branch — apps/sox/src/main.ts, apps/sox/src/serve-shutdown.ts): the
 * grandchild exits within the grace period.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

// `__dirname` is the CJS global — this test file is compiled/run as CJS
// (see apps/sox/tsconfig.typecheck.json), same as the rest of apps/sox/src.
const REPO_ROOT = path.resolve(__dirname, '../../..');
const SOXE_BIN = path.join(REPO_ROOT, 'bin', 'soxe');

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(pred: () => boolean, timeoutMs: number, pollMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  if (pred()) return true;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    if (pred()) return true;
  }
  return pred();
}

let tmpRoot: string;
let serveProc: ChildProcess | undefined;

beforeAll(() => {
  // Fail fast with a clear message rather than a cryptic ENOENT if the
  // project hasn't been built — nx's `test` target depends on `build`, so in
  // the normal `npx nx test sox` path this is already satisfied.
  if (!fs.existsSync(path.join(REPO_ROOT, 'dist', 'apps', 'sox', 'main.js'))) {
    throw new Error(
      `dist/apps/sox/main.js is missing — run "npx nx build sox" before this suite ` +
      `(nx test's dependsOn:["build"] does this automatically).`,
    );
  }
}, 30_000);

afterEach(async () => {
  if (serveProc && serveProc.exitCode === null && serveProc.pid !== undefined) {
    try {
      process.kill(serveProc.pid, 'SIGKILL');
    } catch (e) {
      process.stderr.write(`[test cleanup] failed to SIGKILL leftover soxe-serve pid: ${(e as Error).message}\n`);
    }
  }
  serveProc = undefined;
  if (tmpRoot) {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch (e) {
      process.stderr.write(`[test cleanup] failed to remove tmpRoot ${tmpRoot}: ${(e as Error).message}\n`);
    }
  }
});

/** Build a scratch workspace with a minimal type:service local extension. */
function makeFixtureWorkspace(): { root: string; extId: string; pidFile: string; readyFile: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl5b2fc7a2-'));
  const extId = 'bl5b2fc7a2-fixture';
  const extDir = path.join(root, 'extensions', 'services', extId);
  fs.mkdirSync(extDir, { recursive: true });

  fs.writeFileSync(
    path.join(extDir, 'extension.json'),
    JSON.stringify(
      {
        id: extId,
        name: extId,
        type: 'service',
        version: '0.0.0',
        entrypoint: 'index.js',
      },
      null,
      2,
    ),
    'utf8',
  );

  const pidFile = path.join(root, 'child.pid');
  const readyFile = path.join(root, 'child.ready');
  // A trivial long-lived process. Deliberately installs NO signal handler of
  // its own — the bug/fix under test is entirely about whether `soxe serve`
  // FORWARDS the signal to it, not about the fixture's own shutdown logic.
  // Default Node behaviour for an unhandled SIGTERM is to terminate, which is
  // exactly what we need to observe forwarding (or its absence).
  fs.writeFileSync(
    path.join(extDir, 'index.js'),
    [
      "const fs = require('fs');",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      `fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');`,
      "process.stderr.write('fixture-ready pid=' + process.pid + '\\n');",
      'setInterval(() => {}, 1000);',
    ].join('\n'),
    'utf8',
  );

  return { root, extId, pidFile, readyFile };
}

describe('BL 5b2fc7a2 — cmdServe forwards SIGTERM to its no-proxy grandchild', () => {
  it(
    'SIGTERM on the soxe-serve pid reaps the grandchild within the grace period',
    async () => {
      const fixture = makeFixtureWorkspace();
      tmpRoot = fixture.root;

      const proc = spawn(
        process.execPath,
        [SOXE_BIN, 'serve', fixture.extId, '--root', fixture.root, '--no-proxy', '--grace-ms', '3000'],
        {
          cwd: REPO_ROOT,
          env: { ...process.env, SOX_SERVE_LOG: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      serveProc = proc;
      const servePid = proc.pid;
      expect(servePid).toBeDefined();

      let stderrBuf = '';
      proc.stderr?.on('data', (c: Buffer) => {
        stderrBuf += c.toString();
      });
      let stdoutBuf = '';
      proc.stdout?.on('data', (c: Buffer) => {
        stdoutBuf += c.toString();
      });

      // Wait for the fixture grandchild to report itself ready.
      const readyOk = await waitFor(() => fs.existsSync(fixture.readyFile), 15_000, 100);
      expect(readyOk, `fixture never became ready.\nstderr:\n${stderrBuf}\nstdout:\n${stdoutBuf}`).toBe(true);

      const grandchildPid = Number(fs.readFileSync(fixture.pidFile, 'utf8').trim());
      expect(Number.isInteger(grandchildPid) && grandchildPid > 0).toBe(true);
      expect(pidAlive(grandchildPid)).toBe(true);

      process.kill(servePid as number, 'SIGTERM');

      // Grace is 3000ms; give a comfortable margin for the poll loop + process
      // teardown scheduling on a loaded CI box.
      const grandchildGone = await waitFor(() => !pidAlive(grandchildPid), 8_000, 100);
      expect(
        grandchildGone,
        `grandchild pid ${grandchildPid} is still alive ${8_000}ms after SIGTERM-ing soxe serve pid ${servePid}.\n` +
          `stderr:\n${stderrBuf}\nstdout:\n${stdoutBuf}`,
      ).toBe(true);
    },
    20_000,
  );
});
