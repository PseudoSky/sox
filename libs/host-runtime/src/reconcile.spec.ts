/**
 * reconcile.spec.ts — Slice 4 of docs/spec/service-lifecycle.md (§10.2/§14).
 *
 * The safe-by-construction classification behind `soxe doctor --reconcile`:
 *   - accounted pids are never reaped;
 *   - the live writer-socket holder is never reaped;
 *   - an unattributable live socket ⇒ reap NOTHING (report + skip);
 *   - a token-matched process with zero fds on the live socket (the BL-170
 *     spawn-race-loser zombie) IS reaped;
 *   - with no live socket: a lone unaccounted process is report-only; a ≥2 set
 *     is handed to the §5.3 duplicate heal.
 *
 * socketOwnerPids is exercised against a FAKE lsof exec — no real process table.
 *
 * BL-201: sweepProxyBackendLocks — dead-holder spawn-lock debris sweep.
 *   All fs ops and pid checks are injected — no real filesystem or process table.
 *   A real-filesystem smoke section uses mkdtemp sandboxes.
 */

import * as nodefs from 'node:fs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  classifyReconcileTargets,
  LOCK_DEBRIS_TTL_MS,
  socketOwnerPids,
  sweepProxyBackendLocks,
  type LockSweepFs,
  type LsofExec,
  type PidAliveCheck,
  type ReconcileMatch,
} from './reconcile.js';

const SOCK = '/tmp/sox-test/proxy-memory.sock';

function m(pid: number, ppid = 1): ReconcileMatch {
  return { pid, ppid, orphaned: ppid === 1 };
}

function fakeLsof(stdout: string, code = 0): LsofExec {
  return () => ({ code, stdout });
}

describe('socketOwnerPids — lsof -F pn attribution (injectable exec)', () => {
  it('attributes the holder pids for an exact socket-path NAME match', () => {
    const out = [
      'p100', 'n/some/other.sock',
      'p4373', `n${SOCK}`,
      'p9999', 'n->0xdeadbeef',
      '',
    ].join('\n');
    expect(socketOwnerPids(SOCK, { exec: fakeLsof(out) })).toEqual([4373]);
  });

  it('matches the Linux "path type=STREAM" decorated NAME form', () => {
    const out = ['p777', `n${SOCK} type=STREAM`, ''].join('\n');
    expect(socketOwnerPids(SOCK, { exec: fakeLsof(out) })).toEqual([777]);
  });

  it('never prefix-matches a LONGER path (…sock2 is not …sock)', () => {
    const out = ['p555', `n${SOCK}2`, ''].join('\n');
    expect(socketOwnerPids(SOCK, { exec: fakeLsof(out) })).toEqual([]);
  });

  it('collects multiple holders (listener + connected shims)', () => {
    const out = ['p10', `n${SOCK}`, 'p20', 'n/tmp/x', `n${SOCK}`, ''].join('\n');
    expect(socketOwnerPids(SOCK, { exec: fakeLsof(out) })?.sort()).toEqual([10, 20]);
  });

  it('returns null (ATTRIBUTION FAILED) when lsof produces no output', () => {
    expect(socketOwnerPids(SOCK, { exec: fakeLsof('', 1) })).toBeNull();
    expect(socketOwnerPids('', {})).toBeNull();
  });

  it('tolerates lsof exit 1 with useful output (partial fd read failures)', () => {
    const out = ['p42', `n${SOCK}`, ''].join('\n');
    expect(socketOwnerPids(SOCK, { exec: fakeLsof(out, 1) })).toEqual([42]);
  });
});

