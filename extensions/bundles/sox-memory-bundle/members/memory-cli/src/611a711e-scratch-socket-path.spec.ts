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
 * A FIRST FIX ATTEMPT (also 7be12c60 → still not enough): shortening the mkdtemp base to
 * `fs.mkdtempSync('/tmp/sox-cli-')` got the full, unshortened socket name down to 100 bytes — a
 * PASS under a "≤104 && inside root" assertion, but silently still tier-2 territory: the actual
 * shortened name `backendSocketPath()` returns for `/tmp/sox-cli-XXXXXX/eco/run` lands at 101/104,
 * because the byte check alone cannot tell tier-1 (the real, full, sanitised-key filename) apart
 * from tier-2 (the short `proxy-<digest12>.sock` fallback name) when BOTH happen to fit under 104
 * — the assertion below closes that gap by recomputing the tier-1 name independently and asserting
 * `backendSocketPath()` actually returned it, not merely a same-length stand-in.
 *
 * THE FIX: `vitest.global-embed-scratch.ts` mints the root via `fs.mkdtempSync('/tmp/cl-')` — six
 * bytes shorter than `/tmp/sox-cli-`, so the resolved `hostSocketDir` (`<root>/eco/run`) is 22
 * bytes and the full, unshortened tier-1 socket name (96 bytes total) clears budget with an
 * 8-byte margin, comfortably inside tier-1 and never needing either fallback tier.
 *
 * RED on 7be12c60 (measured by hand: temporarily reverted `vitest.global-embed-scratch.ts`'s
 * mkdtemp line back to `fs.mkdtempSync(path.join(os.tmpdir(), 'sox-cli-embed-'))` and ran this
 * suite) — `backendSocketPath()` returned the TIER-2 shortened name (`proxy-<digest12>.sock`,
 * dropping the sanitised key entirely), 101 bytes, NOT the independently-recomputed tier-1 name
 * this test expects: the exact-equality assertion below failed with a mismatch between the
 * expected (tier-1) and actual (tier-2) socket path, even though 101 ≤ 104 and the path still
 * resolved inside the scratch root — proving the old byte-length-only check could not have caught
 * this. GREEN below: the suite's actual live scratch root (this run's `SCRATCH_ROOT_ENV`)
 * resolves the real tier-1 socket path with margin to spare.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { embedHostSingletonKey } from '@adhd/sox-embedding-provider';
import { backendSocketPath } from '@adhd/sox-service-proxy';
import { getConfiguredEmbedPaths } from '@adhd/sox-memory-core';
import { isInside } from '@adhd/sox-memory-core/testing';
import { SCRATCH_ROOT_ENV } from './test-support/bl-57ae788f-embed-scratch-env.js';

const MAX_SUN_PATH = 104;
/** Minimum bytes of headroom the FULL (tier-1) socket path must keep under MAX_SUN_PATH, so a
 * future extra path segment (a longer run id, a nested subdirectory) is caught here instead of
 * silently tipping into the tier-2/tier-3 fallbacks. */
const MIN_MARGIN = 8;

/** Independently recomputes `backendSocketPath()`'s tier-1 (full, unshortened) name from the same
 * inputs — mirrors `libs/service-proxy/src/socket-path.ts`'s sanitise/digest logic exactly, so this
 * test can assert the FUNCTION actually chose tier-1, not merely that its output happens to fit
 * under budget the way a same-length tier-2/tier-3 name also would. */
function expectedTier1Name(singletonKey: string): string {
  const safe = singletonKey.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48);
  const digest = createHash('sha256').update(singletonKey, 'utf8').digest('hex').slice(0, 12);
  return `proxy-${safe}-${digest}.sock`;
}

describe('BL-611a711e — memory-cli scratch root keeps the real embed-host socket path inside budget', () => {
  it('backendSocketPath() chooses the tier-1 (full, unshortened) name with an 8-byte margin, inside the scratch root', () => {
    const root = process.env[SCRATCH_ROOT_ENV];
    expect(root, `${SCRATCH_ROOT_ENV} must be pinned by vitest.global-embed-scratch.ts`).toBeTruthy();

    const { hostSocketDir, cacheDir } = getConfiguredEmbedPaths();
    expect(isInside(hostSocketDir, root as string)).toBe(true);

    // A realistic singleton key — real modelId/ep length, real 12-hex buildId/cacheDir-digest
    // lengths (embedHostSingletonKey's own format), not a contrived short string.
    const key = embedHostSingletonKey('bge-base-en-v1.5', 'cpu', cacheDir, 'a1b2c3d4e5f6');
    const socketPath = backendSocketPath(hostSocketDir, key);

    // The load-bearing assertion (BL-611a711e): the FULL tier-1 name, not just "some path ≤104
    // bytes that happens to resolve inside root" — a tier-2/tier-3 fallback can satisfy that
    // weaker check too (measured: tier-2 landed at 101/104 under the pre-fix root).
    const expectedName = expectedTier1Name(key);
    expect(
      socketPath.endsWith(`/${expectedName}`),
      `socket path ${socketPath} must end with the tier-1 name ${expectedName} — a different suffix means backendSocketPath() fell back to tier-2/tier-3`,
    ).toBe(true);
    expect(socketPath).toBe(`${hostSocketDir}/${expectedName}`);

    const bytes = Buffer.byteLength(socketPath, 'utf8');
    expect(bytes, `socket path ${socketPath} (${String(bytes)} bytes) must fit MAX_SUN_PATH=${String(MAX_SUN_PATH)}`).toBeLessThanOrEqual(MAX_SUN_PATH);
    expect(
      MAX_SUN_PATH - bytes,
      `socket path ${socketPath} (${String(bytes)} bytes) must keep at least ${String(MIN_MARGIN)} bytes of margin under MAX_SUN_PATH=${String(MAX_SUN_PATH)}, has ${String(MAX_SUN_PATH - bytes)}`,
    ).toBeGreaterThanOrEqual(MIN_MARGIN);

    // Never the tier-3 escape (`udsFallbackRoot()`, /tmp/sox-<uid>/...) — the resolved socket
    // must still live inside THIS run's scratch root, not the fixed per-uid fallback root.
    expect(isInside(socketPath, root as string), `socket path ${socketPath} must resolve inside scratch root ${String(root)}`).toBe(true);
  });
});
