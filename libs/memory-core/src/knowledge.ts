/**
 * knowledge.ts — D-C primitive (a): the outcome-gated knowledge record.
 *
 * This module is the PURE half of the knowledge layer: the record shape and the
 * verdict function. It reads no store and calls no model, so the tiering rules
 * are unit-testable in isolation (see `knowledge.spec.ts`).
 *
 * ## The split
 *
 * A knowledge record has an IMMUTABLE half and an APPEND-ONLY half:
 *
 *   - the **claim**  — subject/text + facet + expectation{expected_outcome,
 *     confidence}, frozen at first write (K-I1). Backed by a native `claim` node
 *     whose lease (`meta.claim`) is minted by SR-7's `memoryClaimUpsert`; the
 *     claim's `revision` is that lease's upsert counter.
 *   - the **outcomes** — each a NEW `episode` node carrying a `meta.outcome`
 *     envelope and a `DERIVED_FROM` edge to the claim (K-I2). An outcome is
 *     never rewritten; re-recording appends.
 *
 * ## The verdict is DERIVED, never stored (K-I3)
 *
 * `deriveVerdict` computes the tier on read from the outcome set, the live
 * `REFUTES` edges, and the claim's revision. Nothing about the tier is a column,
 * so it cannot drift out of sync with the evidence.
 *
 * ## Tiered, never boolean (K-I4)
 *
 * The enum splits Repeatability (self) from Reproducibility (independent, same
 * artifacts) from Replicability (independent, agreeing) — a single `verified`
 * boolean destroys that distinction (DESIGN.md §3). Precedence:
 *
 *   refuted > stale > replicated > independently-reproduced > self-reproduced
 *           > unverified > unknown
 *
 * ## `meta.claim` vs `meta.claim_record` (schedule deviation, documented)
 *
 * SR-7 (already landed) stores its work-lease at `node.meta.claim`. The
 * converged-primitives design names the claim *envelope* `meta.claim` too; that
 * key is already owned by the lease, so this layer stores the knowledge
 * envelope at `meta.claim_record` instead of clobbering the lease. The frozen
 * fields (K-I1) are therefore `content` + `meta.expectation` + `meta.facet` +
 * `meta.claim_record`.
 *
 * [inv:no-mcp] — returns plain result objects, never an MCP ToolResult.
 */

export type VerdictTier =
  | 'unverified'
  | 'self-reproduced'
  | 'independently-reproduced'
  | 'replicated'
  | 'stale'
  | 'refuted'
  | 'unknown';

/** Recorded on each outcome (never inferred): who observed it, and how independently. */
export type Independence = 'self' | 'independent';

export type Confidence = 'low' | 'medium' | 'high';

export interface Expectation {
  expected_outcome: string;
  confidence: Confidence;
}

/** The immutable half of a knowledge record (K-I1). */
export interface ClaimView {
  uid: string;
  /** The assertion text (node.content). */
  text: string;
  /** The facet term id this claim is filed under (meta.facet). */
  facet: string;
  project_path: string;
  expectation: Expectation;
  /** The claim's lease upsert counter (SR-7 `meta.claim.revision`); 1 when unheld. */
  revision: number;
  t_created: string;
}

/** One append-only outcome (K-I2). Never rewritten. */
export interface OutcomeView {
  uid: string;
  claim_uid: string;
  observed_result: string;
  observed_by: string;
  method: string;
  observed_at: string;
  independence: Independence;
  /** The claim lease revision this outcome speaks to (drives staleness). */
  attestation_revision: number;
}

export interface Verdict {
  tier: VerdictTier;
  /** Human-readable reasons, each naming the evidence that produced the tier. */
  basis: string[];
}

export interface Citation {
  file?: string;
  uid?: string;
  context?: string;
}

export interface BackResult {
  claim: ClaimView;
  outcomes: OutcomeView[];
  verdict: Verdict;
  citations: Citation[];
}

