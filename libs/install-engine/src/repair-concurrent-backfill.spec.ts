/**
 * repair-concurrent-backfill.spec.ts — H3 (D-B Migration §3 lost update).
 *
 * `backfillHashes` must NOT erase a record a concurrent install wrote to
 * `ownership.json` between the backfill's read and its write. Pre-fix it read the
 * whole index with `readOwnership`, mutated `contentHash` in place, and published
 * the WHOLE snapshot with `writeOwnershipAtomic` — a classic lost update that
 * silently dropped another writer's record (an untracked injection an uninstall
 * could then never reverse). Post-fix it routes through `OwnershipIndex`
 * (strict-load once → `backfillContentHashes` marks touched records dirty →
 * `save()`'s read-merge-verify loop), so the concurrent record survives.
 *
 * The interleaving is latched deterministically (no sleep, no real second
 * process): we intercept the ONE read of the ownership file and, immediately
 * after that read returns, a second `OwnershipIndex` records its own entry and
 * saves — exactly the "wrote between our read and our rename" race.
 *
 * `node:fs` is mocked at the module level (hoisted) because vitest cannot spy on
 * the named ESM exports of `node:fs` once a module binds them (same reason as
 * embedding-provider's competing-host-cache.spec.ts). Only `readFileSync` is
 * overridden; everything else passes through to the real filesystem, so the
 * concurrent writer's atomic publish is genuinely exercised.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';

const h = vi.hoisted(() => ({
  actualFs: undefined as unknown as typeof import('node:fs'),
  interceptPath: '',
  onRead: undefined as (() => void) | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  h.actualFs = actual;
  return {
    ...actual,
    readFileSync: ((p: unknown, ...rest: unknown[]) => {
      const out = (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
      if (h.onRead !== undefined && String(p) === h.interceptPath) {
        const cb = h.onRead;
        h.onRead = undefined; // one-shot: never re-enter the interceptor
        cb();
      }
      return out;
    }) as typeof actual.readFileSync,
  };
});

// Bound AFTER the mock so this module graph resolves node:fs to the mock.
const { OwnershipIndex, readOwnership } = await import('./ownership.js');
const { ownershipPathFor } = await import('./data-paths.js');
const { backfillHashes, countUnverifiable } = await import('./repair.js');

let dir: string;

beforeEach(() => {
  dir = h.actualFs.mkdtempSync(path.join(os.tmpdir(), 'sox-h3-'));
});

afterEach(() => {
  h.actualFs.rmSync(dir, { recursive: true, force: true });
  h.interceptPath = '';
  h.onRead = undefined;
});

describe('H3 — backfillHashes merges with a concurrent writer (no lost update)', () => {
  it('a record written after the backfill read survives the backfill write', () => {
    const own = ownershipPathFor('project', dir);
    const targetA = path.join(dir, 'a.md');
    h.actualFs.writeFileSync(targetA, 'AAAA');

    // Seed ext 'A' with a hashless entry — the thing being backfilled.
    const seed = OwnershipIndex.loadFromFile(own, { strict: true });
    seed.record({
      extId: 'A',
      scope: 'project',
      entries: [{ kind: 'file-drop', path: targetA }],
    });
    seed.save();
    expect(countUnverifiable('project', dir)).toBe(1);

    // Arm the race: the instant the backfill reads ownership.json, a concurrent
    // writer records ext 'B' and saves (a different extension — both must persist).
    h.interceptPath = own;
    h.onRead = () => {
      const concurrent = OwnershipIndex.loadFromFile(own, { strict: true });
      concurrent.record({
        extId: 'B',
        scope: 'project',
        entries: [{ kind: 'file-drop', path: path.join(dir, 'b.md') }],
      });
      concurrent.save();
    };

    const report = backfillHashes('project', dir);
    expect(report.filled).toBe(1);

    // The concurrent record 'B' MUST still be present (pre-fix: erased).
    const after = readOwnership(own);
    expect(after.owned.map((r) => r.extId).sort()).toEqual(['A', 'B']);

    // …and A's backfilled hash was persisted (the backfill's own work landed).
    const a = after.owned.find((r) => r.extId === 'A')!;
    const aEntry = a.entries[0]!;
    expect(aEntry.kind === 'file-drop' && aEntry.contentHash).toBeTruthy();
  });
});
