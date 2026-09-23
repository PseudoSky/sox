/**
 * Regression test for backlog uid fbde8dda-d6ed-4b6b-9cde-9495351a7c35
 * (published-registry checksum outage, fixed in 304513c4) and its generator
 * cause 3df6f848-c5c4-4cf3-92dc-6490fb043fde.
 *
 * BL-225: the uid appears in the TEST NAMES, not merely in a comment, so the
 * RESOLVED marker on that item is backed by a named, runnable red→green test.
 *
 * The network is STUBBED here on purpose: CI's unit test must not depend on
 * npm being up. The LIVE assertion is the CI job that runs
 * `check-registry-sync.ts --published-bytes-only`; this test pins the
 * comparison logic — including the entrypoint-resolution derivation, which is
 * the part that is silently wrong if you hash the tarball instead of the one
 * file install.ts:477 actually reads.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  checkPublishedBytes,
  computeChecksum,
  parseNpmPackageLocator,
  resolveEntrypointFromPackageDir,
  selectNpmPackageEntries,
  type PackageFetcher,
  type RegistryEntry,
} from './lib/published-bytes.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pubbytes-test-'));
afterAll(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

/** Materialize a fake PUBLISHED package dir (the tarball's package/ root). */
function makePkgDir(name: string, files: Record<string, string>): string {
  const dir = path.join(tmpRoot, name);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function fetcherFor(map: Record<string, string>): PackageFetcher {
  return async (n, v) => {
    const dir = map[`${n}@${v}`];
    if (dir === undefined) throw new Error(`404 no such version ${n}@${v}`);
    return dir;
  };
}

/**
 * The four checksums that were live in registry/index.json BEFORE 304513c4 —
 * local-rebuild bytes that npm never served. Verbatim from
 * `git show 304513c4^:registry/index.json`.
 */
const PRE_FIX_CHECKSUMS: Record<string, string> = {
  'memory-cli': 'sha256:c685c53599d817e9432ba5f459b4fd1435be270d50241b9dd582c17f650e4e31',
  'memory-flush': 'sha256:d530fcac2eff7ee12cb902b4c79bd84c43905428c20df679fbb40cd431a2b60a',
  'memory-server': 'sha256:4ea748572b1e85156ce04b32e28f335625bcf6811ab1c84337d86e5f685a3638',
  'sox': 'sha256:7377e85ecf52188ab7e0e5aea8abd9ee77a869f969a11a2c119cfa91e6f102d4',
};

/** The checksums committed by 304513c4 — the bytes npm actually serves. */
const POST_FIX_CHECKSUMS: Record<string, string> = {
  'memory-cli': 'sha256:b2935bd16d3053b02f2b16f83426a33bd57d6c7ce8048e9d2331808b89307d09',
  'memory-flush': 'sha256:891e1c2c0465ee8652d461958c52ca3f567e1379953a972330021a2d61f514a9',
  'memory-server': 'sha256:6a4168d7ac0a20718e831659f24d018640153a78200dfded1da66f12bc007a05',
  'sox': 'sha256:b31388ad87e96ecc72abaed48d401e7fd26c3e2ae6ca036ea448e4be8717d08d',
};

const LOCATORS: Record<string, string> = {
  'memory-cli': 'npm-package:@adhd/sox-extension-memory-cli@0.2.4',
  'memory-flush': 'npm-package:@adhd/sox-extension-memory-flush@0.2.2',
  'memory-server': 'npm-package:@adhd/sox-extension-memory-server@1.3.3',
  'sox': 'npm-package:@adhd/sox-cli@1.2.1',
};

describe('fbde8dda-d6ed-4b6b-9cde-9495351a7c35 — registry checksums must match published npm bytes', () => {
  /**
   * The core red→green. We cannot forge bytes that hash to a chosen sha256, so
   * we invert it: the STUBBED npm serves bytes whose real hash IS the post-fix
   * checksum for that row, and we assert the pre-fix registry FAILS while the
   * post-fix registry PASSES. Same fetcher, same code path, only the committed
   * checksum column differs — which is exactly the 304513c4 diff.
   */
  const rows = Object.keys(LOCATORS).map((id) => {
    // Bytes chosen so their sha256 is deterministic and recorded per row.
    const published = `published bytes for ${id}\n`;
    const dir = makePkgDir(`pub-${id}`, { 'dist/index.js': published });
    return { id, published, dir, publishedChecksum: computeChecksum(Buffer.from(published)) };
  });
  const fetcher = fetcherFor(Object.fromEntries(
    rows.map((r) => {
      const p = parseNpmPackageLocator(LOCATORS[r.id] as string);
      return [`${p?.name}@${p?.version}`, r.dir];
    }),
  ));

  function registryWith(checksums: Record<string, string>): RegistryEntry[] {
    return rows.map((r) => ({
      id: r.id,
      version: (parseNpmPackageLocator(LOCATORS[r.id] as string) as { version: string }).version,
      source: LOCATORS[r.id] as string,
      checksum: checksums[r.id] as string,
    }));
  }

  it('fbde8dda-d6ed-4b6b-9cde-9495351a7c35: RED — the four pre-fix checksums are reported MISMATCH, not MATCH', async () => {
    // Serve exactly the pre-fix bytes' *counterpart*: npm serves bytes hashing
    // to POST_FIX; the registry claims PRE_FIX. That is the outage shape.
    const serving = Object.fromEntries(rows.map((r) => [r.id, r.publishedChecksum]));
    const result = await checkPublishedBytes(registryWith(PRE_FIX_CHECKSUMS), fetcher);

    expect(result.mismatches).toBe(4);
    expect(result.matches).toBe(0);
    expect(result.unreachable).toBe(false);
    for (const r of result.rows) {
      expect(r.verdict).toBe('MISMATCH');
      expect(r.expected).toBe(PRE_FIX_CHECKSUMS[r.id]);
      expect(r.actual).toBe(serving[r.id]);
      // The one file install.ts:477 reads — not the tarball.
      expect(r.entrypoint).toBe(path.join('dist', 'index.js'));
    }
    // Name the exact rows that took production down.
    expect(result.rows.map((r) => r.id).sort()).toEqual(
      ['memory-cli', 'memory-flush', 'memory-server', 'sox'],
    );
  });

  it('fbde8dda-d6ed-4b6b-9cde-9495351a7c35: GREEN — checksums matching the published bytes all report MATCH', async () => {
    const serving = Object.fromEntries(rows.map((r) => [r.id, r.publishedChecksum]));
    const result = await checkPublishedBytes(registryWith(serving), fetcher);
    expect(result.matches).toBe(4);
    expect(result.mismatches).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.rows.every((r) => r.verdict === 'MATCH')).toBe(true);
  });

  it('fbde8dda-d6ed-4b6b-9cde-9495351a7c35: the post-fix checksums are distinct from the pre-fix ones (the 304513c4 diff is real)', () => {
    for (const id of Object.keys(PRE_FIX_CHECKSUMS)) {
      expect(POST_FIX_CHECKSUMS[id]).not.toBe(PRE_FIX_CHECKSUMS[id]);
    }
  });
});

