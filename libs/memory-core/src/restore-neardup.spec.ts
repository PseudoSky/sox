/**
 * restore-neardup.spec.ts — `memory_curate op: 'restore_neardup'`.
 *
 * THE DEFECT this op remediates: an automatic near-duplicate pass invalidated
 * 852 episodes, of which 689 sit on a live inferred SAME_AS edge. A triage run
 * classified those 689 component-wise on LEXICAL measures only (Jaccard / LCS /
 * containment / length ratio). Embedding cosine sat at 0.95–1.00 across every
 * class and does not discriminate; an AGE rule is what selected the 260 parent
 * documents for destruction in the first place. Neither signal may appear in
 * this code path, in any form.
 *
 * These tests run against a throwaway fixture store under os.tmpdir(). Nothing
 * here opens ~/.memory — every call passes an explicit adapter.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { openDb } from './db.js';
import { memoryCurate } from './curate.js';
import { WriteQueue } from './write-queue.js';
import { _setEmbedProviderForTest, _resetEmbedSingleton } from './embed.js';
import { DeterministicTestProvider } from './embed-test-provider.js';
import { _resetTelemetryForTest } from './telemetry.js';

let dir: string;
let db: StoreAdapter;

const T_INVALID = '2026-09-01T00:00:00.000Z';

beforeEach(async () => {
  _resetTelemetryForTest();
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'restore-neardup-')));
  // report_path is confined to ~/.memory/** by default; the fixture grants its
  // own tmpdir the same way an operator would, rather than weakening the guard.
  process.env['SOX_RESTORE_REPORT_ROOTS'] = dir;
  db = await openDb(path.join(dir, 'm.db'));
  await WriteQueue.clearInstances();
  WriteQueue.setBypass(false);
  _setEmbedProviderForTest(new DeterministicTestProvider());
});

afterEach(async () => {
  _resetTelemetryForTest();
  _resetEmbedSingleton();
  await WriteQueue.clearInstances();
  await db.close().catch(() => { /* already closed */ });
  delete process.env['SOX_RESTORE_REPORT_ROOTS'];
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Fixture helpers ───────────────────────────────────────────────────────────

async function insertEpisode(
  uid: string,
  content: string,
  opts: { invalid?: string | null; tCreated?: string; meta?: unknown } = {},
): Promise<number> {
  const info = await db.executeRun(
    `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid, t_invalid, meta)
     VALUES (?, 'episode', ?, ?, ?, ?, ?, ?)`,
    [
      uid,
      content,
      crypto.createHash('sha256').update(uid).digest('hex'),
      opts.tCreated ?? '2026-01-01T00:00:00.000Z',
      opts.tCreated ?? '2026-01-01T00:00:00.000Z',
      opts.invalid ?? null,
      opts.meta === undefined ? null : JSON.stringify(opts.meta),
    ],
  );
  return Number(info.lastInsertRowid);
}

async function insertEdge(
  srcRowid: number,
  dstRowid: number,
  rel: string,
  origin: string,
  live = true,
): Promise<void> {
  await db.executeRun(
    `INSERT INTO edge (src, dst, rel, origin, t_created, t_invalid) VALUES (?, ?, ?, ?, ?, ?)`,
    [srcRowid, dstRowid, rel, origin, '2026-01-01T00:00:00.000Z', live ? null : T_INVALID],
  );
}

async function tInvalidOf(uid: string): Promise<string | null> {
  const row = await db.executeGet<{ t_invalid: string | null }>(
    `SELECT t_invalid FROM node WHERE uid = ?`,
    [uid],
  );
  return row?.t_invalid ?? null;
}

async function metaOf(uid: string): Promise<Record<string, unknown> | null> {
  const row = await db.executeGet<{ meta: string | null }>(`SELECT meta FROM node WHERE uid = ?`, [uid]);
  if (!row?.meta) return null;
  return JSON.parse(row.meta) as Record<string, unknown>;
}

interface FixtureComponent {
  comp: number;
  cls: string;
  members: Array<{ uid: string; invalid: boolean }>;
  pairs: Array<Record<string, unknown>>;
  derivedFromPairs: number;
  maxJ: number;
  size: number;
  invalid: number;
  live: number;
}

function reportFor(components: FixtureComponent[]): { path: string; sha256: string } {
  const body = JSON.stringify({ summary: { fixture: true }, components }, null, 1);
  const p = path.join(dir, 'triage.json');
  fs.writeFileSync(p, body);
  return { path: p, sha256: crypto.createHash('sha256').update(body).digest('hex') };
}

function pair(a: string, b: string, jaccard: number, derived = false): Record<string, unknown> {
  return {
    a,
    b,
    jaccard,
    lcs_norm: jaccard,
    containment: jaccard,
    len_ratio: jaccard,
    len_a: 100,
    len_b: 100,
    derived_from: derived,
    cosine_recorded: 0.99,
  };
}

/**
 * The canonical two-component fixture:
 *   comp 1 — FALSE-POSITIVE, one invalidated member (restorable, floor)
 *   comp 2 — TRUE-DUPLICATE, one invalidated member (must stay collapsed)
 */
async function buildCanonicalFixture(): Promise<{ report: { path: string; sha256: string } }> {
  const a = await insertEpisode('FIXFP0000000000000000000A', 'alpha beta gamma delta parent document text');
  const b = await insertEpisode('FIXFP0000000000000000000B', 'alpha beta gamma chunk', { invalid: T_INVALID });
  await insertEdge(a, b, 'SAME_AS', 'inferred');

  const c = await insertEpisode('FIXTD0000000000000000000C', 'identical duplicate row content here');
  const d = await insertEpisode('FIXTD0000000000000000000D', 'identical duplicate row content here', {
    invalid: T_INVALID,
  });
  await insertEdge(c, d, 'SAME_AS', 'inferred');

  const report = reportFor([
    {
      comp: 1,
      size: 2,
      invalid: 1,
      live: 1,
      cls: 'FALSE-POSITIVE',
      derivedFromPairs: 0,
      maxJ: 0.31,
      members: [
        { uid: 'FIXFP0000000000000000000A', invalid: false },
        { uid: 'FIXFP0000000000000000000B', invalid: true },
      ],
      pairs: [pair('FIXFP0000000000000000000A', 'FIXFP0000000000000000000B', 0.31)],
    },
    {
      comp: 2,
      size: 2,
      invalid: 1,
      live: 1,
      cls: 'TRUE-DUPLICATE',
      derivedFromPairs: 0,
      maxJ: 1.0,
      members: [
        { uid: 'FIXTD0000000000000000000C', invalid: false },
        { uid: 'FIXTD0000000000000000000D', invalid: true },
      ],
      pairs: [pair('FIXTD0000000000000000000C', 'FIXTD0000000000000000000D', 1.0)],
    },
  ]);
  return { report };
}

