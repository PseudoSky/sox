/**
 * apps/sox/src/verify-artifact.ts — post-restart artifact verification.
 *
 * Extracted from apps/sox/src/main.ts so it can be imported and unit-tested in
 * isolation. main.ts has a module-top-level `void main()` side effect (see its
 * header comment on BL-404/BL-568) — importing main.ts anywhere (including from
 * a test) runs the whole CLI. This function has no such side effect and is safe
 * to import directly.
 *
 * BUG-SOX-VERIFYARTIFACT-PASSES-FILEURL-TO-FS-001: the runtime record's
 * `entry.source` is a lockfile-style source string, which for a locally-built
 * extension is a `file://` URL (see libs/install-engine/src/install.ts's own
 * `source.startsWith('file://') ? source.slice('file://'.length) : source`
 * convention, used at 4+ call sites there — e.g. fetchArtifact). Handing that
 * URL string straight to `fs.readFileSync` fails with ENOENT because there is
 * no such *path* — the string is a URL, not a path, even though the referenced
 * file exists. Every restarted consumer with a `file://` source therefore
 * reported a false `backend-restart-mismatch` / `restart-mismatch`, and the
 * check could never actually confirm a real mismatch either, since it never
 * got past the misdirected read.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { getRuntimeFilePath, getRuntimeRecord } from '@adhd/sox-host-runtime';
import { loadLockfile } from '@adhd/sox-install-engine';

/**
 * Normalise a lockfile/runtime-entry `source` string into a real filesystem
 * path. Sources are either a `file://` URL (local/dev installs — see
 * install-engine's `fetchArtifact`) or a bare absolute path (older runtime
 * records / non-file sources already resolved upstream). Mirrors the
 * `slice('file://'.length)` convention install-engine already uses in four
 * places, rather than reaching for `url.fileURLToPath` and risking a subtly
 * different normalisation (percent-decoding, drive-letter handling) from the
 * rest of the codebase.
 */
export function resolveArtifactFsPath(source: string): string {
  return source.startsWith('file://') ? source.slice('file://'.length) : source;
}

/**
 * Verify that the running process for (extId, scope) loaded the artifact whose
 * sha256 matches the lockfile's expected checksum. Reads the runtime record to
 * find the entrypoint file path, then sha256s the file on disk and compares.
 *
 * Returns { ok: true } on match, { ok: false, detail } on mismatch or error.
 */
export async function verifyRunningArtifact(
  extId: string, lockfilePath: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  // 1. Get expected checksum from lockfile.
  const lock = loadLockfile(lockfilePath);
  if (!lock) return { ok: false, detail: 'no lockfile' };
  const lockKey = Object.keys(lock.resolved).find((k) => k === extId || k.startsWith(`${extId}@`));
  if (!lockKey) return { ok: false, detail: 'not in lockfile' };
  const expected = lock.resolved[lockKey]!.checksum;
  if (!expected) return { ok: false, detail: 'no checksum in lockfile' };

  // 2. Find the running process's entrypoint from the runtime record.
  const runtimeFilePath = getRuntimeFilePath(lockfilePath);
  const record = getRuntimeRecord(runtimeFilePath);
  const entry = record?.entries?.find((e) => e.id === extId || e.key === extId);
  if (!entry) return { ok: false, detail: 'no runtime entry' };
  const artifactSource = entry.source;
  if (!artifactSource) return { ok: false, detail: 'no source in runtime entry' };

  // 3. Sha256 the artifact file the process loaded. BUG-SOX-VERIFYARTIFACT-
  // PASSES-FILEURL-TO-FS-001: normalise a `file://` source to a real fs path
  // before reading — fs.readFileSync does not understand URL strings.
  const artifactPath = resolveArtifactFsPath(artifactSource);
  let actual: string;
  try {
    const data = fs.readFileSync(artifactPath);
    actual = crypto.createHash('sha256').update(data).digest('hex');
  } catch (e) {
    return { ok: false, detail: `cannot read artifact ${artifactPath}: ${String(e)}` };
  }

  if (actual === expected) return { ok: true };
  return { ok: false, detail: `entrypoint sha256 ${actual.slice(0, 19)}… ≠ expected ${expected.slice(0, 19)}…` };
}
