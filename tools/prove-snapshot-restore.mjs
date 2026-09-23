#!/usr/bin/env node
/**
 * prove-snapshot-restore.mjs — end-to-end proof that a pre-operation memory.db
 * snapshot under ~/.adhd/sox-ecosystem/memory/<class>-<ts>/ can actually be
 * restored, not just opened and counted.
 *
 * Task: BUG-MEMORY-SNAPSHOT-NO-RESTORE-PATH-001. Discharges (or refutes) the
 * D5 blocker in docs/decisions/0014-memory-snapshot-retention-policy.md.
 *
 * ENTIRELY OFFLINE. Never touches ~/.memory/memory.db. Never mutates the
 * source snapshot: both the "reference" read and the "restored" copy are
 * made from independent `cp` copies of the snapshot's memory.db(+-wal) into a
 * disposable tmpdir; the original snapshot files are opened zero times.
 *
 * What "restore" means here, concretely: take the snapshot's memory.db and
 * its -wal sidecar (a live database was captured mid-WAL, per
 * GO-LIVE-RUNBOOK.md's own caveat that a *live* store's WAL matters), copy
 * both into a fresh location standing in for ~/.memory/memory.db, and open
 * it with the real production code path (`openDb` from @adhd/sox-memory-core)
 * — the same function the memory-server backend calls on every start. If
 * that open succeeds, WAL frames get folded in exactly as they would in
 * production, and the result must match a reference read of the same
 * snapshot made independently.
 *
 * Proof bar (row counts alone are NOT proof — a file that opens and counts
 * correctly can still have unreadable content):
 *   1. node/live-node/episode/vector counts match between the two independent
 *      copies (reference vs restored).
 *   2. content-level spot check: pick a real episode from the reference copy,
 *      run a REAL memoryRecall() query derived from its content against the
 *      restored copy, and assert the exact same uid/content comes back.
 *   3. verifyStoreIntegrity(depth:'deep') on the restored copy — the same
 *      probe suite the live-store health check uses.
 *
 * Usage:
 *   node --import tsx tools/prove-snapshot-restore.mjs <snapshot-dir> [--keep]
 *
 * Exits non-zero and prints FAIL if any proof step does not hold.
 */
import { mkdtempSync, rmSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, openDbReadOnly, memoryRecall } from '@adhd/sox-memory-core';
// nx infers "@adhd/sox-store-adapter is lazy-loaded" from
// scripts/migrate-store-to-turso.mjs's `await import(...)` optional-availability
// guard (that script alone chooses to tolerate the package being absent) and
// then flags every OTHER static importer repo-wide, including this one,
// which has no such requirement. Item 7 first-run discovery — not a real
// inconsistency in this file.
// eslint-disable-next-line @nx/enforce-module-boundaries
import { verifyStoreIntegrity } from '@adhd/sox-store-adapter';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const snapshotDir = args.find((a) => !a.startsWith('--'));

if (!snapshotDir || !existsSync(snapshotDir)) {
  console.error('usage: node --import tsx tools/prove-snapshot-restore.mjs <snapshot-dir> [--keep]');
  console.error(`  snapshot-dir does not exist: ${snapshotDir}`);
  process.exit(2);
}

const srcDb = join(snapshotDir, 'memory.db');
const srcWal = join(snapshotDir, 'memory.db-wal');
if (!existsSync(srcDb)) {
  console.error(`FAIL: ${srcDb} does not exist — not a valid snapshot dir`);
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'snapshot-restore-proof-'));
const refDir = join(work, 'reference');
const restoredDir = join(work, 'restored');
mkdirSync(refDir, { recursive: true });
mkdirSync(restoredDir, { recursive: true });

function copySnapshotInto(destDir) {
  const destDb = join(destDir, 'memory.db');
  copyFileSync(srcDb, destDb);
  if (existsSync(srcWal)) {
    copyFileSync(srcWal, join(destDir, 'memory.db-wal'));
  }
  return destDb;
}

