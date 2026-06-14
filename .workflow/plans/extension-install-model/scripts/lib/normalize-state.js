/**
 * normalize-state.js — canonical state-entry timestamp normalization.
 *
 * Phase 0 of the plan-state-machine evolution plan
 * (docs/experiments/plan-state-machine-evolution-plan.md).
 *
 * PROBLEM (FEEDBACK-SYNTHESIS.md S3, MAJOR): state.json timestamp keys drift
 * across plans — `started_ts`/`done_ts` (schema 0.0.6) vs.
 * `started_at`/`completed_at` (usage-tracking). Metrics built on inconsistent
 * keys are non-comparable, which makes goal-4 training data noise.
 *
 * CONTRACT: the canonical keys are `started_at` / `done_at`. This module maps
 * any historical alias to the canonical field at READ time. It NEVER rewrites
 * state.json on disk — file migration is state-transition.js's job, not a
 * reader's (metrics-extraction-spec §3.1). Pure, Node-stdlib-free, ESM.
 *
 * Backward-compatible by construction: a plan using legacy keys reads exactly
 * the same canonical values as one already on the new keys.
 */

/** Source-key candidates, in precedence order (canonical first). */
export const STARTED_KEYS = ["started_at", "started_ts"];
export const DONE_KEYS = ["done_at", "completed_at", "done_ts"];

/** All alias keys this module subsumes into canonical timestamps. */
export const LEGACY_TIMESTAMP_KEYS = ["started_ts", "completed_at", "done_ts"];

/**
 * Return the first defined, non-null value among `keys` on `obj`.
 * @returns {*} the value, or null if none present.
 */
export function firstDefined(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null) return v;
  }
  return null;
}

/**
 * Extract canonical timestamps from a raw state entry.
 * @param {object} entry a single state's entry from state.json `states[slug]`
 * @returns {{started_at: (string|null), done_at: (string|null)}}
 */
export function normalizeTimestamps(entry) {
  return {
    started_at: firstDefined(entry, STARTED_KEYS),
    done_at: firstDefined(entry, DONE_KEYS),
  };
}

/**
 * Wall-clock duration in whole seconds between canonical timestamps.
 * @returns {number|null} seconds, or null if either timestamp is missing or
 *   unparseable. Negative results (clock skew / bad data) also return null.
 */
export function wallClockSeconds(entry) {
  const { started_at, done_at } = normalizeTimestamps(entry);
  if (!started_at || !done_at) return null;
  const start = Date.parse(started_at);
  const end = Date.parse(done_at);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const seconds = Math.round((end - start) / 1000);
  return seconds >= 0 ? seconds : null;
}

/**
 * Return a normalized COPY of a state entry: canonical `started_at`/`done_at`
 * are set from whatever alias was present, and the legacy alias keys are
 * dropped so downstream consumers see exactly one shape. All other fields
 * (status, start_ref, end_ref, ...) pass through untouched. The input object
 * is not mutated.
 */
export function normalizeStateEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return { started_at: null, done_at: null };
  }
  const { started_at, done_at } = normalizeTimestamps(entry);
  const out = { ...entry, started_at, done_at };
  for (const k of LEGACY_TIMESTAMP_KEYS) delete out[k];
  return out;
}

/**
 * Normalize every entry under `state.states`, returning a new states map.
 * Convenience for whole-file readers (metrics extractor, transition script).
 */
export function normalizeStates(states) {
  const out = {};
  if (!states || typeof states !== "object") return out;
  for (const [slug, entry] of Object.entries(states)) {
    out[slug] = normalizeStateEntry(entry);
  }
  return out;
}
