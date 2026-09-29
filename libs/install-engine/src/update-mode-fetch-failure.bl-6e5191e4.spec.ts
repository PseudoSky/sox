/**
 * libs/install-engine/src/update-mode-fetch-failure.bl-6e5191e4.spec.ts
 *
 * BL-6e5191e4 — `install()` called `process.exit(1)` directly when a
 * fetch/checksum failure occurred, which `cmdUpgrade`'s per-consumer
 * try/catch (main.ts) cannot catch: `soxe upgrade --all` died on the FIRST
 * failing consumer, aborting the entire run and skipping every remaining
 * consumer plus the rolling restart.
 *
 * Fix: in `mode: 'update'`, install() throws a typed Error instead of
 * calling process.exit(), so the caller can catch it and continue with the
 * next consumer. Other modes (a direct `soxe install`) keep the original
 * fail-fast process.exit(1) behavior.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { install } from './install.js';
import { DATA_SUBDIR, scopeConfigPaths } from './data-paths.js';

interface Fixture {
  root: string;
  configPath: string;
}

/** A consumer whose config resolves an entry with a checksum that will NEVER match. */
function makeFixture(id: string): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-6e5191e4-'));
  const extDir = path.join(root, 'ext-src', id);
  fs.mkdirSync(extDir, { recursive: true });
  const artifactPath = path.join(extDir, 'index.js');
  fs.writeFileSync(artifactPath, `module.exports = { v: "${id}" };\n`, 'utf8');

  fs.mkdirSync(path.join(root, DATA_SUBDIR), { recursive: true });
  const configPath = scopeConfigPaths('project', root).config;
  fs.writeFileSync(configPath, JSON.stringify({ install: [{ id, source: `file://${artifactPath}` }] }, null, 2) + '\n', 'utf8');

  return { root, configPath };
}

describe('BL-6e5191e4: install() fetch/checksum failure in update mode', () => {
  const roots: string[] = [];
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Fail the test loudly instead of silently killing the vitest worker if
    // the regression reappears and process.exit(1) is called again.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${String(code)}) was called — this must not happen in update mode`);
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    for (const r of roots.splice(0)) {
      try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
  });

  it('rejects with a typed Error instead of calling process.exit', async () => {
    const fx = makeFixture('bl-6e5191e4-probe-a');
    roots.push(fx.root);

    // No registry available for this id → resolveFromRegistry returns null →
    // findLocalExtension also finds nothing → the entry is skipped with a
    // warning, not a fetch failure. To force the fetch/checksum failure path,
    // point the config's explicit `source` at a real file, but supply a
    // registry-independent expectedChecksum mismatch is not reachable without
    // a registry row. Instead, point `source` at a nonexistent file so
    // fetchArtifact's file:// branch throws "source file not found".
    const missingPath = path.join(fx.root, 'does-not-exist.js');
    fs.writeFileSync(
      fx.configPath,
      JSON.stringify({ install: [{ id: 'bl-6e5191e4-probe-a', source: `file://${missingPath}` }] }, null, 2) + '\n',
      'utf8',
    );

    await expect(
      install({ scope: 'project', mode: 'update', root: fx.root, configPath: fx.configPath }),
    ).rejects.toThrow(/bl-6e5191e4-probe-a/);

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('regression guard: default mode still fails fast via process.exit(1) (unchanged behavior)', async () => {
    const fx = makeFixture('bl-6e5191e4-probe-b');
    roots.push(fx.root);
    const missingPath = path.join(fx.root, 'does-not-exist.js');
    fs.writeFileSync(
      fx.configPath,
      JSON.stringify({ install: [{ id: 'bl-6e5191e4-probe-b', source: `file://${missingPath}` }] }, null, 2) + '\n',
      'utf8',
    );

    await expect(
      install({ scope: 'project', mode: 'default', root: fx.root, configPath: fx.configPath }),
    ).rejects.toThrow(/process\.exit\(1\) was called/);
  });
});
