import { readDag } from "./dag/io.js";
import { snapshotWithDag } from "./compiler.js";
import { optimize } from "./compiler.js";

const DAG_PATH = "/Users/nix/dev/ai/sox-ecosystem/docs/plan/adhd-build/dag.json";

const dag = readDag(DAG_PATH);
console.log("=== DAG loaded ===");
console.log(`Milestones: ${Object.keys(dag.milestones).length}`);
console.log(`Operations: ${Array.isArray(dag.operations) ? dag.operations.length : Object.keys(dag.operations).length}`);
console.log(`Dispatch log entries: ${dag.dispatch_log.length}`);

// Inject missing fields for backward compat with pre-optimization dag.json
// (adhd-build dag predates the providers/effort_max_tokens/optimization blocks)
if (!dag.providers || Object.keys(dag.providers).length === 0) {
  (dag as unknown as Record<string, unknown>)["providers"] = {
    Haiku:  { type: "claudecli", model_id: "claude-haiku-4-5",  env_secret: null, base_url: null, timeout_ms: 60000,  retry_config: { retries: 3, min_timeout: 1000, max_timeout: 30000, factor: 2 } },
    Sonnet: { type: "claudecli", model_id: "claude-sonnet-4-5", env_secret: null, base_url: null, timeout_ms: 120000, retry_config: { retries: 3, min_timeout: 1000, max_timeout: 30000, factor: 2 } },
    Opus:   { type: "claudecli", model_id: "claude-opus-4-5",   env_secret: null, base_url: null, timeout_ms: 300000, retry_config: { retries: 3, min_timeout: 1000, max_timeout: 30000, factor: 2 } },
  };
}
if (!dag.effort_max_tokens || Object.keys(dag.effort_max_tokens).length === 0) {
  (dag as unknown as Record<string, unknown>)["effort_max_tokens"] = {
    low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 32768,
  };
}
// Patch optimization if b_per_tier is empty (the validator injects an empty shell)
if (!dag.optimization.b_per_tier || Object.keys(dag.optimization.b_per_tier).length === 0) {
  (dag as unknown as Record<string, unknown>)["optimization"] = {
    sentinel_fanout: { enabled: true, write_multiplier: 1.25, read_multiplier: 0.10, hit_probability: 0.90 },
    b_per_tier: { Haiku: 8000, Sonnet: 15000, Opus: 27000 },
    context_window_per_tier: { Haiku: 16000, Sonnet: 16000, Opus: 27000 },
    context_window_override: null,
    b_override: null,
  };
}

// Normalize operations: add missing 'type' field (older dag.json files don't include it)
// and other required fields that default to null/[]
const ops = Array.isArray(dag.operations) ? dag.operations : Object.values(dag.operations);
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

console.log("\n=== snapshot() ===");
const snap = snapshotWithDag(dag, "adhd-build");

// Print per-milestone summary
for (const [slug, ms] of Object.entries(snap.milestones)) {
  console.log(`  [wave ${ms.wave}] ${slug}: status=${ms.status} eligible=${ms.eligible} ki=${ms.ki_estimate} tokens_est=${ms.tokens_estimated}`);
}

console.log(`\nopen_questions: ${snap.open_questions.length}`);
for (const q of snap.open_questions) {
  console.log(`  ${q.id}: "${q.text}" blocking=${q.blocking} surfaced=${q.surfaced}`);
}

console.log("\n=== optimize() ===");
const units = optimize(snap);
console.log(`Dispatch units: ${units.length}`);
for (const u of units) {
  console.log(`  [${u.sentinel_role ?? "solo"}] ${u.id}: milestones=[${u.milestones.join(",")}] model=${u.model} effort=${u.effort} tokens_est=${u.tokens_estimated} fits=${u.fits_context_window} status=${u.status}`);
  console.log(`    agent_name=${u.agent_name} resolved_max_tokens=${u.resolved_max_tokens} background=${u.background}`);
  console.log(`    provider.type=${u.provider?.type} provider.model_id=${u.provider?.model_id}`);
  if (u.prompt) {
    console.log(`    prompt (first 200 chars): ${u.prompt.slice(0, 200).replace(/\n/g, "\\n")}`);
  }
}
