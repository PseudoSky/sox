/**
 * bl-0c9c76b4-nodecap.spec.ts — backlog 0c9c76b4.
 *
 * Failure mode guarded: a requested FULL recluster over a corpus larger than
 * `nodeCap` silently ran the incremental join (which can never create a
 * community) and was reported as a completed pass; and a full pass that blew its
 * time budget kept going (up to 4 guard retries) instead of abandoning cleanly.
 *
 * Tier: S (in-process, real SqliteAdapter on a tmp file, real memoryWrite and
 * clusterStore; no services, no mocks). Only the clock is injected (AC5).
 * Gap statement (P/H/X): none — nothing here needs a tier above S; the budget
 * abort is observed through an injected clock because wall-clock overrun of a
 * 540 s budget cannot be produced in a unit test.
 *
 * Light risk map (criterion -> failure mode that breaks it):
 *   AC1 degraded full pass     -> reported as completed/full_pass, no reason, no counts
 *   AC2 sufficient cap         -> cap raised so far (or inverted) that the real pass never runs
 *   AC3 boundary N==cap/cap+1  -> off-by-one (< vs <=) either way
 *   AC4 single predicate       -> label and branch hand-synchronised again
 *   AC5 budget abort           -> pass continues past budget, or writes a half partition
 *   AC6 default cap            -> literal 10000 left behind / cap not derived from measurement
 *
 * Every test title carries '0c9c76b4 AC<n>' so the criterion is greppable.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from './db.js';
import { memoryWrite } from './write.js';
import { runBatchEnrich } from './enrich-batch.js';
import {
  clusterStore,
  resolveClusterPass,
  DEFAULT_CLUSTER_NODE_CAP,
  DEFAULT_FULL_PASS_BUDGET_MS,
  CLUSTER_NODE_CAP_MEASUREMENT,
} from './cluster.js';

let priorAdapterEnv: string | undefined;
beforeEach(() => {
  priorAdapterEnv = process.env['STORE_ADAPTER'];
  process.env['STORE_ADAPTER'] = 'sqlite';
});
afterEach(() => {
  if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
  else process.env['STORE_ADAPTER'] = priorAdapterEnv;
});

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-nodecap-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const TOTAL = 60;
const COHORT = 12;

/** Deterministic, mutually dissimilar filler: unique pseudo-words per episode. */
function distractor(i: number): string {
  let s = (i + 1) * 2654435761;
  const word = (): string => {
    let w = '';
    for (let k = 0; k < 8; k++) {
      s = (s * 1103515245 + 12345) >>> 0;
      w += String.fromCharCode(97 + (s % 26));
    }
    return w;
  };
  return `${word()} ${word()} ${word()} ${word()} ${word()} ${word()} ${word()}`;
}

/**
 * One tight cohort: near-identical text. With the hash embedder the cohort's
 * pairwise cosine is 30/31 (~0.97: 30 shared words, 1 differing) and
 * filler-vs-anything is ~0.00 (measured: the hash embedder is word-overlap
 * based), so an explicit tau of 0.8 separates them cleanly AND the cohort
 * survives the guard's retry at tau 0.95. Calibration is bypassed on purpose so
 * the tau under test is a stated constant, not a corpus-dependent derived one.
 */
const COHORT_BASE = Array.from({ length: 30 }, (_, i) => `shared${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + ((i * 7) % 26))}word`).join(' ');
function cohortText(n: number): string {
  return `${COHORT_BASE} variant${n}marker`;
}
const TAU = 0.8;

async function writeOne(adapter: StoreAdapter, content: string): Promise<void> {
  const r = await memoryWrite(adapter, { content, project_path: '/test/nodecap' });
  if ('code' in r) throw new Error(`memoryWrite failed: ${JSON.stringify(r)}`);
}

/** TOTAL episodes: one COHORT-sized near-duplicate cohort + dissimilar filler. */
async function seed(dir: string, cohort = COHORT, total = TOTAL): Promise<StoreAdapter> {
  const adapter = await openDb(path.join(dir, 't.db'));
  for (let i = 0; i < cohort; i++) await writeOne(adapter, cohortText(i));
  for (let i = 0; i < total - cohort; i++) await writeOne(adapter, distractor(i));
  return adapter;
}