/**
 * The frozen `meta.*` fields of a `claim` node (K-I1). Single-sourced here so
 * `claim.ts` (the upsert guard) and `update.ts` (the in-place guard) can never
 * drift. NOTE: the envelope key is `claim_record`, not `claim` — `meta.claim` is
 * SR-7's mutable work-LEASE.
 */
export const FROZEN_CLAIM_META_KEYS = ['expectation', 'facet', 'claim_record'] as const;

export interface DeriveVerdictOpts {
  /** Uids of live nodes that REFUTE the claim (from `REFUTES` edges). */
  refutedBy: string[];
  /** The claim's current revision (its lease upsert counter). */
  currentRevision: number;
}

/** Whitespace-collapsed, case-folded comparison key for "agreeing" outcomes. */
export function normalizeObserved(result: string): string {
  return result.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * PURE. Derive the tiered verdict from the claim + its outcome evidence.
 *
 * Deterministic and side-effect free; the same inputs always yield the same
 * tier and basis.
 */
export function deriveVerdict(
  claim: ClaimView,
  outcomes: readonly OutcomeView[],
  opts: DeriveVerdictOpts,
): Verdict {
  // 1. Refuted dominates everything (SR-5): a live refutation is the strongest
  //    signal and outranks any amount of reproduction.
  if (opts.refutedBy.length > 0) {
    return {
      tier: 'refuted',
      basis: opts.refutedBy.map((uid) => `refuted by ${uid}`),
    };
  }

  const currentRevision = opts.currentRevision;

  // 2. Stale: the claim has advanced past EVERY recorded outcome, so the whole
  //    outcome set speaks to a revision that is no longer current. (Inert until
  //    SR-2/SR-6 give the claim a node revision — see the migration note; the
  //    logic is exercised by the pure unit tests.)
  if (outcomes.length > 0 && outcomes.every((o) => o.attestation_revision < currentRevision)) {
    return {
      tier: 'stale',
      basis: [
        `all ${outcomes.length} outcome(s) attest to a revision older than the current ${currentRevision}`,
        `claim ${claim.uid} at revision ${currentRevision}`,
      ],
    };
  }

  // 3. No evidence: asserted, never checked.
  if (outcomes.length === 0) {
    return { tier: 'unverified', basis: ['no outcomes recorded'] };
  }

  // 4. Replicated: >=2 INDEPENDENT outcomes that AGREE on the observed result.
  //    Independence is split out deliberately (K-I4) — two self-observations,
  //    or two independent observations that disagree, must NOT read replicated.
  const independents = outcomes.filter((o) => o.independence === 'independent');
  const byResult = new Map<string, OutcomeView[]>();
  for (const o of independents) {
    const key = normalizeObserved(o.observed_result);
    const bucket = byResult.get(key);
    if (bucket) bucket.push(o);
    else byResult.set(key, [o]);
  }
  for (const [key, group] of byResult) {
    if (group.length >= 2) {
      return {
        tier: 'replicated',
        basis: [
          `${group.length} independent outcomes agree (${key || '<empty>'})`,
          `uids: ${group.map((o) => o.uid).join(', ')}`,
        ],
      };
    }
  }

  // 5. Independently reproduced: at least one independent observation, but not
  //    a replicated pair.
  if (independents.length > 0) {
    return {
      tier: 'independently-reproduced',
      basis: [`independent outcome(s): ${independents.map((o) => o.uid).join(', ')}`],
    };
  }

  // 6. Self-reproduced: only the claimant's own observations.
  const selfs = outcomes.filter((o) => o.independence === 'self');
  if (selfs.length > 0) {
    return {
      tier: 'self-reproduced',
      basis: [`self-observed outcome(s): ${selfs.map((o) => o.uid).join(', ')}`],
    };
  }

  // 7. Outcomes exist but none classifies (malformed independence) — refuse to
  //    guess a tier.
  return { tier: 'unknown', basis: ['outcomes present but none had a usable independence level'] };
}
