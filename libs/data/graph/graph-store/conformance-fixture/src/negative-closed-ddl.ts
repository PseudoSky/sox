/**
 * PKT-62 / BL-443 — AC-4 negative arm.
 *
 * Builds a store from a **local literal** copy of the pre-open (CHECK-bearing) DDL — byte-identical
 * to the blob already embedded in open-kind-check.bl439.spec.ts:160-207 /
 * open-rel-check.bl448.spec.ts:185-232 (both carry the same full closed-schema text; the source
 * package no longer exports a closed-DDL constant to import, so this file reuses the established
 * local-copy convention, cited by provenance here). Applies the INSTALLED package's applySchema()
 * against that pre-built table (proving `ensureCheckConstraints`'s structural gate — reached only
 * through node_modules — still correctly no-ops rather than rebuilding, SPEC-PKT-62.md Decision 4),
 * then attempts writeNode/writeEdge with the novel kind/rel using a PERMISSIVE policy (so the SQL
 * layer, not the TS layer, is what's proven to reject) and asserts both throw matching
 * /CHECK constraint failed/i.
 *
 * Emits one NDJSON line per assertion group to stdout: {"check":"<name>","ok":true|false}.
 * Exits non-zero if anything throws unexpectedly, or if the expected CHECK-failure never occurs.
 */
import { createGraphBackend, DEFAULT_TYPE_POLICY } from '@adhd/sox-graph-store';
import type { TypePolicy } from '@adhd/sox-graph-store';
import { SqliteAdapterImpl } from '@adhd/sox-store-adapter';

type CheckResult = { check: string; ok: boolean; detail?: string };

let anyFailed = false;

function emit(result: CheckResult): void {
  if (!result.ok) anyFailed = true;
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

// Byte-identical to OLD_CHECK_BEARING_INLINE_DDL in open-kind-check.bl439.spec.ts /
// open-rel-check.bl448.spec.ts — provenance: libs/data/graph/graph-store/src/open-rel-check.bl448.spec.ts:185-232.
const OLD_CHECK_BEARING_INLINE_DDL = `
CREATE TABLE IF NOT EXISTS "node" (
  "rowid" integer PRIMARY KEY NOT NULL,
  "uid" text NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('episode','entity','claim','community','session','generic')),
  "content" text,
  "name" text,
  "summary" text,
  "topic" text,
  "tags" text,
  "importance" real DEFAULT 1,
  "confidence" text,
  "content_hash" text,
  "namespace" text DEFAULT 'global',
  "meta" text,
  "agent_id" text,
  "session_id" text,
  "source" text CHECK ("source" IN ('message','tool_output','observation','document','reflection','import')),
  "project_path" text,
  "level" integer,
  "resume_state" text,
  "is_superseded" integer DEFAULT 0,
  "t_occurred" text,
  "t_expires" text,
  "t_created" text NOT NULL,
  "t_valid" text,
  "t_invalid" text
);
CREATE UNIQUE INDEX IF NOT EXISTS "node_uid_unique" ON "node" ("uid");
CREATE INDEX IF NOT EXISTS "ix_node_kind" ON "node" ("kind");
CREATE TABLE IF NOT EXISTS "edge" (
  "rowid" integer PRIMARY KEY NOT NULL,
  "src" integer NOT NULL REFERENCES "node"("rowid") ON DELETE CASCADE,
  "dst" integer NOT NULL REFERENCES "node"("rowid") ON DELETE CASCADE,
  "rel" text NOT NULL CHECK ("rel" IN ('MENTIONS','SUPPORTS','RELATES_TO','SUPERSEDES','DERIVED_FROM','MEMBER_OF','PART_OF','SAME_AS','ASSIGNED_TO','DEPENDS_ON')),
  "weight" real DEFAULT 1,
  "confidence" text,
  "origin" text CHECK ("origin" IN ('extracted','inferred','user_asserted')),
  "meta" text,
  "t_created" text NOT NULL,
  "t_expired" text,
  "t_valid" text,
  "t_invalid" text
);
CREATE INDEX IF NOT EXISTS "ix_edge_src" ON "edge" ("src");
CREATE INDEX IF NOT EXISTS "ix_edge_dst" ON "edge" ("dst");
CREATE INDEX IF NOT EXISTS "ix_edge_rel" ON "edge" ("rel");
`;

// Deliberately permissive (SPEC-PKT-62.md Decision 4): accepts the novel kind/rel in TypeScript so
// the SQL CHECK constraint — not validateKind/validateRel — is what's proven to reject the write.
const permissivePolicy: TypePolicy = {
  validateKind(kind: string): void {
    if (kind === 'component') return;
    DEFAULT_TYPE_POLICY.validateKind(kind);
  },
  validateRel(rel: string): void {
    if (rel === 'COMPONENT_REL') return;
    DEFAULT_TYPE_POLICY.validateRel(rel);
  },
};

async function expectCheckConstraintFailure(fn: () => Promise<unknown>): Promise<{ threw: boolean; matched: boolean; detail?: string }> {
  try {
    await fn();
    return { threw: false, matched: false, detail: 'did not throw' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { threw: true, matched: /CHECK constraint failed/i.test(message), detail: message };
  }
}

async function main(): Promise<void> {
  const adapter = new SqliteAdapterImpl(':memory:');
  await adapter.exec(OLD_CHECK_BEARING_INLINE_DDL);

  const before = await adapter.executeGet<{ sql: string }>(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='node'`,
  );
  if (!before || !before.sql.includes('CHECK ("kind" IN (')) {
    emit({ check: 'closed-ddl-seed-sanity', ok: false, detail: 'seed DDL did not carry the expected node.kind CHECK' });
    await adapter.close();
    process.exitCode = 1;
    return;
  }

  const backend = createGraphBackend(adapter, { typePolicy: permissivePolicy });
  await backend.applySchema();

  // Proves ensureCheckConstraints()'s structural gate no-ops rather than rebuilding: the table
  // identity (its CREATE TABLE sql, still carrying the CHECK) must be unchanged after applySchema().
  const after = await adapter.executeGet<{ sql: string }>(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='node'`,
  );
  const noRebuild = !!after && after.sql === before.sql;
  emit({
    check: 'closed-ddl-no-silent-rebuild',
    ok: noRebuild,
    detail: noRebuild ? undefined : `before=${before.sql} after=${after?.sql}`,
  });

  // ── AC-4 (BL-443) — kind arm: writeNode({kind:'component'}) must fail at the SQL layer ──────
  const kindResult = await expectCheckConstraintFailure(() => backend.writeNode('x', { kind: 'component' }));
  emit({
    check: 'closed-ddl-kind-reject',
    ok: kindResult.threw && kindResult.matched,
    detail: kindResult.detail,
  });

  // Seed two nodes with a known-good kind so the edge arm has valid src/dst to reference.
  const a = await backend.writeNode('seed a', { kind: 'episode' });
  const b = await backend.writeNode('seed b', { kind: 'episode' });

  // ── AC-4 (BL-443) — rel arm: writeEdge(a, b, 'COMPONENT_REL') must fail at the SQL layer ─────
  const relResult = await expectCheckConstraintFailure(() => backend.writeEdge(a, b, 'COMPONENT_REL'));
  emit({
    check: 'closed-ddl-rel-reject',
    ok: relResult.threw && relResult.matched,
    detail: relResult.detail,
  });

  await adapter.close();

  if (anyFailed) process.exitCode = 1;
}

main().catch((err) => {
  emit({ check: 'fixture-fatal', ok: false, detail: String(err && err.stack ? err.stack : err) });
  process.exitCode = 1;
});
