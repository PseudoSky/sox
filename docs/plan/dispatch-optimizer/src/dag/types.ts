/**
 * dag/types.ts — Complete TypeScript type definitions for the plan dispatch optimizer.
 *
 * Source of truth: docs/plan/dispatch-optimizer/PROPOSED_DAG_STRUCTURE.md
 * Every type mirrors the annotated schema exactly.
 *
 * Field annotation glossary (matches schema):
 *   dag          — authored in dag.json, never derived
 *   derived      — computed deterministically from other fields
 *   scheduler    — assigned by topological sort / wave-packing
 *   optimizer    — produced by optimize() only
 *   clock        — system timestamp at snapshot regen time
 */

// ---------------------------------------------------------------------------
// Primitive discriminants
// ---------------------------------------------------------------------------

export type OperationType = "tool-call" | "generative";

export type OperationAction =
  | "create"
  | "delete"
  | "move"
  | "rename"
  | "modify-signature"
  | "modify-body"
  | "add-export"
  | "remove-export"
  | "guard"
  | "exec"
  | "dag.add-milestone"
  | "dag.set-field"
  | "dag.clear-pending"
  | "dag.append-dispatch-log"
  | "fs.move"
  | "fs.delete"
  | "fs.scaffold";

/** Write-class actions whose file target becomes a milestone artifact. */
export const WRITE_CLASS_ACTIONS: ReadonlySet<OperationAction> = new Set([
  "create",
  "modify-signature",
  "modify-body",
  "add-export",
  "remove-export",
  "rename",
]);

export type CodeKind =
  | "function"
  | "interface"
  | "type"
  | "class"
  | "enum"
  | "const"
  | "script";

export type ConfigKind = "config" | "env" | "schema" | "manifest";

export type ShapeKind =
  | CodeKind
  | ConfigKind
  | "doc"
  | "structured-output";

/** Kind family buckets used by the optimizer's partition step. */
export type KindFamily = "code-config" | "doc" | "structured" | "tool-call";

export type MilestoneStatus =
  | "pending"
  | "pending-surfaced"
  | "in_progress"
  | "complete"
  | "failed"
  | "skipped";

export type DispatchUnitStatus = "pending" | "in_progress" | "complete" | "failed";

export type GuardResult = "pass" | "fail";
export type MilestoneGuardResult = "pass" | "fail" | "pending";

export type Provenance = "gitnexus" | "manual" | "assumed" | "vendored";
export type Confidence = "verified" | "vendored" | "documented" | "assumed";
export type KiSource = "estimate" | "calibrated" | "actual";
export type OperationStatus = "pending" | "in_progress" | "complete" | "failed" | "skipped";
export type DispatchKind = "planning" | "execution" | "guard" | "replan" | "correction";
export type ProviderType = "anthropic" | "openai" | "claudecli";
export type SentinelRole = "prewarm" | "payload";

export type ModelTier = "Haiku" | "Sonnet" | "Opus";
export type EffortTier = "low" | "medium" | "high" | "xhigh" | "max";
export type PlanKind = "brownfield" | "greenfield";

// ---------------------------------------------------------------------------
// Shape ops (structural mutation spec for code/config kinds)
// ---------------------------------------------------------------------------

export type ShapeOpType =
  | "add-param"
  | "remove-param"
  | "rename-param"
  | "retype-param"
  | "change-param-optional"
  | "reorder-params"
  | "change-return"
  | "add-field"
  | "remove-field"
  | "rename-field"
  | "retype-field"
  | "change-field-optional"
  | "add-generic"
  | "remove-generic"
  | "constrain-generic"
  | "add-extends"
  | "remove-extends"
  | "set-key"
  | "remove-key"
  | "rename-key"
  | "add-array-item"
  | "remove-array-item"
  | "add-var"
  | "remove-var"
  | "rename-var"
  | "change-default"
  | "add-section"
  | "remove-section"
  | "rename-section"
  | "update-section"
  | "add-table"
  | "remove-table"
  | "add-column"
  | "remove-column"
  | "rename-column"
  | "retype-column"
  | "change-nullable"
  | "add-index"
  | "remove-index"
  | "add-entry"
  | "remove-entry"
  | "update-entry"
  | "bump-version"
  | "update-checksum";

