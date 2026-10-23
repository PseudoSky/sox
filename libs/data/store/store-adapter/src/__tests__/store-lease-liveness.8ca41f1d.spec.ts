/**
 * Pid-reuse rule for registry entries (backlog 8ca41f1d, same root cause as
 * 813348a6): an entry whose timestamp predates its LIVE pid's start time by
 * more than 5 minutes was written by a dead holder whose pid was recycled.
 *
 * Failure mode: a recycled pid keeps a dead holder's opener/lease entry live
 * forever, so the fts-rebuild guard refuses indefinitely.
 * Tier: S (pure functions plus temp-dir fs; ps reader and clock injected, no
 * process is spawned).
 * Gap statement: a real recycled pid cannot be produced deterministically at
 * tier S; it is simulated by an injected start time, so the real `ps -o lstart=`
 * text format is covered only by the parse cases here, not against the OS.
 * Cites: 8ca41f1d AC1-AC7.
 * Light risk map: wrong-direction clock step (live holder read stale) is bounded
 * by the margin and pinned by AC6; ps failure fails live (AC5).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach } from 'vitest';
import {
  acquireStoreLease,
  entryLiveness,
  leaseDirPath,
  storeQuiescence,
  openerDirPath,
  registerStoreOpener,
} from '../store-lease.js';
import { START_SKEW_MARGIN_MS, parseProcessStart } from '../store-lease-liveness.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'store-lease-liveness-'));
  dirs.push(dir);
  return join(dir, 'store.db');
}

// A pid that is alive and is not this process (the parent of the test worker).
const LIVE_OTHER_PID = process.ppid;
const START_ISO = '2026-10-20T13:24:35.000Z';
const START_MS = Date.parse(START_ISO);
/** ps text for START_MS, in the `lstart` format printed under TZ=UTC. */
const START_TEXT = 'Tue Oct 20 13:24:35 2026';
const entry = (pid: number, ms: number): string => `${pid}\n${new Date(ms).toISOString()}\n`;
const reader = (text: string | null) => ({ readStart: () => text });

