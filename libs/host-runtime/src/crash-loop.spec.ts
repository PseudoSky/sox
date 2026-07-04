/**
 * crash-loop.spec.ts — Slice 3 of docs/spec/service-lifecycle.md (§11.3).
 *
 * [inv:crash-loop-cap]: N unexpected exits within a rolling window ⇒ give up,
 * sticky until an explicit clear; a success resets; slow-but-successful starts
 * never count (failures are exits, and the window ages old exits out).
 *
 * All persistence goes to a SANDBOXED temp marker dir — never the real runDir().
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CRASH_LOOP_MAX_FAILURES,
  CRASH_LOOP_WINDOW_MS,
  CrashLoopGuard,
  clearCrashLoopMarker,
  crashLoopMarkerPath,
  listCrashLoopMarkers,
  readCrashLoopMarker,
} from './crash-loop.js';

let markerDir: string;

beforeEach(() => {
  markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-crashloop-'));
});

afterEach(() => {
  try {
    fs.rmSync(markerDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** A guard with a fake, manually-advanced clock. */
function makeGuard(over: { maxFailures?: number; windowMs?: number; persist?: boolean; key?: string } = {}): {
  guard: CrashLoopGuard;
  tick: (ms: number) => void;
} {
  let t = 1_000_000;
  const guard = new CrashLoopGuard({
    key: over.key ?? 'test-svc@1.0.0',
    maxFailures: over.maxFailures ?? 3,
    windowMs: over.windowMs ?? 10_000,
    markerDir,
    persist: over.persist ?? true,
    now: () => t,
  });
  return { guard, tick: (ms) => { t += ms; } };
}

describe('CrashLoopGuard — the §11.3 rolling-window cap', () => {
  it('defaults are the spec decision: 5-in-60s', () => {
    expect(CRASH_LOOP_MAX_FAILURES).toBe(5);
    expect(CRASH_LOOP_WINDOW_MS).toBe(60_000);
    const g = new CrashLoopGuard({ key: 'x', markerDir, persist: false });
    // 4 failures in a burst do NOT cap; the 5th does.
    for (let i = 0; i < 4; i++) expect(g.recordFailure().capped).toBe(false);
    expect(g.recordFailure().capped).toBe(true);
  });

  it('(a) N failures within the window ⇒ capped', () => {
    const { guard, tick } = makeGuard({ maxFailures: 3, windowMs: 10_000 });
    expect(guard.recordFailure().capped).toBe(false);
    tick(1000);
    expect(guard.recordFailure().capped).toBe(false);
    tick(1000);
    const s = guard.recordFailure();
    expect(s.capped).toBe(true);
    expect(s.failuresInWindow).toBe(3);
    expect(guard.isCapped()).toBe(true);
  });

  it('(b) a success resets the counter AND the cap', () => {
    const { guard } = makeGuard({ maxFailures: 3 });
    guard.recordFailure();
    guard.recordFailure();
    guard.recordSuccess();
    expect(guard.failuresInWindow()).toBe(0);
    // A fresh burst must count from zero again.
    expect(guard.recordFailure().capped).toBe(false);
    expect(guard.recordFailure().capped).toBe(false);
    expect(guard.recordFailure().capped).toBe(true);
    guard.recordSuccess();
    expect(guard.isCapped()).toBe(false);
  });

  it('(c) failures spaced wider than the window never cap (a slow-but-alive run recovers)', () => {
    const { guard, tick } = makeGuard({ maxFailures: 3, windowMs: 5_000 });
    for (let i = 0; i < 10; i++) {
      const s = guard.recordFailure();
      expect(s.capped).toBe(false);
      expect(s.failuresInWindow).toBe(1); // prior failure aged out
      tick(6_000); // longer than the window between exits
    }
    expect(guard.isCapped()).toBe(false);
  });

  it('the cap is STICKY: window expiry does not silently un-cap ([inv:list-never-lies])', () => {
    const { guard, tick } = makeGuard({ maxFailures: 2, windowMs: 1_000 });
    guard.recordFailure();
    guard.recordFailure();
    expect(guard.isCapped()).toBe(true);
    tick(60_000); // far past the window
    expect(guard.failuresInWindow()).toBe(0);
    expect(guard.isCapped()).toBe(true); // still capped — explicit clear required
    guard.clear();
    expect(guard.isCapped()).toBe(false);
  });
});

describe('durable marker — cross-process surfacing for status/doctor', () => {
  it('writes the marker on the cap TRANSITION with key/failures/window', () => {
    const { guard } = makeGuard({ maxFailures: 2, key: 'memory-daemon@1.0.0' });
    guard.recordFailure();
    expect(fs.existsSync(crashLoopMarkerPath(markerDir, 'memory-daemon@1.0.0'))).toBe(false);
    guard.recordFailure();
    const marker = readCrashLoopMarker(crashLoopMarkerPath(markerDir, 'memory-daemon@1.0.0'));
    expect(marker).not.toBeNull();
    expect(marker!.key).toBe('memory-daemon@1.0.0');
    expect(marker!.failures.length).toBe(2);
    expect(marker!.maxFailures).toBe(2);
    expect(marker!.windowMs).toBe(10_000);
    expect(marker!.reason).toContain('[crash-loop]');
    expect(marker!.reason).toContain('give-up');
  });

  it('clear()/recordSuccess() removes the marker (explicit start/enable clears)', () => {
    const { guard } = makeGuard({ maxFailures: 1, key: 'svc-a' });
    guard.recordFailure();
    expect(listCrashLoopMarkers(markerDir).length).toBe(1);
    guard.clear();
    expect(listCrashLoopMarkers(markerDir).length).toBe(0);
  });

  it('persist:false never touches the marker dir', () => {
    const { guard } = makeGuard({ maxFailures: 1, persist: false });
    guard.recordFailure();
    expect(guard.isCapped()).toBe(true);
    expect(listCrashLoopMarkers(markerDir).length).toBe(0);
  });

  it('listCrashLoopMarkers enumerates every live marker; corrupt files are skipped', () => {
    const a = makeGuard({ maxFailures: 1, key: 'svc-a' });
    const b = makeGuard({ maxFailures: 1, key: 'svc-b@2.0.0' });
    a.guard.recordFailure();
    b.guard.recordFailure();
    fs.writeFileSync(path.join(markerDir, 'corrupt.json'), '{nope', 'utf8');
    const markers = listCrashLoopMarkers(markerDir);
    expect(markers.map((m) => m.key).sort()).toEqual(['svc-a', 'svc-b@2.0.0']);
  });

  it('marker filenames are fs-safe for keys with path-hostile characters', () => {
    const p = crashLoopMarkerPath(markerDir, 'weird/key with spaces:v1');
    expect(path.basename(p)).toBe('weird_key_with_spaces_v1.json');
    const { guard } = makeGuard({ maxFailures: 1, key: 'weird/key with spaces:v1' });
    guard.recordFailure();
    expect(fs.existsSync(p)).toBe(true);
    expect(clearCrashLoopMarker(markerDir, 'weird/key with spaces:v1')).toBe(true);
  });

  it('readCrashLoopMarker returns null for absent/invalid markers', () => {
    expect(readCrashLoopMarker(path.join(markerDir, 'nope.json'))).toBeNull();
    fs.writeFileSync(path.join(markerDir, 'bad.json'), JSON.stringify({ notAKey: 1 }), 'utf8');
    expect(readCrashLoopMarker(path.join(markerDir, 'bad.json'))).toBeNull();
  });
});
