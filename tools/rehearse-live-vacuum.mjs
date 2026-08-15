#!/usr/bin/env node
/**
 * rehearse-live-vacuum.mjs — rehearse the offline-VACUUM remediation for
 * BUG-INTEGRITY-CHECK-BLINDED-BY-PAGE-NOISE-001 against a SCRATCH COPY of the
 * live store. NEVER touches the live process or ~/.memory/memory.db directly.
 *
 * Team-lead constraint: "You MAY NOT, without explicit approval, stop the
 * live memory-server, or VACUUM ~/.memory/memory.db." This script does
 * neither. It:
 *
 *   1. Takes a live-consistent copy of the CURRENT ~/.memory/memory.db via
 *      the already-proven backupStore()/VACUUM INTO path (read-only against
 *      the source, safe under concurrent writers — backup.ts:118) into
 *      ~/.memory/backups/vacuum-rehearsal-<ts>/baseline.db. This step alone
 *      is a legitimate VACUUM INTO — it is NOT the destructive step, but it
 *      DOES double as "does the page-noise clear when you VACUUM INTO a
 *      fresh file", which is the actual open question, since VACUUM INTO
 *      produces the same defragmented, free-page-reclaimed result as a
 *      plain in-place VACUUM for the purpose of the page-count probe.
 *   2. Runs verifyStoreIntegrity(depth:'deep') on that baseline copy — this
 *      reproduces (on a copy, not live) the same "unknown, cap-blinded"
 *      verdict already observed live by BUG-INTEGRITY-CHECK-BLINDED-BY-PAGE-NOISE-001.
 *   3. Runs backupStore() AGAIN, this time from the baseline copy to a
 *      second file (`vacuumed.db`) — a second VACUUM INTO pass. Reports
 *      whether the page/message count that saturated the cap the first time
 *      is gone the second time (i.e. whether VACUUM actually clears it, or
 *      whether the noise regenerates / is structural).
 *   4. Runs verifyStoreIntegrity(depth:'deep') on `vacuumed.db` and reports
 *      whether `pragma_integrity_check` now completes UNDER the 100-message
 *      cap (a `verified`/`unknown-but-uncapped` result) instead of hitting it.
 *   5. Diffs node/edge/episode/vector counts between baseline and vacuumed —
 *      VACUUM must not change row-level content, only physical layout.
 *
 * Everything under ~/.memory/backups/vacuum-rehearsal-<ts>/ is left on disk
 * (not cleaned up) so it can be inspected — pass --clean to remove it after
 * a successful run.
 *
 * Usage: node --import tsx tools/rehearse-live-vacuum.mjs [--clean]
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { backupStore, isBackupStoreError, openDb, openDbReadOnly } from '@adhd/sox-memory-core';
import { verifyStoreIntegrity } from '@adhd/sox-store-adapter';

const HOME = process.env['HOME'] ?? homedir();
const LIVE_DB = join(HOME, '.memory', 'memory.db');
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const rehearsalDir = join(HOME, '.memory', 'backups', `vacuum-rehearsal-${ts}`);
const baselinePath = join(rehearsalDir, 'baseline.db');
const vacuumedPath = join(rehearsalDir, 'vacuumed.db');
const clean = process.argv.includes('--clean');

async function counts(dbPath) {
  const adapter = await openDb(dbPath);
  try {
    const n = await adapter.executeAll('SELECT count(*) AS c FROM node');
    const e = await adapter.executeAll('SELECT count(*) AS c FROM edge');
    const ep = await adapter.executeAll(
      "SELECT count(*) AS c FROM node WHERE kind = 'episode' AND t_invalid IS NULL",
    );
    let vectors = null;
    const vecTable = await adapter.executeGet(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'vec_%' LIMIT 1",
    );
    if (vecTable && vecTable.name) {
      const v = await adapter.executeAll(`SELECT count(*) AS c FROM "${vecTable.name}"`);
      vectors = v.rows[0]?.c ?? null;
    }
    return { nodes: n.rows[0]?.c ?? null, edges: e.rows[0]?.c ?? null, episodes: ep.rows[0]?.c ?? null, vectors };
  } finally {
    await adapter.close();
  }
}

async function integrityOf(dbPath) {
  const adapter = await openDb(dbPath);
  try {
    const report = await verifyStoreIntegrity(adapter, { depth: 'deep' });
    const capProbe = report.findings.find((f) => f.probe === 'pragma_integrity_check');
    return {
      ok: report.ok,
      probes_run: report.findings.length,
      damaged: report.damaged.map((f) => ({ probe: f.probe, object: f.object, detail: f.detail })),
      integrity_check_probe: capProbe
        ? { status: capProbe.status, detail: capProbe.detail }
        : { status: 'not_run' },
      hit_cap: capProbe ? /hit the 100-message cap/i.test(capProbe.detail ?? '') : null,
    };
  } finally {
    await adapter.close();
  }
}

const result = { rehearsal_dir: rehearsalDir, steps: {}, pass: false };

try {
  if (!existsSync(LIVE_DB)) {
    throw new Error(`live store not found at ${LIVE_DB} — nothing to rehearse against`);
  }
  mkdirSync(rehearsalDir, { recursive: true });

  // Step 0: read-only diagnostic against the LIVE store itself (no copy, no
  // write, no stop) — reproduces the CRITICAL finding independently before
  // touching anything, using the exact same read-only-connection mechanism
  // memory_stats' own deep probe used to discover it. This does NOT violate
  // "never VACUUM/stop the live store" — it is a read.
  console.error('[rehearse] step 0: verifyStoreIntegrity(LIVE memory.db, deep) — read-only, no mutation');
  const liveAdapter = await openDbReadOnly(LIVE_DB);
  let liveIntegrity;
  try {
    const report = await verifyStoreIntegrity(liveAdapter, { depth: 'deep' });
    const capProbe = report.findings.find((f) => f.probe === 'pragma_integrity_check');
    liveIntegrity = {
      ok: report.ok,
      probes_run: report.findings.length,
      damaged: report.damaged.map((f) => ({ probe: f.probe, object: f.object, detail: f.detail })),
      integrity_check_probe: capProbe ? { status: capProbe.status, detail: capProbe.detail } : { status: 'not_run' },
      hit_cap: capProbe ? /hit the 100-message cap/i.test(capProbe.detail ?? '') : null,
    };
  } finally {
    await liveAdapter.close();
  }
  result.steps.live_integrity_before_any_action = liveIntegrity;

  // Step 1: live-consistent snapshot of the CURRENT live store, via the
  // already-proven, allowlisted, non-destructive VACUUM INTO path. Read-only
  // against ~/.memory/memory.db; the live server is never touched.
  console.error(`[rehearse] step 1: backupStore(${LIVE_DB} -> ${baselinePath}) [proven VACUUM INTO path]`);
  const b1 = await backupStore(LIVE_DB, baselinePath, {
    log: (...a) => console.error('  [backup]', ...a),
  });
  if (isBackupStoreError(b1)) {
    throw new Error(`baseline backupStore failed: ${b1.code} ${b1.message}`);
  }
  result.steps.baseline_backup = { ok: true, integrity_report: b1.integrityReport?.status ?? null };

  // Step 2: integrity of the baseline copy (should reproduce the live
  // cap-blinded 'unknown' verdict — this is diagnostic, not the fix).
  console.error('[rehearse] step 2: verifyStoreIntegrity(baseline.db, deep)');
  const baselineIntegrity = await integrityOf(baselinePath);
  result.steps.baseline_integrity = baselineIntegrity;
  const baselineCounts = await counts(baselinePath);
  result.steps.baseline_counts = baselineCounts;

  // Step 3: second VACUUM INTO pass — baseline.db -> vacuumed.db. This is
  // the rehearsal of the actual remediation: an offline VACUUM that
  // re-serializes the file and reclaims unreachable pages. Using VACUUM INTO
  // (not in-place VACUUM) is deliberate — it never mutates its source, so
  // baseline.db (itself already a disposable copy of live, not live itself)
  // stays available for comparison even if this step is repeated.
  console.error(`[rehearse] step 3: backupStore(${baselinePath} -> ${vacuumedPath}) [second VACUUM INTO pass]`);
  const b2 = await backupStore(baselinePath, vacuumedPath, {
    log: (...a) => console.error('  [backup]', ...a),
  });
  if (isBackupStoreError(b2)) {
    throw new Error(`second-pass backupStore failed: ${b2.code} ${b2.message}`);
  }
  result.steps.vacuum_pass = { ok: true, integrity_report: b2.integrityReport?.status ?? null };

  // Step 4: integrity of the vacuumed copy — the decisive question.
  console.error('[rehearse] step 4: verifyStoreIntegrity(vacuumed.db, deep)');
  const vacuumedIntegrity = await integrityOf(vacuumedPath);
  result.steps.vacuumed_integrity = vacuumedIntegrity;
  const vacuumedCounts = await counts(vacuumedPath);
  result.steps.vacuumed_counts = vacuumedCounts;

  // Step 5: content-preserving check — VACUUM must not change row counts.
  const countsPreserved =
    baselineCounts.nodes === vacuumedCounts.nodes &&
    baselineCounts.edges === vacuumedCounts.edges &&
    baselineCounts.episodes === vacuumedCounts.episodes &&
    baselineCounts.vectors === vacuumedCounts.vectors;
  result.steps.counts_preserved = countsPreserved;

  result.summary = {
    live_hit_cap_before_any_vacuum: liveIntegrity.hit_cap,
    single_vacuum_into_pass_cleared_cap: liveIntegrity.hit_cap === true && baselineIntegrity.hit_cap === false,
    second_pass_stable: baselineIntegrity.hit_cap === false && vacuumedIntegrity.hit_cap === false,
    new_damage_after_vacuum:
      (baselineIntegrity.damaged.length > 0 || vacuumedIntegrity.damaged.length > 0) &&
      liveIntegrity.damaged.length === 0,
    counts_preserved: countsPreserved,
  };
  result.pass = countsPreserved && baselineIntegrity.damaged.length === 0 && vacuumedIntegrity.damaged.length === 0;

  if (clean) {
    rmSync(rehearsalDir, { recursive: true, force: true });
    result.cleaned = true;
  }
} catch (err) {
  result.error = err instanceof Error ? { message: err.message, stack: err.stack } : String(err);
  result.pass = false;
}

console.log(JSON.stringify(result, null, 2));
process.exit(result.pass ? 0 : 1);
