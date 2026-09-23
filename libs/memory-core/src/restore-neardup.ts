/**
 * restore-neardup.ts — `memory_curate op: 'restore_neardup'`.
 *
 * WHAT THIS UNDOES. An automatic near-duplicate pass invalidated 852 episodes.
 * 689 of them sit on a live inferred SAME_AS edge; the other 163 carry no
 * SAME_AS edge at all and are structurally invisible to a component-wise
 * restore (they are counted and reported, never touched — see
 * `out_of_scope_edgeless_invalidated_episodes`).
 *
 * A separate read-only triage run classified the 689 component-wise using
 * LEXICAL measures only — Jaccard (union denominator), token-LCS normalised by
 * max length, containment (min denominator) and length ratio. Its output is
 * this op's decision input: the op does not re-derive the classification, it
 * verifies that the store still has the membership the report describes and
 * then applies the report's decision.
 *
 * TWO SIGNALS ARE BANNED FROM THIS FILE, IN EVERY FORM — filter, ranking,
 * tiebreak or ordering key:
 *
 *   1. EMBEDDING COSINE. The triage measured recorded pair cosine at 0.95–1.00
 *      across every class, including the false positives. It does not
 *      discriminate, and the one place it was trusted is what produced this
 *      mess.
 *   2. AGE / RECENCY / CREATION ORDER. An age rule is what selected which
 *      member of each component to destroy, and in 264 of 270 parent-chunk
 *      components the member it destroyed was the LONGEST one — the parent
 *      document, not the chunk. Nothing here reads a creation timestamp, and
 *      nothing here depends on natural row order: components are ordered by
 *      their report component id and members by uid, both explicitly.
 *      (`prior_t_invalid` is read and written, but only as the value to
 *      restore and to reverse by — never compared, ordered or ranked.)
 *
 * RESTORE SCOPE IS A POLICY CHOICE, NOT A MEASUREMENT. The op restores every
 * component the triage did NOT classify as TRUE-DUPLICATE — that is the
 * measured floor (lexically-distinct plus DERIVED_FROM-confirmed parent/chunk)
 * PLUS the whole ambiguous band. The ambiguous band is included on an
 * asymmetry argument chosen by the operator: a wrongly-restored duplicate is
 * one redundant row that stays re-mergeable through its retained SAME_AS edge,
 * while a wrongly-withheld false positive is a fact nobody chose to delete,
 * lost permanently. Nothing measured says the ambiguous band is recoverable.
 * Every result carries that statement in `policy.note`.
 *
 * REVERSAL. Every restored row carries `meta.restoredFrom` with the exact
 * `prior_t_invalid` it was holding, so a restore is undone from the rows
 * themselves — no report, no log, no second pass needed. Use the op:
 *
 *   memory_curate {op:'restore_neardup', reverse:true,
 *                  report_sha256:'<sha>',        // or all_runs:true
 *                  dry_run:false}
 *
 * It is NOT a convenience wrapper around the `UPDATE`. The ORIGINAL
 * invalidation ran `gcOrphanedCommunityState`, so a reversal that only sets
 * `t_invalid` back leaves the row's `MEMBER_OF` edges and any now-empty
 * community LIVE — re-creating the 139-communities / 0-members orphan leak
 * that community-gc.ts exists to prevent, and which the forward path avoids by
 * enqueueing a full enrich. `reverse:true` re-invalidates and GCs in the same
 * transaction, per row.
 *
 * The raw statements are still returned (`result.reversal.scoped_sql`, pinned
 * to this run's report sha256, and `result.reversal.sql`, every run ever) for
 * inspection and for operators who will GC separately — they carry that
 * caveat in `reversal.note`:
 *
 *   UPDATE node
 *      SET t_invalid = json_extract(meta, '$.restoredFrom.prior_t_invalid')
 *    WHERE json_extract(meta, '$.restoredFrom.op') = 'restore_neardup'
 *      AND t_invalid IS NULL
 *      AND json_extract(meta, '$.restoredFrom.report.sha256') = '<sha256>';
 *
 * `meta.restoredFrom` is deliberately NOT cleared by a reversal: the row keeps
 * the audit trail, and re-applying the op afterwards requires the explicit
 * `allow_rerestore: true` (an invalid row carrying `restoredFrom` is otherwise
 * a HALT on apply, because the other way to reach that state is the automatic
 * pass re-invalidating a restored row).
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// The ONE shared definition of "is this integrity_check line actually damage"
// (DEBT-NO-SHARED-TURSO-INTEGRITY-FILTER-001). Imported, never re-derived: a
// second copy of that regex is its own bug, and memory-core already has a
// runtime edge to this package (db.ts), so this adds no new dependency.
// NOTE: TYPE-ONLY here on purpose. `store-adapter` is lazy-loaded inside
// memory-core (recall.ts:382, db.ts, backup.ts), so @nx/enforce-module-boundaries
// forbids a static VALUE import of it from this package — a static one would also
// undo the lazy-load those call sites exist to preserve. The two values are pulled
// in via `await import()` at their single use site, `checkIntegrity` below.
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { enqueueEnrichFull } from './outbox-queue.js';
import { gcOrphanedCommunityState } from './community-gc.js';
import { expandTilde } from './recall.js';

// ── Report shape (the triage output this op consumes) ─────────────────────────

/** The four lexical measures, and only those. */
export interface LexicalMetrics {
  jaccard: number;
  lcs_norm: number;
  containment: number;
  len_ratio: number;
}

interface ReportPair extends Partial<LexicalMetrics> {
  a: string;
  b: string;
  derived_from?: boolean;
}

interface ReportComponent {
  comp: number;
  cls: string;
  members: Array<{ uid: string; invalid?: boolean }>;
  pairs?: ReportPair[];
  derivedFromPairs?: number;
}

interface TriageReport {
  components: ReportComponent[];
}

// ── Result shape ──────────────────────────────────────────────────────────────

export type PolicyBand = 'FLOOR' | 'POLICY_AMBIGUOUS' | 'WITHHELD_TRUE_DUPLICATE';

export type MemberAction =
  | 'restore'
  | 'already_live'
  | 'withheld_true_duplicate'
  | 'not_found'
  | 'no_live_inferred_same_as'
  | 'intent_superseded'
  | 'reinvalidated_after_restore'
  | 'skipped_membership_divergence';

