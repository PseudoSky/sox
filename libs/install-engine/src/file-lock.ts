/**
 * libs/install-engine/src/file-lock.ts — cross-process O_EXCL lock file with
 * race-free stale takeover (ADR-0004 §D5/§D6 "ownership-lock").
 *
 * WHY: `OwnershipIndex.save()` is a read → merge → rename → verify cycle over a
 * union-merged file. The unique-temp + atomic rename (atomic-write.ts) removes the
 * TORN-file class but cannot remove the LOST-UPDATE class: two processes that both
 * read the same snapshot each publish a whole file, and the second rename silently
 * discards the first's record — even though each one's post-rename verify passes.
 * Serializing the cycle with this lock closes that gap.
 *
 * Mechanism:
 *   - Acquire: `openSync(lock, 'wx', 0o600)` (O_EXCL) + ONE `writeSync` of
 *     `{pid, token, startedAtMs}`. EEXIST ⇒ inspect the holder.
 *   - Stale holder (reclaimable) when ANY of:
 *       a) its pid is dead (`process.kill(pid, 0)` → ESRCH; EPERM means alive);
 *       b) the content is empty/unparseable AND the file mtime is older than
 *          `emptyStaleMs` (2s) — a fresh empty file is a holder between `open`
 *          and `write`, so it is waited on, never stolen;
 *       c) the lock is older than the hard ceiling (30s) even with a live pid
 *          (pid reuse / wedged holder).
 *   - Takeover never exposes a window in which a LIVE lock is absent. Reclaimers
 *     first serialize on a tiny O_EXCL guard (`<lock>.reap`, held for microseconds,
 *     itself reclaimed only by pid-dead / age rules). Inside the guard the lock is
 *     RE-INSPECTED; only if it is still stale is it moved aside with
 *     `rename(lock → lock.stale.<ownToken>)`, re-read and compared with what was
 *     inspected, then unlinked. Because every removal of a stale lock goes through
 *     the guard, a reclaimer that inspected a dead holder can never delete the
 *     fresh lock that another reclaimer's winner has since created (the failure
 *     mode of a bare inspect-then-rename).
 *   - Release (finally): unlink only if the lock file still carries OUR token, so
 *     a holder whose lock was taken over never deletes the new holder's lock.
 *   - Backoff: synchronous `Atomics.wait`, 5ms doubling to a 50ms cap + jitter.
 *
 * Leaf module: node builtins only. Every catch either handles a specific errno
 * and rethrows everything else, or rethrows — there are no swallowed errors.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Thrown when the lock could not be acquired within `timeoutMs`. */
export class OwnershipLockTimeoutError extends Error {
  readonly lockPath: string;
  /** pid recorded in the lock we were waiting on, when it could be read. */
  readonly holderPid: number | undefined;
  constructor(lockPath: string, holderPid: number | undefined, timeoutMs: number) {
    super(
      `[ownership-lock] timed out after ${timeoutMs}ms waiting for ${lockPath}` +
      (holderPid !== undefined ? ` (held by live pid ${holderPid})` : '') +
      ` — another process is mid-way through an ownership write`,
    );
    // NOT 'OwnershipConflictError': withReconciledRetry must not retry this.
    this.name = 'OwnershipLockTimeoutError';
    this.lockPath = lockPath;
    this.holderPid = holderPid;
  }
}

export interface FileLockOptions {
  /** Give up acquiring after this long (default 10_000). */
  timeoutMs?: number;
  /** Empty/unparseable lock content is stale once its mtime is older than this (default 2_000). */
  emptyStaleMs?: number;
  /** A lock older than this is stale even if its pid is alive (default 30_000). */
  hardCeilingMs?: number;
}

/** The shape every lock runner (real or test-injected) satisfies. */
export type LockRunner = <T>(lockPath: string, fn: () => T) => T;

interface LockPayload {
  pid: number;
  token: string;
  startedAtMs: number;
}

