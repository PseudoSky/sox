/**
 * build-index-published-pin.test.ts — regression test for backlog
 * 3df6f848-c5c4-4cf3-92dc-6490fb043fde ("the generator regenerates published
 * checksums from local bytes") and 812e6cfd-071b-4ea8-b61c-1118ebaf216c
 * ("a release was published from a dirty tree").
 *
 * DEFECT
 * ------
 * `resolveChecksum` (scripts/build-index.ts) hashes LOCAL `dist/index.js`. For a
 * row whose `source` is `npm-package:<name>@<version>`, the install path
 * (`install.ts fetchArtifact`) npm-installs THAT version and hashes the
 * entrypoint inside the PUBLISHED tarball. Local and published agree only while
 * nobody has rebuilt since publishing — and `dist/` is rewritten by every build.
 * Commit 304513c4 hand-repaired four such rows after every fresh install started
 * failing closed with CHECKSUM MISMATCH; its own commit message warned "the next
 * `registry:sync-index` run will regenerate these four from local bytes and
 * re-break them." The documented release command (`pnpm release:prepared`) runs
 * that generator as one of its first actions, so following PUBLISHING.md verbatim
 * re-shipped the outage at a higher version.
 *
 * FIX UNDER TEST
 * --------------
 * An UNCHANGED `npm-package:` locator keeps its committed checksum. A CHANGED
 * locator (i.e. `changeset version` bumped the package, so this run publishes the
 * local bytes) re-derives from disk. Plus: `--allow-dirty` is refused outright
 * under the publication signal, so a release can never opt out of BL-390's
 * dirty-tree gate the way `@adhd/sox-cli@1.2.1` effectively did.
 *
 * WHY A SUBPROCESS AND A SENTINEL
 * -------------------------------
 * - Never `import { buildIndex }` here: the module is the repo's registry
 *   generator and this suite runs inside the live checkout. It is spawned
 *   against a `mkdtemp` fixture root instead (prior art:
 *   `build-index-cli-root.bl480.test.ts`), so the real `registry/index.json` is
 *   never touched.
 * - The fixture's committed checksum is a SENTINEL (64 × 'a') that no hash of any
 *   real bytes can produce. "Preserved" therefore cannot be faked by a lucky
 *   local-hash collision, and "clobbered" is unambiguous.
 * - The fixture repo is fully committed before each run: otherwise BL-390's
 *   DirtyTreeError fires and the arm would go red without testing preservation
 *   at all.
 */