describe('classifyReconcileTargets — safe-by-construction rules', () => {
  it('rule 1: accounted pids are skipped, never reaped', () => {
    const plan = classifyReconcileTargets({
      matches: [m(100), m(200)],
      accountedPids: new Set([100]),
      socketLive: true,
      socketPids: [200],
    });
    expect(plan.reap).toEqual([]);
    expect(plan.skip).toEqual([
      { match: m(100), reason: 'accounted' },
      { match: m(200), reason: 'writer-socket-holder' },
    ]);
  });

  it('rule 2 + 4: the socket holder is skipped; the zero-fd zombie beside it is reaped (BL-170)', () => {
    // Today's incident shape: writer 43731 owns the socket; zombie 43740 matches
    // the same entrypoint token with zero socket fds.
    const plan = classifyReconcileTargets({
      matches: [m(43731), m(43740)],
      accountedPids: new Set(),
      socketLive: true,
      socketPids: [43731],
    });
    expect(plan.skip).toEqual([{ match: m(43731), reason: 'writer-socket-holder' }]);
    expect(plan.reap).toEqual([m(43740)]);
    expect(plan.duplicateSetNoSocket).toEqual([]);
  });

  it('rule 3: a live socket with FAILED attribution reaps NOTHING (null holders)', () => {
    const plan = classifyReconcileTargets({
      matches: [m(1), m(2)],
      accountedPids: new Set(),
      socketLive: true,
      socketPids: null,
    });
    expect(plan.reap).toEqual([]);
    expect(plan.skip.every((s) => s.reason === 'unattributable-socket-holder')).toBe(true);
    expect(plan.skip.length).toBe(2);
  });

  it('rule 3: a live socket with an EMPTY holder set (parse missed the holder) reaps NOTHING', () => {
    const plan = classifyReconcileTargets({
      matches: [m(1)],
      accountedPids: new Set(),
      socketLive: true,
      socketPids: [],
    });
    expect(plan.reap).toEqual([]);
    expect(plan.skip).toEqual([{ match: m(1), reason: 'unattributable-socket-holder' }]);
  });

  it('rule 5: no socket + a LONE unaccounted process ⇒ report-only, never guess-kill', () => {
    const plan = classifyReconcileTargets({
      matches: [m(300, 500)],
      accountedPids: new Set(),
      socketLive: false,
      socketPids: null,
    });
    expect(plan.reap).toEqual([]);
    expect(plan.skip).toEqual([{ match: m(300, 500), reason: 'single-unaccounted-report-only' }]);
    expect(plan.duplicateSetNoSocket).toEqual([]);
  });

  it('rule 5: no socket + a ≥2 unaccounted set ⇒ handed to the §5.3 duplicate heal', () => {
    const plan = classifyReconcileTargets({
      matches: [m(300), m(301), m(302)],
      accountedPids: new Set([302]),
      socketLive: false,
      socketPids: null,
    });
    expect(plan.reap).toEqual([]); // this module never reaps duplicates itself
    expect(plan.duplicateSetNoSocket).toEqual([m(300), m(301)]);
    expect(plan.skip).toEqual([{ match: m(302), reason: 'accounted' }]);
  });

  it('no matches ⇒ an empty, idempotent plan', () => {
    const plan = classifyReconcileTargets({
      matches: [],
      accountedPids: new Set(),
      socketLive: false,
      socketPids: null,
    });
    expect(plan).toEqual({ reap: [], skip: [], duplicateSetNoSocket: [] });
  });
});

// ─── BL-201: sweepProxyBackendLocks ──────────────────────────────────────────────

/**
 * Minimal in-memory fake filesystem for lock-sweep tests.
 *
 * `files` maps absolute path → `{ content, mtimeMs? }`.
 * When `mtimeMs` is omitted the file is treated as definitively OLD
 * (LOCK_DEBRIS_TTL_MS + 1 000 ms ago) to keep tests that only care about pid
 * liveness from also needing to set timestamps.
 */