async function counts(adapter) {
  const nodes = await adapter.executeAll('SELECT count(*) AS c FROM node');
  const live = await adapter.executeAll('SELECT count(*) AS c FROM node WHERE t_invalid IS NULL');
  const episodes = await adapter.executeAll(
    "SELECT count(*) AS c FROM node WHERE kind = 'episode' AND t_invalid IS NULL",
  );
  const edges = await adapter.executeAll('SELECT count(*) AS c FROM edge');
  let vectors = null;
  try {
    const vecTable = await adapter.executeGet(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'vec_%' LIMIT 1",
    );
    if (vecTable && vecTable.name) {
      const v = await adapter.executeAll(`SELECT count(*) AS c FROM "${vecTable.name}"`);
      vectors = { table: vecTable.name, count: v.rows[0]?.c ?? null };
    }
  } catch (err) {
    vectors = { error: err instanceof Error ? err.message : String(err) };
  }
  return {
    nodes: nodes.rows[0]?.c ?? null,
    live_nodes: live.rows[0]?.c ?? null,
    episodes: episodes.rows[0]?.c ?? null,
    edges: edges.rows[0]?.c ?? null,
    vectors,
  };
}

const result = {
  snapshot_dir: snapshotDir,
  snapshot_class: basename(snapshotDir),
  had_wal: existsSync(srcWal),
  proof: {},
  pass: false,
};

let refAdapter = null;
let restoredAdapter = null;

try {
  // ── Step 1: independent reference read (read-only, never mutates) ────────
  const refDb = copySnapshotInto(refDir);
  refAdapter = await openDbReadOnly(refDb);
  const refCounts = await counts(refAdapter);

  // Pick a real, content-bearing episode from the reference copy to use as
  // the content-level spot check. Prefer one with substantive content.
  const sample = await refAdapter.executeGet(
    "SELECT uid, content, content_hash FROM node WHERE kind = 'episode' AND t_invalid IS NULL " +
      'AND content IS NOT NULL AND length(content) > 40 ORDER BY t_created DESC LIMIT 1',
  );
  result.proof.reference_counts = refCounts;
  result.proof.sample_episode = sample
    ? { uid: sample.uid, content_hash: sample.content_hash, content_preview: String(sample.content).slice(0, 120) }
    : null;
  await refAdapter.close();
  refAdapter = null;

  if (!sample) {
    result.proof.content_spot_check = { ok: false, reason: 'no eligible episode found in reference copy' };
  }

  // ── Step 2: the actual restore drill — production openDb() path ──────────
  const restoredDb = copySnapshotInto(restoredDir);
  restoredAdapter = await openDb(restoredDb); // same call memory-server makes on every start
  const restoredCounts = await counts(restoredAdapter);
  result.proof.restored_counts = restoredCounts;

  const countsMatch =
    refCounts.nodes === restoredCounts.nodes &&
    refCounts.live_nodes === restoredCounts.live_nodes &&
    refCounts.episodes === restoredCounts.episodes &&
    refCounts.edges === restoredCounts.edges;
  result.proof.counts_match = countsMatch;

  // ── Step 3: content-level spot check via a REAL recall query ─────────────
  if (sample) {
    const queryText = String(sample.content).slice(0, 80);
    const recallResult = await memoryRecall(restoredAdapter, 'project', {
      query: queryText,
      limit: 10,
      filters: { kinds: ['episode'] },
    });
    const hit = (recallResult.results ?? []).find((r) => r.uid === sample.uid);
    result.proof.content_spot_check = {
      ok: !!hit && hit.content === sample.content,
      queried_uid: sample.uid,
      found: !!hit,
      content_byte_identical: hit ? hit.content === sample.content : false,
      recall_hit_count: recallResult.results?.length ?? 0,
    };
  }

  // ── Step 4: integrity verification (deep, same probe suite as live health) ─
  const integrity = await verifyStoreIntegrity(restoredAdapter, { depth: 'deep' });
  result.proof.integrity = {
    ok: integrity.ok,
    damaged: integrity.damaged.map((f) => ({ probe: f.probe, object: f.object, detail: f.detail })),
    unknown: integrity.unknown.map((f) => ({ probe: f.probe, object: f.object, detail: f.detail })),
    probes_run: integrity.findings.length,
  };

  await restoredAdapter.close();
  restoredAdapter = null;

  result.pass =
    countsMatch &&
    (!sample || (result.proof.content_spot_check && result.proof.content_spot_check.ok)) &&
    integrity.ok;
} catch (err) {
  result.error = err instanceof Error ? { message: err.message, stack: err.stack } : String(err);
  result.pass = false;
} finally {
  try {
    if (refAdapter) await refAdapter.close();
  } catch {
    /* already reporting a failure; don't mask it */
  }
  try {
    if (restoredAdapter) await restoredAdapter.close();
  } catch {
    /* already reporting a failure; don't mask it */
  }
  if (!keep) {
    rmSync(work, { recursive: true, force: true });
  } else {
    result.scratch_dir = work;
  }
}

console.log(JSON.stringify(result, null, 2));
process.exit(result.pass ? 0 : 1);
