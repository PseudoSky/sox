/**
 * db-artifact-lifecycle.spec.ts — D-B unit + negative controls:
 *   S1  atomic-write (unique temp by construction, never a fixed `.tmp`)
 *   SR-8 malformed index is loud (typed error, never an empty read)
 *   AC3 drift verdicts are HASH-based (same-size, same-mtime edit ⇒ drifted)
 *   AC4 detectDrift mutates nothing
 *   AC6 lockfile ↔ installed reconciliation, both directions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicWriteFileSync, withReconciledRetry } from './atomic-write.js';
import {
  OwnershipIndex,
  OwnershipCorruptError,
  OwnershipConflictError,
  OwnershipWriteError,
  type OwnedEntry,
} from './ownership.js';
import { ownershipPathFor, scopeConfigPaths } from './data-paths.js';
import { detectDrift } from './drift.js';
import { reconcile } from './reconcile.js';
import { backfillHashes, countUnverifiable } from './repair.js';

const sha256 = (p: string): string =>
  'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

let dir: string;
let own: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-db-life-'));
  own = path.join(dir, 'ownership.json');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── S1: atomic-write ──────────────────────────────────────────────────────────

describe('atomicWriteFileSync — S1 (B-I1)', () => {
  it('publishes content atomically and leaves no `.tmp` residue', () => {
    const target = path.join(dir, 'out.json');
    atomicWriteFileSync(target, '{"a":1}');
    expect(fs.readFileSync(target, 'utf8')).toBe('{"a":1}');
    const residue = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
    expect(residue).toEqual([]);
  });

  it('a pre-existing fixed `.<name>.tmp` is NEVER used or disturbed (unique temp by construction)', () => {
    const target = path.join(dir, 'out.json');
    const fixedTmp = target + '.tmp';
    fs.writeFileSync(fixedTmp, 'SENTINEL-DO-NOT-TOUCH');
    atomicWriteFileSync(target, 'fresh');
    // The unique-temp publisher never touches the legacy fixed name.
    expect(fs.readFileSync(fixedTmp, 'utf8')).toBe('SENTINEL-DO-NOT-TOUCH');
    expect(fs.readFileSync(target, 'utf8')).toBe('fresh');
  });

  it('50 back-to-back writes never collide and never leave residue', () => {
    const target = path.join(dir, 'many.json');
    for (let i = 0; i < 50; i++) atomicWriteFileSync(target, `{"i":${i}}`);
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ i: 49 });
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('withReconciledRetry retries OwnershipConflictError, then succeeds', () => {
    let n = 0;
    const out = withReconciledRetry(dir, () => {
      n++;
      if (n < 3) throw new OwnershipConflictError(dir);
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(n).toBe(3);
  });

  it('withReconciledRetry rethrows a non-conflict error immediately', () => {
    let n = 0;
    expect(() =>
      withReconciledRetry(dir, () => {
        n++;
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(n).toBe(1);
  });
});

// ─── SR-8: malformed index is loud ─────────────────────────────────────────────

describe('SR-8 — a malformed ownership index is a loud typed error, never `{owned: []}`', () => {
  it('readOwnership throws OwnershipCorruptError (both modes) naming the file', () => {
    fs.writeFileSync(own, '{ not json');
    expect(() => OwnershipIndex.loadFromFile(own, { strict: true })).toThrow(OwnershipCorruptError);
    expect(() => OwnershipIndex.loadFromFile(own)).toThrow(OwnershipCorruptError);
    try {
      OwnershipIndex.loadFromFile(own, { strict: true });
    } catch (e) {
      expect((e as OwnershipCorruptError).filePath).toBe(own);
    }
  });

  it('OwnershipWriteError names the extension and scope', () => {
    const e = new OwnershipWriteError('ext-x', 'project', new Error('cause'));
    expect(e.extId).toBe('ext-x');
    expect(e.scope).toBe('project');
    expect(e.message).toContain('ext-x');
    expect(e.message).toContain('[inv:no-untracked-injection]');
  });
});

// ─── drift helpers ─────────────────────────────────────────────────────────────

/** The scope-resolved ownership path detectDrift/reconcile read for scope 'project'. */
const scopeOwn = (): string => ownershipPathFor('project', dir);

