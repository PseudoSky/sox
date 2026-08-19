/**
 * libs/install-engine/src/registry-recovery.bug-024.spec.ts — BUG-024 regression gate.
 *
 * `soxe upgrade --all` cannot repair a STALE extension installed into a consumer
 * OUTSIDE the sox-ecosystem repo: `install()` resolves the registry with
 * `loadRegistryIndex(root)` where `root` is the CONSUMER's project root. An
 * out-of-repo consumer has no `<consumerRoot>/registry/index.json`, so
 * resolution always yields zero members, `resolveFromRegistry` returns null,
 * `findLocalExtension(root, id)` also finds nothing (the extension doesn't
 * live under the consumer root either) — install() falls through to
 * `writeLockfileAtomic` with an empty `resolved` map, which correctly refuses
 * to write (that guard is NOT the bug) but leaves the consumer stuck stale
 * forever with a misleading "not found in registry/index.json" warning even
 * though the registry entry genuinely exists — just not reachable from the
 * consumer's root.
 *
 * THE FIX: when the root-relative registry index comes back empty, recover the
 * actual registry root from the EXISTING (stale) lockfile's own recorded
 * provenance — every LockfileEntry.source is an absolute file:// URL into the
 * repo/checkout that published it, so walking up from that path to the nearest
 * `registry/index.json` finds the SAME registry the extension was originally
 * installed from, with no rediscovery from the consumer's cwd required.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { install, loadLockfile, writeLockfileAtomic } from './install.js';
import type { Lockfile } from './install.js';
import { DATA_SUBDIR, scopeConfigPaths } from './data-paths.js';

function sha256(data: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(data).digest('hex');
}

interface Fixture {
  publishingRoot: string;
  consumerRoot: string;
  extDir: string;
  configPath: string;
  lockfilePath: string;
  oldChecksum: string;
  newChecksum: string;
  artifactPath: string;
}

/**
 * publishingRoot mimics the sox-ecosystem repo: a `registry/index.json` plus
 * the extension directory it indexes. consumerRoot mimics a project OUTSIDE
 * that repo (e.g. /Users/nix/dev/security/wop): it has its own scope config
 * and a pre-existing lockfile whose `tokenguard` entry is STALE (recorded
 * checksum no longer matches the artifact at publishingRoot — a new build
 * landed there since the consumer last installed).
 */
function makeFixture(id: string): Fixture {
  const publishingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bug024-repo-'));
  const consumerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bug024-consumer-'));

  const extDir = path.join(publishingRoot, 'extensions', 'services', id);
  fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
  const artifactPath = path.join(extDir, 'dist', 'index.js');

  // "old" build (what the consumer's stale lockfile currently records).
  const oldBody = `module.exports = { v: "${id}-old" };\n`;
  const oldChecksum = sha256(oldBody);

  // "new" build (what's actually on disk in the publishing repo now, and what
  // the registry currently advertises — simulating a rebuild since the
  // consumer last upgraded).
  const newBody = `module.exports = { v: "${id}-new" };\n`;
  fs.writeFileSync(artifactPath, newBody, 'utf8');
  const newChecksum = sha256(newBody);

  fs.writeFileSync(
    path.join(extDir, 'extension.json'),
    JSON.stringify(
      {
        id,
        type: 'service',
        title: `BUG-024 fixture ${id}`,
        description: 'BUG-024 regression fixture — out-of-repo consumer',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js',
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  const registryDir = path.join(publishingRoot, 'registry');
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, 'index.json'),
    JSON.stringify(
      [
        {
          id,
          type: 'service',
          title: `BUG-024 fixture ${id}`,
          description: 'BUG-024 regression fixture — out-of-repo consumer',
          source: `file://${extDir}`,
          checksum: newChecksum,
          compatibility: { host: '>=1.0.0 <2.0.0' },
        },
      ],
      null,
      2,
    ) + '\n',
    'utf8',
  );

  // Consumer root: deliberately has NO registry/ dir of its own, and is not
  // nested under publishingRoot — it is a wholly separate directory tree, like
  // /Users/nix/dev/security/wop relative to /Users/nix/dev/ai/sox-ecosystem.
  const dataDir = path.join(consumerRoot, DATA_SUBDIR);
  fs.mkdirSync(dataDir, { recursive: true });
  const configPath = scopeConfigPaths('project', consumerRoot).config;
  const lockfilePath = scopeConfigPaths('project', consumerRoot).lockfile;

  fs.writeFileSync(
    configPath,
    JSON.stringify({ install: [{ id }] }, null, 2) + '\n',
    'utf8',
  );

  // Pre-existing STALE lockfile: recorded source points at the artifact file
  // inside the publishing repo (the recovery path this fix exercises), and the
  // recorded checksum is the OLD one — exactly the "STALE ... re-installing"
  // condition from the bug report.
  const staleLock: Lockfile = {
    lockfileVersion: 2,
    resolved: {
      [id]: {
        source: `file://${artifactPath}`,
        checksum: oldChecksum,
        resolved_at: new Date(Date.now() - 86_400_000).toISOString(),
      },
    },
  };
  writeLockfileAtomic(lockfilePath, staleLock);

  return {
    publishingRoot,
    consumerRoot,
    extDir,
    configPath,
    lockfilePath,
    oldChecksum,
    newChecksum,
    artifactPath,
  };
}

describe('BUG-024: out-of-repo consumer upgrade recovers the registry from lockfile provenance', () => {
  const roots: string[] = [];
  let originalSoxHome: string | undefined;

  beforeEach(() => {
    roots.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    originalSoxHome = process.env['SOX_ECOSYSTEM_HOME'];
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bug024-home-'));
    roots.push(fakeHome);
    process.env['SOX_ECOSYSTEM_HOME'] = fakeHome;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalSoxHome === undefined) {
      delete process.env['SOX_ECOSYSTEM_HOME'];
    } else {
      process.env['SOX_ECOSYSTEM_HOME'] = originalSoxHome;
    }
    for (const r of roots) {
      try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('repairs a stale extension whose consumer root cannot see the registry directly', async () => {
    const id = 'bug024-tokenguard-fixture';
    const fx = makeFixture(id);
    roots.push(fx.publishingRoot, fx.consumerRoot);

    // Sanity precondition: the consumer root has no registry of its own, so a
    // naive loadRegistryIndex(consumerRoot) MUST come back empty. This is what
    // makes it "out of repo".
    expect(fs.existsSync(path.join(fx.consumerRoot, 'registry', 'index.json'))).toBe(false);

    // Sanity precondition: the pre-existing lockfile really is stale relative
    // to what's on disk in the publishing repo right now.
    const before = loadLockfile(fx.lockfilePath);
    expect(before!.resolved[id]!.checksum).toBe(fx.oldChecksum);
    expect(before!.resolved[id]!.checksum).not.toBe(fx.newChecksum);

    await install({ scope: 'project', mode: 'default', root: fx.consumerRoot });

    const after = loadLockfile(fx.lockfilePath);
    expect(after, 'lockfile must still exist after upgrade').not.toBeNull();
    expect(
      after!.resolved[id],
      'resolution must not come back empty — install() must not have refused to write',
    ).toBeDefined();
    expect(
      after!.resolved[id]!.checksum,
      'the extension must be repaired to the CURRENT registry checksum, not left stale',
    ).toBe(fx.newChecksum);
  });
});
