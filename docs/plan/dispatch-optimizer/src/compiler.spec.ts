/**
 * compiler.spec.ts — Red→green tests for BL-209 and the BL-105 stubs
 * implemented in this pass (conflict, tokens_actual per-op).
 *
 * Source of truth for the fixtures below: dag/types.ts (schema) and
 * SCOPE.md §N1 (derivation rules). Every fixture constructs the minimal
 * valid DagJson needed to exercise one derivation rule through the public
 * snapshot() entry point — no private functions are imported; this is a
 * black-box test of the compiler's documented contract.
 */
import { describe, expect, it } from "vitest";
import { snapshot } from "./compiler.js";
import type {
  DagJson,
  DispatchLogEntry,
  MilestoneDag,
  OperationDag,
  OperationSnapshot,
} from "./dag/types.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function baseDag(overrides: Partial<DagJson> = {}): DagJson {
  return {
    schema_version: 4,
    plan_kind: "greenfield",
    description: "test plan",
    problem: "test problem",
    approach: "test approach",
    executor: "workflow:test",
    phases: ["build"],
    terminal: "done",
    optimization: {
      sentinel_fanout: {
        enabled: true,
        write_multiplier: 1.25,
        read_multiplier: 0.1,
        hit_probability: 0.9,
      },
      b_per_tier: { Sonnet: 15000 },
      context_window_per_tier: { Sonnet: 16000 },
      context_window_override: null,
      b_override: null,
    },
    providers: {},
    effort_max_tokens: {},
    milestones: {},
    operations: [],
    dispatch_log: [],
    ...overrides,
  };
}

function milestone(overrides: Partial<MilestoneDag> = {}): MilestoneDag {
  return {
    description: "test milestone",
    authored_by: "human",
    pending: null,
    triggered_by: null,
    phase: "build",
    depends_on: [],
    agent: "workflow:test-agent",
    model: "Sonnet",
    effort: "medium",
    two_stage: false,
    read_only: [],
    guard: "true",
    ...overrides,
  };
}

function op(overrides: Partial<OperationDag> = {}): OperationDag {
  return {
    id: "op-1",
    milestone: "m1",
    depends_on: [],
    type: "generative",
    action: "modify-signature",
    file: "src/foo.ts",
    symbol: "foo",
    provenance: "manual",
    confidence: "documented",
    audit_check: null,
    criteria: [],
    tool: null,
    args: null,
    guard: null,
    to_file: null,
    to_symbol: null,
    ki_estimate: null,
    ki_source: null,
    authored_by: "human",
    status: "pending",
    shape: null,
    ...overrides,
  };
}

function dispatchEntry(
  overrides: Partial<DispatchLogEntry> = {}
): DispatchLogEntry {
  return {
    id: "d1",
    kind: "execution",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    agent: "test-agent",
    effort: "medium",
    started_at: "2026-07-01T00:00:00.000Z",
    completed_at: "2026-07-01T00:05:00.000Z",
    operations: [],
    turns: [],
    results: [],
    notes: [],
    ...overrides,
  };
}

function findOp(ops: OperationSnapshot[], id: string): OperationSnapshot {
  const found = ops.find((o) => o.id === id);
  if (!found) throw new Error(`op not found in snapshot: ${id}`);
  return found;
}

// ---------------------------------------------------------------------------
// BL-209 — attempt_count / attempt_count_confidence
// ---------------------------------------------------------------------------