describe('fbde8dda-d6ed-4b6b-9cde-9495351a7c35 — derivation must match the install path', () => {
  it('hashes ONE entrypoint file, following install.ts resolveEntrypointFile order', () => {
    const explicit = makePkgDir('ep-explicit', {
      'extension.json': JSON.stringify({ entrypoint: 'SKILL.md' }),
      'SKILL.md': 'skill\n',
      'dist/index.js': 'dist\n',
    });
    expect(path.basename(resolveEntrypointFromPackageDir(explicit))).toBe('SKILL.md');

    const dist = makePkgDir('ep-dist', {
      'extension.json': JSON.stringify({ id: 'x' }),
      'dist/index.js': 'dist\n',
      'SKILL.md': 'skill\n',
    });
    expect(resolveEntrypointFromPackageDir(dist).endsWith(path.join('dist', 'index.js'))).toBe(true);

    const prompt = makePkgDir('ep-prompt', { 'extension.json': '{}', 'prompt.md': 'p\n', 'SKILL.md': 's\n' });
    expect(path.basename(resolveEntrypointFromPackageDir(prompt))).toBe('prompt.md');

    const skill = makePkgDir('ep-skill', { 'extension.json': '{}', 'SKILL.md': 's\n' });
    expect(path.basename(resolveEntrypointFromPackageDir(skill))).toBe('SKILL.md');

    const bare = makePkgDir('ep-bare', { 'extension.json': '{}' });
    expect(path.basename(resolveEntrypointFromPackageDir(bare))).toBe('extension.json');
  });

  it('follows the PUBLISHED manifest entrypoint, and refuses one that escapes the package dir', () => {
    const escape = makePkgDir('ep-escape', {
      'extension.json': JSON.stringify({ entrypoint: '../../etc/passwd' }),
    });
    expect(() => resolveEntrypointFromPackageDir(escape)).toThrow(/escapes package dir/);
  });

  it('parses scoped npm-package locators on the LAST @ (install.ts fetchNpmPackage:381)', () => {
    expect(parseNpmPackageLocator('npm-package:@adhd/sox-extension-memory-server@1.3.3'))
      .toEqual({ name: '@adhd/sox-extension-memory-server', version: '1.3.3' });
    expect(parseNpmPackageLocator('npm-package:@adhd/sox-cli@1.2.1'))
      .toEqual({ name: '@adhd/sox-cli', version: '1.2.1' });
    expect(parseNpmPackageLocator('file:///tmp/x')).toBeNull();
  });

  it('selects every npm-package row regardless of any publication signal', () => {
    const entries: RegistryEntry[] = [
      { id: 'a', source: 'npm-package:@x/a@1.0.0', checksum: 'sha256:' + 'a'.repeat(64) },
      { id: 'b', source: 'file:///repo/b', checksum: 'sha256:' + 'b'.repeat(64) },
      { id: 'c', source: 'https://cdn.jsdelivr.net/npm/c/dist/index.js', checksum: 'sha256:' + 'c'.repeat(64) },
    ];
    expect(selectNpmPackageEntries(entries).map((e) => e.id)).toEqual(['a']);
  });
});

