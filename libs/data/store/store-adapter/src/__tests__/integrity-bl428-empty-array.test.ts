/**
 * BL-428 — `tags = '[]'` where the schema means NULL, and BL-431 — the
 * caller-side probe exclusion.
 *
 * ── BL-428 ──────────────────────────────────────────────────────────────────
 * 86 live episodes carry the literal `'[]'` in `node.tags`. `enrich.ts` is
 * explicit that an empty tags array means *no tags*, "which the schema and
 * every reader (`memory_recall`'s tags filter, etc.) represent as NULL, not
 * `'[]'`". Both write paths honour that today; these rows are residue from the
 * BL-325 window when the guard was momentarily dropped, and they make
 * `with_tags` overcount by exactly that many.
 *
 * **Why no existing probe catches them:** `'[]'` is *valid JSON*. BL-342's
 * `json_column_valid` passes it, correctly — which is precisely why these rows
 * survived a sweep that was looking for malformed values. Detecting a value
 * that is well-formed but semantically wrong needs its own probe, and because
 * "empty means absent" is a claim the owning schema makes rather than a
 * universal truth, the columns are DECLARED (`EMPTY_ARRAY_MUST_BE_NULL`), not
 * discovered.
 *
 * ── BL-431 ──────────────────────────────────────────────────────────────────
 * `json_column_valid` costs 262 ms warm on the live store and took the `fast`
 * pass from ~211 ms to 470.5 ms. The sanctioned response is a caller-side
 * exclusion, and the load-bearing part of it is that a skipped probe is
 * reported as `unknown` rather than omitted: an omitted probe would let
 * `ok: true` mean "verified" over a store nothing checked.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSqliteAdapter } from '../factory.js';
import {
  EMPTY_ARRAY_MUST_BE_NULL,
  repairStoreIntegrity,
  resolveSkippedProbes,
  verifyAndRepair,
  verifyStoreIntegrity,
} from '../integrity.js';
import type { StoreAdapter } from '../types.js';

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-bl428-'));
});

function tempPath(label: string): string {
  return join(tmpDir, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}

const open: StoreAdapter[] = [];
let savedSkip: string | undefined;
afterEach(async () => {
  if (savedSkip === undefined) delete process.env['SOX_STORE_VERIFY_SKIP'];
  else process.env['SOX_STORE_VERIFY_SKIP'] = savedSkip;
  savedSkip = undefined;
  while (open.length > 0) {
    try {
      await open.pop()!.close();
    } catch {
      // already closed
    }
  }
});

function track<T extends StoreAdapter>(a: T): T {
  open.push(a);
  return a;
}

const NODE_DDL = `
  CREATE TABLE IF NOT EXISTS node (
    rowid      INTEGER PRIMARY KEY,
    uid        TEXT UNIQUE NOT NULL,
    kind       TEXT NOT NULL,
    content    TEXT,
    tags       TEXT,
    meta       TEXT,
    enrich_ver TEXT,
    t_created  TEXT NOT NULL
  );
`;

let seq = 0;
async function seedTagged(adapter: StoreAdapter, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await adapter.executeRun(
      `INSERT INTO node (uid, kind, content, tags, meta, enrich_ver, t_created)
       VALUES (?, 'episode', ?, ?, ?, ?, ?)`,
      [
        `ok-${seq++}`,
        `episode ${i} concerning quarterly hippopotamus logistics`,
        JSON.stringify([`tag-${i % 4}`]),
        JSON.stringify({ source: 'test', i }),
        JSON.stringify({ pass: '1.4.0' }),
        new Date().toISOString(),
      ],
    );
  }
}

/** The BL-428 residue shape: the literal empty array where NULL is meant. */
async function seedEmptyArrayTags(adapter: StoreAdapter, n: number): Promise<number[]> {
  const rowids: number[] = [];
  for (let i = 0; i < n; i++) {
    const res = await adapter.executeRun(
      `INSERT INTO node (uid, kind, content, tags, t_created) VALUES (?, 'episode', ?, '[]', ?)`,
      [`empty-${seq++}`, 'untagged episode written during the BL-325 window', new Date().toISOString()],
    );
    rowids.push(Number(res.lastInsertRowid));
  }
  return rowids;
}