/** Dag-authored shape op (no derived fields). */
export interface ShapeOpDag {
  op: ShapeOpType;
  target: string | null;
  to: string | null;
  position: number | null;
  required: boolean | null;
}

/**
 * Snapshot-enriched shape op adds derived gitnexus fields.
 * `from`, `breaking`, `severity` are stubs (gitnexus integration is future work).
 */
export interface ShapeOpSnapshot extends ShapeOpDag {
  /** derived — baseline value from prior completed op or AST read. TODO: gitnexus */
  from: string | null;
  /** derived — deterministic breaking-change lookup table. TODO: gitnexus */
  breaking: boolean | null;
  /** derived — same lookup pass as breaking. TODO: gitnexus */
  severity: "error" | "warning" | "info" | null;
}

// ---------------------------------------------------------------------------
// Shape (polymorphic on kind)
// ---------------------------------------------------------------------------

/** Shape for code kinds (function|interface|type|class|enum|const|script). */
export interface ShapeCode {
  kind: CodeKind;
  ops: ShapeOpDag[];
  description?: null;
  objective?: null;
  required_sections?: null;
  schema?: null;
}

/** Shape for config kinds (config|env|schema|manifest). */
export interface ShapeConfig {
  kind: ConfigKind;
  ops: ShapeOpDag[];
  description?: null;
  objective?: null;
  required_sections?: null;
  schema?: null;
}

/** Shape for doc kind. description and objective are required. */
export interface ShapeDoc {
  kind: "doc";
  ops?: null;
  description: string;
  objective: string;
  required_sections: string[];
  schema?: null;
}

/** Shape for structured-output kind. */
export interface ShapeStructuredOutput {
  kind: "structured-output";
  ops?: null;
  description?: null;
  objective?: null;
  required_sections?: null;
  schema: Record<string, unknown>;
}

/** Shape for no-shape operations (tool-call type). */
export interface ShapeNull {
  kind: null;
  ops?: null;
  description?: null;
  objective?: null;
  required_sections?: null;
  schema?: null;
}

export type Shape =
  | ShapeCode
  | ShapeConfig
  | ShapeDoc
  | ShapeStructuredOutput
  | ShapeNull;

/** Snapshot-enriched shape ops (code/config kinds only). */
export interface ShapeCodeSnapshot extends Omit<ShapeCode, "ops"> {
  ops: ShapeOpSnapshot[];
}

export interface ShapeConfigSnapshot extends Omit<ShapeConfig, "ops"> {
  ops: ShapeOpSnapshot[];
}

export type ShapeSnapshot =
  | ShapeCodeSnapshot
  | ShapeConfigSnapshot
  | ShapeDoc
  | ShapeStructuredOutput
  | ShapeNull;

// ---------------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------------

export interface RetryConfig {
  retries: number;
  min_timeout: number;
  max_timeout: number;
  factor: number;
}

export interface ProviderConfig {
  type: ProviderType;
  model_id: string;
  /** Name of ADHD_AGENT_*_SECRET env var — never the key value itself. Null for claudecli. */
  env_secret: string | null;
  /** Null = provider default. Set for OpenAI-compatible local servers. */
  base_url: string | null;
  timeout_ms: number;
  retry_config: RetryConfig;
}

// ---------------------------------------------------------------------------
// Dispatch log
// ---------------------------------------------------------------------------

export interface Turn {
  turn: number;
  input_tokens: number;
  output_tokens: number;
  /** ISO timestamp when this turn completed. */
  t: string;
}

