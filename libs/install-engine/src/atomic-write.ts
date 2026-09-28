/**
 * libs/install-engine/src/atomic-write.ts — one parallel-safe publish primitive
 * (D-B / substrate DESIGN §2 D3, invariant B-I1).
 *
 * The install/deploy layer writes plain files (`ownership.json`, `extensions.lock`,
 * host file-drops). Correctness of such a write is NOT the lock's job — it is a
 * unique per-process temp on the SAME filesystem, written O_EXCL, fsynced, then
 * ONE atomic `rename(2)`. A reader therefore sees either the whole old file or the
 * whole new file, never a torn half. An advisory lock (if a caller adds one) may
 * only bound duplicate work; a concurrent NON-COOPERATIVE writer cannot corrupt
 * the result (ADR-0012 parallel-process invariant; the rename is the mechanism).
 *
 * History: two fixed-`.tmp` publishers raced (`writeOwnershipAtomic` and
 * `writeLockfileAtomic`); a partial flip would leave one temp racing, so BOTH were
 * routed through here in the same change.
 *
 * Leaf-ish module: node builtins only. No soxe imports (ownership.ts imports THIS,
 * so this must not import ownership back — the retry matcher keys on the error
 * NAME, not the class).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Monotonic per-process counter making each temp name unique even within one tick. */
let atomicCounter = 0;

/**
 * Publish `data` at `filePath` atomically: unique O_EXCL temp on the same fs,
 * fsync, one rename. Never leaves a fixed-`.tmp` name behind.
 *
 * Temp name: `${filePath}.${process.pid}.${counter++}.${randomBytes(6).hex}.tmp`
 * The pid + counter + random triple guarantees a collision is impossible by
 * construction (two installs in the same fs cannot both create the same temp),
 * so `openSync(tmp, 'wx')` (O_EXCL) never has to lose a race — it is a proof,
 * not a guard.
 *
 * On any throw the temp is best-effort unlinked; the destination is left
 * untouched (a failed write never half-publishes).
 */
export function atomicWriteFileSync(filePath: string, data: string | Buffer): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const rand = crypto.randomBytes(6).toString('hex');
  const tmp = `${filePath}.${process.pid}.${atomicCounter++}.${rand}.tmp`;

  let fd: number | undefined;
  try {
    // 'wx' === O_WRONLY | O_CREAT | O_EXCL — fails if the temp already exists.
    fd = fs.openSync(tmp, 'wx', 0o644);
    fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // The rename is the correctness mechanism: atomic on the same filesystem.
    fs.renameSync(tmp, filePath);
    fsyncDir(dir);
  } catch (e) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* fd already gone in the failure path */ }
    }
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch { /* best-effort cleanup — the fixed-name temp never existed */ }
    throw e;
  }
}

/**
 * fsync a directory so a rename is durable across power loss. Best-effort:
 * some filesystems/platforms reject `fsync` on a directory fd; a failure here
 * degrades durability, never correctness.
 */
function fsyncDir(dir: string): void {
  let dfd: number | undefined;
  try {
    dfd = fs.openSync(dir, 'r');
    fs.fsyncSync(dfd);
  } catch { /* directory fsync unsupported on this platform — best-effort */ }
  finally {
    if (dfd !== undefined) {
      try { fs.closeSync(dfd); } catch { /* already closed */ }
    }
  }
}

/**
 * Run `fn`, retrying it while it throws an `OwnershipConflictError` (an external
 * writer moved the file between our read and our rename). This resolves a *lost
 * update* between two writers (AC1) — it does NOT provide atomicity, which stays
 * entirely in `atomicWriteFileSync`. Matched by error NAME so this leaf module
 * need not import ownership.ts (no cycle).
 *
 * @param filePath  For error context only.
 * @param fn        The re-load → merge → save unit; must be idempotent on retry.
 * @param opts.attempts  Bounded retry budget (default 16). The merge is
 *   monotone (a grow-set union on read), so this terminates in practice.
 */
export function withReconciledRetry<T>(
  filePath: string,
  fn: () => T,
  opts: { attempts?: number } = {},
): T {
  const attempts = opts.attempts ?? 16;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (e) {
      if (e instanceof Error && e.name === 'OwnershipConflictError') {
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(
        `[atomic-write] withReconciledRetry exhausted ${attempts} attempts on ${filePath}`,
      );
}
