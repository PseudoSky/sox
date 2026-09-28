/**
 * dc-knowledge.spec.ts — D-C end-to-end, through the REAL memory-core ops on a
 * real store (openDb schema, real connections). Every capability has a
 * negative control that goes RED under its deliberately-wrong variant.
 *
 *   DC_NEGATIVE_FACET=1  → allow in-place facet redefine (AC3 must go RED)
 *   DC_NEGATIVE_CLAIM=1  → unguarded claim read-modify-write (K-I7 race → RED)
 *   DC_NEGATIVE_SR8=1    → disable SR-8 verify-after-write (a drop returns ok → RED)
 *
 * The coverage (AC6) and SR-3 count negative controls are the SPECIFICITY of the
 * asserted numbers: a client-side-join / always-answer implementation returns a
 * different (larger) value than asserted, turning the assertion RED.
 *
 * Concurrency uses two REAL independent connections + a latch barrier (never a
 * sleep), matching the SR-7 proof standard.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from './db.js';
import { memoryClaimAssert, readClaimView, memoryClaimUpsert } from './claim.js';
import { memoryOutcomeAppend, readOutcomes } from './outcome.js';
import { memoryBack } from './back.js';
import { memoryFacetAdmit, memoryFacetPromote, memoryFacetList, facetTermId, FacetError, type FacetTerm } from './facets.js';
import { memoryUpdate } from './update.js';
import {
  memoryWriteBatch,
  _setBatchDropFieldForTest,
  _setBatchVerifyDisabledForTest,
} from './write.js';
import { memoryRecall } from './recall.js';
import { _setEmbedProviderForTest, _shutdownEmbedWorker } from './embed.js';
import { DeterministicTestProvider } from './embed-test-provider.js';
import { _setKnowledgeConfigForTest, DEFAULT_KNOWLEDGE_CONFIG, type KnowledgeConfig } from './config.js';
import { getMemoryGraphBackend } from './graph-backend.js';

let dir: string;
let dbPath: string;
let db: StoreAdapter;
let priorAdapterEnv: string | undefined;

beforeEach(async () => {
  priorAdapterEnv = process.env['STORE_ADAPTER'];
  process.env['STORE_ADAPTER'] = 'sqlite';
  _setEmbedProviderForTest(new DeterministicTestProvider());
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-knowledge-'));
  dbPath = path.join(dir, 'store.db');
  db = await openDb(dbPath);
});

afterEach(async () => {
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  _setKnowledgeConfigForTest(null);
  _setBatchDropFieldForTest(null);
  _setBatchVerifyDisabledForTest(false);
  if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
  else process.env['STORE_ADAPTER'] = priorAdapterEnv;
});

afterAll(async () => {
  await _shutdownEmbedWorker();
});

async function assertClaim(over: Partial<Parameters<typeof memoryClaimAssert>[1]> = {}): Promise<string> {
  const r = await memoryClaimAssert(db, {
    text: 'the sky is blue',
    facet: 'observation:colour',
    project_path: '/p',
    expectation: { expected_outcome: 'blue', confidence: 'low' },
    asserted_by: 'alice',
    ...over,
  });
  if (!r.ok) throw new Error(`claim assert failed: ${r.message}`);
  return r.uid;
}

async function seedEpisode(content: string, result: string): Promise<void> {
  await getMemoryGraphBackend(db).writeNode(
    content,
    {
      kind: 'episode',
      projectPath: '/p',
      source: 'observation',
      metadata: { case: { outcome: { result } } },
    },
    { skipDedupe: true },
  );
}

// ── AC4/AC5 — outcome-gated record + tiered verdict ───────────────────────────

describe('D-C — outcome-gated record (AC4) and tiered verdict (AC5)', () => {
  it('a claim is immutable; outcomes append as SEPARATE nodes; the claim bytes are unchanged', async () => {
    const uid = await assertClaim();
    const before = await db.executeGet<{ content: string }>(`SELECT content FROM node WHERE uid = ?`, [uid]);

    const r1 = await memoryOutcomeAppend(db, {
      claim_uid: uid, observed_result: 'blue', observed_by: 'alice', method: 'eyeball', independence: 'self',
    });
    expect(r1.ok).toBe(true);
    const r2 = await memoryOutcomeAppend(db, {
      claim_uid: uid, observed_result: 'blue', observed_by: 'bob', method: 'spectrometer', independence: 'independent',
    });
    expect(r2.ok).toBe(true);

    const outcomes = await readOutcomes(db, uid);
    expect(outcomes).toHaveLength(2);
    expect(new Set(outcomes.map((o) => o.uid)).size).toBe(2);
    const after = await db.executeGet<{ content: string }>(`SELECT content FROM node WHERE uid = ?`, [uid]);
    expect(after!.content).toBe(before!.content);

    // AC5: 1 self + 1 independent agreeing → independently-reproduced.
    const back = await memoryBack(db, uid);
    expect(back.ok).toBe(true);
    if (!back.ok) throw new Error('unreachable');
    expect(back.verdict.tier).toBe('independently-reproduced');
    expect(back.outcomes).toHaveLength(2);
    expect(back.citations.some((c) => c.uid === uid && c.context === 'claim')).toBe(true);
  });

  it('self-only ⇒ self-reproduced; two agreeing independent ⇒ replicated; differing independence ⇒ different tiers', async () => {
    const onlySelf = await assertClaim({ text: 'water boils at 100C' });
    await memoryOutcomeAppend(db, { claim_uid: onlySelf, observed_result: 'boils', observed_by: 'a', method: 'kettle', independence: 'self' });
    const selfBack = await memoryBack(db, onlySelf);
    if (!selfBack.ok) throw new Error('unreachable');
    expect(selfBack.verdict.tier).toBe('self-reproduced');

    const rep = await assertClaim({ text: 'the tide rises twice daily' });
    await memoryOutcomeAppend(db, { claim_uid: rep, observed_result: 'rises', observed_by: 'a', method: 'gauge', independence: 'independent' });
    await memoryOutcomeAppend(db, { claim_uid: rep, observed_result: 'rises', observed_by: 'b', method: 'satellite', independence: 'independent' });
    const repBack = await memoryBack(db, rep);
    if (!repBack.ok) throw new Error('unreachable');
    expect(repBack.verdict.tier).toBe('replicated');

    // The two records differ ONLY in independence; their tiers MUST differ
    // (the collapse-to-boolean negative control is proven in knowledge.spec.ts).
    const indep = await assertClaim({ text: 'mercury is hot' });
    await memoryOutcomeAppend(db, { claim_uid: indep, observed_result: 'hot', observed_by: 'a', method: 'probe', independence: 'independent' });
    const indepBack = await memoryBack(db, indep);
    if (!indepBack.ok) throw new Error('unreachable');
    expect(indepBack.verdict.tier).toBe('independently-reproduced');
    expect(indepBack.verdict.tier).not.toBe(selfBack.verdict.tier);
  });

  it('a live REFUTES edge ⇒ refuted, and the refuted claim still exists', async () => {
    const uid = await assertClaim();
    const refuter = await getMemoryGraphBackend(db).writeNode('counter-evidence', {
      kind: 'episode', projectPath: '/p', source: 'observation',
    });
    const claimRec = await getMemoryGraphBackend(db).getNodeByUid(uid);
    await getMemoryGraphBackend(db).writeEdge(refuter, claimRec!.id, 'REFUTES');

    const back = await memoryBack(db, uid);
    if (!back.ok) throw new Error('unreachable');
    expect(back.verdict.tier).toBe('refuted');
    expect(back.citations.some((c) => c.context === 'refutes')).toBe(true);
    // The refuted node still exists.
    const still = await db.executeGet<{ uid: string }>(`SELECT uid FROM node WHERE uid = ? AND t_invalid IS NULL`, [uid]);
    expect(still).toBeTruthy();
  });

  it('idempotent re-record via client_request_id does not append a second outcome', async () => {
    const uid = await assertClaim();
    await memoryOutcomeAppend(db, { claim_uid: uid, observed_result: 'blue', observed_by: 'a', method: 'm', independence: 'self', client_request_id: 'req-1' });
    const replay = await memoryOutcomeAppend(db, { claim_uid: uid, observed_result: 'blue', observed_by: 'a', method: 'm', independence: 'self', client_request_id: 'req-1' });
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error('unreachable');
    expect(replay.replayed).toBe(true);
    expect(await readOutcomes(db, uid)).toHaveLength(1);
  });
});

// ── AC7 — expectation confidence recorded + revisitable ───────────────────────

describe('D-C — expectation is recorded (AC7)', () => {
  it('the claim stores the expected outcome + confidence at assertion time', async () => {
    const uid = await assertClaim({ expectation: { expected_outcome: 'blue-ish', confidence: 'low' } });
    const view = await readClaimView(db, uid);
    expect(view).not.toBeNull();
    expect(view!.expectation.expected_outcome).toBe('blue-ish');
    expect(view!.expectation.confidence).toBe('low');
    expect(view!.facet).toBe('observation:colour');
    expect(view!.project_path).toBe('/p');
    expect(view!.revision).toBe(1);
  });
});

// ── K-I1 — claim immutability ─────────────────────────────────────────────────

describe('D-C — K-I1 claim immutability', () => {
  it('refuses a content edit and a frozen-meta change; allows a non-frozen meta merge', async () => {
    const uid = await assertClaim();

    const contentEdit = await memoryUpdate(db, { uid, content: 'the sky is GREEN' });
    expect('code' in contentEdit && contentEdit.code).toBe('E_CLAIM_IMMUTABLE');

    const expEdit = await memoryUpdate(db, {
      uid,
      metadata: { expectation: { expected_outcome: 'green', confidence: 'high' } },
    });
    expect('code' in expEdit && expEdit.code).toBe('E_CLAIM_IMMUTABLE');

    const facetEdit = await memoryUpdate(db, { uid, metadata: { facet: 'observation:other' } });
    expect('code' in facetEdit && facetEdit.code).toBe('E_CLAIM_IMMUTABLE');

    // A NON-frozen meta key merges fine (the claim's own frozen fields are intact).
    const okEdit = await memoryUpdate(db, { uid, metadata: { note: 'reviewed' } });
    expect('updated_fields' in okEdit && okEdit.updated_fields).toContain('meta');
  });

  it('claim-upsert refuses a patch that would change a frozen field', async () => {
    const uid = await assertClaim();
    const patched = await memoryClaimUpsert(db, {
      uid,
      caller: 'alice',
      patch: { metadata: { expectation: { expected_outcome: 'green', confidence: 'high' } } },
    });
    expect(patched.ok).toBe(false);
    if (patched.ok) throw new Error('unreachable');
    expect(patched.code).toBe('E_CLAIM_IMMUTABLE');
  });
});

// ── AC2/AC3 — the open facet vocabulary + term stability ──────────────────────

/**
 * The refuted design (AC3 negative control): admit a term and ALLOW an in-place
 * redefine. Selected by DC_NEGATIVE_FACET=1.
 */
