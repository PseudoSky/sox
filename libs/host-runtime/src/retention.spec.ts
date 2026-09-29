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
import {
  planRetention,
  applyRetention,
  sweepTrash,
  type RootsModel,
  type RetentionPolicy,
  type RetentionPlan,
} from './retention.js';

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

describe('H1 — live roots are matched PATH-AWARE (trailing separator; no over-protecting substrings)', () => {
  it('an absolute live root WITH a trailing separator still protects its generation', () => {
    const genPath = mk('gen-1'); // path.join(dir, 'gen-1')
    // Shell tab-completion supplies the trailing separator; the old matcher
    // (`name === r || r.endsWith(name) || fullPath === r || ...`) matched none
    // of its arms, so this live-rooted generation was classified reclaimable.
    const plan = planRetention(
      dir,
      { liveGenerations: [genPath + path.sep], lockEntries: [], runningPids: [] },
      policy(),
    );
    expect(plan.reclaim.map((r) => path.basename(r.path))).not.toContain('gen-1');
    expect(plan.protected.map((p) => path.basename(p.path))).toContain('gen-1');
  });

  it('a bare live-root name WITH a trailing separator still protects its generation', () => {
    mk('gen-1');
    const plan = planRetention(
      dir,
      { liveGenerations: ['gen-1' + path.sep], lockEntries: [], runningPids: [] },
      policy(),
    );
    expect(plan.protected.map((p) => path.basename(p.path))).toContain('gen-1');
  });

  it('a short root does NOT over-protect unrelated siblings (substring arms dropped)', () => {
    mk('gen-1');
    mk('gen-11'); // `name.startsWith('gen-1')` used to protect this unrelated dir
    mk('1-other'); // `r.endsWith(name)` style: root 'gen-1' ends with '1'…
    const plan = planRetention(
      dir,
      { liveGenerations: ['gen-1'], lockEntries: [], runningPids: [] },
      policy(),
    );
    const protectedNames = plan.protected.map((p) => path.basename(p.path));
    expect(protectedNames).toContain('gen-1');
    expect(protectedNames).not.toContain('gen-11');
    expect(plan.reclaim.map((r) => path.basename(r.path)).sort()).toEqual(['1-other', 'gen-11']);
  });

  it('a root given as an ancestor directory still roots everything beneath it', () => {
    mk('gen-1');
    mk('snapshot-2020');
    // Root is the managed dir's PARENT (an ancestor of both children).
    const plan = planRetention(
      dir,
      { liveGenerations: [path.dirname(dir)], lockEntries: [], runningPids: [] },
      policy(),
    );
    expect(plan.reclaim).toEqual([]);
    expect(plan.protected).toHaveLength(2);
  });
});

describe('H2 — the trash namespace is never reclaimed (no self-nesting EINVAL)', () => {
  it('a trash dir INSIDE the managed root is excluded, so a second gc run succeeds', async () => {
    mk('gen-1');
    mk('snapshot-2020');
    const insideTrash = path.join(dir, '.trash');
    const p: RetentionPolicy = { ...policy(), trashDir: insideTrash };

    // First run: the unreferenced snapshot moves into <dir>/.trash.
    const plan1 = planRetention(dir, roots(), p);
    expect(plan1.reclaim.map((r) => path.basename(r.path))).toEqual(['snapshot-2020']);
    await applyRetention(plan1, p);
    expect(fs.existsSync(path.join(dir, 'snapshot-2020'))).toBe(false);
    expect(fs.existsSync(insideTrash)).toBe(true);

    // A gc seconds later (not the same instant): the trash dir from the PRIOR
    // run is now older than maxAgeMs, so pre-fix it is a genuine reclaim
    // candidate (`ageMs < maxAgeMs` is false) and the second apply throws EINVAL.
    fs.utimesSync(insideTrash, PAST, PAST);

    // Second run: `.trash` must NOT be a reclaim candidate (it matches no root),
    // and applyRetention must not try to rename it into its own descendant.
    const plan2 = planRetention(dir, roots(), p);
    expect(plan2.reclaim.map((r) => path.basename(r.path))).not.toContain('.trash');
    await expect(applyRetention(plan2, p)).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'gen-1'))).toBe(true); // root untouched
    expect(fs.existsSync(path.join(insideTrash, 'snapshot'))).toBe(true); // trash intact
  });

  it('applyRetention refuses an item that CONTAINS policy.trashDir (guard)', async () => {
    const managed = path.join(dir, 'sub');
    fs.mkdirSync(managed, { recursive: true });
    fs.utimesSync(managed, PAST, PAST);
    const nestedTrash = path.join(managed, 'trash');
    const plan: RetentionPlan = {
      reclaim: [{ path: managed, class: 'scratch', bytes: 1, reason: 'x' }],
      protected: [],
      unmanaged: [],
      totalBytes: 1,
    };
    await expect(applyRetention(plan, { ...policy(), trashDir: nestedTrash })).rejects.toThrow(
      /ancestor of/,
    );
    expect(fs.existsSync(managed)).toBe(true); // never moved into its own descendant
  });
});

describe('MEDIUM — a mid-loop throw leaves already-moved trees recorded (recoverable)', () => {
  it('trees moved before the throw are persisted to the manifest and remain sweepable', async () => {
    const a = mk('snapshot-a');
    const b = mk('snapshot-b');
    const bad = path.join(dir, 'sub');
    fs.mkdirSync(bad, { recursive: true });
    fs.utimesSync(bad, PAST, PAST);
    const nestedTrash = path.join(bad, 'trash');

    // A hand-built plan whose last item is an ancestor of the trash dir, so the
    // loop throws only AFTER a and b have moved.
    const plan: RetentionPlan = {
      reclaim: [
        { path: a, class: 'snapshot', bytes: 1, reason: 'x' },
        { path: b, class: 'snapshot', bytes: 1, reason: 'x' },
        { path: bad, class: 'scratch', bytes: 1, reason: 'x' },
      ],
      protected: [],
      unmanaged: [],
      totalBytes: 3,
    };
    const p: RetentionPolicy = { ...policy(), trashDir: nestedTrash };
    await expect(applyRetention(plan, p)).rejects.toThrow(/ancestor of/);

    // The moved trees are RECORDED even though the loop threw mid-way.
    const manifestPath = path.join(nestedTrash, 'manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Array<{ originalPath: string }>;
    expect(manifest.map((e) => path.basename(e.originalPath)).sort()).toEqual([
      'snapshot-a',
      'snapshot-b',
    ]);

    // …and therefore sweepable past the grace window.
    const swept = sweepTrash(nestedTrash, Date.now() + 120_000).sort();
    expect(swept).toEqual([a, b].sort());
  });
});