import { execFileSync, spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
const CURRENT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-index.ts');
const TSX_CLI = require.resolve('tsx/cli');

/**
 * The last commit BEFORE pin preservation landed. The RED arm materializes this
 * exact pre-fix generator and proves it clobbers the sentinel — without it, a
 * test that only asserts the GREEN behaviour cannot distinguish "the fix works"
 * from "the fixture never exercised the defect".
 */
const PRE_FIX_REV = '6d955c24';

const PUBLISHED_SENTINEL = 'sha256:' + 'a'.repeat(64);
const FIXTURE_ID = 'pinfix-fixture-server';
const FIXTURE_PKG = `@adhd/sox-extension-${FIXTURE_ID}`;

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

function sha256File(p: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function extDirOf(root: string): string {
  return path.join(root, 'extensions', 'mcp-servers', FIXTURE_ID);
}

/**
 * A scratch repo shaped like the real one at the moment of the outage:
 *   - one published, non-private extension with a built `dist/index.js`
 *   - a committed `registry/index.json` whose row carries the PUBLISHED-bytes
 *     checksum (the sentinel) and an `npm-package:` locator at `version`
 *   - local `dist/index.js` bytes that do NOT hash to that checksum, exactly as
 *     a post-publish rebuild leaves them
 */
function scratchRepo(version: string, distBody: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pinfix-')));
  tempDirs.push(root);
  git(['init', '-q'], root);
  git(['config', 'user.email', 'test@test.com'], root);
  git(['config', 'user.name', 'test'], root);

  const extDir = extDirOf(root);
  fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(extDir, 'extension.json'),
    JSON.stringify(
      {
        id: FIXTURE_ID,
        type: 'mcp-server',
        title: 'pin fixture',
        description: 'pin fixture description',
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
          title: 'pin fixture',
          description: 'pin fixture description',
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

/** Materialize the pre-fix generator next to the current one so its relative imports resolve. */
function materializePreFixScript(): string {
  const dest = path.join(REPO_ROOT, 'scripts', `.build-index.prefix.${process.pid}.ts`);
  fs.writeFileSync(dest, git(['show', `${PRE_FIX_REV}:scripts/build-index.ts`], REPO_ROOT));
  tempDirs.push(dest); // rmSync(recursive) removes a plain file too
  return dest;
}

async function runBuildIndex(
  scriptPath: string,
  root: string,
  args: string[] = [],
  env: Record<string, string> = { SOX_REGISTRY_PUBLISH: 'npm' },
): Promise<{ code: number; out: string }> {
  const child = spawn(process.execPath, [TSX_CLI, scriptPath, root, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
  });
  let out = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (out += d.toString()));
  const code = await new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? -1)));
  return { code, out };
}

function readRow(root: string): { source: string; checksum: string } {
  const entries = JSON.parse(
    fs.readFileSync(path.join(root, 'registry', 'index.json'), 'utf8'),
  ) as Array<{ id: string; source: string; checksum: string }>;
  const row = entries.find((e) => e.id === FIXTURE_ID);
  expect(row, `fixture row "${FIXTURE_ID}" must be present`).toBeDefined();
  return row!;
}

describe('[3df6f848] build-index must not clobber a published-bytes checksum pin', () => {
  it('GREEN: an UNCHANGED npm-package: locator keeps its committed (published-bytes) checksum', async () => {
    const root = scratchRepo('1.3.3', 'module.exports = "REBUILT LOCALLY AFTER PUBLISH";\n');
    const localHash = sha256File(path.join(extDirOf(root), 'dist', 'index.js'));
    expect(localHash).not.toBe(PUBLISHED_SENTINEL); // the fixture must actually diverge

    const { code, out } = await runBuildIndex(CURRENT_SCRIPT, root);
    expect(code, out).toBe(0);

    const row = readRow(root);
    expect(row.source).toBe(`npm-package:${FIXTURE_PKG}@1.3.3`);
    expect(row.checksum, 'the published pin must survive regeneration').toBe(PUBLISHED_SENTINEL);
    expect(row.checksum).not.toBe(localHash);
    expect(out).toMatch(/preserving published-bytes checksum/);
  }, 60_000);

  it('RED (pre-fix generator at 6d955c24): the same run re-pins the row to LOCAL disk bytes', async () => {
    const root = scratchRepo('1.3.3', 'module.exports = "REBUILT LOCALLY AFTER PUBLISH";\n');
    const localHash = sha256File(path.join(extDirOf(root), 'dist', 'index.js'));
    const preFix = materializePreFixScript();

    const { code, out } = await runBuildIndex(preFix, root);
    expect(code, out).toBe(0);

    const row = readRow(root);
    // This is the outage, reproduced: locator still points at the published
    // 1.3.3 that npm keeps serving, while the checksum has moved to bytes that
    // exist only on this disk. Every fresh install then fails CHECKSUM MISMATCH.
    expect(row.source).toBe(`npm-package:${FIXTURE_PKG}@1.3.3`);
    expect(row.checksum).toBe(localHash);
    expect(row.checksum).not.toBe(PUBLISHED_SENTINEL);
  }, 60_000);

  it('a CHANGED locator (version bump) still re-derives from local bytes — preservation must not freeze a real publish', async () => {
    const root = scratchRepo('1.3.3', 'module.exports = "OLD";\n');

    // What `changeset version` does: bump the package, commit. The locator the
    // generator now emits (1.3.4) differs from the committed pin's (1.3.3), so
    // the pin cannot apply — these local bytes are what this release publishes.
    const extDir = extDirOf(root);
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: FIXTURE_PKG, version: '1.3.4', private: false }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), 'module.exports = "NEW RELEASE";\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'chore: version packages'], root);
    const newHash = sha256File(path.join(extDir, 'dist', 'index.js'));

    const { code, out } = await runBuildIndex(CURRENT_SCRIPT, root);
    expect(code, out).toBe(0);

    const row = readRow(root);
    expect(row.source).toBe(`npm-package:${FIXTURE_PKG}@1.3.4`);
    expect(row.checksum, 'a bumped locator must adopt the bytes being published').toBe(newHash);
    expect(out).toMatch(/locator changed/);
  }, 60_000);
});

describe('[812e6cfd] the publication signal and the provisional escape hatch are mutually exclusive', () => {
  it('refuses --allow-dirty under SOX_REGISTRY_PUBLISH, leaving the committed index untouched', async () => {
    const root = scratchRepo('1.3.3', 'module.exports = "PUBLISHED";\n');
    const before = fs.readFileSync(path.join(root, 'registry', 'index.json'), 'utf8');

    // Uncommitted edit to a checksum-relevant path — the "+dirty" state that
    // @adhd/sox-cli@1.2.1 was published from.
    fs.writeFileSync(path.join(extDirOf(root), 'dist', 'index.js'), 'module.exports = "WIP";\n');

    const { code, out } = await runBuildIndex(CURRENT_SCRIPT, root, ['--allow-dirty']);
    expect(code, out).toBe(1);
    expect(out).toMatch(/REFUSING --allow-dirty under the publication signal/);
    expect(
      fs.readFileSync(path.join(root, 'registry', 'index.json'), 'utf8'),
      'a refused run must write nothing',
    ).toBe(before);
  }, 60_000);

  it('still allows --allow-dirty for a NON-publish (local inspection) run', async () => {
    const root = scratchRepo('1.3.3', 'module.exports = "PUBLISHED";\n');
    fs.writeFileSync(path.join(extDirOf(root), 'dist', 'index.js'), 'module.exports = "WIP";\n');

    const { code, out } = await runBuildIndex(CURRENT_SCRIPT, root, ['--allow-dirty'], { SOX_REGISTRY_PUBLISH: '' });
    expect(code, out).toBe(0);
    expect(out).toMatch(/wrote \d+ entries/);
  }, 60_000);
});