export interface DispatchResult {
  op_id: string;
  status: "complete" | "failed" | "skipped";
  guard_result: GuardResult | null;
  guard_output: string | null;
  guard_ran_at: string | null;
}

export interface DispatchNote {
  level: "info" | "warn" | "error";
  text: string;
}

export interface DispatchLogEntry {
  id: string;
  kind: DispatchKind;
  provider: "anthropic" | "openai" | "deepseek" | "google" | "local";
  model: string | null;
  agent: string;
  effort: EffortTier | null;
  started_at: string;
  completed_at: string | null;
  /** Op ids packed into this dispatch, in execution order. */
  operations: string[];
  turns: Turn[];
  results: DispatchResult[];
  notes: DispatchNote[];
}

// ---------------------------------------------------------------------------
// Operation (dag-authored form)
// ---------------------------------------------------------------------------

export interface OperationDag {
  id: string;
  /** Milestone slug this operation belongs to. */
  milestone: string;
  depends_on: string[];
  type: OperationType;
  action: OperationAction;
  file: string | null;
  symbol: string | null;
  provenance: Provenance | null;
  confidence: Confidence | null;
  audit_check: string | null;
  criteria: string[];
  /** tool-call only. */
  tool: string | null;
  /** tool-call only. */
  args: Record<string, unknown> | null;
  guard: string | null;
  to_file: string | null;
  to_symbol: string | null;
  ki_estimate: number | null;
  ki_source: KiSource | null;
  authored_by: string;
  /** Fast-path status cache; written by orchestrator after each dispatch closes. */
  status: OperationStatus;
  shape: Shape | null;
}

// ---------------------------------------------------------------------------
// Operation (snapshot-enriched form)
// ---------------------------------------------------------------------------

/**
 * Conflict record assigned by the scheduler during wave-candidate analysis.
 * Stubbed: requires same-wave op-key collision scan (future work).
 */
export interface OperationConflict {
  detected: boolean;
  competing_op: string | null;
  op_key: string | null;
  resolution: "safe-merge" | "warning" | "error" | null;
}

/**
 * Blast radius entry — one per affected symbol in upstream consumers.
 * Stubbed: populated via gitnexus_impact (future work).
 */
export interface BlastRadiusEntry {
  file: string;
  symbol: string;
  impact:
    | "implements"
    | "calls"
    | "imports"
    | "extends"
    | "re-exports"
    | "overrides";
  consumer: "current" | "future";
}

export interface OperationSnapshot extends OperationDag {
  shape: ShapeSnapshot | null;

  /** derived — ids of all dispatch_log entries whose operations[] includes this op id. */
  dispatch_ids: string[];
  /**
   * derived — count(dispatch_ids); > 1 indicates retries.
   * TODO: stubbed as 0 — op-level dispatch log scan is not yet implemented.
   */
  attempt_count: number;
  /** derived — guard_result from latest dispatch result with a non-null guard_result. */
  guard_result: GuardResult | null;
  /** derived — guard_output from the same results entry. */
  guard_output: string | null;
  /** derived — guard_ran_at from the same results entry. */
  guard_ran_at: string | null;

  /**
   * derived — gitnexus_impact for current consumers; cross-op scan for future.
   * TODO: stubbed as [] — requires gitnexus MCP call (future work).
   */
  blast_radius: BlastRadiusEntry[];

  /**
   * scheduler — op-key collision scan.
   * TODO: stubbed as empty conflict — requires same-wave scan (future work).
   */
  conflict: OperationConflict;

  /** derived — prorated token actual from dispatch turn totals. */
  tokens_actual: number | null;
}

// ---------------------------------------------------------------------------
// Milestone (dag-authored form)
// ---------------------------------------------------------------------------

export interface MilestoneDag {
  description: string;
  rationale?: string;
  authored_by: string;
  /** Dispatch gate. null = ready. Non-null = blocked on this question. */
  pending: string | null;
  triggered_by: string | null;
  phase: string;
  depends_on: string[];
  /** Null inherits plan-level executor. */
  agent: string | null;
  model: ModelTier | null;
  effort: EffortTier | null;
  two_stage: boolean;
  read_only: string[];
  guard: string | null;
}

