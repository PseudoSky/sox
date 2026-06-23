/**
 * libs/install-engine/src/verify-integrity.spec.ts
 *
 * Unit gate for the ADR-0003 is-this-current primitive. The scope-parity suite
 * (integrity.scope.spec.ts) exercises the rule end-to-end through install();
 * this suite pins the primitive's four verdicts directly:
 *   current | stale | not-installed | unresolvable
 * across all four scopes (the primitive is scope-independent by construction —
 * only the lockfile PATH differs, which we supply explicitly).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { verifyIntegrity } from './verify-integrity.js';
import type { Scope, Lockfile } from './install.js';

const SCOPES: Scope[] = ['org', 'user', 'project', 'local'];

function sha256File(p: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

interface Sandbox {
  root: string;
  artifactPath: string;
  lockfilePath: string;
}

function makeSandbox(id: string, body: string): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-'));
  const artifactPath = path.join(root, 'dist', 'index.js');
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, body, 'utf8');
  const lockfilePath = path.join(root, 'extensions.lock');
  const lock: Lockfile = {
    lockfileVersion: 2,
    resolved: {
      [id]: {
        source: `file://${artifactPath}`,
        checksum: sha256File(artifactPath),
        resolved_at: new Date().toISOString(),
      },
    },
  };
  fs.writeFileSync(lockfilePath, JSON.stringify(lock, null, 2) + '\n', 'utf8');
  return { root, artifactPath, lockfilePath };
}

describe('verifyIntegrity primitive', () => {
  const sandboxes: Sandbox[] = [];
  beforeEach(() => { sandboxes.length = 0; });
  afterEach(() => {
    for (const s of sandboxes) {
      try { fs.rmSync(s.root, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
  function track(s: Sandbox): Sandbox { sandboxes.push(s); return s; }

  for (const scope of SCOPES) {
    describe(`scope=${scope}`, () => {
      it('reports CURRENT when the artifact matches the recorded checksum', async () => {
        const id = `vi-cur-${scope}`;
        const sb = track(makeSandbox(id, `module.exports={v:"${id}"};\n`));
        const r = await verifyIntegrity(scope, id, { lockfilePath: sb.lockfilePath });
        expect(r.status).toBe('current');
        expect(r.current).toBe(true);
        expect(r.actual).toBe(r.expected);
        expect(r.actual).toBe(sha256File(sb.artifactPath));
      });

      it('reports STALE when the artifact has drifted', async () => {
        const id = `vi-stale-${scope}`;
        const sb = track(makeSandbox(id, `module.exports={v:"${id}"};\n`));
        const before = sha256File(sb.artifactPath);
        fs.writeFileSync(sb.artifactPath, `module.exports={v:"${id}-DRIFT"};\n`, 'utf8');
        const r = await verifyIntegrity(scope, id, { lockfilePath: sb.lockfilePath });
        expect(r.status).toBe('stale');
        expect(r.current).toBe(false);
        expect(r.expected).toBe(before);
        expect(r.actual).toBe(sha256File(sb.artifactPath));
        expect(r.actual).not.toBe(r.expected);
      });

      it('reports NOT-INSTALLED when the id is absent from the lockfile', async () => {
        const id = `vi-ni-${scope}`;
        const sb = track(makeSandbox(id, `module.exports={};\n`));
        const r = await verifyIntegrity(scope, 'no-such-ext', { lockfilePath: sb.lockfilePath });
        expect(r.status).toBe('not-installed');
        expect(r.current).toBe(false);
        expect(r.expected).toBeNull();
      });

      it('reports NOT-INSTALLED when the lockfile does not exist', async () => {
        const r = await verifyIntegrity(scope, 'anything', {
          lockfilePath: path.join(os.tmpdir(), 'vi-missing-' + Math.random().toString(36).slice(2), 'x.lock'),
        });
        expect(r.status).toBe('not-installed');
      });

      it('reports UNRESOLVABLE when the artifact at source is gone', async () => {
        const id = `vi-unres-${scope}`;
        const sb = track(makeSandbox(id, `module.exports={};\n`));
        fs.rmSync(sb.artifactPath);
        const r = await verifyIntegrity(scope, id, { lockfilePath: sb.lockfilePath });
        expect(r.status).toBe('unresolvable');
        expect(r.current).toBe(false);
        expect(r.error).toBeTruthy();
      });
    });
  }

  it('cross-scope parity: same (id, artifact) yields identical verdict regardless of scope', async () => {
    const id = 'vi-parity';
    const sb = track(makeSandbox(id, `module.exports={v:"${id}"};\n`));
    const results = [];
    for (const scope of SCOPES) {
      results.push(await verifyIntegrity(scope, id, { lockfilePath: sb.lockfilePath }));
    }
    const checksums = new Set(results.map((r) => r.actual));
    expect(checksums.size).toBe(1);
    expect(results.every((r) => r.status === 'current')).toBe(true);
  });
});
