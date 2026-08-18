/**
 * socket-path.spec.ts -- backend UDS path derivation (S9.5.4): deterministic,
 * filesystem-safe, identical singleton keys => identical path (one backend), and
 * bounded under the sun_path length limit.
 */
import { describe, it, expect } from 'vitest';
import { backendSocketPath } from './socket-path.js';

describe('backendSocketPath', () => {
  it('is deterministic for the same (dir, key)', () => {
    const a = backendSocketPath('/tmp/run/supervisors', 'memory-server|/home/u/.memory/memory.db');
    const b = backendSocketPath('/tmp/run/supervisors', 'memory-server|/home/u/.memory/memory.db');
    expect(a).toBe(b);
  });

  it('differs for different keys (no collision)', () => {
    const a = backendSocketPath('/tmp/run/supervisors', 'memory-server|/db/a.db');
    const b = backendSocketPath('/tmp/run/supervisors', 'memory-server|/db/b.db');
    expect(a).not.toBe(b);
  });

  it('produces a .sock under the given socket dir', () => {
    const p = backendSocketPath('/tmp/run/supervisors', 'x|y');
    expect(p.startsWith('/tmp/run/supervisors/')).toBe(true);
    expect(p.endsWith('.sock')).toBe(true);
  });

  it('stays within the 104-byte sun_path limit even for a very long key', () => {
    const longKey = 'memory-server|' + '/very/deeply/nested/path/segment'.repeat(10);
    const p = backendSocketPath('/tmp/run/supervisors', longKey);
    expect(Buffer.byteLength(p, 'utf8')).toBeLessThanOrEqual(104);
  });

  it('sanitises filesystem-unsafe characters out of the name segment', () => {
    const p = backendSocketPath('/tmp/run/supervisors', 'id with spaces|/db/p ath.db');
    const name = p.split('/').pop() ?? '';
    expect(/^[a-zA-Z0-9._-]+$/.test(name)).toBe(true);
  });

  // BL-578: reproduces the real-world failure -- a nested git-worktree scratch
  // data root (`.claude/worktrees/agent-<hash>/dist/smoke/run-<ts>/sox-data-root/
  // run/supervisors`) is ALREADY over the 104-byte sun_path budget on its own,
  // before any filename is appended. The pre-fix implementation only shortened
  // the filename and re-joined it onto the same (too-long) socketDir, so this
  // case stayed broken even after the "long key" fallback above was added --
  // proving the fallback logic, not just the key length, was the defect.
  it('BL-578: stays within the 104-byte sun_path limit when socketDir alone already exceeds it', () => {
    const deeplyNestedSocketDir =
      '/Users/nix/dev/ai/sox-ecosystem/.claude/worktrees/agent-ab422e9ad04a48819' +
      '/dist/smoke/run-2026-08-17T23-33-50/sox-data-root/run/supervisors';
    expect(Buffer.byteLength(deeplyNestedSocketDir, 'utf8')).toBeGreaterThan(104);

    const p = backendSocketPath(deeplyNestedSocketDir, 'memory-server|/db/a.db');
    expect(Buffer.byteLength(p, 'utf8')).toBeLessThanOrEqual(104);
    expect(p.endsWith('.sock')).toBe(true);
  });

  it('BL-578: the long-socketDir fallback is still deterministic and collision-free per key', () => {
    const deeplyNestedSocketDir =
      '/Users/nix/dev/ai/sox-ecosystem/.claude/worktrees/agent-ab422e9ad04a48819' +
      '/dist/smoke/run-2026-08-17T23-33-50/sox-data-root/run/supervisors';
    const a1 = backendSocketPath(deeplyNestedSocketDir, 'memory-server|/db/a.db');
    const a2 = backendSocketPath(deeplyNestedSocketDir, 'memory-server|/db/a.db');
    const b = backendSocketPath(deeplyNestedSocketDir, 'memory-server|/db/b.db');
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });
});