// ---------------------------------------------------------------------------
// Pairwise overlap
// ---------------------------------------------------------------------------

/**
 * pairwise_overlap — maps slug pairs to byte overlap.
 * Key format: "${slugA}:${slugB}" where slugA < slugB alphabetically.
 * Value is 0 for prospective overlap (files not on disk) or sum(stat.size) for actual.
 */
export type PairwiseOverlapMap = Record<string, number>;

// ---------------------------------------------------------------------------
// Open question
// ---------------------------------------------------------------------------

export interface OpenQuestion {
  /** derived — stable id: "q:<slug>" */
  id: string;
  /** dag — verbatim text from milestone.pending */
  text: string;
  /** dag — milestone slug whose pending field this came from */
  blocking: string;
  /** derived — true when blocking milestone has status == "pending-surfaced" */
  surfaced: boolean;
  /** derived — dispatch_log entry id where question first appeared */
  raised_at_dispatch: string | null;
  /** derived — turn number within that dispatch */
  raised_at_turn: number | null;
  /** dag — false until a replan/correction clears milestone.pending */
  answered: boolean;
  /** dag — null until answered */
  answer: string | null;
}

// ---------------------------------------------------------------------------
// Milestone (snapshot-enriched form)
// ---------------------------------------------------------------------------

export interface MilestoneSnapshot extends MilestoneDag {
  /** derived — path where orchestrator writes the generated context doc. */
  context: string;

  /** scheduler — wave number assigned by topological sort. */
  wave: number;

  /**
   * derived — D-07 eligibility invariant (binding):
   *   pending == null
   *   AND all deps have status == "complete"
   *   AND no dep has status == "failed"
   */
  eligible: boolean;

  /** derived — computed from ops and dispatch_log. */
  status: MilestoneStatus;

  /** derived — min(dispatch_log[id].started_at) for dispatches touching this milestone. */
  started_at: string | null;

  /** derived — guard_ran_at from the dispatch_log entry where guard passed. */
  completed_at: string | null;

  /** derived — from latest guard op result (null if no guard configured). */
  guard_result: MilestoneGuardResult | null;

  /** derived — guard_output from same results entry. */
  guard_output: string | null;

  /** derived — union of op.file for write-class actions + to_file for move actions. */
  artifacts: string[];

  /** derived — sum(stat(f).size for f in artifacts); 0 if files don't exist. */
  si_bytes: number;

  /** derived — sum(ki_estimate for all ops in this milestone), applying §C3 heuristics for null. */
  ki_estimate: number | null;

  /**
   * derived — b_eff_per_tier[resolved_model] + si_bytes_as_tokens + ki_estimate.
   * Null if any input is null (b_eff null or ki_estimate null).
   */
  tokens_estimated: number | null;

  /** derived — sum of token actuals from completed dispatches. */
  tokens_actual: number | null;
}

// ---------------------------------------------------------------------------
// DagJson — the authored document (dag.json on disk)
// ---------------------------------------------------------------------------

export interface SentinelFanoutConfig {
  enabled: boolean;
  write_multiplier: number;
  read_multiplier: number;
  hit_probability: number;
}

export interface OptimizationConfig {
  sentinel_fanout: SentinelFanoutConfig;
  b_per_tier: Record<string, number | null>;
  context_window_per_tier: Record<string, number>;
  context_window_override: Record<string, number> | null;
  b_override: Record<string, number> | null;
}

