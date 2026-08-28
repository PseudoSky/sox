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
  descendantOf,
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
      processTable: new Map(),
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
      processTable: new Map(),
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
      processTable: new Map(),
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
      processTable: new Map(),
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
      processTable: new Map(),
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
      processTable: new Map(),
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
      processTable: new Map(),
    });
    expect(plan).toEqual({ reap: [], skip: [], duplicateSetNoSocket: [] });
  });
});

// ─── BL-621: ancestry-rooted classification ────────────────────────────────────

describe('descendantOf — parentage-chain walk (BL-621)', () => {
  it('returns the first root reached walking the ppid chain', () => {
    const table = new Map([[200, 100], [100, 50], [50, 1]]);
    expect(descendantOf(200, new Set([50, 100]), table)).toBe(100);
  });

  it('returns null when the chain reaches a non-root end', () => {
    const table = new Map([[400, 1], [1, 0]]);
    expect(descendantOf(400, new Set([100]), table)).toBeNull();
  });

  it('returns null on an unknown parent (chain ends early)', () => {
    const table = new Map([[400, 99]]); // 99 not itself in the table
    expect(descendantOf(400, new Set([50]), table)).toBeNull();
  });

  it('returns null when the root is deeper than maxDepth (depth cap)', () => {
    const table = new Map<number, number>();
    const N = 1000;
    for (let i = N; i > 1; i--) table.set(i, i - 1);
    table.set(1, 0);
    // root 1 is N-1 levels up — unreachable within the default 32-hop cap.
    expect(descendantOf(N, new Set([1]), table)).toBeNull();
    // but reachable with a cap at least as deep as the chain.
    expect(descendantOf(N, new Set([1]), table, N)).toBe(1);
  });
});

describe('classifyReconcileTargets — ancestry (BL-621)', () => {
  it('BL-621: a child of the live writer is skipped as descendant-of-live-instance, never reaped', () => {
    // child 200 → writer 100 → supervisor 50 → init 1; roots {50 (accounted), 100 (holder)}.
    const table = new Map([[200, 100], [100, 50], [50, 1]]);
    const plan = classifyReconcileTargets({
      matches: [m(200, 100)],
      accountedPids: new Set([50]),
      socketLive: true,
      socketPids: [100],
      processTable: table,
    });
    expect(plan.reap).toEqual([]);
    expect(plan.skip).toEqual([
      { match: m(200, 100), reason: 'descendant-of-live-instance', protectingPid: 100 },
    ]);
    expect(plan.duplicateSetNoSocket).toEqual([]);
  });

  it('BL-621: no-socket shape — backend + enrich fork + fastembed pool hosts are all skipped, never a duplicate set', () => {
    const table = new Map([[300, 50], [301, 300], [302, 300], [50, 1]]);
    const plan = classifyReconcileTargets({
      matches: [m(300, 50), m(301, 300), m(302, 300)],
      accountedPids: new Set([50]),
      socketLive: false,
      socketPids: null,
      processTable: table,
    });
    expect(plan.reap).toEqual([]);
    expect(plan.duplicateSetNoSocket).toEqual([]);
    expect(plan.skip.length).toBe(3);
    expect(plan.skip.every((s) => s.reason === 'descendant-of-live-instance')).toBe(true);
  });

  it('BL-621 regression: a true BL-170 orphan (PPID 1, no live root) is STILL reaped', () => {
    // orphan 400 → init 1; live writer 100. No live root in 400's parentage.
    const table = new Map([[400, 1], [100, 50], [50, 1]]);
    const plan = classifyReconcileTargets({
      matches: [m(100, 50), m(400, 1)],
      accountedPids: new Set([50]),
      socketLive: true,
      socketPids: [100],
      processTable: table,
    });
    expect(plan.reap).toEqual([m(400, 1)]);
    expect(plan.skip).toContainEqual({ match: m(100, 50), reason: 'writer-socket-holder' });
  });

  it('BL-621: cross-scope anchor — a descendant of an OS-unit-anchored pid (another scope) is protected', () => {
    const table = new Map([[701, 700], [700, 1]]);
    const plan = classifyReconcileTargets({
      matches: [m(701, 700)],
      accountedPids: new Set([700]),
      socketLive: true,
      socketPids: [999], // a live, unrelated holder
      processTable: table,
    });
    expect(plan.reap).toEqual([]);
    expect(plan.skip).toEqual([
      { match: m(701, 700), reason: 'descendant-of-live-instance', protectingPid: 700 },
    ]);
  });

  it('BL-621: depth cap — a root deeper than 32 hops does not protect (match falls through to reap)', () => {
    const table = new Map<number, number>();
    const matchPid = 5000;
    // chain 5000 → 4999 → … → 4968 (32 hops up) → 4967 (root at the 33rd ancestor).
    for (let i = matchPid; i > 4968; i--) table.set(i, i - 1);
    table.set(4968, 4967);
    table.set(4967, 1);
    const plan = classifyReconcileTargets({
      matches: [m(matchPid, matchPid - 1)],
      accountedPids: new Set([4967]),
      socketLive: true,
      socketPids: [100],
      processTable: table,
    });
    expect(plan.reap).toEqual([m(matchPid, matchPid - 1)]);
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
    const lockFile = `${LOCK_DIR}/proxy-backend-f4e50123.lock`;
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
    const lockFile = `${LOCK_DIR}/proxy-backend-6a4ba6e0.lock`;
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
    const lockFile = `${LOCK_DIR}/proxy-backend-d54a0123.lock`;
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
    const lockPath = join(tmpDir, 'proxy-backend-d4e51111.lock');
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
