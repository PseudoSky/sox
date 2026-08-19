/**
 * (BL-587, BL-590) Shared WAL tuning constants and pure helpers for the
 * idle-flush debounce and the wal-cap backstop.
 *
 * Before this file existed, `TursoAdapterImpl` and `SqliteAdapterImpl` each
 * declared their OWN copy of `DEFAULT_IDLE_FLUSH_MS` / `DEFAULT_WAL_CAP_BYTES`
 * — same names, same values, two independent constants that happened to
 * agree by discipline rather than by construction. BL-587 is exactly a case
 * of that discipline not holding: the two adapters share a numeric WAL-cap
 * constant that means something materially different on each backend
 * because their post-schema WAL baselines differ (sqlite's FTS5 shadow
 * tables alone roughly double its baseline versus a schema with no FTS).
 * Pulling the tuning math out into one module, imported by both, makes that
 * class of drift structurally impossible going forward — there is now one
 * place that computes "what is the effective debounce window" and one place
 * that computes "what is the effective wal-cap", and both adapters call the
 * same pure functions with their own state as input.
 */

// ── idle-flush (BL-590 — adaptive debounce) ─────────────────────────────────

/**
 * Floor of the idle-flush debounce window, ms. Below this, an idle store
 * would flush more eagerly than the original (pre-BL-590) fixed 2000ms
 * default ever did — never acceptable, since a genuinely idle store (no
 * write cadence to adapt to) must still flush promptly. Also the value used
 * when no write-interval signal exists yet (a freshly opened, never-written
 * instance) — see `effectiveIdleFlushMs()`.
 */
export const DEFAULT_IDLE_FLUSH_FLOOR_MS = 2000;

/**
 * Ceiling of the idle-flush debounce window, ms. BL-590's own text bounds
 * the adaptive window to "clamped between the current 2000ms floor and a
 * sane ceiling (~30s) so ... a pathological cadence cannot defer flushing
 * forever." 30s is that ceiling: comfortably above the measured embed
 * pipeline cadence this feature exists to coalesce (time_to_vector_ms p50
 * 4516ms — 30s is ~6.6x that), while remaining short enough that the
 * wal-cap backstop (which cannot be starved by a debounce window, gated or
 * not) is never the ONLY thing standing between a stalled writer and
 * unbounded WAL growth for more than half a minute.
 */
export const DEFAULT_IDLE_FLUSH_CEILING_MS = 30_000;

/**
 * EWMA smoothing factor for the observed inter-write gap. 0.3 weights the
 * most recent gap meaningfully (fast to react to a real cadence shift —
 * e.g. an embed backlog draining and the pipeline speeding back up) without
 * letting a single outlier gap (a GC pause, a slow disk write) swing the
 * window on its own. Not derived from a measured optimum — a reasoned,
 * conventional EWMA weight (standard range 0.1-0.5 for "react within a
 * handful of samples, damp single-sample noise") — see BL-590 follow-on if
 * empirical tuning of this constant specifically is ever warranted.
 */
export const IDLE_FLUSH_EWMA_ALPHA = 0.3;

/**
 * Multiplier applied to the EWMA'd inter-write gap to get the candidate
 * debounce window — BL-590's "comfortably exceed" requirement. 1.5x means a
 * write cadence of exactly the debounce window's length still coalesces
 * (the SECOND write of a pair always lands before the first write's timer
 * would have fired), while a single missed/slow write does not itself
 * balloon the window (linear in the gap, not exponential).
 */
export const IDLE_FLUSH_MARGIN_FACTOR = 1.5;

/**
 * Fold one observed inter-write gap into the running EWMA. `null` in ⇒ the
 * gap becomes the seed value (first observation, no history to blend with).
 */
export function updateWriteIntervalEwma(prevEwmaMs: number | null, gapMs: number): number {
  if (prevEwmaMs === null) return gapMs;
  return IDLE_FLUSH_EWMA_ALPHA * gapMs + (1 - IDLE_FLUSH_EWMA_ALPHA) * prevEwmaMs;
}

/**
 * Compute the debounce window to arm for the NEXT idle-flush timer.
 *
 * No write-interval signal yet (`writeIntervalEwmaMs === null`, e.g. a
 * freshly opened instance or one that has only ever taken a single write)
 * ⇒ `floorMs`, i.e. today's fixed behaviour — this is what keeps a store
 * that goes idle immediately flushing promptly rather than waiting out a
 * ceiling it has no evidence it needs.
 */
