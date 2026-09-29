/**
 * apps/sox/src/verify-artifact.bl-cd1fe520.spec.ts
 *
 * BL-cd1fe520 — post-restart artifact verification compared a BARE hex digest
 * against the lockfile checksum with `===`. Every lock writer (install()'s
 * computeChecksum, and since BL-cd1fe520 the declarative/host-placement writers
 * too) records `sha256:<hex>`, so a correctly restarted consumer could never
 * verify: `upgrade`'s rolling restart always ended in `restart-mismatch` /
 * `backend-restart-mismatch`. Both forms must be accepted, and a real mismatch
 * must still be reported.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as verifyArtifact from './verify-artifact.js';

const { verifyRunningArtifact } = verifyArtifact;

let base: string;
let artifactPath: string;
let lockfilePath: string;

function hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function writeFixture(checksum: string): void {
  fs.writeFileSync(lockfilePath, JSON.stringify({
    lockfileVersion: 2,
    resolved: { 'memory-server': { source: `file://${artifactPath}`, checksum, resolved_at: new Date().toISOString() } },
  }));
  fs.writeFileSync(path.join(base, 'runtime.json'), JSON.stringify({
    version: 1,
    scope: 'user',
    startedAt: new Date().toISOString(),
    entries: [{
      key: 'memory-server', id: 'memory-server', type: 'mcp-server', scope: 'user',
      source: `file://${artifactPath}`, pid: 1234, running: true, activatedAt: new Date().toISOString(),
    }],
  }));
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-artifact-cd1fe520-'));
  artifactPath = path.join(base, 'index.js');
  fs.writeFileSync(artifactPath, 'console.log("restarted artifact");\n');
  lockfilePath = path.join(base, 'lockfile.json');
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('BL-cd1fe520 — verifyRunningArtifact accepts the sha256:<hex> checksum every lock writer records', () => {
  it('a sha256:-prefixed lock checksum that matches the running artifact verifies ok', async () => {
    writeFixture(`sha256:${hex(fs.readFileSync(artifactPath))}`);
    const result = await verifyRunningArtifact('memory-server', lockfilePath);
    expect(result).toEqual({ ok: true });
  });

  it('a bare-hex lock checksum (hand-written/legacy) still verifies ok', async () => {
    writeFixture(hex(fs.readFileSync(artifactPath)));
    expect(await verifyRunningArtifact('memory-server', lockfilePath)).toEqual({ ok: true });
  });

  it('a sha256:-prefixed checksum for different bytes is still a real mismatch', async () => {
    writeFixture(`sha256:${'0'.repeat(64)}`);
    const result = await verifyRunningArtifact('memory-server', lockfilePath);
    expect(result.ok).toBe(false);
  });

  it('normalizeSha256 is case- and prefix-insensitive', () => {
    const { normalizeSha256 } = verifyArtifact as unknown as { normalizeSha256: (s: string) => string };
    expect(typeof normalizeSha256).toBe('function');
    expect(normalizeSha256('sha256:ABCDEF')).toBe('abcdef');
    expect(normalizeSha256('abcdef')).toBe('abcdef');
  });
});