export interface RestoreMemberPlan {
  uid: string;
  action: MemberAction;
  /** The exact `t_invalid` value that would be (or was) cleared. */
  prior_t_invalid: string | null;
  /** The component's decisive pair measures for this member — all four, never a subset. */
  metrics: LexicalMetrics | null;
  /** Every pair this member participates in, with all four measures. */
  pairs: Array<{ with: string; metrics: LexicalMetrics; derived_from: boolean }>;
}

export type ComponentStatus =
  | 'planned'
  | 'withheld_true_duplicate'
  | 'membership_divergence'
  | 'no_invalidated_members'
  /** Every invalidated member was held back by a guard (a missing live
   *  inferred SAME_AS edge, or recorded SUPERSEDES intent) — NOT the same
   *  thing as having no invalidated members, and deliberately distinct so a
   *  dry-run/report diff does not read it as one. */
  | 'all_members_withheld_by_guard'
  | 'halted_reinvalidated';

export interface RestoreComponentPlan {
  component_id: number;
  /** The triage class, verbatim. */
  class: string;
  policy_band: PolicyBand;
  /** True when at least one pair carries a live DERIVED_FROM edge in the report —
   *  a chunk of a document, PROVEN, as opposed to the shape-only hypothesis. */
  derived_from_confirmed: boolean;
  eligible: boolean;
  status: ComponentStatus;
  report_members: string[];
  store_members: string[];
  members: RestoreMemberPlan[];
}

export interface RestoreBatchReport {
  batch: number;
  component_ids: number[];
  expected_restored: number;
  observed_restored: number;
  verified: boolean;
}

export interface CurateRestoreNeardupResult {
  op: 'restore_neardup';
  dry_run: boolean;
  report: { path: string; sha256: string } | null;
  integrity: IntegrityVerdict & { override: boolean };
  policy: {
    scope: 'floor_plus_ambiguous';
    floor_plus_ambiguous: true;
    withholds: 'TRUE-DUPLICATE';
    note: string;
  };
  /** One line an operator cannot miss: the planned-vs-policy-scope arithmetic,
   *  what is withheld and why, and the policy-not-measurement framing. */
  headline: string;
  summary: {
    components_in_report: number;
    components_eligible: number;
    components_withheld_true_duplicate: number;
    components_membership_divergence: number;
    /** Components whose every invalidated member was held back by a guard.
     *  Distinct from `no_invalidated_members` — see ComponentStatus. */
    components_all_members_withheld_by_guard: number;
    members_restored: number;
    members_planned: number;
    members_floor: number;
    members_policy_ambiguous: number;
    members_withheld_true_duplicate: number;
    members_already_live: number;
    members_no_live_inferred_same_as: number;
    members_intent_superseded: number;
    members_not_found: number;
    /** Invalid rows that already carry meta.restoredFrom — something
     *  re-invalidated a restored row. Visible in a dry run; an APPLY halts. */
    members_reinvalidated_after_restore: number;
    /** Measured from the store on every call: invalidated episodes carrying NO
     *  SAME_AS edge. A component-wise restore cannot see these. Reported so
     *  "N restored" is never read as "everything recovered". */
    out_of_scope_edgeless_invalidated_episodes: number;
    /** The reconciliation, spelled out so nobody has to derive it:
     *  planned + withheld_intent_superseded = policy_scope_members. */
    policy_scope_reconciliation: {
      planned: number;
      floor: number;
      policy_ambiguous: number;
      withheld_intent_superseded: number;
      policy_scope_members: number;
      withheld_true_duplicate: number;
      same_as_population: number;
      out_of_scope_edgeless: number;
    };
  };
  components: RestoreComponentPlan[];
  batches: RestoreBatchReport[];
  enrich_enqueued_seq: number | null;
  /** The exact, self-contained undo for this run — see the file header.
   *  `scoped_sql` is null when no report was supplied: a statement whose
   *  sha256 predicate is an empty string matches nothing while LOOKING like a
   *  valid reversal, which is worse than no statement at all. */
  reversal: { sql: string; scoped_sql: string | null; note: string };
  /** Set (alongside `error`) when a batch failed verification mid-run, so the
   *  MCP layer still reports isError while the partial plan survives. */
  code?: string;
  error?: {
    code: string;
    batch: number;
    expected: number;
    observed: number;
    not_written: string[];
    message: string;
  };
}

export interface RestoreNeardupError {
  code: string;
  message?: string;
  op?: string;
  uids?: string[];
}

const POLICY_NOTE =
  'Restore scope is FLOOR PLUS AMBIGUOUS. The ambiguous band is included by a POLICY CHOICE ' +
  'made by the operator on an asymmetry argument (a wrongly-restored duplicate stays re-mergeable ' +
  'through its retained SAME_AS edge; a wrongly-withheld false positive is lost permanently). ' +
  'The total is a policy choice, not a measured recoverable count — nothing measured says the ' +
  'ambiguous band is recoverable. Components classified TRUE-DUPLICATE stay collapsed.';

// ── Store-side helpers ────────────────────────────────────────────────────────

interface StoreNode {
  rowid: number;
  uid: string;
  t_invalid: string | null;
  meta: string | null;
}

/**
 * Union-find over LIVE INFERRED `SAME_AS` edges only.
 *
 * `origin = 'inferred'` is load-bearing: a `user_asserted` SAME_AS edge is a
 * MANUAL merge (`merge_duplicates`), i.e. recorded intent. An automatic pass
 * must not reverse intent, which is the symmetric form of the argument that
 * removed automatic invalidation in the first place.
 */
