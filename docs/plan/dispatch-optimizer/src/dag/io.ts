/**
 * dag/io.ts — File-system I/O for dag.json documents.
 *
 * All disk operations go through these functions so the rest of the codebase
 * never does raw fs.readFileSync on dag.json. appendDispatchLog uses an
 * atomic write (temp-file + rename) to prevent torn writes on concurrent
 * orchestrator processes.
 */

import * as fs from "fs";
import * as path from "path";
import type { DagJson, DispatchLogEntry } from "./types.js";
import { validateDagJson } from "./validate.js";

// ---------------------------------------------------------------------------
// readDag
// ---------------------------------------------------------------------------

/**
 * Read, validate, and normalize a dag.json file from disk.
 *
 * @param filePath - Absolute path to dag.json.
 * @returns Parsed, validated, and backward-compat-normalized DagJson.
 * @throws If the file is missing, not valid JSON, or fails structural validation.
 */
export function readDag(filePath: string): DagJson {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`readDag: cannot read "${filePath}": ${msg}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`readDag: "${filePath}" is not valid JSON: ${msg}`);
  }

  validateDagJson(parsed);
  // BL-107: backward-compat normalization runs after structural validation so
  // the validated type is safe to access. Older dag.json files omit
  // providers/effort_max_tokens/optimization.b_per_tier and per-op fields;
  // these defaults are injected here rather than in the runner.
  normalizeDag(parsed);
  return parsed;
}

// ---------------------------------------------------------------------------
// normalizeDag — BL-107 backward-compat normalization pass
// ---------------------------------------------------------------------------

/**
 * Inject sensible defaults for fields that older dag.json files omit.
 *
 * Normalises:
 *   - providers:            claudecli configs for Haiku / Sonnet / Opus
 *   - effort_max_tokens:    standard effort-tier token caps
 *   - optimization:         baseline b_per_tier + context_window_per_tier
 *                           (full block replaced when b_per_tier is empty)
 *   - Per-operation fields: type, criteria, tool, args, to_file, to_symbol,
 *                           audit_check — all required by OperationDag but
 *                           absent in older authoring sessions.
 *
 * Mutates dag in place; called immediately after validateDagJson so the
 * returned DagJson is always fully-populated before the compiler sees it.
 *
 * Source of defaults: run.ts (BL-107 — moved here from the runner).
 */
function normalizeDag(dag: DagJson): void {
  const dagRec = dag as unknown as Record<string, unknown>;

  // --- providers -----------------------------------------------------------
  if (Object.keys(dag.providers).length === 0) {
    dagRec["providers"] = {
      Haiku: {
        type: "claudecli",
        model_id: "claude-haiku-4-5",
        env_secret: null,
        base_url: null,
        timeout_ms: 60000,
        retry_config: { retries: 3, min_timeout: 1000, max_timeout: 30000, factor: 2 },
      },
      Sonnet: {
        type: "claudecli",
        model_id: "claude-sonnet-4-5",
        env_secret: null,
        base_url: null,
        timeout_ms: 120000,
        retry_config: { retries: 3, min_timeout: 1000, max_timeout: 30000, factor: 2 },
      },
      Opus: {
        type: "claudecli",
        model_id: "claude-opus-4-5",
        env_secret: null,
        base_url: null,
        timeout_ms: 300000,
        retry_config: { retries: 3, min_timeout: 1000, max_timeout: 30000, factor: 2 },
      },
    };
  }

  // --- effort_max_tokens ---------------------------------------------------
  if (Object.keys(dag.effort_max_tokens).length === 0) {
    dagRec["effort_max_tokens"] = {
      low: 1024,
      medium: 4096,
      high: 8192,
      xhigh: 16384,
      max: 32768,
    };
  }

  // --- optimization.b_per_tier ---------------------------------------------
  // Replace the whole optimization block when b_per_tier is empty — validateDagJson
  // may have injected a shell with b_per_tier: {} if the field was absent.
  if (Object.keys(dag.optimization.b_per_tier).length === 0) {
    dagRec["optimization"] = {
      sentinel_fanout: {
        enabled: true,
        write_multiplier: 1.25,
        read_multiplier: 0.10,
        hit_probability: 0.90,
      },
      b_per_tier: { Haiku: 8000, Sonnet: 15000, Opus: 27000 },
      context_window_per_tier: { Haiku: 16000, Sonnet: 16000, Opus: 27000 },
      context_window_override: null,
      b_override: null,
    };
  }

  // --- per-operation field normalization -----------------------------------
  const ops = Array.isArray(dag.operations)
    ? dag.operations
    : Object.values(dag.operations);

  for (const op of ops) {
    const o = op as unknown as Record<string, unknown>;
    if (o["type"] === undefined)        o["type"]        = "generative";
    if (o["criteria"] === undefined)    o["criteria"]    = [];
    if (o["tool"] === undefined)        o["tool"]        = null;
    if (o["args"] === undefined)        o["args"]        = null;
    if (o["to_file"] === undefined)     o["to_file"]     = null;
    if (o["to_symbol"] === undefined)   o["to_symbol"]   = null;
    if (o["audit_check"] === undefined) o["audit_check"] = null;
  }
}

// ---------------------------------------------------------------------------
// writeDag
// ---------------------------------------------------------------------------

/**
 * Write a DagJson to disk as formatted JSON.
 *
 * Uses an atomic write: writes to a temp file in the same directory, then
 * renames over the target. This prevents a torn read if another process reads
 * dag.json while the write is in flight.
 *
 * @param filePath - Absolute path to dag.json.
 * @param dag - The DagJson to serialize.
 */
export function writeDag(filePath: string, dag: DagJson): void {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.dag-tmp-${process.pid}-${Date.now()}.json`);
  const serialized = JSON.stringify(dag, null, 2) + "\n";

  try {
    fs.writeFileSync(tmp, serialized, "utf-8");
    fs.renameSync(tmp, filePath);
  } catch (err: unknown) {
    // Clean up temp file on failure; ignore secondary cleanup errors.
    try {
      fs.unlinkSync(tmp);
    } catch {
      // intentionally swallowed
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`writeDag: cannot write "${filePath}": ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// appendDispatchLog
// ---------------------------------------------------------------------------

/**
 * Atomically append a DispatchLogEntry to dag.json's dispatch_log array.
 *
 * Reads the current dag.json, pushes the entry, and writes back via an atomic
 * rename. This is the only correct way to mutate dispatch_log — direct array
 * manipulation on a stale in-memory DagJson will lose concurrent entries.
 *
 * @param filePath - Absolute path to dag.json.
 * @param entry - The dispatch log entry to append.
 */
export function appendDispatchLog(
  filePath: string,
  entry: DispatchLogEntry
): void {
  const dag = readDag(filePath);
  dag.dispatch_log.push(entry);
  writeDag(filePath, dag);
}

// ---------------------------------------------------------------------------
// Internal helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Resolve the temp file directory for atomic writes — same as the target's
 * parent so that rename() is guaranteed to be atomic (same filesystem).
 */
export function _tempDir(filePath: string): string {
  return path.dirname(path.resolve(filePath));
}