async function admitInPlace(
  _adapter: StoreAdapter,
  p: { facet: string; term: string; definition: string; origin: string },
): Promise<FacetTerm> {
  return {
    id: `${p.facet}:${p.term}`,
    facet: p.facet,
    term: p.term,
    definition: p.definition,
    definitionHash: 'in-place-redefined',
    status: 'unpromoted',
    origin: p.origin,
    demand: { count: 0, distinctClaims: 0 },
    created_at: '',
  };
}
const admit: typeof memoryFacetAdmit =
  process.env['DC_NEGATIVE_FACET'] === '1'
    ? (adapter, p) => admitInPlace(adapter, p)
    : memoryFacetAdmit;

describe('D-C — open facet vocabulary (AC2) and term stability (AC3)', () => {
  it('a new term is admitted unpromoted and appears in the readable catalog', async () => {
    const t = await admit(db, { facet: 'technique', term: 'bisection', definition: 'halve the interval', origin: 'researcher' });
    expect(t.status).toBe('unpromoted');
    const catalog = await memoryFacetList(db, { facet: 'technique' });
    expect(catalog.map((x) => x.id)).toContain('technique:bisection');
  });

  it('admitting the SAME id with a different definition throws E_TERM_REDEFINED (DC_NEGATIVE_FACET=1 → RED)', async () => {
    await admit(db, { facet: 'technique', term: 'bisection', definition: 'halve the interval', origin: 'researcher' });
    // Idempotent: same definition is accepted.
    await admit(db, { facet: 'technique', term: 'bisection', definition: 'halve the interval', origin: 'researcher' });
    // Redefine: refused (K-I5). Mint a new id for a new meaning.
    await expect(
      admit(db, { facet: 'technique', term: 'bisection', definition: 'a completely different meaning', origin: 'researcher' }),
    ).rejects.toMatchObject({ code: 'E_TERM_REDEFINED' });
    // The same definition under a NEW term id succeeds.
    const fresh = await admit(db, { facet: 'technique', term: 'bisection-v2', definition: 'a completely different meaning', origin: 'researcher' });
    expect(fresh.id).toBe('technique:bisection-v2');
  });

  it('promotion is gated on distinct-claim demand (AC2)', async () => {
    await admit(db, { facet: 'pattern', term: 'retry', definition: 'bounded retry', origin: 'researcher' });
    // No claims demand it yet → stays unpromoted.
    const beforePromote = await memoryFacetPromote(db, { term_id: 'pattern:retry' });
    expect(beforePromote.status).toBe('unpromoted');

    // Two distinct claims filed under the term (min default 2) → promotable.
    await assertClaim({ text: 'retry absorbs jitter', facet: 'pattern:retry' });
    await assertClaim({ text: 'retry must be bounded', facet: 'pattern:retry' });
    const promoted = await memoryFacetPromote(db, { term_id: 'pattern:retry' });
    expect(promoted.status).toBe('promoted');
    expect(promoted.demand.distinctClaims).toBe(2);

    // Unknown term id is a typed error.
    await expect(memoryFacetPromote(db, { term_id: 'pattern:nope' })).rejects.toBeInstanceOf(FacetError);
  });
});

