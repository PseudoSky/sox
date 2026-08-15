/**
 * libs/host-runtime/src/runtime.spec.ts
 *
 * BUG-EPIC-WIRE-INPUTS-UNBOUNDED-001 (class A, site 3: runtime.ts:206 —
 * exec-socket read buffer). Before the fix, the [inv:exec-socket] server
 * accumulated `socket.on('data', ...)` chunks into a single string with no
 * cap while waiting for the terminating `\n`. A peer that connects and never
 * sends a newline — malicious, buggy, or a truncated write — grew that
 * buffer without bound until the process died of memory exhaustion. This
 * test feeds exactly that delimiter-less stream and asserts bounded memory
 * (the shim refuses once the cap is crossed) and a clean connection refusal,
 * never a hang.
 *
 * `SOX_ECOSYSTEM_HOME` reroutes the socket dir and the global supervisor
 * registry file under a per-test tmpdir (ADR-0004 §D2/D3) so this test never
 * touches the real `~/.adhd/sox-ecosystem/` state.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';

import { startRuntime, stopRuntime, type RuntimeRecord } from './runtime.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** Set up an isolated data root + empty (nonexistent) lockfile/config, start the
 * runtime (zero extensions — nothing to activate), and return its record plus a
 * teardown that stops the runtime and restores SOX_ECOSYSTEM_HOME. */
async function startIsolatedRuntime(): Promise<RuntimeRecord> {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-data-root-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-spec-'));
  const lockfilePath = path.join(projectDir, 'extensions.lock');
  const configPath = path.join(projectDir, 'config.json');
  const runtimeFilePath = path.join(projectDir, 'runtime.json');

  const prevHome = process.env['SOX_ECOSYSTEM_HOME'];
  process.env['SOX_ECOSYSTEM_HOME'] = dataRoot;

  const record = await startRuntime({
    scope: 'project',
    lockfilePath,
    configPath,
    runtimeFilePath,
    root: projectDir,
  });

  cleanups.push(async () => {
    await stopRuntime({ scope: 'project', runtimeFilePath });
    if (prevHome === undefined) delete process.env['SOX_ECOSYSTEM_HOME'];
    else process.env['SOX_ECOSYSTEM_HOME'] = prevHome;
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  return record;
}

describe('runtime.ts exec socket — bounded read buffer (BUG-EPIC-WIRE-INPUTS-UNBOUNDED-001)', () => {
  it('starts with an exec socket path in the runtime record', async () => {
    const record = await startIsolatedRuntime();
    expect(record.execSocketPath).toBeDefined();
    expect(fs.existsSync(record.execSocketPath!)).toBe(true);
  });

  it('a well-formed one-line request still round-trips normally (control)', async () => {
    const record = await startIsolatedRuntime();
    const sockPath = record.execSocketPath!;

    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = net.createConnection(sockPath);
      let buf = '';
      socket.on('connect', () => {
        socket.write(JSON.stringify({ list: true }) + '\n');
      });
      socket.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl !== -1) {
          resolve(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
          socket.end();
        }
      });
      socket.on('error', reject);
    });

    expect(response['result']).toBeDefined();
  });

  it('a delimiter-less stream past the cap is refused, not accumulated forever', async () => {
    const record = await startIsolatedRuntime();
    const sockPath = record.execSocketPath!;

    // 1 MiB past the exec socket's 8 MiB cap — enough to prove the cap is
    // enforced without needlessly flooding the connection once it is proven
    // crossed. Never send a '\n': this is the delimiter-less-peer scenario
    // (see runtime.ts's MAX_EXEC_LINE_BYTES).
    const OVER_CAP_BYTES = 9 * 1024 * 1024;

    const closed = await new Promise<boolean>((resolve, reject) => {
      const socket = net.createConnection(sockPath);
      const chunk = Buffer.alloc(1024 * 1024, 0x61); // 1 MiB of 'a' — no '\n' anywhere in it
      let written = 0;

      function pump(): void {
        if (written >= OVER_CAP_BYTES) return; // stop pumping; wait for the server to act
        written += chunk.length;
        const ok = socket.write(chunk);
        if (ok) setImmediate(pump);
        else socket.once('drain', pump);
      }

      socket.on('connect', () => pump());
      // The server refuses by destroying the socket — that's the clean
      // refusal this test is proving (no response body is expected on this
      // internal exec-socket protocol; the connection closing IS the signal).
      socket.on('close', () => resolve(true));
      socket.on('error', () => {
        // A write error after the server closes its read side is expected
        // once the client is still trying to send past the cap.
      });

      setTimeout(() => reject(new Error('timed out waiting for connection close — buffer may be unbounded again')), 10_000);
    });

    expect(closed).toBe(true);
  }, 15_000);
});
