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
 */

import { describe, expect, it } from 'vitest';

import {
  classifyReconcileTargets,
  socketOwnerPids,
  type LsofExec,
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