describe("BL-209 — attempt_count disambiguates never-ran from unknown", () => {
  it("guard op: empty dispatch_log -> attempt_count 0, confidence 'verified' (genuinely never ran)", () => {
    const dag = baseDag({
      milestones: { m1: milestone() },
      operations: [op({ id: "m1.op1", milestone: "m1" })],
      dispatch_log: [],
    });

    const snap = snapshot(dag);
    const guardOp = findOp(snap.operations, "m1.guard");

    expect(guardOp.attempt_count).toBe(0);
    expect(guardOp.attempt_count_confidence).toBe("verified");
  });

  it("guard op: kind:'guard' entry present with a pass result -> attempt_count 1, confidence 'verified'", () => {
    const dag = baseDag({
      milestones: { m1: milestone() },
      operations: [op({ id: "m1.op1", milestone: "m1" })],
      dispatch_log: [
        dispatchEntry({
          id: "d1",
          kind: "guard",
          operations: ["m1.guard"],
          results: [
            {
              op_id: "m1.guard",
              status: "complete",
              guard_result: "pass",
              guard_output: "ok",
              guard_ran_at: "2026-07-01T00:05:00.000Z",
            },
          ],
        }),
      ],
    });

    const snap = snapshot(dag);
    const guardOp = findOp(snap.operations, "m1.guard");

    expect(guardOp.attempt_count).toBe(1);
    expect(guardOp.attempt_count_confidence).toBe("verified");
    expect(guardOp.guard_result).toBe("pass");
  });

  it("guard op: a non-guard-kind entry mentioning the guard id is NOT counted as a guard attempt (root cause of BL-209)", () => {
    const dag = baseDag({
      milestones: { m1: milestone() },
      operations: [op({ id: "m1.op1", milestone: "m1" })],
      dispatch_log: [
        // Loosely-modeled "execution" entry that happens to list the guard id
        // in operations[] — this must NOT inflate the guard's attempt_count.
        dispatchEntry({
          id: "d1",
          kind: "execution",
          operations: ["m1.op1", "m1.guard"],
          results: [],
        }),
        dispatchEntry({
          id: "d2",
          kind: "guard",
          operations: ["m1.guard"],
          results: [
            {
              op_id: "m1.guard",
              status: "complete",
              guard_result: "pass",
              guard_output: "ok",
              guard_ran_at: "2026-07-01T00:06:00.000Z",
            },
          ],
        }),
      ],
    });

    const snap = snapshot(dag);
    const guardOp = findOp(snap.operations, "m1.guard");

    // Only d2 (kind: "guard") counts — not 2.
    expect(guardOp.attempt_count).toBe(1);
    expect(guardOp.attempt_count_confidence).toBe("verified");
    // dispatch_ids stays broad (traceability) — both entries mentioned the id.
    expect(guardOp.dispatch_ids.sort()).toEqual(["d1", "d2"]);
  });

  it("guard op: an untyped (pre-convention) dispatch_log entry downgrades confidence to 'unknown' even though the filtered count is 0", () => {
    const untyped = dispatchEntry({ id: "d1", operations: ["m1.guard"] });
    // Simulate a pre-convention dag.json loaded from disk where `kind` is
    // absent at runtime despite the TS type marking it required.
    delete (untyped as unknown as Record<string, unknown>)["kind"];

    const dag = baseDag({
      milestones: { m1: milestone() },
      operations: [op({ id: "m1.op1", milestone: "m1" })],
      dispatch_log: [untyped],
    });

    const snap = snapshot(dag);
    const guardOp = findOp(snap.operations, "m1.guard");

    expect(guardOp.attempt_count).toBe(0);
    expect(guardOp.attempt_count_confidence).toBe("unknown");
  });

  it("authored op: a kind:'guard' entry mentioning the op id is NOT counted as an execution attempt", () => {
    const dag = baseDag({
      milestones: { m1: milestone() },
      operations: [op({ id: "m1.op1", milestone: "m1" })],
      dispatch_log: [
        dispatchEntry({ id: "d1", kind: "guard", operations: ["m1.op1"] }),
      ],
    });

    const snap = snapshot(dag);
    const authoredOp = findOp(snap.operations, "m1.op1");

    expect(authoredOp.attempt_count).toBe(0);
    expect(authoredOp.attempt_count_confidence).toBe("verified");
  });

  it("authored op: an execution-kind entry IS counted as a genuine attempt", () => {
    const dag = baseDag({
      milestones: { m1: milestone() },
      operations: [op({ id: "m1.op1", milestone: "m1" })],
      dispatch_log: [
        dispatchEntry({ id: "d1", kind: "execution", operations: ["m1.op1"] }),
        dispatchEntry({ id: "d2", kind: "correction", operations: ["m1.op1"] }),
      ],
    });

    const snap = snapshot(dag);
    const authoredOp = findOp(snap.operations, "m1.op1");

    expect(authoredOp.attempt_count).toBe(2);
    expect(authoredOp.attempt_count_confidence).toBe("verified");
  });
});

