/**
 * build-index-pin-guard.4d1a3bf9.test.ts — regression test for backlog
 * 4d1a3bf9-2ffd-4a3d-b017-85ec0146759d ("a default-mode build-index run
 * silently clobbers a committed npm-package: pin with a checkout-bound
 * file:// source").
 *
 * DEFECT
 * ------
 * `resolveSource` (scripts/build-index.ts ~287-318) only ever emits an
 * `npm-package:` locator when `SOX_REGISTRY_PUBLISH` is set; every other run
 * resolves to `file://${extDir}`. The published-bytes pin-preservation block
 * added for backlog 3df6f848 (`loadCommittedPins`, ~426-477; the
 * `source.startsWith('npm-package:')` branch, ~571-591) only fires when the
 * NEWLY resolved source is ITSELF `npm-package:` — it guards a CHANGED
 * locator, never a locator that stopped being npm-package entirely. So the
 * default (no `SOX_REGISTRY_PUBLISH`) mode of `build-index` — the mode every
 * `npx tsx scripts/build-index.ts` / `npx nx run registry:sync-index`
 * invocation runs in outside a release — silently rewrites every committed
 * `npm-package:` row to a checkout-bound `file://` row with a locally
 * computed checksum, discarding the pin with no warning and no non-zero
 * exit.
 *
 * FIX UNDER TEST
 * --------------
 * Outside a release (`SOX_REGISTRY_PUBLISH` unset), if the committed registry
 * (the same source `loadCommittedPins` reads, i.e. `git show HEAD:...`)
 * contains any `npm-package:` row that this run would rewrite to a
 * non-npm-package source, `buildIndex` refuses: throws `PinLossError`
 * (surfaced by the CLI as a non-zero exit and nothing written), and the
 * committed `registry/index.json` is untouched. Under `SOX_REGISTRY_PUBLISH`
 * the guard never fires — behavior there is unchanged (see
 * build-index-published-pin.test.ts). A registry with no npm-package rows is
 * unaffected either way.
 *
 * WHY A SUBPROCESS AND A SENTINEL
 * -------------------------------
 * Same rationale as build-index-published-pin.test.ts: never `import {
 * buildIndex }` in a suite that runs inside the live checkout — spawn against
 * a `mkdtemp` fixture root instead. The fixture's committed checksum is a
 * SENTINEL (64 × 'a') no real hash can produce, so "preserved"/"refused"
 * cannot be faked by a lucky local-hash collision.
 */

import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-index.ts');
const TSX_CLI = require.resolve('tsx/cli');

const PUBLISHED_SENTINEL = 'sha256:' + 'a'.repeat(64);
const FIXTURE_ID = 'pinguard-fixture-server';
const FIXTURE_PKG = `@adhd/sox-extension-${FIXTURE_ID}`;

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

function extDirOf(root: string): string {
  return path.join(root, 'extensions', 'mcp-servers', FIXTURE_ID);
}

/**
 * A scratch repo carrying exactly one committed, published extension: a
 * `registry/index.json` row pinned `npm-package:` at `version` with the
 * PUBLISHED-bytes sentinel checksum, and local `dist/index.js` bytes that do
 * NOT hash to that checksum — the shape every checkout has the moment after
 * a release, before the next default-mode `build-index` run.
 */
function scratchRepo(version: string, distBody: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pinguard-')));
  tempDirs.push(root);
  git(['init', '-q'], root);
  git(['config', 'user.email', 'test@test.com'], root);
  git(['config', 'user.name', 'test'], root);

  // dist/ is gitignored in the real repo (.gitignore:4) — mirror that so a
  // rebuilt artifact never dirties the tree (which would trip the unrelated
  // BL-390 gate before this guard is ever reached).
  fs.writeFileSync(path.join(root, '.gitignore'), 'dist/\n');

  const extDir = extDirOf(root);
  fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(extDir, 'extension.json'),
    JSON.stringify(
      {
        id: FIXTURE_ID,
        type: 'mcp-server',
        title: 'pin guard fixture',
        description: 'pin guard fixture description',
        entrypoint: 'dist/index.js',
        compatibility: { host: '>=1.0.0 <2.0.0' },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(extDir, 'package.json'),
    JSON.stringify({ name: FIXTURE_PKG, version, private: false }, null, 2),
  );
  fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), distBody);

  fs.mkdirSync(path.join(root, 'registry'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'registry', 'index.json'),
    JSON.stringify(
      [
        {
          id: FIXTURE_ID,
          type: 'mcp-server',
          version,
          title: 'pin guard fixture',
          description: 'pin guard fixture description',
          source: `npm-package:${FIXTURE_PKG}@${version}`,
          checksum: PUBLISHED_SENTINEL,
          compatibility: { host: '>=1.0.0 <2.0.0' },
        },
      ],
      null,
      2,
    ) + '\n',
  );

  git(['add', '.'], root);
  git(['commit', '-q', '-m', 'chore: seed published state'], root);
  return root;
}