// ── SR-3 — metadata predicate + count ─────────────────────────────────────────

describe('D-C — SR-3 metadata predicate + count', () => {
  it('filters.metadata returns ONLY matching rows and count matches the subset', async () => {
    await seedEpisode('alpha release succeeded', 'success');
    await seedEpisode('beta release failed', 'fail');
    await seedEpisode('gamma release succeeded', 'success');

    const res = await memoryRecall(db, 'project', {
      query: 'release',
      limit: 10,
      filters: { metadata: { path: 'case.outcome.result', in: ['success'] } },
    });
    // All 3 episodes share the word 'release'; only 2 are success. If the
    // predicate were ignored (client-side join / corpus-wide count) these become
    // 3 and the assertions go RED.
    expect(res.results.length).toBe(2);
    expect(res.count).toBeDefined();
    expect(res.count!.value).toBe(2);
    expect(res.count!.exactness).toBe('eq');
  });

  it('reports count exactness=gte when the match count exceeds the configured cap', async () => {
    await seedEpisode('one x', 'success');
    await seedEpisode('two x', 'success');
    const cfg: KnowledgeConfig = {
      ...DEFAULT_KNOWLEDGE_CONFIG,
      coverage: { ...DEFAULT_KNOWLEDGE_CONFIG.coverage, countCap: 1 },
    };
    _setKnowledgeConfigForTest(cfg);
    const res = await memoryRecall(db, 'project', {
      query: 'x',
      limit: 10,
      filters: { metadata: { path: 'case.outcome.result', in: ['success'] } },
    });
    expect(res.count!.value).toBe(1);
    expect(res.count!.exactness).toBe('gte');
  });
});

