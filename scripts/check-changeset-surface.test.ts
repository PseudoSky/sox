/**
 * check-changeset-surface.test.ts — regression test for the BL-460 surface gate.
 *
 * Each case builds a disposable fixture workspace (a publishable package with a
 * local `dist/*.d.ts`) and points the gate at a local fixture HTTP registry that
 * serves both the packument (`dist-tags.latest` / `dist.tarball`) and the raw
 * tarball bytes — so the assertions do not depend on the live registry state of
 * any real `@adhd/sox-*` package, and the gate really performs an HTTP fetch +
 * `tar` extraction, no test backdoor.
 *
 * Cases:
 *   1. RED   — local dist/*.d.ts differs from published, no changeset  → exit 1
 *   2. GREEN — same diff, but a pending changeset names the package    → exit 0
 *   3. GREEN — local dist/*.d.ts byte-identical to published            → exit 0
 *      (no changeset needed — nothing to gate)
 *   4. --ci + missing local dist/                                       → exit 1
 *   5. default (no --ci) + missing local dist/                          → exit 0, WARN
 *   6. --offline                                                        → exit 1 (fail-closed)
 *   7. registry unreachable for the packument                           → exit 1, UNVERIFIABLE
 *   8. package not yet published (packument 404, first publish)         → exit 0
 *   9. C1(b) RED — a BUNDLE with no `dist/*.d.ts` but a changed
 *      `dist/schema.json` tool list, no changeset                       → exit 1
 *  10. C1(b) GREEN — the same bundle diff, a pending changeset          → exit 0
 *  11. C1(b) GREEN — bundle `dist/schema.json` byte-identical           → exit 0
 *  12. C1(b) NEGATIVE CONTROL — the pre-C1(b) script (fallback patched out)
 *      MISSES the exact diff case 9 catches                              → exit 0
 *      (proves case 9 has teeth: it goes red only because of the fallback)
 */

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-changeset-surface.ts');

const PKG_NAME = '@adhd/sox-fixture-surface';

// The exact source line the C1(b) fallback lives on — the negative-control test
// patches it out to reproduce the pre-C1(b) "no schema.json fallback" script.
const FALLBACK_SOURCE_LINE =
  "  if (fs.existsSync(path.join(pkgRoot, SURFACE_FALLBACK_FILE))) {\n" +
  "    return { files: [SURFACE_FALLBACK_FILE], via: 'schema' };\n" +
  '  }';


const tempRoots: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const d of tempRoots.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function mktemp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(d);
  return d;
}

/** A workspace with one publishable package holding a local dist/*.d.ts. */
function makeFixtureWorkspace(localDtsContent: string | null): string {
  const root = mktemp('check-changeset-surface-');
  const write = (rel: string, content: string): void => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  write(
    'libs/fixture-surface/package.json',
    JSON.stringify(
      { name: PKG_NAME, version: '1.0.0', private: false, engines: { node: '>=20' } },
      null,
      2,
    ),
  );
  if (localDtsContent !== null) {
    write('libs/fixture-surface/dist/index.d.ts', localDtsContent);
  }
  return root;
}

/**
 * A BUNDLE workspace: a publishable package whose `dist/` carries no `.d.ts` —
 * only the tool-list snapshot `dist/schema.json` (memory-server's real shape).
 * `localSchemaContent === null` means no local dist/ at all.
 */
function makeBundleFixtureWorkspace(localSchemaContent: string | null): string {
  const root = mktemp('check-changeset-surface-bundle-');
  const write = (rel: string, content: string): void => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  write(
    'libs/fixture-surface/package.json',
    JSON.stringify({ name: PKG_NAME, version: '1.0.0', private: false }, null, 2),
  );
  if (localSchemaContent !== null) {
    write('libs/fixture-surface/dist/schema.json', localSchemaContent);
  }
  return root;
}

/** Writes a copy of the gate script with the C1(b) schema.json fallback patched
 *  out — the pre-C1(b) script — so the negative control runs the REAL tool minus
 *  only the fix, not a stub. Throws if the marker line moved (test maintenance). */
function writePreFixVariantScript(): string {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  if (!src.includes(FALLBACK_SOURCE_LINE)) {
    throw new Error(
      'negative-control marker not found in scripts/check-changeset-surface.ts — ' +
        'the C1(b) fallback line moved; update FALLBACK_SOURCE_LINE in this test.',
    );
  }
  const patched = src.replace(
    FALLBACK_SOURCE_LINE,
    "  // negative control: pre-C1(b) behaviour — no schema.json fallback.\n",
  );
  const dir = mktemp('check-changeset-surface-pre-fix-');
  const p = path.join(dir, 'check-changeset-surface.ts');
  fs.writeFileSync(p, patched);
  return p;
}

