/**
 * BL-341 + BL-449 — the post-`VACUUM INTO` backup verdict must say what it
 * actually checked.
 *
 * Three things could not be told apart before this suite existed, because all
 * three produced `integrityCheck: 'ok'`:
 *
 *   1. the copy was verified and is clean;
 *   2. the copy was verified against ONE pragma that is structurally incapable
 *      of reading an FTS index, and the FTS index is dead (BL-449);
 *   3. the copy was not verified at all — the probe threw, or its output was
 *      truncated at `PRAGMA integrity_check`'s 100-message cap and every
 *      visible message happened to be filterable noise (BL-341).
 *
 * Every test below asserts the structured `integrityReport` verdict, never the
 * prose string — the whole point of the field is that a caller does not have
 * to parse English to learn whether its backup is trustworthy.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { createSqliteAdapter } from '../factory.js';
import { verifyStoreIntegrity, summarizeBackupIntegrity, INTEGRITY_CHECK_MESSAGE_CAP } from '../integrity.js';
import type { StoreAdapter } from '../types.js';

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-backup-verdict-'));
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

// Identical to `integrity-selfheal.test.ts`'s fixture on purpose — same store
// shape, so a verdict difference here is a verdict difference, not a schema one.
const NODE_DDL = `
  CREATE TABLE IF NOT EXISTS node (
    id INTEGER PRIMARY KEY, content TEXT, name TEXT, summary TEXT, topic TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_node_topic_all ON node (topic);
`;
const FTS5_DDL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS fts_node USING fts5(
    content, name, summary, content='node', content_rowid='rowid'
  );
`;

/**
 * The BL-347 damage shape, reused verbatim from `integrity-selfheal.test.ts`:
 * the FTS virtual table and every `sqlite_master` row survive, the content
 * does not. A migrator's `IF NOT EXISTS` sees a healthy-looking artifact.
 */
function seedEmptyFts5Index(adapter: StoreAdapter, ftsTable: string): void {
  const raw = adapter.unwrap() as BetterSqlite3Database;
  raw.exec(`INSERT INTO ${ftsTable}(${ftsTable}) VALUES('delete-all')`);
}

async function seedRows(adapter: StoreAdapter, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await adapter.executeRun(
      `INSERT INTO node (content, name, summary, topic) VALUES (?, ?, ?, ?)`,
      [`episode ${i} concerning quarterly hippopotamus logistics`, `n${i}`, `s${i}`, 't'],
    );
  }
}

/**
 * A `StoreAdapter` whose ONLY real behaviour is what `PRAGMA integrity_check`
 * returns. Producing 100+ genuine btree violations in a real file that still
 * survives `VACUUM INTO` is not reproducible across SQLite builds; the cap is a
 * property of the pragma's output, so the pragma's output is what we control.
 * Everything the verdict pipeline reads downstream is real code.
 */
function stubIntegrityCheckAdapter(behaviour: { messages: string[] } | { throws: Error }): StoreAdapter {
  return {
    executeAll: async (sql: string) => {
      if (!/integrity_check/i.test(sql)) return { rows: [] };
      if ('throws' in behaviour) throw behaviour.throws;
      return { rows: behaviour.messages.map((m) => ({ integrity_check: m })) };
    },
  } as unknown as StoreAdapter;
}

/**
 * `StoreAdapter.backupTo` is optional on the interface (a mock adapter may not
 * implement it). Assert it once, here, instead of scattering `!` through the
 * assertions — a missing `backupTo` should read as a failed precondition, not
 * as a confusing null-deref inside a test about integrity verdicts.
 */
function backupToOf(adapter: StoreAdapter): NonNullable<StoreAdapter['backupTo']> {
  const fn = adapter.backupTo;
  if (fn === undefined) throw new Error('precondition: this adapter implements backupTo()');
  return fn.bind(adapter);
}

/** Exactly the two calls both adapters' `backupTo()` make against the copy. */
async function verdictFor(adapter: StoreAdapter) {
  const report = await verifyStoreIntegrity(adapter, {
    depth: 'deep',
    only: ['pragma_integrity_check'],
  });
  return summarizeBackupIntegrity(report);
}

