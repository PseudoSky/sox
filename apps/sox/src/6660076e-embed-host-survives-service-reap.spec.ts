/**
 * 6660076e — a service's reaper must never claim the shared embedding host.
 *
 * The embedding host is spawned BY a service (memory-server) but belongs to no
 * service: every consumer on the box shares it (ADR-0022 §5). It used to inherit
 * the spawner's env, including `SOX_SERVICE_ID`, so:
 *
 *   - `findOrphansByServiceId(<memory-server id>, token)` — the teardown path in
 *     `apps/sox/src/main.ts` (disable/stop/restart/uninstall) — matched it;
 *   - the OS-truth `ps` pass in `gatherProcessSnapshot` listed it as an
 *     unmanaged memory-server process.
 *
 * The spawner's entrypoint also travels to the host as provenance argv; it must
 * be a single `--spawner-entry=<path>` element, never a whitespace-bounded token
 * `reapByIdentity(<memory-server entrypoint>)` would match.
 *
 * Real processes: a fake "memory-server" (its argv[1] IS the identity token)
 * spawns the host from the embedding-provider source under tsx, then exits.
 * The host's private pool is a stub IPC host — no model.
 */
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findOrphansByServiceId,
  gatherProcessSnapshot,
  pidAlive,
  reapByIdentity,
} from '@adhd/sox-host-runtime';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PROVIDER_SRC = path.join(REPO_ROOT, 'libs', 'data', 'embed', 'embedding-provider', 'src');
const SERVICE_ID = 'memory-server-test';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function pidsMatching(needle: string): number[] {
  const out = execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const pids: number[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && m[2]!.includes(needle) && Number(m[1]) !== process.pid) pids.push(Number(m[1]));
  }
  return pids;
}

const STUB = `let model = null;
process.on('message', (msg) => {
  if (msg && msg.__shutdown) { try { process.disconnect(); } catch (e) { process.stderr.write(String(e)); } return; }
  const reply = (r) => { if (process.connected) process.send(Object.assign({ id: msg.id }, r)); };
  if (msg.type === 'init') { model = msg.model; reply({ initOk: true, dim: 3, execution_provider: 'cpu' }); return; }
  if (model === null) { reply({ error: 'Model not initialized' }); return; }
  reply({ embedding: [0, 0, 0] });
});
`;

describe('6660076e — the embed host survives a service reap', () => {
  it('findOrphansByServiceId, the OS-truth pass and reapByIdentity all leave the host alone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-6660076e-'));
    cleanups.push(() => {
      for (const pid of pidsMatching(dir)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const home = path.join(dir, 'home');
    const cache = path.join(dir, 'models');
    fs.mkdirSync(home);
    fs.mkdirSync(cache);
    const stub = path.join(dir, 'stub.mjs');
    fs.writeFileSync(stub, STUB);
    fs.mkdirSync(path.join(dir, 'host'));
    const shim = path.join(dir, 'host', 'embedHostMain-testshim.mjs');
    fs.writeFileSync(
      shim,
      `const mod = await import(${JSON.stringify(pathToFileURL(path.join(PROVIDER_SRC, 'embedHostMain.ts')).href)});\nawait mod.runEmbedHost();\n`,
    );

    // The fake memory-server: its entrypoint path is the reaper's identity token.
    const serviceRoot = path.join(dir, 'memory-server');
    fs.mkdirSync(path.join(serviceRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(serviceRoot, 'package.json'), '{"type":"module"}\n');
    const token = path.join(serviceRoot, 'dist', 'index.js');
    fs.writeFileSync(
      token,
      [
        `const mod = await import(${JSON.stringify(pathToFileURL(path.join(PROVIDER_SRC, 'index.ts')).href)});`,
        `const client = new mod.FunneledFastembedClient();`,
        `await client.request({ type: 'init', model: 'stub', cacheDir: ${JSON.stringify(cache)} }, 30000);`,
        `process.stderr.write('SPAWNER_OK\\n');`,
        `process.exit(0);`,
        '',
      ].join('\n'),
    );

    const base = process.env['NODE_OPTIONS'] ?? '';
    const code = await new Promise<number | null>((resolve) => {
      let stderr = '';
      const child = spawn(process.execPath, [token], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          NODE_OPTIONS: `${base} --import tsx`.trim(),
          SOX_ECOSYSTEM_HOME: home,
          SOX_FASTEMBED_HOST_PATH: stub,
          SOX_EMBED_HOST_MAIN: shim,
          SOX_EMBED_EXECUTION_PROVIDER: 'cpu',
          SOX_SERVICE_ID: SERVICE_ID,
          SOX_CONFIG_DB_PATH: path.join(dir, 'memory.db'),
          SOX_PERM_FS: 'rw',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      child.on('exit', (c) => {
        if (c !== 0) process.stderr.write(`[spawner stderr] ${stderr}\n`);
        resolve(c);
      });
    });
    expect(code).toBe(0);

    const hosts = pidsMatching(`${shim} --socket=`);
    expect(hosts, 'the spawner brought up exactly one host').toHaveLength(1);
    const hostPid = hosts[0]!;

    // 1. The service-id teardown path does not claim it.
    const byService = findOrphansByServiceId(SERVICE_ID, token).map((m) => m.pid);
    expect(byService).not.toContain(hostPid);

    // 2. The OS-truth pass does not list it as an unmanaged service process.
    const rows = gatherProcessSnapshot([], path.join(dir, 'sockets'), path.join(dir, 'logs'));
    expect(rows.filter((r) => r.pid === hostPid && r.source === 'ps-scan')).toEqual([]);

    // 3. Reaping the service by its entrypoint identity leaves the host alive.
    const reaped = await reapByIdentity(token, { graceMs: 500 });
    expect(reaped.killed.map((k) => k.pid)).not.toContain(hostPid);
    expect(pidAlive(hostPid)).toBe(true);
  }, 90_000);
});
