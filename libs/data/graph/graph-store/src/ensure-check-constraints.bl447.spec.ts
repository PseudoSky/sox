/**
 * BL-447 — structural CHECK-presence gate replaces substring-literal rebuild probe.
 *
 * `ensureCheckConstraints()` (index.ts:833-876) decides whether to rebuild `node`/`edge`
 * by searching the live `sqlite_master.sql` text for the literal `'generic'` / `'DEPENDS_ON'`.
 * That literal search cannot tell "CHECK absent because this store predates the enum value"
 * (rebuild) apart from "CHECK absent because this store is deliberately open-schema, post
 * BL-438 D1/D4" (do nothing) — both fail the literal `.includes()` test identically. This spec
 * proves the structural `hasEnumCheckConstraint()` gate (module-private, index.ts:793-795)
 * resolves that ambiguity correctly in both directions, per SPEC-BL-447.md §5.
 *
 * Uses real temp-file adapters (not `:memory:`) because Criterion A must close and reopen a
 * real connection against the same file to prove state persisted correctly across cold opens —
 * `:memory:` databases do not survive closing the connection. Pattern follows
 * `libs/data/store/store-adapter/src/__tests__/migration-e2e.test.ts:20-52`.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteAdapterImpl } from '@adhd/sox-store-adapter';
import { createGraphBackend, DEFAULT_NODE_KINDS, PUBLIC_EDGE_RELS } from './index.js';
import type { EdgeRel } from './index.js';

// ── Temp directory ───────────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'graph-store-bl447-'));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function tempPath(label: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpDir, `${label}-${suffix}.db`);
}

const openAdapters: SqliteAdapterImpl[] = [];
afterEach(async () => {
  while (openAdapters.length > 0) {
    const a = openAdapters.pop()!;
    try {
      await a.close();
    } catch {
      // already closed
    }
  }
});

function track(adapter: SqliteAdapterImpl): SqliteAdapterImpl {
  openAdapters.push(adapter);
  return adapter;
}

// ── §5.1 — Criterion A fixture: the open-schema (post D1/D4) DDL shape ───────
//
// Test-local, per SPEC-BL-447.md §5.1/D-4: this is NOT imported from `graphDdl()` /
// `INLINE_MIGRATION_DDL` because BL-447 must be provable *before* those constants lose their
// CHECK clause — that is the entire point of this ticket (it gates BL-438 D1/D4). This is
// `NODE_TABLE_DDL`/`EDGE_TABLE_DDL`'s exact column set (index.ts:259-303) with only the
// `CHECK (kind IN (...))` / `CHECK (rel IN (...))` clause removed, i.e. exactly what those two
// constants will look like the day D1/D4 land. `is_superseded`/`t_expired` are included directly
// here (unlike production, where `addColumnIfMissing` ALTERs them in) so this test's
// rebuild-detection isn't confounded by those unrelated ALTER TABLEs, which always run first.
//
// DEVIATION FROM SPEC-BL-447.md §5.1's literal text, resolved without escalation (see completion
// report's OPEN QUESTIONS FOR ARCHITECT): the spec's literal `OPEN_SCHEMA_NODE_DDL` omits
// `access_count`/`last_access`/`t_updated`, three columns the real `NODE_TABLE_DDL` (index.ts:284-287)
// and `NODE_COLUMNS` (index.ts:305-311) both carry — a mismatch with the spec's own stated intent
// ("this is NODE_TABLE_DDL's exact column set … with only the CHECK clause removed"). Confirmed by
// running the RED arm exactly as written in the spec: `rebuildTable`'s `NODE_COLUMNS`-driven
// `INSERT INTO node (...) SELECT ... FROM node_old` throws `SqliteError: no such column:
// access_count` (this is real corroborating evidence the substring-probe bug fires — it attempts a
// rebuild it should never attempt — but it is a crash, not the clean rootpage-identity RED
// assertion failure §5.1 describes). Fixed here by including the 3 columns, matching the stated
// intent literally.
const OPEN_SCHEMA_NODE_DDL = `CREATE TABLE node (
  rowid        INTEGER PRIMARY KEY,
  uid          TEXT UNIQUE NOT NULL,
  kind         TEXT NOT NULL,
  content      TEXT,
  name         TEXT,
  summary      TEXT,
  topic        TEXT,
  tags         TEXT,
  importance   REAL DEFAULT 1.0,
  confidence   REAL,
  content_hash TEXT,
  namespace    TEXT DEFAULT 'global',
  meta         TEXT,
  agent_id     TEXT,
  session_id   TEXT,
  source       TEXT CHECK (source IN ('message','tool_output','observation','document','reflection','import')),
  project_path TEXT,
  level        INTEGER,
  resume_state TEXT,
  is_superseded INTEGER DEFAULT 0,
  t_occurred   TEXT,
  t_expires    TEXT,
  t_created    TEXT NOT NULL,
  t_valid      TEXT,
  t_invalid    TEXT,
  access_count INTEGER DEFAULT 0,
  last_access  TEXT,
  t_updated    TEXT
)`;

const OPEN_SCHEMA_EDGE_DDL = `CREATE TABLE edge (
  rowid     INTEGER PRIMARY KEY,
  src       INTEGER NOT NULL REFERENCES node ON DELETE CASCADE,
  dst       INTEGER NOT NULL REFERENCES node ON DELETE CASCADE,
  rel       TEXT NOT NULL,
  weight    REAL DEFAULT 1.0,
  confidence REAL,
  origin    TEXT CHECK (origin IN ('extracted','inferred','user_asserted')),
  meta      TEXT,
  t_created TEXT NOT NULL,
  t_expired TEXT,
  t_valid   TEXT,
  t_invalid TEXT
)`;

// ── §5.2 — Criterion B fixtures: the CLOSED shape (production `NODE_TABLE_DDL`/`EDGE_TABLE_DDL`,
//    index.ts:259-303, verbatim) parameterised by the CHECK's IN-list ─────────
//
// `NODE_TABLE_DDL`/`EDGE_TABLE_DDL` are module-private in index.ts (not exported) so they cannot
// be imported directly as SPEC-BL-447.md §5.2 literally instructs — see OPEN QUESTIONS FOR
// ARCHITECT in the completion report. Resolution used here: these templates are copied
// byte-for-byte from index.ts:259-303 (confirmed via `git diff`/`Read` immediately before
// writing this file) with the CHECK IN-list parameterised so `CLOSED_NODE_DDL(DEFAULT_NODE_KINDS)`
// / `CLOSED_EDGE_DDL(FULL_EDGE_RELS)` are byte-identical to the real production constants, and the
// "genuinely legacy" fixture is produced by the same template with the enum's last-added member
// dropped — so this test cannot silently drift from the real population it stands in for any more
// than a direct import could.
const CLOSED_NODE_DDL = (kinds: readonly string[]): string => `CREATE TABLE node (
  rowid        INTEGER PRIMARY KEY,
  uid          TEXT UNIQUE NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN (${kinds.map((k) => `'${k}'`).join(',')})),
  content      TEXT,
  name         TEXT,
  summary      TEXT,
  topic        TEXT,
  tags         TEXT,
  importance   REAL DEFAULT 1.0,
  confidence   REAL,
  content_hash TEXT,
  namespace    TEXT DEFAULT 'global',
  meta         TEXT,
  agent_id     TEXT,
  session_id   TEXT,
  source       TEXT CHECK (source IN ('message','tool_output','observation','document','reflection','import')),
  project_path TEXT,
  level        INTEGER,
  resume_state TEXT,
  t_occurred   TEXT,
  t_expires    TEXT,
  t_created    TEXT NOT NULL,
  t_valid      TEXT,
  t_invalid    TEXT,
  is_superseded INTEGER DEFAULT 0,
  access_count INTEGER DEFAULT 0,
  last_access  TEXT,
  t_updated    TEXT
)`;

const CLOSED_EDGE_DDL = (rels: readonly string[]): string => `CREATE TABLE edge (
  rowid     INTEGER PRIMARY KEY,
  src       INTEGER NOT NULL REFERENCES node ON DELETE CASCADE,
  dst       INTEGER NOT NULL REFERENCES node ON DELETE CASCADE,
  rel       TEXT NOT NULL CHECK (rel IN (${rels.map((r) => `'${r}'`).join(',')})),
  weight    REAL DEFAULT 1.0,
  confidence REAL,
  origin    TEXT CHECK (origin IN ('extracted','inferred','user_asserted')),
  meta      TEXT,
  t_created TEXT NOT NULL,
  t_expired TEXT,
  t_valid   TEXT,
  t_invalid TEXT
)`;

// `EdgeRel` (index.ts:364-374) is a type, not a runtime enum, so it has no value-level export to
// enumerate. `PUBLIC_EDGE_RELS` is the only exported runtime source of any of its members. The
// full order below matches `EDGE_TABLE_DDL`'s live IN-list text (index.ts:294) exactly — confirmed
// by direct `Read` immediately before writing this file — with `PUBLIC_EDGE_RELS`'s 7 entries
// interleaved at their real positions and the two non-public entries (`MEMBER_OF`, `PART_OF`)
// added by hand, since there is no exported constant that carries them.
const FULL_EDGE_RELS: readonly EdgeRel[] = [
  'MENTIONS',
  'SUPPORTS',
  'RELATES_TO',
  'SUPERSEDES',
  'DERIVED_FROM',
  'MEMBER_OF',
  'PART_OF',
  'SAME_AS',
  'ASSIGNED_TO',
  'DEPENDS_ON',
];

// Fixture self-check (asserted inline, not as a standalone `it` — SPEC-BL-447.md §7 gates on an
// exact 48-test count: 46 existing + Criterion A + Criterion B, no more) — verified once at module
// load so a drift in `FULL_EDGE_RELS` fails loudly instead of silently mis-testing Criterion B.
{
  const missingPublicRel = PUBLIC_EDGE_RELS.find((rel) => !FULL_EDGE_RELS.includes(rel));
  if (missingPublicRel) {
    throw new Error(
      `FULL_EDGE_RELS fixture (BL-447 test) is missing PUBLIC_EDGE_RELS entry ${JSON.stringify(missingPublicRel)} — fix the fixture, not this check.`,
    );
  }
  if (
    !FULL_EDGE_RELS.includes('MEMBER_OF') ||
    !FULL_EDGE_RELS.includes('PART_OF') ||
    !FULL_EDGE_RELS.includes('DEPENDS_ON') ||
    FULL_EDGE_RELS.length !== PUBLIC_EDGE_RELS.length + 3
  ) {
    throw new Error(
      'FULL_EDGE_RELS fixture (BL-447 test) no longer matches PUBLIC_EDGE_RELS + {MEMBER_OF, PART_OF, DEPENDS_ON} — fix the fixture, not this check.',
    );
  }
}

// ── Shared identity-capture helper ───────────────────────────────────────────

interface TableIdentity {
  rootpage: number;
  sql: string;
}

async function captureIdentity(
  adapter: SqliteAdapterImpl,
): Promise<{ node: TableIdentity; edge: TableIdentity; nodeCount: number; edgeCount: number }> {
  const rows = (
    await adapter.executeAll<{ name: string; sql: string; rootpage: number }>(
      `SELECT name, sql, rootpage FROM sqlite_master WHERE type='table' AND name IN ('node','edge')`,
    )
  ).rows;
  const node = rows.find((r) => r.name === 'node');
  const edge = rows.find((r) => r.name === 'edge');
  if (!node || !edge) throw new Error('node/edge table missing from sqlite_master');
  const nodeCount = (await adapter.executeGet<{ c: number }>(`SELECT COUNT(*) AS c FROM node`))!.c;
  const edgeCount = (await adapter.executeGet<{ c: number }>(`SELECT COUNT(*) AS c FROM edge`))!.c;
  return {
    node: { rootpage: node.rootpage, sql: node.sql },
    edge: { rootpage: edge.rootpage, sql: edge.sql },
    nodeCount,
    edgeCount,
  };
}

// ── §5.1 Criterion A ─────────────────────────────────────────────────────────

describe('BL-447 Criterion A — zero rebuilds on an already-open-schema store, across two cold opens', () => {
  it('applySchema() never rebuilds a store whose node/edge tables have no CHECK on kind/rel', async () => {
    const dbPath = tempPath('open-schema');
    const now = new Date().toISOString();

    const adapter1 = track(new SqliteAdapterImpl(dbPath));
    await adapter1.exec('PRAGMA foreign_keys = ON');
    await adapter1.exec(OPEN_SCHEMA_NODE_DDL);
    await adapter1.exec(OPEN_SCHEMA_EDGE_DDL);

    await adapter1.executeRun(`INSERT INTO node (uid, kind, content, t_created) VALUES (?, ?, ?, ?)`, [
      'n1',
      'episode',
      'first',
      now,
    ]);
    await adapter1.executeRun(`INSERT INTO node (uid, kind, content, t_created) VALUES (?, ?, ?, ?)`, [
      'n2',
      'episode',
      'second',
      now,
    ]);
    // `rel` set to a value NOT in the historical enum — proves this really is open-schema
    // (nothing constrains it), not accidentally still-closed.
    await adapter1.executeRun(`INSERT INTO edge (src, dst, rel, t_created) VALUES (?, ?, ?, ?)`, [
      1,
      2,
      'CUSTOM_REL',
      now,
    ]);

    const before = await captureIdentity(adapter1);
    expect(before.nodeCount).toBe(2);
    expect(before.edgeCount).toBe(1);

    // First open/apply.
    const backend1 = createGraphBackend(adapter1);
    await backend1.applySchema();

    const afterFirstOpen = await captureIdentity(adapter1);
    expect(afterFirstOpen.node.rootpage).toBe(before.node.rootpage);
    expect(afterFirstOpen.edge.rootpage).toBe(before.edge.rootpage);
    expect(afterFirstOpen.node.sql).toBe(before.node.sql);
    expect(afterFirstOpen.edge.sql).toBe(before.edge.sql);
    expect(afterFirstOpen.nodeCount).toBe(2);
    expect(afterFirstOpen.edgeCount).toBe(1);

    // Close, then open a *new* adapter on the same file — a real process cold-open.
    // `close()` is idempotent (sqlite-adapter.ts:346), so the afterEach hook's later attempt to
    // close `adapter1` again is a harmless no-op.
    await adapter1.close();

    const adapter2 = track(new SqliteAdapterImpl(dbPath));
    const backend2 = createGraphBackend(adapter2);
    await backend2.applySchema();

    const afterSecondOpen = await captureIdentity(adapter2);
    expect(afterSecondOpen.node.rootpage).toBe(before.node.rootpage);
    expect(afterSecondOpen.edge.rootpage).toBe(before.edge.rootpage);
    expect(afterSecondOpen.node.sql).toBe(before.node.sql);
    expect(afterSecondOpen.edge.sql).toBe(before.edge.sql);
    expect(afterSecondOpen.nodeCount).toBe(2);
    expect(afterSecondOpen.edgeCount).toBe(1);
    expect(await adapter2.pragmaGet<number>('foreign_keys')).toBe(1);
  });
});

// ── §5.2 Criterion B ─────────────────────────────────────────────────────────

describe('BL-447 Criterion B — a genuine legacy pre-generic/pre-DEPENDS_ON store upgrades to the CLOSED shape', () => {
  it('rebuilds a legacy CHECK-present store to the current closed enum, not the open shape', async () => {
    const dbPath = tempPath('legacy-closed');
    const now = new Date().toISOString();

    const legacyKinds = DEFAULT_NODE_KINDS.slice(0, -1); // drop 'generic' (the array's last entry)
    const legacyRels = FULL_EDGE_RELS.filter((r) => r !== 'DEPENDS_ON');

    const adapter = track(new SqliteAdapterImpl(dbPath));
    await adapter.exec('PRAGMA foreign_keys = ON');
    await adapter.exec(CLOSED_NODE_DDL(legacyKinds));
    await adapter.exec(CLOSED_EDGE_DDL(legacyRels));

    await adapter.executeRun(`INSERT INTO node (uid, kind, content, t_created) VALUES (?, ?, ?, ?)`, [
      'n1',
      'episode',
      'first',
      now,
    ]);
    await adapter.executeRun(`INSERT INTO node (uid, kind, content, t_created) VALUES (?, ?, ?, ?)`, [
      'n2',
      'episode',
      'second',
      now,
    ]);
    await adapter.executeRun(`INSERT INTO edge (src, dst, rel, t_created) VALUES (?, ?, ?, ?)`, [
      1,
      2,
      'MENTIONS',
      now,
    ]);

    // Sanity: this store really is still closed pre-upgrade — 'generic' is rejected by SQLite's
    // live CHECK.
    await expect(
      adapter.executeRun(`INSERT INTO node (uid, kind, content, t_created) VALUES (?, ?, ?, ?)`, [
        'should-fail',
        'generic',
        'x',
        now,
      ]),
    ).rejects.toThrow();

    const backend = createGraphBackend(adapter);
    await backend.applySchema();

    const after = await captureIdentity(adapter);
    expect(after.nodeCount).toBe(2);
    expect(after.edgeCount).toBe(1);

    // Upgraded: both now contain the newly-added enum member.
    expect(after.node.sql).toContain("'generic'");
    expect(after.edge.sql).toContain("'DEPENDS_ON'");

    // Bare-identifier form (matches NODE_TABLE_DDL/EDGE_TABLE_DDL's rebuild-target text, not
    // INLINE_MIGRATION_DDL's Drizzle-quoted form) — confirms the rebuild targeted the CLOSED
    // constant, not some open-schema shape.
    expect(after.node.sql).toContain('CHECK (kind IN (');
    expect(after.node.sql).not.toContain('CHECK ("kind" IN (');
    expect(after.edge.sql).toContain('CHECK (rel IN (');
    expect(after.edge.sql).not.toContain('CHECK ("rel" IN (');

    // Byte-identical to what a freshly created CLOSED-shape store looks like today.
    expect(after.node.sql).toBe(CLOSED_NODE_DDL(DEFAULT_NODE_KINDS));
    expect(after.edge.sql).toBe(CLOSED_EDGE_DDL(FULL_EDGE_RELS));

    // Positive proof the live SQLite CHECK itself now accepts 'generic'/'DEPENDS_ON' — not just
    // that the text changed.
    await expect(
      adapter.executeRun(`INSERT INTO node (uid, kind, content, t_created) VALUES (?, ?, ?, ?)`, [
        'generic-1',
        'generic',
        'g',
        now,
      ]),
    ).resolves.toBeDefined();

    const genericId = await backend.writeNode('generic content via writeNode', { kind: 'generic' });
    expect(typeof genericId).toBe('number');

    await expect(
      adapter.executeRun(`INSERT INTO edge (src, dst, rel, t_created) VALUES (?, ?, ?, ?)`, [
        1,
        2,
        'DEPENDS_ON',
        now,
      ]),
    ).resolves.toBeDefined();
  });
});