type Holder =
  | { state: 'gone' }
  | { state: 'live'; pid: number | undefined }
  | { state: 'stale'; raw: string; mtimeMs: number };

const DEFAULTS = { timeoutMs: 10_000, emptyStaleMs: 2_000, hardCeilingMs: 30_000 } as const;
const BACKOFF_START_MS = 5;
const BACKOFF_CAP_MS = 50;

function errno(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e
    ? String((e as { code: unknown }).code)
    : undefined;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function parsePayload(raw: string): LockPayload | undefined {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    // Unparseable content is a classification input (⇒ empty/garbage rules), not an error.
    if (e instanceof SyntaxError) return undefined;
    throw e;
  }
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (
    typeof o['pid'] === 'number' && Number.isInteger(o['pid']) && o['pid'] > 0 &&
    typeof o['token'] === 'string' && typeof o['startedAtMs'] === 'number'
  ) {
    return { pid: o['pid'], token: o['token'], startedAtMs: o['startedAtMs'] };
  }
  return undefined;
}

/** true = process exists (or exists but is not ours: EPERM); false = ESRCH. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = errno(e);
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw e;
  }
}

/** Pure classification of a lock's observed (content, mtime). */
function classify(raw: string, mtimeMs: number, now: number, o: Required<FileLockOptions>): Holder {
  const payload = parsePayload(raw);
  if (payload === undefined) {
    return now - mtimeMs > o.emptyStaleMs
      ? { state: 'stale', raw, mtimeMs }
      : { state: 'live', pid: undefined };
  }
  if (!pidAlive(payload.pid)) return { state: 'stale', raw, mtimeMs };
  if (now - payload.startedAtMs > o.hardCeilingMs) return { state: 'stale', raw, mtimeMs };
  return { state: 'live', pid: payload.pid };
}

function inspect(lockPath: string, o: Required<FileLockOptions>): Holder {
  let raw: string;
  let mtimeMs: number;
  try {
    // stat first: if the file vanishes between the two calls we report 'gone'.
    mtimeMs = fs.statSync(lockPath).mtimeMs;
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (e) {
    if (errno(e) === 'ENOENT') return { state: 'gone' };
    throw e;
  }
  return classify(raw, mtimeMs, Date.now(), o);
}

/**
 * Remove `lockPath` if (and only if) it is still the stale content `seen`. Only
 * the rename winner proceeds; the renamed file is re-read and re-classified, and a
 * live lock that raced into the slot is restored (no-clobber `link`). Callers hold
 * the reap guard (or are reclaiming the guard itself), so the restore path is
 * reachable only by a pathological self-releasing holder (ceiling/empty cases).
 */
function moveAsideIfStale(lockPath: string, seen: { raw: string }, ownToken: string, o: Required<FileLockOptions>): void {
  const stalePath = `${lockPath}.stale.${ownToken}`;
  try {
    fs.renameSync(lockPath, stalePath);
  } catch (e) {
    if (errno(e) === 'ENOENT') return; // someone else already took it over
    throw e;
  }
  let raw: string;
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(stalePath).mtimeMs;
    raw = fs.readFileSync(stalePath, 'utf8');
  } catch (e) {
    if (errno(e) === 'ENOENT') return;
    throw e;
  }
  if (raw === seen.raw && classify(raw, mtimeMs, Date.now(), o).state === 'stale') {
    unlinkQuiet(stalePath);
    return;
  }
  // We displaced a DIFFERENT (fresh, live) lock that replaced the stale one between
  // our inspect and our rename. Put it back only if the slot is still free
  // (`link` is an atomic no-clobber); otherwise another process already holds the
  // lock and the displaced file is simply discarded — we keep waiting either way.
  try {
    fs.linkSync(stalePath, lockPath);
  } catch (e) {
    if (errno(e) !== 'EEXIST') throw e;
  }
  unlinkQuiet(stalePath);
}