// ── AC6 — coverage abstention ─────────────────────────────────────────────────

describe('D-C — coverage-aware abstention (AC6)', () => {
  it('abstains (never returns the nearest held row) under a calibrated threshold; the permissive default answers', async () => {
    await seedEpisode('alpha release succeeded', 'success');
    await seedEpisode('beta release failed', 'fail');

    // Negative control: the shipped (permissive) config is the pre-fix shape —
    // it returns the nearest held rows.
    const permissive = await memoryRecall(db, 'project', { query: 'release', limit: 10 });
    expect(permissive.coverage!.abstained).toBe(false);
    expect(permissive.results.length).toBeGreaterThan(0);

    // Calibrated: an impossible similarity floor makes the honest answer ABSTAIN.
    const strict: KnowledgeConfig = {
      ...DEFAULT_KNOWLEDGE_CONFIG,
      coverage: { ...DEFAULT_KNOWLEDGE_CONFIG.coverage, minMaxSimilarity: 2 },
    };
    _setKnowledgeConfigForTest(strict);
    const abstained = await memoryRecall(db, 'project', { query: 'release', limit: 10 });
    expect(abstained.coverage!.abstained).toBe(true);
    expect(abstained.coverage!.reason).toBe('no-coverage');
    expect(abstained.results).toEqual([]);
    expect(abstained.coverage!.threshold_source).toBe('coverage.minMaxSimilarity');
  });

  it('an empty candidate set abstains on the permissive default too', async () => {
    await seedEpisode('alpha', 'success');
    const res = await memoryRecall(db, 'project', {
      query: 'alpha',
      limit: 10,
      filters: { metadata: { path: 'case.outcome.result', in: ['nonexistent'] } },
    });
    expect(res.coverage!.abstained).toBe(true);
    expect(res.results).toEqual([]);
  });
});

// ── SR-8 — verify-after-write ─────────────────────────────────────────────────

