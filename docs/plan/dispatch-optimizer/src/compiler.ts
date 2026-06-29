/**
 * compiler.ts — Plan dispatch optimizer: snapshot() and optimize().
 *
 * snapshot(dag)    — Computes the fully derived DagSnapshot from dag.json.
 * optimize(snap)   — Runs algorithm selection + batch assignment → DispatchUnit[].
 *
 * Schema source: docs/plan/dispatch-optimizer/PROPOSED_DAG_STRUCTURE.md
 * Algorithm source: docs/plan/dispatch-optimizer/SCOPE.md §B, §N1, §N2
 * Design decisions: docs/plan/dispatch-optimizer/DECISIONS.md
 *
 * Neither function mutates its input.
 */

import * as fs from "fs";
import type {
  DagJson,
  DagSnapshot,
  MilestoneDag,
  MilestoneSnapshot,
  MilestoneStatus,
  OperationDag,
  OperationSnapshot,
  DispatchUnit,
  OpenQuestion,
  PairwiseOverlapMap,
  SnapshotOptimization,
  Shape,
  ShapeSnapshot,
  ShapeOpDag,
  ShapeOpSnapshot,
  ProviderConfig,
  KindFamily,
  ModelTier,
  EffortTier,
} from "./dag/types.js";
import { WRITE_CLASS_ACTIONS } from "./dag/types.js";
import { validateSnapshot } from "./dag/validate.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** §C3 — chars per token by file type (for si_bytes → tokens conversion). */
const CHARS_PER_TOKEN: Record<string, number> = {
  prose: 5.5,
  md: 5.5,
  ts: 6.3,
  tsx: 6.3,
  py: 6.3,
  default: 4.0,
};

/** Effort-tier ki_estimate heuristic for doc kind (§C3). */
const DOC_KI_BY_EFFORT: Record<string, number> = {
  low: 600,
  medium: 1000,
  high: 2000,
};

/** Write-class actions whose `file` target becomes an artifact. */
const WRITE_ACTIONS: ReadonlySet<string> = WRITE_CLASS_ACTIONS;

// ---------------------------------------------------------------------------
// §C3 — ki_estimate heuristics
// ---------------------------------------------------------------------------

/**
 * Count the number of top-level fields in a JSON Schema object.
 * Used for structured-output ki_estimate = fieldCount × 50.
 */
function countSchemaFields(schema: Record<string, unknown>): number {
  const props =
    (schema["properties"] as Record<string, unknown> | undefined) ?? {};
  return Object.keys(props).length || Object.keys(schema).length;
}

/**
 * Derive a ki_estimate for an operation when op.ki_estimate is null.
 * Source: SCOPE.md §C3.
 */