export function effectiveIdleFlushMs(opts: {
  floorMs: number;
  ceilingMs: number;
  writeIntervalEwmaMs: number | null;
}): number {
  if (opts.writeIntervalEwmaMs === null) return opts.floorMs;
  const target = opts.writeIntervalEwmaMs * IDLE_FLUSH_MARGIN_FACTOR;
  return Math.min(Math.max(target, opts.floorMs), opts.ceilingMs);
}

// ── wal-cap (BL-587 — baseline-relative cap) ────────────────────────────────

/**
 * Default HEADROOM budget, bytes — the tunable BL-587 asked for. This is the
 * SAME numeric value the old flat `DEFAULT_WAL_CAP_BYTES` used (262,144 /
 * 256 KiB — see the historical derivation this repo already measured: ~63x
 * the ~4,152-byte clean-shutdown-stamp noise floor, ~49% of the 539,752-byte
 * pathological live figure that prompted the wal-cap feature). Kept
 * unchanged in magnitude deliberately: with no baseline captured (the
 * default — see `effectiveWalCapBytes()`), the effective cap is exactly
 * this value, so a caller that never adopts baseline capture sees IDENTICAL
 * behaviour to pre-BL-587 code. What changes is that a caller who DOES call
 * `captureWalCapBaseline()` after finishing its own schema DDL gets that
 * same 256 KiB budget on top of ITS backend's real baseline, instead of a
 * fixed absolute number that silently meant less headroom on whichever
 * backend happens to have the larger baseline (measured: sqlite with FTS5
 * ≈150-165 KB baseline vs turso's much lower one, for the same logical
 * schema).
 */
export const DEFAULT_WAL_CAP_HEADROOM_BYTES = 262_144;

/**
 * Absolute ceiling on the EFFECTIVE cap (baseline + headroom), bytes,
 * regardless of how large a captured baseline turns out to be. BL-587
 * explicitly requires this: "Keep an absolute ceiling so a pathological
 * baseline cannot disable the backstop entirely" — e.g. a baseline captured
 * against an already-bloated WAL (a caller that calls
 * `captureWalCapBaseline()` at the wrong moment, or a store recovering from
 * prior damage) must not silently raise the effective cap to something the
 * backstop can never usefully trip at.
 *
 * 1,048,576 bytes (1 MiB) — reasoned, not measured, since no baseline this
 * large has ever been observed: roughly 2x the 539,752-byte pathological
 * WAL size that originally justified the wal-cap feature at all, and 4x the
 * default headroom budget above. A baseline would have to already be ~3.2x
 * the largest pathological figure measured live (786,432 = ceiling minus
 * headroom) before this ceiling starts trimming the budget instead of
 * baseline-relative headroom doing the real work — comfortably above any
 * baseline this package's own measurements have produced (sqlite+FTS5
 * ≈150-165 KB is the largest on record).
 */
export const DEFAULT_WAL_CAP_CEILING_BYTES = 1_048_576;

/**
 * Compute the effective wal-cap threshold.
 *
 * `explicitOverrideBytes` (non-null) wins unconditionally — this is the
 * `opts.walCapBytes` test-only escape hatch that already existed pre-BL-587
 * (e.g. `wal-cap-concurrency.bug019.spec.ts` sets an artificially tiny
 * absolute cap to trip the backstop almost immediately under a controlled
 * writer burst); baseline-relative computation would defeat that test's own
 * determinism, so an explicit override always bypasses it entirely.
 *
 * Otherwise: `min(baselineBytes + headroomBytes, ceilingBytes)`. With no
 * baseline captured (`baselineBytes === 0`, the default until a caller
 * invokes `captureWalCapBaseline()`), this reduces to exactly
 * `headroomBytes` — the pre-BL-587 flat-constant behaviour.
 */
export function effectiveWalCapBytes(opts: {
  explicitOverrideBytes: number | null;
  baselineBytes: number;
  headroomBytes: number;
  ceilingBytes: number;
}): number {
  if (opts.explicitOverrideBytes !== null) return opts.explicitOverrideBytes;
  return Math.min(opts.baselineBytes + opts.headroomBytes, opts.ceilingBytes);
}