async function buildLivePartition(
  adapter: StoreAdapter,
  interestedUids: string[],
): Promise<{
  parentOf: Map<string, string>;
  membersOfRoot: Map<string, string[]>;
  nodes: Map<string, StoreNode>;
}> {
  const { rows: edges } = await adapter.executeAll<{ a: string; b: string }>(
    `SELECT ns.uid AS a, nd.uid AS b
       FROM edge e
       JOIN node ns ON ns.rowid = e.src
       JOIN node nd ON nd.rowid = e.dst
      WHERE e.rel = 'SAME_AS'
        AND e.origin = 'inferred'
        AND e.t_invalid IS NULL
        AND e.t_expired IS NULL`,
  );

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = parent.get(x) ?? x;
    while (r !== (parent.get(r) ?? r)) r = parent.get(r) ?? r;
    let c = x;
    while (c !== r) {
      const nxt = parent.get(c) ?? c;
      parent.set(c, r);
      c = nxt;
    }
    return r;
  };
  const union = (x: string, y: string): void => {
    const rx = find(x);
    const ry = find(y);
    if (rx === ry) return;
    // Deterministic, content-free merge order: lexicographic on uid. NOT rowid,
    // NOT insertion order — both are creation-order proxies.
    if (rx < ry) parent.set(ry, rx);
    else parent.set(rx, ry);
  };

  for (const e of edges) {
    if (!parent.has(e.a)) parent.set(e.a, e.a);
    if (!parent.has(e.b)) parent.set(e.b, e.b);
    union(e.a, e.b);
  }

  const parentOf = new Map<string, string>();
  for (const uid of parent.keys()) parentOf.set(uid, find(uid));

  // Root -> members, built ONCE. Recomputing this per component was O(components
  // x store) and is why the plan used to scale badly.
  const membersOfRoot = new Map<string, string[]>();
  for (const [uid, root] of parentOf) {
    const bucket = membersOfRoot.get(root);
    if (bucket) bucket.push(uid);
    else membersOfRoot.set(root, [uid]);
  }
  for (const bucket of membersOfRoot.values()) bucket.sort();

  // Load ONLY the rows this run can possibly touch — the report's members plus
  // everything union-find attached to them. `SELECT ... FROM node` with no
  // predicate pulled every row (content-free columns, but still every row and
  // its meta blob) and does not scale past this incident's store size.
  const wanted = new Set<string>(interestedUids);
  for (const uid of interestedUids) {
    const root = parentOf.get(uid);
    if (!root) continue;
    for (const m of membersOfRoot.get(root) ?? []) wanted.add(m);
  }

  const nodes = new Map<string, StoreNode>();
  const all = [...wanted].sort();
  for (let i = 0; i < all.length; i += 400) {
    const chunk = all.slice(i, i + 400);
    const ph = chunk.map(() => '?').join(',');
    const { rows } = await adapter.executeAll<StoreNode>(
      `SELECT n.rowid AS rowid, n.uid AS uid, n.t_invalid AS t_invalid, n.meta AS meta
         FROM node n WHERE n.uid IN (${ph})`,
      chunk,
    );
    for (const r of rows) nodes.set(r.uid, r);
  }

  return { parentOf, membersOfRoot, nodes };
}

/** uids that are superseded by a live SUPERSEDES edge — recorded human intent. */
async function supersededUids(adapter: StoreAdapter): Promise<Set<string>> {
  const { rows } = await adapter.executeAll<{ uid: string }>(
    `SELECT n.uid AS uid
       FROM edge e JOIN node n ON n.rowid = e.dst
      WHERE e.rel = 'SUPERSEDES' AND e.t_invalid IS NULL AND e.t_expired IS NULL`,
  );
  return new Set(rows.map((r) => r.uid));
}

/** §1.4 blind spot, measured on every call rather than quoted from the report. */
async function edgelessInvalidatedEpisodes(adapter: StoreAdapter): Promise<number> {
  const row = await adapter.executeGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM node n
      WHERE n.t_invalid IS NOT NULL AND n.kind = 'episode'
        AND NOT EXISTS (
          SELECT 1 FROM edge e WHERE e.rel = 'SAME_AS' AND (e.src = n.rowid OR e.dst = n.rowid)
        )`,
  );
  return row?.c ?? 0;
}

export interface IntegrityVerdict {
  /** True when nothing the shared classifier calls DAMAGE was reported. */
  ok: boolean;
  /** Human-readable reason when not ok; null when ok. */
  detail: string | null;
  /** Raw lines classified as real damage — never suppressed. */
  damage: string[];
  /** Documented-benign lines: the Turso FTS directory count mismatch
   *  (turso#7611) and `Page N: …` reclaimable-space noise. Reported, not
   *  counted against the gate. */
  suppressed: string[];
  /** The driver version the suppression was measured against. */
  suppression_valid_for: string;
  /** PRAGMA integrity_check caps its own output; true means "clean as far as
   *  we could see", which this gate treats as NOT ok. */
  truncated: boolean;
}

/**
 * §6.7 precondition. Real damage makes every count this op verifies
 * untrustworthy, so APPLY is refused while damage is present. Dry run is
 * always allowed — an operator has to be able to see the plan on the store
 * they are about to repair.
 *
 * MEASURED, and why this does NOT just test for the literal string 'ok':
 * Turso's `integrity_check` reports
 * `wrong # of entries in index __turso_internal_fts_dir_<idx>_key` on a
 * freshly created, fully working FTS index (turso#7611, still reproducing on
 * the installed 0.7.1 driver). Every store this op will ever run against
 * carries an FTS index, so a literal 'ok' test would make
 * `allow_integrity_failure: true` MANDATORY for every apply — which trains an
 * operator to pass a bypass-the-corruption-check flag as routine, and makes
 * the gate worthless on the day there is real damage. The classification is
 * delegated to the store-adapter's `classifyIntegrityMessages`, the single
 * source of truth for it.
 */
export async function checkIntegrity(adapter: StoreAdapter): Promise<IntegrityVerdict> {
  // Lazy value import — see the type-only import note at the top of this file.
  const { classifyIntegrityMessages, SUPPRESSION_VALID_FOR } = await import(
    '@adhd/sox-store-adapter'
  );
  const base = {
    damage: [] as string[],
    suppressed: [] as string[],
    suppression_valid_for: SUPPRESSION_VALID_FOR,
    truncated: false,
  };
  let values: string[];
  try {
    const { rows } = await adapter.executeAll<Record<string, unknown>>(`PRAGMA integrity_check`);
    // Normalisation IDENTICAL to probeIntegrityCheck (integrity.ts:2435-2440),
    // deliberately: a divergent one classifies a multi-line pragma value as a
    // single blob and treats the `*** in database ...` banner as DAMAGE, which
    // would spuriously block an apply. Same reason the classifier itself is
    // imported rather than re-derived.
    values = rows
      .flatMap((r) => Object.values(r))
      .filter((v): v is string => typeof v === 'string')
      .flatMap((v) => v.split('\n'))
      .map((v) => v.trim())
      .filter((v) => v.length > 0 && v !== 'ok' && !v.startsWith('*** in database'));
  } catch (err) {
    return {
      ...base,
      ok: false,
      detail: `integrity_check failed: ${(err as Error).message}`,
      damage: [`integrity_check failed: ${(err as Error).message}`],
    };
  }

  // Classify the FULL raw list — never a slice. A second cap applied before
  // classification is how benign noise blinds the probe
  // (BUG-INTEGRITY-CHECK-BLINDED-BY-PAGE-NOISE-001).
  const { damage, knownFalsePositives, pageAccounting, truncated } =
    classifyIntegrityMessages(values);
  const suppressed = [...knownFalsePositives, ...pageAccounting];

  if (damage.length > 0) {
    return { ok: false, detail: damage.join('; '), damage, suppressed, truncated,
      suppression_valid_for: SUPPRESSION_VALID_FOR };
  }
  if (truncated) {
    return {
      ok: false,
      detail:
        'integrity_check output hit its message cap — clean as far as we could see is not clean',
      damage, suppressed, truncated, suppression_valid_for: SUPPRESSION_VALID_FOR,
    };
  }
  return { ok: true, detail: null, damage, suppressed, truncated,
    suppression_valid_for: SUPPRESSION_VALID_FOR };
}

// ── Classification → policy band ──────────────────────────────────────────────

/**
 * The triage's four-way class folded onto the operator's three-way policy.
 * PARENT-CHUNK splits: DERIVED_FROM-confirmed components are the measured
 * floor (an edge proves the pair is a document and its own chunk); shape-only
 * ones rest on a containment/jaccard/len_ratio signature and belong with the
 * ambiguous band. That distinction is a proof-vs-hypothesis boundary and is
 * carried through to `meta.restoredFrom.derived_from_confirmed`.
 */
export function policyBandFor(cls: string, derivedFromConfirmed: boolean): PolicyBand {
  const c = cls.toUpperCase();
  if (c === 'TRUE-DUPLICATE') return 'WITHHELD_TRUE_DUPLICATE';
  if (c === 'FALSE-POSITIVE') return 'FLOOR';
  if (c === 'PARENT-CHUNK') return derivedFromConfirmed ? 'FLOOR' : 'POLICY_AMBIGUOUS';
  return 'POLICY_AMBIGUOUS';
}

function metricsOf(p: ReportPair): LexicalMetrics {
  return {
    jaccard: p.jaccard ?? 0,
    lcs_norm: p.lcs_norm ?? 0,
    containment: p.containment ?? 0,
    len_ratio: p.len_ratio ?? 0,
  };
}

/**
 * The decisive pair for a member = its highest-Jaccard pair. Purely lexical,
 * and used only to decide WHICH metric row is recorded as provenance — never
 * to decide whether to restore (that is the component's class) and never to
 * rank members against each other.
 */
function decisiveMetrics(pairs: Array<{ metrics: LexicalMetrics }>): LexicalMetrics | null {
  if (pairs.length === 0) return null;
  let best = pairs[0]!;
  for (const p of pairs) if (p.metrics.jaccard > best.metrics.jaccard) best = p;
  return best.metrics;
}

function deepMergeMeta(existing: string | null, restoredFrom: unknown): string {
  let base: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed meta is preserved under a rescue key rather than dropped:
      // this op must never destroy a field it did not author.
      base = { _meta_unparsed: existing };
    }
  }
  return JSON.stringify({ ...base, restoredFrom });
}

