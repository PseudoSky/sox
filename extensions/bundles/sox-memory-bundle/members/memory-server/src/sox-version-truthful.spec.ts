/**
 * sox-version-truthful.spec.ts — `memory_ping`'s `sox_version` reports the
 * RUNNING BUNDLE's version, never the store's `_sox_engine` marker.
 *
 * Defect: after a deploy, `memory_ping` gave the operator no truthful semver.
 * The only version-shaped field was `store.store_engine.sox_version`, read from
 * the `_sox_engine` marker row, which is (a) stamped ONCE by the first opener
 * and never re-stamped, and (b) read lazily (BL-580 / DEBT-003 lazy-connect) —
 * so on a freshly restarted process it is `null`, and even once populated it
 * reports the FIRST opener's version, not the current bundle. The `artifact`
 * field (sha256 content identity) was always correct and changed on deploy; only
 * the semver was misleading.
 *
 * Fix: the ping now carries a top-level `sox_version` derived from the bundle's
 * OWN package.json (the manifest sibling of the entrypoint artifact) — a
 * different question ("which bundle release is running?") than the marker's
 * ("which engine first opened this store, and with which version?"). The marker
 * is intentionally NOT re-stamped on every open, and `store.store_engine` keeps
 * its provenance meaning.
 *
 * These tests pin:
 *   1. Truthfulness in the freshly-restarted shape — a bare ping (no store
 *      opened) reports a non-null semver that equals the bundle's own manifest
 *      version, not null and not the store marker's value.
 *   2. Wiring consistency — the ping reports exactly `getBundleSemver()`, and
 *      the memoized getter resolves from THIS module's location.
 *   3. Change-with-the-bundle — the resolver follows the manifest it is pointed
 *      at (a fixture with a DIFFERENT declared version, laid out like the live
 *      install: a versionless `dist/package.json` between the entry and the real
 *      manifest), proving the source is the bundle manifest, never a store stamp.
 *   4. Store-state independence — with a store actually open (and its marker
 *      stamped), `sox_version` still reports the bundle version.
 *
 * Red→green (BL-225): with `sox_version: getBundleSemver()` removed from the
 * ping response, tests 1/2/4 fail (`sox_version` undefined) and test 3 fails on
 * the missing export; with the fix restored, all pass.
 */

import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { getBundleSemver, handleToolCall, resolveBundleSemver } from './index.js';

// node:fs via CommonJS createRequire — the mutable module object every ESM
// `import * as fs` reads live off of (same technique as bl412).
const require = createRequire(__filename);
const fs = require('node:fs') as typeof import('node:fs');

// ── The bundle's own manifest — the source of truth the ping must report ──────
// Walk up from THIS spec file until the extension's own package.json is found
// (name-matched so a monorepo-root or runner manifest can never be mistaken for
// it). The spec lives in the same `src/` tree as the module under test, so this
// is the exact manifest `getBundleSemver()` resolves to under vitest — and the
// exact manifest `dist/index.js` walks up to in the deployed bundle.
const EXTENSION_PACKAGE_NAME = '@adhd/sox-extension-memory-server';

function findBundleManifestVersion(): string {
  let dir = path.dirname(__filename);
  for (let depth = 0; depth < 6 && dir !== path.dirname(dir); depth++, dir = path.dirname(dir)) {
    try {
      const pkgPath = path.join(dir, 'package.json');
      if (!fs.existsSync(pkgPath)) continue;
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string; version?: string };
      if (pkg.name === EXTENSION_PACKAGE_NAME && typeof pkg.version === 'string' && pkg.version.length > 0) {
        return pkg.version;
      }
    } catch {
      /* keep walking */
    }
  }
  throw new Error(`could not locate ${EXTENSION_PACKAGE_NAME} package.json above ${__filename}`);
}

const BUNDLE_VERSION = findBundleManifestVersion();

const TEST_DIR = path.join(os.tmpdir(), `sox-version-truthful-${process.pid}`);
const OPEN_DB = path.join(TEST_DIR, 'open.db');

