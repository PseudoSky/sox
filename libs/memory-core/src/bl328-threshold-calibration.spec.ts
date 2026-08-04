/**
 * bl328-threshold-calibration.spec.ts — BL-328 / PKT-30.
 *
 * **What is under test:** target-mean-degree threshold calibration
 * (`calibrateThreshold` in `cluster.ts`), replacing the fixed global cosine τ
 * that PKT-28 proved is not viable at any value.
 *
 * PKT-28 measured, directly on the true full corpus (N=4867, no projection),
 * that a constant τ fixes the per-pair EDGE PROBABILITY, so under
 * single-linkage-equivalent DBSCAN (`minClusterSize = 2`) mean node degree
 * grows LINEARLY with corpus size and the graph percolates into one giant
 * component. Largest-cluster ratio at τ=0.82 on the same store, as it grew:
 * 0.085 (N=200) → 0.222 → 0.459 → 0.684 (N=1616) → 0.759 (N=4867). τ=0.85
 * crossed the degenerate bound between two measurement dates on the same
 * corpus. The replacement holds the DEGREE fixed instead of the threshold.
 *
 * **The three things this file locks, each of which has its own failure mode:**
 *
 * 1. §1 — the sweep. Across N = 200…1616 on a corpus that PROVABLY percolates
 *    at the fixed floor (the control arm asserts largest-cluster ratio > 0.5
 *    there, so a green result cannot be an artifact of an easy corpus),
 *    calibration keeps largest-cluster ratio at/below the 0.5 degenerate bound
 *    — measured BEFORE the D5.5 retry guard, which is explicitly not allowed
 *    to be the mechanism (BL-328 §5.4). And τ must MOVE as N grows: a
 *    calibration that returns a constant is the defect, not the fix.
 *
 * 2. §2 — the pairwise/centroid trap. τ governs a PAIRWISE metric (DBSCAN's
 *    cosine distance; `incrementalJoin`'s max-similarity-to-any-member).
 *    Estimating the edge probability from a to-CENTROID statistic samples a
 *    systematically higher-valued distribution and hands back a τ that is too
 *    LOOSE where it is actually applied. Measured on the live store's own 266
 *    real multi-member communities: mean pairwise 0.8701 vs mean to-centroid
 *    0.9475 — offset +0.0774 (p10 +0.0553, p90 +0.0975, max +0.1223, and zero
 *    communities with a negative offset), consistent with the +0.086..+0.127
 *    recorded on the three curated BL-328 cohorts in PLAN.md §P0.5. A τ
 *    mis-derived by that much lands near 0.81 — which PKT-28 measured as
 *    degenerate (ratio 0.759 at 0.82). This section proves the shipped
 *    function is on the pairwise side of that gap.
 *
 * 3. §3 — reachability. BL-420's defect was a correct default that production
 *    never reached, because the caller always passed an explicit threshold.
 *    Calibration is one layer further down and can die exactly the same way,
 *    so this arm drives a bare `runBatchEnrich()` — the call every real
 *    periodic tick makes, with no threshold override — over a corpus that
 *    percolates at the floor, and asserts the persisted partition is
 *    non-degenerate.
 *
 * **Corpus.** Synthetic but structurally faithful: a shared base component
 * (real prose has a HIGH similarity floor — measured inter-topic mean 0.6384,
 * not the 0.4742 of the hand-written fixture), one dominant topic holding 70%
 * of the corpus (this store's real content is dominated by chunked research
 * output), and a long tail of minor topics. Deterministic — a seeded
 * `mulberry32`, no `Math.random()`, so the sweep numbers below are exactly
 * reproducible.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import { cluster as analysisCluster } from '@adhd/sox-analysis';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import {
  calibrateThreshold,
  CLUSTER_THRESHOLD_CEILING,
  CLUSTER_THRESHOLD_FLOOR,
  runBatchEnrich,
  wrapRawDbAsAdapter,
} from './index.js';

const DIM = 128;

// ── Deterministic corpus generator ────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / n;
  return v;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

/**
 * Corpus with a realistic similarity FLOOR and a dominant topic.
 *
 * `beta2` is the shared-base energy (the "everything in a real store is
 * somewhat similar to everything else" effect — measured inter-topic mean
 * 0.6384 on this store vs 0.4742 for the synthetic fixture). `headShare` of
 * the documents draw topic 0; the rest spread over `K-1` minor topics. Each
 * document's topic loading `a` is drawn over [aLo, aHi], so raising τ
 * FRAGMENTS a topic gradually rather than deleting it all at once — the
 * behaviour a real similarity distribution has and a knife-edge fixture
 * does not.
 */