describe("BL-428 — tags = '[]' is detected and normalised to NULL", () => {
  it('BL-428: negative control — a store with no empty arrays reports the probe ok, having actually looked', async () => {
    const adapter = track(createSqliteAdapter({ dbPath: tempPath('bl428-clean') }));
    await adapter.exec(NODE_DDL);
    await seedTagged(adapter, 20);

    const report = await verifyStoreIntegrity(adapter);
    const findings = report.findings.filter((f) => f.probe === 'json_empty_array_null');

    // The probe must have inspected the declared column — a probe that looks at
    // nothing cannot fail and reads as coverage forever (BL-167).
    expect(findings.map((f) => f.object)).toEqual(['node.tags']);
    expect(findings[0]?.status).toBe('ok');
    expect(findings[0]?.probeValidated).toBe(true);
    expect(report.damaged.filter((f) => f.probe === 'json_empty_array_null')).toEqual([]);
  });

  it("BL-428: json_valid PASSES '[]' — which is why the BL-342 probe alone can never find these rows", async () => {
    const adapter = track(createSqliteAdapter({ dbPath: tempPath('bl428-validjson') }));
    await adapter.exec(NODE_DDL);
    await seedTagged(adapter, 20);
    await seedEmptyArrayTags(adapter, 3);

    // The premise, asserted rather than assumed: these rows are well-formed.
    const invalid = await adapter.executeGet<{ c: number }>(
      `SELECT COUNT(*) AS c FROM node WHERE tags IS NOT NULL AND NOT json_valid(tags)`,
    );
    expect(Number(invalid?.c)).toBe(0);

    const report = await verifyStoreIntegrity(adapter);
    expect(report.damaged.filter((f) => f.probe === 'json_column_valid')).toEqual([]);
    expect(report.damaged.map((f) => f.probe)).toContain('json_empty_array_null');
  });

  it('BL-428: the rows are counted, reported as repairable, and normalised to NULL by the repair pass', async () => {
    const adapter = track(createSqliteAdapter({ dbPath: tempPath('bl428-repair') }));
    await adapter.exec(NODE_DDL);
    await seedTagged(adapter, 20);
    const bad = await seedEmptyArrayTags(adapter, 5);

    // Pre-repair: the defect as the live store reports it — `with_tags` counts
    // rows that carry no tags at all.
    const before = await adapter.executeGet<{ with_tags: number }>(
      `SELECT COUNT(*) AS with_tags FROM node WHERE tags IS NOT NULL`,
    );
    expect(Number(before?.with_tags)).toBe(25);

    const verify = await verifyStoreIntegrity(adapter);
    const finding = verify.findings.find((f) => f.probe === 'json_empty_array_null');
    expect(finding?.status).toBe('damaged');
    expect(finding?.repairable).toBe(true);
    expect(finding?.backlog).toBe('BL-428');
    expect(finding?.detail).toContain('5 of 25');

    const repair = await repairStoreIntegrity(adapter, verify);
    const action = repair.actions.find((a) => a.probe === 'json_empty_array_null');
    expect(action?.ok).toBe(true);
    // The count is the repair's own rowsAffected, not the probe's earlier read.
    expect(action?.action).toContain('5 empty-array value(s)');

    const rows = await adapter.executeAll<{ tags: string | null }>(
      `SELECT tags FROM node WHERE rowid IN (${bad.join(',')})`,
    );
    expect(rows.rows.every((r) => r.tags === null)).toBe(true);

    const after = await adapter.executeGet<{ with_tags: number }>(
      `SELECT COUNT(*) AS with_tags FROM node WHERE tags IS NOT NULL`,
    );
    expect(Number(after?.with_tags)).toBe(20);

    // The episodes themselves survive — a repair normalises a column, it never
    // deletes a row.
    const total = await adapter.executeGet<{ c: number }>(`SELECT COUNT(*) AS c FROM node`);
    expect(Number(total?.c)).toBe(25);

    expect(repair.verified?.damaged.filter((f) => f.probe === 'json_empty_array_null')).toEqual([]);
  });

  it('BL-428: a NON-empty tags array is never touched — the repair cannot lose content', async () => {
    const adapter = track(createSqliteAdapter({ dbPath: tempPath('bl428-noloss') }));
    await adapter.exec(NODE_DDL);
    await seedTagged(adapter, 20);
    await seedEmptyArrayTags(adapter, 2);

    await verifyAndRepair(adapter);

    const kept = await adapter.executeGet<{ c: number }>(
      `SELECT COUNT(*) AS c FROM node WHERE tags IS NOT NULL AND json_array_length(tags) > 0`,
    );
    expect(Number(kept?.c)).toBe(20);
  });

  it('BL-428: the ordinary open path repairs it — no hand-run DDL, the store heals itself', async () => {
    const dbPath = tempPath('bl428-selfheal');
    const seedAdapter = track(createSqliteAdapter({ dbPath }));
    await seedAdapter.exec(NODE_DDL);
    await seedTagged(seedAdapter, 20);
    await seedEmptyArrayTags(seedAdapter, 4);
    await seedAdapter.close();

    const reopened = track(createSqliteAdapter({ dbPath }));
    const events: string[] = [];
    const result = await verifyAndRepair(reopened, {
      onReport: (event, detail) => events.push(`${event}: ${detail}`),
    });

    expect(result.repair?.actions.some((a) => a.probe === 'json_empty_array_null' && a.ok)).toBe(true);
    // Damage is never silent.
    expect(events.some((e) => e.startsWith('damaged:') && e.includes('BL-428'))).toBe(true);

    const remaining = await reopened.executeGet<{ c: number }>(
      `SELECT COUNT(*) AS c FROM node WHERE tags = '[]'`,
    );
    expect(Number(remaining?.c)).toBe(0);
  });

  it('BL-428: only DECLARED columns get the empty-array rule — meta = \'{}\' is left alone', async () => {
    const adapter = track(createSqliteAdapter({ dbPath: tempPath('bl428-declared') }));
    await adapter.exec(NODE_DDL);
    await seedTagged(adapter, 20);
    await adapter.executeRun(
      `INSERT INTO node (uid, kind, content, meta, t_created) VALUES ('m1', 'episode', 'x', '[]', ?)`,
      [new Date().toISOString()],
    );

    expect(EMPTY_ARRAY_MUST_BE_NULL).toEqual(['node.tags']);
    const report = await verifyStoreIntegrity(adapter);
    expect(report.findings.filter((f) => f.probe === 'json_empty_array_null').map((f) => f.object)).toEqual([
      'node.tags',
    ]);

    await repairStoreIntegrity(adapter, report);
    const meta = await adapter.executeGet<{ meta: string | null }>(
      `SELECT meta FROM node WHERE uid = 'm1'`,
    );
    expect(meta?.meta).toBe('[]');
  });
});