interface Partition {
  communities: string[];
  memberEdges: number;
}
async function partition(adapter: StoreAdapter): Promise<Partition> {
  const c = await adapter.executeAll<{ uid: string }>(
    `SELECT uid FROM node WHERE kind = 'community' AND t_invalid IS NULL ORDER BY uid`,
  );
  const e = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM edge WHERE rel = 'MEMBER_OF' AND t_invalid IS NULL`,
  );
  return { communities: c.rows.map((r) => r.uid), memberEdges: e?.cnt ?? 0 };
}

describe('0c9c76b4 AC1 — a requested full pass over nodeCap is explicitly degraded', () => {
  it('0c9c76b4 AC1: episodes > nodeCap -> degraded {nodeCap, episodeCount, nodeCap}, full_pass false, no community', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const adapter = await seed(dir);
      const r = await clusterStore(adapter, { nodeCap: 50 });
      expect(r.degraded).toEqual({ reason: 'nodeCap', episodeCount: TOTAL, nodeCap: 50 });
      expect(r.full_pass).toBe(false);
      expect((await partition(adapter)).communities).toEqual([]);
      await adapter.close();
    } finally {
      cleanup();
    }
  });

  it('0c9c76b4 AC1: runBatchEnrich surfaces it as skipped with a reason naming nodeCap and the structured detail', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const adapter = await seed(dir);
      const r = await runBatchEnrich(adapter, { clusterNodeCap: 50, incrementalCluster: false });
      expect(r.cluster_pass_skipped).toBe(true);
      expect(r.cluster_skip_reason).toMatch(/^nodeCap:/);
      expect(r.cluster_degraded).toEqual({ reason: 'nodeCap', episodeCount: TOTAL, nodeCap: 50 });
      expect(r.communities_upserted).toBe(0);
      await adapter.close();
    } finally {
      cleanup();
    }
  });

  it('0c9c76b4 AC1: an incremental pass the caller ASKED for is not reported degraded', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const adapter = await seed(dir);
      const r = await clusterStore(adapter, { incrementalOnly: true, nodeCap: 50 });
      expect(r.degraded).toBeUndefined();
      expect(r.full_pass).toBe(false);
      await adapter.close();
    } finally {
      cleanup();
    }
  });
});

describe('0c9c76b4 AC2 — a sufficient cap runs the real full pass', () => {
  it('0c9c76b4 AC2: same fixture, cap 100 -> full_pass true, no degradation, communities created for the cohort', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const adapter = await seed(dir);
      const r = await clusterStore(adapter, { nodeCap: 100, threshold: TAU });
      expect(r.degraded).toBeUndefined();
      expect(r.full_pass).toBe(true);
      expect(r.clusters.length).toBeGreaterThanOrEqual(1);
      expect((await partition(adapter)).communities.length).toBeGreaterThanOrEqual(1);
      await adapter.close();
    } finally {
      cleanup();
    }
  });
});

describe('0c9c76b4 AC3 — boundary', () => {
  it('0c9c76b4 AC3: resolveClusterPass: N == cap is full, N == cap+1 degrades', () => {
    expect(resolveClusterPass(60, { nodeCap: 60 })).toEqual({ mode: 'full' });
    expect(resolveClusterPass(61, { nodeCap: 60 })).toEqual({
      mode: 'incremental',
      degraded: { reason: 'nodeCap', episodeCount: 61, nodeCap: 60 },
    });
  });

  it('0c9c76b4 AC3: through clusterStore, cap == N runs full; cap == N-1 degrades', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const adapter = await seed(dir);
      const atCap = await clusterStore(adapter, { nodeCap: TOTAL - 1 });
      expect(atCap.degraded?.reason).toBe('nodeCap');
      expect(atCap.full_pass).toBe(false);
      const full = await clusterStore(adapter, { nodeCap: TOTAL, threshold: TAU });
      expect(full.degraded).toBeUndefined();
      expect(full.full_pass).toBe(true);
      await adapter.close();
    } finally {
      cleanup();
    }
  });
});

describe('0c9c76b4 AC4 — one full-vs-incremental predicate', () => {
  it('0c9c76b4 AC4: incrementalOnly never degrades; absent cap uses the shared default', () => {
    expect(resolveClusterPass(1_000_000, { incrementalOnly: true })).toEqual({ mode: 'incremental' });
    expect(resolveClusterPass(DEFAULT_CLUSTER_NODE_CAP, {}).mode).toBe('full');
    expect(resolveClusterPass(DEFAULT_CLUSTER_NODE_CAP + 1, {}).degraded?.nodeCap).toBe(DEFAULT_CLUSTER_NODE_CAP);
  });

  it('0c9c76b4 AC4: the cap comparison exists exactly once in cluster.ts (label and branch cannot drift)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'cluster.ts'), 'utf8');
    const comparisons = src.match(/<=\s*nodeCap\b/g) ?? [];
    expect(comparisons).toHaveLength(1);
    expect(src).toMatch(/episodeCount\s*<=\s*nodeCap/); // ...and it is the one inside resolveClusterPass
  });
});

describe('0c9c76b4 AC5 — deadline abort leaves the partition intact', () => {
  /** Reads `readings` in order (the last one repeats); lets a test script elapsed time. */
  function scriptedClock(readings: number[]): () => number {
    let i = 0;
    return () => readings[Math.min(i++, readings.length - 1)]!;
  }

  it('0c9c76b4 AC5: budget already spent before the all-pairs run -> reason budget, nothing written', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const adapter = await seed(dir);
      const before = await partition(adapter);
      // reads: [start, pre-pass check] — the second reading is past the 1 s budget.
      const r = await clusterStore(adapter, { nodeCap: 100, budgetMs: 1_000, now: scriptedClock([0, 60_000]) });
      expect(r.degraded?.reason).toBe('budget');
      expect(r.degraded).toMatchObject({ budgetMs: 1_000, episodeCount: TOTAL });
      expect(r.full_pass).toBe(false);
      expect(r.clusters).toEqual([]);
      expect(await partition(adapter)).toEqual(before);
      await adapter.close();
    } finally {
      cleanup();
    }
  });

  it('0c9c76b4 AC5: a guard retry that cannot fit aborts and the PREVIOUS partition survives data that would change it', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const adapter = await seed(dir);
      const first = await clusterStore(adapter, { nodeCap: 200, threshold: TAU });
      expect(first.full_pass).toBe(true);
      expect(first.guard_retries).toBe(0);
      const previous = await partition(adapter);
      expect(previous.communities.length).toBeGreaterThanOrEqual(1);

      // 40 more cohort members: the cohort is now 52/100 > 0.5, so the D5.5 degenerate
      // guard WILL retry, and an un-aborted pass would mint a different community uid.
      for (let i = COHORT; i < COHORT + 40; i++) await writeOne(adapter, cohortText(i));

      // reads: start=0, check#0=0, passStart=0, passEnd=100 (lastPassMs=100),
      // check#1=950 -> 950 + 100 > 1000, the retry will not fit.
      const r = await clusterStore(adapter, {
        nodeCap: 200,
        threshold: TAU,
        budgetMs: 1_000,
        now: scriptedClock([0, 0, 0, 100, 950]),
      });
      expect(r.degraded?.reason).toBe('budget');
      expect(r.guard_retries).toBe(1);
      expect(r.full_pass).toBe(false);
      expect(await partition(adapter)).toEqual(previous);

      // Control: the same store with an ample budget DOES change the partition,
      // so the equality above is the abort's doing, not an inert fixture.
      const control = await clusterStore(adapter, { nodeCap: 200, threshold: TAU });
      expect(control.degraded).toBeUndefined();
      expect(await partition(adapter)).not.toEqual(previous);
      await adapter.close();
    } finally {
      cleanup();
    }
  });

  it('0c9c76b4 AC5: runBatchEnrich reports a budget abort as skipped with a budget: reason', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const adapter = await seed(dir);
      // A negative budget is spent before the first check on any clock.
      const r = await runBatchEnrich(adapter, { clusterNodeCap: 100, clusterBudgetMs: -1, incrementalCluster: false });
      expect(r.cluster_pass_skipped).toBe(true);
      expect(r.cluster_skip_reason).toMatch(/^budget:/);
      expect(r.cluster_degraded?.reason).toBe('budget');
      expect(r.communities_upserted).toBe(0);
      await adapter.close();
    } finally {
      cleanup();
    }
  });

  it('0c9c76b4 AC5: the default budget sits below the 600 s enrich-child SIGTERM', () => {
    expect(DEFAULT_FULL_PASS_BUDGET_MS).toBeLessThan(600_000);
  });
});

describe('0c9c76b4 AC6 — one derived default cap', () => {
  it('0c9c76b4 AC6: the default is raised above the old 10000 and derived from the recorded measurement', () => {
    const m = CLUSTER_NODE_CAP_MEASUREMENT;
    const perPair = m.measuredSeconds / (m.measuredN * m.measuredN);
    const worstCaseSeconds = m.worstCasePasses * perPair * DEFAULT_CLUSTER_NODE_CAP ** 2;
    expect(DEFAULT_CLUSTER_NODE_CAP).toBeGreaterThan(10_000);
    expect(worstCaseSeconds).toBeLessThanOrEqual(m.budgetFraction * m.budgetSeconds);
    // and it is not wastefully conservative: the next 1000 episodes would break the rule
    const next = m.worstCasePasses * perPair * (DEFAULT_CLUSTER_NODE_CAP + 1000) ** 2;
    expect(next).toBeGreaterThan(m.budgetFraction * m.budgetSeconds);
  });

  it('0c9c76b4 AC6: no literal 10000 cap is left in cluster.ts or enrich-batch.ts', () => {
    for (const f of ['cluster.ts', 'enrich-batch.ts']) {
      const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
      expect(src, f).not.toMatch(/(?:\?\?|=)\s*10_?000\b/);
    }
  });
});