function makeCorpus(
  n: number,
  { seed = 7, K = 30, beta2 = 0.2, aLo = 0.8, aHi = 0.99, headShare = 0.7 } = {},
): Float32Array[] {
  const rnd = mulberry32(seed);
  const mk = (): Float32Array =>
    normalize(Float32Array.from({ length: DIM }, () => rnd() - 0.5));
  const base = mk();
  const topics = Array.from({ length: K }, mk);
  const beta = Math.sqrt(beta2);
  const rest = Math.sqrt(1 - beta2);
  const out: Float32Array[] = [];
  for (let i = 0; i < n; i++) {
    const k = rnd() < headShare ? 0 : 1 + Math.floor(rnd() * (K - 1));
    const a = Math.sqrt(aLo * aLo + rnd() * (aHi * aHi - aLo * aLo));
    const b = Math.sqrt(Math.max(0, 1 - a * a));
    const noise = mk();
    const mix = new Float32Array(DIM);
    for (let d = 0; d < DIM; d++) mix[d] = a * topics[k]![d]! + b * noise[d]!;
    normalize(mix);
    const v = new Float32Array(DIM);
    for (let d = 0; d < DIM; d++) v[d] = beta * base[d]! + rest * mix[d]!;
    out.push(normalize(v));
  }
  return out;
}

/** Partition shape at a given τ — the same statistics the calibration report uses. */
function partitionAt(vecs: Float32Array[], threshold: number) {
  const res = analysisCluster(
    vecs.map((vec, id) => ({ id, vec })),
    { threshold, minClusterSize: 2 },
  );
  const sizes = res.communities.map((c) => c.memberIds.length).sort((x, y) => y - x);
  const clustered = sizes.reduce((x, y) => x + y, 0);
  return {
    cluster_count: res.communities.length,
    largest: sizes[0] ?? 0,
    largest_ratio: (sizes[0] ?? 0) / vecs.length,
    clustered_frac: clustered / vecs.length,
  };
}

// ── §1 The sweep ──────────────────────────────────────────────────────────────

describe('BL-328 — target-mean-degree calibration keeps the partition non-degenerate as N grows', () => {
  const SWEEP_N = [200, 400, 800, 1200, 1616];

  it('across N=200…1616, the calibrated τ holds largest-cluster ratio <= 0.5 on a corpus where the FIXED floor percolates', () => {
    const rows: Array<{
      n: number;
      tau: number;
      degree: number;
      calibrated_ratio: number;
      fixed_ratio: number;
    }> = [];

    for (const n of SWEEP_N) {
      const vecs = makeCorpus(n);

      // CONTROL ARM. If this corpus were not actually percolating at the
      // fixed floor, the calibrated arm below would pass for free and prove
      // nothing — this is the assertion BL-328's own acceptance calls out as
      // the one whose absence let τ=0.65 look correct.
      const fixed = partitionAt(vecs, CLUSTER_THRESHOLD_FLOOR);
      expect(
        fixed.largest_ratio,
        `control: fixed τ=${CLUSTER_THRESHOLD_FLOOR} must be DEGENERATE at N=${n} for this test to mean anything`,
      ).toBeGreaterThan(0.5);

      // THE FIX. Calibration sees only a bounded sample, never the whole corpus.
      const cal = calibrateThreshold(vecs, vecs.length);
      const calibrated = partitionAt(vecs, cal.threshold);

      // Measured BEFORE the D5.5 retry guard — the guard is a backstop, and
      // BL-328 §5.4 is explicit that it must not be the mechanism.
      expect(
        calibrated.largest_ratio,
        `calibrated τ=${cal.threshold} at N=${n} must be non-degenerate (pre-guard)`,
      ).toBeLessThanOrEqual(0.5);

      // Calibration must MEET the degree budget, not surrender to the ceiling,
      // and must still cluster something — "cluster nothing" is a trivial way
      // to be non-degenerate and is not a fix.
      expect(cal.reason, `N=${n} calibration reason`).not.toBe('ceiling');
      expect(cal.threshold).toBeLessThan(CLUSTER_THRESHOLD_CEILING);
      expect(calibrated.cluster_count, `N=${n} must still produce communities`).toBeGreaterThan(0);
      expect(calibrated.clustered_frac).toBeGreaterThan(0);

      // τ may never be looser than the value PKT-28 proved safe.
      expect(cal.threshold).toBeGreaterThanOrEqual(CLUSTER_THRESHOLD_FLOOR);
      expect(cal.projected_mean_degree).toBeLessThanOrEqual(cal.target_mean_degree);

      rows.push({
        n,
        tau: cal.threshold,
        degree: cal.projected_mean_degree,
        calibrated_ratio: calibrated.largest_ratio,
        fixed_ratio: fixed.largest_ratio,
      });
    }

    // Reported so a future regression shows its working, the way the
    // clustering-e2e probe rows do.
    console.log('[BL-328 sweep] ' + JSON.stringify(rows));
  });

  it('τ MOVES as the corpus grows — a calibration that returns a constant is the defect, not the fix', () => {
    const taus = SWEEP_N.map((n) => calibrateThreshold(makeCorpus(n), n).threshold);

    // Monotone non-decreasing: more corpus can only ever justify a tighter τ.
    for (let i = 1; i < taus.length; i++) {
      expect(taus[i]!, `τ must not loosen as N grows (${SWEEP_N[i - 1]}→${SWEEP_N[i]})`).toBeGreaterThanOrEqual(
        taus[i - 1]!,
      );
    }
    // And it must actually move somewhere in the range — this is the assertion
    // that fails against the old nullary constant.
    expect(taus[taus.length - 1]!, `τ across N=${SWEEP_N.join(',')}: ${taus.join(',')}`).toBeGreaterThan(taus[0]!);
  });

  it('degree budget is what moves τ: the SAME distribution at a larger N yields a tighter τ', () => {
    // Same vectors, only the projected corpus size differs — isolates N as the
    // driver, with the similarity distribution held exactly constant.
    const vecs = makeCorpus(800);
    const small = calibrateThreshold(vecs, 200);
    const large = calibrateThreshold(vecs, 20000);
    expect(large.threshold).toBeGreaterThan(small.threshold);
    expect(small.edge_probability).toBeGreaterThanOrEqual(large.edge_probability);
  });

  it('falls back to the floor rather than inventing a threshold from too little signal', () => {
    const cal = calibrateThreshold([makeCorpus(2)[0]!, makeCorpus(2)[1]!], 2);
    expect(cal.reason).toBe('sample-too-small');
    expect(cal.threshold).toBe(CLUSTER_THRESHOLD_FLOOR);
  });
});

