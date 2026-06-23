/**
 * libs/install-engine/src/integrity.scope.spec.ts
 *
 * ADR-0003 conformance gate — extension identity is content-addressed (id + checksum).
 *
 * This is the parameterized scope-parity suite mandated by ADR-0003
 * (§"All-scopes integrity rule"). It asserts the integrity rule byte-identically
 * across all four scopes [org, user, project, local]:
 *
 *   "For an installed extension `id` at scope `S`: it is CURRENT iff the sha256
 *    of the artifact at the resolved `source` equals the `checksum` recorded
 *    under key `id` in scope `S`'s lockfile. Any inequality ⇒ needs upgrade.
 *    There is no version comparison anywhere in this decision."
 *
 * Binding-enforcement invariants (each run per scope):
 *   A  — artifact change ⇒ needs upgrade (checksum changes; install re-pins).
 *   B1 — --frozen-lockfile verifies the CHECKSUM (not key presence) and FAILS on drift.
 *   B2 — one id maps to exactly one artifact (key is bare `id` — structural).
 *   B3 — cross-scope parity: same (id, artifact) ⇒ same checksum + same verdict;
 *        only the lockfile path differs.
 *   B4 — tamper gate: a checksum mismatch at fetch raises CHECKSUM MISMATCH,
 *        identically regardless of scope.
 *
 * BL-4 reality gate: the fixture's artifact bytes are written to disk and the
 * checksum verdict is computed against THAT on-disk artifact — never a stale one.
 * (The artifact under test is a synthetic fixture, so there is no nx-built dist to
 * go stale; the suite hashes exactly what install() hashes, the file at `source`.)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  install,
  loadLockfile,
  fetchArtifact,
  type Scope,
  type Lockfile,
} from './install.js';

const SCOPES: Scope[] = ['org', 'user', 'project', 'local'];

// ─── Fixture helpers ────────────────────────────────────────────────────────

interface Fixture {
  root: string;
  extDir: string;
  artifactPath: string;
}

/**
 * Build a synthetic workspace `root` containing:
 *   - extensions/skills/<id>/extension.json  (the manifest, no `version` needed for id)
 *   - extensions/skills/<id>/dist/index.js   (the built artifact = the content address)
 *   - registry/index.json                    (one entry, file:// source, real checksum)
 * The registry checksum is computed from the artifact bytes exactly as build-index does.
 */
function makeFixture(id: string, artifactBody: string): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adr3-scope-'));
  const extDir = path.join(root, 'extensions', 'skills', id);
  const distDir = path.join(extDir, 'dist');
  fs.mkdirSync(distDir, { recursive: true });

  const artifactPath = path.join(distDir, 'index.js');
  fs.writeFileSync(artifactPath, artifactBody, 'utf8');

  const manifest = {
    $schema: '../../../schemas/extension.schema.json',
    id,
    type: 'skill',
    title: `Fixture ${id}`,
    description: 'ADR-0003 scope-parity fixture',
    compatibility: { host: '>=1.0.0 <2.0.0' },
    license: 'MIT',
    entrypoint: 'dist/index.js',
  };
  fs.writeFileSync(
    path.join(extDir, 'extension.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );

  const checksum = sha256File(artifactPath);
  const indexEntry = {
    id,
    type: 'skill',
    title: manifest.title,
    description: manifest.description,
    source: `file://${extDir}`,
    checksum,
    compatibility: manifest.compatibility,
  };
  const registryDir = path.join(root, 'registry');
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, 'index.json'),
    JSON.stringify([indexEntry], null, 2) + '\n',
    'utf8',
  );

  return { root, extDir, artifactPath };
}

