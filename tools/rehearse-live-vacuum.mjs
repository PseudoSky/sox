#!/usr/bin/env node
/**
 * rehearse-live-vacuum.mjs — rehearse the offline-VACUUM remediation for
 * BUG-INTEGRITY-CHECK-BLINDED-BY-PAGE-NOISE-001 against a SCRATCH COPY of the
 * live store, and test the page-leak hypothesis the team lead measured across
 * snapshots (2.7MB/episode growth, freelist_count 0-2, 71% file overhead on
 * the Aug 8 snapshot). NEVER touches the live process or ~/.memory/memory.db
 * for anything but a read-only connection.
 *
 * Team-lead constraint, unchanged: no live VACUUM, no stopping the server,
 * without explicit approval. Delete nothing.
 *
 * REVISION 2 (this version) fixes a methodology gap in the first rehearsal:
 * that version measured "baseline" as a VACUUM INTO copy of live, which is
 * ALREADY compacted — comparing it to a second VACUUM INTO pass could only
 * ever show "stable", never reveal whether the live file itself carries the
 * leaked-page overhead. This version measures the BEFORE state directly on
 * the live file via a read-only connection (page_count/page_size/
 * freelist_count/payload/raw integrity_check messages — all pure SELECT/
 * PRAGMA reads, zero mutation), then measures the AFTER state on a single
 * VACUUM INTO copy. That before/after delta, on the SAME logical content, is
 * the number that answers the leak hypothesis.
 *
 * Steps:
 *   0. BEFORE: read-only PRAGMA + payload + raw integrity_check against LIVE
 *      memory.db directly. No copy made yet.
 *   1. Single VACUUM INTO pass: live -> scratch copy (the proven backupStore()
 *      path, read-only against the source, backup.ts:118).
 *   2. AFTER: same PRAGMA + payload + raw integrity_check measurements
 *      against the scratch copy.
 *   3. Idempotency check: a second VACUUM INTO pass, copy -> copy2, confirms
 *      the AFTER state is stable (not still shrinking).
 *   4. Row-count diff (node/edge/episode/vector) between copy and copy2 —
 *      VACUUM must not change content, only physical layout.
 *   5. Verdict on the leak hypothesis, led by the single number that decides
 *      whether a production VACUUM is worth it: the page_count delta.
 *
 * Usage: node --import tsx tools/rehearse-live-vacuum.mjs [--clean]
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { backupStore, isBackupStoreError, openDb, openDbReadOnly } from '@adhd/sox-memory-core';
import { classifyIntegrityMessages } from '@adhd/sox-store-adapter';

const HOME = process.env['HOME'] ?? homedir();
const LIVE_DB = join(HOME, '.memory', 'memory.db');
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const rehearsalDir = join(HOME, '.memory', 'backups', `vacuum-rehearsal-${ts}`);
const vacuumedPath = join(rehearsalDir, 'vacuumed.db');
const vacuumed2Path = join(rehearsalDir, 'vacuumed-pass2.db');
const clean = process.argv.includes('--clean');

/** Enumerate real, non-internal tables — same filter class integrity.ts uses. */
async function userTables(adapter) {
  const res = await adapter.executeAll(
    "SELECT name FROM sqlite_master WHERE type = 'table' " +
      "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_\\_turso\\_internal%' ESCAPE '\\'",
  );
  return res.rows.map((r) => r.name);
}

/**
 * Payload total via the column-sum method: for every user table, sum
 * length() of every non-rowid column across all rows. Matches the team
 * lead's method exactly for comparability with their snapshot measurements.
 * Tables that error (some virtual-table shadow tables don't support this)
 * are recorded as skipped, not silently dropped from the total.
 */
