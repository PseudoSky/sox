#!/usr/bin/env node
/**
 * verify-bug-memory-010.mjs — empirical test of BUG-MEMORY-010's two
 * reasoned-but-unverified defects.
 *
 * DEFECT 1 (member_count drift): `meta.member_count` is written ONLY at
 * materialize time (cluster.ts:330). The incremental join (cluster.ts:608-611)
 * adds a MEMBER_OF edge without updating it. The live MCP handler reads
 * memberCount straight out of meta (memory-server/src/index.ts:1727-1732), so
 * any drift is user-visible under-reporting.
 *
 * DEFECT 2 (uid identity violation): community uid is the identity contract
 *   communityUid(sortedRowids, salt) =
 *     sha256(salt ? `${salt}:${ids.join(',')}` : ids.join(',')).hex.slice(0,32)
 * (cluster.ts:143-146). The incremental join adds a member without recomputing
 * it. Recompute the hash over each community's LIVE member rowids and compare
 * to the stored uid: a mismatch proves the invariant breaks in normal operation.
 *
 * READ-ONLY. Opens the copy read-only and refuses any path under ~/.memory.
 */
import crypto from 'node:crypto';
import { connect } from '@tursodatabase/database';

const DB = process.env.BENCH_DB ?? '/tmp/sub600c/bench.db';
if (DB.includes('/.memory/')) {
  console.error('REFUSING: must not touch the live store. Use a copy.');
  process.exit(2);
}

const db = await connect(DB);
const all = async (sql, args = []) => await (await db.prepare(sql)).all(args);

function communityUid(sortedRowids, salt = '') {
  const key = salt ? `${salt}:${sortedRowids.join(',')}` : sortedRowids.join(',');
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
}

// All live communities with their stored meta.
const communities = await all(
  `SELECT rowid, uid, level, meta FROM node
    WHERE kind = 'community' AND t_invalid IS NULL
    ORDER BY rowid`,
);

// All live MEMBER_OF edges (src = episode rowid, dst = community rowid).
const edges = await all(
  `SELECT src, dst FROM edge
    WHERE rel = 'MEMBER_OF' AND t_invalid IS NULL`,
);

const liveMembers = new Map(); // community_rowid -> [episode_rowid]
for (const e of edges) {
  const arr = liveMembers.get(e.dst) ?? [];
  arr.push(e.src);
  liveMembers.set(e.dst, arr);
}

let countMatch = 0, countDrift = 0, countMissingMeta = 0;
let uidMatch = 0, uidMismatch = 0, uidUnsalted = 0, uidSalted = 0;
const driftSamples = [];
const uidSamples = [];
let totalLiveMembers = 0;

for (const c of communities) {
  const members = (liveMembers.get(c.rowid) ?? []).slice().sort((a, b) => a - b);
  totalLiveMembers += members.length;

  let meta = null;
  try { meta = c.meta ? JSON.parse(c.meta) : null; } catch { meta = null; }

  // ── Defect 1: member_count vs live COUNT(*) ──────────────────────────────
  const stored = meta?.member_count;
  if (stored === undefined || stored === null) {
    countMissingMeta++;
  } else if (stored === members.length) {
    countMatch++;
  } else {
    countDrift++;
    if (driftSamples.length < 10) {
      driftSamples.push({
        uid: c.uid, stored_member_count: stored, live_member_count: members.length,
        delta: members.length - stored,
      });
    }
  }

  // ── Defect 2: recomputed uid vs stored uid ───────────────────────────────
  const scope = meta?.cluster_scope;
  const salt = scope && scope.kind === 'subset' && scope.hash ? String(scope.hash) : '';
  if (salt) uidSalted++; else uidUnsalted++;

  if (members.length > 0) {
    const recomputed = communityUid(members, salt);
    if (recomputed === c.uid) {
      uidMatch++;
    } else {
      uidMismatch++;
      if (uidSamples.length < 10) {
        uidSamples.push({
          stored_uid: c.uid, recomputed_uid: recomputed,
          live_member_count: members.length,
          stored_member_count: stored ?? null,
          scope_kind: scope?.kind ?? 'global(implicit)',
        });
      }
    }
  }
}

const communitiesWithNoLiveMembers = communities.filter(
  (c) => (liveMembers.get(c.rowid) ?? []).length === 0,
).length;

console.log(
  JSON.stringify(
    {
      verify: 'BUG-MEMORY-010',
      db: DB,
      live_communities: communities.length,
      live_member_of_edges: edges.length,
      total_live_members_attributed: totalLiveMembers,
      communities_with_zero_live_members: communitiesWithNoLiveMembers,
      defect_1_member_count: {
        match: countMatch,
        drift: countDrift,
        missing_meta_member_count: countMissingMeta,
        drift_rate: communities.length ? +(countDrift / communities.length).toFixed(4) : null,
        samples: driftSamples,
      },
      defect_2_uid_identity: {
        uid_matches_recomputed_hash: uidMatch,
        uid_mismatch: uidMismatch,
        mismatch_rate: uidMatch + uidMismatch ? +(uidMismatch / (uidMatch + uidMismatch)).toFixed(4) : null,
        salted_subset_communities: uidSalted,
        unsalted_global_communities: uidUnsalted,
        samples: uidSamples,
      },
    },
    null,
    2,
  ),
);
await db.close();