/**
 * Reclaim a stale lock under the reap guard. Re-inspects after winning the guard
 * so a lock that was reclaimed-and-recreated by someone else is left alone.
 */
function reclaim(lockPath: string, ownToken: string, deadline: number, o: Required<FileLockOptions>): void {
  const reapPath = `${lockPath}.reap`;
  const reapPayload: LockPayload = { pid: process.pid, token: ownToken, startedAtMs: Date.now() };
  // The guard is held for microseconds: age it out fast and reclaim it by rename.
  const guardOpts: Required<FileLockOptions> = { ...o, emptyStaleMs: 1_000, hardCeilingMs: 2_000 };
  let backoff = 1;
  while (!tryCreate(reapPath, reapPayload)) {
    const g = inspect(reapPath, guardOpts);
    if (g.state === 'stale') {
      moveAsideIfStale(reapPath, g, ownToken, guardOpts);
      continue;
    }
    if (g.state === 'live' && Date.now() >= deadline) {
      throw new OwnershipLockTimeoutError(lockPath, g.pid, o.timeoutMs);
    }
    sleepSync(backoff);
    backoff = Math.min(backoff * 2, 10);
  }
  try {
    const h = inspect(lockPath, o);
    if (h.state === 'stale') moveAsideIfStale(lockPath, h, ownToken, o);
  } finally {
    release(reapPath, ownToken);
  }
}

function unlinkQuiet(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch (e) {
    if (errno(e) !== 'ENOENT') throw e;
  }
}

function tryCreate(lockPath: string, payload: LockPayload): boolean {
  let fd: number;
  try {
    fd = fs.openSync(lockPath, 'wx', 0o600);
  } catch (e) {
    const code = errno(e);
    if (code === 'EEXIST') return false;
    if (code === 'ENOENT') {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      return tryCreate(lockPath, payload);
    }
    throw e;
  }
  try {
    fs.writeSync(fd, JSON.stringify(payload));
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/** Unlink the lock only if it still carries our token. */
function release(lockPath: string, token: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (e) {
    if (errno(e) === 'ENOENT') return;
    throw e;
  }
  if (parsePayload(raw)?.token === token) unlinkQuiet(lockPath);
}

/**
 * Run `fn` while holding an exclusive cross-process lock at `lockPath`.
 * Synchronous (the ownership index API is synchronous). Throws
 * `OwnershipLockTimeoutError` if the lock cannot be acquired in `timeoutMs`.
 */
export function withFileLockSync<T>(lockPath: string, fn: () => T, opts: FileLockOptions = {}): T {
  const o: Required<FileLockOptions> = {
    timeoutMs: opts.timeoutMs ?? DEFAULTS.timeoutMs,
    emptyStaleMs: opts.emptyStaleMs ?? DEFAULTS.emptyStaleMs,
    hardCeilingMs: opts.hardCeilingMs ?? DEFAULTS.hardCeilingMs,
  };
  const token = crypto.randomBytes(12).toString('hex');
  const payload: LockPayload = { pid: process.pid, token, startedAtMs: Date.now() };
  const deadline = Date.now() + o.timeoutMs;
  let backoff = BACKOFF_START_MS;
  let lastHolderPid: number | undefined;

  for (;;) {
    if (tryCreate(lockPath, payload)) break;
    const holder = inspect(lockPath, o);
    if (holder.state === 'gone') continue; // freed between EEXIST and inspect: retry now
    if (holder.state === 'stale') {
      reclaim(lockPath, token, deadline, o);
      continue; // loop to O_EXCL; whoever wins that create holds the lock
    }
    lastHolderPid = holder.pid;
    if (Date.now() >= deadline) throw new OwnershipLockTimeoutError(lockPath, lastHolderPid, o.timeoutMs);
    sleepSync(backoff + Math.floor(Math.random() * backoff));
    backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
  }

  try {
    return fn();
  } finally {
    release(lockPath, token);
  }
}