// ---------------------------------------------------------------------------
// BL-105 — conflict: same-wave op_key collision scan
// ---------------------------------------------------------------------------

describe("BL-105 (conflict) — same-wave op_key collision scan", () => {
  function shapeAddParam(to: string) {
    return {
      kind: "function" as const,
      ops: [
        {
          op: "add-param" as const,
          target: "options",
          to,
          position: null,
          required: true,
        },
      ],
    };
  }

  it("same op_key + same `to`, same wave, same (file,symbol) -> resolution 'safe-merge'", () => {
    const dag = baseDag({
      milestones: { m1: milestone(), m2: milestone() }, // both wave 0 (no deps)
      operations: [
        op({
          id: "m1.op1",
          milestone: "m1",
          shape: shapeAddParam("string"),
        }),
        op({
          id: "m2.op1",
          milestone: "m2",
          shape: shapeAddParam("string"),
        }),
      ],
    });

    const snap = snapshot(dag);
    const opA = findOp(snap.operations, "m1.op1");
    const opB = findOp(snap.operations, "m2.op1");

    expect(opA.conflict.detected).toBe(true);
    expect(opA.conflict.op_key).toBe("options::param-by-name");
    expect(opA.conflict.resolution).toBe("safe-merge");
    expect(opA.conflict.competing_op).toBe("m2.op1");

    expect(opB.conflict.detected).toBe(true);
    expect(opB.conflict.resolution).toBe("safe-merge");
    expect(opB.conflict.competing_op).toBe("m1.op1");
  });

  it("same op_key + different `to`, same wave -> resolution 'error'", () => {
    const dag = baseDag({
      milestones: { m1: milestone(), m2: milestone() },
      operations: [
        op({ id: "m1.op1", milestone: "m1", shape: shapeAddParam("string") }),
        op({ id: "m2.op1", milestone: "m2", shape: shapeAddParam("number") }),
      ],
    });

    const snap = snapshot(dag);
    const opA = findOp(snap.operations, "m1.op1");

    expect(opA.conflict.detected).toBe(true);
    expect(opA.conflict.op_key).toBe("options::param-by-name");
    expect(opA.conflict.resolution).toBe("error");
  });

  it("orthogonal op-category on the same (file,symbol) -> op_key differs, no conflict detected", () => {
    const dag = baseDag({
      milestones: { m1: milestone(), m2: milestone() },
      operations: [
        op({ id: "m1.op1", milestone: "m1", shape: shapeAddParam("string") }),
        op({
          id: "m2.op1",
          milestone: "m2",
          shape: {
            kind: "function",
            ops: [
              {
                op: "add-generic",
                target: "T",
                to: "unknown",
                position: null,
                required: null,
              },
            ],
          },
        }),
      ],
    });

    const snap = snapshot(dag);
    const opA = findOp(snap.operations, "m1.op1");
    const opB = findOp(snap.operations, "m2.op1");

    expect(opA.conflict.detected).toBe(false);
    expect(opB.conflict.detected).toBe(false);
  });

  it("same op_key but different waves -> no conflict (waves computed before the scan)", () => {
    const dag = baseDag({
      milestones: {
        m1: milestone(),
        // m2 depends on m1 -> wave 1, m1 stays wave 0.
        m2: milestone({ depends_on: ["m1"] }),
      },
      operations: [
        op({ id: "m1.op1", milestone: "m1", shape: shapeAddParam("string") }),
        op({ id: "m2.op1", milestone: "m2", shape: shapeAddParam("string") }),
      ],
    });

    const snap = snapshot(dag);
    const opA = findOp(snap.operations, "m1.op1");
    const opB = findOp(snap.operations, "m2.op1");

    expect(snap.milestones["m1"]?.wave).toBe(0);
    expect(snap.milestones["m2"]?.wave).toBe(1);
    expect(opA.conflict.detected).toBe(false);
    expect(opB.conflict.detected).toBe(false);
  });

  it("same op_key, same wave, but different (file,symbol) -> no conflict", () => {
    const dag = baseDag({
      milestones: { m1: milestone(), m2: milestone() },
      operations: [
        op({
          id: "m1.op1",
          milestone: "m1",
          file: "src/foo.ts",
          symbol: "foo",
          shape: shapeAddParam("string"),
        }),
        op({
          id: "m2.op1",
          milestone: "m2",
          file: "src/bar.ts",
          symbol: "bar",
          shape: shapeAddParam("string"),
        }),
      ],
    });

    const snap = snapshot(dag);
    const opA = findOp(snap.operations, "m1.op1");
    const opB = findOp(snap.operations, "m2.op1");

    expect(opA.conflict.detected).toBe(false);
    expect(opB.conflict.detected).toBe(false);
  });

  it("guard ops never participate in conflict detection", () => {
    const dag = baseDag({
      milestones: { m1: milestone(), m2: milestone() },
      operations: [
        op({ id: "m1.op1", milestone: "m1", shape: shapeAddParam("string") }),
        op({ id: "m2.op1", milestone: "m2", shape: shapeAddParam("string") }),
      ],
    });

    const snap = snapshot(dag);
    const guard1 = findOp(snap.operations, "m1.guard");
    const guard2 = findOp(snap.operations, "m2.guard");

    expect(guard1.conflict).toEqual({
      detected: false,
      competing_op: null,
      op_key: null,
      resolution: null,
    });
    expect(guard2.conflict).toEqual({
      detected: false,
      competing_op: null,
      op_key: null,
      resolution: null,
    });
  });
});

