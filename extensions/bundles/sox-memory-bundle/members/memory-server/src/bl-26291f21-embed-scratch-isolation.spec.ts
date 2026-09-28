/**
 * BL-26291f21 — no memory-server test worker may resolve the operator's embed paths.
 *
 * `npx nx test memory-server` peer-spawned the machine-wide embedding host with
 * `--cache-dir=/Users/nix/.cache/sox/models` and `/Users/nix/.adhd/sox-ecosystem/run/proxy-*.sock`
 * from inside a vitest fork worker (the `real-backend` project's in-process real embeds). This
 * spec asserts, against the product's OWN resolvers (`getConfiguredEmbedPaths()` →
 * memory-core `resolveConfig().cacheDir` + embedding-provider `resolveEmbedHostSocketDir()`), that
 * a worker's embed paths lie inside the run's scratch root and never under the operator's
 * `~/.cache/sox` or `~/.adhd/sox-ecosystem`. It never embeds and never spawns anything.
 *
 * It also pins the shared real-backend gate to the directory the backend actually loads from
 * (the three real-backend files used to gate on `.../sox-memory/models` while loading
 * `.../sox/models`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getConfiguredEmbedPaths } from '@adhd/sox-memory-core';
import {
  EMBED_MODEL_DIR_NAME,
  MODEL_SEEDED_ENV,
  SCRATCH_ROOT_ENV,
  embedIsolationViolations,
  isInside,
  isRealModelCached,
  operatorEmbedRoots,
  realModelCacheDir,
  sanctionedOperatorTelemetryDir,
  TELEMETRY_DIR_ENV,
} from './test-support/bl-26291f21-embed-scratch.js';

describe('BL-26291f21 — memory-server test workers never resolve operator embed paths', () => {
  it('embed model cache + host socket dir resolve inside the run scratch root, never under the operator roots', () => {
    const { cacheDir, hostSocketDir } = getConfiguredEmbedPaths();
    const op = operatorEmbedRoots();
    expect(isInside(cacheDir, op.modelCacheRoot), `cacheDir ${cacheDir} under operator ${op.modelCacheRoot}`).toBe(false);
    expect(isInside(hostSocketDir, op.ecosystemHome), `socket dir ${hostSocketDir} under operator ${op.ecosystemHome}`).toBe(false);
    const scratch = process.env[SCRATCH_ROOT_ENV];
    expect(scratch, `${SCRATCH_ROOT_ENV} must be pinned by vitest.global-embed-scratch.ts`).toBeTruthy();
    expect(isInside(cacheDir, scratch as string)).toBe(true);
    expect(isInside(hostSocketDir, scratch as string)).toBe(true);
    expect(embedIsolationViolations()).toEqual([]);
  });

  it('the real-backend skip gate reads the SAME cache dir memory-core loads from (no sox-memory/models drift)', () => {
    expect(realModelCacheDir()).toBe(getConfiguredEmbedPaths().cacheDir);
    expect(realModelCacheDir().split(path.sep)).not.toContain('sox-memory');
    for (const f of ['recall-sqlite.test.ts', 'turso-clean-room.test.ts', 'clustering-e2e.test.ts']) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      expect(src, `${f} must not re-derive the stale sox-memory/models gate path`).not.toMatch(/'sox-memory'/);
      expect(src, `${f} must gate on the shared isRealModelCached()`).toMatch(/isRealModelCached\(\)/);
    }
  });

  it('the scratch model cache is seeded by the global setup (clone), never read from the operator cache by a test', () => {
    const seeded = process.env[MODEL_SEEDED_ENV];
    expect(seeded, `${MODEL_SEEDED_ENV} must be exported by vitest.global-embed-scratch.ts`).toMatch(/^[01]$/);
    const scratchModel = path.join(getConfiguredEmbedPaths().cacheDir, EMBED_MODEL_DIR_NAME, 'model_optimized.onnx');
    // The real-backend gate must agree with the seed: seeded => runs (no download); not seeded => skips.
    expect(fs.existsSync(scratchModel)).toBe(seeded === '1');
    expect(isRealModelCached()).toBe(seeded === '1');
  });

  it('the only operator ~/.adhd/sox-ecosystem path a worker resolves is the BL-404 sox-tests/logs telemetry dir, exactly', () => {
    const op = operatorEmbedRoots();
    expect(isInside(process.env['SOX_ECOSYSTEM_HOME'] ?? '', op.ecosystemHome)).toBe(false);
    const telemetryDir = process.env[TELEMETRY_DIR_ENV] ?? '';
    if (isInside(telemetryDir, op.ecosystemHome)) {
      expect(path.resolve(telemetryDir)).toBe(sanctionedOperatorTelemetryDir());
    }
    // The allowlist is exact, never a prefix: a sibling or a child of it is still a violation.
    for (const bad of [path.join(op.ecosystemHome, 'sox-tests'), path.join(sanctionedOperatorTelemetryDir(), 'nested'), path.join(op.ecosystemHome, 'run')]) {
      expect(embedIsolationViolations({ ...process.env, [TELEMETRY_DIR_ENV]: bad }).length, bad).toBeGreaterThan(0);
    }
    expect(embedIsolationViolations({ ...process.env, [TELEMETRY_DIR_ENV]: sanctionedOperatorTelemetryDir() })).toEqual([]);
  });
});