describe('D-C — SR-8 batch verify-after-write', () => {
  it('round-trips every supplied field (ok:true)', async () => {
    const res = await memoryWriteBatch(db, [
      { content: 'batch one', project_path: '/p', topic: 't1', tags: ['a', 'b'], importance: 7, summary: 's1' },
    ]);
    expect(res.results[0]!.ok).toBe(true);
  });

  it('an injected drop FAILS the item naming the field (DC_NEGATIVE_SR8=1 → silently ok → RED)', async () => {
    _setBatchDropFieldForTest('topic');
    if (process.env['DC_NEGATIVE_SR8'] === '1') _setBatchVerifyDisabledForTest(true);
    const res = await memoryWriteBatch(db, [
      { content: 'batch two', project_path: '/p', topic: 't2', tags: ['x'], importance: 3, summary: 's2' },
    ]);
    const item = res.results[0]!;
    expect(item.ok).toBe(false);
    if (item.ok) throw new Error('unreachable');
    expect(item.code).toBe('E_VERIFY_FAILED');
    expect((item.details as { field?: string } | undefined)?.field).toBe('topic');
  });
});

// ── K-I7 — concurrency: two real connections, latch barrier ───────────────────

/** The pre-fix shape: read meta, then write it — NO conditional predicate. */
async function claimUnguarded(
  adapter: StoreAdapter,
  uid: string,
  caller: string,
  afterRead: () => Promise<void>,
): Promise<{ ok: true } | { ok: false; code: 'E_CLAIM_HELD' }> {
  const row = await adapter.executeGet<{ meta: string | null }>(
    `SELECT meta FROM node WHERE uid = ? AND t_invalid IS NULL`,
    [uid],
  );
  const meta = row?.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {};
  await afterRead();
  const now = new Date().toISOString();
  meta['claim'] = { caller, claimed_at: now, updated_at: now, revision: 1 };
  await adapter.executeRun(`UPDATE node SET meta = ? WHERE uid = ?`, [JSON.stringify(meta), uid]);
  return { ok: true };
}

describe('D-C — K-I7 concurrency: exactly one claim wins (DC_NEGATIVE_CLAIM=1 → RED)', () => {
  it('two racing connections yield one winner; the loser gets E_CLAIM_HELD', async () => {
    const uid = await assertClaim();
    await db.close();

    const a = await openDb(dbPath);
    const b = await openDb(dbPath);
    try {
      const negative = process.env['DC_NEGATIVE_CLAIM'] === '1';
      let releaseStart!: () => void;
      const start = new Promise<void>((r) => (releaseStart = r));
      let reads = 0;
      let releaseReads!: () => void;
      const bothRead = new Promise<void>((r) => (releaseReads = r));
      const afterRead = async (): Promise<void> => {
        reads += 1;
        if (reads === 2) releaseReads();
        await bothRead;
      };
      const run = (adapter: StoreAdapter, caller: string) =>
        start.then(async () => {
          if (!negative) return memoryClaimUpsert(adapter, { uid, caller });
          return claimUnguarded(adapter, uid, caller, afterRead);
        });
      const p1 = run(a, 'alice');
      const p2 = run(b, 'bob');
      releaseStart();
      const [r1, r2] = await Promise.all([p1, p2]);

      const winners = [r1, r2].filter((r) => r.ok);
      expect(winners.length).toBe(1); // the invariant; RED under the unguarded variant
      const loser = [r1, r2].find((r) => !r.ok);
      expect(loser).toBeDefined();
      if (loser && !loser.ok && 'code' in loser) expect(loser.code).toBe('E_CLAIM_HELD');
    } finally {
      await a.close();
      await b.close();
      db = await openDb(dbPath);
    }
  });
});

// ── H2 — facet-admit race: exactly one registry node per term id ──────────────
//
// `memoryFacetAdmit` checks `findByTermId` and then INSERTs with
// `skipDedupe:true`. Two concurrent PROCESSES admitting the SAME term id (with
// DIFFERENT definitions) could each miss the check and both INSERT → two
// registry nodes carrying the same `meta.facet_term.id` but different
// `definitionHash`, bypassing the K-I5 `E_TERM_REDEFINED` guard (ADR-0012: a
// check-then-INSERT is not atomic across processes). The fix runs the check and
// the INSERT in ONE `BEGIN IMMEDIATE` transaction (the ADR-0012 §1 CAS
// primitive) so writers serialize: the losing admit's check runs only after the
// winner commits, and it then throws the SAME K-I5 error.
//
// DC_NEGATIVE_FACET_RACE=1 swaps in the pre-fix UNGUARDED shape (no transaction)
// held at a latch barrier, so both checks pass and both INSERT — two registry
// nodes, and the exactly-one-winner assertion goes RED.