// ---------------------------------------------------------------------------
// BL-105 — tokens_actual: per-op ki_estimate-share proration
// ---------------------------------------------------------------------------

describe("BL-105 (tokens_actual) — per-op ki_estimate-share proration", () => {
  it("prorates the milestone's tokens_actual total across ops by ki_estimate share", () => {
    const dag = baseDag({
      milestones: { m1: milestone({ guard: "true" }) },
      operations: [
        op({ id: "m1.op1", milestone: "m1", ki_estimate: 100 }),
        op({ id: "m1.op2", milestone: "m1", ki_estimate: 300 }),
      ],
      dispatch_log: [
        dispatchEntry({
          id: "d1",
          kind: "execution",
          operations: ["m1.op1", "m1.op2"],
          started_at: "2026-07-01T00:00:00.000Z",
          completed_at: "2026-07-01T00:05:00.000Z",
          turns: [{ turn: 1, input_tokens: 200, output_tokens: 200, t: "2026-07-01T00:05:00.000Z" }],
          results: [
            { op_id: "m1.op1", status: "complete", guard_result: null, guard_output: null, guard_ran_at: null },
            { op_id: "m1.op2", status: "complete", guard_result: null, guard_output: null, guard_ran_at: null },
          ],
        }),
      ],
    });

    const snap = snapshot(dag);
    expect(snap.milestones["m1"]?.tokens_actual).toBe(400);

    const opA = findOp(snap.operations, "m1.op1");
    const opB = findOp(snap.operations, "m1.op2");

    // op1 has 1/4 of the ki_estimate share, op2 has 3/4.
    expect(opA.tokens_actual).toBe(100);
    expect(opB.tokens_actual).toBe(300);
  });

  it("returns null (not a fabricated even split) when ki_estimate sum is 0", () => {
    const dag = baseDag({
      milestones: { m1: milestone() },
      operations: [
        op({ id: "m1.op1", milestone: "m1", type: "tool-call", shape: null, ki_estimate: 0 }),
        op({ id: "m1.op2", milestone: "m1", type: "tool-call", shape: null, ki_estimate: 0 }),
      ],
      dispatch_log: [
        dispatchEntry({
          id: "d1",
          kind: "execution",
          operations: ["m1.op1", "m1.op2"],
          started_at: "2026-07-01T00:00:00.000Z",
          completed_at: "2026-07-01T00:05:00.000Z",
          turns: [{ turn: 1, input_tokens: 50, output_tokens: 50, t: "2026-07-01T00:05:00.000Z" }],
          results: [
            { op_id: "m1.op1", status: "complete", guard_result: null, guard_output: null, guard_ran_at: null },
            { op_id: "m1.op2", status: "complete", guard_result: null, guard_output: null, guard_ran_at: null },
          ],
        }),
      ],
    });

    const snap = snapshot(dag);
    expect(snap.milestones["m1"]?.tokens_actual).toBe(100);

    const opA = findOp(snap.operations, "m1.op1");
    const opB = findOp(snap.operations, "m1.op2");
    expect(opA.tokens_actual).toBeNull();
    expect(opB.tokens_actual).toBeNull();
  });

  it("returns null for every op when the milestone has no completed dispatches", () => {
    const dag = baseDag({
      milestones: { m1: milestone() },
      operations: [op({ id: "m1.op1", milestone: "m1", ki_estimate: 50 })],
      dispatch_log: [],
    });

    const snap = snapshot(dag);
    expect(snap.milestones["m1"]?.tokens_actual).toBeNull();

    const opA = findOp(snap.operations, "m1.op1");
    expect(opA.tokens_actual).toBeNull();
  });

  it("guard op tokens_actual is always 0 (tool-call, never consumes model tokens)", () => {
    const dag = baseDag({
      milestones: { m1: milestone() },
      operations: [
        op({
          id: "m1.op1",
          milestone: "m1",
          ki_estimate: 100,
        }),
      ],
      dispatch_log: [
        dispatchEntry({
          id: "d1",
          kind: "execution",
          operations: ["m1.op1"],
          started_at: "2026-07-01T00:00:00.000Z",
          completed_at: "2026-07-01T00:05:00.000Z",
          turns: [{ turn: 1, input_tokens: 50, output_tokens: 50, t: "2026-07-01T00:05:00.000Z" }],
          results: [
            { op_id: "m1.op1", status: "complete", guard_result: null, guard_output: null, guard_ran_at: null },
          ],
        }),
      ],
    });

    const snap = snapshot(dag);
    const guardOp = findOp(snap.operations, "m1.guard");
    expect(guardOp.tokens_actual).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// BL-105 — stubs intentionally left in place (regression guard, not "complete")
// ---------------------------------------------------------------------------

describe("BL-105 — stubs left in place stay honestly null/[] (no fabricated data)", () => {
  it("blast_radius, from/breaking/severity, mcp_servers, raised_at_* remain stubbed", () => {
    const dag = baseDag({
      milestones: { m1: milestone() },
      operations: [
        op({
          id: "m1.op1",
          milestone: "m1",
          shape: {
            kind: "function",
            ops: [
              { op: "add-param", target: "x", to: "string", position: null, required: true },
            ],
          },
        }),
      ],
    });

    const snap = snapshot(dag);
    const authoredOp = findOp(snap.operations, "m1.op1");

    expect(authoredOp.blast_radius).toEqual([]);
    const shape = authoredOp.shape;
    const shapeOps: Array<{ from: string | null; breaking: boolean | null; severity: string | null }> =
      shape !== null && "ops" in shape && Array.isArray(shape.ops) ? shape.ops : [];
    expect(shapeOps[0]?.from).toBeNull();
    expect(shapeOps[0]?.breaking).toBeNull();
    expect(shapeOps[0]?.severity).toBeNull();
  });
});
