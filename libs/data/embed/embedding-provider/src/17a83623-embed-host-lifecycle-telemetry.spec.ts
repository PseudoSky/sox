/**
 * 17a83623 — embed-host lifecycle telemetry, verified against a PACKED artifact.
 *
 * On 2026-09-25 the host that served production was a published 0.5.3 build
 * whose source had changed after publish: it wrote no host telemetry at all, so
 * nobody could tell which build was answering. Source-level tests could not
 * have caught that — they run the source, not the bytes a consumer installs.
 *
 * This suite packs the real publish closure (`pnpm pack` of embedding-provider,
 * service-proxy, sox-telemetry, listen-guard), installs the tarballs into a
 * temp project OUTSIDE the workspace, and drives the funnel from there. The
 * host is the installed `dist/embedHostMain.js`. It must write, in order:
 *
 *   spawned{build_id, spawner_service, spawner_pid, denied_env}
 *   → model.init{trigger} → reap.armed → reap.fired → exit
 *
 * The test target depends on this project's own `build`, and the installed
 * files are checked for ADR-0022 markers so a stale dist fails loudly.
 */
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { destroyFunnelDir, readHostTelemetry, stubHostSource, waitFor } from './test-support/funnelHarness.js';

const PKG_ROOT = path.resolve(__dirname, '..');
const LIBS = path.resolve(PKG_ROOT, '..', '..', '..');
const CLOSURE: Record<string, string> = {
  '@adhd/sox-embedding-provider': PKG_ROOT,
  '@adhd/sox-service-proxy': path.join(LIBS, 'service-proxy'),
  '@adhd/sox-telemetry': path.join(LIBS, 'observability', 'sox-telemetry'),
  '@adhd/sox-listen-guard': path.join(LIBS, 'listen-guard'),
};

let root = '';
let app = '';

function tarballFor(packDir: string, before: Set<string>): string {
  const created = fs.readdirSync(packDir).filter((n) => n.endsWith('.tgz') && !before.has(n));
  if (created.length !== 1) throw new Error(`pnpm pack produced ${JSON.stringify(created)}`);
  return path.join(packDir, created[0]!);
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-17a83623-'));
  const packDir = path.join(root, 'packs');
  fs.mkdirSync(packDir);
  const tarballs: Record<string, string> = {};
  for (const [name, dir] of Object.entries(CLOSURE)) {
    const before = new Set(fs.readdirSync(packDir));
    execFileSync('pnpm', ['pack', '--pack-destination', packDir], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    tarballs[name] = tarballFor(packDir, before);
  }

  app = path.join(root, 'app');
  fs.mkdirSync(app);
  const fileRef = (name: string): string => `file:${tarballs[name]!}`;
  fs.writeFileSync(
    path.join(app, 'package.json'),
    JSON.stringify(
      {
        name: 'packed-embed-consumer',
        private: true,
        type: 'module',
        dependencies: { '@adhd/sox-embedding-provider': fileRef('@adhd/sox-embedding-provider') },
        // Pin the whole closure to the packed bytes — never the registry.
        pnpm: {
          overrides: Object.fromEntries(Object.keys(CLOSURE).map((n) => [n, fileRef(n)])),
        },
      },
      null,
      2,
    ),
  );
  execFileSync('pnpm', ['install', '--prefer-offline', '--ignore-scripts', '--no-frozen-lockfile'], {
    cwd: app,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, npm_config_workspace_root: '' },
  });
}, 600_000);

afterAll(() => {
  if (root) destroyFunnelDir({ dir: root, home: '', cache: '', stubPath: '', shimPath: '' });
});

function installedDist(name: string): string {
  return fs.realpathSync(path.join(app, 'node_modules', name, 'dist'));
}

function distContains(dir: string, marker: string): boolean {
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.js'))
    .some((n) => fs.readFileSync(path.join(dir, n), 'utf8').includes(marker));
}