function hasRestoredFrom(meta: string | null): boolean {
  if (!meta) return false;
  try {
    const parsed = JSON.parse(meta) as Record<string, unknown>;
    return parsed !== null && typeof parsed === 'object' && 'restoredFrom' in parsed;
  } catch {
    return false;
  }
}

/**
 * `report_path` is a FILE READ from a parameter on the same tool surface whose
 * `db_path` is confined to `~/.memory/**` by the permission guard. An
 * unrestricted read there is a disclosure channel regardless of what the op
 * does with the bytes, so it gets the same treatment:
 *
 *  - absolute paths only, symlinks resolved BEFORE the prefix test (a symlink
 *    inside the allowlist pointing out of it is the obvious bypass),
 *  - confined to `~/.memory/` by default; additional roots must be granted
 *    deliberately through `SOX_RESTORE_REPORT_ROOTS` (colon-separated),
 *  - `.json` only, and capped at REPORT_MAX_BYTES,
 *  - every rejection returns a FIXED message — never the path it probed, never
 *    an errno, never the parser's snippet of file contents.
 */
const REPORT_MAX_BYTES = 32 * 1024 * 1024;

function reportRoots(): string[] {
  const roots = [path.join(os.homedir(), '.memory')];
  const extra = process.env['SOX_RESTORE_REPORT_ROOTS'];
  if (extra) {
    for (const r of extra.split(':')) {
      const t = r.trim();
      if (t.length > 0) roots.push(path.resolve(expandTilde(t)));
    }
  }
  return roots;
}

export function resolveReportPath(
  candidate: string,
): { path: string } | RestoreNeardupError {
  const denied: RestoreNeardupError = {
    code: 'E_REPORT_PATH_DENIED',
    op: 'restore_neardup',
    message:
      'report_path is outside the allowed roots, is not an absolute .json path, or exceeds the ' +
      'size cap. Allowed: ~/.memory/**, plus any root granted via SOX_RESTORE_REPORT_ROOTS.',
  };
  const expanded = path.resolve(expandTilde(candidate));
  if (!path.isAbsolute(expanded) || !expanded.toLowerCase().endsWith('.json')) return denied;

  let real: string;
  let stat: fs.Stats;
  try {
    real = fs.realpathSync(expanded);
    stat = fs.statSync(real);
  } catch {
    return denied;
  }
  if (!stat.isFile() || stat.size > REPORT_MAX_BYTES) return denied;

  const ok = reportRoots().some((root) => {
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      realRoot = root;
    }
    return real === realRoot || real.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep);
  });
  return ok ? { path: real } : denied;
}


// ── Reverse mode ──────────────────────────────────────────────────────────────

export interface CurateRestoreNeardupReverseResult {
  op: 'restore_neardup';
  mode: 'reverse';
  dry_run: boolean;
  /** The run being reversed: its report sha256, or null for "every run". */
  report_sha256: string | null;
  /** Same gate as the forward path — reversal is the same class of mutation
   *  with MORE blast radius per row (node + MEMBER_OF edges + communities). */
  integrity: IntegrityVerdict & { override: boolean };
  rows_matched: number;
  rows_reinvalidated: number;
  member_of_edges_invalidated: number;
  communities_invalidated: number;
  uids: string[];
  note: string;
}

