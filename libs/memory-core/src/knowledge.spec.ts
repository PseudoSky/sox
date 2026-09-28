/**
 * knowledge.spec.ts — D-C pure primitives: `deriveVerdict` (tiered verdict) and
 * `assessCoverage` (coverage-aware abstention).
 *
 * These are pure functions over explicit inputs, so the tests are deterministic
 * and independent of any store. Each capability's NEGATIVE CONTROL lives here as
 * a deliberately-wrong variant selected by an env flag; with the flag set the
 * assertion goes RED, proving the real implementation is load-bearing.
 *
 *   DC_NEGATIVE_COLLAPSE=1  → replace the tiered verdict with the refuted
 *                             single-boolean design (K-I4 collapse).
 *   DC_NEGATIVE_ANSWER=1    → replace coverage abstention with "always return
 *                             the nearest thing held" (K-I6 violation).
 *
 * Run the negative control explicitly, e.g.:
 *   DC_NEGATIVE_COLLAPSE=1 npx nx test memory-core -- dc-knowledge
 */
import { describe, it, expect } from 'vitest';
import {
  deriveVerdict,
  type ClaimView,
  type OutcomeView,
  type Verdict,
} from './knowledge.js';
import { assessCoverage } from './coverage.js';
import { DEFAULT_KNOWLEDGE_CONFIG, type KnowledgeConfig } from './config.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function claim(over: Partial<ClaimView> = {}): ClaimView {
  return {
    uid: 'claim-1',
    text: 'the sky is blue',
    facet: 'observation:colour',
    project_path: '/p',
    expectation: { expected_outcome: 'blue', confidence: 'medium' },
    revision: 1,
    t_created: '2026-09-27T00:00:00.000Z',
    ...over,
  };
}

function outcome(over: Partial<OutcomeView> = {}): OutcomeView {
  return {
    uid: 'out-1',
    claim_uid: 'claim-1',
    observed_result: 'blue',
    observed_by: 'alice',
    method: 'eyeball',
    observed_at: '2026-09-27T01:00:00.000Z',
    independence: 'self',
    attestation_revision: 1,
    ...over,
  };
}

// ── The negative-control variants (the refuted designs) ───────────────────────

/** The collapsed single-boolean design: any outcome ⇒ 'independently-reproduced'. */
function deriveVerdictCollapsed(_c: ClaimView, outcomes: readonly OutcomeView[]): Verdict {
  return outcomes.length > 0
    ? { tier: 'independently-reproduced', basis: ['verified (collapsed)'] }
    : { tier: 'unverified', basis: [] };
}

const collapseNegative = process.env['DC_NEGATIVE_COLLAPSE'] === '1';
const derive: typeof deriveVerdict = collapseNegative
  ? ((c, o) => deriveVerdictCollapsed(c, o))
  : deriveVerdict;

// ── deriveVerdict ─────────────────────────────────────────────────────────────

describe('deriveVerdict — tiered, never boolean (K-I4, AC5)', () => {
  it('no outcomes ⇒ unverified', () => {
    const v = derive(claim(), [], { refutedBy: [], currentRevision: 1 });
    expect(v.tier).toBe('unverified');
  });

  it('TWO records differing ONLY in independence yield DIFFERENT tiers (the negative control collapses this)', () => {
    const self = derive(claim(), [outcome({ uid: 'o-self', independence: 'self' })], {
      refutedBy: [],
      currentRevision: 1,
    });
    const indep = derive(claim(), [outcome({ uid: 'o-indep', independence: 'independent' })], {
      refutedBy: [],
      currentRevision: 1,
    });
    expect(self.tier).toBe('self-reproduced');
    expect(indep.tier).toBe('independently-reproduced');
    // THE INVARIANT the boolean design destroys: the two must differ.
    expect(self.tier).not.toBe(indep.tier);
  });

  it('two INDEPENDENT AGREEING outcomes ⇒ replicated', () => {
    const v = derive(
      claim(),
      [
        outcome({ uid: 'o1', independence: 'independent', observed_result: 'blue' }),
        outcome({ uid: 'o2', independence: 'independent', observed_result: 'BLUE ' }),
      ],
      { refutedBy: [], currentRevision: 1 },
    );
    expect(v.tier).toBe('replicated');
  });

  it('two independent outcomes that DISAGREE are NOT replicated', () => {
    const v = derive(
      claim(),
      [
        outcome({ uid: 'o1', independence: 'independent', observed_result: 'blue' }),
        outcome({ uid: 'o2', independence: 'independent', observed_result: 'green' }),
      ],
      { refutedBy: [], currentRevision: 1 },
    );
    expect(v.tier).toBe('independently-reproduced');
  });

  it('two SELF outcomes that agree are NOT replicated (independence is required)', () => {
    const v = derive(
      claim(),
      [
        outcome({ uid: 'o1', independence: 'self', observed_result: 'blue' }),
        outcome({ uid: 'o2', independence: 'self', observed_result: 'blue' }),
      ],
      { refutedBy: [], currentRevision: 1 },
    );
    expect(v.tier).toBe('self-reproduced');
  });

  it('a live REFUTES edge dominates every reproduction level ⇒ refuted', () => {
    const v = derive(
      claim(),
      [
        outcome({ uid: 'o1', independence: 'independent', observed_result: 'blue' }),
        outcome({ uid: 'o2', independence: 'independent', observed_result: 'blue' }),
      ],
      { refutedBy: ['refuter-9'], currentRevision: 1 },
    );
    expect(v.tier).toBe('refuted');
    expect(v.basis.join(' ')).toContain('refuter-9');
  });

  it('outcomes all attesting an older revision ⇒ stale', () => {
    const v = derive(claim({ revision: 3 }), [outcome({ attestation_revision: 1 })], {
      refutedBy: [],
      currentRevision: 3,
    });
    expect(v.tier).toBe('stale');
  });
});