describe('store-lease pid reuse — 8ca41f1d', () => {
  it('precondition: the live-other pid is alive and is not this process', () => {
    expect(LIVE_OTHER_PID).not.toBe(process.pid);
    expect(() => process.kill(LIVE_OTHER_PID, 0)).not.toThrow();
  });

  it('8ca41f1d AC1: a live holder (entry at or after its process start) is live', () => {
    const at = entryLiveness(entry(LIVE_OTHER_PID, START_MS), Date.now(), reader(START_TEXT));
    const after = entryLiveness(entry(LIVE_OTHER_PID, START_MS + 60_000), Date.now(), reader(START_TEXT));
    expect(at).toMatchObject({ live: true, pid: LIVE_OTHER_PID });
    expect(after).toMatchObject({ live: true, pid: LIVE_OTHER_PID });
  });

  it('8ca41f1d AC2: an entry earlier than its live pid start by more than the margin is not live and is swept', () => {
    // The fs sweep for this verdict is pinned in store-lease-sweep.8ca41f1d.spec.ts.
    const stale = entry(LIVE_OTHER_PID, START_MS - 2 * START_SKEW_MARGIN_MS);
    expect(entryLiveness(stale, Date.now(), reader(START_TEXT))).toMatchObject({ live: false });
  });

  it('8ca41f1d AC3: a dead pid is not live, as before', () => {
    // Find a pid that is not alive without spawning: walk down from a high pid.
    let dead = 4_000_000;
    for (; dead > 3_000_000; dead--) {
      try {
        process.kill(dead, 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') break;
      }
    }
    let reads = 0;
    const info = entryLiveness(entry(dead, Date.now()), Date.now(), {
      readStart: () => {
        reads++;
        return START_TEXT;
      },
    });
    expect(info).toMatchObject({ live: false, pid: dead });
    expect(reads, 'a dead pid is decided by the kill probe, never ps').toBe(0);
  });

  it('8ca41f1d AC4: old-format entries (same pid + ISO shape, no migration) are judged by the AC2 rule', () => {
    const oldFormat = `${LIVE_OTHER_PID}\n2026-10-11T08:31:08.723Z\n`;
    expect(entryLiveness(oldFormat, Date.now(), reader('Tue Oct 20 13:24:35 2026'))).toMatchObject({ live: false });
    expect(entryLiveness(oldFormat, Date.now(), reader('Sat Oct 10 13:24:35 2026'))).toMatchObject({ live: true });
  });

  it('8ca41f1d AC5: ps failure, unparseable ps text, a throwing reader, or a bad timestamp leave the entry live', () => {
    const stale = entry(LIVE_OTHER_PID, START_MS - 10 * START_SKEW_MARGIN_MS);
    expect(entryLiveness(stale, Date.now(), reader(null))?.live).toBe(true);
    expect(entryLiveness(stale, Date.now(), reader('not a date'))?.live).toBe(true);
    expect(entryLiveness(stale, Date.now(), reader(''))?.live).toBe(true);
    expect(
      entryLiveness(stale, Date.now(), {
        readStart: () => {
          throw new Error('ps blew up');
        },
      })?.live,
    ).toBe(true);
    expect(entryLiveness(`${LIVE_OTHER_PID}\ngarbage\n`, Date.now(), reader(START_TEXT))?.live).toBe(true);
    expect(entryLiveness(`${LIVE_OTHER_PID}\n`, Date.now(), reader(START_TEXT))?.live).toBe(true);
  });

  it('8ca41f1d AC6: exactly 5 minutes before the start is live; 5 minutes plus 1 ms is stale', () => {
    const boundary = entry(LIVE_OTHER_PID, START_MS - START_SKEW_MARGIN_MS);
    const over = entry(LIVE_OTHER_PID, START_MS - START_SKEW_MARGIN_MS - 1);
    expect(START_SKEW_MARGIN_MS).toBe(300_000);
    expect(entryLiveness(boundary, Date.now(), reader(START_TEXT))?.live).toBe(true);
    expect(entryLiveness(over, Date.now(), reader(START_TEXT))?.live).toBe(false);
  });

  it('8ca41f1d AC7: writers keep the two-line pid+ISO format and a same-process round trip is live', async () => {
    const dbPath = tempDbPath();
    const lease = await acquireStoreLease(dbPath);
    const leaseContent = readFileSync(join(leaseDirPath(dbPath), lease.token), 'utf8');
    expect(leaseContent).toMatch(/^\d+\n\d{4}-\d{2}-\d{2}T[\d:.]+Z\n$/);
    expect(leaseContent.split('\n')[0]).toBe(String(process.pid));
    // No ps may be consulted for the own pid.
    const info = entryLiveness(leaseContent, Date.now(), {
      readStart: () => {
        throw new Error('own pid must not be probed');
      },
    });
    expect(info).toMatchObject({ live: true, pid: process.pid });
    // Production path (real ps reader never reached for own pid): still live.
    expect(storeQuiescence(dbPath).livePeers.map((p) => p.pid)).toEqual([process.pid]);
    await lease.release();

    const opener = registerStoreOpener(dbPath);
    const files = readdirSync(openerDirPath(dbPath));
    expect(files).toEqual([String(process.pid)]);
    const openerContent = readFileSync(join(openerDirPath(dbPath), files[0] as string), 'utf8');
    expect(openerContent).toMatch(/^\d+\n\d{4}-\d{2}-\d{2}T[\d:.]+Z\n$/);
    expect(entryLiveness(openerContent)?.live).toBe(true);
    opener.release();
  });

  it('parseProcessStart reads ps lstart text as UTC, incl. space-padded days', () => {
    expect(parseProcessStart(START_TEXT)).toBe(START_MS);
    expect(parseProcessStart('Mon Oct  5 01:02:03 2026')).toBe(Date.parse('2026-10-05T01:02:03Z'));
    expect(parseProcessStart('garbage')).toBeNaN();
  });
});