describe('17a83623 — embed-host lifecycle telemetry (packed artifact)', () => {
  it('the installed closure is this build, not the registry', () => {
    const ep = installedDist('@adhd/sox-embedding-provider');
    for (const marker of ['reapDueInMs', 'buildEmbedHostEnv', 'embedding_provider.embed_host.spawned']) {
      expect(distContains(ep, marker), `installed embedding-provider dist lacks ${marker}`).toBe(true);
    }
    // Resolve service-proxy the way the installed embedding-provider does.
    const sp = fs.realpathSync(path.join(ep, '..', '..', 'sox-service-proxy', 'dist'));
    expect(distContains(sp, 'unlinkIfStillOurs'), 'installed service-proxy lacks the 448f9d93 guard').toBe(true);
  });

  it('writes spawned → model.init → reap.armed → reap.fired → exit, with spawner provenance', async () => {
    const home = path.join(root, 'home');
    const cache = path.join(root, 'models');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(cache, { recursive: true });
    const stub = path.join(root, 'stub.mjs');
    fs.writeFileSync(stub, stubHostSource());
    const consumer = path.join(app, 'consumer.mjs');
    fs.writeFileSync(
      consumer,
      [
        `import * as mod from '@adhd/sox-embedding-provider';`,
        `mod.configureEmbedHostIdleGraceMs(500);`,
        `const client = mod.getSharedFastembedProcess();`,
        `await client.request({ type: 'init', model: 'stub', cacheDir: ${JSON.stringify(cache)} }, 30000);`,
        `await client.request({ type: 'embed', text: 'hello' }, 30000);`,
        `process.stderr.write('CONSUMER_OK\\n');`,
        `process.exit(0);`,
        '',
      ].join('\n'),
    );

    let consumerPid = -1;
    const code = await new Promise<number | null>((resolve) => {
      let stderr = '';
      const child = spawn(process.execPath, [consumer], {
        cwd: app,
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: process.env['HOME'] ?? '',
          TMPDIR: process.env['TMPDIR'] ?? os.tmpdir(),
          SOX_ECOSYSTEM_HOME: home,
          SOX_FASTEMBED_HOST_PATH: stub,
          SOX_EMBED_EXECUTION_PROVIDER: 'cpu',
          SOX_SERVICE_ID: 'memory-server-test',
          SOX_CONFIG_DB_PATH: path.join(root, 'memory.db'),
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      consumerPid = child.pid ?? -1;
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      child.on('exit', (c) => {
        if (c !== 0) process.stderr.write(`[consumer stderr] ${stderr}\n`);
        resolve(c);
      });
    });
    expect(code).toBe(0);

    // The host retires 500 ms after its last work; wait for its exit record.
    await waitFor(
      () => readHostTelemetry(home).some((r) => r['event'] === 'embedding_provider.embed_host.exit'),
      15_000,
      'the host exit record',
    );

    const records = readHostTelemetry(home);
    const spawned = records.find((r) => r['event'] === 'embedding_provider.embed_host.spawned');
    expect(spawned, 'spawned record').toBeDefined();
    const hostPid = spawned!['pid'];
    const mine = records.filter((r) => r['pid'] === hostPid);
    const lifecycle = [
      'embedding_provider.embed_host.spawned',
      'embedding_provider.embed_host.model.init',
      'embedding_provider.embed_host.reap.armed',
      'embedding_provider.embed_host.reap.fired',
      'embedding_provider.embed_host.exit',
    ];
    const seen = mine.map((r) => String(r['event'])).filter((e) => lifecycle.includes(e));
    // In order, as a subsequence (reap.armed may repeat as work re-arms it).
    let at = 0;
    for (const e of seen) if (e === lifecycle[at]) at++;
    expect(at, `lifecycle order; saw ${JSON.stringify(seen)}`).toBe(lifecycle.length);

    expect(spawned!['build_id']).toMatch(/^[0-9a-f]{12}$/);
    expect(spawned!['spawner_service']).toBe('memory-server-test');
    expect(spawned!['spawner_pid']).toBe(consumerPid);
    expect(spawned!['denied_env']).toEqual(expect.arrayContaining(['SOX_CONFIG_DB_PATH', 'SOX_SERVICE_ID']));
    const init = mine.find((r) => r['event'] === 'embedding_provider.embed_host.model.init');
    expect(init!['trigger']).toBe('eager');
    const fired = mine.find((r) => r['event'] === 'embedding_provider.embed_host.reap.fired');
    expect(fired!['reason']).toBe('idle_window_elapsed');
    const exit = mine.find((r) => r['event'] === 'embedding_provider.embed_host.exit');
    expect(exit!['code']).toBe(0);
    // The telemetry is the host's own, under its own service name.
    expect(spawned!['service']).toBe('embed-host');
  }, 60_000);
});
