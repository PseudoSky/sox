/**
 * connection-identity.kill9.spec.ts — 8468f7b1 SP-K9 (QUARANTINED lane, decision D3:
 * spawn-and-SIGKILL, same precedent as ensure-backend.spec.ts spawning real children).
 *
 * A real client process connects to serveBackend, spawns a long-lived grandchild
 * (the "Chrome" stand-in), and is SIGKILLed. The kernel closes the killed client's
 * fds, so onClientDisconnect must fire within 2 s even though the grandchild is
 * still alive.
 *
 * What this proves, exactly: with Node's default `child_process.spawn` (libuv), a
 * grandchild spawned detached with `stdio: 'ignore'` does not keep the client's
 * connected socket open, so the disconnect is observed. It does NOT prove CLOEXEC
 * for every spawn configuration: a grandchild given the socket through `stdio`
 * inheritance, or spawned by a non-libuv launcher, is a different case.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { serveBackend, type ClientDisconnectReason } from './backend.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const CLIENT_SCRIPT = `
const net = require('node:net');
const { spawn } = require('node:child_process');
const s = net.connect(process.argv[1], () => {
  const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', detached: true });
  g.unref();
  process.stdout.write('ready ' + g.pid + '\\n');
});
s.on('error', () => {});
setInterval(() => {}, 1000);
`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(pred: () => boolean, label: string, ms: number): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('SIGKILLed client is detected through the kernel closing its socket', () => {
  it('8468f7b1 SP-K9 SP3: onClientDisconnect fires within 2s of SIGKILL while a spawned grandchild lives (default libuv spawn, detached stdio-ignore grandchild)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-k9-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const events: string[] = [];
    const handle = await serveBackend({
      socketPath: path.join(dir, 'k9.sock'),
      handler: (req) => ({ jsonrpc: '2.0', id: req.id ?? null, result: {} }),
      onDiagnostic: () => {},
      onClientConnect: (id) => events.push(`connect:${id}`),
      onClientDisconnect: (id, r: ClientDisconnectReason) => events.push(`disconnect:${id}:${r}`),
    });
    cleanups.push(() => handle.close());

    const child = spawn(process.execPath, ['-e', CLIENT_SCRIPT, handle.socketPath], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let grandchild = 0;
    cleanups.push(() => {
      if (child.pid && alive(child.pid)) child.kill('SIGKILL');
      if (grandchild && alive(grandchild)) process.kill(grandchild, 'SIGKILL');
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    await until(() => /ready \d+/.test(out), 'client + grandchild ready', 10000);
    grandchild = Number(/ready (\d+)/.exec(out)![1]);
    await until(() => events.includes('connect:c1'), 'server saw the client', 3000);
    expect(alive(grandchild)).toBe(true);

    const killedAt = Date.now();
    child.kill('SIGKILL');
    await until(() => events.some((e) => e.startsWith('disconnect:c1:')), 'disconnect after SIGKILL', 2000);
    expect(Date.now() - killedAt).toBeLessThan(2000);
    // consumers must not rely on end vs error for a killed peer
    expect(['disconnect:c1:end', 'disconnect:c1:error']).toContain(events[events.length - 1]);
    // the grandchild outlived the client and did not pin the connection
    expect(alive(grandchild)).toBe(true);
  }, 20000);
});
