/**
 * BL-342 — the malformed JSON *data* on the store, not the readers.
 *
 * The 2026-07-30 restore wrote the **empty string** into JSON-typed columns
 * where the schema means NULL. `''` is not valid JSON, so any `json_extract`
 * touching such a row aborts the statement:
 *
 *   Error: step failed: Parse error: malformed JSON
 *
 * BL-343 made the readers resilient (every `json_extract` gated on
 * `json_valid`), so the tool stopped dying — but the malformed rows were never
 * repaired and no migration removed them. They remain excluded from every
 * JSON-dependent aggregate for as long as they exist. This file pins the
 * repair.
 *
 * ── The trap this file exists to close ──────────────────────────────────────
 *
 * The live sweep that diagnosed BL-342 looked only at `tags` and reported one
 * bad row. `tags` is NOT the column that throws — `with_tags` only tests
 * `tags IS NOT NULL` and never parses the value. The column that actually
 * kills `memory_stats` is **`enrich_ver`**, via the `legacy_episodes` query's
 * `json_extract(enrich_ver, '$.note')`. A repair that normalises only the
 * column the sweep happened to name leaves the tool dead while appearing to
 * fix it. Every test below therefore exercises `enrich_ver` explicitly, and
 * the multi-column test asserts all three JSON columns are repaired in one
 * pass.
 *
 * ── The counter-trap: a repair must not become a data-loss event ────────────
 *
 * Discovery is by measured distribution, not by column name, so a prose column
 * holding one JSON document must NOT be classified as JSON-typed — otherwise
 * every ordinary sentence in it reads as "malformed JSON" and the repair
 * silently NULLs the corpus. And a non-empty unparseable value is reported but
 * never auto-repaired: it may carry real content. Both are asserted here.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSqliteAdapter } from '../factory.js';
import {
  verifyStoreIntegrity,
  repairStoreIntegrity,
  verifyAndRepair,
  isJsonTypedColumn,
} from '../integrity.js';
import type { StoreAdapter } from '../types.js';

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-bl342-'));
});

function tempPath(label: string): string {
  return join(tmpDir, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}

const open: StoreAdapter[] = [];
afterEach(async () => {
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

/** The live schema's shape: three JSON-typed TEXT columns plus prose columns. */
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
async function seedGood(adapter: StoreAdapter, n: number): Promise<void> {
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

/** Write the BL-342 shape into one column: `''` where the schema means NULL. */
async function seedMalformed(
  adapter: StoreAdapter,
  column: 'tags' | 'meta' | 'enrich_ver',
  value = '',
): Promise<number> {
  const res = await adapter.executeRun(
    `INSERT INTO node (uid, kind, content, ${column}, t_created) VALUES (?, 'episode', ?, ?, ?)`,
    [`bad-${column}-${seq++}`, 'restored row', value, new Date().toISOString()],
  );
  return Number(res.lastInsertRowid);
}

function findingFor(
  report: { findings: { probe: string; object: string }[] },
  object: string,
): { probe: string; object: string; status?: string; repairable?: boolean; detail?: string } | undefined {
  return report.findings.find((f) => f.probe === 'json_column_valid' && f.object === object) as
    | { probe: string; object: string; status?: string; repairable?: boolean; detail?: string }
    | undefined;
}

describe('BL-342 — malformed JSON columns are detected and normalised to NULL', () => {
  it('BL-342: negative control — a clean store reports json_column_valid ok on every JSON column', async () => {
    const adapter = track(createSqliteAdapter({ dbPath: tempPath('bl342-clean') }));
    await adapter.exec(NODE_DDL);
    await seedGood(adapter, 20);

    const report = await verifyStoreIntegrity(adapter);
    const json = report.findings.filter((f) => f.probe === 'json_column_valid');

    // The probe must actually have found the columns — a probe that inspects
    // nothing cannot fail, and would read as coverage forever (BL-167).
    expect(json.map((f) => f.object).sort()).toEqual(['node.enrich_ver', 'node.meta', 'node.tags']);
    expect(json.every((f) => f.status === 'ok')).toBe(true);
    expect(json.every((f) => f.probeValidated)).toBe(true);
    expect(report.damaged.filter((f) => f.probe === 'json_column_valid')).toEqual([]);
  });

  it("BL-342: enrich_ver = '' — the column that actually throws — is detected and repaired", async () => {
    const adapter = track(createSqliteAdapter({ dbPath: tempPath('bl342-enrichver') }));
    await adapter.exec(NODE_DDL);
    await seedGood(adapter, 20);
    const badRowid = await seedMalformed(adapter, 'enrich_ver');

    // The live failure, reproduced: json_extract over the whole column aborts.
    await expect(
      adapter.executeGet(
        `SELECT COUNT(*) AS c FROM node WHERE json_extract(enrich_ver, '$.note') = 'legacy'`,
      ),
    ).rejects.toThrow(/malformed JSON|JSON/i);

    const before = await verifyStoreIntegrity(adapter);
    const finding = findingFor(before, 'node.enrich_ver');
    expect(finding?.status).toBe('damaged');
    expect(finding?.repairable).toBe(true);
    expect(finding?.detail).toContain(String(badRowid));

    const repair = await repairStoreIntegrity(adapter, before);
    expect(repair.actions.some((a) => a.object === 'node.enrich_ver' && a.ok)).toBe(true);

    // The value is NULL — not '', not '{}'. NULL is how the schema and every
    // reader spell "absent"; '{}' would invent enrichment that never ran.
    const row = await adapter.executeGet<{ enrich_ver: string | null }>(
      `SELECT enrich_ver FROM node WHERE rowid = ?`,
      [badRowid],
    );
    expect(row?.enrich_ver).toBeNull();

    // And the query that used to abort now runs.
    const after = await adapter.executeGet<{ c: number }>(
      `SELECT COUNT(*) AS c FROM node WHERE json_extract(enrich_ver, '$.note') = 'legacy'`,
    );
    expect(Number(after?.c)).toBe(0);

    const reverified = await verifyStoreIntegrity(adapter);
    expect(reverified.damaged.filter((f) => f.probe === 'json_column_valid')).toEqual([]);
  });

  it('BL-342: every JSON column is repaired in one pass, not just the one a sweep named', async () => {
    const adapter = track(createSqliteAdapter({ dbPath: tempPath('bl342-allcols') }));
    await adapter.exec(NODE_DDL);
    await seedGood(adapter, 20);
    await seedMalformed(adapter, 'tags');
    await seedMalformed(adapter, 'meta');
    await seedMalformed(adapter, 'enrich_ver');

    const before = await verifyStoreIntegrity(adapter);
    expect(
      before.damaged
        .filter((f) => f.probe === 'json_column_valid')
        .map((f) => f.object)
        .sort(),
    ).toEqual(['node.enrich_ver', 'node.meta', 'node.tags']);

    await repairStoreIntegrity(adapter, before);

    const residual = await adapter.executeGet<{ c: number }>(
      `SELECT COUNT(*) AS c FROM node
        WHERE (tags       IS NOT NULL AND NOT json_valid(tags))
           OR (meta       IS NOT NULL AND NOT json_valid(meta))
           OR (enrich_ver IS NOT NULL AND NOT json_valid(enrich_ver))`,
    );
    expect(Number(residual?.c)).toBe(0);
  });

  it('BL-342: self-heals on the next ordinary open — no repair DDL from the caller', async () => {
    const dbPath = tempPath('bl342-selfheal');
    const built = track(createSqliteAdapter({ dbPath }));
    await built.exec(NODE_DDL);
    await seedGood(built, 20);
    await seedMalformed(built, 'enrich_ver');
    await built.close();

    const reopened = track(createSqliteAdapter({ dbPath }));
    // The adapter's own open-time pass is what production runs; call the same
    // entry point it calls rather than a bespoke repair.
    const result = await verifyAndRepair(reopened);
    expect(result.repair?.actions.some((a) => a.probe === 'json_column_valid' && a.ok)).toBe(true);

    const residual = await reopened.executeGet<{ c: number }>(
      `SELECT COUNT(*) AS c FROM node WHERE enrich_ver IS NOT NULL AND NOT json_valid(enrich_ver)`,
    );
    expect(Number(residual?.c)).toBe(0);
  });

  it('BL-342: a prose column holding one JSON document is NOT treated as a JSON column', async () => {
    const adapter = track(createSqliteAdapter({ dbPath: tempPath('bl342-prose') }));
    await adapter.exec(NODE_DDL);
    await seedGood(adapter, 20);
    // One episode whose content genuinely is a JSON document.
    await adapter.executeRun(
      `INSERT INTO node (uid, kind, content, t_created) VALUES (?, 'episode', ?, ?)`,
      [`json-content-${seq++}`, '{"this":"is legitimately a json document"}', new Date().toISOString()],
    );

    const report = await verifyStoreIntegrity(adapter);
    expect(findingFor(report, 'node.content')).toBeUndefined();

    // And the prose survives a repair pass untouched — this is the assertion
    // that separates a repair from a data-loss event.
    await repairStoreIntegrity(adapter, report);
    const prose = await adapter.executeGet<{ c: number }>(
      `SELECT COUNT(*) AS c FROM node WHERE content IS NOT NULL`,
    );
    expect(Number(prose?.c)).toBe(21);
  });

  it('BL-342: a non-empty unparseable value is reported but never auto-discarded', async () => {
    const adapter = track(createSqliteAdapter({ dbPath: tempPath('bl342-nonblank') }));
    await adapter.exec(NODE_DDL);
    await seedGood(adapter, 20);
    const truncated = await seedMalformed(adapter, 'meta', '{"unterminated": ');

    const before = await verifyStoreIntegrity(adapter);
    const finding = findingFor(before, 'node.meta');
    expect(finding?.status).toBe('damaged');
    expect(finding?.repairable).toBe(false);
    expect(finding?.detail).toContain('NOT auto-repairable');

    await repairStoreIntegrity(adapter, before);
    const row = await adapter.executeGet<{ meta: string | null }>(
      `SELECT meta FROM node WHERE rowid = ?`,
      [truncated],
    );
    expect(row?.meta).toBe('{"unterminated": ');
  });

  it('BL-342: the classifier itself rejects a column that is only incidentally JSON', () => {
    expect(isJsonTypedColumn({ nonNull: 21, jsonShaped: 20 })).toBe(true);
    expect(isJsonTypedColumn({ nonNull: 21, jsonShaped: 1 })).toBe(false);
    expect(isJsonTypedColumn({ nonNull: 0, jsonShaped: 0 })).toBe(false);
  });
});
