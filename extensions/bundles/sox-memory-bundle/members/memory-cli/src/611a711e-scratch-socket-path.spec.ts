/**
 * 611a711e-scratch-socket-path.spec.ts — regression for backlog 611a711e item 2.
 *
 * WHAT WAS WRONG (measured, not assumed, on 7be12c60): `vitest.global-embed-scratch.ts` minted
 * this suite's scratch root via `fs.mkdtempSync(path.join(os.tmpdir(), 'sox-cli-embed-'))`. On
 * macOS, `os.tmpdir()` resolves to `/var/folders/<2 chars>/<~30 chars>/T/` — already ~50-70 bytes
 * before the run-specific suffix, `eco/run/` (the resolved `hostSocketDir`), or the socket
 * filename are added. The REAL socket file the embed host binds is derived by
 * `@adhd/sox-service-proxy`'s `backendSocketPath(socketDir, singletonKey)`, which composes
 * `<socketDir>/proxy-<sanitised-key>-<digest12>.sock` and must fit macOS's 104-byte `sun_path`
 * budget (`libs/service-proxy/src/socket-path.ts`). Measured against the OLD root construction
 * with a realistic `embedHostSingletonKey()` value, the full (unshortened) socket filename came
 * to 150 bytes — 46 OVER budget — forcing `backendSocketPath()`'s tier-2 shortened-filename
 * fallback, which itself lands within single-digit bytes of the 104 limit (measured: 101/104).
 * Any deeper nesting (a longer temp-dir hash, a longer run id) tips tier-2 over as well, and
 * `backendSocketPath()`'s tier-3 fallback escapes ENTIRELY OUTSIDE this scratch root, to
 * `/tmp/sox-<uid>/p-<16hex>.sock` — silently defeating the whole isolation guarantee this suite's
 * `assertEmbedPathsIsolated` calls exist to enforce (that check only inspects `hostSocketDir`, the
 * containing directory, never the realized socket FILE path `backendSocketPath()` actually binds).
 *
 * THE FIX: `vitest.global-embed-scratch.ts` now mints the root via the SAME short, fixed,
 * absolute pattern memory-server's own `vitest.global-embed-scratch.ts` already uses
 * (`fs.mkdtempSync('/tmp/sox-cli-')`, no `os.tmpdir()` in the path at all) — comfortably inside
 * budget even for the FULL, unshortened socket name, so neither fallback tier is ever needed.
 *
 * RED on 7be12c60 (measured by hand — the old root construction is gone, so this file asserts the
 * NEW behavior and documents the OLD numbers in this header rather than reconstructing the old
 * code path here): full socket path length 150 bytes (old root) vs. 100 bytes (new root); MAX is
 * 104. GREEN below: the suite's actual live scratch root (this run's `SCRATCH_ROOT_ENV`) produces
 * a full, unshortened socket path inside budget, and it resolves inside the scratch root.
 */
import { describe, expect, it } from 'vitest';
import { embedHostSingletonKey } from '@adhd/sox-embedding-provider';
import { backendSocketPath } from '@adhd/sox-service-proxy';
import { getConfiguredEmbedPaths } from '@adhd/sox-memory-core';
import { isInside } from '@adhd/sox-memory-core/testing';
import { SCRATCH_ROOT_ENV } from './test-support/bl-57ae788f-embed-scratch-env.js';

const MAX_SUN_PATH = 104;

describe('BL-611a711e — memory-cli scratch root keeps the real embed-host socket path inside budget', () => {
  it('the full (unshortened) proxy socket path fits the 104-byte sun_path budget and resolves inside the scratch root', () => {
    const root = process.env[SCRATCH_ROOT_ENV];
    expect(root, `${SCRATCH_ROOT_ENV} must be pinned by vitest.global-embed-scratch.ts`).toBeTruthy();

    const { hostSocketDir } = getConfiguredEmbedPaths();
    expect(isInside(hostSocketDir, root as string)).toBe(true);

    // A realistic singleton key — real modelId/ep length, real 12-hex buildId/cacheDir-digest
    // lengths (embedHostSingletonKey's own format), not a contrived short string.
    const key = embedHostSingletonKey('bge-base-en-v1.5', 'cpu', getConfiguredEmbedPaths().cacheDir, 'a1b2c3d4e5f6');
    const socketPath = backendSocketPath(hostSocketDir, key);

    expect(
      Buffer.byteLength(socketPath, 'utf8'),
      `socket path ${socketPath} (${String(Buffer.byteLength(socketPath, 'utf8'))} bytes) must fit MAX_SUN_PATH=${String(MAX_SUN_PATH)}`,
    ).toBeLessThanOrEqual(MAX_SUN_PATH);

    // Never the tier-3 escape (`udsFallbackRoot()`, /tmp/sox-<uid>/...) — the resolved socket
    // must still live inside THIS run's scratch root, not the fixed per-uid fallback root.
    expect(isInside(socketPath, root as string), `socket path ${socketPath} must resolve inside scratch root ${String(root)}`).toBe(true);
  });
});
