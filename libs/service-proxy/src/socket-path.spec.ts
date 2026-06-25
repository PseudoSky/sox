/**
 * socket-path.spec.ts — backend UDS path derivation (§9.5.4): deterministic,
 * filesystem-safe, identical singleton keys ⇒ identical path (one backend), and
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
});