async function runBuildIndex(
  root: string,
  env: Record<string, string>,
): Promise<{ code: number; out: string }> {
  const child = spawn(process.execPath, [TSX_CLI, SCRIPT, root], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
  });
  let out = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (out += d.toString()));
  const code = await new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? -1)));
  return { code, out };
}

describe('[4d1a3bf9] build-index refuses to overwrite a published npm-package: pin outside a release', () => {
  it('default mode (no SOX_REGISTRY_PUBLISH): refuses and leaves registry/index.json byte-identical', async () => {
    const root = scratchRepo('2.0.0', 'module.exports = "REBUILT LOCALLY AFTER PUBLISH";\n');
    const registryPath = path.join(root, 'registry', 'index.json');
    const before = fs.readFileSync(registryPath, 'utf8');

    // No SOX_REGISTRY_PUBLISH — the empty string mirrors an unset env var in
    // the spawned child (deleting the key from the object is unreliable
    // across platforms; build-index only checks truthiness).
    const { code, out } = await runBuildIndex(root, { SOX_REGISTRY_PUBLISH: '' });

    expect(code, out).not.toBe(0);
    expect(out).toMatch(/4d1a3bf9/);
    expect(out).toMatch(new RegExp(FIXTURE_ID));
    expect(out).toMatch(/npm-package:/);
    expect(out).toMatch(/repin-registry-entry\.mjs/);
    expect(out).toMatch(/PUBLISHING\.md/);
    expect(
      fs.readFileSync(registryPath, 'utf8'),
      'a refused run must write nothing — the committed file must be byte-identical',
    ).toBe(before);
  }, 60_000);

  it('SOX_REGISTRY_PUBLISH mode: the guard never fires, and the pin is preserved as before', async () => {
    const root = scratchRepo('2.0.0', 'module.exports = "REBUILT LOCALLY AFTER PUBLISH";\n');

    const { code, out } = await runBuildIndex(root, { SOX_REGISTRY_PUBLISH: 'npm' });

    expect(code, out).toBe(0);
    expect(out).not.toMatch(/4d1a3bf9/);
    const entries = JSON.parse(
      fs.readFileSync(path.join(root, 'registry', 'index.json'), 'utf8'),
    ) as Array<{ id: string; source: string; checksum: string }>;
    const row = entries.find((e) => e.id === FIXTURE_ID);
    expect(row, `fixture row "${FIXTURE_ID}" must be present`).toBeDefined();
    expect(row!.source).toBe(`npm-package:${FIXTURE_PKG}@2.0.0`);
    expect(row!.checksum, 'the published pin must survive').toBe(PUBLISHED_SENTINEL);
  }, 60_000);

  it('a registry with no npm-package rows is unaffected by the guard in default mode', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pinguard-nopin-')));
    tempDirs.push(root);
    git(['init', '-q'], root);
    git(['config', 'user.email', 'test@test.com'], root);
    git(['config', 'user.name', 'test'], root);
    fs.writeFileSync(path.join(root, '.gitignore'), 'dist/\n');

    const extDir = extDirOf(root);
    fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify(
        {
          id: FIXTURE_ID,
          type: 'mcp-server',
          title: 'pin guard fixture',
          description: 'pin guard fixture description',
          entrypoint: 'dist/index.js',
          compatibility: { host: '>=1.0.0 <2.0.0' },
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: FIXTURE_PKG, version: '1.0.0', private: false }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), 'module.exports = "LOCAL";\n');

    // A committed registry that already has a row for this id — but a
    // file:// one, not npm-package:. This is "a registry with no npm-package
    // rows", not "no committed registry at all" (which would trivially skip
    // loadCommittedPins for an unrelated reason).
    fs.mkdirSync(path.join(root, 'registry'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'registry', 'index.json'),
      JSON.stringify(
        [
          {
            id: FIXTURE_ID,
            type: 'mcp-server',
            version: '1.0.0',
            title: 'pin guard fixture',
            description: 'pin guard fixture description',
            source: `file://${extDir}`,
            checksum: 'sha256:' + 'b'.repeat(64),
            compatibility: { host: '>=1.0.0 <2.0.0' },
          },
        ],
        null,
        2,
      ) + '\n',
    );

    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'chore: seed unpublished state'], root);

    const { code, out } = await runBuildIndex(root, { SOX_REGISTRY_PUBLISH: '' });
    expect(code, out).toBe(0);
    expect(out).toMatch(/wrote \d+ entries/);
    const entries = JSON.parse(
      fs.readFileSync(path.join(root, 'registry', 'index.json'), 'utf8'),
    ) as Array<{ id: string; source: string }>;
    const row = entries.find((e) => e.id === FIXTURE_ID);
    expect(row!.source).toBe(`file://${extDir}`);
  }, 60_000);
});
