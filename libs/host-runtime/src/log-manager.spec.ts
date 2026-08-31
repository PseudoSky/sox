/**
 * log-manager.spec.ts — BL-620 / INV-6: OS-unit log rotation.
 *
 * The stable active paths (`<id>-os.out.log` / `<id>-os.err.log`) grow
 * unbounded because launchd/systemd append forever. `rotateOsUnitLogs`
 * copytruncates an over-size active log to `<path>.<YYYYMMDD-HHmmss>` (BL-629:
 * the active inode is preserved so the supervisor's open fd keeps writing to the
 * same, now-truncated file), then prunes archives by count and size — matching
 * BOTH the new `.YYYYMMDD[-HHmmss]` form and the legacy
 * `-os-<date>.<out|err>.log` form, and deleting any archive over `maxBytes*4`
 * regardless of count. A second rotation within one UTC day lands in a distinct
 * archive (no silent same-day overwrite).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findAllLogStreamsForExt, findMostRecentLogFile, rotateOsUnitLogs } from './log-manager.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-oslog-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const outPath = (): string => path.join(dir, 'doctor-tick-os.out.log');
const errPath = (): string => path.join(dir, 'doctor-tick-os.err.log');

describe('rotateOsUnitLogs — BL-620 / INV-6', () => {
  it('copytruncates an over-size active log to <path>.<YYYYMMDD-HHmmss> (preserves the live inode)', () => {
    fs.writeFileSync(outPath(), 'x'.repeat(1_000_001)); // > 1MB default maxBytes
    rotateOsUnitLogs({ outPath: outPath() });
    // BL-629: the active path SURVIVES (its inode is preserved so the OS
    // supervisor's open fd keeps writing to it) but is truncated to 0…
    expect(fs.existsSync(outPath())).toBe(true);
    expect(fs.statSync(outPath()).size).toBe(0);
    // …and the rotated content landed in a compact `.<YYYYMMDD-HHmmss>` archive.
    const archived = fs.readdirSync(dir).find((f) => f.startsWith('doctor-tick-os.out.log.'));
    expect(archived).toMatch(/^doctor-tick-os\.out\.log\.\d{8}-\d{6}$/);
    expect(fs.statSync(path.join(dir, archived!)).size).toBe(1_000_001);
  });

  it('BL-620 second-round: a second rotation within one UTC day lands in a DISTINCT archive (no same-day overwrite)', () => {
    fs.writeFileSync(outPath(), 'x'.repeat(1_000_001));
    rotateOsUnitLogs({ outPath: outPath() });
    fs.writeFileSync(outPath(), 'y'.repeat(1_000_001));
    rotateOsUnitLogs({ outPath: outPath() });
    // Two distinct archives must survive — the old fixed `.YYYYMMDD` suffix
    // silently overwrote the first on the second rotation.
    const archives = fs.readdirSync(dir).filter((f) => f.startsWith('doctor-tick-os.out.log.'));
    expect(archives).toHaveLength(2);
  });

  it('leaves a below-threshold active log untouched (no rotation)', () => {
    fs.writeFileSync(outPath(), 'small');
    rotateOsUnitLogs({ outPath: outPath() });
    expect(fs.existsSync(outPath())).toBe(true);
    expect(fs.statSync(outPath()).size).toBe('small'.length);
    expect(fs.readdirSync(dir).filter((f) => f.includes('.log.'))).toHaveLength(0);
  });

  it('rotates the err stream too when errPath is provided', () => {
    fs.writeFileSync(outPath(), 'x'.repeat(1_000_001));
    fs.writeFileSync(errPath(), 'x'.repeat(1_000_001));
    rotateOsUnitLogs({ outPath: outPath(), errPath: errPath() });
    // Both active files survive (truncated), and each produced its own archive.
    expect(fs.statSync(outPath()).size).toBe(0);
    expect(fs.statSync(errPath()).size).toBe(0);
    expect(fs.readdirSync(dir).some((f) => f.startsWith('doctor-tick-os.out.log.'))).toBe(true);
    expect(fs.readdirSync(dir).some((f) => f.startsWith('doctor-tick-os.err.log.'))).toBe(true);
  });

  it('prunes legacy `-os-<date>.out.log` archives by count-cap (oldest first)', () => {
    for (const d of ['08-01', '08-02', '08-03', '08-04', '08-05', '08-06', '08-07']) {
      fs.writeFileSync(path.join(dir, `doctor-tick-os-2026-${d}.out.log`), 'x');
    }
    rotateOsUnitLogs({ outPath: outPath(), keep: 3 });
    const legacy = fs.readdirSync(dir)
      .filter((f) => f.startsWith('doctor-tick-os-') && f.endsWith('.out.log'))
      .sort();
    expect(legacy).toEqual([
      'doctor-tick-os-2026-08-05.out.log',
      'doctor-tick-os-2026-08-06.out.log',
      'doctor-tick-os-2026-08-07.out.log',
    ]);
  });

  it('prunes new-form <path>.<YYYYMMDD> archives by count-cap', () => {
    for (let i = 1; i <= 7; i++) {
      fs.writeFileSync(path.join(dir, `doctor-tick-os.out.log.2026080${i}`), 'x');
    }
    rotateOsUnitLogs({ outPath: outPath(), keep: 3 });
    const archives = fs.readdirSync(dir)
      .filter((f) => f.startsWith('doctor-tick-os.out.log.'))
      .sort();
    expect(archives).toEqual([
      'doctor-tick-os.out.log.20260805',
      'doctor-tick-os.out.log.20260806',
      'doctor-tick-os.out.log.20260807',
    ]);
  });

  it('prunes new-form <path>.<YYYYMMDD-HHmmss> archives by count-cap (timestamped suffix)', () => {
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(path.join(dir, `doctor-tick-os.out.log.2026080${i}-120000`), 'x');
    }
    rotateOsUnitLogs({ outPath: outPath(), keep: 2 });
    const archives = fs.readdirSync(dir)
      .filter((f) => f.startsWith('doctor-tick-os.out.log.'))
      .sort();
    expect(archives).toEqual([
      'doctor-tick-os.out.log.20260804-120000',
      'doctor-tick-os.out.log.20260805-120000',
    ]);
  });

  it('BL-620 second-round: count-cap sorts by PARSED date across mixed legacy + new forms (not raw name)', () => {
    // A legacy `-os-2026-08-02` collates AFTER a new `.20260801` under a raw
    // localeCompare, but it is the OLDER archive by date — the count-cap must
    // drop it, never the newer timestamped archive.
    fs.writeFileSync(path.join(dir, 'doctor-tick-os.out.log.20260805'), 'newer');
    fs.writeFileSync(path.join(dir, 'doctor-tick-os-2026-08-02.out.log'), 'older');
    fs.writeFileSync(path.join(dir, 'doctor-tick-os.out.log.20260803-142530'), 'mid');
    rotateOsUnitLogs({ outPath: outPath(), keep: 2 });
    const remaining = fs.readdirSync(dir).filter((f) => f !== 'doctor-tick-os.out.log').sort();
    expect(remaining).toEqual([
      'doctor-tick-os.out.log.20260803-142530',
      'doctor-tick-os.out.log.20260805',
    ]);
  });

  it('prunes archives over maxBytes*4 regardless of count (size-cap)', () => {
    // 6MB is over the 4MB size-cap (1MB * 4) — pruned even though `keep` is high.
    fs.writeFileSync(path.join(dir, 'doctor-tick-os-2026-08-01.out.log'), 'x'.repeat(6 * 1024 * 1024));
    fs.writeFileSync(path.join(dir, 'doctor-tick-os-2026-08-02.out.log'), 'small');
    rotateOsUnitLogs({ outPath: outPath(), keep: 5 });
    expect(fs.existsSync(path.join(dir, 'doctor-tick-os-2026-08-01.out.log'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'doctor-tick-os-2026-08-02.out.log'))).toBe(true);
  });

  it('keeps a legacy 3.5MB dated file (under size-cap) — subject only to count-cap', () => {
    // The exact live doctor-tick out.log size (3.5MB) is UNDER the 4MB size-cap,
    // so it must NOT be size-pruned; it survives within the count bound.
    fs.writeFileSync(path.join(dir, 'doctor-tick-os-2026-08-11.out.log'), 'x'.repeat(3_500_000));
    rotateOsUnitLogs({ outPath: outPath(), keep: 5 });
    expect(fs.existsSync(path.join(dir, 'doctor-tick-os-2026-08-11.out.log'))).toBe(true);
  });
});

describe('findAllLogStreamsForExt / findMostRecentLogFile — BL-630 os-out vs os-err distinction', () => {
  it('emits DISTINCT prefixes for the os-out and os-err streams (no more shared `${extId}-os`)', () => {
    const streams = findAllLogStreamsForExt('doctor-tick', 'supervisor-1', 'user');
    const osOut = streams.find((s) => s.label === 'os-out');
    const osErr = streams.find((s) => s.label === 'os-err');
    expect(osOut).toBeDefined();
    expect(osErr).toBeDefined();
    expect(osOut!.filePrefix).toBe('doctor-tick-os.out');
    expect(osErr!.filePrefix).toBe('doctor-tick-os.err');
    expect(osOut!.filePrefix).not.toBe(osErr!.filePrefix);
  });

  it('resolves the stable stdout and stderr files to DISTINCT paths', () => {
    fs.writeFileSync(path.join(dir, 'doctor-tick-os.out.log'), 'stdout');
    fs.writeFileSync(path.join(dir, 'doctor-tick-os.err.log'), 'stderr');
    const outFile = findMostRecentLogFile(dir, 'doctor-tick-os.out');
    const errFile = findMostRecentLogFile(dir, 'doctor-tick-os.err');
    expect(outFile).toBe(path.join(dir, 'doctor-tick-os.out.log'));
    expect(errFile).toBe(path.join(dir, 'doctor-tick-os.err.log'));
    expect(outFile).not.toBe(errFile);
  });

  it('still matches the legacy `<extId>-os-<date>.<out|err>.log` forms via the finder', () => {
    fs.writeFileSync(path.join(dir, 'doctor-tick-os-2026-08-01.out.log'), 'legacy-out');
    fs.writeFileSync(path.join(dir, 'doctor-tick-os-2026-08-02.out.log'), 'legacy-out-newer');
    fs.writeFileSync(path.join(dir, 'doctor-tick-os-2026-08-03.err.log'), 'legacy-err');
    // The out prefix must resolve to the newest dated .out.log, never the .err.log.
    expect(findMostRecentLogFile(dir, 'doctor-tick-os.out')).toBe(path.join(dir, 'doctor-tick-os-2026-08-02.out.log'));
    expect(findMostRecentLogFile(dir, 'doctor-tick-os.err')).toBe(path.join(dir, 'doctor-tick-os-2026-08-03.err.log'));
  });

  it('does not cross the out/err boundary even when both stable and legacy forms coexist', () => {
    fs.writeFileSync(path.join(dir, 'doctor-tick-os.out.log'), 'stable-out');
    fs.writeFileSync(path.join(dir, 'doctor-tick-os.err.log'), 'stable-err');
    fs.writeFileSync(path.join(dir, 'doctor-tick-os-2026-08-01.err.log'), 'legacy-err');
    // out must resolve to the stable out file (most recent .out), never the .err.
    expect(findMostRecentLogFile(dir, 'doctor-tick-os.out')).toBe(path.join(dir, 'doctor-tick-os.out.log'));
    expect(findMostRecentLogFile(dir, 'doctor-tick-os.err')).toBe(path.join(dir, 'doctor-tick-os.err.log'));
  });

  it('BL-632: resolves the ACTIVE file first when a rotated `.YYYYMMDD` archive coexists', () => {
    fs.writeFileSync(path.join(dir, 'doctor-tick-os.out.log'), 'active');
    fs.writeFileSync(path.join(dir, 'doctor-tick-os.out.log.20260801'), 'archive');
    // Note: `logStreamFileMatches` already rejects `.log.<digits>` archives via
    // its `.endsWith('.log')` gate, so the finder returned the active file even
    // before the explicit active-first resolution. The exact-name short-circuit
    // makes that invariant structural rather than incidental to the guard, so a
    // future widening of the match predicate cannot reintroduce the misreport.
    expect(findMostRecentLogFile(dir, 'doctor-tick-os.out')).toBe(path.join(dir, 'doctor-tick-os.out.log'));
  });

  it('BL-632: excludes `.log.<digits>` archives even when the active file is absent (no phantom "most recent")', () => {
    fs.writeFileSync(path.join(dir, 'doctor-tick-os.out.log.20260801'), 'archive');
    expect(findMostRecentLogFile(dir, 'doctor-tick-os.out')).toBeNull();
  });
});