function makeFakeFs(
  files: Record<string, { content: string; mtimeMs?: number }>,
  dir: string,
): LockSweepFs {
  return {
    existsSync: (d) => d === dir,
    readdirSync: (d) => {
      if (d !== dir) throw new Error(`readdirSync: unexpected dir ${d}`);
      return Object.keys(files).map((p) => p.replace(`${dir}/`, ''));
    },
    statSync: (filePath) => {
      const entry = files[filePath];
      if (!entry) throw new Error(`statSync: not found: ${filePath}`);
      return { mtimeMs: entry.mtimeMs ?? Date.now() - LOCK_DEBRIS_TTL_MS - 1_000 };
    },
    readFileSync: (filePath, _enc) => {
      const entry = files[filePath];
      if (!entry) throw new Error(`readFileSync: not found: ${filePath}`);
      return entry.content;
    },
    unlinkSync: (filePath) => {
      if (!files[filePath]) throw new Error(`unlinkSync: not found: ${filePath}`);
      delete files[filePath];
    },
  };
}

const LOCK_DIR = '/run/supervisors';
const OLD_MTIME = Date.now() - LOCK_DEBRIS_TTL_MS - 5_000; // definitively old
const FRESH_MTIME = Date.now() - 1_000;                     // definitively fresh (< TTL)

const deadPid: PidAliveCheck = () => false;

