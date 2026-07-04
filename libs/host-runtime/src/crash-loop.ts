/**
 * libs/host-runtime/src/crash-loop.ts — Slice 3 of docs/spec/service-lifecycle.md.
 *
 * `[inv:crash-loop-cap]` (§11.3, Appendix B item 4a): bounded restarts.
 *
 *   > "After 5 unexpected exits inside 60s, stop restarting, mark the service
 *   >  DEGRADED (give-up), log a durable `[crash-loop]` line, surface it in
 *   >  `soxe status`/`doctor`, and require an explicit `soxe start`/`enable`
 *   >  to clear."
 *
 * This is the leaf primitive — a rolling-window failure counter ("restart
 * counter with a rolling-window timestamp ring", §11.3) with:
 *
 *   - `recordFailure()`   — push an unexpected-exit timestamp; prune the window;
 *                           transition to CAPPED at `maxFailures`-in-`windowMs`.
 *   - STICKY cap          — once capped, the guard STAYS capped even after the
 *                           window expires: only an explicit `clear()` /
 *                           `recordSuccess()` (the "explicit start/enable" of
 *                           §11.3) un-caps it. A silent self-heal would hide the
 *                           give-up from the operator ([inv:list-never-lies]).
 *   - `recordSuccess()`   — a confirmed-good run (e.g. a backend that came live
 *                           and answered its readiness handshake) resets the ring
 *                           AND the cap.
 *   - Durable MARKER      — on the transition to capped, a JSON marker is written
 *                           under `<markerDir>/<key>.json` (default
 *                           `runDir()/crash-loop/`) so a SEPARATE process
 *                           (`soxe status` / `soxe doctor`) can render the
 *                           DEGRADED (give-up) state. Cleared by clear()/success.
 *
 * Failures are counted on process EXIT only — a slow-but-successful start never
 * records a failure (it never exits), so the cap cannot trigger on it.
 *
 * Consumers (the seams the cap is wired into):
 *   - `supervisor.ts` unexpected-exit handler (the M1 `_respawn` path, §11.3).
 *   - `ensureBackend` (libs/service-proxy) — the primitive is exposed here for
 *     the integrator; see the Slice 3 report for the one-line integration.
 *   - `soxe status` / `soxe doctor` — marker readers (apps/sox/src/main.ts).
 *
 * Leaf module: node builtins + data-paths only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { runDir } from './data-paths.js';

// ─── Defaults (§11.3 decision: 5-in-60s) ─────────────────────────────────────────

export const CRASH_LOOP_MAX_FAILURES = 5;
export const CRASH_LOOP_WINDOW_MS = 60_000;

// ─── Durable marker (cross-process surfacing for status/doctor) ──────────────────

/** The persisted give-up marker `soxe status`/`doctor` render as DEGRADED (give-up). */
export interface CrashLoopMarker {
  /** Supervisor/service key (e.g. `memory-daemon@1.0.0`). */
  key: string;
  /** ISO timestamp of the cap transition. */
  cappedAt: string;
  /** ISO timestamps of the unexpected exits inside the window at cap time. */
  failures: string[];
  maxFailures: number;
  windowMs: number;
  /** Human-readable give-up line (also written to the durable log). */
  reason: string;
}

/** Default marker directory: `<userDataRoot>/run/crash-loop/`. */
export function crashLoopMarkerDir(): string {
  return path.join(runDir(), 'crash-loop');
}

/** fs-safe marker filename for a service key. */
export function crashLoopMarkerPath(markerDir: string, key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9._@-]/g, '_');
  return path.join(markerDir, `${safe}.json`);
}

/** Read one marker; null when absent/corrupt. */
export function readCrashLoopMarker(markerPath: string): CrashLoopMarker | null {
  try {
    if (!fs.existsSync(markerPath)) return null;
    const m = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as CrashLoopMarker;
    if (typeof m.key !== 'string' || !Array.isArray(m.failures)) return null;
    return m;
  } catch {
    return null;
  }
}

/** Enumerate every live give-up marker in a marker dir (for status/doctor). */
export function listCrashLoopMarkers(markerDir: string): CrashLoopMarker[] {
  const out: CrashLoopMarker[] = [];
  let files: string[];
  try {
    files = fs.readdirSync(markerDir).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const f of files) {
    const m = readCrashLoopMarker(path.join(markerDir, f));
    if (m) out.push(m);
  }
  return out;
}

/** Remove the marker for a key (explicit start/enable clears it). True if removed. */
export function clearCrashLoopMarker(markerDir: string, key: string): boolean {
  const p = crashLoopMarkerPath(markerDir, key);
  try {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      return true;
    }
  } catch {
    /* best-effort */
  }
  return false;
}