describe('BL-341 — a truncated integrity_check verdict says it was truncated', () => {
  it('BL-341: >100 real violations are flagged capped, not reported as a bounded count', async () => {
    const messages = Array.from(
      { length: INTEGRITY_CHECK_MESSAGE_CAP + 20 },
      (_, i) => `row ${i} missing from index idx_node_topic`,
    );
    const { verdict, legacyString } = await verdictFor(stubIntegrityCheckAdapter({ messages }));

    expect(verdict.status).toBe('damaged');
    // The load-bearing assertion: `capped` is a STRUCTURED field. Before this
    // fix the only trace of truncation was a clause inside `detail`, which a
    // caller could reach solely by parsing prose — the failure class this repo
    // keeps filing.
    expect(verdict.capped).toBe(true);
    expect(verdict.damagedCount).toBeGreaterThan(0);
    expect(legacyString).not.toBe('ok');
  });

  it('BL-341: 100+ messages with ZERO real damage is `unverified`, never `verified`', async () => {
    // The live shape: a store whose integrity_check output is filled to the cap
    // by page-accounting noise (the production copy carried 45 such pages) and
    // BL-360's unconditional Turso FTS false positive. Nothing un-filterable
    // remains — but the messages PAST the cap were never emitted, so "clean"
    // is not a conclusion the output supports.
    const messages = [
      ...Array.from({ length: INTEGRITY_CHECK_MESSAGE_CAP + 5 }, (_, i) => `Page ${i + 2}: never used`),
      'wrong # of entries in index __turso_internal_fts_dir_idx_fts_node_key',
    ];
    const { verdict, legacyString } = await verdictFor(stubIntegrityCheckAdapter({ messages }));

    expect(verdict.status).toBe('unverified');
    expect(verdict.capped).toBe(true);
    expect(verdict.unknownCount).toBeGreaterThan(0);
    expect(verdict.damagedCount).toBe(0);
    // `IntegrityReport.ok` is still true — nothing was found DAMAGED. That is
    // precisely why reading `.ok` as the backup verdict was the defect.
    expect(verdict.ok).toBe(true);
    // The compatibility string still says 'ok', by design: `unverified` must
    // not delete a backup (that is BL-360's non-convergence trap — a store
    // whose integrity_check is filled with un-repairable leaked-page noise
    // would become permanently unbackupable). The truth lives in `status`.
    expect(legacyString).toBe('ok');
  });

  it('BL-341: under the cap with only filterable noise stays `verified`', async () => {
    // The negative control. Truncation is the signal, not the noise — a store
    // with 45 leaked pages and a working FTS index must still back up cleanly,
    // or the verdict can never return to green and gets tuned out (BL-374).
    const messages = [
      ...Array.from({ length: 45 }, (_, i) => `Page ${i + 2}: never used`),
      'wrong # of entries in index __turso_internal_fts_dir_idx_fts_node_key',
    ];
    const { verdict, legacyString } = await verdictFor(stubIntegrityCheckAdapter({ messages }));

    expect(verdict.status).toBe('verified');
    expect(verdict.capped).toBe(false);
    expect(legacyString).toBe('ok');
  });
});

describe('BL-449 — a probe that could not run is not a clean bill of health', () => {
  it('BL-449: an integrity_check that THROWS yields `unverified`, not `ok`', async () => {
    const { verdict, legacyString } = await verdictFor(
      stubIntegrityCheckAdapter({ throws: new Error('no such pragma: integrity_check') }),
    );

    expect(verdict.status).toBe('unverified');
    expect(verdict.unknownCount).toBe(1);
    // The exact inversion BL-449 names: `report.ok` says true (nothing was
    // found damaged) over a run that established nothing whatsoever. `ok` and
    // the legacy string both still say so — and `status` is the field that
    // refuses to, which is why the verdict had to become structured.
    expect(verdict.ok).toBe(true);
    expect(legacyString).toBe('ok');
  });

  /** A real store with a real FTS index, backed up through the real adapter. */
  async function storeWithLiveFts(label: string): Promise<ReturnType<typeof createSqliteAdapter>> {
    const adapter = track(createSqliteAdapter({ dbPath: tempPath(label) }));
    await adapter.exec(NODE_DDL);
    await adapter.exec(FTS5_DDL);
    await seedRows(adapter, 20);
    await adapter.exec(
      `INSERT INTO fts_node(rowid, content, name, summary)
         SELECT rowid, content, name, summary FROM node`,
    );
    return adapter;
  }

  it('BL-449: NEGATIVE CONTROL — a healthy store backs up as `verified`, checked by every probe', async () => {
    const adapter = await storeWithLiveFts('bl449-healthy');
    const dest = tempPath('bl449-healthy-copy');
    const healthy = await backupToOf(adapter)(dest);

    expect(existsSync(dest)).toBe(true);
    expect(
      healthy.integrityReport?.status,
      'a healthy store must back up as verified: ' + JSON.stringify(healthy.integrityReport, null, 2),
    ).toBe('verified');
    expect(healthy.integrityCheck).toBe('ok');
    // The copy was checked against MORE than one pragma — the `only:`
    // narrowing being gone, asserted rather than assumed.
    expect(healthy.integrityReport?.probesRun).toContain('fts_index_live');
    expect(healthy.integrityReport?.probesRun).toContain('pragma_integrity_check');
  });

  it('BL-449: backupTo() on a store with a DEAD FTS index does not certify the copy `ok`', async () => {
    const adapter = await storeWithLiveFts('bl449-dead-fts');

    // Damage: the index object survives, its content does not (BL-347).
    seedEmptyFts5Index(adapter, 'fts_node');

    const dest = tempPath('bl449-damaged-copy');
    const result = await backupToOf(adapter)(dest);

    // `PRAGMA integrity_check` is green on this copy — the file is a
    // structurally perfect SQLite database. The damage is in the CONTENT of a
    // derived artifact, which is why one pragma could never see it. THIS is
    // the assertion that goes red if the `only:` narrowing comes back.
    expect(
      result.integrityReport?.status,
      'a backup of a store with a dead FTS index must not be certified: ' +
        JSON.stringify(result.integrityReport, null, 2),
    ).toBe('damaged');
    expect(result.integrityCheck).not.toBe('ok');
    expect(
      result.integrityReport?.findings.some(
        (f) => f.probe === 'fts_index_live' && f.status === 'damaged',
      ),
    ).toBe(true);
  });

  it('BL-449: skipIntegrityCheck reports NO verdict rather than a passing one', async () => {
    const dbPath = tempPath('bl449-skipped');
    const adapter = track(createSqliteAdapter({ dbPath }));
    await adapter.exec(NODE_DDL);
    await seedRows(adapter, 3);

    const dest = tempPath('bl449-skipped-copy');
    const result = await backupToOf(adapter)(dest, { skipIntegrityCheck: true });

    // `integrityCheck: 'ok'` here has always been a lie of convenience. The
    // structured field refuses to tell it: nothing ran, so there is no verdict.
    expect(result.integrityReport).toBeUndefined();
  });
});
