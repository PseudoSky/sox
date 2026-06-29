/**
 * dag/validate.ts — Structural validators for dag.json and snapshot output.
 *
 * validateDagJson:    checks required top-level fields, milestone integrity,
 *                     operation references, and basic type constraints.
 * validateSnapshot:   checks derived-field invariants mandated by DECISIONS.md
 *                     (D-07 eligible/pending, valid statuses, etc.).
 *
 * Both functions use assertion signatures so TypeScript narrows the type in
 * the calling scope after a successful call.
 */

import type {
  DagJson,
  DagSnapshot,
  MilestoneStatus,
  OperationStatus,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function err(context: string, field: string, value: unknown): never {
  throw new Error(
    `Validation error [${context}]: "${field}" is invalid — got ${JSON.stringify(value)}`
  );
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

const VALID_MILESTONE_STATUSES: ReadonlySet<string> = new Set<MilestoneStatus>([
  "pending",
  "pending-surfaced",
  "in_progress",
  "complete",
  "failed",
  "skipped",
]);

const VALID_OPERATION_STATUSES: ReadonlySet<string> = new Set<OperationStatus>([
  "pending",
  "in_progress",
  "complete",
  "failed",
  "skipped",
]);

// ---------------------------------------------------------------------------
// validateDagJson
// ---------------------------------------------------------------------------

/**
 * Assert that `dag` is a structurally valid DagJson.
 *
 * Checks:
 *   - Required top-level string fields exist.
 *   - `milestones` is an object with at least one entry; each milestone has
 *     required fields (description, depends_on array).
 *   - `operations` is an array or object; each operation has required fields
 *     (id, milestone ref that exists in milestones).
 *   - `dispatch_log` is an array.
 *   - `optimization`, `providers`, `effort_max_tokens` are objects.
 *
 * @throws {Error} with a descriptive message if validation fails.
 */
export function validateDagJson(dag: unknown): asserts dag is DagJson {
  const ctx = "dag.json";
  if (!isObject(dag)) {
    throw new Error(`Validation error [${ctx}]: root must be an object`);
  }

  // Required scalar fields
  for (const field of [
    "description",
    "problem",
    "approach",
    "executor",
  ] as const) {
    const v = dag[field];
    if (!isString(v) || v.trim() === "") {
      err(ctx, field, v);
    }
  }

  // phases
  if (!Array.isArray(dag["phases"])) {
    err(ctx, "phases", dag["phases"]);
  }

  // terminal
  if (
    !isString(dag["terminal"]) &&
    !Array.isArray(dag["terminal"])
  ) {
    err(ctx, "terminal", dag["terminal"]);
  }

  // optimization — inject backward-compat defaults if missing (older dag.json files)
  if (dag["optimization"] === undefined) {
    (dag as Record<string, unknown>)["optimization"] = {
      sentinel_fanout: {
        enabled: true,
        write_multiplier: 1.25,
        read_multiplier: 0.10,
        hit_probability: 0.90,
      },
      b_per_tier: {},
      context_window_per_tier: {},
      context_window_override: null,
      b_override: null,
    };
  } else if (!isObject(dag["optimization"])) {
    err(ctx, "optimization", dag["optimization"]);
  }

  // providers — inject empty object if missing (backward compat)
  if (dag["providers"] === undefined) {
    (dag as Record<string, unknown>)["providers"] = {};
  } else if (!isObject(dag["providers"])) {
    err(ctx, "providers", dag["providers"]);
  }

  // effort_max_tokens — inject empty object if missing (backward compat)
  if (dag["effort_max_tokens"] === undefined) {
    (dag as Record<string, unknown>)["effort_max_tokens"] = {};
  } else if (!isObject(dag["effort_max_tokens"])) {
    err(ctx, "effort_max_tokens", dag["effort_max_tokens"]);
  }

  // dispatch_log
  if (!Array.isArray(dag["dispatch_log"])) {
    err(ctx, "dispatch_log", dag["dispatch_log"]);
  }

  // milestones
  const milestonesRaw = dag["milestones"];
  if (!isObject(milestonesRaw)) {
    err(ctx, "milestones", milestonesRaw);
  }

  const milestoneKeys = Object.keys(milestonesRaw);
  if (milestoneKeys.length === 0) {
    throw new Error(
      `Validation error [${ctx}]: "milestones" must have at least one entry`
    );
  }

  for (const slug of milestoneKeys) {
    const m = milestonesRaw[slug];
    if (!isObject(m)) {
      err(`${ctx}.milestones.${slug}`, "(milestone)", m);
    }
    const mObj = m as Record<string, unknown>;

    // required milestone fields
    if (!isString(mObj["description"]) || (mObj["description"] as string).trim() === "") {
      err(`${ctx}.milestones.${slug}`, "description", mObj["description"]);
    }
    if (!Array.isArray(mObj["depends_on"])) {
      err(`${ctx}.milestones.${slug}`, "depends_on", mObj["depends_on"]);
    }
    // validate dep references
    for (const dep of mObj["depends_on"] as unknown[]) {
      if (!isString(dep)) {
        err(`${ctx}.milestones.${slug}.depends_on`, "(entry)", dep);
      }
      if (!(dep in milestonesRaw)) {
        throw new Error(
          `Validation error [${ctx}.milestones.${slug}.depends_on]: ` +
            `references unknown milestone "${dep}"`
        );
      }
    }
  }

  // operations — may be array or object
  const opsRaw = dag["operations"];
  let opsArray: unknown[];
  if (Array.isArray(opsRaw)) {
    opsArray = opsRaw;
  } else if (isObject(opsRaw)) {
    opsArray = Object.values(opsRaw);
  } else {
    err(ctx, "operations", opsRaw);
    opsArray = []; // unreachable; satisfies TypeScript
  }

  for (const op of opsArray) {
    if (!isObject(op)) {
      err(`${ctx}.operations`, "(entry)", op);
    }
    const opObj = op as Record<string, unknown>;

    if (!isString(opObj["id"])) {
      err(`${ctx}.operations[?]`, "id", opObj["id"]);
    }
    const opId = opObj["id"] as string;

    if (!isString(opObj["milestone"])) {
      err(`${ctx}.operations[${opId}]`, "milestone", opObj["milestone"]);
    }
    const milestoneRef = opObj["milestone"] as string;
    if (!(milestoneRef in milestonesRaw)) {
      throw new Error(
        `Validation error [${ctx}.operations[${opId}]]: ` +
          `"milestone" references unknown slug "${milestoneRef}"`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// validateSnapshot
// ---------------------------------------------------------------------------

/**
 * Assert that `snapshot` is a structurally valid DagSnapshot with correct
 * derived-field invariants.
 *
 * Invariant checks (from DECISIONS.md):
 *   - D-07: No eligible milestone has pending != null.
 *   - All milestone statuses are valid enum members.
 *   - All operation statuses are valid enum members.
 *   - open_questions[].blocking references a real milestone slug.
 *   - fits_context_window in dispatch_units is a boolean (not null).
 *   - No null wave values (every milestone has a wave number).
 *
 * @throws {Error} with a descriptive message if any invariant is violated.
 */
export function validateSnapshot(snapshot: unknown): asserts snapshot is DagSnapshot {
  const ctx = "dag-snapshot";
  if (!isObject(snapshot)) {
    throw new Error(`Validation error [${ctx}]: root must be an object`);
  }

  // Required scalar fields
  for (const field of ["snapshot_at", "description"] as const) {
    if (!isString(snapshot[field])) {
      err(ctx, field, snapshot[field]);
    }
  }

  // milestones
  const milestonesRaw = snapshot["milestones"];
  if (!isObject(milestonesRaw)) {
    err(ctx, "milestones", milestonesRaw);
  }
  const milestoneKeys = Object.keys(milestonesRaw);

  for (const slug of milestoneKeys) {
    const m = milestonesRaw[slug] as Record<string, unknown>;
    const mCtx = `${ctx}.milestones.${slug}`;

    // D-07: eligible milestones must not have pending != null
    const eligible = m["eligible"];
    const pending = m["pending"];
    if (eligible === true && pending !== null && pending !== undefined) {
      throw new Error(
        `Validation error [${mCtx}]: D-07 violation — ` +
          `eligible=true but pending="${pending}" (pending must be null for eligible milestones)`
      );
    }

    // Valid status
    const status = m["status"];
    if (!isString(status) || !VALID_MILESTONE_STATUSES.has(status)) {
      err(mCtx, "status", status);
    }

    // Wave must be a non-negative integer
    const wave = m["wave"];
    if (typeof wave !== "number" || !Number.isInteger(wave) || wave < 0) {
      err(mCtx, "wave", wave);
    }

    // eligible must be boolean
    if (typeof eligible !== "boolean") {
      err(mCtx, "eligible", eligible);
    }
  }

  // operations
  const opsRaw = snapshot["operations"];
  if (!Array.isArray(opsRaw)) {
    err(ctx, "operations", opsRaw);
  }
  for (const op of opsRaw as unknown[]) {
    if (!isObject(op)) continue;
    const opObj = op as Record<string, unknown>;
    const opId = isString(opObj["id"]) ? opObj["id"] : "?";
    const status = opObj["status"];
    if (!isString(status) || !VALID_OPERATION_STATUSES.has(status)) {
      err(`${ctx}.operations[${opId}]`, "status", status);
    }
  }

  // open_questions
  const oqs = snapshot["open_questions"];
  if (!Array.isArray(oqs)) {
    err(ctx, "open_questions", oqs);
  }
  for (const oq of oqs as unknown[]) {
    if (!isObject(oq)) continue;
    const oqObj = oq as Record<string, unknown>;
    const blocking = oqObj["blocking"];
    if (!isString(blocking) || !(blocking in milestonesRaw)) {
      throw new Error(
        `Validation error [${ctx}.open_questions]: ` +
          `"blocking" references unknown milestone slug "${blocking}"`
      );
    }
    if (typeof oqObj["surfaced"] !== "boolean") {
      err(`${ctx}.open_questions[${oqObj["id"]}]`, "surfaced", oqObj["surfaced"]);
    }
    if (typeof oqObj["answered"] !== "boolean") {
      err(`${ctx}.open_questions[${oqObj["id"]}]`, "answered", oqObj["answered"]);
    }
  }

  // dispatch_units (optional, but if present, validate fits_context_window)
  const units = snapshot["dispatch_units"];
  if (units !== undefined) {
    if (!Array.isArray(units)) {
      err(ctx, "dispatch_units", units);
    }
    for (const unit of units as unknown[]) {
      if (!isObject(unit)) continue;
      const u = unit as Record<string, unknown>;
      const fits = u["fits_context_window"];
      if (typeof fits !== "boolean") {
        err(`${ctx}.dispatch_units[${u["id"]}]`, "fits_context_window", fits);
      }
    }
  }
}