// ─── The guard ────────────────────────────────────────────────────────────────────

export interface CrashLoopGuardOptions {
  /** Service key the guard protects (marker filename + log lines). */
  key: string;
  /** Cap: N unexpected exits within the window ⇒ give up. Default 5 (§11.3). */
  maxFailures?: number | undefined;
  /** Rolling window in ms. Default 60_000 (§11.3). */
  windowMs?: number | undefined;
  /** Marker directory. Default `crashLoopMarkerDir()`. */
  markerDir?: string | undefined;
  /** Write/clear the durable marker. Default true. Set false for in-memory-only. */
  persist?: boolean | undefined;
  /** Injectable clock (tests). Default Date.now. */
  now?: (() => number) | undefined;
}

export interface CrashLoopState {
  /** True once the cap has been hit (sticky until clear()/recordSuccess()). */
  capped: boolean;
  /** Unexpected exits currently inside the rolling window. */
  failuresInWindow: number;
  maxFailures: number;
  windowMs: number;
}

export class CrashLoopGuard {
  private readonly _key: string;
  private readonly _max: number;
  private readonly _windowMs: number;
  private readonly _markerDir: string;
  private readonly _persist: boolean;
  private readonly _now: () => number;

  /** Rolling ring of unexpected-exit timestamps (epoch ms), pruned to the window. */
  private _ring: number[] = [];
  /** Sticky give-up flag — window expiry never clears it (§11.3: explicit clear). */
  private _capped = false;

  constructor(opts: CrashLoopGuardOptions) {
    this._key = opts.key;
    this._max = opts.maxFailures ?? CRASH_LOOP_MAX_FAILURES;
    this._windowMs = opts.windowMs ?? CRASH_LOOP_WINDOW_MS;
    this._markerDir = opts.markerDir ?? crashLoopMarkerDir();
    this._persist = opts.persist !== false;
    this._now = opts.now ?? Date.now;
  }

  key(): string {
    return this._key;
  }

  /** Sticky capped state. */
  isCapped(): boolean {
    return this._capped;
  }

  /** Unexpected exits inside the current window. */
  failuresInWindow(): number {
    this._prune(this._now());
    return this._ring.length;
  }

  private _prune(now: number): void {
    const cutoff = now - this._windowMs;
    this._ring = this._ring.filter((t) => t > cutoff);
  }

  private _state(): CrashLoopState {
    return {
      capped: this._capped,
      failuresInWindow: this._ring.length,
      maxFailures: this._max,
      windowMs: this._windowMs,
    };
  }

  /**
   * Record one unexpected exit. Prunes the window, then caps when the ring holds
   * `maxFailures` timestamps. On the TRANSITION to capped, writes the durable
   * marker (when persisting). Idempotent once capped (no re-write).
   */
  recordFailure(): CrashLoopState {
    const now = this._now();
    this._prune(now);
    this._ring.push(now);
    if (!this._capped && this._ring.length >= this._max) {
      this._capped = true;
      if (this._persist) this._writeMarker();
    }
    return this._state();
  }

  /**
   * A confirmed-good run: reset the ring AND the cap, and clear the marker.
   * (For the in-supervisor path the rolling window is the organic recovery — a
   * process that stays alive past the window ages its failures out; this method
   * is the explicit reset for discrete-success seams like a backend ensure.)
   */
  recordSuccess(): void {
    this.clear();
  }

  /** The explicit `soxe start`/`enable` clear (§11.3). */
  clear(): void {
    this._ring = [];
    this._capped = false;
    if (this._persist) clearCrashLoopMarker(this._markerDir, this._key);
  }

  /** Human-readable give-up line (the durable `[crash-loop]` log line, §11.3). */
  giveUpLine(): string {
    return (
      `[crash-loop] "${this._key}" gave up after ${this._ring.length} unexpected exits ` +
      `within ${this._windowMs}ms (cap ${this._max}) — DEGRADED (give-up); ` +
      `an explicit start/enable is required to clear`
    );
  }

  private _writeMarker(): void {
    try {
      fs.mkdirSync(this._markerDir, { recursive: true });
      const marker: CrashLoopMarker = {
        key: this._key,
        cappedAt: new Date(this._now()).toISOString(),
        failures: this._ring.map((t) => new Date(t).toISOString()),
        maxFailures: this._max,
        windowMs: this._windowMs,
        reason: this.giveUpLine(),
      };
      const p = crashLoopMarkerPath(this._markerDir, this._key);
      const tmp = `${p}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(marker, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, p);
    } catch {
      // Marker persistence is best-effort — the in-memory cap still holds and the
      // console/log-manager line is still emitted by the caller.
    }
  }
}
