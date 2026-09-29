/**
 * 4041c6e0-umask-002-tighten.spec.ts — legacy 0775 socket dirs are repaired, not
 * deleted (BL-4041c6e0, BL-6233c1c2).
 *
 * A sox run dir made under umask 002, or by an older build, is 0775. The trust
 * check refuses it with reason `own-writable` and tells the operator to run
 * `chmod go-w`, never `rm -r`, because the dir holds live runtime state.
 * `tightenOwnedSocketDir` is the automatic repair: it acts only on a directory it
 * can prove is ours, through one O_NOFOLLOW descriptor.
 *
 * Every test runs under umask 002, restored in `finally`, and works only in
 * mkdtemp scratch dirs or injected stats. The real `/tmp/sox-<uid>` is never
 * opened: the fallback-root case returns before any fs call.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { udsFallbackRoot } from './socket-path.js';
import {
  assertPrivateSocketDir,
  ensurePrivateSocketDir,
  tightenOwnedSocketDir,
  type TightenEvent,
  type UdsDirUnsafeError,
} from './socket-dir.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function underUmask002<T>(fn: () => T): T {
  expect(() => process.umask()).not.toThrow(); // precondition: umask is settable here
  const prev = process.umask(0o002);
  try {
    return fn();
  } finally {
    process.umask(prev);
  }
}

/** A scratch dir created the legacy way: a bare recursive mkdir under umask 002. */
function legacyDir(): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-4041-tighten-'));
  cleanups.push(() => {
    fs.chmodSync(parent, 0o700);
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const dir = path.join(parent, 'run', 'supervisors');
  fs.mkdirSync(dir, { recursive: true }); // umask 002 => 0775, exactly the legacy shape
  return dir;
}

function mode(p: string): number {
  return fs.lstatSync(p).mode & 0o7777;
}

function refusal(fn: () => void): UdsDirUnsafeError {
  try {
    fn();
  } catch (err) {
    return err as UdsDirUnsafeError;
  }
  throw new Error('expected a refusal');
}

describe('BL-4041c6e0 / 6233c1c2: legacy 0775 socket dirs', () => {
  it('4041c6e0 6233c1c2 (a): a 0775 dir is refused as own-writable, with chmod go-w and no rm -r', () => {
    underUmask002(() => {
      const dir = legacyDir();
      expect(mode(dir)).toBe(0o775);
      const err = refusal(() => assertPrivateSocketDir(dir));
      expect(err.code).toBe('E_UDS_DIR_UNSAFE');
      expect(err.reason).toBe('own-writable');
      expect(err.message).toContain(`chmod go-w ${dir}`);
      expect(err.message).toContain('Do not delete it');
      expect(err.message).not.toContain('rm -r');
    });
  });

  it('4041c6e0 6233c1c2 (b): tighten returns tightened, mode becomes 0755, then the check passes', () => {
    underUmask002(() => {
      const dir = legacyDir();
      const events: TightenEvent[] = [];
      expect(tightenOwnedSocketDir(dir, { onTightened: (e) => events.push(e) })).toBe('tightened');
      expect(mode(dir)).toBe(0o755);
      expect(events).toEqual([{ dir, oldMode: 0o775, newMode: 0o755 }]);
      expect(() => assertPrivateSocketDir(dir)).not.toThrow();
      expect(() => ensurePrivateSocketDir(dir, { create: true })).not.toThrow();
    });
  });

  it('4041c6e0 6233c1c2 (c): a second tighten is a no-op that returns ok', () => {
    underUmask002(() => {
      const dir = legacyDir();
      expect(tightenOwnedSocketDir(dir)).toBe('tightened');
      const events: TightenEvent[] = [];
      expect(tightenOwnedSocketDir(dir, { onTightened: (e) => events.push(e) })).toBe('ok');
      expect(events).toEqual([]);
      expect(mode(dir)).toBe(0o755);
    });
  });

  it('4041c6e0 6233c1c2 (d): a symlink to a 0777 dir is skipped and its target is left unchanged', () => {
    underUmask002(() => {
      const target = legacyDir();
      fs.chmodSync(target, 0o777);
      const link = path.join(path.dirname(target), 'link');
      fs.symlinkSync(target, link);
      expect(tightenOwnedSocketDir(link)).toBe('skipped-not-owned');
      expect(mode(target)).toBe(0o777);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    });
  });

  it('4041c6e0 6233c1c2 (d2): a missing dir is absent, a non-directory is skipped', () => {
    underUmask002(() => {
      const dir = legacyDir();
      expect(tightenOwnedSocketDir(path.join(dir, 'nope'))).toBe('absent');
      const file = path.join(dir, 'plain');
      fs.writeFileSync(file, '');
      expect(tightenOwnedSocketDir(file)).toBe('skipped-not-owned');
    });
  });

  it('4041c6e0 6233c1c2 (d3): a dir owned by another uid is skipped (injected getuid)', () => {
    underUmask002(() => {
      const dir = legacyDir();
      const uid = (process.getuid as () => number)();
      expect(tightenOwnedSocketDir(dir, { deps: { getuid: () => uid + 1 } })).toBe('skipped-not-owned');
      expect(mode(dir)).toBe(0o775);
    });
  });

  it('4041c6e0 6233c1c2 (e): the /tmp/sox-<uid> fallback root is never touched', () => {
    underUmask002(() => {
      // Returns before any fs call, so this never opens the real root.
      expect(tightenOwnedSocketDir(udsFallbackRoot())).toBe('skipped-not-owned');
      expect(tightenOwnedSocketDir(udsFallbackRoot(4242), { deps: { getuid: () => 4242 } })).toBe(
        'skipped-not-owned',
      );
    });
  });

  it('4041c6e0 6233c1c2 (f): foreign and fallback-mode refusals carry their own reasons and messages', () => {
    underUmask002(() => {
      const uid = 90210;
      const stat = (m: number, owner: number, symlink = false) => ({
        mode: m,
        uid: owner,
        isDirectory: () => !symlink,
        isSymbolicLink: () => symlink,
      });

      // Foreign-owned ordinary dir.
      const foreign = refusal(() =>
        assertPrivateSocketDir('/data/run', { getuid: () => uid, lstat: () => stat(0o040700, 0) }),
      );
      expect(foreign.reason).toBe('foreign');
      expect(foreign.message).toContain('not a directory you own');
      expect(foreign.message).toContain('ls -ld /data/run');
      expect(foreign.message).toContain('possible local impostor');
      expect(foreign.message).toContain('mv /data/run /data/run.suspect-');
      expect(foreign.message).not.toContain('sun_path');
      expect(foreign.message).not.toContain('rm -r');

      // A symlink and a non-directory fold into foreign.
      const link = refusal(() =>
        assertPrivateSocketDir('/data/run', { getuid: () => uid, lstat: () => stat(0o120777, uid, true) }),
      );
      expect(link.reason).toBe('foreign');
      expect(link.isSymlink).toBe(true);
      expect(link.message).toContain('`rm /data/run` removes only the link');

      // Fallback root, ours, wrong mode.
      const root = udsFallbackRoot(uid);
      const wrongMode = refusal(() =>
        assertPrivateSocketDir(root, { getuid: () => uid, lstat: () => stat(0o040755, uid) }),
      );
      expect(wrongMode.reason).toBe('fallback-mode');
      expect(wrongMode.message).toContain(`chmod 700 ${root}`);
      expect(wrongMode.message).not.toContain('rm -r');

      // Fallback root, foreign: the foreign message plus the sun_path explanation.
      const foreignRoot = refusal(() =>
        assertPrivateSocketDir(root, { getuid: () => uid, lstat: () => stat(0o040700, 0) }),
      );
      expect(foreignRoot.reason).toBe('foreign');
      expect(foreignRoot.message).toContain('not a directory you own');
      expect(foreignRoot.message).toContain('exceeds sun_path (104 bytes)');
      expect(foreignRoot.message).toContain('SOX_ECOSYSTEM_HOME');
      expect(foreignRoot.message).not.toContain('rm -r');
    });
  });
});