export interface DagJson {
  schema_version: number;
  plan_kind: PlanKind;
  description: string;
  problem: string;
  approach: string;
  executor: string;
  executor_model?: ModelTier;
  executor_effort?: EffortTier;
  phases: string[];
  terminal: string | string[];
  assumed_baseline?: string[] | Record<string, unknown>;
  optimization: OptimizationConfig;
  providers: Record<string, ProviderConfig>;
  effort_max_tokens: Record<string, number>;
  milestones: Record<string, MilestoneDag>;
  /** operations[] in dag.json — may be array or Record; normalized on read. */
  operations: OperationDag[] | Record<string, OperationDag>;
  dispatch_log: DispatchLogEntry[];
}

// ---------------------------------------------------------------------------
// DagSnapshot — fully compiled execution view
// ---------------------------------------------------------------------------

export interface SnapshotOptimization {
  sentinel_fanout: SentinelFanoutConfig;
  context_window_override: Record<string, number> | null;
  b_override: Record<string, number> | null;
  b_per_tier: Record<string, number | null>;
  /** derived — b_per_tier[tier] × ((1−p)×w + p×r); null when b_per_tier[tier] null. */
  b_eff_per_tier: Record<string, number | null>;
  context_window_per_tier: Record<string, number>;
}

export interface DagSnapshot {
  /** clock — ISO timestamp of this regen pass. */
  snapshot_at: string;
  /** derived — monotonically increasing integer. */
  snapshot_version: number;
  /** dag — directory name. */
  plan: string;

  schema_version: number;
  plan_kind: PlanKind;
  description: string;
  problem: string;
  approach: string;
  executor: string;
  executor_model?: ModelTier;
  executor_effort?: EffortTier;
  phases: string[];
  terminal: string | string[];
  assumed_baseline?: string[] | Record<string, unknown>;

  optimization: SnapshotOptimization;

  /** All milestone slugs in topological order (scheduler). */
  milestones: Record<string, MilestoneSnapshot>;

  /** All operations, including synthesized guard ops. */
  operations: OperationSnapshot[];

  pairwise_overlap: PairwiseOverlapMap;

  /** optimizer — created by optimize(); not part of snapshot() output. */
  dispatch_units?: DispatchUnit[];

  open_questions: OpenQuestion[];
}

// ---------------------------------------------------------------------------
// DispatchUnit — optimizer output
// ---------------------------------------------------------------------------

export interface DispatchUnit {
  /** optimizer — "primary-slug.dispatch.N" */
  id: string;
  /** optimizer — milestone slugs packed into this unit. */
  milestones: string[];
  /** optimizer — op ids in execution order. */
  operations: string[];

  model: ModelTier | null;
  effort: EffortTier | null;
  two_stage: boolean;

  /** optimizer — dag.providers[milestone.model] copied verbatim. */
  provider: ProviderConfig | null;
  /** optimizer — resolved from milestone.agent (namespace prefix stripped). */
  agent_name: string;
  /**
   * optimizer — from agent catalog entry.
   * TODO: stubbed as null — requires agent catalog lookup (future work).
   */
  mcp_servers: null;
  /** optimizer — dag.effort_max_tokens[milestone.effort]. */
  resolved_max_tokens: number | null;
  /** optimizer — always true. */
  background: true;

  /**
   * optimizer — pre-compiled prompt string.
   * Null if all ops in this unit are type: "tool-call" (no model call needed).
   */
  prompt: string | null;
  /** optimizer — files read to assemble the prompt. */
  context_files: string[];
  /** derived — sum(stat(f).size for f in context_files) at pack time. */
  si_bytes: number;
  /** derived — b_eff_per_tier[model] + si_bytes_as_tokens + sum(ki_estimate for ops). */
  tokens_estimated: number | null;
  /** derived — tokens_estimated <= context_window_per_tier[model]. */
  fits_context_window: boolean;

  /**
   * optimizer — Sentinel-Fanout role within its wave window.
   * null when sentinel_fanout.enabled is false.
   */
  sentinel_role: SentinelRole | null;

  dispatch_log_id: string | null;
  remote_task_id: string | null;
  result: string | null;
  status: DispatchUnitStatus;
  started_at: string | null;
  completed_at: string | null;
  tokens_actual: number | null;
}
