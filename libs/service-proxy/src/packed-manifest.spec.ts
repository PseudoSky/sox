/**
 * packed-manifest.spec.ts — 8468f7b1 SP35 / SP28: the PACKED manifest (what `pnpm pack`
 * publishes) carries no `workspace:` specifier, and the built package still exports every
 * 0.5.0 runtime name (no removals). Requires `dist/` (the test target dependsOn build).
 *
 * `dist/package.json` is a verbatim copy of the source manifest made by the shared
 * atomic-tsc executor, so it keeps `workspace:^` literally; it is NOT what is published
 * (the tarball is cut from the package root, where pnpm rewrites the protocol), and this
 * spec asserts exactly that.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const PKG_ROOT = path.resolve(__dirname, '..');

/** A home-directory or absolute filesystem path embedded in a JSON string value. */
const MACHINE_LOCAL_PATH = /"(?:\/Users\/|\/home\/|~\/|[A-Za-z]:\\)/;

/** Every runtime export of the published 0.5.0 package (54871159 index.ts). */
const SURFACE_0_5_0 = [
  'ERR_BACKEND_UNAVAILABLE', 'FrameDecoder', 'HEADER_BYTES', 'MAX_FRAME_BYTES', 'assertPrivateSocketDir',
  'backendSocketPath', 'canonicalize', 'computeSchemaHash', 'dialBackend', 'encodeFrame', 'ensureBackend',
  'ensurePrivateSocketDir', 'errorResponse', 'handshakeBackend', 'isJsonRpcRequest', 'isJsonRpcResponse',
  'isNotification', 'isUdsDirUnsafeError', 'probeSocketLive', 'runFrontShim', 'serveBackend',
  'tightenOwnedSocketDir', 'udsFallbackRoot',
];

describe('8468f7b1 SP35 SP28 packed manifest and built surface', () => {
  const hasDist = fs.existsSync(path.join(PKG_ROOT, 'dist', 'index.js'));

  // The dist-dependent tests below skip locally when dist is absent (a bare `vitest run`), but the
  // `test` target dependsOn `build`, so under CI a missing dist is a broken pipeline, not a skip.
  it('SP35 dist is present when CI is set (the test target dependsOn build)', () => {
    if (process.env.CI) expect(hasDist, 'dist/index.js missing: run `nx run service-proxy:build` first').toBe(true);
  });

  it('SP26 the source manifest carries no machine-local absolute path (it ships in the tarball)', () => {
    const text = fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8');
    expect(text).not.toMatch(MACHINE_LOCAL_PATH);
    const manifest = JSON.parse(text) as { sox?: { externalConsumers?: Array<{ repo?: string }> } };
    expect(manifest.sox?.externalConsumers?.length).toBeGreaterThan(0);
    for (const c of manifest.sox?.externalConsumers ?? []) expect(c.repo ?? '').not.toMatch(/^[/~]/);
  });

  it.skipIf(!hasDist)('SP35 `pnpm pack` output has no workspace: specifier and ships only dist', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-pack-'));
    try {
      const r = spawnSync('pnpm', ['pack', '--pack-destination', out], { cwd: PKG_ROOT, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      const tgz = fs.readdirSync(out).find((f) => f.endsWith('.tgz'))!;
      const files = spawnSync('tar', ['-tzf', path.join(out, tgz)], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
      expect(files.every((f) => f === 'package/package.json' || f === 'package/README.md' || f === 'package/CHANGELOG.md' || f === 'package/LICENSE' || f.startsWith('package/dist/'))).toBe(true);
      const manifestText = spawnSync('tar', ['-xzOf', path.join(out, tgz), 'package/package.json'], { encoding: 'utf8' }).stdout;
      expect(manifestText).not.toMatch(/workspace:/);
      expect(manifestText).not.toMatch(MACHINE_LOCAL_PATH);
      expect(manifestText).not.toContain(os.homedir());
      const manifest = JSON.parse(manifestText) as { dependencies?: Record<string, string> };
      expect(manifest.dependencies?.['@adhd/sox-listen-guard']).toMatch(/^\^\d+\.\d+\.\d+/);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);

  it.skipIf(!hasDist)('SP28 the built dist/index.js still exports every 0.5.0 runtime name', async () => {
    const mod = (await import(pathToFileURL(path.join(PKG_ROOT, 'dist', 'index.js')).href)) as Record<string, unknown>;
    const exported = Object.keys(mod.default && typeof mod.default === 'object' ? { ...(mod.default as object), ...mod } : mod);
    for (const name of SURFACE_0_5_0) expect(exported, name).toContain(name);
  });
});
