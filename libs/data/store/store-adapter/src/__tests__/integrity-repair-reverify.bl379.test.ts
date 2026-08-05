/**
 * BL-379 — a probe that cannot run must say so, not vanish.
 *
 * `repairStoreIntegrity()` re-verified with `{ depth: report.depth }` and
 * forwarded no `walBaseline`. `probeWalIdentity()` returns `null` without one,
 * and a `null` finding is never pushed — so `wal_identity` contributed
 * **nothing** to any post-repair report, silently. Repair does real work (an
 * FTS rebuild took 982 ms on the live store); a WAL unlinked during that window
 * was invisible to the verification that immediately followed it.
 *
 * The finding was *absent*, not wrong, so every assertion here is on
 * **presence** — and the negative control pins the other half of the bar:
 * the report must distinguish *ran and clean* from *did not run*.
 *
 * Damage recipe is BL-342's (`''` in a JSON column, repaired by normalising to
 * NULL) purely because it is the cheapest repairable finding that exercises the
 * real repair→reverify path. The subject under test is the WAL hand-off.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSqliteAdapter } from '../factory.js';
import {
  verifyStoreIntegrity,
  repairStoreIntegrity,
  verifyAndRepair,
  captureWalIdentity,
} from '../integrity.js';
import type { IntegrityFinding, IntegrityReport } from '../integrity.js';
import type { StoreAdapter } from '../types.js';

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-bl379-'));
});

let seq = 0;
function tempPath(label: string): string {
  return join(tmpDir, `${label}-${Date.now()}-${seq++}.db`);
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

/**
 * A store with a live `-wal` sidecar and one repairable JSON finding.
 *
 * `journal_mode = WAL` is set explicitly: better-sqlite3 defaults to `delete`,
 * and with no `-wal` on disk the baseline reads `present: false` and the probe
 * legitimately has nothing to compare — which would make this suite pass for
 * the wrong reason.
 */
async function seedDamagedWalStore(label: string): Promise<{ adapter: StoreAdapter; dbPath: string }> {
  const dbPath = tempPath(label);
  const adapter = track(createSqliteAdapter({ dbPath }));
  await adapter.exec('PRAGMA journal_mode = WAL');
  await adapter.exec(NODE_DDL);
  for (let i = 0; i < 10; i++) {
    await adapter.executeRun(
      `INSERT INTO node (uid, kind, content, tags, meta, enrich_ver, t_created)
       VALUES (?, 'episode', ?, ?, ?, ?, ?)`,
      [
        `bl379-ok-${seq++}`,
        `episode ${i}`,
        JSON.stringify([`tag-${i % 3}`]),
        JSON.stringify({ source: 'test', i }),
        JSON.stringify({ pass: '1.4.0' }),
        new Date().toISOString(),
      ],
    );
  }
  // The BL-342 shape: `''` where the schema means NULL. Repairable, and its
  // repair is a plain UPDATE, so the repair pass here can never be the thing
  // that fails.
  await adapter.executeRun(
    `INSERT INTO node (uid, kind, content, enrich_ver, t_created) VALUES (?, 'episode', ?, ?, ?)`,
    [`bl379-bad-${seq++}`, 'restored row', '', new Date().toISOString()],
  );

  expect(
    existsSync(dbPath + '-wal'),
    'precondition: the store must really have a WAL sidecar, or the probe has nothing to compare',
  ).toBe(true);
  return { adapter, dbPath };
}

function walFindings(report: IntegrityReport | null): IntegrityFinding[] {
  return (report?.findings ?? []).filter((f) => f.probe === 'wal_identity');
}