function seedOwnership(records: Array<{ extId: string; entries: OwnedEntry[] }>): void {
  const idx = OwnershipIndex.loadFromFile(scopeOwn(), { strict: true });
  for (const r of records) idx.addEntries(r.extId, 'project', r.entries);
  idx.save();
}

describe('AC3 — drift verdicts are HASH-based (B-I4)', () => {
  it('still-valid / drifted / gone / foreign / unverifiable', async () => {
    const managed = path.join(dir, 'managed');
    fs.mkdirSync(managed, { recursive: true });
    const stable = path.join(managed, 'stable.md');
    const edited = path.join(managed, 'edited.md');
    const deleted = path.join(managed, 'deleted.md');
    const legacy = path.join(managed, 'legacy.md');
    const FIXED = new Date(1_700_000_000_000); // a stable instant for the mtime proof
    fs.writeFileSync(stable, 'STABLE');
    fs.writeFileSync(edited, 'AAAA');
    fs.utimesSync(edited, FIXED, FIXED);
    fs.writeFileSync(deleted, 'DELETE');
    fs.writeFileSync(legacy, 'LEGACY');

    seedOwnership([{ extId: 'e', entries: [
      { kind: 'file-drop', path: stable, contentHash: sha256(stable) },
      { kind: 'file-drop', path: edited, contentHash: sha256(edited) },
      { kind: 'file-drop', path: deleted, contentHash: sha256(deleted) },
      { kind: 'file-drop', path: legacy }, // no contentHash → unverifiable
    ] }]);

    // Same-size edit + mtime reset to the SAME fixed instant → only a hash can see it.
    const before = fs.statSync(edited);
    fs.writeFileSync(edited, 'BBBB'); // same byte length
    fs.utimesSync(edited, FIXED, FIXED); // same mtime as recorded pre-edit
    const after = fs.statSync(edited);
    expect(after.size).toBe(before.size);       // size unchanged
    expect(after.mtimeMs).toBe(before.mtimeMs); // mtime unchanged (same fixed instant)

    fs.rmSync(deleted);
    fs.writeFileSync(path.join(managed, 'foreign.md'), 'stranger');

    const report = await detectDrift('project', dir);
    const by = (t: string) => report.entries.find((e) => e.target === t)?.verdict;
    expect(by(stable)).toBe('still-valid');
    expect(by(edited)).toBe('drifted');    // NC: mtime/size would have said still-valid
    expect(by(deleted)).toBe('gone');
    expect(by(legacy)).toBe('unverifiable');
    expect(report.entries.filter((e) => e.verdict === 'foreign').map((e) => e.target))
      .toContain(path.join(managed, 'foreign.md'));
    expect(report.counts.drifted).toBe(1);
  });
});

describe('AC4 — detectDrift mutates NOTHING (B-I5)', () => {
  it('byte-identical managed tree before and after', async () => {
    const managed = path.join(dir, 'm');
    fs.mkdirSync(managed, { recursive: true });
    const files = ['a.md', 'b.md', 'c.md'];
    for (const f of files) fs.writeFileSync(path.join(managed, f), `content-${f}`);
    seedOwnership([{ extId: 'e', entries: files.map((f) => ({
      kind: 'file-drop' as const, path: path.join(managed, f),
      contentHash: sha256(path.join(managed, f)),
    })) }]);

    const snapshot = (): string =>
      JSON.stringify(
        fs.readdirSync(managed).sort().map((f) => ({ f, h: sha256(path.join(managed, f)) })),
      );
    const before = snapshot();
    await detectDrift('project', dir);
    expect(snapshot()).toBe(before);
    // No new files anywhere under the root (a `.last-run` cache would show here).
    expect(fs.readdirSync(managed).sort()).toEqual(files);
  });
});

