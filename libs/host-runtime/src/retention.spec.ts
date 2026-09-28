/**
 * retention.spec.ts — D-B AC5 / B-I6: bounded, roots-first retention.
 *   - a rooted artifact is NEVER reclaimed (negative control proves the check has teeth)
 *   - an unreferenced artifact is trashed, survives the grace window, then sweeps
 *   - planRetention is a read-only dry run
 *   - no roots model ⇒ nothing is auto-cleaned
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { planRetention, applyRetention, sweepTrash, type RootsModel, type RetentionPolicy } from './retention.js';

let dir: string;
let trashDir: string;
const PAST = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

function mk(name: string, bytes = 'x'): string {
  const p = path.join(dir, name);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, 'content.bin'), bytes.repeat(64));
  fs.utimesSync(p, PAST, PAST);
  return p;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-ret-'));
  trashDir = path.join(dir, '..', `trash-${path.basename(dir)}`);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(trashDir, { recursive: true, force: true });
});

const policy = (): RetentionPolicy => ({ maxAgeMs: 1000, graceMs: 60_000, trashDir });
const roots = (): RootsModel => ({ liveGenerations: ['gen-1'], lockEntries: ['snapshot-live'], runningPids: [] });

describe('AC5 — retention never deletes a root; unreferenced survives the grace window', () => {
  it('plan is roots-first, read-only, and classifies candidates', () => {
    mk('gen-1');
    mk('snapshot-live');
    mk('snapshot-2020');
    mk('scratch-tmp');
    const listingBefore = fs.readdirSync(dir).sort();

    const plan = planRetention(dir, roots(), policy());

    const reclaimed = plan.reclaim.map((r) => path.basename(r.path)).sort();
    expect(reclaimed).toEqual(['scratch-tmp', 'snapshot-2020']); // sorted: 'scratch' < 'snap'
    expect(plan.reclaim.find((r) => path.basename(r.path) === 'snapshot-2020')!.class).toBe('snapshot');
    const protectedNames = plan.protected.map((p) => path.basename(p.path));
    expect(protectedNames).toContain('gen-1');        // rooted via liveGenerations
    expect(protectedNames).toContain('snapshot-live'); // rooted via lockEntries
    expect(plan.totalBytes).toBeGreaterThan(0);

    // Read-only: the dry run mutated nothing.
    expect(fs.readdirSync(dir).sort()).toEqual(listingBefore);

    // NEGATIVE CONTROL: a naive reclaim that ignores roots WOULD pick the rooted
    // gen-1 (the exact bug the roots check prevents). If it didn't, the roots
    // assertion above would be vacuous.
    const naive = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    expect(naive).toContain('gen-1');
    expect(reclaimed).not.toContain('gen-1');
  });

  it('applyRetention trashes the reclaim set, spares roots, and survives the grace window', async () => {
    mk('gen-1');
    mk('snapshot-2020');
    const plan = planRetention(dir, roots(), policy());

    await applyRetention(plan, policy());

    // The rooted tree is untouched; the candidate moved to trash.
    expect(fs.existsSync(path.join(dir, 'gen-1'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'snapshot-2020'))).toBe(false);

    // Inside the grace window: nothing is physically swept.
    expect(sweepTrash(trashDir)).toEqual([]);
    expect(fs.existsSync(trashDir)).toBe(true);

    // Past the grace window: the soft-deleted tree is swept.
    const swept = sweepTrash(trashDir, Date.now() + 120_000);
    expect(swept).toContain(path.join(dir, 'snapshot-2020'));
  });

  it('no roots model ⇒ nothing is ever eligible (all unmanaged, empty reclaim)', () => {
    mk('snapshot-2020');
    mk('whatever');
    const plan = planRetention(dir, { liveGenerations: [], lockEntries: [], runningPids: [] }, policy());
    expect(plan.reclaim).toEqual([]);
    expect(plan.unmanaged.map((p) => path.basename(p)).sort()).toEqual(['snapshot-2020', 'whatever']);
  });

  it('the age gate withholds a fresh unreferenced entry', () => {
    const fresh = path.join(dir, 'fresh-snap');
    fs.mkdirSync(fresh, { recursive: true });
    fs.writeFileSync(path.join(fresh, 'x'), 'y'); // mtime ≈ now
    const plan = planRetention(dir, roots(), { ...policy(), maxAgeMs: 60_000 });
    expect(plan.reclaim.map((r) => path.basename(r.path))).not.toContain('fresh-snap');
    expect(plan.protected.map((p) => path.basename(p.path))).toContain('fresh-snap');
  });
});
