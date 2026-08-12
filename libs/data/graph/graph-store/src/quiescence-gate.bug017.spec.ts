/**
 * BUG-017 / BL-563 — graph-store's fts5-residue drop is quiescence-gated
 * (SPEC §T1 Change 3) and never mutates a readonly-open store (BL-563).
 *
 * The graph-store heal (`ensureCheckConstraints` → `rebuildTable`) deletes
 * dead fts5 residue from `sqlite_master` BEFORE rebuilding `edge`. The drop is
 * a WRITABLE better-sqlite3 open through
 * `TursoAdapterImpl.withConnectionClosedForRepair` — the BUG-014 poisoner
 * shape (exp9) when live turso multiprocess peers hold the store, and (BL-563)
 * a silent file mutation on a readonly-open adapter (readonly is enforced by
 * the adapter's connection, which the repair closes; better-sqlite3 opens the
 * file writable).
 *
 * - Test 1 (BUG-017): with a REAL child-process turso peer holding the store,
 *   the heal DEFERS the drop (`graph_store.heal.fts5_residue_drop_deferred_live_peers`)
 *   and the rebuild still completes — RED (pre-fix): the unguarded drop runs
 *   under the live peer (residue gone, WAL destroyed).
 * - Test 2 (BL-563): a readonly-open adapter reaches the heal and its rebuild
 *   fails on readonly as expected — but the residue must SURVIVE. RED
 *   (pre-fix): the drop runs before the rebuild's readonly failure, silently
 *   mutating the read-only open.
 *
 * Both arms use real engines; the peer is a REAL child process.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { TursoAdapterImpl } from '@adhd/sox-store-adapter';
import { log } from '@adhd/sox-telemetry';
import { createGraphBackend } from './index.js';

const require = createRequire(import.meta.url);

const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();
const tursoArm = hasTurso ? it : it.skip;

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const CHILD = resolve(HERE, '__tests__', 'fixtures', 'quiescence-child.bug017.ts');

// ── The legacy fixture (row order is the point) ──────────────────────────────

const DRIZZLE_MIGRATIONS_DDL = `CREATE TABLE "__drizzle_migrations" (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
)`;

const LIVE_NODE_DDL = `CREATE TABLE \`node\` (
  \`rowid\` integer PRIMARY KEY NOT NULL,
  \`uid\` text NOT NULL,
  \`kind\` text NOT NULL CHECK (\`kind\` IN ('episode','entity','claim','community','session','generic')),
  \`content\` text, \`name\` text, \`summary\` text, \`topic\` text, \`tags\` text,
  \`importance\` real DEFAULT 1.0, \`confidence\` real, \`content_hash\` text,
  \`namespace\` text DEFAULT 'global', \`meta\` text, \`agent_id\` text, \`session_id\` text,
  \`source\` text CHECK (\`source\` IN ('message','tool_output','observation','document','reflection','import')),
  \`project_path\` text, \`level\` integer, \`resume_state\` text, \`t_occurred\` text, \`t_expires\` text,
  \`t_created\` text NOT NULL, \`t_valid\` text, \`t_invalid\` text, \`is_superseded\` integer DEFAULT 0,
  \`access_count\` integer DEFAULT 0, \`last_access\` text, \`t_updated\` text
)`;

const LIVE_EDGE_DDL = `CREATE TABLE \`edge\` (
  \`rowid\` integer PRIMARY KEY NOT NULL,
  \`src\` integer NOT NULL REFERENCES \`node\`(\`rowid\`) ON DELETE CASCADE,
  \`dst\` integer NOT NULL REFERENCES \`node\`(\`rowid\`) ON DELETE CASCADE,
  \`rel\` text NOT NULL CHECK (\`rel\` IN ('MENTIONS','SUPPORTS','RELATES_TO','SUPERSEDES','DERIVED_FROM','MEMBER_OF','PART_OF','SAME_AS','ASSIGNED_TO','DEPENDS_ON')),
  \`weight\` real DEFAULT 1.0, \`confidence\` real,
  \`origin\` text CHECK (\`origin\` IN ('extracted','inferred','user_asserted')),
  \`meta\` text, \`t_created\` text NOT NULL, \`t_expired\` text, \`t_valid\` text, \`t_invalid\` text
)`;

const DRIZZLE_NODE_INDEX_DDLS = [
  `CREATE UNIQUE INDEX \`node_uid_unique\` ON \`node\` (\`uid\`)`,
  `CREATE INDEX \`ix_node_kind\` ON \`node\` (\`kind\`)`,
  `CREATE INDEX \`ix_node_hash\` ON \`node\` (\`content_hash\`)`,
  `CREATE INDEX \`ix_node_agent\` ON \`node\` (\`agent_id\`)`,
  `CREATE INDEX \`ix_node_session\` ON \`node\` (\`session_id\`)`,
  `CREATE INDEX \`ix_node_validity\` ON \`node\` (\`t_invalid\`) WHERE \`t_invalid\` IS NULL`,
  `CREATE INDEX \`ix_node_importance\` ON \`node\` (\`importance\`)`,
  `CREATE INDEX \`ix_node_temporal\` ON \`node\` (\`t_invalid\`, \`t_created\` DESC) WHERE \`t_invalid\` IS NULL`,
  `CREATE INDEX \`ix_node_topic\` ON \`node\` (\`topic\`) WHERE \`topic\` IS NOT NULL`,
  `CREATE INDEX \`ix_node_project\` ON \`node\` (\`project_path\`) WHERE \`project_path\` IS NOT NULL`,
  `CREATE INDEX \`ix_node_namespace\` ON \`node\` (\`namespace\`)`,
  `CREATE INDEX \`ix_node_expires\` ON \`node\` (\`t_expires\`) WHERE \`t_expires\` IS NOT NULL`,
];

const FTS5_VIRTUAL_TABLE = `CREATE VIRTUAL TABLE fts_node USING fts5(content, name, summary,
  content='node', content_rowid='rowid', tokenize='unicode61')`;
const FTS5_TRIGGERS = [
  `CREATE TRIGGER fts_node_ai AFTER INSERT ON node BEGIN
INSERT INTO fts_node (rowid, content, name, summary) VALUES (new.rowid, new.content, new.name, new.summary);
END`,
  `CREATE TRIGGER fts_node_ad AFTER DELETE ON node BEGIN
INSERT INTO fts_node (fts_node, rowid, content, name, summary) VALUES ('delete', old.rowid, old.content, old.name, old.summary);
END`,
  `CREATE TRIGGER fts_node_au AFTER UPDATE ON node BEGIN
INSERT INTO fts_node (fts_node, rowid, content, name, summary) VALUES ('delete', old.rowid, old.content, old.name, old.summary);
INSERT INTO fts_node (rowid, content, name, summary) VALUES (new.rowid, new.content, new.name, new.summary);
END`,
];

/** Build the legacy fixture via better-sqlite3: the removed-migration store
 *  shape — node + explicit-rowid-FK edge + node indexes, THEN the fts5
 *  residue — byte-identical to the live backlog.db's row order (BL-506). */