async function payloadTotal(adapter) {
  const tables = await userTables(adapter);
  const perTable = {};
  const skipped = [];
  let total = 0;
  for (const table of tables) {
    let cols;
    try {
      const info = await adapter.executeAll(`PRAGMA table_info("${table}")`);
      cols = info.rows.map((c) => c.name).filter((n) => n !== 'rowid');
    } catch (err) {
      skipped.push({ table, reason: `table_info failed: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    if (cols.length === 0) {
      skipped.push({ table, reason: 'no columns after excluding rowid' });
      continue;
    }
    const expr = cols.map((c) => `coalesce(length("${c}"),0)`).join('+');
    try {
      const sum = await adapter.executeGet(`SELECT sum(${expr}) AS bytes FROM "${table}"`);
      const bytes = sum && sum.bytes != null ? Number(sum.bytes) : 0;
      perTable[table] = bytes;
      total += bytes;
    } catch (err) {
      skipped.push({ table, reason: `sum query failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return { total_bytes: total, per_table_bytes: perTable, skipped };
}

/**
 * Raw, unfiltered PRAGMA integrity_check, classified via the shared
 * classifier (DEBT-NO-SHARED-TURSO-INTEGRITY-FILTER-001) instead of a local
 * copy of its two regexes — this script used to hand-roll both (the exact
 * "every caller writes its own regex" gap that item exists to close).
 * `classifyIntegrityMessages` is called on the RAW message array, before any
 * other filtering, so `truncated` reflects the pragma's own 100-message cap
 * honestly.
 */
async function rawIntegrityCheck(adapter) {
  const res = await adapter.executeAll('PRAGMA integrity_check');
  const messages = res.rows
    .flatMap((r) => Object.values(r))
    .filter((v) => typeof v === 'string')
    .flatMap((v) => v.split('\n'))
    .map((v) => v.trim())
    .filter((v) => v.length > 0 && v !== 'ok' && !v.startsWith('*** in database'));
  const classified = classifyIntegrityMessages(messages);
  return {
    total_messages: messages.length,
    hit_cap: classified.truncated,
    leaked_page_messages: classified.pageAccounting.length,
    known_fts_false_positives: classified.knownFalsePositives.length,
    other_messages: classified.damage, // if non-empty, this is the interesting bucket
  };
}

async function rowCounts(adapter) {
  const n = await adapter.executeAll('SELECT count(*) AS c FROM node');
  const e = await adapter.executeAll('SELECT count(*) AS c FROM edge');
  const ep = await adapter.executeAll("SELECT count(*) AS c FROM node WHERE kind = 'episode' AND t_invalid IS NULL");
  let vectors = null;
  const vecTable = await adapter.executeGet("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'vec_%' LIMIT 1");
  if (vecTable && vecTable.name) {
    const v = await adapter.executeAll(`SELECT count(*) AS c FROM "${vecTable.name}"`);
    vectors = v.rows[0]?.c ?? null;
  }
  return { nodes: n.rows[0]?.c ?? null, edges: e.rows[0]?.c ?? null, episodes: ep.rows[0]?.c ?? null, vectors };
}

/** Full measurement bundle for a single open adapter: pragmas + payload + raw integrity + counts. */
async function measure(adapter) {
  const pageCount = await adapter.executeGet('PRAGMA page_count');
  const pageSize = await adapter.executeGet('PRAGMA page_size');
  const freelistCount = await adapter.executeGet('PRAGMA freelist_count');
  const payload = await payloadTotal(adapter);
  const integrity = await rawIntegrityCheck(adapter);
  const counts = await rowCounts(adapter);
  const page_count = Number(pageCount?.page_count ?? 0);
  const page_size = Number(pageSize?.page_size ?? 0);
  const freelist_count = Number(freelistCount?.freelist_count ?? 0);
  const file_bytes = page_count * page_size;
  return {
    page_count,
    page_size,
    freelist_count,
    file_bytes,
    file_mb: +(file_bytes / (1024 * 1024)).toFixed(1),
    payload_bytes: payload.total_bytes,
    payload_mb: +(payload.total_bytes / (1024 * 1024)).toFixed(1),
    overhead_mb: +((file_bytes - payload.total_bytes) / (1024 * 1024)).toFixed(1),
    overhead_pct: file_bytes > 0 ? +(((file_bytes - payload.total_bytes) / file_bytes) * 100).toFixed(1) : null,
    payload_per_table_mb: Object.fromEntries(
      Object.entries(payload.per_table_bytes).map(([k, v]) => [k, +(v / (1024 * 1024)).toFixed(2)]),
    ),
    payload_skipped_tables: payload.skipped,
    integrity_check: integrity,
    counts,
  };
}

const result = { rehearsal_dir: rehearsalDir, steps: {}, pass: false };

try {
  if (!existsSync(LIVE_DB)) {
    throw new Error(`live store not found at ${LIVE_DB} — nothing to rehearse against`);
  }
  mkdirSync(rehearsalDir, { recursive: true });

  // ── Step 0: BEFORE, measured directly on LIVE via a read-only connection ──
  console.error('[rehearse] step 0: BEFORE measurement — read-only against LIVE memory.db, zero mutation');
  const liveAdapter = await openDbReadOnly(LIVE_DB);
  let before;
  try {
    before = await measure(liveAdapter);
  } finally {
    await liveAdapter.close();
  }
  result.steps.before_live = before;

  // ── Step 1: single VACUUM INTO pass, live -> scratch copy ─────────────────
  console.error(`[rehearse] step 1: backupStore(${LIVE_DB} -> ${vacuumedPath}) [single VACUUM INTO pass]`);
  const b1 = await backupStore(LIVE_DB, vacuumedPath, { log: (...a) => console.error('  [backup]', ...a) });
  if (isBackupStoreError(b1)) throw new Error(`VACUUM INTO failed: ${b1.code} ${b1.message}`);
  result.steps.vacuum_into_result = { integrity_report: b1.integrityReport?.status ?? null };

  // ── Step 2: AFTER, measured on the vacuumed copy ───────────────────────────
  console.error('[rehearse] step 2: AFTER measurement — scratch copy, post single VACUUM INTO pass');
  const vacAdapter = await openDb(vacuumedPath);
  let after;
  try {
    after = await measure(vacAdapter);
  } finally {
    await vacAdapter.close();
  }
  result.steps.after_vacuum_pass1 = after;

  // ── Step 3: idempotency — second VACUUM INTO pass ──────────────────────────
  console.error(`[rehearse] step 3: backupStore(${vacuumedPath} -> ${vacuumed2Path}) [second pass, idempotency check]`);
  const b2 = await backupStore(vacuumedPath, vacuumed2Path, { log: (...a) => console.error('  [backup]', ...a) });
  if (isBackupStoreError(b2)) throw new Error(`second VACUUM INTO pass failed: ${b2.code} ${b2.message}`);
  const vac2Adapter = await openDb(vacuumed2Path);
  let after2;
  try {
    after2 = await measure(vac2Adapter);
  } finally {
    await vac2Adapter.close();
  }
  result.steps.after_vacuum_pass2 = after2;

  // ── Step 4: content-preservation check ─────────────────────────────────────
  const countsPreserved =
    before.counts.nodes === after.counts.nodes &&
    before.counts.edges === after.counts.edges &&
    before.counts.episodes === after.counts.episodes &&
    before.counts.vectors === after.counts.vectors &&
    after.counts.nodes === after2.counts.nodes &&
    after.counts.edges === after2.counts.edges;
  result.steps.counts_preserved_before_vs_after = countsPreserved;

  // ── Step 5: verdict ─────────────────────────────────────────────────────────
  const pageCountDelta = before.page_count - after.page_count;
  const pageCountDeltaPct = before.page_count > 0 ? +((pageCountDelta / before.page_count) * 100).toFixed(1) : null;
  const fileBytesReclaimedMb = +((before.file_bytes - after.file_bytes) / (1024 * 1024)).toFixed(1);
  const payloadStable = Math.abs(before.payload_bytes - after.payload_bytes) < before.payload_bytes * 0.02; // <2% drift = same content, different layout accounting

  // Any real (non-page-accounting, non-known-FP) integrity_check messages
  // that appear only once the cap clears, on either side.
  const newMessagesOnceCapCleared = !before.integrity_check.hit_cap
    ? [] // cap was never hit before; nothing was hidden
    : after.integrity_check.other_messages;

  result.verdict = {
    // The lead number, per instruction: page_count delta.
    page_count_before: before.page_count,
    page_count_after: after.page_count,
    page_count_delta: pageCountDelta,
    page_count_delta_pct: pageCountDeltaPct,
    file_mb_before: before.file_mb,
    file_mb_after: after.file_mb,
    file_mb_reclaimed: fileBytesReclaimedMb,
    payload_mb_before: before.payload_mb,
    payload_mb_after: after.payload_mb,
    payload_stable_across_vacuum: payloadStable,
    leaked_page_messages_before: before.integrity_check.leaked_page_messages,
    leaked_page_messages_after: after.integrity_check.leaked_page_messages,
    integrity_check_hit_cap_before: before.integrity_check.hit_cap,
    integrity_check_hit_cap_after: after.integrity_check.hit_cap,
    integrity_check_now_completes: before.integrity_check.hit_cap && !after.integrity_check.hit_cap,
    new_messages_revealed_once_cap_cleared: newMessagesOnceCapCleared,
    counts_preserved: countsPreserved,
    second_pass_page_count: after2.page_count,
    stable_on_second_pass: after.page_count === after2.page_count,
    // Verdict on the LEAK HYPOTHESIS — stated plainly, not hedged.
    leak_hypothesis:
      pageCountDeltaPct !== null && pageCountDeltaPct > 20
        ? 'CONFIRMED: VACUUM reclaimed a large fraction of page_count — the space was leaked (allocated, orphaned, never reused) and IS reclaimable by an offline VACUUM.'
        : pageCountDeltaPct !== null && pageCountDeltaPct > 2
          ? 'PARTIALLY CONFIRMED: VACUUM reclaimed a measurable but modest fraction of page_count — some leak, not the dominant driver of file size.'
          : 'NOT CONFIRMED: VACUUM barely changed page_count — the size is legitimately index/structural overhead, not a leak. The growth needs a different explanation.',
  };

  result.pass = countsPreserved && result.verdict.stable_on_second_pass;

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