// ── assessCoverage ────────────────────────────────────────────────────────────

/** The pre-fix retriever: never abstains — always returns the nearest thing held. */
function assessAlwaysAnswer(): ReturnType<typeof assessCoverage> {
  return {
    abstained: false,
    signals: { max_similarity: 1, distribution_flatness: 0, topk_entropy: 0, decay_rate: 0 },
    threshold_source: 'negative-control:always-answer',
  };
}

const answerNegative = process.env['DC_NEGATIVE_ANSWER'] === '1';
const assess: typeof assessCoverage = answerNegative
  ? (() => assessAlwaysAnswer())
  : assessCoverage;

describe('assessCoverage — abstain on no coverage (K-I6, AC6)', () => {
  it('empty candidate set ⇒ abstains no-coverage', () => {
    const env = assess([], DEFAULT_KNOWLEDGE_CONFIG);
    expect(env.abstained).toBe(true);
    expect(env.reason).toBe('no-coverage');
  });

  it('a calibrated minMaxSimilarity makes a weak candidate set abstain', () => {
    const cfg: KnowledgeConfig = {
      ...DEFAULT_KNOWLEDGE_CONFIG,
      coverage: { ...DEFAULT_KNOWLEDGE_CONFIG.coverage, minMaxSimilarity: 0.8 },
    };
    const env = assess([{ score: 0.1 }, { score: 0.09 }], cfg, { topSimilarity: 0.1 });
    expect(env.abstained).toBe(true);
    expect(env.reason).toBe('no-coverage');
    expect(env.threshold_source).toBe('coverage.minMaxSimilarity');
  });

  it('the permissive default does NOT abstain on a covered query', () => {
    const env = assess([{ score: 0.9 }, { score: 0.4 }], DEFAULT_KNOWLEDGE_CONFIG, {
      topSimilarity: 0.9,
    });
    expect(env.abstained).toBe(false);
    expect(env.threshold_source).toBe('coverage:no-threshold-exceeded');
  });

  it('a flat distribution trips the flatness signal when enabled', () => {
    const cfg: KnowledgeConfig = {
      ...DEFAULT_KNOWLEDGE_CONFIG,
      coverage: { ...DEFAULT_KNOWLEDGE_CONFIG.coverage, maxFlatness: 0.5 },
    };
    const env = assess([{ score: 1 }, { score: 0.99 }, { score: 0.98 }], cfg, {
      topSimilarity: 1,
    });
    expect(env.abstained).toBe(true);
    expect(env.reason).toBe('flat-distribution');
  });

  it('a uniform top-k trips the entropy signal when enabled', () => {
    const cfg: KnowledgeConfig = {
      ...DEFAULT_KNOWLEDGE_CONFIG,
      coverage: { ...DEFAULT_KNOWLEDGE_CONFIG.coverage, maxEntropy: 0.9 },
    };
    const env = assess([{ score: 1 }, { score: 1 }, { score: 1 }, { score: 1 }], cfg, {
      topSimilarity: 1,
    });
    expect(env.abstained).toBe(true);
    expect(env.reason).not.toBe('no-coverage');
  });

  it('the INVARIANT: a no-coverage set abstains (negative control always-answer → RED)', () => {
    // With the pre-fix retriever (DC_NEGATIVE_ANSWER=1) this returns a candidate
    // set as an answer and the assertion below goes RED.
    const cfg: KnowledgeConfig = {
      ...DEFAULT_KNOWLEDGE_CONFIG,
      coverage: { ...DEFAULT_KNOWLEDGE_CONFIG.coverage, minMaxSimilarity: 0.5 },
    };
    const env = assess([{ score: 0.05 }], cfg, { topSimilarity: 0.05 });
    expect(env.abstained).toBe(true);
  });
});