/**
 * The pre-fix `memoryFacetAdmit` shape: a bare existence check, then an
 * UNGUARDED `skipDedupe` INSERT — no transaction, so two callers can both miss
 * the check. `afterRead` is the K-I7 latch barrier (never a sleep) that holds
 * both callers at their check until each has read, forcing the race window open
 * deterministically for the negative control.
 */
async function facetAdmitUnguarded(
  adapter: StoreAdapter,
  p: { facet: string; term: string; definition: string; origin: string },
  afterRead: () => Promise<void>,
): Promise<FacetTerm> {
  const id = facetTermId(p.facet, p.term);
  const row = await adapter.executeGet<{ uid: string }>(
    `SELECT uid, name, meta FROM node
      WHERE kind = 'generic' AND topic = 'facet-registry' AND t_invalid IS NULL
        AND json_valid(meta) AND json_extract(meta, '$.facet_term.id') = ?
      LIMIT 1`,
    [id],
  );
  if (row) throw new FacetError('E_TERM_REDEFINED', `pre-fix guard: ${id}`);
  await afterRead();
  await getMemoryGraphBackend(adapter).writeNode(
    p.term,
    {
      kind: 'generic',
      name: p.term,
      topic: 'facet-registry',
      source: 'observation',
      metadata: {
        facet_term: {
          id,
          facet: p.facet,
          term: p.term,
          definition: p.definition,
          definitionHash: `pre-fix-${p.definition}`,
          status: 'unpromoted',
          origin: p.origin,
          created_at: new Date().toISOString(),
        },
      },
    },
    { skipDedupe: true },
  );
  return {
    id,
    facet: p.facet,
    term: p.term,
    definition: p.definition,
    definitionHash: `pre-fix-${p.definition}`,
    status: 'unpromoted',
    origin: p.origin,
    demand: { count: 0, distinctClaims: 0 },
    created_at: '',
  };
}

describe('D-C — H2 facet-admit race: exactly one registry node per term id (DC_NEGATIVE_FACET_RACE=1 → RED)', () => {
  it('two racing admits of the same term id yield one winner; the loser gets E_TERM_REDEFINED and no duplicate exists', async () => {
    await db.close();

    const a = await openDb(dbPath);
    const b = await openDb(dbPath);
    try {
      const negative = process.env['DC_NEGATIVE_FACET_RACE'] === '1';

      let releaseStart!: () => void;
      const start = new Promise<void>((r) => (releaseStart = r));
      let reads = 0;
      let releaseReads!: () => void;
      const bothRead = new Promise<void>((r) => (releaseReads = r));
      const afterRead = async (): Promise<void> => {
        reads += 1;
        if (reads === 2) releaseReads();
        await bothRead;
      };

      const base = { facet: 'pattern', term: 'retry', origin: 'researcher' } as const;
      // Positive path: the fix serializes the two BEGIN IMMEDIATE transactions.
      // Negative path: the pre-fix unguarded shape, held at the latch barrier.
      const run = (adapter: StoreAdapter, definition: string) =>
        start.then(() =>
          negative
            ? facetAdmitUnguarded(adapter, { ...base, definition }, afterRead)
            : memoryFacetAdmit(adapter, { ...base, definition }),
        );

      const pA = run(a, 'bounded retry with jitter');
      const pB = run(b, 'the racing pre-fix definition');
      releaseStart();
      const settled = await Promise.allSettled([pA, pB]);

      const fulfilled = settled.filter((s) => s.status === 'fulfilled');
      const rejected = settled.filter((s) => s.status === 'rejected');
      // The invariant: exactly one admit wins. RED (2 fulfilled) under the
      // unguarded pre-fix shape.
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'E_TERM_REDEFINED' });

      // Exactly ONE registry node for this term id — never a duplicate.
      const nodes = await a.executeAll<{ uid: string }>(
        `SELECT uid FROM node
          WHERE kind = 'generic' AND topic = 'facet-registry' AND t_invalid IS NULL
            AND json_valid(meta) AND json_extract(meta, '$.facet_term.id') = ?`,
        ['pattern:retry'],
      );
      expect(nodes.rows.length).toBe(1);
    } finally {
      await a.close();
      await b.close();
      db = await openDb(dbPath);
    }
  }, 30_000);
});