describe('sweepProxyBackendLocks — BL-201 dead-holder debris sweep (injected fs + pid)', () => {
  it('dead pid + old file → swept', () => {
    const lockFile = `${LOCK_DIR}/proxy-backend-deadbeef.lock`;
    const files: Record<string, { content: string; mtimeMs?: number }> = {
      [lockFile]: { content: JSON.stringify({ pid: 99999, t: OLD_MTIME, key: 'k' }), mtimeMs: OLD_MTIME },
    };
    const logs: string[] = [];
    const result = sweepProxyBackendLocks(LOCK_DIR, {
      fsSeal: makeFakeFs(files, LOCK_DIR),
      pidAlive: deadPid,
      log: (msg) => logs.push(msg),
    });
    expect(result.swept).toBe(1);
    expect(result.kept).toBe(0);
    expect(result.scanned).toBe(1);
    expect(result.entries[0]?.action).toBe('swept');
    expect(logs.some((l) => l.includes('swept'))).toBe(true);
    // File should be gone from the fake fs after the unlink.
    expect(files[lockFile]).toBeUndefined();
  });

  it('dead pid + fresh file (< TTL) → kept (mid-reclaim guard)', () => {
    const lockFile = `${LOCK_DIR}/proxy-backend-freshtest.lock`;
    const files: Record<string, { content: string; mtimeMs?: number }> = {
      [lockFile]: { content: JSON.stringify({ pid: 99999, t: FRESH_MTIME, key: 'k' }), mtimeMs: FRESH_MTIME },
    };
    const logs: string[] = [];
    const result = sweepProxyBackendLocks(LOCK_DIR, {
      fsSeal: makeFakeFs(files, LOCK_DIR),
      pidAlive: deadPid,
      log: (msg) => logs.push(msg),
    });
    expect(result.swept).toBe(0);
    expect(result.kept).toBe(1);
    expect(result.entries[0]?.action).toBe('kept');
    // Log should mention TTL to explain the keep decision.
    expect(logs.some((l) => l.includes('KEEP') && l.includes('TTL'))).toBe(true);
    // File must still exist.
    expect(files[lockFile]).toBeDefined();
  });

  it('live pid + old file → kept (holder is still running, regardless of age)', () => {
    const livePid = process.pid; // guaranteed alive for the duration of this test
    const lockFile = `${LOCK_DIR}/proxy-backend-aabbccdd.lock`;
    const files: Record<string, { content: string; mtimeMs?: number }> = {
      [lockFile]: { content: JSON.stringify({ pid: livePid, t: OLD_MTIME, key: 'k' }), mtimeMs: OLD_MTIME },
    };
    const logs: string[] = [];
    const result = sweepProxyBackendLocks(LOCK_DIR, {
      fsSeal: makeFakeFs(files, LOCK_DIR),
      pidAlive: (pid) => pid === livePid, // returns true only for the current process
      log: (msg) => logs.push(msg),
    });
    expect(result.swept).toBe(0);
    expect(result.kept).toBe(1);
    expect(result.entries[0]?.action).toBe('kept');
    expect(logs.some((l) => l.includes('alive'))).toBe(true);
    expect(files[lockFile]).toBeDefined();
  });

  it('unparseable payload + old file → swept (cannot validate as live)', () => {
    const lockFile = `${LOCK_DIR}/proxy-backend-garbage00.lock`;
    const files: Record<string, { content: string; mtimeMs?: number }> = {
      [lockFile]: { content: 'NOT-JSON}{{{', mtimeMs: OLD_MTIME },
    };
    const logs: string[] = [];
    const result = sweepProxyBackendLocks(LOCK_DIR, {
      fsSeal: makeFakeFs(files, LOCK_DIR),
      pidAlive: deadPid,
      log: (msg) => logs.push(msg),
    });
    expect(result.swept).toBe(1);
    expect(result.entries[0]?.action).toBe('swept');
    // 'unparseable' appears in the reason string.
    expect(result.entries[0]?.reason).toMatch(/unparseable/);
    expect(logs.some((l) => l.includes('swept'))).toBe(true);
    expect(files[lockFile]).toBeUndefined();
  });

  it('dry-run: reports WOULD sweep without unlinking', () => {
    const lockFile = `${LOCK_DIR}/proxy-backend-dryruntest.lock`;
    const files: Record<string, { content: string; mtimeMs?: number }> = {
      [lockFile]: { content: JSON.stringify({ pid: 99999, t: OLD_MTIME, key: 'k' }), mtimeMs: OLD_MTIME },
    };
    const logs: string[] = [];
    const result = sweepProxyBackendLocks(LOCK_DIR, {
      dryRun: true,
      fsSeal: makeFakeFs(files, LOCK_DIR),
      pidAlive: deadPid,
      log: (msg) => logs.push(msg),
    });
    expect(result.swept).toBe(1);
    expect(result.entries[0]?.action).toBe('would-sweep');
    expect(logs.some((l) => l.includes('WOULD sweep'))).toBe(true);
    // File must NOT have been deleted — dry-run never calls unlinkSync.
    expect(files[lockFile]).toBeDefined();
  });

  it('empty lock dir → zero scanned, zero swept, no error', () => {
    const fsSeal: LockSweepFs = {
      existsSync: () => true,
      readdirSync: () => [],
      statSync: () => { throw new Error('should not be called'); },
      readFileSync: () => { throw new Error('should not be called'); },
      unlinkSync: () => { throw new Error('should not be called'); },
    };
    const result = sweepProxyBackendLocks(LOCK_DIR, { fsSeal, pidAlive: deadPid });
    expect(result.scanned).toBe(0);
    expect(result.swept).toBe(0);
    expect(result.kept).toBe(0);
    expect(result.entries).toEqual([]);
  });

  it('non-matching filenames in the dir are silently ignored', () => {
    // Only files matching /^proxy-backend-[0-9a-f]+\.lock$/ are scanned.
    const fsSeal: LockSweepFs = {
      existsSync: () => true,
      readdirSync: () => [
        'proxy-backend-.lock',        // invalid — no hex digits
        'proxy-backendXYZ.lock',      // invalid prefix
        'runtime.json',
        'some-backend-deadbeef.lock', // wrong prefix
        'proxy-backend-deadbeef.log', // wrong extension
      ],
      statSync: () => { throw new Error('should not be called'); },
      readFileSync: () => { throw new Error('should not be called'); },
      unlinkSync: () => { throw new Error('should not be called'); },
    };
    const result = sweepProxyBackendLocks(LOCK_DIR, { fsSeal, pidAlive: deadPid });
    expect(result.scanned).toBe(0);
    expect(result.entries).toEqual([]);
  });

  it('missing lock dir → zero scanned, no error', () => {
    const fsSeal: LockSweepFs = {
      existsSync: () => false,
      readdirSync: () => { throw new Error('should not be called'); },
      statSync: () => { throw new Error('should not be called'); },
      readFileSync: () => { throw new Error('should not be called'); },
      unlinkSync: () => { throw new Error('should not be called'); },
    };
    const result = sweepProxyBackendLocks(LOCK_DIR, { fsSeal, pidAlive: deadPid });
    expect(result.scanned).toBe(0);
    expect(result.swept).toBe(0);
  });

  it('multiple files — mixed dead/live/fresh dispositions in one pass', () => {
    const livePid = process.pid;
    const lockA = `${LOCK_DIR}/proxy-backend-aaaaaaaa.lock`; // dead + old → sweep
    const lockB = `${LOCK_DIR}/proxy-backend-bbbbbbbb.lock`; // dead + fresh → keep
    const lockC = `${LOCK_DIR}/proxy-backend-cccccccc.lock`; // live + old → keep
    const files: Record<string, { content: string; mtimeMs?: number }> = {
      [lockA]: { content: JSON.stringify({ pid: 11111, t: OLD_MTIME, key: 'a' }), mtimeMs: OLD_MTIME },
      [lockB]: { content: JSON.stringify({ pid: 22222, t: FRESH_MTIME, key: 'b' }), mtimeMs: FRESH_MTIME },
      [lockC]: { content: JSON.stringify({ pid: livePid, t: OLD_MTIME, key: 'c' }), mtimeMs: OLD_MTIME },
    };
    const result = sweepProxyBackendLocks(LOCK_DIR, {
      fsSeal: makeFakeFs(files, LOCK_DIR),
      pidAlive: (pid) => pid === livePid,
    });
    expect(result.scanned).toBe(3);
    expect(result.swept).toBe(1);
    expect(result.kept).toBe(2);
    const actions = result.entries.map((e) => e.action).sort();
    expect(actions).toEqual(['kept', 'kept', 'swept']);
    // lockA swept; lockB and lockC kept.
    expect(files[lockA]).toBeUndefined();
    expect(files[lockB]).toBeDefined();
    expect(files[lockC]).toBeDefined();
  });
});

