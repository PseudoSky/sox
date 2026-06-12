/**
 * libs/host-runtime/src/policy.spec.ts
 *
 * Unit tests for the permission policy compiler and matcher.
 *
 * Criteria covered:
 *   [policy-core.2] deny-by-default for a present fs.write domain
 *   [policy-core.3] legacy compat: compilePolicy(undefined).enforced===false, allow-all
 *   [policy-core.4] toEnv/fromEnv round-trip lossless
 *   [policy-core.5] ~/ and ** matching
 */

import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { compilePolicy, compilePolicyFromEnv } from './policy.js';

// ─── [policy-core.3] Legacy compat ────────────────────────────────────────────

describe('compilePolicy(undefined) — legacy compat [policy-core.3]', () => {
  it('sets enforced=false', () => {
    const p = compilePolicy(undefined);
    expect(p.enforced).toBe(false);
  });

  it('allowsFsRead returns true for any path', () => {
    const p = compilePolicy(undefined);
    expect(p.allowsFsRead('/etc/passwd')).toBe(true);
    expect(p.allowsFsRead('/tmp/evil.db')).toBe(true);
  });

  it('allowsFsWrite returns true for any path', () => {
    const p = compilePolicy(undefined);
    expect(p.allowsFsWrite('/tmp/anything.db')).toBe(true);
    expect(p.allowsFsWrite('/etc/shadow')).toBe(true);
  });

  it('allowsSocket returns true for any path', () => {
    const p = compilePolicy(undefined);
    expect(p.allowsSocket('/var/run/anything.sock')).toBe(true);
  });

  it('allowsNetwork returns true for any host', () => {
    const p = compilePolicy(undefined);
    expect(p.allowsNetwork('evil.example.com')).toBe(true);
    expect(p.allowsNetwork('https://any.host/path')).toBe(true);
  });
});

// ─── [policy-core.2] Deny-by-default for a present domain ────────────────────

describe('deny-by-default for declared domains [policy-core.2]', () => {
  it('denies a write path OUTSIDE the declared fs.write allowlist', () => {
    const p = compilePolicy({
      fs: { write: [path.join(os.homedir(), '.memory', '**')] },
    });
    expect(p.enforced).toBe(true);
    expect(p.allowsFsWrite('/tmp/evil.db')).toBe(false);
  });

  it('allows a write path INSIDE the declared fs.write allowlist', () => {
    const p = compilePolicy({
      fs: { write: [path.join(os.homedir(), '.memory', '**')] },
    });
    expect(p.allowsFsWrite(path.join(os.homedir(), '.memory', 'notes.db'))).toBe(true);
  });

  it('denies when allowlist is empty (deny-by-default)', () => {
    const p = compilePolicy({ fs: { write: [] } });
    expect(p.allowsFsWrite('/tmp/any.db')).toBe(false);
  });

  it('fs.read absent in a present block → unconstrained for read', () => {
    // Only fs.write is declared; fs.read domain is absent → read is unconstrained
    const p = compilePolicy({ fs: { write: ['/allowed/**'] } });
    expect(p.allowsFsRead('/tmp/anything')).toBe(true);
  });

  it('fs present but only read declared → write is unconstrained (absent sub-key)', () => {
    // fs block present, but write key absent (undefined) → write is unconstrained
    const p = compilePolicy({ fs: { read: ['/allowed/**'] } });
    expect(p.allowsFsWrite('/tmp/anything')).toBe(true);
  });

  it('network domain present but empty → denies all hosts', () => {
    const p = compilePolicy({ network: { outbound: [] } });
    expect(p.allowsNetwork('example.com')).toBe(false);
  });

  it('socket domain absent from present block → unconstrained', () => {
    const p = compilePolicy({ fs: { write: ['/allowed/**'] } });
    expect(p.allowsSocket('/var/run/anything.sock')).toBe(true);
  });

  it('socket declared → enforced deny-by-default', () => {
    const p = compilePolicy({
      socket: { paths: [path.join(os.homedir(), '.memory', 'memoryd.sock')] },
    });
    expect(p.allowsSocket('/var/run/other.sock')).toBe(false);
    expect(p.allowsSocket(path.join(os.homedir(), '.memory', 'memoryd.sock'))).toBe(true);
  });

  it('network allows a declared host', () => {
    const p = compilePolicy({ network: { outbound: ['api.example.com'] } });
    expect(p.allowsNetwork('api.example.com')).toBe(true);
    expect(p.allowsNetwork('evil.com')).toBe(false);
  });
});