describe('BL-379 — post-repair reverification cannot silently skip the WAL-identity probe', () => {
  it('BL-379 negative control: WAL intact — the post-repair report says the probe RAN and is clean', async () => {
    const { adapter, dbPath } = await seedDamagedWalStore('bl379-control');
    const baseline = captureWalIdentity(dbPath);
    expect(baseline?.present).toBe(true);

    const before = await verifyStoreIntegrity(adapter, { walBaseline: baseline });
    expect(
      before.damaged.some((f) => f.probe === 'json_column_valid'),
      'precondition: there must be something to repair, or no reverify runs at all',
    ).toBe(true);

    const repair = await repairStoreIntegrity(adapter, before, { walBaseline: baseline });
    expect(repair.verified, 'repair must re-verify, never be believed on its own').not.toBeNull();

    // "Ran and clean" — distinguishable from "did not run", which is the whole
    // point of the item. Absence would read identically to health.
    const found = walFindings(repair.verified);
    expect(found.length, JSON.stringify(repair.verified!.findings, null, 2)).toBe(1);
    expect(found[0]!.status).toBe('ok');
    expect(found[0]!.probeValidated).toBe(true);
  });

  it('BL-379: a WAL unlinked BETWEEN the damage and the repair appears in the post-repair report', async () => {
    const { adapter, dbPath } = await seedDamagedWalStore('bl379-unlinked');
    const baseline = captureWalIdentity(dbPath);
    expect(baseline?.present).toBe(true);

    const before = await verifyStoreIntegrity(adapter, { walBaseline: baseline });
    expect(before.damaged.some((f) => f.probe === 'json_column_valid')).toBe(true);
    // The pre-repair pass saw a healthy WAL — so a finding in the POST-repair
    // report can only have come from the reverify, not from a stale copy.
    expect(walFindings(before).map((f) => f.status)).toEqual(['ok']);

    // …and now the WAL vanishes mid-pass. This is BL-330's damage, arriving in
    // the one window BL-379 says nothing was watching.
    unlinkSync(dbPath + '-wal');
    expect(existsSync(dbPath + '-wal')).toBe(false);

    const repair = await repairStoreIntegrity(adapter, before, { walBaseline: baseline });
    expect(repair.verified).not.toBeNull();

    // ASSERT ON PRESENCE. Before the fix this array was empty: the probe
    // returned null for want of a baseline and the finding was never pushed,
    // so the report omitted it rather than reporting it wrong.
    const found = walFindings(repair.verified);
    expect(
      found.length,
      'the post-repair report omitted wal_identity entirely (BL-379): ' +
        JSON.stringify(repair.verified!.findings.map((f) => f.probe)),
    ).toBe(1);
    expect(found[0]!.status).toBe('damaged');
    expect(found[0]!.backlog).toBe('BL-330');
    expect(found[0]!.detail).toMatch(/unlinked|replaced/);

    // …and the top-level verdict must not clear over it. A repair that ends
    // with the WAL gone is not `ok`, however well its own actions went.
    expect(repair.actions.every((a) => a.ok)).toBe(true);
    expect(repair.ok, 'reverify found damage, so the repair verdict cannot be ok').toBe(false);
  });

  it('BL-379: the open path forwards it too — verifyAndRepair reverifies with the baseline it holds', async () => {
    const { adapter, dbPath } = await seedDamagedWalStore('bl379-openpath');
    const baseline = captureWalIdentity(dbPath);
    expect(baseline?.present).toBe(true);

    unlinkSync(dbPath + '-wal');

    const result = await verifyAndRepair(adapter, { walBaseline: baseline });
    expect(result.repair, 'there was repairable damage, so a repair pass must have run').not.toBeNull();

    // `verifyAndRepair` is the only caller already holding the baseline, so it
    // is the one place a dropped hand-off silences the probe on every adapter
    // open (`runOpenTimeIntegrity`).
    const found = walFindings(result.repair!.verified);
    expect(
      found.length,
      'the open path repaired and reverified without the WAL probe: ' +
        JSON.stringify(result.repair!.verified?.findings.map((f) => f.probe)),
    ).toBe(1);
    expect(found[0]!.status).toBe('damaged');
  });
});
