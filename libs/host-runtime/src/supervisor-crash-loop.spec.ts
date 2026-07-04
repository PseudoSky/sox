/**
 * supervisor-crash-loop.spec.ts — Slice 3 of docs/spec/service-lifecycle.md (§11.3).
 *
 * [inv:crash-loop-cap] wired into the REAL ProcessSupervisor unexpected-exit
 * seam, proven with REAL spawned child processes (no fakes at the process layer):
 *
 *   (a) a crash-looping child (exits immediately, N times within the window) ⇒
 *       the supervisor GIVES UP: no further respawns, isCrashLooped()=true,
 *       durable marker written (the status/doctor surface).
 *   (b) an explicit start() clears the give-up state + marker and respawns.
 *   (c) a slow-but-successful start (health probe times out but the process
 *       stays ALIVE) records ZERO failures — the cap counts exits, not slowness.
 *
 * All markers go to a SANDBOXED temp dir; children are reaped in afterEach.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listCrashLoopMarkers } from './crash-loop.js';
import { ProcessSupervisor } from './supervisor.js';

let tmpDir: string;
let markerDir: string;
const sups: ProcessSupervisor[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-sup-crashloop-'));
  markerDir = path.join(tmpDir, 'crash-loop');
  fs.mkdirSync(markerDir, { recursive: true });
});

afterEach(async () => {
  for (const s of sups.splice(0)) {
    try { await s.stop(); } catch { /* already gone */ }
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

/** A child that appends one line per RUN, then exits 1 — unless a flag file exists,
 *  in which case it stays alive (the "fixed" service for the clear test). */
function writeCrashyEntrypoint(): { entrypoint: string; runsFile: string; fixFlag: string } {
  const entrypoint = path.join(tmpDir, 'crashy.js');
  const runsFile = path.join(tmpDir, 'runs.log');
  const fixFlag = path.join(tmpDir, 'fixed.flag');
  fs.writeFileSync(
    entrypoint,
    [
      `const fs = require('node:fs');`,
      `fs.appendFileSync(${JSON.stringify(runsFile)}, process.pid + '\\n');`,
      `if (fs.existsSync(${JSON.stringify(fixFlag)})) { setInterval(() => {}, 1000); }`,
      `else { process.exit(1); }`,
      '',
    ].join('\n'),
    'utf8',
  );
  return { entrypoint, runsFile, fixFlag };
}

function runCount(runsFile: string): number {
  try {
    return fs.readFileSync(runsFile, 'utf8').split('\n').filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

describe('ProcessSupervisor + [inv:crash-loop-cap] (§11.3) — real processes', () => {
  it('(a) N unexpected exits in the window ⇒ give up: no more respawns, marker written', async () => {
    const { entrypoint, runsFile } = writeCrashyEntrypoint();
    const sup = new ProcessSupervisor({
      key: 'crashy-svc@1.0.0',
      entrypointPath: entrypoint,
      lifecycle: {}, // no health gate — start() returns after spawn
      crashLoop: { maxFailures: 3, windowMs: 30_000, markerDir },
    });
    sups.push(sup);
    await sup.start();

    // The child exits immediately; backoffs are 200/400ms ⇒ the 3rd exit caps well
    // within this bound.
    expect(await waitFor(() => sup.isCrashLooped(), 15_000)).toBe(true);
    expect(sup.isHealthy()).toBe(false);

    // Durable marker written for status/doctor.
    const markers = listCrashLoopMarkers(markerDir);
    expect(markers.length).toBe(1);
    expect(markers[0]!.key).toBe('crashy-svc@1.0.0');
    expect(markers[0]!.failures.length).toBe(3);
    expect(markers[0]!.reason).toContain('[crash-loop]');

    // NO further respawns after the cap: the run count freezes.
    const runsAtCap = runCount(runsFile);
    expect(runsAtCap).toBe(3);
    await sleep(1500); // > the next backoff would have been (800ms)
    expect(runCount(runsFile)).toBe(runsAtCap);
    expect(sup.isCrashLooped()).toBe(true); // sticky
  }, 30_000);

  it('(b) an explicit start() clears the give-up state + marker and respawns', async () => {
    const { entrypoint, runsFile, fixFlag } = writeCrashyEntrypoint();
    const sup = new ProcessSupervisor({
      key: 'crashy-svc@1.0.0',
      entrypointPath: entrypoint,
      lifecycle: {},
      crashLoop: { maxFailures: 2, windowMs: 30_000, markerDir },
    });
    sups.push(sup);
    await sup.start();
    expect(await waitFor(() => sup.isCrashLooped(), 15_000)).toBe(true);
    expect(listCrashLoopMarkers(markerDir).length).toBe(1);

    // "Fix" the service, then the EXPLICIT start clears cap + marker (§11.3).
    fs.writeFileSync(fixFlag, '1', 'utf8');
    const runsBefore = runCount(runsFile);
    await sup.start();
    expect(sup.isCrashLooped()).toBe(false);
    expect(listCrashLoopMarkers(markerDir).length).toBe(0);
    // It actually respawned and now stays alive.
    expect(await waitFor(() => runCount(runsFile) === runsBefore + 1, 10_000)).toBe(true);
    expect(sup.pid()).not.toBeNull();
    await sleep(300);
    expect(runCount(runsFile)).toBe(runsBefore + 1); // alive — no crash loop
  }, 30_000);

  it('(c) a slow-but-successful start never trips the cap (failures are exits, not slowness)', async () => {
    // Child stays alive forever; health probes a socket that NEVER binds, so the
    // health gate times out — but the process does not exit ⇒ zero failures.
    const entrypoint = path.join(tmpDir, 'slow.js');
    fs.writeFileSync(entrypoint, `setInterval(() => {}, 1000);\n`, 'utf8');
    const sup = new ProcessSupervisor({
      key: 'slow-svc@1.0.0',
      entrypointPath: entrypoint,
      lifecycle: {
        health: { type: 'socket', endpoint: path.join(tmpDir, 'never.sock'), timeout_ms: 400 },
      },
      crashLoop: { maxFailures: 2, windowMs: 30_000, markerDir },
    });
    sups.push(sup);
    await expect(sup.start()).rejects.toThrow(/Health check timed out/);
    // Slow ≠ crashing: no give-up, no marker, process still alive.
    expect(sup.isCrashLooped()).toBe(false);
    expect(listCrashLoopMarkers(markerDir).length).toBe(0);
    expect(sup.pid()).not.toBeNull();
  }, 30_000);
});