// ─── [policy-core.5] ~/ and ** matching ──────────────────────────────────────

describe('tilde expansion and ** glob matching [policy-core.5]', () => {
  it('~/.memory/x.db is allowed by ["~/.memory/**"]', () => {
    const p = compilePolicy({ fs: { write: ['~/.memory/**'] } });
    const target = path.join(os.homedir(), '.memory', 'x.db');
    expect(p.allowsFsWrite(target)).toBe(true);
  });

  it('/tmp/x.db is denied by ["~/.memory/**"]', () => {
    const p = compilePolicy({ fs: { write: ['~/.memory/**'] } });
    expect(p.allowsFsWrite('/tmp/x.db')).toBe(false);
  });

  it('~/.memory/sub/dir/x.db is allowed by ["~/.memory/**"] (** crosses segments)', () => {
    const p = compilePolicy({ fs: { write: ['~/.memory/**'] } });
    const target = path.join(os.homedir(), '.memory', 'sub', 'dir', 'x.db');
    expect(p.allowsFsWrite(target)).toBe(true);
  });

  it('* matches within a single segment only', () => {
    const p = compilePolicy({ fs: { read: ['/tmp/*.db'] } });
    expect(p.allowsFsRead('/tmp/foo.db')).toBe(true);
    expect(p.allowsFsRead('/tmp/sub/foo.db')).toBe(false);
    expect(p.allowsFsRead('/tmp/foo.txt')).toBe(false);
  });

  it('exact path match works (no glob chars)', () => {
    const p = compilePolicy({
      socket: { paths: [path.join(os.homedir(), '.memory', 'memoryd.sock')] },
    });
    expect(p.allowsSocket(path.join(os.homedir(), '.memory', 'memoryd.sock'))).toBe(true);
    expect(p.allowsSocket(path.join(os.homedir(), '.memory', 'other.sock'))).toBe(false);
  });

  it('tilde in subject (allowsFsWrite("~/.memory/x.db")) expands correctly', () => {
    // The subject itself starts with ~/ — normalizePath expands it
    const p = compilePolicy({ fs: { write: ['~/.memory/**'] } });
    // Pass the tilde path as subject; the implementation must expand it before matching
    expect(p.allowsFsWrite('~/.memory/x.db')).toBe(true);
  });
});

// ─── [policy-core.4] toEnv / fromEnv round-trip ──────────────────────────────