function buildLegacyFkHealFixture(dbPath: string): void {
  const Database = require('better-sqlite3') as new (p: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...args: unknown[]): void };
    close(): void;
  };
  const db = new Database(dbPath);
  db.exec(DRIZZLE_MIGRATIONS_DDL); // rowid 1
  db.exec(LIVE_NODE_DDL); // rowid 2
  db.exec(LIVE_EDGE_DDL); // rowid 3 — BEFORE the residue
  for (const ddl of DRIZZLE_NODE_INDEX_DDLS) db.exec(ddl); // rowids 4-15
  db.exec(FTS5_VIRTUAL_TABLE); // rowid 16 + 4 shadow tables (17-20)
  for (const t of FTS5_TRIGGERS) db.exec(t); // rowids 21-23
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO node (uid, kind, content, name, t_created) VALUES (?, 'episode', ?, ?, ?)`,
  ).run('n1', 'first node content', 'first', now);
  db.prepare(
    `INSERT INTO node (uid, kind, content, name, t_created) VALUES (?, 'episode', ?, ?, ?)`,
  ).run('n2', 'second node content', 'second', now);
  db.prepare(`INSERT INTO edge (src, dst, rel, t_created) VALUES (1, 2, 'MENTIONS', ?)`).run(now);
  db.close();
}

/** Resolve when the child prints `READY=<pid>` (or fail on early exit). */
function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolveReady, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timed out waiting for the peer child READY')),
      30000,
    );
    timer.unref();
    let buf = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.includes('READY=')) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`peer child exited before READY (code ${code})`));
    });
  });
}

async function residueNames(adapter: TursoAdapterImpl): Promise<string[]> {
  const res = await adapter.executeAll<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE name LIKE 'fts_node%'`,
  );
  return res.rows.map((r) => r.name);
}