/** Packs `{relPath: content}` into an npm-shaped tarball (`package/<relPath>`). */
function buildTarball(files: Record<string, string>): Buffer {
  const stage = mktemp('check-changeset-surface-tarball-');
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(stage, 'package', rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const tarFile = path.join(stage, 'out.tgz');
  const res = spawnSync('tar', ['-czf', tarFile, '-C', stage, 'package'], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`fixture tar failed: ${res.stderr}`);
  return fs.readFileSync(tarFile);
}

/**
 * Fixture registry serving a packument at `/<name>` (dist-tags.latest pointing at
 * `/tarballs/<name>.tgz`) and the raw tarball bytes at that path. `notFound: true`
 * simulates a 404 (unpublished / no matching name).
 */
async function startFixtureRegistry(opts: {
  name: string;
  version?: string;
  tarball?: Buffer;
  notFound?: boolean;
}): Promise<string> {
  const version = opts.version ?? '1.0.0';
  let base = '';
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/tarballs/')) {
      if (!opts.tarball) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(opts.tarball);
      return;
    }
    const name = decodeURIComponent(url.slice(1));
    if (opts.notFound || name !== opts.name) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        name: opts.name,
        'dist-tags': { latest: version },
        versions: {
          [version]: { dist: { tarball: `${base}/tarballs/${encodeURIComponent(opts.name)}.tgz` } },
        },
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}`;
  return base;
}

async function run(
  root: string,
  extraArgs: string[],
  scriptPath: string = SCRIPT,
): Promise<{ code: number; out: string }> {
  const env = { ...process.env };
  delete env['npm_config_registry'];
  const child = spawn('npx', ['tsx', scriptPath, root, ...extraArgs], { cwd: REPO_ROOT, env });
  let out = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (out += d.toString()));
  const code = await new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? -1)));
  return { code, out };
}

describe('check-changeset-surface — BL-460 gate', () => {
  it('FAILS, naming the package, when local dist/*.d.ts differs from published and no changeset exists', async () => {
    const root = makeFixtureWorkspace('export interface Foo { bar: string; baz: number; }\n');
    const tarball = buildTarball({ 'dist/index.d.ts': 'export interface Foo { bar: string; }\n' });
    const registry = await startFixtureRegistry({ name: PKG_NAME, tarball });

    const { code, out } = await run(root, ['--registry', registry]);

    expect(code).toBe(1);
    expect(out).toContain('differs from the published');
    expect(out).toContain(PKG_NAME);
    expect(out).toContain('no .changeset/*.md');
  }, 60_000);

  it('PASSES with a NOTE when the same diff is covered by a pending changeset', async () => {
    const root = makeFixtureWorkspace('export interface Foo { bar: string; baz: number; }\n');
    fs.mkdirSync(path.join(root, '.changeset'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.changeset', 'brave-pandas-sing.md'),
      `---\n'${PKG_NAME}': minor\n---\n\nAdd baz.\n`,
    );
    const tarball = buildTarball({ 'dist/index.d.ts': 'export interface Foo { bar: string; }\n' });
    const registry = await startFixtureRegistry({ name: PKG_NAME, tarball });

    const { code, out } = await run(root, ['--registry', registry]);

    expect(out).toContain('pending changeset');
    expect(code).toBe(0);
  }, 60_000);

  it('PASSES when local dist/*.d.ts is byte-identical to published, regardless of changeset presence', async () => {
    const content = 'export interface Foo { bar: string; }\n';
    const root = makeFixtureWorkspace(content);
    const tarball = buildTarball({ 'dist/index.d.ts': content });
    const registry = await startFixtureRegistry({ name: PKG_NAME, tarball });

    const { code, out } = await run(root, ['--registry', registry]);

    expect(code).toBe(0);
    expect(out).toContain('check-changeset-surface: OK');
  }, 60_000);

  it('--ci FAILS when a publishable package has no local dist/', async () => {
    const root = makeFixtureWorkspace(null);
    const registry = await startFixtureRegistry({ name: PKG_NAME, notFound: true });

    const { code, out } = await run(root, ['--registry', registry, '--ci']);

    expect(code).toBe(1);
    expect(out).toContain('no local dist/');
    expect(out).toContain(PKG_NAME);
  }, 60_000);

  it('default mode SKIPS with a WARN (not a failure) when a publishable package has no local dist/', async () => {
    const root = makeFixtureWorkspace(null);
    const registry = await startFixtureRegistry({ name: PKG_NAME, notFound: true });

    const { code, out } = await run(root, ['--registry', registry]);

    expect(code).toBe(0);
    expect(out).toContain('WARN');
    expect(out).toContain('no local dist/');
  }, 60_000);

  it('FAILS CLOSED in --offline mode rather than degrading to green', async () => {
    const root = makeFixtureWorkspace('export interface Foo { bar: string; }\n');
    const tarball = buildTarball({ 'dist/index.d.ts': 'export interface Foo { bar: string; }\n' });
    const registry = await startFixtureRegistry({ name: PKG_NAME, tarball });

    const { code, out } = await run(root, ['--registry', registry, '--offline']);

    expect(code).toBe(1);
    expect(out).toContain('OFFLINE MODE');
  }, 60_000);

  it('FAILS CLOSED (UNVERIFIABLE) when the registry is unreachable for the packument', async () => {
    const root = makeFixtureWorkspace('export interface Foo { bar: string; }\n');
    const dead = await startFixtureRegistry({ name: PKG_NAME });
    for (const s of servers.splice(0)) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }

    const { code, out } = await run(root, ['--registry', dead, '--probe-timeout-ms', '2000']);

    expect(code).toBe(1);
    expect(out).toContain('UNVERIFIABLE');
  }, 60_000);

  it('PASSES when the package has never been published (packument 404, first publish)', async () => {
    const root = makeFixtureWorkspace('export interface Foo { bar: string; }\n');
    const registry = await startFixtureRegistry({ name: PKG_NAME, notFound: true });

    const { code, out } = await run(root, ['--registry', registry]);

    expect(code).toBe(0);
    expect(out).toContain('first publish');
  }, 60_000);

  // ── C1(b): bundle-only surface changes (no dist/*.d.ts) ────────────────────
  // The defect: a bundle whose dist/ has no `.d.ts` (memory-server ships only
  // index.js + schema.json) hit "no *.d.ts — nothing to diff" and `continue`d,
  // so adding a memory_* tool changed the published surface with the gate green.
  // The fallback diffs the bundle's dist/schema.json tool list instead.
  const SCHEMA_BEFORE = JSON.stringify({ tools: [{ name: 'memory_ping' }, { name: 'memory_write' }] });
  const SCHEMA_AFTER = JSON.stringify({
    tools: [
      { name: 'memory_ping' },
      { name: 'memory_write' },
      { name: 'memory_claim_upsert' },
    ],
  });

  it('C1(b) FAILS when a bundle with no *.d.ts changed its dist/schema.json tool list and no changeset exists', async () => {
    const root = makeBundleFixtureWorkspace(SCHEMA_AFTER);
    const tarball = buildTarball({ 'dist/schema.json': SCHEMA_BEFORE });
    const registry = await startFixtureRegistry({ name: PKG_NAME, tarball });

    const { code, out } = await run(root, ['--registry', registry]);

    expect(code).toBe(1);
    expect(out).toContain('differs from the published');
    expect(out).toContain('schema.json tool list');
    expect(out).toContain(PKG_NAME);
    expect(out).toContain('no .changeset/*.md');
  }, 60_000);

  it('C1(b) PASSES with a NOTE when the bundle diff is covered by a pending changeset', async () => {
    const root = makeBundleFixtureWorkspace(SCHEMA_AFTER);
    fs.mkdirSync(path.join(root, '.changeset'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.changeset', 'brave-pandas-bundle.md'),
      `---\n'${PKG_NAME}': minor\n---\n\nAdd memory_claim_upsert.\n`,
    );
    const tarball = buildTarball({ 'dist/schema.json': SCHEMA_BEFORE });
    const registry = await startFixtureRegistry({ name: PKG_NAME, tarball });

    const { code, out } = await run(root, ['--registry', registry]);

    expect(code).toBe(0);
    expect(out).toContain('pending changeset');
  }, 60_000);

  it('C1(b) PASSES when the bundle dist/schema.json is byte-identical to published', async () => {
    const root = makeBundleFixtureWorkspace(SCHEMA_AFTER);
    const tarball = buildTarball({ 'dist/schema.json': SCHEMA_AFTER });
    const registry = await startFixtureRegistry({ name: PKG_NAME, tarball });

    const { code, out } = await run(root, ['--registry', registry]);

    expect(code).toBe(0);
    expect(out).toContain('unchanged from published');
  }, 60_000);

  it('C1(b) NEGATIVE CONTROL — the pre-fix script MISSES the same bundle diff (proving the case above has teeth)', async () => {
    const root = makeBundleFixtureWorkspace(SCHEMA_AFTER);
    const tarball = buildTarball({ 'dist/schema.json': SCHEMA_BEFORE });
    const registry = await startFixtureRegistry({ name: PKG_NAME, tarball });

    // The REAL script catches it (the fix).
    const fixed = await run(root, ['--registry', registry]);
    expect(fixed.code).toBe(1);

    // The SAME fixture against the script with the C1(b) fallback removed — the
    // pre-fix behaviour — silently passes with "nothing to diff".
    const preFix = await run(root, ['--registry', registry], writePreFixVariantScript());
    expect(preFix.code).toBe(0);
    expect(preFix.out).toContain('nothing to diff');
  }, 60_000);
});