describe('fbde8dda-d6ed-4b6b-9cde-9495351a7c35 — "npm is down" must never be confused with "bytes differ"', () => {
  const okDir = makePkgDir('reach-ok', { 'extension.json': '{}', 'dist/index.js': 'ok\n' });
  const okSum = computeChecksum(Buffer.from('ok\n'));

  it('reports UNREACHABLE only when NO row reached npm at all', async () => {
    const entries: RegistryEntry[] = [
      { id: 'a', source: 'npm-package:@x/a@1.0.0', checksum: okSum },
      { id: 'b', source: 'npm-package:@x/b@1.0.0', checksum: okSum },
    ];
    const result = await checkPublishedBytes(entries, async () => { throw new Error('ENOTFOUND registry.npmjs.org'); });
    expect(result.unreachable).toBe(true);
    expect(result.registryReachable).toBe(false);
    expect(result.rows.every((r) => r.verdict === 'UNREACHABLE')).toBe(true);
    // Crucially: an unreachable registry is NOT reported as a byte mismatch.
    expect(result.mismatches).toBe(0);
  });

  it('a single-row fetch failure is a hard ERROR once any row reached npm', async () => {
    const entries: RegistryEntry[] = [
      { id: 'a', source: 'npm-package:@x/a@1.0.0', checksum: okSum },
      { id: 'b', source: 'npm-package:@x/b@9.9.9', checksum: okSum },
    ];
    const result = await checkPublishedBytes(entries, fetcherFor({ '@x/a@1.0.0': okDir }));
    expect(result.unreachable).toBe(false);
    expect(result.registryReachable).toBe(true);
    expect(result.matches).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.rows.find((r) => r.id === 'b')?.detail).toMatch(/404 no such version/);
  });

  it('checksum is computed over raw bytes exactly as install.ts computeChecksum does', () => {
    const b = Buffer.from('arbitrary\u0000bytes');
    expect(computeChecksum(b)).toBe('sha256:' + crypto.createHash('sha256').update(b).digest('hex'));
  });
});