afterAll(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(OPEN_DB + suffix, { force: true });
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('memory_ping — sox_version reports the RUNNING bundle version', () => {
  const savedConfig = process.env['SOX_CONFIG_DB_PATH'];

  afterEach(() => {
    if (savedConfig === undefined) delete process.env['SOX_CONFIG_DB_PATH'];
    else process.env['SOX_CONFIG_DB_PATH'] = savedConfig;
  });

  it('reports a non-null semver even when no store is open (the freshly-restarted shape)', async () => {
    // Bare ping with no host-injected SOX_CONFIG_DB_PATH (BL-412): the store is
    // NOT opened, `store.configured === false`, and `store.store_engine` is
    // absent — exactly the shape that previously left the operator with no
    // truthful version after a deploy/restart.
    delete process.env['SOX_CONFIG_DB_PATH'];

    const res = await handleToolCall('memory_ping', {});
    expect(res.isError).not.toBe(true);
    const parsed = JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;

    // The defect shape: store not open → marker never read → store_engine absent.
    expect(parsed['store']).toMatchObject({ configured: false });
    expect((parsed['store'] as Record<string, unknown>)?.['store_engine']).toBeUndefined();

    // The fix: a truthful semver, present and correct WITHOUT any store open.
    expect(typeof parsed['sox_version']).toBe('string');
    expect(parsed['sox_version']).toMatch(/^\d+\.\d+\.\d+/);
    expect(parsed['sox_version']).toBe(BUNDLE_VERSION);
    // It is the bundle's OWN version — never null, never the fallback constant.
    expect(parsed['sox_version']).not.toBeNull();
    expect(parsed['sox_version']).not.toBe('0.0.0');
  });

  it('the ping reports exactly getBundleSemver(), which resolves from this module\'s own manifest', async () => {
    const res = await handleToolCall('memory_ping', {});
    expect(res.isError).not.toBe(true);
    const parsed = JSON.parse((res.content[0] as { text: string }).text) as { sox_version?: string };

    expect(parsed['sox_version']).toBe(getBundleSemver());
    // Under vitest, __filename is the module's real source path (vitest injects
    // it from import.meta.url), so the memoized getter must agree with a walk
    // from here — and must equal the extension's declared version.
    expect(getBundleSemver()).toBe(resolveBundleSemver(path.dirname(__filename)));
    expect(getBundleSemver()).toBe(BUNDLE_VERSION);
  });

  it('resolveBundleSemver follows the manifest it is pointed at (version changes when the bundle changes)', () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-version-fixture-'));
    try {
      // Replicates the LIVE install layout: a versionless manifest
      // ({"type":"commonjs"} — the actual dist/package.json shape) sits between
      // the entry and the real manifest one level up.
      const distDir = path.join(fixtureDir, 'dist');
      const entryDir = path.join(distDir, 'nested');
      for (const dir of [distDir, entryDir]) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(path.join(distDir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
      fs.writeFileSync(
        path.join(fixtureDir, 'package.json'),
        JSON.stringify({ name: EXTENSION_PACKAGE_NAME, version: '9.9.9-test' }),
      );

      // The entry's own dir has no manifest; the versionless dist manifest is
      // skipped; the declared version of the bundle's manifest is what wins.
      expect(resolveBundleSemver(entryDir)).toBe('9.9.9-test');
      expect(resolveBundleSemver(distDir)).toBe('9.9.9-test');

      // A DIFFERENT declared version ⇒ a different reported version: the value
      // follows the bundle's manifest, never a store-stamped first-opener value.
      fs.writeFileSync(
        path.join(fixtureDir, 'package.json'),
        JSON.stringify({ name: EXTENSION_PACKAGE_NAME, version: '10.0.0-test' }),
      );
      expect(resolveBundleSemver(entryDir)).toBe('10.0.0-test');
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('with a store actually open, sox_version still reports the bundle version (store-state independent)', async () => {
    const res = await handleToolCall('memory_ping', { db_path: OPEN_DB });
    expect(res.isError).not.toBe(true);
    const parsed = JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;

    // The store opened — its marker may now be stamped (store.store_engine is
    // provenance data), but the ping's semver is NOT taken from it.
    expect(parsed['sox_version']).toBe(BUNDLE_VERSION);
    expect(parsed['sox_version']).toBe(getBundleSemver());
  });
});
