/**
 * apps/sox/src/verify-artifact.bug-sox-verifyartifact-passes-fileurl-to-fs-001.spec.ts
 *
 * BUG-SOX-VERIFYARTIFACT-PASSES-FILEURL-TO-FS-001 — RED->GREEN regression.
 *
 * verifyRunningArtifact() read the running process's entrypoint from the
 * runtime record's `entry.source`, which — for a local/dev install — is a
 * `file://` URL (the same convention install-engine's fetchArtifact already
 * handles by stripping the scheme before touching fs). The buggy version
 * handed that URL string straight to fs.readFileSync, which fails with ENOENT
 * even though the referenced file exists on disk, because a `file://` URL is
 * not a filesystem path.
 *
 * Consequence: every restarted consumer with a `file://` lockfile source
 * reported a false `backend-restart-mismatch` / `restart-mismatch`, and the
 * check could never confirm a REAL mismatch either — it never got past the
 * misdirected read. This spec covers both halves of the acceptance criteria:
 *
 *   1. A file:// source that matches the lockfile checksum verifies ok:true.
 *   2. A file:// source that does NOT match the lockfile checksum still
 *      reports a real ok:false mismatch (proves the fix didn't just swallow
 *      the error and turn a permanent false-negative into a permanent
 *      false-positive).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveArtifactFsPath, verifyRunningArtifact } from './verify-artifact.js';

let base: string;
let artifactPath: string;
let lockfilePath: string;
let runtimeFilePath: string;

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function writeLockfile(checksum: string): void {
  fs.writeFileSync(
    lockfilePath,
    JSON.stringify({
      lockfileVersion: 2,
      resolved: {
        'memory-server': {
          source: `file://${artifactPath}`,
          checksum,
          resolved_at: new Date().toISOString(),
        },
      },
    }),
  );
}

function writeRuntimeRecord(source: string): void {
  fs.writeFileSync(
    runtimeFilePath,
    JSON.stringify({
      version: 1,
      scope: 'user',
      startedAt: new Date().toISOString(),
      entries: [
        {
          key: 'memory-server',
          id: 'memory-server',
          type: 'mcp-server',
          scope: 'user',
          source,
          pid: 1234,
          running: true,
          activatedAt: new Date().toISOString(),
        },
      ],
    }),
  );
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-artifact-'));
  artifactPath = path.join(base, 'index.js');
  fs.writeFileSync(artifactPath, 'console.log("real built artifact");\n');
  lockfilePath = path.join(base, 'lockfile.json');
  runtimeFilePath = path.join(base, 'runtime.json');
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('BUG-SOX-VERIFYARTIFACT-PASSES-FILEURL-TO-FS-001', () => {
  it('resolveArtifactFsPath strips the file:// scheme so fs can read it', () => {
    const url = `file://${artifactPath}`;
    const resolved = resolveArtifactFsPath(url);
    expect(resolved).toBe(artifactPath);
    // This is the exact operation that ENOENT'd on the un-normalised URL —
    // prove it actually reads now.
    expect(() => fs.readFileSync(resolved)).not.toThrow();
  });

  it('verifies ok:true for a file:// runtime source whose checksum matches the lockfile', async () => {
    const checksum = sha256(fs.readFileSync(artifactPath));
    writeLockfile(checksum);
    writeRuntimeRecord(`file://${artifactPath}`);

    const result = await verifyRunningArtifact('memory-server', lockfilePath);

    expect(result.ok).toBe(true);
  });

  it('still reports a real mismatch for a file:// runtime source with the WRONG checksum', async () => {
    writeLockfile('0'.repeat(64)); // deliberately wrong checksum
    writeRuntimeRecord(`file://${artifactPath}`);

    const result = await verifyRunningArtifact('memory-server', lockfilePath);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toContain('entrypoint sha256');
      expect(result.detail).toContain('≠ expected');
      // Not the ENOENT class of failure — this is a genuine content mismatch.
      expect(result.detail).not.toContain('cannot read artifact');
      expect(result.detail).not.toContain('ENOENT');
    }
  });
});
