/**
 * bl-bae70da4-home-redirect.spec.ts — BL-bae70da4: memory-core's test suite
 * must never resolve a `~/.memory`-shaped path into the operator's real
 * store.
 *
 * Symptom (2026-09-28): `npx nx test memory-core --skip-nx-cache` created
 * `/Users/nix/.memory/sox-backup-test-bl385-1790579878384-zsap0j7ml2s/` — a
 * BL-385 backup-spec test directory, written directly into the operator's
 * live store because `backup.spec.ts`'s helpers (`freshDbInsideAllowlist`,
 * `destPathInsideAllowlist`, and two inline call sites) build their test
 * paths from the real `os.homedir()`, and `backup.ts`'s
 * `memoryAllowlistRoot()` / `isPathInMemoryAllowlist()` allowlist is itself
 * `os.homedir()/.memory` — so any path built the same way trivially passes
 * the allowlist check the test exists to exercise.
 *
 * Fix: `vitest.home-scratch-setup.ts`, the FIRST entry in this project's
 * `setupFiles`, redirects `HOME`/`USERPROFILE` to a scratch directory before
 * any other setup file or spec module runs. `os.homedir()` re-reads
 * `process.env.HOME` on every call (not cached at process start), so every
 * call-site above is redirected with zero per-spec changes.
 *
 * This spec asserts nothing but path STRINGS — it never touches disk itself
 * (deliberately: it must be safe to run against UNFIXED code, i.e. without
 * the HOME redirect wired into vitest.config.ts's setupFiles, to prove RED,
 * without writing into the real ~/.memory in that state).
 *
 * `os.userInfo().homedir` is used as ground truth throughout because it is a
 * direct OS passwd-DB / API lookup that IGNORES the `HOME`/`USERPROFILE`
 * redirect entirely (verified: `HOME=/tmp/x node -e
 * "console.log(os.userInfo().homedir)"` still prints the real account home)
 * — so it stays anchored to the operator's real home both before AND after
 * the fix, making it a reliable independent oracle for this test.
 */
import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { memoryAllowlistRoot } from './backup.js';
import { defaultMemoryDbPath } from './reembed.js';

describe('BL-bae70da4: memory-core tests never resolve into the operator real ~/.memory', () => {
  const realHome = os.userInfo().homedir;
  const realMemRoot = path.join(realHome, '.memory');

  it('os.homedir() no longer equals the OS passwd-DB home during a test run', () => {
    expect(os.homedir()).not.toBe(realHome);
  });

  it('memoryAllowlistRoot() (the backupStore allowlist) resolves outside the operator real ~/.memory', () => {
    const root = memoryAllowlistRoot();
    expect(root).not.toBe(realMemRoot);
    expect(root.startsWith(realMemRoot + path.sep)).toBe(false);
  });

  it('defaultMemoryDbPath() resolves outside the operator real ~/.memory', () => {
    const dbPath = defaultMemoryDbPath();
    expect(dbPath.startsWith(realMemRoot)).toBe(false);
  });

  it('the redirect points at a scratch directory, not merely "somewhere else on the real machine"', () => {
    // Belt-and-suspenders: the redirected home must be under the OS tmp
    // root (mkdtempSync's contract), so a future regression that points
    // HOME at some OTHER fixed, non-scratch, non-tmp directory (still not
    // the real home, so the two assertions above would stay green) is
    // still caught here.
    const scratchHome = os.homedir();
    expect(scratchHome.startsWith(os.tmpdir())).toBe(true);
  });
});