// ── §2 The pairwise/centroid trap ─────────────────────────────────────────────

describe('BL-328 — calibration estimates the edge probability on the PAIRWISE metric τ is applied to', () => {
  it('a to-centroid statistic is systematically higher, and would hand back a LOOSER τ', () => {
    const vecs = makeCorpus(400);
    const communities = analysisCluster(
      vecs.map((vec, id) => ({ id, vec })),
      { threshold: CLUSTER_THRESHOLD_FLOOR, minClusterSize: 2 },
    ).communities.filter((c) => c.memberIds.length >= 3);
    expect(communities.length, 'need multi-member communities to measure the offset').toBeGreaterThan(0);

    // Per-community: mean pairwise vs mean to-centroid. This reproduces, on
    // synthetic geometry, the +0.0774 mean offset measured on the live store's
    // own 266 real communities (p10 +0.0553, p90 +0.0975, zero negatives).
    const offsets: number[] = [];
    for (const c of communities) {
      const members = c.memberIds.map((i) => vecs[i]!);
      let sum = 0;
      let pairs = 0;
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          sum += cosine(members[i]!, members[j]!);
          pairs++;
        }
      }
      const meanPairwise = sum / pairs;
      const centroid = new Float32Array(DIM);
      for (const m of members) for (let d = 0; d < DIM; d++) centroid[d] = centroid[d]! + m[d]! / members.length;
      let cs = 0;
      for (const m of members) cs += cosine(m, centroid);
      offsets.push(cs / members.length - meanPairwise);
    }
    // Directional, not a magic number: to-centroid is higher, every time.
    expect(Math.min(...offsets), `offsets: ${offsets.map((o) => o.toFixed(4)).join(',')}`).toBeGreaterThan(0);

    console.log(
      `[BL-328 offset] communities=${offsets.length} mean=+${(offsets.reduce((x, y) => x + y, 0) / offsets.length).toFixed(4)} min=+${Math.min(...offsets).toFixed(4)} max=+${Math.max(...offsets).toFixed(4)}`,
    );
  });

  it('a candidate INSIDE τ of a community centroid but outside τ of every member is NOT admitted', () => {
    // The trap made executable. Members sit on a ring at 35° from the axis ĉ,
    // spaced 45° in azimuth: adjacent members are cos²35 + sin²35·cos45 =
    // 0.904 apart, so they chain into ONE community under single-linkage —
    // while every member is only 0.819 from ĉ itself. A candidate placed
    // exactly at ĉ is therefore similarity 1.0 to the community's CENTROID
    // and below τ to every one of its MEMBERS. A centroid-metric join admits
    // it; the pairwise/single-link metric τ is calibrated for must not. This
    // is the +0.0774 offset measured on the live store, turned into a
    // pass/fail rather than a caveat.
    const axis = normalize(Float32Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0)));
    const alpha = (35 * Math.PI) / 180;
    const members: Float32Array[] = [];
    for (let m = 0; m < 8; m++) {
      const az = (m * 45 * Math.PI) / 180;
      const v = new Float32Array(DIM);
      // Two orthogonal directions spanning the ring plane, both ⟂ axis.
      v[0] = Math.cos(alpha);
      v[1] = Math.sin(alpha) * Math.cos(az);
      v[2] = Math.sin(alpha) * Math.sin(az);
      members.push(normalize(v));
    }
    const candidate = axis;

    const centroid = new Float32Array(DIM);
    for (const m of members) for (let d = 0; d < DIM; d++) centroid[d] = centroid[d]! + m[d]! / members.length;
    const toCentroid = cosine(candidate, centroid);
    const maxToMember = Math.max(...members.map((m) => cosine(candidate, m)));

    // The premise, asserted rather than assumed.
    expect(toCentroid, 'candidate must be INSIDE τ of the centroid').toBeGreaterThan(CLUSTER_THRESHOLD_FLOOR);
    expect(maxToMember, 'candidate must be OUTSIDE τ of every member').toBeLessThan(CLUSTER_THRESHOLD_FLOOR);
    expect(toCentroid - maxToMember).toBeGreaterThan(0.086); // ≥ the smallest offset PLAN.md §P0.5 records

    const all = [...members, candidate];
    const res = analysisCluster(
      all.map((vec, id) => ({ id, vec })),
      { threshold: CLUSTER_THRESHOLD_FLOOR, minClusterSize: 2 },
    );
    const candidateId = all.length - 1;
    const joined = res.communities.find((c) => c.memberIds.includes(candidateId));
    expect(joined, 'candidate must stay unclustered — the applied metric is pairwise, not centroid').toBeUndefined();
    // ...while the ring itself does form a community, so this is not simply
    // "nothing clustered".
    expect(res.communities.some((c) => c.memberIds.length >= 4)).toBe(true);
  });

  it('reports its metric as pairwise so a future edit that swaps in centroids is visible', () => {
    const cal = calibrateThreshold(makeCorpus(200), 200);
    expect(cal.metric).toBe('pairwise');
    expect(cal.pair_count).toBe((cal.sample_size * (cal.sample_size - 1)) / 2);
  });

  it('the bounded sample is a sound estimator of the full-corpus edge probability', () => {
    // The one approximation the implementation makes: P(edge) comes from a
    // ≤400-vector subsample, not all N². If that estimate were biased, every
    // τ above would be wrong for a reason no other assertion here would catch.
    const vecs = makeCorpus(1616);
    const cal = calibrateThreshold(vecs, vecs.length);
    expect(cal.sample_size).toBeLessThanOrEqual(400);

    let above = 0;
    let total = 0;
    for (let i = 0; i < vecs.length; i++) {
      for (let j = i + 1; j < vecs.length; j++) {
        if (cosine(vecs[i]!, vecs[j]!) >= cal.threshold) above++;
        total++;
      }
    }
    const truthP = above / total;
    console.log(
      `[BL-328 sample fidelity] τ=${cal.threshold} sampled_P=${cal.edge_probability.toExponential(3)} true_P=${truthP.toExponential(3)} sample=${cal.sample_size}/${vecs.length}`,
    );
    // Both must agree that the degree budget is met at this τ — that is the
    // decision the estimate actually drives.
    expect(truthP * (vecs.length - 1)).toBeLessThanOrEqual(cal.target_mean_degree * 1.5);
  });
});