function comps(result: unknown): Array<Record<string, any>> {
  return (result as { components: Array<Record<string, any>> }).components;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('restore_neardup — dry-run gate', () => {
  it('defaults to dry_run when the caller passes NO dry_run key at all, and mutates nothing', async () => {
    const { report } = await buildCanonicalFixture();

    const result = await memoryCurate(db, { op: 'restore_neardup', report_path: report.path });

    expect('code' in result).toBe(false);
    expect((result as { dry_run: boolean }).dry_run).toBe(true);
    // Nothing moved.
    expect(await tInvalidOf('FIXFP0000000000000000000B')).toBe(T_INVALID);
    expect(await tInvalidOf('FIXTD0000000000000000000D')).toBe(T_INVALID);
    expect(await metaOf('FIXFP0000000000000000000B')).toBeNull();
  });

  it('dry_run: true is also a no-op and emits the full per-component plan', async () => {
    const { report } = await buildCanonicalFixture();

    const result = await memoryCurate(db, {
      op: 'restore_neardup',
      report_path: report.path,
      dry_run: true,
    });

    const plan = comps(result);
    expect(plan).toHaveLength(2);
    const fp = plan.find((c) => c.component_id === 1)!;
    const td = plan.find((c) => c.component_id === 2)!;
    expect(fp.eligible).toBe(true);
    expect(fp.policy_band).toBe('FLOOR');
    expect(td.eligible).toBe(false);
    expect(td.policy_band).toBe('WITHHELD_TRUE_DUPLICATE');
    // All four lexical metrics travel in the plan.
    expect(Object.keys(fp.members.find((m: any) => m.uid.startsWith('FIXFP'))!.metrics ?? {}).sort())
      .toEqual(['containment', 'jaccard', 'lcs_norm', 'len_ratio']);
    expect(await tInvalidOf('FIXFP0000000000000000000B')).toBe(T_INVALID);
  });

  it('states the policy provenance and the out-of-scope edge-less count', async () => {
    const { report } = await buildCanonicalFixture();
    // One invalidated episode with NO SAME_AS edge at all — structurally invisible.
    await insertEpisode('FIXORPHAN00000000000000EE', 'orphan invalidated episode', { invalid: T_INVALID });

    const result = (await memoryCurate(db, {
      op: 'restore_neardup',
      report_path: report.path,
    })) as any;

    expect(result.policy.floor_plus_ambiguous).toBe(true);
    expect(result.policy.note).toMatch(/policy choice, not a measured recoverable count/i);
    expect(result.summary.out_of_scope_edgeless_invalidated_episodes).toBe(1);
    // The arithmetic is STATED, not left to be derived.
    expect(result.headline).toMatch(/PLANNED 1 of 1 policy-scope members/);
    expect(result.headline).toMatch(/1 invalidated episodes carry NO SAME_AS edge and are OUT OF SCOPE/);
    expect(result.headline).toMatch(/POLICY CHOICE, not a measured recoverable count/);
    const r = result.summary.policy_scope_reconciliation;
    expect(r.planned + r.withheld_intent_superseded).toBe(r.policy_scope_members);
    expect(r.policy_scope_members + r.withheld_true_duplicate).toBe(r.same_as_population);
    expect(r.floor + r.policy_ambiguous).toBe(r.planned);
  });
});

describe('restore_neardup — apply', () => {
  it('restores the FALSE-POSITIVE member and leaves the TRUE-DUPLICATE member collapsed', async () => {
    const { report } = await buildCanonicalFixture();

    const result = (await memoryCurate(db, {
      op: 'restore_neardup',
      report_path: report.path,
      dry_run: false,
    })) as any;

    expect(result.summary.members_restored).toBe(1);
    expect(result.summary.members_withheld_true_duplicate).toBe(1);
    expect(await tInvalidOf('FIXFP0000000000000000000B')).toBeNull();
    expect(await tInvalidOf('FIXTD0000000000000000000D')).toBe(T_INVALID);
  });

  it('never deletes a SAME_AS edge', async () => {
    const { report } = await buildCanonicalFixture();
    const before = await db.executeGet<{ c: number }>(
      `SELECT COUNT(*) AS c FROM edge WHERE rel = 'SAME_AS'`,
    );
    await memoryCurate(db, { op: 'restore_neardup', report_path: report.path, dry_run: false });
    const after = await db.executeGet<{ c: number }>(
      `SELECT COUNT(*) AS c FROM edge WHERE rel = 'SAME_AS' AND t_invalid IS NULL`,
    );
    expect(after!.c).toBe(before!.c);
  });

  it('is idempotent — a second apply restores nothing', async () => {
    const { report } = await buildCanonicalFixture();
    const first = (await memoryCurate(db, {
      op: 'restore_neardup',
      report_path: report.path,
      dry_run: false,
    })) as any;
    expect(first.summary.members_restored).toBe(1);

    const second = (await memoryCurate(db, {
      op: 'restore_neardup',
      report_path: report.path,
      dry_run: false,
    })) as any;
    expect(second.summary.members_restored).toBe(0);
    // 3 = both components' surviving anchors (never invalidated) + the member
    // this op restored on the first pass. `already_live` is now evaluated
    // FIRST, ahead of every guard, so it means exactly "no action needed" —
    // including for the TRUE-DUPLICATE component's live anchor. Idempotency is
    // "already live ⇒ no-op", which is the same state for all three.
    expect(second.summary.members_already_live).toBe(3);
    // meta.restoredFrom written once, not twice-nested.
    const meta = (await metaOf('FIXFP0000000000000000000B')) as any;
    expect(meta.restoredFrom.prior_t_invalid).toBe(T_INVALID);
  });

  it('refuses to apply without a triage report', async () => {
    await buildCanonicalFixture();
    const result = (await memoryCurate(db, { op: 'restore_neardup', dry_run: false })) as any;
    expect(result.code).toBe('E_MISSING');
  });
});

describe('restore_neardup — structural guards', () => {
  it('never clears t_invalid on a node with no live inferred SAME_AS edge', async () => {
    // Three shapes that must all be refused:
    //  - no edge at all
    //  - an EXPIRED/invalidated SAME_AS edge
    //  - a user_asserted (manual merge) SAME_AS edge — intent, not an automatic pass
    const live = await insertEpisode('GUARDLIVE000000000000000L', 'live anchor content');
    const noEdge = await insertEpisode('GUARDNOEDGE00000000000001', 'no edge invalid content', {
      invalid: T_INVALID,
    });
    const deadEdge = await insertEpisode('GUARDDEAD0000000000000002', 'dead edge invalid content', {
      invalid: T_INVALID,
    });
    const manual = await insertEpisode('GUARDMANUAL000000000000003', 'manual merge invalid content', {
      invalid: T_INVALID,
    });
    await insertEdge(live, deadEdge, 'SAME_AS', 'inferred', false);
    await insertEdge(live, manual, 'SAME_AS', 'user_asserted', true);

    const report = reportFor([
      {
        comp: 1,
        size: 4,
        invalid: 3,
        live: 1,
        cls: 'FALSE-POSITIVE',
        derivedFromPairs: 0,
        maxJ: 0.2,
        members: [
          { uid: 'GUARDLIVE000000000000000L', invalid: false },
          { uid: 'GUARDNOEDGE00000000000001', invalid: true },
          { uid: 'GUARDDEAD0000000000000002', invalid: true },
          { uid: 'GUARDMANUAL000000000000003', invalid: true },
        ],
        pairs: [
          pair('GUARDLIVE000000000000000L', 'GUARDNOEDGE00000000000001', 0.2),
          pair('GUARDLIVE000000000000000L', 'GUARDDEAD0000000000000002', 0.2),
          pair('GUARDLIVE000000000000000L', 'GUARDMANUAL000000000000003', 0.2),
        ],
      },
    ]);
    void noEdge;

    const result = (await memoryCurate(db, {
      op: 'restore_neardup',
      report_path: report.path,
      dry_run: false,
    })) as any;

    expect(result.summary.members_restored).toBe(0);
    expect(await tInvalidOf('GUARDNOEDGE00000000000001')).toBe(T_INVALID);
    expect(await tInvalidOf('GUARDDEAD0000000000000002')).toBe(T_INVALID);
    expect(await tInvalidOf('GUARDMANUAL000000000000003')).toBe(T_INVALID);

    // THE MECHANISM, not just the outcome. Asserting only members_restored===0
    // and three unchanged t_invalid values passes just as happily when the
    // nodes were skipped for an unrelated reason (membership divergence) — the
    // BL-167 shape: a test named for an invariant that never checks it. These
    // three must be refused for THE EDGE REASON, and the counter must say so.
    const byUid = new Map<string, any>(
      comps(result)[0]!.members.map((m: any) => [m.uid, m]),
    );
    expect(byUid.get('GUARDNOEDGE00000000000001').action).toBe('no_live_inferred_same_as');
    expect(byUid.get('GUARDDEAD0000000000000002').action).toBe('no_live_inferred_same_as');
    expect(byUid.get('GUARDMANUAL000000000000003').action).toBe('no_live_inferred_same_as');
    expect(result.summary.members_no_live_inferred_same_as).toBe(3);
  });

  it('withholds a node carrying a live SUPERSEDES edge, and records the override when forced', async () => {
    const { report } = await buildCanonicalFixture();
    const rows = await db.executeAll<{ rowid: number; uid: string }>(
      `SELECT rowid, uid FROM node WHERE uid IN (?, ?)`,
      ['FIXFP0000000000000000000A', 'FIXFP0000000000000000000B'],
    );
    const byUid = new Map(rows.rows.map((r) => [r.uid, r.rowid]));
    await insertEdge(
      byUid.get('FIXFP0000000000000000000A')!,
      byUid.get('FIXFP0000000000000000000B')!,
      'SUPERSEDES',
      'user_asserted',
    );

    const withheld = (await memoryCurate(db, {
      op: 'restore_neardup',
      report_path: report.path,
      dry_run: false,
    })) as any;
    expect(withheld.summary.members_restored).toBe(0);
    expect(withheld.summary.members_intent_superseded).toBe(1);
    // A component whose only invalidated member is withheld by a guard must
    // NOT be reported as "no invalidated members" — that would read, in a
    // dry-run-vs-report diff, as the report being wrong about the component.
    const fp = comps(withheld).find((c) => c.component_id === 1)!;
    expect(fp.status).toBe('all_members_withheld_by_guard');
    expect(withheld.summary.components_all_members_withheld_by_guard).toBe(1);
    // …and the shortfall is stated in the headline, with the way to close it.
    expect(withheld.headline).toMatch(/PLANNED 0 of 1 policy-scope members/);
    expect(withheld.headline).toMatch(/restore_superseded: true/);
    expect(await tInvalidOf('FIXFP0000000000000000000B')).toBe(T_INVALID);

    const forced = (await memoryCurate(db, {
      op: 'restore_neardup',
      report_path: report.path,
      dry_run: false,
      restore_superseded: true,
    })) as any;
    expect(forced.summary.members_restored).toBe(1);
    const meta = (await metaOf('FIXFP0000000000000000000B')) as any;
    expect(meta.restoredFrom.intent_superseded_override).toBe(true);
  });

  it('skips a component whose store membership diverges from the report', async () => {
    const { report } = await buildCanonicalFixture();
    // A new pair arrived after the report was written: comp 1 grew a third member.
    const extra = await insertEpisode('FIXNEW0000000000000000EXT', 'late arriving member');
    const aRow = await db.executeGet<{ rowid: number }>(`SELECT rowid FROM node WHERE uid = ?`, [
      'FIXFP0000000000000000000A',
    ]);
    await insertEdge(aRow!.rowid, extra, 'SAME_AS', 'inferred');

    const result = (await memoryCurate(db, {
      op: 'restore_neardup',
      report_path: report.path,
      dry_run: false,
    })) as any;

    const fp = comps(result).find((c) => c.component_id === 1)!;
    expect(fp.status).toBe('membership_divergence');
    expect(result.summary.components_membership_divergence).toBe(1);
    expect(await tInvalidOf('FIXFP0000000000000000000B')).toBe(T_INVALID);
  });

  it('halts rather than re-restoring a node that was re-invalidated after a restore', async () => {
    const { report } = await buildCanonicalFixture();
    await memoryCurate(db, { op: 'restore_neardup', report_path: report.path, dry_run: false });
    // Simulate the automatic pass still being live: it re-invalidates a restored node.
    await db.executeRun(`UPDATE node SET t_invalid = ? WHERE uid = ?`, [
      '2026-09-10T00:00:00.000Z',
      'FIXFP0000000000000000000B',
    ]);

    const result = (await memoryCurate(db, {
      op: 'restore_neardup',
      report_path: report.path,
      dry_run: false,
    })) as any;

    expect(result.code).toBe('E_REINVALIDATED_AFTER_RESTORE');
    // And it did NOT quietly re-restore.
    expect(await tInvalidOf('FIXFP0000000000000000000B')).toBe('2026-09-10T00:00:00.000Z');
  });
});

describe('restore_neardup — provenance and reversal', () => {
  it('meta.restoredFrom round-trips and supports an exact reversal', async () => {
    const { report } = await buildCanonicalFixture();
    await memoryCurate(db, {
      op: 'restore_neardup',
      report_path: report.path,
      dry_run: false,
      bl_id: 'BL-TEST',
    });

    const meta = (await metaOf('FIXFP0000000000000000000B')) as any;
    const rf = meta.restoredFrom;
    expect(rf.op).toBe('restore_neardup');
    expect(rf.bl_id).toBe('BL-TEST');
    expect(rf.prior_t_invalid).toBe(T_INVALID);
    expect(rf.component_id).toBe(1);
    expect(rf.component_members.sort()).toEqual([
      'FIXFP0000000000000000000A',
      'FIXFP0000000000000000000B',
    ]);
    expect(rf.class).toBe('FALSE-POSITIVE');
    expect(Object.keys(rf.metrics).sort()).toEqual([
      'containment',
      'jaccard',
      'lcs_norm',
      'len_ratio',
    ]);
    expect(rf.report.sha256).toBe(report.sha256);
    expect(typeof rf.at).toBe('string');

    // The documented reversal, executed VERBATIM as the op itself reports it —
    // so the shipped undo string is what the test proves, not a paraphrase.
    const applied = (await memoryCurate(db, {
      op: 'restore_neardup',
      report_path: report.path,
    })) as any;
    expect(applied.reversal.sql).toContain('restoredFrom.prior_t_invalid');
    await db.executeRun(applied.reversal.sql);
    expect(await tInvalidOf('FIXFP0000000000000000000B')).toBe(T_INVALID);

    // And a reversal is itself reversible — the op restores it again.
    const again = (await memoryCurate(db, {
      op: 'restore_neardup',
      report_path: report.path,
      dry_run: false,
      allow_rerestore: true,
    })) as any;
    expect(again.summary.members_restored).toBe(1);
    expect(await tInvalidOf('FIXFP0000000000000000000B')).toBeNull();
  });

  it('preserves pre-existing node.meta keys when merging restoredFrom', async () => {
    const a = await insertEpisode('METAKEEP0000000000000000A', 'alpha beta gamma parent text');
    const b = await insertEpisode('METAKEEP0000000000000000B', 'alpha delta chunk text', {
      invalid: T_INVALID,
      meta: { subject: 'keepme', nested: { x: 1 } },
    });
    await insertEdge(a, b, 'SAME_AS', 'inferred');
    const report = reportFor([
      {
        comp: 7,
        size: 2,
        invalid: 1,
        live: 1,
        cls: 'AMBIGUOUS',
        derivedFromPairs: 0,
        maxJ: 0.8,
        members: [
          { uid: 'METAKEEP0000000000000000A', invalid: false },
          { uid: 'METAKEEP0000000000000000B', invalid: true },
        ],
        pairs: [pair('METAKEEP0000000000000000A', 'METAKEEP0000000000000000B', 0.8)],
      },
    ]);

    await memoryCurate(db, { op: 'restore_neardup', report_path: report.path, dry_run: false });

    const meta = (await metaOf('METAKEEP0000000000000000B')) as any;
    expect(meta.subject).toBe('keepme');
    expect(meta.nested).toEqual({ x: 1 });
    expect(meta.restoredFrom.class).toBe('AMBIGUOUS');
    expect(meta.restoredFrom.policy_band).toBe('POLICY_AMBIGUOUS');
  });
});

describe('restore_neardup — banned signals', () => {
  it('produces a byte-identical plan when every t_created is permuted', async () => {
    // The longest member is also the OLDEST — the exact shape an age rule
    // destroyed 260 times. Flipping the timestamps must change nothing.
    const mk = async (tA: string, tB: string) => {
      const a = await insertEpisode('AGEPERM00000000000000000A', 'a long parent document with much more text than its chunk', { tCreated: tA });
      const b = await insertEpisode('AGEPERM00000000000000000B', 'a long parent document', {
        invalid: T_INVALID,
        tCreated: tB,
      });
      await insertEdge(a, b, 'SAME_AS', 'inferred');
      return reportFor([
        {
          comp: 3,
          size: 2,
          invalid: 1,
          live: 1,
          cls: 'PARENT-CHUNK',
          derivedFromPairs: 1,
          maxJ: 0.5,
          members: [
            { uid: 'AGEPERM00000000000000000A', invalid: false },
            { uid: 'AGEPERM00000000000000000B', invalid: true },
          ],
          pairs: [pair('AGEPERM00000000000000000A', 'AGEPERM00000000000000000B', 0.5, true)],
        },
      ]);
    };

    const r1 = await mk('2020-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
    const plan1 = (await memoryCurate(db, { op: 'restore_neardup', report_path: r1.path })) as any;

    await db.executeRun(`DELETE FROM edge`);
    await db.executeRun(`DELETE FROM node`);
    const r2 = await mk('2030-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
    const plan2 = (await memoryCurate(db, { op: 'restore_neardup', report_path: r2.path })) as any;

    expect(JSON.stringify(plan2.components)).toBe(JSON.stringify(plan1.components));
    expect(plan1.components[0].policy_band).toBe('FLOOR');
    expect(plan1.components[0].derived_from_confirmed).toBe(true);
  });

  it('the restore source carries no age, recency or cosine signal', () => {
    const src = fs.readFileSync(
      path.join(__dirname, 'restore-neardup.ts'),
      'utf8',
    );
    // Strip comments — the bans are documented in prose that necessarily names them.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
      .join('\n');
    for (const banned of [
      't_created',
      'created_at',
      'cosine',
      'cosine_sim',
      't_valid',
      'ORDER BY rowid',
      'order by rowid',
      'Date.parse',
    ]) {
      expect(code.includes(banned), `banned signal present: ${banned}`).toBe(false);
    }
  });
});

describe('restore_neardup — integrity precondition', () => {
  // MEASURED: on a Turso store with FTS, one raw node INSERT is enough to make
  // `PRAGMA integrity_check` report
  // `wrong # of entries in index __turso_internal_fts_dir_idx_fts_node_key` —
  // the same string the triage saw on the live store copy, and a documented
  // driver false positive (turso#7611). If that blocked, every apply would need
  // allow_integrity_failure and the flag would become a routine keystroke.
  it('does NOT block on the turso#7611 FTS false positive — no override needed', async () => {
    const { report } = await buildCanonicalFixture();

    const dry = (await memoryCurate(db, { op: 'restore_neardup', report_path: report.path })) as any;
    expect(dry.integrity.ok).toBe(true);
    expect(dry.integrity.damage).toEqual([]);
    expect(dry.integrity.suppressed.join(' ')).toMatch(/__turso_internal_fts_dir_/);
    expect(dry.integrity.suppression_valid_for).toBe('0.7.1');

    const apply = (await memoryCurate(db, {
      op: 'restore_neardup',
      report_path: report.path,
      dry_run: false,
    })) as any;
    expect(apply.code).toBeUndefined();
    expect(apply.summary.members_restored).toBe(1);
    const meta = (await metaOf('FIXFP0000000000000000000B')) as any;
    expect(meta.restoredFrom.integrity_at_restore.ok).toBe(true);
    expect(meta.restoredFrom.integrity_at_restore.override).toBe(false);
  });

  /** An adapter whose integrity_check reports REAL damage, everything else live. */
  function withDamage(message: string): StoreAdapter {
    return new Proxy(db, {
      get(target, prop, recv) {
        if (prop === 'executeAll') {
          return async (sql: string, params?: unknown[]) => {
            if (/integrity_check/i.test(sql)) return { rows: [{ integrity_check: message }] };
            return (target as any).executeAll(sql, params);
          };
        }
        return Reflect.get(target, prop, recv);
      },
    }) as StoreAdapter;
  }

  it('allows dry_run but refuses apply on REAL damage', async () => {
    const { report } = await buildCanonicalFixture();
    const broken = withDamage('row 12 missing from index ix_node_uid');

    const dry = (await memoryCurate(broken, { op: 'restore_neardup', report_path: report.path })) as any;
    expect(dry.dry_run).toBe(true);
    expect(dry.integrity.ok).toBe(false);
    expect(dry.integrity.damage).toEqual(['row 12 missing from index ix_node_uid']);

    const apply = (await memoryCurate(broken, {
      op: 'restore_neardup',
      report_path: report.path,
      dry_run: false,
    })) as any;
    expect(apply.code).toBe('E_INTEGRITY_NOT_OK');
    expect(await tInvalidOf('FIXFP0000000000000000000B')).toBe(T_INVALID);
  });

  it('records the override on every restored row when real damage is forced through', async () => {
    const { report } = await buildCanonicalFixture();
    const broken = withDamage('row 12 missing from index ix_node_uid');

    const forced = (await memoryCurate(broken, {
      op: 'restore_neardup',
      report_path: report.path,
      dry_run: false,
      allow_integrity_failure: true,
    })) as any;
    expect(forced.summary.members_restored).toBe(1);

    const meta = (await metaOf('FIXFP0000000000000000000B')) as any;
    expect(meta.restoredFrom.integrity_at_restore.ok).toBe(false);
    expect(meta.restoredFrom.integrity_at_restore.override).toBe(true);
    expect(meta.restoredFrom.integrity_at_restore.damage).toEqual([
      'row 12 missing from index ix_node_uid',
    ]);
  });

  it('treats a truncated integrity_check as NOT ok — "clean as far as we could see" is not clean', async () => {
    const { report } = await buildCanonicalFixture();
    const many = new Proxy(db, {
      get(target, prop, recv) {
        if (prop === 'executeAll') {
          return async (sql: string, params?: unknown[]) => {
            if (/integrity_check/i.test(sql)) {
              return {
                rows: Array.from({ length: 100 }, (_, i) => ({
                  integrity_check: `Page ${i + 1}: never used`,
                })),
              };
            }
            return (target as any).executeAll(sql, params);
          };
        }
        return Reflect.get(target, prop, recv);
      },
    }) as StoreAdapter;

    const dry = (await memoryCurate(many, { op: 'restore_neardup', report_path: report.path })) as any;
    expect(dry.integrity.damage).toEqual([]);
    expect(dry.integrity.truncated).toBe(true);
    expect(dry.integrity.ok).toBe(false);

    const apply = (await memoryCurate(many, {
      op: 'restore_neardup',
      report_path: report.path,
      dry_run: false,
    })) as any;
    expect(apply.code).toBe('E_INTEGRITY_NOT_OK');
  });
});

describe('restore_neardup — batching', () => {
  it('applies in batches and verifies the exact per-batch delta', async () => {
    const components: FixtureComponent[] = [];
    for (let i = 0; i < 5; i++) {
      const u = `BATCH${String(i).padStart(3, '0')}`;
      const a = await insertEpisode(`${u}AAAAAAAAAAAAAAAAAA`, `batch ${i} live anchor content here`);
      const b = await insertEpisode(`${u}BBBBBBBBBBBBBBBBBB`, `batch ${i} other text entirely`, {
        invalid: T_INVALID,
      });
      await insertEdge(a, b, 'SAME_AS', 'inferred');
      components.push({
        comp: i + 1,
        size: 2,
        invalid: 1,
        live: 1,
        cls: 'FALSE-POSITIVE',
        derivedFromPairs: 0,
        maxJ: 0.1,
        members: [
          { uid: `${u}AAAAAAAAAAAAAAAAAA`, invalid: false },
          { uid: `${u}BBBBBBBBBBBBBBBBBB`, invalid: true },
        ],
        pairs: [pair(`${u}AAAAAAAAAAAAAAAAAA`, `${u}BBBBBBBBBBBBBBBBBB`, 0.1)],
      });
    }
    const report = reportFor(components);

    const result = (await memoryCurate(db, {
      op: 'restore_neardup',
      report_path: report.path,
      dry_run: false,
      batch_size: 2,
    })) as any;

    expect(result.summary.members_restored).toBe(5);
    expect(result.batches).toHaveLength(3);
    for (const b of result.batches) {
      expect(b.verified).toBe(true);
      expect(b.expected_restored).toBe(b.observed_restored);
    }
    const stillInvalid = await db.executeGet<{ c: number }>(
      `SELECT COUNT(*) AS c FROM node WHERE t_invalid IS NOT NULL AND kind = 'episode'`,
    );
    expect(stillInvalid!.c).toBe(0);
  });
});

describe('restore_neardup — apply verifies authorship, not state', () => {
  it('does NOT count a row that was made live by someone else between plan and apply', async () => {
    const { report } = await buildCanonicalFixture();

    // An adapter that races us: the moment the op opens its write transaction,
    // the target row is already live and carries no restoredFrom. The UPDATE's
    // `AND t_invalid IS NOT NULL` therefore matches zero rows — but a
    // state-only check (`t_invalid IS NULL`) would happily count it, leaving a
    // row that no reversal statement can ever find.
    let raced = false;
    const racing: StoreAdapter = new Proxy(db, {
      get(target, prop, recv) {
        if (prop === 'transaction') {
          return async (fn: any, opts: any) => {
            if (!raced) {
              raced = true;
              await (target as any).executeRun(`UPDATE node SET t_invalid = NULL WHERE uid = ?`, [
                'FIXFP0000000000000000000B',
              ]);
            }
            return (target as any).transaction(fn, opts);
          };
        }
        return Reflect.get(target, prop, recv);
      },
    }) as StoreAdapter;

    const result = (await memoryCurate(racing, {
      op: 'restore_neardup',
      report_path: report.path,
      dry_run: false,
    })) as any;

    expect(result.code).toBe('E_BATCH_VERIFICATION_FAILED');
    expect(result.error.not_written).toEqual(['FIXFP0000000000000000000B']);
    expect(result.summary.members_restored).toBe(0);
    // The row is live (someone else made it so) but carries NO restoredFrom —
    // the op must not claim it.
    expect(await tInvalidOf('FIXFP0000000000000000000B')).toBeNull();
    expect(await metaOf('FIXFP0000000000000000000B')).toBeNull();
  });

  it('a failed batch returns the RESULT — partial plan, batches and reversal survive', async () => {
    const { report } = await buildCanonicalFixture();
    let raced = false;
    const racing: StoreAdapter = new Proxy(db, {
      get(target, prop, recv) {
        if (prop === 'transaction') {
          return async (fn: any, opts: any) => {
            if (!raced) {
              raced = true;
              await (target as any).executeRun(`UPDATE node SET t_invalid = NULL WHERE uid = ?`, [
                'FIXFP0000000000000000000B',
              ]);
            }
            return (target as any).transaction(fn, opts);
          };
        }
        return Reflect.get(target, prop, recv);
      },
    }) as StoreAdapter;

    const result = (await memoryCurate(racing, {
      op: 'restore_neardup',
      report_path: report.path,
      dry_run: false,
    })) as any;

    expect(result.op).toBe('restore_neardup');
    expect(result.components.length).toBe(2);
    expect(result.batches.length).toBe(1);
    expect(result.reversal.scoped_sql).toContain(report.sha256);
    expect(result.error.message).toMatch(/halted/i);
  });

  it('merges meta read INSIDE the transaction, so a concurrent meta write is not clobbered', async () => {
    const { report } = await buildCanonicalFixture();
    const racing: StoreAdapter = new Proxy(db, {
      get(target, prop, recv) {
        if (prop === 'transaction') {
          return async (fn: any, opts: any) => {
            // Someone writes meta after the plan was built.
            await (target as any).executeRun(`UPDATE node SET meta = ? WHERE uid = ?`, [
              JSON.stringify({ written_by_someone_else: true }),
              'FIXFP0000000000000000000B',
            ]);
            return (target as any).transaction(fn, opts);
          };
        }
        return Reflect.get(target, prop, recv);
      },
    }) as StoreAdapter;

    const result = (await memoryCurate(racing, {
      op: 'restore_neardup',
      report_path: report.path,
      dry_run: false,
    })) as any;
    expect(result.summary.members_restored).toBe(1);

    const meta = (await metaOf('FIXFP0000000000000000000B')) as any;
    expect(meta.written_by_someone_else).toBe(true); // NOT clobbered by the plan-time snapshot
    expect(meta.restoredFrom.op).toBe('restore_neardup');
  });
});

describe('restore_neardup — report_path is a guarded read', () => {
  it('denies a path outside the allowed roots, with a fixed message', async () => {
    await buildCanonicalFixture();
    const outside = path.join(os.tmpdir(), `outside-${process.pid}.json`);
    fs.writeFileSync(outside, JSON.stringify({ components: [] }));
    try {
      const result = (await memoryCurate(db, {
        op: 'restore_neardup',
        report_path: outside,
      })) as any;
      expect(result.code).toBe('E_REPORT_PATH_DENIED');
      expect(result.message).not.toContain(outside);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('denies a non-.json path and a directory', async () => {
    await buildCanonicalFixture();
    const txt = path.join(dir, 'report.txt');
    fs.writeFileSync(txt, '{}');
    const asDir = (await memoryCurate(db, { op: 'restore_neardup', report_path: dir })) as any;
    const asTxt = (await memoryCurate(db, { op: 'restore_neardup', report_path: txt })) as any;
    expect(asDir.code).toBe('E_REPORT_PATH_DENIED');
    expect(asTxt.code).toBe('E_REPORT_PATH_DENIED');
  });

  it('never returns file CONTENTS through the JSON parser error', async () => {
    await buildCanonicalFixture();
    const secret = 'SUPER-SECRET-TOKEN-do-not-echo';
    const malformed = path.join(dir, 'malformed.json');
    fs.writeFileSync(malformed, `not json at all ${secret}`);

    const result = (await memoryCurate(db, {
      op: 'restore_neardup',
      report_path: malformed,
    })) as any;
    expect(result.code).toBe('E_REPORT_MALFORMED');
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe('restore_neardup — reverse mode', () => {
  async function restoreOnce(): Promise<{ path: string; sha256: string }> {
    const { report } = await buildCanonicalFixture();
    const r = (await memoryCurate(db, {
      op: 'restore_neardup',
      report_path: report.path,
      dry_run: false,
    })) as any;
    expect(r.summary.members_restored).toBe(1);
    return report;
  }

  it('dry_run is the default and mutates nothing', async () => {
    const report = await restoreOnce();
    const rev = (await memoryCurate(db, {
      op: 'restore_neardup',
      reverse: true,
      report_sha256: report.sha256,
    })) as any;
    expect(rev.mode).toBe('reverse');
    expect(rev.dry_run).toBe(true);
    expect(rev.rows_matched).toBe(1);
    expect(rev.rows_reinvalidated).toBe(0);
    expect(await tInvalidOf('FIXFP0000000000000000000B')).toBeNull();
  });

  it('refuses to reverse without an identified run', async () => {
    await restoreOnce();
    const rev = (await memoryCurate(db, {
      op: 'restore_neardup',
      reverse: true,
      dry_run: false,
    })) as any;
    expect(rev.code).toBe('E_MISSING');
  });

  it('re-invalidates to the exact prior value AND GCs community state', async () => {
    const report = await restoreOnce();

    // Give the restored node the community state a live episode would have.
    const nodeRow = await db.executeGet<{ rowid: number }>(
      `SELECT rowid FROM node WHERE uid = ?`,
      ['FIXFP0000000000000000000B'],
    );
    const community = await db.executeRun(
      `INSERT INTO node (uid, kind, name, t_created, t_valid) VALUES (?, 'community', ?, ?, ?)`,
      ['REVCOMMUNITY0000000000001', 'c', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
    );
    await db.executeRun(
      `INSERT INTO edge (src, dst, rel, origin, t_created) VALUES (?, ?, 'MEMBER_OF', 'inferred', ?)`,
      [nodeRow!.rowid, Number(community.lastInsertRowid), '2026-01-01T00:00:00.000Z'],
    );

    const rev = (await memoryCurate(db, {
      op: 'restore_neardup',
      reverse: true,
      report_sha256: report.sha256,
      dry_run: false,
    })) as any;

    expect(rev.rows_reinvalidated).toBe(1);
    expect(await tInvalidOf('FIXFP0000000000000000000B')).toBe(T_INVALID);
    // The leak the raw UPDATE would have left behind:
    expect(rev.member_of_edges_invalidated).toBe(1);
    expect(rev.communities_invalidated).toBe(1);
    const liveEdges = await db.executeGet<{ c: number }>(
      `SELECT COUNT(*) AS c FROM edge WHERE rel = 'MEMBER_OF' AND t_invalid IS NULL AND src = ?`,
      [nodeRow!.rowid],
    );
    expect(liveEdges!.c).toBe(0);
    expect(await tInvalidOf('REVCOMMUNITY0000000000001')).toBe(T_INVALID);
  });

  it('scopes to one run: a different report sha matches nothing', async () => {
    const report = await restoreOnce();
    const rev = (await memoryCurate(db, {
      op: 'restore_neardup',
      reverse: true,
      report_sha256: 'f'.repeat(64),
      dry_run: false,
    })) as any;
    expect(rev.rows_matched).toBe(0);
    expect(await tInvalidOf('FIXFP0000000000000000000B')).toBeNull();
    // …and the right sha still finds it.
    const ok = (await memoryCurate(db, {
      op: 'restore_neardup',
      reverse: true,
      report_sha256: report.sha256,
      dry_run: false,
    })) as any;
    expect(ok.rows_reinvalidated).toBe(1);
  });
});

describe('restore_neardup — a dry run is always readable', () => {
  it('surfaces a re-invalidated-after-restore node in the PLAN instead of refusing to plan', async () => {
    const { report } = await buildCanonicalFixture();
    await memoryCurate(db, { op: 'restore_neardup', report_path: report.path, dry_run: false });
    await db.executeRun(`UPDATE node SET t_invalid = ? WHERE uid = ?`, [
      '2026-09-10T00:00:00.000Z',
      'FIXFP0000000000000000000B',
    ]);

    // Reading a plan must NOT require arming a mutation flag.
    const dry = (await memoryCurate(db, {
      op: 'restore_neardup',
      report_path: report.path,
    })) as any;
    expect(dry.code).toBeUndefined();
    expect(dry.summary.members_reinvalidated_after_restore).toBe(1);
    const c = comps(dry).find((x) => x.component_id === 1)!;
    expect(c.status).toBe('halted_reinvalidated');

    // The APPLY still halts.
    const apply = (await memoryCurate(db, {
      op: 'restore_neardup',
      report_path: report.path,
      dry_run: false,
    })) as any;
    expect(apply.code).toBe('E_REINVALIDATED_AFTER_RESTORE');
  });

  it('emits scoped_sql: null rather than a statement that matches nothing', async () => {
    await buildCanonicalFixture();
    const dry = (await memoryCurate(db, { op: 'restore_neardup' })) as any;
    expect(dry.report).toBeNull();
    expect(dry.reversal.scoped_sql).toBeNull();
    expect(dry.reversal.sql).toContain('restoredFrom.prior_t_invalid');
  });
});

describe('restore_neardup — reverse mode, multi-row', () => {
  it('reverses EVERY restored row across components and sums the GC counters', async () => {
    // 3 restorable members across 2 components — a loop that runs once and
    // stops would still satisfy the single-member fixtures above.
    const components: FixtureComponent[] = [];
    const restored: string[] = [];
    for (let i = 0; i < 2; i++) {
      const u = `MULTI${i}`;
      const anchor = `${u}AAAAAAAAAAAAAAAAAAAA`;
      const m1 = `${u}BBBBBBBBBBBBBBBBBBBB`;
      const m2 = `${u}CCCCCCCCCCCCCCCCCCCC`;
      const aRow = await insertEpisode(anchor, `multi ${i} anchor text here`);
      const b = await insertEpisode(m1, `multi ${i} wholly different text`, { invalid: T_INVALID });
      await insertEdge(aRow, b, 'SAME_AS', 'inferred');
      const members = [
        { uid: anchor, invalid: false },
        { uid: m1, invalid: true },
      ];
      const pairs = [pair(anchor, m1, 0.1)];
      restored.push(m1);
      if (i === 0) {
        // one component of size 3, so the loop must cover >1 member per component
        const c = await insertEpisode(m2, `multi ${i} third distinct text`, { invalid: T_INVALID });
        await insertEdge(aRow, c, 'SAME_AS', 'inferred');
        members.push({ uid: m2, invalid: true });
        pairs.push(pair(anchor, m2, 0.1));
        restored.push(m2);
      }
      components.push({
        comp: i + 1,
        size: members.length,
        invalid: members.filter((m) => m.invalid).length,
        live: 1,
        cls: 'FALSE-POSITIVE',
        derivedFromPairs: 0,
        maxJ: 0.1,
        members,
        pairs,
      });
    }
    const report = reportFor(components);

    const fwd = (await memoryCurate(db, {
      op: 'restore_neardup',
      report_path: report.path,
      dry_run: false,
    })) as any;
    expect(fwd.summary.members_restored).toBe(3);

    // Give every restored row its own community membership.
    let communityRowids: number[] = [];
    for (const uid of restored) {
      const n = await db.executeGet<{ rowid: number }>(`SELECT rowid FROM node WHERE uid = ?`, [uid]);
      const c = await db.executeRun(
        `INSERT INTO node (uid, kind, name, t_created, t_valid) VALUES (?, 'community', ?, ?, ?)`,
        [`COMM-${uid}`, 'c', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
      );
      communityRowids.push(Number(c.lastInsertRowid));
      await db.executeRun(
        `INSERT INTO edge (src, dst, rel, origin, t_created) VALUES (?, ?, 'MEMBER_OF', 'inferred', ?)`,
        [n!.rowid, Number(c.lastInsertRowid), '2026-01-01T00:00:00.000Z'],
      );
    }

    const rev = (await memoryCurate(db, {
      op: 'restore_neardup',
      reverse: true,
      report_sha256: report.sha256,
      dry_run: false,
    })) as any;

    expect(rev.rows_matched).toBe(3);
    expect(rev.rows_reinvalidated).toBe(3);
    expect(rev.member_of_edges_invalidated).toBe(3);
    expect(rev.communities_invalidated).toBe(3);
    for (const uid of restored) expect(await tInvalidOf(uid)).toBe(T_INVALID);
    const liveMemberOf = await db.executeGet<{ c: number }>(
      `SELECT COUNT(*) AS c FROM edge WHERE rel = 'MEMBER_OF' AND t_invalid IS NULL`,
    );
    expect(liveMemberOf!.c).toBe(0);
    const liveCommunities = await db.executeGet<{ c: number }>(
      `SELECT COUNT(*) AS c FROM node WHERE kind = 'community' AND t_invalid IS NULL`,
    );
    expect(liveCommunities!.c).toBe(0);
  });

  it('is gated on integrity exactly like an apply', async () => {
    const { report } = await buildCanonicalFixture();
    await memoryCurate(db, { op: 'restore_neardup', report_path: report.path, dry_run: false });

    const broken: StoreAdapter = new Proxy(db, {
      get(target, prop, recv) {
        if (prop === 'executeAll') {
          return async (sql: string, params?: unknown[]) => {
            if (/integrity_check/i.test(sql)) {
              return { rows: [{ integrity_check: 'row 12 missing from index ix_node_uid' }] };
            }
            return (target as any).executeAll(sql, params);
          };
        }
        return Reflect.get(target, prop, recv);
      },
    }) as StoreAdapter;

    // dry run still readable…
    const dry = (await memoryCurate(broken, {
      op: 'restore_neardup',
      reverse: true,
      report_sha256: report.sha256,
    })) as any;
    expect(dry.rows_matched).toBe(1);
    expect(dry.integrity.ok).toBe(false);

    // …the mutation is refused.
    const apply = (await memoryCurate(broken, {
      op: 'restore_neardup',
      reverse: true,
      report_sha256: report.sha256,
      dry_run: false,
    })) as any;
    expect(apply.code).toBe('E_INTEGRITY_NOT_OK');
    expect(await tInvalidOf('FIXFP0000000000000000000B')).toBeNull();

    // …unless forced, and then the verdict travels with the result.
    const forced = (await memoryCurate(broken, {
      op: 'restore_neardup',
      reverse: true,
      report_sha256: report.sha256,
      dry_run: false,
      allow_integrity_failure: true,
    })) as any;
    expect(forced.rows_reinvalidated).toBe(1);
    expect(forced.integrity.override).toBe(true);
    expect(await tInvalidOf('FIXFP0000000000000000000B')).toBe(T_INVALID);
  });
});