describe('BL-431 — a short-lived caller can exclude a probe, and the report says so', () => {
  it('BL-431: VerifyOptions.skip omits the probe and records it as unknown, never as ok', async () => {
    const adapter = track(createSqliteAdapter({ dbPath: tempPath('bl431-skip') }));
    await adapter.exec(NODE_DDL);
    await seedTagged(adapter, 20);

    const full = await verifyStoreIntegrity(adapter);
    expect(full.findings.some((f) => f.probe === 'json_column_valid')).toBe(true);

    const skipped = await verifyStoreIntegrity(adapter, {
      skip: ['json_column_valid', 'json_empty_array_null'],
    });

    // The scan did not run…
    expect(skipped.findings.filter((f) => f.probeValidated && f.probe === 'json_column_valid')).toEqual([]);
    // …and its absence is stated, not inferred away.
    const declared = skipped.unknown.map((f) => f.probe).sort();
    expect(declared).toEqual(['json_column_valid', 'json_empty_array_null']);
    expect(skipped.unknown.every((f) => f.backlog === 'BL-431')).toBe(true);
  });

  it('BL-431: skip wins over only — the exclusion cannot be defeated by a wider request', async () => {
    const adapter = track(createSqliteAdapter({ dbPath: tempPath('bl431-precedence') }));
    await adapter.exec(NODE_DDL);
    await seedTagged(adapter, 5);

    const report = await verifyStoreIntegrity(adapter, {
      only: ['json_column_valid'],
      skip: ['json_column_valid'],
    });
    expect(report.findings.filter((f) => f.probeValidated)).toEqual([]);
  });

  it('BL-431: SOX_STORE_VERIFY_SKIP is parsed strictly — an unrecognised name fails SAFE (probe still runs)', () => {
    savedSkip = process.env['SOX_STORE_VERIFY_SKIP'];

    process.env['SOX_STORE_VERIFY_SKIP'] = '';
    expect(resolveSkippedProbes()).toEqual([]);

    process.env['SOX_STORE_VERIFY_SKIP'] = 'json_column_valid, json_empty_array_null';
    expect(resolveSkippedProbes().sort()).toEqual(['json_column_valid', 'json_empty_array_null']);

    // A typo costs latency, never coverage.
    process.env['SOX_STORE_VERIFY_SKIP'] = 'json_colum_valid,fts_index_live';
    expect(resolveSkippedProbes()).toEqual(['fts_index_live']);
  });

  it('BL-431: skipping the JSON scan is measurably cheaper — the point of the lever', async () => {
    const adapter = track(createSqliteAdapter({ dbPath: tempPath('bl431-cost') }));
    await adapter.exec(NODE_DDL);
    await seedTagged(adapter, 400);

    const withScan = await verifyStoreIntegrity(adapter);
    const withoutScan = await verifyStoreIntegrity(adapter, {
      skip: ['json_column_valid', 'json_empty_array_null'],
    });

    // Wall-clock on a 400-row store is small and noisy; what must hold is that
    // the excluded pass does strictly less work, asserted by the probe count
    // rather than by a timing threshold that would flake under contention.
    expect(withoutScan.findings.filter((f) => f.probeValidated).length).toBeLessThan(
      withScan.findings.filter((f) => f.probeValidated).length,
    );
    expect(withoutScan.durationMs).toBeLessThanOrEqual(withScan.durationMs + 50);
  });
});