/** Resolve when the child has exited — immediately if it already has. */
function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((done) => child.once('exit', () => done()));
}

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'graph-store-bug017-'));
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('BUG-017/BL-563 — graph-store residue drop quiescence + readonly gates', () => {
  tursoArm(
    'BUG-017: with a live turso peer, the heal DEFERS the residue drop (logged) and the rebuild still completes',
    async () => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const dbPath = join(tmpDir, `gate-live-${suffix}.db`);
      buildLegacyFkHealFixture(dbPath);

      // Spawn the REAL turso multiprocess peer holding the store.
      const child: ChildProcess = spawn(
        process.execPath,
        ['--import', 'tsx', CHILD, dbPath],
        { stdio: ['ignore', 'pipe', 'pipe'], cwd: process.cwd() },
      );
      await waitForReady(child);

      const warnSpy = vi.spyOn(log, 'warn');
      try {
        const adapter = await TursoAdapterImpl.connect({ dbPath });
        try {
          const graph = createGraphBackend(adapter);
          // GREEN: the heal completes — the deferred drop must not abort it.
          await expect(graph.applySchema()).resolves.toBeUndefined();

          // The drop was DEFERRED, never run: the residue must still be present.
          const residue = await residueNames(adapter);
          expect(
            residue.length,
            'BUG-017: the residue drop must be DEFERRED while a live peer holds the store',
          ).toBeGreaterThan(0);
          // INV-5: the deferral is logged loudly with the typed reason.
          expect(warnSpy.mock.calls.map((c) => c[0])).toContain(
            'graph_store.heal.fts5_residue_drop_deferred_live_peers',
          );

          // The heal's in-session work still completed: the caller handle is
          // live (the hook's finally reopened it) and writes still land.
          const id = await graph.writeNode('post-heal write probe', {});
          expect(id).toBeGreaterThan(0);
        } finally {
          await adapter.close();
        }
      } finally {
        warnSpy.mockRestore();
        child.kill('SIGKILL');
        await waitForExit(child);
      }
    },
    90000,
  );

  tursoArm(
    'BL-563: a readonly-open adapter NEVER drops residue — the drop is a silent file mutation that must be gated',
    async () => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const dbPath = join(tmpDir, `gate-ro-${suffix}.db`);
      buildLegacyFkHealFixture(dbPath);

      // Pre-heal with a WRITABLE quiescent open (create the Tantivy FTS
      // index), so the store shape matches a fully-migrated legacy store —
      // the population BL-563's review finding observed.
      const warm = await TursoAdapterImpl.connect({ dbPath });
      try {
        await warm.ensureFtsIndex('node', ['content', 'name', 'summary'], {
          weights: { content: 1.0, name: 1.0, summary: 1.0 },
          backfill: true,
        });
      } finally {
        await warm.close();
      }

      // The READONLY open. The gate under test is `dropFts5ResidueBeforeRebuild`
      // itself — reached directly because the PUBLIC `applySchema` path can
      // never reach the heal on a readonly connection: its unconditional
      // INLINE_MIGRATION_DDL `CREATE TABLE IF NOT EXISTS` statements throw
      // "Resource is read-only" first (measured 2026-08-12 against
      // @tursodatabase/database@0.7.1), so a public-path test would be
      // vacuous (it passes pre- and post-fix). BL-563's defect is precisely
      // that the DROP — the one mutation a read-only open must never perform
      // — runs inside the repair hook, whose better-sqlite3 write bypasses
      // the adapter's readonly layer (that layer is the adapter's own
      // connection, which the repair closes). The typed cast is the test
      // seam to the private method that carries the gate.
      //
      // (BUG-017 review follow-up) The seam pins the test to THIS method: it
      // keeps the gate-removal case red, but it does NOT guard against a
      // future refactor that re-routes the drop around
      // `dropFts5ResidueBeforeRebuild` entirely (e.g. the drop moving into
      // the adapter hook). That structural guard is SPEC §T8's single
      // classic-engine-access choke point (`classic-engine-access.ts` + the
      // eslint ban), which is the tracked follow-up; until then this
      // method-level seam is the best reachable pin on a readonly connection.
      const adapter = await TursoAdapterImpl.connect({ dbPath, readonly: true });
      try {
        const graph = createGraphBackend(adapter);
        const dropResidue = (
          graph as unknown as { dropFts5ResidueBeforeRebuild(): Promise<void> }
        ).dropFts5ResidueBeforeRebuild;

        // Invoked as a METHOD (receiver preserved) — the seam is the cast,
        // not an unbound extraction.
        await dropResidue.call(graph);

        // The residue survives: the readonly open never dropped it. RED
        // (pre-fix): the drop runs (better-sqlite3 opens the file writable,
        // bypassing the closed readonly connection) and the residue is gone.
        const residue = await residueNames(adapter);
        expect(
          residue.length,
          'BL-563: a readonly open must NEVER mutate the store — the residue survives',
        ).toBeGreaterThan(0);
      } finally {
        await adapter.close();
      }
    },
    90000,
  );
});