// ─── AC6: reconciliation ───────────────────────────────────────────────────────

describe('AC6 — lock ↔ installed reconciliation, both directions (B-I7, read-only)', () => {
  it('reports lockOnly / installedOnly / drifted / stubs', async () => {
    const srcA = path.join(dir, 'a.js'); fs.writeFileSync(srcA, 'AAA');
    const srcB = path.join(dir, 'b.js'); fs.writeFileSync(srcB, 'BBB');
    const srcE = path.join(dir, 'e.js'); fs.writeFileSync(srcE, 'EEE');

    const lockPath = scopeConfigPaths('project', dir).lockfile;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      lockfileVersion: 2,
      resolved: {
        A: { source: `file://${srcA}`, checksum: sha256(srcA), resolved_at: 'x' },
        C: { source: `file://${path.join(dir, 'missing-c.js')}`, checksum: 'sha256:deadbeef', resolved_at: 'x' },
        E: { source: `file://${srcE}`, checksum: 'sha256:deadbeef', resolved_at: 'x' }, // wrong checksum
      },
    }));

    fs.mkdirSync(path.dirname(scopeOwn()), { recursive: true });
    seedOwnership([
      { extId: 'A', entries: [{ kind: 'file-drop', path: srcA }] },
      { extId: 'B', entries: [{ kind: 'file-drop', path: srcB }] },
      { extId: 'E', entries: [{ kind: 'file-drop', path: srcE }] },
      { extId: 'D', entries: [{ kind: 'file-drop', path: path.join(dir, 'gone-d.js') }] },
    ]);

    const before = fs.readFileSync(lockPath, 'utf8');
    const report = await reconcile('project', dir);
    const status = (id: string) => report.perExtension.find((p) => p.id === id)?.status;

    expect(status('A')).toBe('installed');
    expect(status('E')).toBe('drifted');        // present but checksum differs
    expect(status('C')).toBe('missing');        // declared but no ownership record
    expect(report.lockOnly).toEqual(['C']);
    expect(report.installedOnly.sort()).toEqual(['B', 'D']);
    expect(report.stubs).toEqual(['D']);        // installed record with no on-disk artifact
    expect(status('D')).toBe('foreign');
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(before); // read-only (B-I7)

    // NEGATIVE CONTROL: a lock-only read cannot see the installed-not-locked ext B.
    const lockOnlyView = Object.keys(JSON.parse(before).resolved);
    expect(lockOnlyView).not.toContain('B');    // the naive view misses it…
    expect(report.installedOnly).toContain('B'); // …reconcile catches it → RED for the naive view
  });
});

// ─── S5: hash backfill ─────────────────────────────────────────────────────────

describe('S5 — hash backfill fills managed entries, reports the migration delta', () => {
  it('backfills present targets, leaves absent ones unverifiable, is idempotent', async () => {
    const existing = path.join(dir, 'ex.md');
    const missing = path.join(dir, 'missing.md');
    fs.writeFileSync(existing, 'EXISTS');
    seedOwnership([{ extId: 'e', entries: [
      { kind: 'file-drop', path: existing },   // hashless, target present → backfillable
      { kind: 'materialize', path: missing },  // hashless, target absent → stays unverifiable
    ] }]);

    expect(countUnverifiable('project', dir)).toBe(2);
    const report = backfillHashes('project', dir);
    expect(report).toEqual({ before: 2, after: 1, filled: 1, missingTargets: 1 });
    expect(countUnverifiable('project', dir)).toBe(1);

    // The filled entry now reports still-valid; the absent one stays unverifiable.
    const drift = await detectDrift('project', dir);
    const by = (t: string) => drift.entries.find((e) => e.target === t)?.verdict;
    expect(by(existing)).toBe('still-valid');
    expect(by(missing)).toBe('unverifiable');

    // Idempotent: a second run fills nothing new.
    expect(backfillHashes('project', dir).filled).toBe(0);
  });
});