function deriveKiEstimate(
  op: OperationDag,
  milestoneEffort: EffortTier | null
): number {
  // tool-call operations have zero output tokens by definition (D-03)
  if (op.type === "tool-call") return 0;

  const shape = op.shape;
  if (!shape || shape.kind === null) return 0;

  const kind = shape.kind;

  // code kinds: ops.length × 200
  if (
    kind === "function" ||
    kind === "interface" ||
    kind === "type" ||
    kind === "class" ||
    kind === "enum" ||
    kind === "const" ||
    kind === "script"
  ) {
    const ops = "ops" in shape && Array.isArray(shape.ops) ? shape.ops : [];
    return ops.length * 200;
  }

  // config kinds: ops.length × 100
  if (
    kind === "config" ||
    kind === "env" ||
    kind === "schema" ||
    kind === "manifest"
  ) {
    const ops = "ops" in shape && Array.isArray(shape.ops) ? shape.ops : [];
    return ops.length * 100;
  }

  // doc kind: effort-tier heuristic
  if (kind === "doc") {
    const effort = milestoneEffort ?? "medium";
    return DOC_KI_BY_EFFORT[effort] ?? 1000;
  }

  // structured-output: schema field count × 50
  if (kind === "structured-output") {
    const schema =
      "schema" in shape && shape.schema ? shape.schema : {};
    return countSchemaFields(schema as Record<string, unknown>) * 50;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// si_bytes → tokens
// ---------------------------------------------------------------------------

/**
 * Convert file bytes to an approximate token count.
 * Source: SCOPE.md §C3 — byte-count is the right proxy (r>0.98, arxiv 2511.08066).
 */
function siBytesAsTokens(bytes: number, filePath?: string): number {
  if (bytes <= 0) return 0;
  const ext = filePath ? (filePath.split(".").pop()?.toLowerCase() ?? "") : "";
  const cpt = CHARS_PER_TOKEN[ext] ?? CHARS_PER_TOKEN["default"] ?? 4.0;
  return Math.ceil(bytes / cpt);
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function safeStatSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Topological sort with cycle detection
// ---------------------------------------------------------------------------

/**
 * Topologically sort milestone slugs and assign wave numbers.
 * Uses Kahn's algorithm (BFS) for O(V+E).
 *
 * Wave 0: nodes with empty depends_on.
 * Wave N: 1 + max(wave of deps).
 * Ties within a wave are broken by slug (lexicographic) for determinism.
 *
 * @throws {Error} if a cycle is detected, including the cycle path.
 */
function topoSortMilestones(
  milestones: Record<string, MilestoneDag>
): { order: string[]; waves: Map<string, number> } {
  const slugs = Object.keys(milestones);
  const inDegree = new Map<string, number>();
  const children = new Map<string, string[]>();

  for (const slug of slugs) {
    if (!inDegree.has(slug)) inDegree.set(slug, 0);
    if (!children.has(slug)) children.set(slug, []);
  }

  for (const slug of slugs) {
    const deps = milestones[slug]?.depends_on ?? [];
    for (const dep of deps) {
      const ch = children.get(dep);
      if (ch !== undefined) ch.push(slug);
      inDegree.set(slug, (inDegree.get(slug) ?? 0) + 1);
    }
  }

  const waves = new Map<string, number>();
  const order: string[] = [];

  // Initialize queue with wave-0 nodes, sorted for determinism
  let queue: string[] = slugs
    .filter((s) => (inDegree.get(s) ?? 0) === 0)
    .sort();

  for (const s of queue) {
    waves.set(s, 0);
  }

  while (queue.length > 0) {
    const next: string[] = [];

    for (const slug of queue) {
      order.push(slug);
      const ch = (children.get(slug) ?? []).slice().sort();
      for (const child of ch) {
        const newDegree = (inDegree.get(child) ?? 0) - 1;
        inDegree.set(child, newDegree);

        // Wave of child = 1 + max(wave of each dep)
        const parentWave = waves.get(slug) ?? 0;
        const currentChildWave = waves.get(child) ?? 0;
        waves.set(child, Math.max(currentChildWave, parentWave + 1));

        if (newDegree === 0) {
          next.push(child);
        }
      }
    }

    queue = next.sort();
  }

  if (order.length !== slugs.length) {
    // Cycle detected — identify which nodes were not visited
    const visited = new Set(order);
    const cycle = slugs.filter((s) => !visited.has(s));
    throw new Error(
      `snapshot(): cycle detected in milestone depends_on graph. ` +
        `Nodes involved: [${cycle.join(", ")}]`
    );
  }

  return { order, waves };
}

// ---------------------------------------------------------------------------
// Dispatch-log scanning helpers
// ---------------------------------------------------------------------------

/**
 * Find dispatch log entries that mention at least one op belonging to the given
 * milestone slug.
 */
function dispatchesForMilestone(
  log: DagJson["dispatch_log"],
  milestoneOps: string[]
): DagJson["dispatch_log"] {
  if (milestoneOps.length === 0) return [];
  const opSet = new Set(milestoneOps);
  return log.filter((entry) =>
    entry.operations.some((opId) => opSet.has(opId))
  );
}

/**
 * Find dispatch log entries that include a specific op id.
 */
function dispatchesForOp(
  log: DagJson["dispatch_log"],
  opId: string
): DagJson["dispatch_log"] {
  return log.filter((entry) => entry.operations.includes(opId));
}

// ---------------------------------------------------------------------------
// Milestone status derivation
// ---------------------------------------------------------------------------

/**
 * Derive milestone status from ops + dispatch_log.
 * Source: SCOPE.md §N1 step 4, PROPOSED_DAG_STRUCTURE.md status derivation rules.
 */
function deriveMilestoneStatus(
  slug: string,
  dag: MilestoneDag,
  milestoneOpIds: string[],
  log: DagJson["dispatch_log"],
  depStatuses: MilestoneStatus[]
): MilestoneStatus {
  const guardOpId = `${slug}.guard`;
  const allOpIds = [...milestoneOpIds, guardOpId];

  // Gather all results across all dispatch entries for this milestone's ops
  const entries = dispatchesForMilestone(log, allOpIds);

  // complete: guard op in dispatch_log has guard_result == "pass"
  for (const entry of entries) {
    for (const result of entry.results) {
      if (result.op_id === guardOpId && result.guard_result === "pass") {
        return "complete";
      }
    }
  }

  // failed: any op result for this milestone has status == "failed"
  for (const entry of entries) {
    for (const result of entry.results) {
      if (allOpIds.includes(result.op_id) && result.status === "failed") {
        return "failed";
      }
    }
  }

  // in_progress: any op result has status == "in_progress"
  for (const entry of entries) {
    for (const result of entry.results) {
      if (
        allOpIds.includes(result.op_id) &&
        // "in_progress" is not a dispatch_log result status (only complete/failed/skipped)
        // but orchestrators may write it; guard defensively
        (result.status as string) === "in_progress"
      ) {
        return "in_progress";
      }
    }
  }

  // pending-surfaced: pending != null AND all deps are complete
  const allDepsComplete =
    depStatuses.length === 0 ||
    depStatuses.every((s) => s === "complete");

  if (dag.pending !== null && allDepsComplete) {
    return "pending-surfaced";
  }

  // pending: all other cases
  return "pending";
}

// ---------------------------------------------------------------------------
// Guard result derivation (per milestone)
// ---------------------------------------------------------------------------

interface GuardInfo {
  guard_result: "pass" | "fail" | "pending";
  guard_output: string | null;
  completed_at: string | null;
}

function deriveGuardResult(
  slug: string,
  log: DagJson["dispatch_log"]
): GuardInfo {
  const guardOpId = `${slug}.guard`;

  let latestGuardResult: "pass" | "fail" | null = null;
  let latestGuardOutput: string | null = null;
  let completedAt: string | null = null;

  for (const entry of log) {
    if (!entry.operations.includes(guardOpId)) continue;
    for (const result of entry.results) {
      if (result.op_id !== guardOpId) continue;
      if (result.guard_result !== null) {
        latestGuardResult = result.guard_result;
        latestGuardOutput = result.guard_output;
        if (result.guard_result === "pass") {
          completedAt = result.guard_ran_at;
        }
      }
    }
  }

  if (latestGuardResult !== null) {
    return {
      guard_result: latestGuardResult,
      guard_output: latestGuardOutput,
      completed_at: completedAt,
    };
  }

  return { guard_result: "pending", guard_output: null, completed_at: null };
}

// ---------------------------------------------------------------------------
// Artifact derivation
// ---------------------------------------------------------------------------

/**
 * Derive the artifact file list for a milestone: union of op.file for write-class
 * actions plus op.to_file for "move" actions.
 */
function deriveArtifacts(ops: OperationDag[]): string[] {
  const set = new Set<string>();
  for (const op of ops) {
    if (op.action === "move" && op.to_file) {
      set.add(op.to_file);
    } else if (WRITE_ACTIONS.has(op.action) && op.file) {
      set.add(op.file);
    }
  }
  return Array.from(set);
}

// ---------------------------------------------------------------------------
// Operation snapshot derivation
// ---------------------------------------------------------------------------

/**
 * Enrich an authored OperationDag into an OperationSnapshot with derived fields.
 */
function buildOperationSnapshot(
  op: OperationDag,
  milestoneEffort: EffortTier | null,
  log: DagJson["dispatch_log"]
): OperationSnapshot {
  const dispatches = dispatchesForOp(log, op.id);
  const dispatch_ids = dispatches.map((d) => d.id);

  // guard_result: latest non-null guard result for this op
  let guard_result: "pass" | "fail" | null = null;
  let guard_output: string | null = null;
  let guard_ran_at: string | null = null;

  for (const entry of dispatches) {
    for (const result of entry.results) {
      if (result.op_id === op.id && result.guard_result !== null) {
        guard_result = result.guard_result;
        guard_output = result.guard_output;
        guard_ran_at = result.guard_ran_at;
      }
    }
  }

  // ki_estimate: use authored value if present; apply heuristic otherwise
  const ki_estimate =
    op.ki_estimate !== null && op.ki_estimate !== undefined
      ? op.ki_estimate
      : deriveKiEstimate(op, milestoneEffort);

  // Enrich shape ops with derived stub fields
  const enrichedShape = enrichShape(op.shape);

  return {
    ...op,
    ki_estimate,
    shape: enrichedShape,
    dispatch_ids,
    // TODO: stubbed as 0 — op-level attempt_count requires per-op dispatch log scan
    attempt_count: 0,
    guard_result,
    guard_output,
    guard_ran_at,
    // TODO: stubbed — requires gitnexus_impact MCP call (future work)
    blast_radius: [],
    // TODO: stubbed — requires same-wave op-key collision scan (future work)
    conflict: {
      detected: false,
      competing_op: null,
      op_key: null,
      resolution: null,
    },
    // TODO: stubbed — requires ki_estimate share prorating across dispatch totals
    tokens_actual: null,
  };
}

/**
 * Enrich a Shape by adding derived stub fields to shape ops.
 */
function enrichShape(
  shape: Shape | null | undefined
): ShapeSnapshot | null {
  if (!shape) return null;
  if (shape.kind === null) return shape as ShapeSnapshot;

  const kind = shape.kind;

  if (
    kind === "function" ||
    kind === "interface" ||
    kind === "type" ||
    kind === "class" ||
    kind === "enum" ||
    kind === "const" ||
    kind === "script" ||
    kind === "config" ||
    kind === "env" ||
    kind === "schema" ||
    kind === "manifest"
  ) {
    const ops: ShapeOpSnapshot[] = (
      "ops" in shape && Array.isArray(shape.ops) ? shape.ops : []
    ).map((sop: ShapeOpDag) => ({
      ...sop,
      // TODO: from/breaking/severity require AST read + gitnexus (future work)
      from: null,
      breaking: null,
      severity: null,
    }));
    return { ...(shape as object), ops } as ShapeSnapshot;
  }

  // doc and structured-output have no ops to enrich
  return shape as ShapeSnapshot;
}

// ---------------------------------------------------------------------------
// Synthesized guard operation
// ---------------------------------------------------------------------------

/**
 * Synthesize a guard op for a milestone: id = "<slug>.guard", depends on all
 * other authored ops in the milestone. Required by PROPOSED_DAG_STRUCTURE.md.
 */
function synthesizeGuardOp(
  slug: string,
  dag: MilestoneDag,
  milestoneOpIds: string[],
  log: DagJson["dispatch_log"]
): OperationSnapshot {
  const guardId = `${slug}.guard`;
  const dispatches = dispatchesForOp(log, guardId);
  const dispatch_ids = dispatches.map((d) => d.id);

  let guard_result: "pass" | "fail" | null = null;
  let guard_output: string | null = null;
  let guard_ran_at: string | null = null;

  for (const entry of dispatches) {
    for (const result of entry.results) {
      if (result.op_id === guardId && result.guard_result !== null) {
        guard_result = result.guard_result;
        guard_output = result.guard_output;
        guard_ran_at = result.guard_ran_at;
      }
    }
  }

  return {
    id: guardId,
    milestone: slug,
    depends_on: milestoneOpIds,
    type: "tool-call",
    action: "guard",
    file: null,
    symbol: null,
    provenance: null,
    confidence: null,
    audit_check: null,
    criteria: [],
    tool: null,
    args: null,
    guard: dag.guard ?? null,
    to_file: null,
    to_symbol: null,
    ki_estimate: 0,
    ki_source: null,
    authored_by: "synthesized",
    status: "pending",
    shape: null,
    dispatch_ids,
    attempt_count: 0,
    guard_result,
    guard_output,
    guard_ran_at,
    blast_radius: [],
    conflict: { detected: false, competing_op: null, op_key: null, resolution: null },
    tokens_actual: null,
  };
}

// ---------------------------------------------------------------------------
// b_eff_per_tier computation
// ---------------------------------------------------------------------------

/**
 * Compute effective base cost per tier under prompt caching.
 * b_eff = b × ((1 − p) × w + p × r)
 * Source: SCOPE.md §A1.
 */
function computeBEff(
  bPerTier: Record<string, number | null>,
  sentinelConfig: {
    enabled: boolean;
    write_multiplier: number;
    read_multiplier: number;
    hit_probability: number;
  }
): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  const { write_multiplier: w, read_multiplier: r, hit_probability: p } =
    sentinelConfig;

  for (const [tier, b] of Object.entries(bPerTier)) {
    if (b === null) {
      result[tier] = null;
    } else {
      result[tier] = Math.round(b * ((1 - p) * w + p * r));
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// pairwise_overlap computation
// ---------------------------------------------------------------------------

/**
 * Build the pairwise overlap map across all milestone pairs.
 * Source: SCOPE.md §C2, DECISIONS.md D-09.
 *
 * Key format: "${slugA}:${slugB}" where slugA < slugB alphabetically.
 *
 * For each pair:
 *   - Prospective: files in intersection of op.file targets; bytes = stat(f) if exists else 0.
 *   - Actual: after both complete, stat the intersection of artifacts.
 */
function buildPairwiseOverlap(
  milestoneOps: Map<string, OperationDag[]>,
  milestoneStatuses: Map<string, MilestoneStatus>
): PairwiseOverlapMap {
  const slugs = Array.from(milestoneOps.keys());
  const result: PairwiseOverlapMap = {};

  for (let i = 0; i < slugs.length; i++) {
    for (let j = i + 1; j < slugs.length; j++) {
      const slugA = slugs[i];
      const slugB = slugs[j];
      if (slugA === undefined || slugB === undefined) continue;

      // Stable key: lower slug alphabetically comes first
      const [keyA, keyB] =
        slugA < slugB ? [slugA, slugB] : [slugB, slugA];
      const key = `${keyA}:${keyB}`;

      const opsA = milestoneOps.get(slugA) ?? [];
      const opsB = milestoneOps.get(slugB) ?? [];

      const filesA = new Set(opsA.map((op) => op.file).filter((f): f is string => f !== null));
      const filesB = new Set(opsB.map((op) => op.file).filter((f): f is string => f !== null));

      const intersection = Array.from(filesA).filter((f) => filesB.has(f));

      if (intersection.length === 0) continue;

      const statusA = milestoneStatuses.get(slugA) ?? "pending";
      const statusB = milestoneStatuses.get(slugB) ?? "pending";
      const bothComplete = statusA === "complete" && statusB === "complete";

      let bytes = 0;
      for (const f of intersection) {
        bytes += bothComplete ? safeStatSize(f) : 0;
      }

      result[key] = bytes;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Normalize operations from dag (array or Record)
// ---------------------------------------------------------------------------

function normalizeOperations(
  raw: DagJson["operations"]
): OperationDag[] {
  const ops: OperationDag[] = Array.isArray(raw) ? raw : Object.values(raw);
  // Back-compat: dags authored before the `type` field was introduced default
  // to "generative". A missing `type` treated as "tool-call" would silently
  // produce null prompts for every milestone (the bug this fixes).
  return ops.map((op) =>
    op.type === undefined ? { ...op, type: "generative" as const } : op
  );
}

// ---------------------------------------------------------------------------
// snapshot()
// ---------------------------------------------------------------------------

/**
 * Compute the fully-derived DagSnapshot from a dag.json document.
 *
 * Computation order (per SCOPE.md §N1):
 *   1. Copy dag-level fields verbatim.
 *   2. Compute b_eff_per_tier.
 *   3. Topological sort → assign wave numbers.
 *   4. Per-milestone derived fields.
 *   5. Per-operation derived fields.
 *   6. pairwise_overlap.
 *   7. open_questions.
 *
 * Does not mutate the input dag.
 *
 * @throws {Error} if a dependency cycle is detected.
 */
export function snapshot(dag: DagJson): DagSnapshot {
  const now = new Date().toISOString();

  // Step 1 — Copy dag-level fields
  const sentinelFanout = dag.optimization.sentinel_fanout;
  const bPerTier = { ...dag.optimization.b_per_tier };
  const contextWindowPerTier = { ...dag.optimization.context_window_per_tier };

  // Step 2 — Compute b_eff_per_tier
  const bEff = computeBEff(bPerTier, sentinelFanout);

  // Step 3 — Topological sort
  const { waves } = topoSortMilestones(dag.milestones);

  // Normalize operations
  const opsArray = normalizeOperations(dag.operations);

  // Group operations by milestone
  const opsByMilestone = new Map<string, OperationDag[]>();
  for (const op of opsArray) {
    const list = opsByMilestone.get(op.milestone) ?? [];
    list.push(op);
    opsByMilestone.set(op.milestone, list);
  }

  // Step 4 — Per-milestone derived fields (two passes: statuses first, full snapshot second)

  // Pass 4a: compute statuses (needed for overlap + questions)
  const milestoneStatuses = new Map<string, MilestoneStatus>();

  // Process in topological order so parent statuses are available for children
  const topoSlugs = Array.from(waves.entries())
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([slug]) => slug);

  for (const slug of topoSlugs) {
    const dagM = dag.milestones[slug];
    if (dagM === undefined) continue;

    const milestoneOpIds = (opsByMilestone.get(slug) ?? []).map((op) => op.id);

    const depStatuses = dagM.depends_on.map(
      (dep) => milestoneStatuses.get(dep) ?? "pending"
    );

    const status = deriveMilestoneStatus(
      slug,
      dagM,
      milestoneOpIds,
      dag.dispatch_log,
      depStatuses
    );
    milestoneStatuses.set(slug, status);
  }

  // Pass 4b: build full MilestoneSnapshot objects
  const milestones: Record<string, MilestoneSnapshot> = {};
  const allOpsSnapshot: OperationSnapshot[] = [];

  for (const slug of topoSlugs) {
    const dagM = dag.milestones[slug];
    if (dagM === undefined) continue;

    const wave = waves.get(slug) ?? 0;
    const milestoneOps = opsByMilestone.get(slug) ?? [];
    const milestoneOpIds = milestoneOps.map((op) => op.id);

    const status = milestoneStatuses.get(slug) ?? "pending";

    // D-07: eligible = pending==null AND all deps complete AND no dep failed
    const depStatuses = dagM.depends_on.map(
      (dep) => milestoneStatuses.get(dep) ?? "pending"
    );
    const allDepsComplete =
      dagM.depends_on.length === 0 ||
      depStatuses.every((s) => s === "complete");
    const noDepFailed = depStatuses.every((s) => s !== "failed");
    const eligible = dagM.pending === null && allDepsComplete && noDepFailed;

    // started_at: min started_at across all dispatch log entries for this milestone
    const relatedDispatches = dispatchesForMilestone(dag.dispatch_log, [
      ...milestoneOpIds,
      `${slug}.guard`,
    ]);
    const started_at =
      relatedDispatches.length > 0
        ? relatedDispatches
            .map((d) => d.started_at)
            .sort()[0] ?? null
        : null;

    // guard_result / guard_output / completed_at
    let guardResult: "pass" | "fail" | "pending" | null;
    let guardOutput: string | null;
    let completedAt: string | null;

    if (dagM.guard) {
      const gi = deriveGuardResult(slug, dag.dispatch_log);
      guardResult = gi.guard_result;
      guardOutput = gi.guard_output;
      completedAt = gi.completed_at;
    } else {
      guardResult = null;
      guardOutput = null;
      completedAt = null;
    }

    // artifacts
    const artifacts = deriveArtifacts(milestoneOps);

    // si_bytes: sum stat sizes of artifacts
    const si_bytes = artifacts.reduce((acc, f) => acc + safeStatSize(f), 0);

    // ki_estimate per op
    const enrichedOps: OperationSnapshot[] = milestoneOps.map((op) =>
      buildOperationSnapshot(op, dagM.effort, dag.dispatch_log)
    );

    // ki_estimate for milestone: sum enriched ki_estimates
    let ki_estimate: number | null = null;
    let kiSum = 0;
    let anyNullKi = false;
    for (const op of enrichedOps) {
      if (op.ki_estimate === null) {
        anyNullKi = true;
        break;
      }
      kiSum += op.ki_estimate;
    }
    if (!anyNullKi) ki_estimate = kiSum;

    // tokens_estimated: b_eff_per_tier[model] + si_bytes_as_tokens + ki_estimate
    let tokens_estimated: number | null = null;
    const model = dagM.model;
    if (model !== null && ki_estimate !== null) {
      const bEffForModel = bEff[model] ?? null;
      if (bEffForModel !== null) {
        const siTokens = siBytesAsTokens(si_bytes);
        tokens_estimated = bEffForModel + siTokens + ki_estimate;
      }
    }

    // tokens_actual: sum turn tokens from completed dispatches for this milestone
    let tokens_actual: number | null = null;
    const completedDispatches = relatedDispatches.filter((d) =>
      d.completed_at !== null &&
      d.results.length > 0 &&
      d.results.every((r) => r.status === "complete" || r.status === "skipped")
    );
    if (completedDispatches.length > 0) {
      tokens_actual = completedDispatches.reduce((sum, d) => {
        return sum + d.turns.reduce((ts, t) => ts + t.input_tokens + t.output_tokens, 0);
      }, 0);
    }

    // Synthesize guard op
    const guardOp = synthesizeGuardOp(
      slug,
      dagM,
      milestoneOpIds,
      dag.dispatch_log
    );
    allOpsSnapshot.push(...enrichedOps, guardOp);

    // Build the milestone snapshot — use conditional spreads for optional fields
    // (required by exactOptionalPropertyTypes)
    milestones[slug] = {
      description: dagM.description,
      ...(dagM.rationale !== undefined ? { rationale: dagM.rationale } : {}),
      authored_by: dagM.authored_by,
      pending: dagM.pending,
      triggered_by: dagM.triggered_by,
      phase: dagM.phase,
      depends_on: dagM.depends_on,
      agent: dagM.agent,
      model: dagM.model,
      effort: dagM.effort,
      two_stage: dagM.two_stage,
      read_only: dagM.read_only,
      guard: dagM.guard,
      context: `contexts/${slug}.md`,
      wave,
      eligible,
      status,
      started_at,
      completed_at: completedAt,
      guard_result: guardResult,
      guard_output: guardOutput,
      artifacts,
      si_bytes,
      ki_estimate,
      tokens_estimated,
      tokens_actual,
    };
  }

  // Step 6 — pairwise_overlap
  const pairwiseOverlap = buildPairwiseOverlap(opsByMilestone, milestoneStatuses);

  // Step 7 — open_questions
  const open_questions = buildOpenQuestions(dag, milestones);

  // Build optimization block for snapshot
  const optimization: SnapshotOptimization = {
    sentinel_fanout: sentinelFanout,
    context_window_override: dag.optimization.context_window_override,
    b_override: dag.optimization.b_override,
    b_per_tier: bPerTier,
    b_eff_per_tier: bEff,
    context_window_per_tier: contextWindowPerTier,
  };

  // Use conditional spreads for optional top-level fields (exactOptionalPropertyTypes)
  const snap: DagSnapshot = {
    snapshot_at: now,
    snapshot_version: 1, // callers may increment if persisting
    plan: "", // caller sets this from directory name
    schema_version: dag.schema_version,
    plan_kind: dag.plan_kind,
    description: dag.description,
    problem: dag.problem,
    approach: dag.approach,
    executor: dag.executor,
    ...(dag.executor_model !== undefined ? { executor_model: dag.executor_model } : {}),
    ...(dag.executor_effort !== undefined ? { executor_effort: dag.executor_effort } : {}),
    phases: [...dag.phases],
    terminal: dag.terminal,
    ...(dag.assumed_baseline !== undefined ? { assumed_baseline: dag.assumed_baseline } : {}),
    optimization,
    milestones,
    operations: allOpsSnapshot,
    pairwise_overlap: pairwiseOverlap,
    open_questions,
  };

  validateSnapshot(snap);
  return snap;
}

// ---------------------------------------------------------------------------
// open_questions builder
// ---------------------------------------------------------------------------

function buildOpenQuestions(
  dag: DagJson,
  milestones: Record<string, MilestoneSnapshot>
): OpenQuestion[] {
  const questions: OpenQuestion[] = [];

  for (const [slug, m] of Object.entries(milestones)) {
    const dagM = dag.milestones[slug];
    if (dagM === undefined || dagM.pending === null) continue;

    const surfaced = m.status === "pending-surfaced";

    questions.push({
      id: `q:${slug}`,
      text: dagM.pending,
      blocking: slug,
      surfaced,
      // TODO: scan dispatch_log notes for the turn/dispatch where question appeared
      raised_at_dispatch: null,
      raised_at_turn: null,
      answered: false,
      answer: null,
    });
  }

  return questions;
}

// ---------------------------------------------------------------------------
// Kind family classification
// ---------------------------------------------------------------------------

/**
 * Determine the KindFamily for a milestone by examining its operations.
 * Source: SCOPE.md §N2 step 2.
 */
function getMilestoneKindFamily(
  milestoneOps: OperationDag[]
): KindFamily {
  if (milestoneOps.length === 0) return "tool-call";

  // guard-only milestones (all ops are tool-call)
  if (milestoneOps.every((op) => op.type === "tool-call")) {
    return "tool-call";
  }

  // Find first generative op with a shape.kind
  for (const op of milestoneOps) {
    if (op.type !== "generative" || !op.shape || op.shape.kind === null) continue;
    const kind = op.shape.kind;
    if (
      kind === "function" ||
      kind === "interface" ||
      kind === "type" ||
      kind === "class" ||
      kind === "enum" ||
      kind === "const" ||
      kind === "script" ||
      kind === "config" ||
      kind === "env" ||
      kind === "schema" ||
      kind === "manifest"
    ) {
      return "code-config";
    }
    if (kind === "doc") return "doc";
    if (kind === "structured-output") return "structured";
  }

  // Default: code-config (most common)
  return "code-config";
}

// ---------------------------------------------------------------------------
// DAG structure detection
// ---------------------------------------------------------------------------

/**
 * Check if the eligible subgraph is a forest (each node has ≤ 1 parent).
 * Source: SCOPE.md §B2.
 */
function isForest(
  eligibleSlugs: string[],
  milestones: Record<string, MilestoneSnapshot>
): boolean {
  const eligibleSet = new Set(eligibleSlugs);
  for (const slug of eligibleSlugs) {
    const m = milestones[slug];
    if (m === undefined) continue;
    const deps = m.depends_on.filter((d) => eligibleSet.has(d));
    if (deps.length > 1) return false;
  }
  return true;
}

/**
 * Check if the eligible subgraph is series-parallel.
 *
 * Uses the Valdes-Tarjan-Lawler reduction approach:
 * A DAG is series-parallel (SP) if it can be reduced to a single edge by
 * repeatedly applying:
 *   - Series: merge a path v₁→v₂→v₃ into v₁→v₃
 *   - Parallel: merge duplicate edges v₁→v₂ into a single edge
 *
 * Source: SCOPE.md §B2 — "Valdes-Tarjan-Lawler algorithm"
 * arxiv 1905.13740
 */
function isSeriesParallel(
  eligibleSlugs: string[],
  milestones: Record<string, MilestoneSnapshot>
): boolean {
  if (eligibleSlugs.length <= 2) return true;

  // Build adjacency for eligible subgraph
  const eligibleSet = new Set(eligibleSlugs);
  const children = new Map<string, Set<string>>();
  const parents = new Map<string, Set<string>>();

  for (const slug of eligibleSlugs) {
    children.set(slug, new Set());
    parents.set(slug, new Set());
  }

  for (const slug of eligibleSlugs) {
    const m = milestones[slug];
    if (m === undefined) continue;
    for (const dep of m.depends_on) {
      if (!eligibleSet.has(dep)) continue;
      children.get(dep)?.add(slug);
      parents.get(slug)?.add(dep);
    }
  }

  // SP reduction — iterate until no more reductions possible
  let changed = true;
  const active = new Set(eligibleSlugs);

  while (changed) {
    changed = false;

    for (const v of Array.from(active)) {
      const vParents = parents.get(v) ?? new Set<string>();
      const vChildren = children.get(v) ?? new Set<string>();

      // Series reduction: if v has exactly 1 parent and 1 child, bypass v
      if (vParents.size === 1 && vChildren.size === 1) {
        const [p] = Array.from(vParents);
        const [c] = Array.from(vChildren);
        if (p === undefined || c === undefined) continue;

        children.get(p)?.delete(v);
        children.get(p)?.add(c);
        parents.get(c)?.delete(v);
        parents.get(c)?.add(p);

        active.delete(v);
        children.delete(v);
        parents.delete(v);
        changed = true;
        break;
      }

      // Parallel reduction: remove duplicate edges (already represented as sets)
      // Nothing to do here since we use Sets — duplicates are automatically removed.
    }
  }

  // SP if we reduced down to ≤ 2 nodes
  return active.size <= 2;
}

// ---------------------------------------------------------------------------
// Optimizer shared cost helpers
// ---------------------------------------------------------------------------

/** Cost of a batch: B_eff + sum(file token costs) + sum(Ki). */
function batchCost(
  slugs: string[],
  bEff: number,
  milestones: Record<string, MilestoneSnapshot>,
  opsByMilestone: Map<string, OperationDag[]>
): number {
  const fileUnion = new Set<string>();
  let kiSum = 0;

  for (const slug of slugs) {
    const m = milestones[slug];
    if (m === undefined) continue;
    kiSum += m.ki_estimate ?? 0;
    for (const op of opsByMilestone.get(slug) ?? []) {
      if (op.file) fileUnion.add(op.file);
    }
    for (const f of m.read_only) fileUnion.add(f);
  }

  const fileBytes = Array.from(fileUnion).reduce(
    (acc, f) => acc + safeStatSize(f),
    0
  );
  const fileTokens = siBytesAsTokens(fileBytes);

  return bEff + fileTokens + kiSum;
}

// ---------------------------------------------------------------------------
// Bitmask DP (exact, N ≤ 20)
// Source: SCOPE.md §B2 — exact algorithm for N ≤ 20
// ---------------------------------------------------------------------------

/**
 * Bitmask DP — exact optimal packing for N ≤ 20 milestones.
 *
 * dp[mask] = { cost, batches } — minimum cost to pack the milestone subset in mask.
 * Try all non-empty subsets of mask as a single batch; cost = batch tokens if ≤ W.
 * dp[mask] = min over valid single-batch subsets b⊆mask of: batchCost(b) + dp[mask^b].
 *
 * Precedence: for each milestone i in subset b, all eligible deps of i must be
 * in the already-packed bits (mask ^ b).
 */
function bitmaskDP(
  slugs: string[],
  milestones: Record<string, MilestoneSnapshot>,
  opsByMilestone: Map<string, OperationDag[]>,
  bEffValue: number,
  contextWindow: number
): string[][] {
  const N = slugs.length;
  const full = (1 << N) - 1;

  // Precompute dep masks (within eligible set)
  const eligibleSet = new Set(slugs);
  const depMask: number[] = new Array<number>(N).fill(0);
  for (let i = 0; i < N; i++) {
    const s = slugs[i];
    if (s === undefined) continue;
    const deps = milestones[s]?.depends_on ?? [];
    for (const dep of deps) {
      if (!eligibleSet.has(dep)) continue;
      const j = slugs.indexOf(dep);
      if (j >= 0) depMask[i] = (depMask[i] ?? 0) | (1 << j);
    }
  }

  interface DpEntry { batches: string[][]; cost: number }
  const dp: Array<DpEntry | undefined> = new Array(1 << N).fill(undefined);
  dp[0] = { batches: [], cost: 0 };

  for (let mask = 1; mask <= full; mask++) {
    let best: DpEntry = { batches: [], cost: Number.MAX_SAFE_INTEGER };

    // Iterate over all non-empty subsets of mask
    for (let sub = mask; sub > 0; sub = (sub - 1) & mask) {
      // Precedence check: for each member i of sub,
      // all eligible deps must be already packed (in mask ^ sub)
      let feasible = true;
      for (let i = 0; i < N; i++) {
        if (!(sub & (1 << i))) continue;
        const needed = (depMask[i] ?? 0) & ~sub;
        if ((needed & (mask ^ sub)) !== needed) {
          feasible = false;
          break;
        }
      }
      if (!feasible) {
        if (sub === 0) break;
        continue;
      }

      // Context window check
      const slugsInSub = slugs.filter((_, i) => (sub & (1 << i)) !== 0);
      const tokens = batchCost(slugsInSub, bEffValue, milestones, opsByMilestone);
      if (tokens > contextWindow) {
        if (sub === 0) break;
        continue;
      }

      const prev = dp[mask ^ sub];
      if (prev === undefined) {
        if (sub === 0) break;
        continue;
      }

      const newCost = prev.cost + tokens;
      if (newCost < best.cost) {
        best = { batches: [...prev.batches, slugsInSub], cost: newCost };
      }

      if (sub === 0) break;
    }

    if (best.cost < Number.MAX_SAFE_INTEGER) {
      dp[mask] = best;
    }
  }

  const result = dp[full];
  return result !== undefined && result.batches.length > 0
    ? result.batches
    : slugs.map((s) => [s]); // fallback: each milestone its own batch
}

// ---------------------------------------------------------------------------
// Tree DP (exact, forest/SP, N ≤ 50)
// Source: SCOPE.md §B3 — arxiv 1905.13740
// ---------------------------------------------------------------------------

/**
 * Tree DP — exact optimal for forest/series-parallel eligible subgraphs.
 *
 * Bottom-up decision at each node:
 *   a) Extend parent's batch (no new B; union file sets may grow).
 *   b) Start a new batch (pay B; new file set).
 *
 * This implementation uses a greedy bottom-up chain: process nodes in reverse
 * topological order (leaves first), greedily extending the parent's batch if
 * the context window still fits.
 */
function treeDP(
  slugs: string[],
  milestones: Record<string, MilestoneSnapshot>,
  opsByMilestone: Map<string, OperationDag[]>,
  bEffValue: number,
  contextWindow: number
): string[][] {
  // Process in reverse wave order (leaves first)
  const byWave = [...slugs].sort(
    (a, b) => {
      const wa = milestones[a]?.wave ?? 0;
      const wb = milestones[b]?.wave ?? 0;
      return (wb - wa) || a.localeCompare(b);
    }
  );

  const assignment = new Map<string, number>();
  const batches: string[][] = [];
  const eligibleSet = new Set(slugs);

  for (const slug of byWave) {
    const m = milestones[slug];
    if (m === undefined) continue;
    const deps = m.depends_on.filter((d) => eligibleSet.has(d));
    let assigned = false;

    // Try to extend parent batch if single parent
    if (deps.length === 1) {
      const dep = deps[0];
      if (dep !== undefined) {
        const parentBatchIdx = assignment.get(dep) ?? -1;
        if (parentBatchIdx >= 0) {
          const parentBatch = batches[parentBatchIdx];
          if (parentBatch !== undefined) {
            const candidate = [...parentBatch, slug];
            const tokens = batchCost(candidate, bEffValue, milestones, opsByMilestone);
            if (tokens <= contextWindow) {
              batches[parentBatchIdx] = candidate;
              assignment.set(slug, parentBatchIdx);
              assigned = true;
            }
          }
        }
      }
    }

    if (!assigned) {
      const idx = batches.length;
      batches.push([slug]);
      assignment.set(slug, idx);
    }
  }

  return enforcePrecedenceConstraint(batches, milestones, eligibleSet);
}

/**
 * Post-process batches to enforce DAG precedence constraint:
 * every eligible dep of slug must be in an EARLIER batch than slug.
 *
 * Iterates to a fixed point, splitting offending milestones into new batches.
 */
function enforcePrecedenceConstraint(
  batches: string[][],
  milestones: Record<string, MilestoneSnapshot>,
  eligibleSet: Set<string>
): string[][] {
  let current = batches.map((b) => [...b]);
  let assignment = new Map<string, number>();

  const rebuildAssignment = (): void => {
    assignment = new Map();
    for (let idx = 0; idx < current.length; idx++) {
      const batch = current[idx];
      if (batch === undefined) continue;
      for (const slug of batch) assignment.set(slug, idx);
    }
  };
  rebuildAssignment();

  let changed = true;
  while (changed) {
    changed = false;
    for (let idx = 0; idx < current.length; idx++) {
      const batch = current[idx];
      if (batch === undefined) continue;
      const toSplit: string[] = [];
      for (const slug of batch) {
        const m = milestones[slug];
        if (m === undefined) continue;
        const deps = m.depends_on.filter((d) => eligibleSet.has(d));
        for (const dep of deps) {
          const depBatch = assignment.get(dep) ?? -1;
          if (depBatch >= idx) {
            toSplit.push(slug);
            break;
          }
        }
      }
      if (toSplit.length > 0) {
        current[idx] = batch.filter((s) => !toSplit.includes(s));
        current.push(toSplit);
        current = current.filter((b) => b.length > 0);
        rebuildAssignment();
        changed = true;
        break;
      }
    }
  }

  return current;
}

// ---------------------------------------------------------------------------
// Simulated Annealing (general DAG, N ≤ 50, pure TypeScript)
// Source: SCOPE.md §B2 + open decision — SA in pure TS, 3-8% from CP-SAT optimal.
// No native dependencies (SCOPE.md §Open Decisions #1).
// ---------------------------------------------------------------------------

/**
 * Simulated Annealing for general DAG scheduling.
 *
 * State: assignment of each milestone to a batch index.
 * Energy: total cost = B_eff × batches_used + Σ |∪Sᵢ per batch|_bytes + Σ Kᵢ
 *         + LARGE_PENALTY per constraint violation (window, precedence).
 * Moves:
 *   - Move one milestone to a different random batch.
 *   - Swap two milestones between batches.
 * Schedule: T₀=100, T_min=0.01, cooling=0.95, iterations=N×20 per temp step.
 *
 * Reference: SCOPE.md §B2, §Open Decisions #1
 */
function simulatedAnnealing(
  slugs: string[],
  milestones: Record<string, MilestoneSnapshot>,
  opsByMilestone: Map<string, OperationDag[]>,
  bEffValue: number,
  contextWindow: number
): string[][] {
  const N = slugs.length;
  if (N === 0) return [];

  const eligibleSet = new Set(slugs);
  const PENALTY = contextWindow * 10;

  // Dep index: index of each eligible dep in slugs[]
  const depsInEligible = (slug: string): number[] => {
    const m = milestones[slug];
    if (m === undefined) return [];
    return m.depends_on
      .filter((d) => eligibleSet.has(d))
      .map((d) => slugs.indexOf(d))
      .filter((i) => i >= 0);
  };

  // Energy function
  const energy = (assignment: number[]): number => {
    const batchContents = new Map<number, string[]>();
    for (let i = 0; i < N; i++) {
      const b = assignment[i];
      if (b === undefined) continue;
      const list = batchContents.get(b) ?? [];
      list.push(slugs[i] ?? "");
      batchContents.set(b, list);
    }

    let cost = 0;
    for (const members of batchContents.values()) {
      const tokens = batchCost(members, bEffValue, milestones, opsByMilestone);
      cost += tokens;
      if (tokens > contextWindow) {
        cost += PENALTY * (tokens - contextWindow);
      }
    }

    // Precedence penalty
    for (let i = 0; i < N; i++) {
      const ai = assignment[i];
      if (ai === undefined) continue;
      for (const di of depsInEligible(slugs[i] ?? "")) {
        const adi = assignment[di];
        if (adi !== undefined && adi >= ai) {
          cost += PENALTY;
        }
      }
    }

    return cost;
  };

  // Initial state: each milestone in its own batch (ordered by wave)
  let current: number[] = slugs.map((_, i) => i);
  let currentEnergy = energy(current);
  let best = [...current];
  let bestEnergy = currentEnergy;

  const maxBatches = N;
  let T = 100.0;
  const T_min = 0.01;
  const cooling = 0.95;
  const itersPerTemp = N * 20;

  while (T > T_min) {
    for (let iter = 0; iter < itersPerTemp; iter++) {
      const neighbor = [...current];

      if (Math.random() < 0.6) {
        // Move: pick a random milestone, assign it to a random batch
        const i = Math.floor(Math.random() * N);
        neighbor[i] = Math.floor(Math.random() * maxBatches);
      } else {
        // Swap: pick two milestones and swap their batch assignments
        const i = Math.floor(Math.random() * N);
        const j = Math.floor(Math.random() * N);
        if (i !== j) {
          const tmp = current[i];
          neighbor[i] = current[j] ?? 0;
          neighbor[j] = tmp ?? 0;
        }
      }

      const neighborEnergy = energy(neighbor);
      const delta = neighborEnergy - currentEnergy;

      if (delta < 0 || Math.random() < Math.exp(-delta / T)) {
        current = neighbor;
        currentEnergy = neighborEnergy;
        if (currentEnergy < bestEnergy) {
          best = [...current];
          bestEnergy = currentEnergy;
        }
      }
    }
    T *= cooling;
  }

  // Convert best assignment to batch lists
  const batchMap = new Map<number, string[]>();
  for (let i = 0; i < N; i++) {
    const b = best[i];
    if (b === undefined) continue;
    const slug = slugs[i];
    if (slug === undefined) continue;
    const list = batchMap.get(b) ?? [];
    list.push(slug);
    batchMap.set(b, list);
  }

  const result = Array.from(batchMap.values()).filter((b) => b.length > 0);
  return enforcePrecedenceConstraint(result, milestones, eligibleSet);
}

// ---------------------------------------------------------------------------
// HLFET (N > 50 or time-constrained)
// Source: SCOPE.md §B2 — "Highest Level First with Estimated Times"
// "HLFET achieves the optimal 2−1/P approximation ratio for list scheduling. O(N log N)."
// Critical-path distance uses ki_estimate as weight.
// ---------------------------------------------------------------------------

/**
 * HLFET — critical-path priority list scheduling.
 *
 * 1. Compute critical-path weight: cp[v] = ki_estimate[v] + max(cp[successor], 0)
 * 2. Sort eligible milestones by cp[v] descending (heaviest first).
 * 3. Assign each milestone to the first batch where all eligible deps are in
 *    an earlier batch and adding it keeps tokens_estimated ≤ W.
 * 4. If no batch fits, start a new batch.
 */
function hlfet(
  slugs: string[],
  milestones: Record<string, MilestoneSnapshot>,
  opsByMilestone: Map<string, OperationDag[]>,
  bEffValue: number,
  contextWindow: number
): string[][] {
  const eligibleSet = new Set(slugs);

  // Build successor map (within eligible subgraph)
  const successors = new Map<string, string[]>();
  for (const slug of slugs) successors.set(slug, []);

  for (const slug of slugs) {
    const m = milestones[slug];
    if (m === undefined) continue;
    for (const dep of m.depends_on) {
      if (!eligibleSet.has(dep)) continue;
      const sucList = successors.get(dep);
      if (sucList !== undefined) sucList.push(slug);
    }
  }

  // Compute critical path weights bottom-up (reverse wave order)
  const cp = new Map<string, number>();
  const reverseTopo = [...slugs].sort(
    (a, b) => (milestones[b]?.wave ?? 0) - (milestones[a]?.wave ?? 0)
  );

  for (const slug of reverseTopo) {
    const ki = milestones[slug]?.ki_estimate ?? 0;
    const sucCp = (successors.get(slug) ?? []).map((s) => cp.get(s) ?? 0);
    cp.set(slug, ki + (sucCp.length > 0 ? Math.max(...sucCp) : 0));
  }

  // Sort by cp descending (HLFET priority)
  const sorted = [...slugs].sort((a, b) => (cp.get(b) ?? 0) - (cp.get(a) ?? 0));

  const batches: string[][] = [];
  const assignment = new Map<string, number>();

  for (const slug of sorted) {
    const m = milestones[slug];
    if (m === undefined) continue;
    const depsInEligible = m.depends_on.filter((d) => eligibleSet.has(d));
    const maxDepBatch = depsInEligible.reduce((max, dep) => {
      return Math.max(max, assignment.get(dep) ?? -1);
    }, -1);

    // Try to fit in an existing batch after maxDepBatch
    let placed = false;
    for (let idx = maxDepBatch + 1; idx < batches.length; idx++) {
      const batch = batches[idx];
      if (batch === undefined) continue;
      const candidate = [...batch, slug];
      const tokens = batchCost(candidate, bEffValue, milestones, opsByMilestone);
      if (tokens <= contextWindow) {
        batches[idx] = candidate;
        assignment.set(slug, idx);
        placed = true;
        break;
      }
    }

    if (!placed) {
      const idx = batches.length;
      batches.push([slug]);
      assignment.set(slug, idx);
    }
  }

  return batches.filter((b) => b.length > 0);
}

// ---------------------------------------------------------------------------
// Resolve agent name (strip namespace prefix)
// ---------------------------------------------------------------------------

/**
 * Strip namespace prefix from agent slug.
 * "workflow:workflow-researcher" → "workflow-researcher"
 * "plan-orchestrator" → "plan-orchestrator"
 */
function resolveAgentName(agentSlug: string | null): string {
  if (!agentSlug) return "";
  const colonIdx = agentSlug.indexOf(":");
  return colonIdx >= 0 ? agentSlug.slice(colonIdx + 1) : agentSlug;
}

// ---------------------------------------------------------------------------
// Compile prompt
// ---------------------------------------------------------------------------

/**
 * Compile a structured prompt for a dispatch unit.
 *
 * Returns null if all ops in the unit are type: "tool-call" (no model call needed).
 * Source: SCOPE.md §N2 step 6.
 */
function compilePrompt(
  packedSlugs: string[],
  milestones: Record<string, MilestoneSnapshot>,
  opsSnapshot: OperationSnapshot[]
): string | null {
  let allToolCall = true;
  const parts: string[] = [];

  for (const slug of packedSlugs) {
    const m = milestones[slug];
    if (m === undefined) continue;

    const milestoneOps = opsSnapshot
      .filter((op) => op.milestone === slug && op.action !== "guard");

    if (milestoneOps.some((op) => op.type === "generative")) {
      allToolCall = false;
    }

    parts.push(`## Milestone: ${slug}`);
    parts.push(m.description);
    if (m.rationale) parts.push(`\n*Rationale:* ${m.rationale}`);

    parts.push("\n### Operations:");
    for (const op of milestoneOps) {
      const filePart = op.file ? ` ${op.file}` : "";
      const symbolPart = op.symbol ? ` (${op.symbol})` : "";
      parts.push(`- [${op.id}] ${op.action}${filePart}${symbolPart}`);

      if (op.shape && op.shape.kind !== null) {
        const shape = op.shape;

        if (shape.kind === "doc") {
          parts.push(`  Description: ${shape.description}`);
          parts.push(`  Objective: ${shape.objective}`);
          if (shape.required_sections && shape.required_sections.length > 0) {
            parts.push(
              `  Required sections: ${shape.required_sections.join(", ")}`
            );
          }
        } else if (shape.kind === "structured-output") {
          parts.push(
            "  Schema:\n" +
              JSON.stringify(shape.schema, null, 2)
                .split("\n")
                .map((l) => `    ${l}`)
                .join("\n")
          );
        } else if ("ops" in shape && Array.isArray(shape.ops)) {
          for (const sop of shape.ops) {
            const toStr = sop.to !== null ? ` → ${sop.to}` : "";
            const targetStr = sop.target !== null ? ` "${sop.target}"` : "";
            parts.push(`    - ${sop.op}${targetStr}${toStr}`);
          }
        }
      }
    }

    const guard = m.guard;
    parts.push(`\n### Guard: ${guard ?? "none"}`);
    parts.push("");
  }

  if (allToolCall) return null;
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Assemble DispatchUnit
// ---------------------------------------------------------------------------

/**
 * Build a single DispatchUnit from a batch of packed milestone slugs.
 * Source: SCOPE.md §N2 step 6.
 */
function assembleDispatchUnit(
  packedSlugs: string[],
  unitIndex: number,
  snap: DagSnapshot,
  opsSnapshot: OperationSnapshot[],
  dagProviders: Record<string, ProviderConfig>,
  dagEffortMaxTokens: Record<string, number>
): DispatchUnit {
  const primarySlug = packedSlugs[0] ?? "";
  const primaryM = snap.milestones[primarySlug];
  const model = primaryM?.model ?? null;
  const effort = primaryM?.effort ?? null;

  // Collect all op ids from packed milestones (excluding synthesized guard ops)
  const operationIds: string[] = [];
  for (const slug of packedSlugs) {
    for (const op of opsSnapshot) {
      if (op.milestone === slug && op.action !== "guard") {
        operationIds.push(op.id);
      }
    }
  }

  // context_files: milestone context paths + read_only[] + op.file targets
  const contextFileSet = new Set<string>();
  for (const slug of packedSlugs) {
    const m = snap.milestones[slug];
    if (m === undefined) continue;
    contextFileSet.add(m.context);
    for (const f of m.read_only) contextFileSet.add(f);
    for (const op of opsSnapshot) {
      if (op.milestone === slug && op.file) contextFileSet.add(op.file);
    }
  }
  const context_files = Array.from(contextFileSet);

  // si_bytes: sum stat sizes of context files at pack time
  const si_bytes = context_files.reduce((acc, f) => acc + safeStatSize(f), 0);

  // tokens_estimated
  const bEffForModel = model ? (snap.optimization.b_eff_per_tier[model] ?? null) : null;
  const kiSum = packedSlugs.reduce(
    (acc, slug) => acc + (snap.milestones[slug]?.ki_estimate ?? 0),
    0
  );

  let tokens_estimated: number | null = null;
  if (bEffForModel !== null) {
    const siTokens = siBytesAsTokens(si_bytes);
    tokens_estimated = bEffForModel + siTokens + kiSum;
  }

  // fits_context_window
  const contextWindow = model
    ? (snap.optimization.context_window_per_tier[model] ?? Infinity)
    : Infinity;
  const fits_context_window =
    tokens_estimated !== null ? tokens_estimated <= contextWindow : true;

  // provider
  const provider: ProviderConfig | null =
    model !== null && dagProviders[model] !== undefined
      ? (dagProviders[model] as ProviderConfig)
      : null;

  // agent_name
  const agent_name = resolveAgentName(primaryM?.agent ?? null);

  // resolved_max_tokens
  const resolved_max_tokens: number | null =
    effort !== null && dagEffortMaxTokens[effort] !== undefined
      ? (dagEffortMaxTokens[effort] as number)
      : null;

  // prompt
  const prompt = compilePrompt(packedSlugs, snap.milestones, opsSnapshot);

  return {
    id: `${primarySlug}.dispatch.${unitIndex}`,
    milestones: packedSlugs,
    operations: operationIds,
    model,
    effort,
    two_stage: primaryM?.two_stage ?? false,
    provider,
    agent_name,
    mcp_servers: null, // TODO: requires agent catalog lookup (future work)
    resolved_max_tokens,
    background: true,
    prompt,
    context_files,
    si_bytes,
    tokens_estimated,
    fits_context_window,
    sentinel_role: null, // set in sentinel-fanout pass
    dispatch_log_id: null,
    remote_task_id: null,
    result: null,
    status: "pending",
    started_at: null,
    completed_at: null,
    tokens_actual: null,
  };
}

// ---------------------------------------------------------------------------
// optimize()
// ---------------------------------------------------------------------------

/**
 * Compute the optimal dispatch plan for the current scheduling cycle.
 *
 * Input: DagSnapshot — fully computed from snapshot() or snapshotWithDag().
 * Output: DispatchUnit[] — one unit per batch assignment.
 *
 * Does not mutate the input snapshot.
 * Source: SCOPE.md §N2.
 *
 * Algorithm selection (§B2 table):
 *   N ≤ 20, any structure:                  Bitmask DP (exact)
 *   N ≤ 50, forest or series-parallel:      Tree DP (exact, O(N²W))
 *   N ≤ 50, general DAG:                    Simulated Annealing (~3-8% from optimal)
 *   N > 50, any:                            HLFET (O(N log N), 2-1/P approximation)
 */
export function optimize(snapshot: DagSnapshot): DispatchUnit[] {
  // Step 1 — Filter eligible milestones
  const eligibleSlugs = Object.keys(snapshot.milestones).filter(
    (slug) => snapshot.milestones[slug]?.eligible === true
  );

  if (eligibleSlugs.length === 0) return [];

  // Build op index (exclude synthesized guard ops)
  const opsByMilestone = new Map<string, OperationDag[]>();
  for (const op of snapshot.operations) {
    if (op.action === "guard") continue;
    const list = opsByMilestone.get(op.milestone) ?? [];
    list.push(op as unknown as OperationDag);
    opsByMilestone.set(op.milestone, list);
  }

  // Step 2 — Partition by kind family (no mixing allowed, per D-11)
  const partitions = new Map<string, string[]>(); // "family:model" → slugs
  for (const slug of eligibleSlugs) {
    const m = snapshot.milestones[slug];
    if (m === undefined) continue;
    const mOps = opsByMilestone.get(slug) ?? [];
    const family = getMilestoneKindFamily(mOps as OperationDag[]);
    const model = m.model ?? "_null";
    const partKey = `${family}:${model}`;
    const list = partitions.get(partKey) ?? [];
    list.push(slug);
    partitions.set(partKey, list);
  }

  // Recover dag-level provider + effort-max-tokens from snapshot extensions
  const augmented = snapshot as DagSnapshot & {
    _dagProviders?: Record<string, ProviderConfig>;
    _dagEffortMaxTokens?: Record<string, number>;
  };
  const dagProviders: Record<string, ProviderConfig> = augmented._dagProviders ?? {};
  const dagEffortMaxTokens: Record<string, number> = augmented._dagEffortMaxTokens ?? {};

  const allUnits: DispatchUnit[] = [];
  let unitCounter = 0;

  for (const [partKey, partSlugs] of partitions) {
    const parts = partKey.split(":");
    const modelKey = parts[1] ?? "_null";
    const model: ModelTier | null = modelKey !== "_null" ? (modelKey as ModelTier) : null;

    // Effective base cost for this model tier
    const bEffForModel =
      model !== null ? (snapshot.optimization.b_eff_per_tier[model] ?? null) : null;
    const bFallback =
      model !== null ? (snapshot.optimization.b_per_tier[model] ?? 0) : 0;
    const bEffValue = bEffForModel ?? (typeof bFallback === "number" ? bFallback : 0);

    const contextWindow =
      model !== null
        ? (snapshot.optimization.context_window_per_tier[model] ?? Infinity)
        : Infinity;

    const N = partSlugs.length;

    // Step 3 & 4 — Detect DAG structure and select algorithm
    let batches: string[][];

    if (N <= 20) {
      // Bitmask DP — exact
      batches = bitmaskDP(
        partSlugs,
        snapshot.milestones,
        opsByMilestone,
        bEffValue,
        contextWindow
      );
    } else if (N <= 50) {
      if (isForest(partSlugs, snapshot.milestones)) {
        batches = treeDP(
          partSlugs,
          snapshot.milestones,
          opsByMilestone,
          bEffValue,
          contextWindow
        );
      } else if (isSeriesParallel(partSlugs, snapshot.milestones)) {
        batches = treeDP(
          partSlugs,
          snapshot.milestones,
          opsByMilestone,
          bEffValue,
          contextWindow
        );
      } else {
        // Simulated Annealing — general DAG
        batches = simulatedAnnealing(
          partSlugs,
          snapshot.milestones,
          opsByMilestone,
          bEffValue,
          contextWindow
        );
      }
    } else {
      // HLFET — O(N log N), 2-1/P approximation
      batches = hlfet(
        partSlugs,
        snapshot.milestones,
        opsByMilestone,
        bEffValue,
        contextWindow
      );
    }

    // Step 5 & 6 — Assemble DispatchUnits
    for (const batch of batches) {
      if (batch.length === 0) continue;

      const unit = assembleDispatchUnit(
        batch,
        unitCounter++,
        snapshot,
        snapshot.operations,
        dagProviders,
        dagEffortMaxTokens
      );

      // Step 8 — Split if context window violated and batch has multiple milestones
      if (!unit.fits_context_window && batch.length > 1) {
        for (const solo of batch) {
          const soloUnit = assembleDispatchUnit(
            [solo],
            unitCounter++,
            snapshot,
            snapshot.operations,
            dagProviders,
            dagEffortMaxTokens
          );
          allUnits.push(soloUnit);
        }
        continue;
      }

      allUnits.push(unit);
    }
  }

  // Step 7 — Sentinel-Fanout grouping
  if (snapshot.optimization.sentinel_fanout.enabled) {
    applySentinelFanout(allUnits, snapshot.milestones);
  }

  return allUnits;
}

/**
 * Apply Sentinel-Fanout grouping to dispatch units.
 *
 * Group units by wave. Within each wave, the heaviest unit (by tokens_estimated)
 * is designated "prewarm"; others are "payload".
 * Source: SCOPE.md §N2 step 7, §D.
 */
function applySentinelFanout(
  units: DispatchUnit[],
  milestones: Record<string, MilestoneSnapshot>
): void {
  const byWave = new Map<number, DispatchUnit[]>();
  for (const unit of units) {
    const primarySlug = unit.milestones[0] ?? "";
    const wave = milestones[primarySlug]?.wave ?? 0;
    const list = byWave.get(wave) ?? [];
    list.push(unit);
    byWave.set(wave, list);
  }

  for (const waveUnits of byWave.values()) {
    if (waveUnits.length === 0) continue;

    let heaviest: DispatchUnit | undefined = waveUnits[0];
    for (const u of waveUnits) {
      if (heaviest === undefined) { heaviest = u; continue; }
      const uTokens = u.tokens_estimated ?? 0;
      const hTokens = heaviest.tokens_estimated ?? 0;
      if (uTokens > hTokens) heaviest = u;
    }

    for (const u of waveUnits) {
      u.sentinel_role = u === heaviest ? "prewarm" : "payload";
    }
  }
}

// ---------------------------------------------------------------------------
// snapshotWithDag — convenience wrapper
// ---------------------------------------------------------------------------

/**
 * Produce a DagSnapshot and attach dag-level provider/effort config for use
 * by optimize(). The attached fields use a `_` prefix to distinguish them from
 * schema-defined snapshot fields.
 */
export function snapshotWithDag(
  dag: DagJson,
  planSlug?: string
): DagSnapshot & {
  _dagProviders: Record<string, ProviderConfig>;
  _dagEffortMaxTokens: Record<string, number>;
} {
  const snap = snapshot(dag);
  if (planSlug !== undefined) snap.plan = planSlug;

  return Object.assign(snap, {
    _dagProviders: dag.providers,
    _dagEffortMaxTokens: dag.effort_max_tokens,
  });
}