describe('toEnv / fromEnv round-trip [policy-core.4]', () => {
  const perms = {
    fs: { read: ['~/.memory/**'], write: ['~/.memory/**'] },
    network: { outbound: [] },
    socket: { paths: ['~/.memory/memoryd.sock'] },
  };

  it('round-tripped policy has enforced=true', () => {
    const p = compilePolicy(perms);
    const p2 = compilePolicyFromEnv(p.toEnv());
    expect(p2.enforced).toBe(true);
  });

  it('round-tripped allowsFsWrite matches original for allowed path', () => {
    const p = compilePolicy(perms);
    const p2 = compilePolicyFromEnv(p.toEnv());
    const allowed = path.join(os.homedir(), '.memory', 'notes.db');
    expect(p2.allowsFsWrite(allowed)).toBe(p.allowsFsWrite(allowed));
    expect(p2.allowsFsWrite(allowed)).toBe(true);
  });

  it('round-tripped allowsFsWrite matches original for denied path', () => {
    const p = compilePolicy(perms);
    const p2 = compilePolicyFromEnv(p.toEnv());
    expect(p2.allowsFsWrite('/tmp/evil.db')).toBe(p.allowsFsWrite('/tmp/evil.db'));
    expect(p2.allowsFsWrite('/tmp/evil.db')).toBe(false);
  });

  it('round-tripped allowsNetwork matches original (deny-all outbound)', () => {
    const p = compilePolicy(perms);
    const p2 = compilePolicyFromEnv(p.toEnv());
    expect(p2.allowsNetwork('example.com')).toBe(p.allowsNetwork('example.com'));
    expect(p2.allowsNetwork('example.com')).toBe(false);
  });

  it('round-tripped allowsSocket matches original for allowed socket', () => {
    const p = compilePolicy(perms);
    const p2 = compilePolicyFromEnv(p.toEnv());
    const sock = path.join(os.homedir(), '.memory', 'memoryd.sock');
    expect(p2.allowsSocket(sock)).toBe(p.allowsSocket(sock));
    expect(p2.allowsSocket(sock)).toBe(true);
  });

  it('round-tripped allowsSocket denies unlisted socket', () => {
    const p = compilePolicy(perms);
    const p2 = compilePolicyFromEnv(p.toEnv());
    expect(p2.allowsSocket('/var/run/other.sock')).toBe(p.allowsSocket('/var/run/other.sock'));
    expect(p2.allowsSocket('/var/run/other.sock')).toBe(false);
  });

  it('unenforced policy round-trips to unenforced (SOX_PERM_ENFORCE absent)', () => {
    const p = compilePolicy(undefined);
    const env = p.toEnv();
    // toEnv() on unenforced policy must NOT include SOX_PERM_ENFORCE
    expect(env['SOX_PERM_ENFORCE']).toBeUndefined();
    const p2 = compilePolicyFromEnv(env);
    expect(p2.enforced).toBe(false);
    expect(p2.allowsFsWrite('/tmp/anything')).toBe(true);
  });

  it('toEnv() produces correct [shape:policy-env] keys and JSON arrays', () => {
    const p = compilePolicy(perms);
    const env = p.toEnv();
    expect(env['SOX_PERM_ENFORCE']).toBe('1');
    expect(JSON.parse(env['SOX_PERM_FS_READ']!)).toEqual(['~/.memory/**']);
    expect(JSON.parse(env['SOX_PERM_FS_WRITE']!)).toEqual(['~/.memory/**']);
    expect(JSON.parse(env['SOX_PERM_SOCKET']!)).toEqual(['~/.memory/memoryd.sock']);
    expect(JSON.parse(env['SOX_PERM_NETWORK']!)).toEqual([]);
  });

  it('full representative decision set matches after round-trip', () => {
    const p = compilePolicy(perms);
    const p2 = compilePolicyFromEnv(p.toEnv());

    const subjects = {
      fsRead: [
        path.join(os.homedir(), '.memory', 'index.db'),
        '/etc/passwd',
      ],
      fsWrite: [
        path.join(os.homedir(), '.memory', 'notes.db'),
        '/tmp/evil.db',
      ],
      socket: [
        path.join(os.homedir(), '.memory', 'memoryd.sock'),
        '/var/run/evil.sock',
      ],
      network: ['api.example.com', 'evil.com'],
    };

    for (const s of subjects.fsRead) {
      expect(p2.allowsFsRead(s)).toBe(p.allowsFsRead(s));
    }
    for (const s of subjects.fsWrite) {
      expect(p2.allowsFsWrite(s)).toBe(p.allowsFsWrite(s));
    }
    for (const s of subjects.socket) {
      expect(p2.allowsSocket(s)).toBe(p.allowsSocket(s));
    }
    for (const s of subjects.network) {
      expect(p2.allowsNetwork(s)).toBe(p.allowsNetwork(s));
    }
  });
});

// ─── Absent domain in present block ───────────────────────────────────────────

describe('absent domain in present block → unconstrained', () => {
  it('fs absent from present block → both read and write unconstrained', () => {
    // No `fs` key at all; only network is declared
    const p = compilePolicy({ network: { outbound: [] } });
    expect(p.allowsFsRead('/etc/passwd')).toBe(true);
    expect(p.allowsFsWrite('/tmp/anything')).toBe(true);
  });

  it('network absent from present block → network unconstrained', () => {
    const p = compilePolicy({ fs: { write: [] } });
    expect(p.allowsNetwork('any.host.example.com')).toBe(true);
  });

  it('socket absent from present block → socket unconstrained', () => {
    const p = compilePolicy({ fs: { write: [] } });
    expect(p.allowsSocket('/var/run/docker.sock')).toBe(true);
  });
});