// ── §3 Production reachability ────────────────────────────────────────────────

const MINIMAL_DDL = `
CREATE TABLE IF NOT EXISTS node (
  rowid INTEGER PRIMARY KEY,
  uid TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL,
  content TEXT, name TEXT, summary TEXT,
  meta TEXT, agent_id TEXT, session_id TEXT, source TEXT,
  importance REAL DEFAULT 1.0, content_hash TEXT, level INTEGER,
  resume_state TEXT, confidence REAL,
  namespace TEXT DEFAULT 'global',
  t_created TEXT NOT NULL, t_occurred TEXT, t_expires TEXT,
  t_valid TEXT, t_invalid TEXT, last_access TEXT,
  access_count INTEGER DEFAULT 0,
  tags TEXT, topic TEXT, project_path TEXT, enrich_ver TEXT,
  is_superseded INTEGER DEFAULT 0,
  t_updated TEXT
);

CREATE TABLE IF NOT EXISTS edge (
  rowid INTEGER PRIMARY KEY,
  src INTEGER NOT NULL REFERENCES node(rowid),
  dst INTEGER NOT NULL REFERENCES node(rowid),
  rel TEXT NOT NULL,
  weight REAL DEFAULT 1.0, origin TEXT, confidence REAL,
  t_created TEXT NOT NULL, t_expired TEXT, t_valid TEXT, t_invalid TEXT, meta TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_edge_unique ON edge(src, dst, rel);

CREATE VIRTUAL TABLE IF NOT EXISTS vec_node USING vec0(node_id INTEGER PRIMARY KEY, embedding FLOAT[${DIM}]);
`;