// ─── Real-filesystem integration smoke (mkdtemp sandbox — no injected fs) ────────

describe('sweepProxyBackendLocks — real-filesystem smoke (mkdtemp sandbox)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sox-lock-sweep-'));
  });

  afterEach(() => {
    // Best-effort cleanup; OS tmpdir is purged eventually.
    try {
      for (const f of nodefs.readdirSync(tmpDir)) {
        try { nodefs.unlinkSync(join(tmpDir, f)); } catch { /* ignore */ }
      }
      nodefs.rmdirSync(tmpDir);
    } catch { /* ignore */ }
  });

  it('sweeps a real old dead-holder lock file from a real tmpdir sandbox', () => {
    const lockPath = join(tmpDir, 'proxy-backend-cafecafe.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: 99999999, t: Date.now() - 60_000, key: 'test' }));

    // Backdate the mtime so it is definitively older than TTL.
    const oldTime = new Date(Date.now() - LOCK_DEBRIS_TTL_MS - 5_000);
    nodefs.utimesSync(lockPath, oldTime, oldTime);

    const result = sweepProxyBackendLocks(tmpDir, {
      pidAlive: () => false, // inject dead-pid check for reproducibility
    });
    expect(result.scanned).toBe(1);
    expect(result.swept).toBe(1);
    expect(nodefs.existsSync(lockPath)).toBe(false);
  });

  it('dry-run does not delete real lock files from the sandbox', () => {
    const lockPath = join(tmpDir, 'proxy-backend-drytest11.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: 99999999, t: Date.now() - 60_000, key: 'drytest' }));
    const oldTime = new Date(Date.now() - LOCK_DEBRIS_TTL_MS - 5_000);
    nodefs.utimesSync(lockPath, oldTime, oldTime);

    const result = sweepProxyBackendLocks(tmpDir, {
      dryRun: true,
      pidAlive: () => false,
    });
    expect(result.swept).toBe(1);
    expect(result.entries[0]?.action).toBe('would-sweep');
    // File must still exist — dry-run never unlinks.
    expect(nodefs.existsSync(lockPath)).toBe(true);
  });
});