/**
 * The supported reversal. NOT just the `UPDATE`: the ORIGINAL invalidation ran
 * `gcOrphanedCommunityState` (community-gc.ts), which invalidates the episode's
 * live `MEMBER_OF` edges and any community thereby left with zero live members.
 * A bare `UPDATE ... SET t_invalid = prior` re-invalidates the node while
 * leaving those edges and communities live — re-creating the very
 * 139-communities / 0-members orphan leak that module exists to prevent, and
 * the exact leak the forward path avoids by enqueueing a full enrich.
 *
 * So reversal re-invalidates and GCs in the SAME transaction, per row, exactly
 * as `memoryInvalidate` and `merge_duplicates` do.
 */
export async function curateRestoreNeardupReverse(
  adapter: StoreAdapter,
  args: Record<string, unknown>,
): Promise<CurateRestoreNeardupReverseResult | RestoreNeardupError> {
  const dryRun = args['dry_run'] !== false;
  let sha: string | null = null;
  if (typeof args['report_sha256'] === 'string') sha = args['report_sha256'];
  else if (typeof args['report_path'] === 'string') {
    const guard = resolveReportPath(args['report_path']);
    if ('code' in guard) return guard;
    try {
      sha = crypto.createHash('sha256').update(fs.readFileSync(guard.path)).digest('hex');
    } catch {
      return {
        code: 'E_REPORT_UNREADABLE',
        op: 'restore_neardup',
        message: 'triage report could not be read (missing, unreadable, or not a regular file).',
      };
    }
  } else if (args['all_runs'] !== true) {
    return {
      code: 'E_MISSING',
      op: 'restore_neardup',
      message:
        'reverse needs report_sha256 (or report_path) to identify WHICH run to undo. ' +
        'Pass all_runs: true to reverse every restore_neardup run this store has ever seen.',
    };
  }

  // The forward path refuses to APPLY on real damage; reversal is the same
  // class of mutation and gets the same gate, recorded the same way. Benign
  // driver artifacts are suppressed by the shared classifier, so this is not a
  // routine keystroke either.
  const revCheck = await checkIntegrity(adapter);
  const integrity = {
    ...revCheck,
    override: !revCheck.ok && args['allow_integrity_failure'] === true,
  };
  if (!dryRun && !integrity.ok && args['allow_integrity_failure'] !== true) {
    return {
      code: 'E_INTEGRITY_NOT_OK',
      op: 'restore_neardup',
      message:
        `integrity_check reported REAL damage (${integrity.detail ?? 'unknown'}). A reversal ` +
        're-invalidates rows AND invalidates their MEMBER_OF edges and empty communities, so it ' +
        'is gated exactly like an apply. dry_run remains available; allow_integrity_failure: ' +
        'true forces it and records the verdict on the result.',
    };
  }

  const where =
    `json_extract(meta, '$.restoredFrom.op') = 'restore_neardup' AND t_invalid IS NULL` +
    (sha === null ? '' : ` AND json_extract(meta, '$.restoredFrom.report.sha256') = ?`);
  const params = sha === null ? [] : [sha];

  const { rows } = await adapter.executeAll<{ rowid: number; uid: string; prior: string | null }>(
    `SELECT rowid, uid, json_extract(meta, '$.restoredFrom.prior_t_invalid') AS prior
       FROM node WHERE ${where} ORDER BY uid`,
    params,
  );

  const note =
    'Reversal re-invalidates each row to the exact prior_t_invalid recorded on it AND runs ' +
    'gcOrphanedCommunityState in the same transaction, so no live MEMBER_OF edge or empty ' +
    'community is left behind. meta.restoredFrom is retained as the audit trail; re-applying ' +
    'the restore afterwards requires allow_rerestore: true.';

  if (dryRun) {
    return {
      op: 'restore_neardup',
      mode: 'reverse',
      dry_run: true,
      report_sha256: sha,
      integrity,
      rows_matched: rows.length,
      rows_reinvalidated: 0,
      member_of_edges_invalidated: 0,
      communities_invalidated: 0,
      uids: rows.map((r) => r.uid),
      note,
    };
  }

  let reinvalidated = 0;
  let edges = 0;
  let communities = 0;
  await adapter.transaction(async (tx) => {
    for (const r of rows) {
      if (r.prior === null) continue; // nothing recorded to restore to — leave it live
      const res = await tx.executeRun(
        `UPDATE node SET t_invalid = ? WHERE uid = ? AND t_invalid IS NULL`,
        [r.prior, r.uid],
      );
      if (res.rowsAffected !== 1) continue;
      reinvalidated += 1;
      const gc = await gcOrphanedCommunityState(tx, r.rowid, r.prior);
      edges += gc.member_of_edges_invalidated;
      communities += gc.communities_invalidated;
    }
  }, { mode: 'immediate' });

  return {
    op: 'restore_neardup',
    mode: 'reverse',
    dry_run: false,
    report_sha256: sha,
    integrity,
    rows_matched: rows.length,
    rows_reinvalidated: reinvalidated,
    member_of_edges_invalidated: edges,
    communities_invalidated: communities,
    uids: rows.map((r) => r.uid),
    note,
  };
}

// ── The op ────────────────────────────────────────────────────────────────────

