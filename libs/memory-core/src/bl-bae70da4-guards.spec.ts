/**
 * bl-bae70da4-guards.spec.ts — BL-bae70da4: the two guards that back the
 * scratch-HOME redirect must actually fire.
 *
 * 1. The fs-touch guard (vitest.home-guard-setup.ts) patches the CommonJS
 *    `node:fs` object. ESM imports only see that patch after
 *    `syncBuiltinESMExports()`. The first block makes controlled, READ-ONLY
 *    calls (`existsSync` / `statSync` / `readdirSync`) against the operator's
 *    real `~/.memory` through every import shape memory-core uses, and
 *    asserts the guard recorded each one. It then drains those touches so the
 *    guard's afterEach does not fail this test for doing it on purpose.
 *    Nothing here writes to the real `~/.memory`.
 *
 * 2. The whole-run guard (vitest.global-guard.ts) must flag test-shaped
 *    artefacts and must NOT flag the live server's own churn. The second
 *    block drives its pure classifier with synthetic before/after listings.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { existsSync, statSync } from 'node:fs';
import defaultFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { drainTouches, guardedPathArgs } from '../vitest.home-guard-setup';
import { classifyMemoryRootDiff, isLiveTopLevelName } from '../vitest.global-guard';

const REAL_MEM = path.join(os.userInfo().homedir, '.memory');

describe('BL-bae70da4 fs-touch guard fires for ESM callers (read-only probes)', () => {
  it('records existsSync through an `import * as fs` namespace', () => {
    drainTouches();
    fs.existsSync(REAL_MEM);
    const touches = drainTouches();
    expect(touches.some((t) => t.startsWith(`existsSync(${REAL_MEM})`))).toBe(true);
  });

  it('records named imports, the default import, and Buffer / file: URL paths', () => {
    drainTouches();
    existsSync(path.join(REAL_MEM, 'memory.db'));
    statSync(REAL_MEM, { throwIfNoEntry: false });
    defaultFs.existsSync(Buffer.from(REAL_MEM));
    fs.existsSync(pathToFileURL(REAL_MEM));
    fs.readdirSync(os.homedir()); // scratch HOME: must NOT be recorded
    const touches = drainTouches().map((t) => t.split('\n')[0]);
    expect(touches).toEqual([
      `existsSync(${path.join(REAL_MEM, 'memory.db')})`,
      `statSync(${REAL_MEM})`,
      `existsSync(${REAL_MEM})`,
      `existsSync(${REAL_MEM})`,
    ]);
  });

  it('checks the destination argument of two-path calls and normalises relative / .. paths', () => {
    const scratch = path.join(os.homedir(), 'a');
    expect(guardedPathArgs('renameSync', [scratch, path.join(REAL_MEM, 'x')])).toEqual([
      scratch,
      path.join(REAL_MEM, 'x'),
    ]);
    expect(guardedPathArgs('copyFileSync', [scratch, pathToFileURL(path.join(REAL_MEM, 'y'))])).toEqual([
      scratch,
      path.join(REAL_MEM, 'y'),
    ]);
    expect(guardedPathArgs('cpSync', [scratch, Buffer.from(REAL_MEM)])).toEqual([scratch, REAL_MEM]);
    expect(guardedPathArgs('writeFileSync', [path.join(REAL_MEM, 'sub', '..', 'z'), 'data'])).toEqual([
      path.join(REAL_MEM, 'z'),
    ]);
    expect(guardedPathArgs('readFileSync', [3])).toEqual([]);
  });
});

describe('BL-bae70da4 global guard classifier', () => {
  const baseline = [
    '.DS_Store',
    'backups/',
    'backups/.auto-backup-abc123',
    'backups/memory-2026-09-28T01-00-00.000.db',
    'backups/memory-2026-09-28T02-00-00.000.db',
    'embed-verify.db',
    'memory.db',
    'memory.db-tshm',
    'memory.db-tshm.stale-2026-09-28-0846',
    'memory.db-wal',
    'memory.db.sox-lease.d/',
    'memory.db.sox-lease.d/.openers/',
    'memory.db.sox-lease.d/.openers/111',
    'registry.json',
    'restore-reports/',
  ];

  it('does NOT flag live-server churn: backup rotation, WAL/tshm flips, stale sidecars, leases, .DS_Store', () => {
    const after = [
      'backups/',
      'backups/.auto-backup-abc123',
      // rotation: oldest pruned, newest added (with its transient sidecar)
      'backups/memory-2026-09-28T02-00-00.000.db',
      'backups/memory-2026-09-28T03-00-00.000.db',
      'backups/memory-2026-09-28T03-00-00.000.db-wal',
      'backups/.DS_Store',
      'embed-verify.db',
      'embed-verify.db-wal', // another process opened a sibling store
      'memory.db',
      'memory.db-shm',
      // memory.db-tshm and memory.db-wal removed by checkpoint/close
      'memory.db-tshm.stale-2026-09-28-0847', // new stale sidecar, old one pruned
      'memory.db.sidecar-sweep-marker',
      'memory.db.sox-lease.d/',
      'memory.db.sox-lease.d/.openers/',
      'memory.db.sox-lease.d/.openers/222',
      'memory.db.sox-lease.d/0b9c.openmark',
      'registry.json',
      'restore-reports/',
      'restore-reports/r1.json',
      // .DS_Store removed at top level
    ];
    expect(classifyMemoryRootDiff(baseline, after)).toEqual([]);
  });

  it('recognises the modern -SSmmm-p<pid>[-<n>] stale-sidecar tail as live churn, and still flags test-shaped entries', () => {
    const modernTshm = 'memory.db-tshm.stale-2026-09-28-0846-56771-p4261';
    const modernTshmClobber = 'memory.db-tshm.stale-2026-09-28-0846-56771-p4261-1';
    const modernShm = 'memory.db-shm.stale-2026-09-28-0846-56771-p4261';
    const legacyMinute = 'memory.db-tshm.stale-2026-09-28-0846';

    // The live server's current rename shape (sidecar-retention.ts) and its
    // no-clobber variant are live churn, not test leaks.
    expect(isLiveTopLevelName(modernTshm)).toBe(true);
    expect(isLiveTopLevelName(modernTshmClobber)).toBe(true);
    expect(isLiveTopLevelName(modernShm)).toBe(true);
    expect(isLiveTopLevelName(legacyMinute)).toBe(true);

    // Negative control: a genuinely test-created top-level entry, and a
    // truncated stamp, are NOT waved through — the matcher stays strict.
    expect(isLiveTopLevelName('x.db')).toBe(false);
    expect(isLiveTopLevelName('memory.db-tshm.stale-2026-09-28')).toBe(false);

    const afterWithModernNames = [...baseline, modernTshm, modernTshmClobber];
    expect(classifyMemoryRootDiff(baseline, afterWithModernNames)).toEqual([]);

    expect(classifyMemoryRootDiff(baseline, [...baseline, 'x.db'])).toEqual([
      { change: 'added', path: 'x.db', reason: 'unknown-top-level-entry' },
    ]);
  });

  it('flags test-shaped artefacts at the top level and inside backups/, added or removed', () => {
    const after = [
      ...baseline,
      'sox-backup-test-bl385-1790579878384-zsap0j7ml2s/',
      'sox-backup-test-bl385-1790579878384-zsap0j7ml2s/memory.db',
      'backups/sox-backup-test-auto-1/',
      'backups/sox-backup-test-auto-1/memory-2026-09-28T03-00-00.000.db',
      'x.db',
      'sox-noexist-1.db-wal',
    ].filter((p) => p !== 'registry.json');
    const got = classifyMemoryRootDiff(baseline, after);
    expect(got).toEqual(
      expect.arrayContaining([
        { change: 'added', path: 'sox-backup-test-bl385-1790579878384-zsap0j7ml2s/', reason: 'test-artefact-name' },
        {
          change: 'added',
          path: 'sox-backup-test-bl385-1790579878384-zsap0j7ml2s/memory.db',
          reason: 'test-artefact-name',
        },
        { change: 'added', path: 'backups/sox-backup-test-auto-1/', reason: 'test-artefact-name' },
        {
          change: 'added',
          path: 'backups/sox-backup-test-auto-1/memory-2026-09-28T03-00-00.000.db',
          reason: 'test-artefact-name',
        },
        { change: 'added', path: 'x.db', reason: 'unknown-top-level-entry' },
        // a live-sidecar suffix must not launder a test-named stem
        { change: 'added', path: 'sox-noexist-1.db-wal', reason: 'test-artefact-name' },
        { change: 'removed', path: 'registry.json', reason: 'unknown-top-level-entry' },
      ]),
    );
    expect(got).toHaveLength(7);
  });

  it('reports nothing for identical listings (a create-then-remove inside the run is the fs guard\'s job)', () => {
    expect(classifyMemoryRootDiff(baseline, baseline)).toEqual([]);
  });
});