function sha256File(p: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** Per-scope sandbox config + lockfile paths (we never touch the real scope paths). */
function scopePaths(root: string, scope: Scope): { config: string; lockfile: string } {
  const dir = path.join(root, '.scopes', scope);
  fs.mkdirSync(dir, { recursive: true });
  return {
    config: path.join(dir, 'extensions.json'),
    lockfile: path.join(dir, 'extensions.lock'),
  };
}

function writeConfig(configPath: string, id: string): void {
  const cfg = { install: [{ id, enabled: true }] };
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

/** Look up a lockfile entry by id. Tolerates both the ADR-0003 bare-`id` key and
 *  the legacy v1 `id@version` key, so the suite is the SAME gate before and after
 *  the Phase-1 key-format flip. */
function lookupEntry(lock: Lockfile, id: string) {
  if (lock.resolved[id]) return lock.resolved[id];
  const legacyKey = Object.keys(lock.resolved).find((k) => k.startsWith(`${id}@`));
  return legacyKey ? lock.resolved[legacyKey] : undefined;
}

/** All lockfile keys that resolve to this id (bare or legacy). */
function keysForId(lock: Lockfile, id: string): string[] {
  return Object.keys(lock.resolved).filter((k) => k === id || k.startsWith(`${id}@`));
}

/** The integrity verdict, computed exactly as ADR-0003 mandates: hash the
 *  on-disk artifact at `source` and compare to the lockfile checksum. */
function isCurrent(lock: Lockfile, id: string): boolean {
  const entry = lookupEntry(lock, id);
  if (!entry) return false; // missing entry ⇒ not installed
  const filePath = entry.source.replace(/^file:\/\//, '');
  if (!fs.existsSync(filePath)) return false;
  return sha256File(filePath) === entry.checksum;
}

// ─── Test bodies (each runs once per scope) ─────────────────────────────────

describe('ADR-0003 scope-parity integrity rule', () => {
  let fixtures: Fixture[] = [];

  beforeEach(() => {
    fixtures = [];
    // Silence the install client's console chatter; keep failures visible via expect.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const f of fixtures) {
      try { fs.rmSync(f.root, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function track(f: Fixture): Fixture {
    fixtures.push(f);
    return f;
  }

  for (const scope of SCOPES) {
    describe(`scope=${scope}`, () => {
      it('A: a fresh install pins the artifact checksum under the bare id and reports CURRENT', async () => {
        const id = `fix-a-${scope}`;
        const fx = track(makeFixture(id, `module.exports = { v: "${id}-orig" };\n`));
        const sp = scopePaths(fx.root, scope);
        writeConfig(sp.config, id);

        await install({
          scope,
          mode: 'default',
          configPath: sp.config,
          lockfilePath: sp.lockfile,
          root: fx.root,
        });

        const lock = loadLockfile(sp.lockfile);
        expect(lock).not.toBeNull();
        // ADR-0003 Phase 1: lockfileVersion is 2 and the key is the BARE id.
        expect(lock!.lockfileVersion).toBe(2);
        expect(Object.keys(lock!.resolved)).toEqual([id]);
        expect(keysForId(lock!, id)).toHaveLength(1);
        expect(lookupEntry(lock!, id)!.checksum).toBe(sha256File(fx.artifactPath));
        expect(isCurrent(lock!, id)).toBe(true);
      });

      it('A: an artifact change makes the install STALE, and re-install re-pins the new checksum', async () => {
        const id = `fix-a2-${scope}`;
        const fx = track(makeFixture(id, `module.exports = { v: "${id}-orig" };\n`));
        const sp = scopePaths(fx.root, scope);
        writeConfig(sp.config, id);

        await install({ scope, mode: 'default', configPath: sp.config, lockfilePath: sp.lockfile, root: fx.root });
        const lock1 = loadLockfile(sp.lockfile)!;
        const checksum1 = lookupEntry(lock1, id)!.checksum;
        expect(isCurrent(lock1, id)).toBe(true);

        // Mutate the BUILT artifact on disk → identity changes (no version anywhere).
        fs.writeFileSync(fx.artifactPath, `module.exports = { v: "${id}-MUTATED" };\n`, 'utf8');
        // Against the OLD lockfile, the install is now STALE (artifact != recorded checksum).
        expect(isCurrent(lock1, id)).toBe(false);

        // Registry must reflect the new artifact (as registry:sync-index would do).
        rewriteRegistryChecksum(fx);

        // Re-install re-resolves and re-pins the NEW checksum.
        await install({ scope, mode: 'default', configPath: sp.config, lockfilePath: sp.lockfile, root: fx.root });
        const lock2 = loadLockfile(sp.lockfile)!;
        const checksum2 = lookupEntry(lock2, id)!.checksum;
        expect(checksum2).not.toBe(checksum1);
        expect(checksum2).toBe(sha256File(fx.artifactPath));
        expect(isCurrent(lock2, id)).toBe(true);
      });

      it('B1: --frozen-lockfile verifies the checksum and FAILS on a mutated artifact', async () => {
        const id = `fix-b1-${scope}`;
        const fx = track(makeFixture(id, `module.exports = { v: "${id}" };\n`));
        const sp = scopePaths(fx.root, scope);
        writeConfig(sp.config, id);

        // Generate the lockfile.
        await install({ scope, mode: 'default', configPath: sp.config, lockfilePath: sp.lockfile, root: fx.root });

        // Frozen install against the UNCHANGED artifact must succeed.
        await expect(
          install({ scope, mode: 'frozen', configPath: sp.config, lockfilePath: sp.lockfile, root: fx.root }),
        ).resolves.toBeDefined();

        // Mutate the artifact → checksum drift. Frozen install MUST FAIL (process.exit(1)).
        // (ADR-0003 B1: --frozen-lockfile is strengthened from presence-check to
        //  checksum-equality. Strengthened in Phase 1.)
        fs.writeFileSync(fx.artifactPath, `module.exports = { v: "${id}-DRIFT" };\n`, 'utf8');
        const exitErr = new Error('process.exit called');
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => { throw exitErr; }) as never);
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
          await expect(
            install({ scope, mode: 'frozen', configPath: sp.config, lockfilePath: sp.lockfile, root: fx.root }),
          ).rejects.toBe(exitErr);
          expect(exitSpy).toHaveBeenCalledWith(1);
          // The failure must name a checksum/drift reason, identically in every scope.
          const msg = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
          expect(msg).toMatch(/checksum|drift|mismatch/i);
        } finally {
          exitSpy.mockRestore();
          errSpy.mockRestore();
        }
      });

      it('B2: the lockfile key is the bare id — one id cannot carry two checksums', async () => {
        const id = `fix-b2-${scope}`;
        const fx = track(makeFixture(id, `module.exports = { v: "${id}" };\n`));
        const sp = scopePaths(fx.root, scope);
        writeConfig(sp.config, id);

        await install({ scope, mode: 'default', configPath: sp.config, lockfilePath: sp.lockfile, root: fx.root });
        // Re-install (no artifact change) must keep exactly one key for the id.
        await install({ scope, mode: 'default', configPath: sp.config, lockfilePath: sp.lockfile, root: fx.root });

        const lock = loadLockfile(sp.lockfile)!;
        // Exactly one key resolves to the id — one id ⇒ one artifact (structural).
        expect(keysForId(lock, id)).toHaveLength(1);
      });

      it('back-compat: a legacy v1 `id@version` lockfile is read by bare id and re-pinned to v2 on next install', async () => {
        const id = `fix-v1-${scope}`;
        const fx = track(makeFixture(id, `module.exports = { v: "${id}" };\n`));
        const sp = scopePaths(fx.root, scope);
        writeConfig(sp.config, id);

        // Hand-write a LEGACY v1 lockfile: key is `id@1.2.3`, lockfileVersion 1.
        const checksum = sha256File(fx.artifactPath);
        const legacy: Lockfile = {
          lockfileVersion: 1,
          resolved: {
            [`${id}@1.2.3`]: {
              source: `file://${fx.artifactPath}`,
              checksum,
              resolved_at: new Date().toISOString(),
            },
          },
        };
        fs.writeFileSync(sp.lockfile, JSON.stringify(legacy, null, 2) + '\n', 'utf8');

        // loadLockfile normalizes legacy keys to the bare id.
        const read = loadLockfile(sp.lockfile)!;
        expect(lookupEntry(read, id)).toBeDefined();
        expect(isCurrent(read, id)).toBe(true);

        // A frozen install resolves the legacy lockfile WITHOUT re-pinning (verifies checksum).
        await expect(
          install({ scope, mode: 'frozen', configPath: sp.config, lockfilePath: sp.lockfile, root: fx.root }),
        ).resolves.toBeDefined();

        // A normal install rewrites the on-disk lockfile to v2 with the bare-id key.
        await install({ scope, mode: 'default', configPath: sp.config, lockfilePath: sp.lockfile, root: fx.root });
        const migrated = JSON.parse(fs.readFileSync(sp.lockfile, 'utf8')) as Lockfile;
        expect(migrated.lockfileVersion).toBe(2);
        expect(Object.keys(migrated.resolved)).toEqual([id]);
      });

      it('B4: a tampered artifact raises CHECKSUM MISMATCH at fetch, identically per scope', async () => {
        const id = `fix-b4-${scope}`;
        const fx = track(makeFixture(id, `module.exports = { v: "${id}" };\n`));
        const goodChecksum = sha256File(fx.artifactPath);

        // Tamper the artifact AFTER recording the good checksum.
        fs.writeFileSync(fx.artifactPath, `module.exports = { v: "${id}-TAMPERED" };\n`, 'utf8');

        await expect(
          fetchArtifact(`file://${fx.extDir}`, goodChecksum),
        ).rejects.toThrow(/CHECKSUM MISMATCH/);
      });
    });
  }

  it('B3: cross-scope parity — same (id, artifact) yields identical checksum + verdict in all four scopes; only the lockfile path differs', async () => {
    const id = 'fix-b3-parity';
    const fx = track(makeFixture(id, `module.exports = { v: "${id}" };\n`));
    const artifactChecksum = sha256File(fx.artifactPath);

    const lockPaths: Record<Scope, string> = {} as Record<Scope, string>;
    const checksums: Record<Scope, string> = {} as Record<Scope, string>;
    const verdicts: Record<Scope, boolean> = {} as Record<Scope, boolean>;

    for (const scope of SCOPES) {
      const sp = scopePaths(fx.root, scope);
      writeConfig(sp.config, id);
      await install({ scope, mode: 'default', configPath: sp.config, lockfilePath: sp.lockfile, root: fx.root });
      const lock = loadLockfile(sp.lockfile)!;
      lockPaths[scope] = sp.lockfile;
      checksums[scope] = lookupEntry(lock, id)!.checksum;
      verdicts[scope] = isCurrent(lock, id);
    }

    // Identical checksum across every scope (= the artifact's content address).
    for (const scope of SCOPES) {
      expect(checksums[scope]).toBe(artifactChecksum);
      expect(verdicts[scope]).toBe(true);
    }

    // The only difference is the lockfile PATH — all four are distinct.
    const distinctPaths = new Set(Object.values(lockPaths));
    expect(distinctPaths.size).toBe(SCOPES.length);
  });
});

/** Recompute the registry checksum from the (mutated) artifact, mirroring
 *  `registry:sync-index` so a re-install resolves the new content address. */
function rewriteRegistryChecksum(fx: Fixture): void {
  const indexPath = path.join(fx.root, 'registry', 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as Array<Record<string, unknown>>;
  for (const entry of index) {
    entry['checksum'] = sha256File(fx.artifactPath);
  }
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf8');
}