export async function curateRestoreNeardup(
  adapter: StoreAdapter,
  args: Record<string, unknown>,
): Promise<CurateRestoreNeardupResult | CurateRestoreNeardupReverseResult | RestoreNeardupError> {
  // The reversal is part of THIS op, not a bare SQL statement a human pastes:
  // it has to GC community state in the same transaction (see
  // curateRestoreNeardupReverse). `dry_run` defaults to TRUE there too.
  if (args['reverse'] === true) return await curateRestoreNeardupReverse(adapter, args);

  // DRY RUN DEFAULTS TO TRUE — the inverse of every other curate op. A caller
  // must opt IN to mutation with an explicit `dry_run: false`. This is decided
  // here rather than in the dispatcher precisely so the other ops' contracts
  // are untouched.
  const dryRun = args['dry_run'] !== false;

  const reportPath = typeof args['report_path'] === 'string' ? args['report_path'] : undefined;
  const blId = typeof args['bl_id'] === 'string' ? args['bl_id'] : null;
  const batchSize = Math.max(1, Number(args['batch_size'] ?? 50));
  const allowRerestore = args['allow_rerestore'] === true;
  const allowIntegrityFailure = args['allow_integrity_failure'] === true;
  // A live SUPERSEDES edge onto a node is recorded human intent
  // (`memory_invalidate` with a replacement). Those nodes are withheld by
  // default — an automatic pass must not reverse an intentional invalidation.
  // Measured on the triage copy: 3 of the 607 policy-scope members carry one.
  // The override exists so an operator can act on them deliberately; it is
  // recorded per row.
  const restoreSuperseded = args['restore_superseded'] === true;
  const componentFilter = Array.isArray(args['component_ids'])
    ? new Set((args['component_ids'] as unknown[]).map((n) => Number(n)))
    : null;

  if (!reportPath && !dryRun) {
    return {
      code: 'E_MISSING',
      op: 'restore_neardup',
      message:
        'report_path is required to APPLY restore_neardup — the triage report is the decision ' +
        'input and its sha256 is recorded in meta.restoredFrom. dry_run may omit it.',
    };
  }

  let report: TriageReport = { components: [] };
  let reportMeta: { path: string; sha256: string } | null = null;
  if (reportPath) {
    const guard = resolveReportPath(reportPath);
    if ('code' in guard) return guard;
    const resolved = guard.path;
    let raw: Buffer;
    try {
      raw = fs.readFileSync(resolved);
    } catch {
      // Fixed message: the thrown error embeds the path and errno detail of
      // whatever was probed, which is a disclosure channel of its own.
      return {
        code: 'E_REPORT_UNREADABLE',
        op: 'restore_neardup',
        message: 'triage report could not be read (missing, unreadable, or not a regular file).',
      };
    }
    try {
      report = JSON.parse(raw.toString('utf8')) as TriageReport;
    } catch {
      // NEVER surface the parser's message: Node's JSON.parse error embeds a
      // snippet of the offending input, which would turn a malformed-file
      // response into an arbitrary-file-contents read.
      return {
        code: 'E_REPORT_MALFORMED',
        op: 'restore_neardup',
        message: 'triage report is not valid JSON.',
      };
    }
    if (!Array.isArray(report.components)) {
      return {
        code: 'E_REPORT_MALFORMED',
        op: 'restore_neardup',
        message: 'triage report has no `components` array',
      };
    }
    reportMeta = { path: resolved, sha256: crypto.createHash('sha256').update(raw).digest('hex') };
  }

  // §6.7 precondition. Documented-benign driver artifacts (the turso#7611 FTS
  // directory count mismatch, `Page N: …` free-space noise) are SUPPRESSED by
  // the shared classifier and do not block — see checkIntegrity for why a
  // literal 'ok' test would reduce the override to a routine keystroke. Real
  // damage still blocks by default, and crossing it requires an explicit,
  // RECORDED operator decision: the override is written into every restored
  // row's provenance, so it is never silent.
  const integrityCheck = await checkIntegrity(adapter);
  const integrity = { ...integrityCheck, override: !integrityCheck.ok && allowIntegrityFailure };
  if (!dryRun && !integrity.ok && !allowIntegrityFailure) {
    return {
      code: 'E_INTEGRITY_NOT_OK',
      op: 'restore_neardup',
      message:
        `integrity_check reported REAL damage (${integrity.detail ?? 'unknown'}). ` +
        'Documented-benign driver artifacts are already suppressed, so this is not the ' +
        'turso#7611 FTS false positive. Repair the store and take a verified `VACUUM INTO` ' +
        'snapshot before applying a restore; dry_run remains available. ' +
        'allow_integrity_failure: true forces the run anyway and records the decision and the ' +
        'exact damage in meta.restoredFrom.integrity_at_restore on every restored row.',
    };
  }

  // Deterministic order: report component id, then uid. Never row order.
  const reportComponents = [...report.components]
    .filter((c) => (componentFilter ? componentFilter.has(Number(c.comp)) : true))
    .sort((x, y) => Number(x.comp) - Number(y.comp));

  const interested = [
    ...new Set(reportComponents.flatMap((c) => c.members.map((m) => m.uid))),
  ].sort();
  const { parentOf, membersOfRoot, nodes } = await buildLivePartition(adapter, interested);
  const superseded = await supersededUids(adapter);
  const edgeless = await edgelessInvalidatedEpisodes(adapter);
  const at = new Date().toISOString();

  const plans: RestoreComponentPlan[] = [];
  const halted: string[] = [];

  for (const rc of reportComponents) {
    const reportMembers = rc.members.map((m) => m.uid).sort();
    const derivedFromConfirmed =
      (rc.derivedFromPairs ?? 0) > 0 || (rc.pairs ?? []).some((p) => p.derived_from === true);
    const band = policyBandFor(rc.cls, derivedFromConfirmed);
    const eligible = band !== 'WITHHELD_TRUE_DUPLICATE';

    // Store-side membership of the component these uids currently belong to.
    const roots = new Set<string>();
    for (const uid of reportMembers) {
      const r = parentOf.get(uid);
      if (r) roots.add(r);
    }
    const storeMembers = [...roots]
      .sort()
      .flatMap((root) => membersOfRoot.get(root) ?? [])
      .sort();

    const membersOnEdge = new Set(storeMembers);
    const membershipMatches =
      storeMembers.length === reportMembers.length &&
      storeMembers.every((u, i) => u === reportMembers[i]);

    const members: RestoreMemberPlan[] = reportMembers.map((uid) => {
      const pairs = (rc.pairs ?? [])
        .filter((p) => p.a === uid || p.b === uid)
        .map((p) => ({
          with: p.a === uid ? p.b : p.a,
          metrics: metricsOf(p),
          derived_from: p.derived_from === true,
        }))
        .sort((x, y) => (x.with < y.with ? -1 : x.with > y.with ? 1 : 0));
      const node = nodes.get(uid);

      // ORDER IS LOAD-BEARING. `parentOf` is built ONLY from live inferred
      // SAME_AS edges, so a member lacking one is never in `storeMembers` and
      // therefore always fails `membershipMatches` too. Testing membership
      // first made `no_live_inferred_same_as` unreachable dead code and its
      // counter permanently 0 — while the test named for that invariant still
      // passed, because the node was skipped for the OTHER reason. The
      // structural guard (§6 invariant 2) is the more specific fact, so it is
      // reported first and the counter means what it says.
      let action: MemberAction;
      if (!node) action = 'not_found';
      else if (node.t_invalid === null) action = 'already_live';
      else if (!membersOnEdge.has(uid)) action = 'no_live_inferred_same_as';
      else if (!membershipMatches) action = 'skipped_membership_divergence';
      else if (!eligible) action = 'withheld_true_duplicate';
      else if (superseded.has(uid) && !restoreSuperseded) action = 'intent_superseded';
      else if (hasRestoredFrom(node.meta) && !allowRerestore) action = 'reinvalidated_after_restore';
      else action = 'restore';

      if (action === 'reinvalidated_after_restore') halted.push(uid);

      return {
        uid,
        action,
        prior_t_invalid: node?.t_invalid ?? null,
        metrics: decisiveMetrics(pairs),
        pairs,
      };
    });

    let status: ComponentStatus;
    if (!membershipMatches) status = 'membership_divergence';
    else if (!eligible) status = 'withheld_true_duplicate';
    else if (members.some((m) => m.action === 'reinvalidated_after_restore')) status = 'halted_reinvalidated';
    else if (members.some((m) => m.action === 'restore')) status = 'planned';
    else if (members.some((m) => m.prior_t_invalid !== null)) status = 'all_members_withheld_by_guard';
    else status = 'no_invalidated_members';

    plans.push({
      component_id: Number(rc.comp),
      class: rc.cls,
      policy_band: band,
      derived_from_confirmed: derivedFromConfirmed,
      eligible,
      status,
      report_members: reportMembers,
      store_members: storeMembers,
      members,
    });
  }

  // A node that is invalid AND already carries `restoredFrom` means something
  // re-invalidated a restored row — i.e. the automatic pass is still live and
  // §6 invariant 6 (ordering) is violated. Re-restoring would start a loop, so
  // the run halts and reports instead. `allow_rerestore: true` is the operator
  // override, and is what makes a deliberate REVERSAL re-appliable.
  //                                     ^ apply only. A dry run must still be
  // readable in this state — the same principle as the integrity gate: an
  // operator has to be able to SEE the plan on the store they are about to
  // repair, and requiring a mutation flag (allow_rerestore) in order to read
  // one is exactly backwards. The dry run surfaces the condition as
  // `summary.members_reinvalidated_after_restore` plus a component status.
  if (halted.length > 0 && !dryRun) {
    return {
      code: 'E_REINVALIDATED_AFTER_RESTORE',
      op: 'restore_neardup',
      uids: halted.sort(),
      message:
        `${halted.length} node(s) carry meta.restoredFrom and are invalidated again. Something ` +
        're-invalidated a restored row: confirm the automatic near-dup invalidation is removed ' +
        'from the RUNNING artifact before retrying. Pass allow_rerestore: true to override ' +
        '(this is also how a deliberate reversal is re-applied).',
    };
  }

  const countBy = (pred: (m: RestoreMemberPlan, c: RestoreComponentPlan) => boolean): number =>
    plans.reduce((n, c) => n + c.members.filter((m) => pred(m, c)).length, 0);

  const plannedMembers = countBy((m) => m.action === 'restore');
  const summary: CurateRestoreNeardupResult['summary'] = {
    components_in_report: plans.length,
    components_eligible: plans.filter((c) => c.status === 'planned').length,
    components_withheld_true_duplicate: plans.filter((c) => c.status === 'withheld_true_duplicate').length,
    components_membership_divergence: plans.filter((c) => c.status === 'membership_divergence').length,
    components_all_members_withheld_by_guard: plans.filter(
      (c) => c.status === 'all_members_withheld_by_guard',
    ).length,
    members_restored: 0,
    members_planned: plannedMembers,
    members_floor: countBy((m, c) => m.action === 'restore' && c.policy_band === 'FLOOR'),
    members_policy_ambiguous: countBy(
      (m, c) => m.action === 'restore' && c.policy_band === 'POLICY_AMBIGUOUS',
    ),
    members_withheld_true_duplicate: plans
      .filter((c) => c.status === 'withheld_true_duplicate')
      .reduce((n, c) => n + c.members.filter((m) => m.prior_t_invalid !== null).length, 0),
    members_already_live: countBy((m) => m.action === 'already_live'),
    members_no_live_inferred_same_as: countBy((m) => m.action === 'no_live_inferred_same_as'),
    members_intent_superseded: countBy((m) => m.action === 'intent_superseded'),
    members_not_found: countBy((m) => m.action === 'not_found'),
    members_reinvalidated_after_restore: countBy(
      (m) => m.action === 'reinvalidated_after_restore',
    ),
    out_of_scope_edgeless_invalidated_episodes: edgeless,
    policy_scope_reconciliation: {
      planned: 0,
      floor: 0,
      policy_ambiguous: 0,
      withheld_intent_superseded: 0,
      policy_scope_members: 0,
      withheld_true_duplicate: 0,
      same_as_population: 0,
      out_of_scope_edgeless: edgeless,
    },
  };
  summary.policy_scope_reconciliation = {
    planned: summary.members_planned,
    floor: summary.members_floor,
    policy_ambiguous: summary.members_policy_ambiguous,
    withheld_intent_superseded: summary.members_intent_superseded,
    policy_scope_members: summary.members_planned + summary.members_intent_superseded,
    withheld_true_duplicate: summary.members_withheld_true_duplicate,
    same_as_population:
      summary.members_planned +
      summary.members_intent_superseded +
      summary.members_withheld_true_duplicate,
    out_of_scope_edgeless: edgeless,
  };
  const r = summary.policy_scope_reconciliation;
  const headline =
    `PLANNED ${r.planned} of ${r.policy_scope_members} policy-scope members ` +
    `(${r.floor} floor + ${r.policy_ambiguous} policy-ambiguous). ` +
    (r.withheld_intent_superseded > 0
      ? `${r.withheld_intent_superseded} WITHHELD: each carries a live SUPERSEDES edge — recorded ` +
        'human intent, which an automatic pass must not reverse. Pass restore_superseded: true to ' +
        'include them deliberately (recorded per row). '
      : '') +
    `${r.withheld_true_duplicate} TRUE-DUPLICATE members stay collapsed. ` +
    `${r.out_of_scope_edgeless} invalidated episodes carry NO SAME_AS edge and are OUT OF SCOPE — ` +
    'a component-wise restore cannot see them, so this run is NOT "everything recovered". ' +
    `The ${r.policy_scope_members}-member scope is a POLICY CHOICE, not a measured recoverable count.`;

  const result: CurateRestoreNeardupResult = {
    op: 'restore_neardup',
    dry_run: dryRun,
    report: reportMeta,
    integrity,
    headline,
    policy: {
      scope: 'floor_plus_ambiguous',
      floor_plus_ambiguous: true,
      withholds: 'TRUE-DUPLICATE',
      note: POLICY_NOTE,
    },
    summary,
    components: plans,
    batches: [],
    enrich_enqueued_seq: null,
    reversal: {
      sql:
        "UPDATE node SET t_invalid = json_extract(meta, '$.restoredFrom.prior_t_invalid') " +
        "WHERE json_extract(meta, '$.restoredFrom.op') = 'restore_neardup' AND t_invalid IS NULL",
      scoped_sql:
        reportMeta === null
          ? null
          : "UPDATE node SET t_invalid = json_extract(meta, '$.restoredFrom.prior_t_invalid') " +
            "WHERE json_extract(meta, '$.restoredFrom.op') = 'restore_neardup' AND t_invalid IS NULL " +
            `AND json_extract(meta, '$.restoredFrom.report.sha256') = '${reportMeta.sha256}'`,
      note:
        'PREFERRED: memory_curate {op:"restore_neardup", reverse:true, report_sha256:"<sha>", ' +
        'dry_run:false} — it re-invalidates AND runs gcOrphanedCommunityState in the same ' +
        'transaction. The raw statements below do NOT: they leave live MEMBER_OF edges and ' +
        'zero-member communities behind (the 139-communities/0-members orphan leak), so use ' +
        'them only for inspection, or when you will GC separately. scoped_sql is pinned to this ' +
        'run\'s report sha256; sql reverses EVERY restore_neardup run this store has ever seen. ' +
        'Either way meta.restoredFrom is retained as the audit trail, and re-applying afterwards ' +
        'requires allow_rerestore: true.',
    },
  };

  if (dryRun) return result;

  // ── Apply ───────────────────────────────────────────────────────────────────
  const actionable = plans.filter((c) => c.status === 'planned');
  let batchNo = 0;
  for (let i = 0; i < actionable.length; i += batchSize) {
    const slice = actionable.slice(i, i + batchSize);
    batchNo += 1;
    const targets = slice.flatMap((c) =>
      c.members
        .filter((m) => m.action === 'restore')
        .map((m) => ({ component: c, member: m })),
    );

    const notWritten: string[] = [];
    await adapter.transaction(async (tx) => {
      for (const { component, member } of targets) {
        // FIX: re-read meta INSIDE the transaction. The plan-time snapshot from
        // buildLivePartition is minutes old by the last batch; merging it back
        // clobbers any meta another writer set in between — a lost update on
        // the one field this op promises never to destroy. The serial
        // WriteQueue slot narrows that window; it does not close it (it
        // excludes the enrich tick, not every writer).
        const fresh = await tx.executeGet<{ meta: string | null }>(
          `SELECT meta FROM node WHERE uid = ? AND t_invalid IS NOT NULL`,
          [member.uid],
        );
        if (!fresh) {
          // Became live between plan and apply — someone else's write. Not ours
          // to claim, and NOT counted as restored.
          notWritten.push(member.uid);
          continue;
        }
        const restoredFrom = {
          op: 'restore_neardup',
          bl_id: blId,
          at,
          prior_t_invalid: member.prior_t_invalid,
          component_id: component.component_id,
          component_members: component.report_members,
          class: component.class,
          policy_band: component.policy_band,
          derived_from_confirmed: component.derived_from_confirmed,
          metrics: member.metrics,
          pairs: member.pairs,
          report: reportMeta,
          policy_note: POLICY_NOTE,
          integrity_at_restore: integrity,
          intent_superseded_override: superseded.has(member.uid),
        };
        const res = await tx.executeRun(
          `UPDATE node SET t_invalid = NULL, meta = ? WHERE uid = ? AND t_invalid IS NOT NULL`,
          [deepMergeMeta(fresh.meta, restoredFrom), member.uid],
        );
        // rowsAffected, not "the row looks right afterwards": a row someone
        // else made live satisfies a state check while carrying NO
        // meta.restoredFrom — and both reversal statements key on exactly that
        // field, so such a row would be silently UN-REVERSIBLE.
        if (res.rowsAffected !== 1) notWritten.push(member.uid);
      }
    }, { mode: 'immediate' });

    // §6 invariant 4, scoped to THIS batch's uid set rather than a store-global
    // count: a global `COUNT(*) WHERE t_invalid IS NOT NULL` moves under a
    // concurrent enrich tick or merge and would halt the run for no reason.
    // §6 invariant 4 verifies AUTHORSHIP, not state: every uid this batch
    // claims must be live AND carry a meta.restoredFrom stamped with THIS
    // run's `at`. Counting `t_invalid IS NULL` alone passes for a row made
    // live by someone else, which is the un-reversible case above.
    const uids = targets.map((t) => t.member.uid);
    let observed = 0;
    if (uids.length > 0) {
      const ph = uids.map(() => '?').join(',');
      const row = await adapter.executeGet<{ c: number }>(
        `SELECT COUNT(*) AS c FROM node
          WHERE uid IN (${ph})
            AND t_invalid IS NULL
            AND json_extract(meta, '$.restoredFrom.at') = ?`,
        [...uids, at],
      );
      observed = row?.c ?? 0;
    }
    const verified = observed === uids.length && notWritten.length === 0;
    result.batches.push({
      batch: batchNo,
      component_ids: slice.map((c) => c.component_id),
      expected_restored: uids.length,
      observed_restored: observed,
      verified,
    });
    if (!verified) {
      // Return the RESULT, not a bare error: the batches that DID land, their
      // component plans, and the scoped reversal statement are exactly what an
      // operator needs at this moment, and a bare `{code, message}` discards
      // all three. `code` is still set so the MCP layer reports isError.
      result.code = 'E_BATCH_VERIFICATION_FAILED';
      result.error = {
        code: 'E_BATCH_VERIFICATION_FAILED',
        batch: batchNo,
        expected: uids.length,
        observed,
        not_written: notWritten.sort(),
        message:
          `batch ${batchNo}: ${uids.length} node(s) were claimed, ${observed} carry this run's ` +
          `meta.restoredFrom stamp. The run halted. ${result.summary.members_restored} node(s) ` +
          'restored in earlier verified batches are recorded and reversible via ' +
          'result.reversal.scoped_sql; anything listed in not_written was NOT written and was ' +
          'NOT counted.',
      };
      return result;
    }
    result.summary.members_restored += uids.length;
  }

  // §6 invariant 5. The original invalidation ran gcOrphanedCommunityState, so
  // a restored node is live but community-orphaned. Enqueue a full enrich pass
  // rather than documenting the half-fix; the in-process periodic tick consumes
  // the trigger row (BL-186 — it is deliberately NOT run inline here).
  if (result.summary.members_restored > 0) {
    result.enrich_enqueued_seq = await enqueueEnrichFull(
      adapter,
      `restore_neardup:${result.summary.members_restored}`,
    );
  }

  return result;
}
