/**
 * check-publishable.test.ts — regression test for the registry-existence gate (rule 2).
 *
 * The defect this locks shut: `check-publishable.ts` built its "published" set from the
 * workspace `private` flag and NEVER consulted the npm registry, so it reported OK while
 * `@adhd/sox-telemetry` — a hard `workspace:*` RUNTIME dependency of `store-adapter` and
 * `memory-core` — was E404 on npm. Changesets rewrites `workspace:*` to a concrete version
 * at publish, so that publish would have shipped a hard 404 to every consumer, and
 * transitively to `graph-store`.
 *
 * Each case builds a disposable fixture workspace and points the gate at a local fixture
 * registry (`--registry`), so the assertions do not depend on the live publish state of any
 * real package — a test that went green on its own the day `sox-telemetry` got published
 * would prove nothing.
 *
 * Cases:
 *   1. RED   — dep absent from the registry            → exit 1, names the dep
 *   2. GREEN — same tree, dep present on the registry  → exit 0
 *   3. dep absent BUT covered by a pending changeset   → exit 0, NOTE (publishes same run)
 *   4. registry has the packument but ZERO versions    → exit 1 (unpublished placeholder)
 *   5. --offline                                       → exit 1 (fail-closed, never green)
 *   6. registry unreachable                            → exit 1, UNVERIFIABLE (fail-closed)
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-publishable.ts');

const CONSUMER = '@adhd/sox-fixture-consumer';
const DEP = '@adhd/sox-fixture-dep';

const tempRoots: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const d of tempRoots.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A workspace with one publishable consumer holding a `workspace:*` runtime dep on DEP. */
function makeFixtureWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-publishable-'));
  tempRoots.push(root);
  const write = (rel: string, json: unknown): void => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, JSON.stringify(json, null, 2));
  };
  write('libs/consumer/package.json', {
    name: CONSUMER,
    version: '1.0.0',
    private: false,
    engines: { node: '>=20' },
    dependencies: { [DEP]: 'workspace:*' },
  });
  write('libs/dep/package.json', {
    name: DEP,
    version: '1.0.0',
    private: false,
    engines: { node: '>=20' },
  });
  return root;
}

/**
 * Fixture registry. `known` maps package name → packument (or null to 404).
 * Standing this up is what makes "simulate the published case" honest: the gate
 * has no test backdoor, it really performs an HTTP existence probe.
 */
async function startFixtureRegistry(
  known: Record<string, { versions: Record<string, unknown> } | null>,
): Promise<string> {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').slice(1));
    const entry = known[name];
    if (entry === undefined || entry === null) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name, ...entry }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return `http://127.0.0.1:${addr.port}`;
}

/**
 * MUST be async: the fixture registry runs on this process's event loop, so a
 * blocking spawnSync here would deadlock — the child's probe could never be served.
 */
async function run(root: string, extraArgs: string[]): Promise<{ code: number; out: string }> {
  const env = { ...process.env };
  delete env['npm_config_registry'];
  const child = spawn('npx', ['tsx', SCRIPT, root, ...extraArgs], { cwd: REPO_ROOT, env });
  let out = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (out += d.toString()));
  const code = await new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? -1)));
  return { code, out };
}

describe('check-publishable — registry existence gate (rule 2)', () => {
  it('FAILS, naming the package, when a workspace:* runtime dep does not exist on the registry', async () => {
    const root = makeFixtureWorkspace();
    const registry = await startFixtureRegistry({ [DEP]: null });

    const { code, out } = await run(root, ['--registry', registry]);

    expect(code).toBe(1);
    expect(out).toContain('DOES NOT EXIST');
    expect(out).toContain(DEP);
    // The offending PAIR must be named, not just the missing package.
    expect(out).toContain('libs/consumer/package.json');
  }, 60_000);

  it('PASSES on the identical tree once that dep exists on the registry', async () => {
    const root = makeFixtureWorkspace();
    const registry = await startFixtureRegistry({ [DEP]: { versions: { '1.0.0': {} } } });

    const { code, out } = await run(root, ['--registry', registry]);

    expect(out).not.toContain('DOES NOT EXIST');
    expect(out).toContain('check-publishable: OK');
    expect(code).toBe(0);
  }, 60_000);

  it('PASSES with a NOTE when the missing dep has a pending changeset (publishes in the same run)', async () => {
    const root = makeFixtureWorkspace();
    fs.mkdirSync(path.join(root, '.changeset'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.changeset', 'brave-pandas-sing.md'),
      `---\n'${DEP}': minor\n---\n\nFirst publish.\n`,
    );
    const registry = await startFixtureRegistry({ [DEP]: null });

    const { code, out } = await run(root, ['--registry', registry]);

    expect(out).toContain('NOTE');
    expect(out).toContain('pending changeset');
    expect(code).toBe(0);
  }, 60_000);

  it('FAILS when the registry knows the name but has zero published versions', async () => {
    const root = makeFixtureWorkspace();
    const registry = await startFixtureRegistry({ [DEP]: { versions: {} } });

    const { code, out } = await run(root, ['--registry', registry]);

    expect(code).toBe(1);
    expect(out).toContain('zero published versions');
  }, 60_000);

  it('FAILS CLOSED in --offline mode rather than degrading to green', async () => {
    const root = makeFixtureWorkspace();
    // Registry would say "published" — offline must STILL fail, because it did not ask.
    const registry = await startFixtureRegistry({ [DEP]: { versions: { '1.0.0': {} } } });

    const { code, out } = await run(root, ['--registry', registry, '--offline']);

    expect(code).toBe(1);
    expect(out).toContain('OFFLINE MODE');
    expect(out).toContain('UNVERIFIED');
  }, 60_000);

  it('FAILS CLOSED when the registry is unreachable (never assumes published)', async () => {
    const root = makeFixtureWorkspace();
    // Bind and immediately release a port so nothing is listening on it.
    const dead = await startFixtureRegistry({});
    for (const s of servers.splice(0)) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }

    const { code, out } = await run(root, ['--registry', dead, '--probe-timeout-ms', '2000']);

    expect(code).toBe(1);
    expect(out).toContain('UNVERIFIABLE');
    expect(out).toContain('fails closed');
  }, 60_000);
});