function makeTmpDb(): { db: Database.Database; adapter: StoreAdapter; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl328-'));
  const db = new Database(path.join(dir, 'test.db'));
  sqliteVec.load(db);
  db.exec(MINIMAL_DDL);
  return {
    db,
    adapter: wrapRawDbAsAdapter(db),
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('BL-328 — calibration is REACHED by the production path (BL-420 defect shape, one layer down)', () => {
  it('a bare runBatchEnrich() over a corpus that percolates at the fixed floor yields a non-degenerate partition', async () => {
    const N = 200;
    const vecs = makeCorpus(N);
    // Control, computed in-test: at the fixed floor this corpus IS degenerate.
    expect(partitionAt(vecs, CLUSTER_THRESHOLD_FLOOR).largest_ratio).toBeGreaterThan(0.5);

    const { db, adapter, cleanup } = makeTmpDb();
    try {
      const now = new Date().toISOString();
      const insNode = db.prepare<unknown[], { rowid: number }>(
        `INSERT INTO node (uid, kind, content, t_created, t_valid) VALUES (?, 'episode', ?, ?, ?) RETURNING rowid`,
      );
      const insVec = db.prepare('INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)');
      vecs.forEach((v, i) => {
        const { rowid } = insNode.get(`bl328-ep${i}`, `episode ${i} ` + 'x'.repeat(60), now, now)!;
        insVec.run(rowid, '[' + Array.from(v).map((x) => x.toFixed(8)).join(',') + ']');
      });

      // No clusterThreshold override — exactly what memory-server's periodic
      // tick does. If calibration is unreachable from here (BL-420's defect
      // shape) this pass runs at the fixed floor and produces the blob.
      const result = await runBatchEnrich(adapter, {});
      expect(result.communities_upserted).toBeGreaterThan(0);

      // CALIBRATION, NOT THE GUARD, must be what produced this partition.
      // Asserting only the outcome is not enough: the D5.5 retry guard also
      // escalates τ by +0.05 and would rescue this corpus on its own, which
      // is exactly the "guard is doing the undocumented real calibration"
      // state BL-328 §5.4 says must end. So assert the mechanism directly —
      // a calibration record reached this pass, it moved τ off the floor by
      // hitting the degree budget, and the guard never had to fire.
      expect(result.cluster_calibration, 'calibration must be REACHED from a bare runBatchEnrich()').toBeDefined();
      expect(result.cluster_calibration!.reason).toBe('target-degree');
      expect(result.cluster_calibration!.metric).toBe('pairwise');
      expect(result.cluster_calibration!.threshold).toBeGreaterThan(CLUSTER_THRESHOLD_FLOOR);
      expect(result.cluster_guard_retries, 'D5.5 guard must be a backstop, not the mechanism').toBe(0);
      expect(result.cluster_effective_threshold).toBe(result.cluster_calibration!.threshold);

      // Largest PERSISTED community, straight off the MEMBER_OF edges — the
      // same place `clusterStats` computes coverage from, not stored meta.
      const largest = db
        .prepare<unknown[], { n: number }>(
          `SELECT COUNT(*) AS n FROM edge WHERE rel = 'MEMBER_OF' AND t_invalid IS NULL
           GROUP BY dst ORDER BY n DESC LIMIT 1`,
        )
        .get()!;
      expect(largest.n / N, `largest persisted community ratio (N=${N})`).toBeLessThanOrEqual(0.5);
    } finally {
      cleanup();
    }
  }, 60_000);
});
