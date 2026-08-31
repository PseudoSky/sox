/**
 * memory-core typed config surface — ADR-0013 D2/D3.
 *
 * Feature switches are typed config, never environment variables that toggle
 * behavior. This module is the typed home for memory-core's configurable
 * dimensions. Today it carries the `BackupConfig` skeleton the backup feature
 * (architect task, landing after this branch) implements against.
 *
 * Backing rule: `enabled` is the REPORT-ONLY literal `true` — auto-backup is
 * ALWAYS on (the `SOX_AUTO_BACKUP_ENABLED` toggle was deleted as an
 * anti-feature, ADR-0013; "auto backup should be enabled always"). There is
 * no type-level or runtime way to disable it. Numeric/string dimensions
 * (intervalMs, retentionCount, dir) are tuning/config per D3/D5 and may be
 * env-tunable, but they never gate a code path.
 */
import { resolve } from 'node:path';
import { expandDbPath } from './db.js';

// ── BackupConfig (skeleton — the full backup feature lands separately) ───────

export interface BackupConfig {
  /**
   * ALWAYS `true` — a report-only dimension, NOT a switch (ADR-0013 D2). The
   * literal type makes "disable backup" unrepresentable in the type system;
   * callers read it to REPORT the mode, never to gate.
   */
  enabled: true;
  /** Cadence of the scheduled auto-backup (6 h). */
  intervalMs: number;
  /** Retained rotated backups per source (24). */
  retentionCount: number;
  /** Backup directory, in the declared (`~`) form; resolved by
   *  {@link resolveBackupConfig}. */
  dir: string;
}

export const DEFAULT_BACKUP_CONFIG: BackupConfig = {
  enabled: true,
  intervalMs: 6 * 60 * 60 * 1000,
  retentionCount: 24,
  dir: '~/.memory/backups',
};

/**
 * Resolve the effective backup configuration.
 *
 * `dir` precedence (first non-undefined wins):
 *   1. `overrides.dir` — the typed seam where the platform config-cascade
 *      (`config.backup.dir`, ADR-0013 D2) will inject when memory-core gains
 *      an injected-config channel. Absent today; the seam is the parameter.
 *   2. `SOX_AUTO_BACKUP_DIR` — host-injected config, KEPT per ADR-0013 D5
 *      (an injection channel, not a toggle).
 *   3. {@link DEFAULT_BACKUP_CONFIG.dir} (`~/.memory/backups`).
 *
 * Returns the dir in `path.resolve`d, `~`-expanded form so callers can use it
 * directly. Never throws. `intervalMs`/`retentionCount` resolve to their
 * defaults — the future feature may make them env-tunable (D3-legal numeric
 * tuning) but MUST never gate a path, and no `SOX_BACKUP_*` toggle env var
 * may ever exist.
 */
export function resolveBackupConfig(overrides?: { dir?: string }): BackupConfig {
  const declaredDir =
    overrides?.dir !== undefined && overrides.dir !== ''
      ? overrides.dir
      : process.env.SOX_AUTO_BACKUP_DIR !== undefined && process.env.SOX_AUTO_BACKUP_DIR !== ''
        ? process.env.SOX_AUTO_BACKUP_DIR
        : DEFAULT_BACKUP_CONFIG.dir;
  return {
    enabled: true,
    intervalMs: DEFAULT_BACKUP_CONFIG.intervalMs,
    retentionCount: DEFAULT_BACKUP_CONFIG.retentionCount,
    // `expandDbPath` resolves `~/…`; `resolve` absolutizes the rest (relative
    // paths land under cwd, matching the pre-config behaviour of
    // `path.resolve(expandDbPath(raw))` in autoBackup).
    dir: resolve(expandDbPath(declaredDir)),
  };
}

// ── EnrichHealthConfig (BUG-MEMORYSERVER-EMBED-HEAL-NOOPERATOR-001) ──────────
//
// The typed config for the enrich/embed pipeline self-heal health plane. This is
// the LIFETIME operational control plane that replaces the 15-min stall window +
// queue-freshness heuristic (which read healthy during the 2026-08-26 >24h
// outage because fresh queue rows masked a pipeline whose last SUCCESSFUL pass
// was hours stale).
//
// ADR-0013: no new SOX_* toggle env var. Every dimension here is typed config
// with a default; `enabled` is a report-only literal `true` (auto-heal is always
// on — the same rule as BackupConfig). `stallThresholdMs` is the single tunable
// that was already env-driven (SOX_ENRICH_STALL_THRESHOLD_MS); the rest are
// operator-tuning dimensions resolvable only through the typed `overrides` seam.

export interface EnrichHealthConfig {
  /** The stall window: how long since the last SUCCESSFUL pass before a
   *  non-empty backlog reads `stalled` (the honest freshness signal — NOT the
   *  age of the newest queue row). */
  stallThresholdMs: number;
  /** Minimum success-rate (successful passes / total passes) required to read
   *  `ok` once enough passes have run to judge. */
  successRateFloor: number;
  /** How many passes must have run before the success-rate floor is enforced
   *  (avoids a false `regressing` on the very first pass). */
  minPasses: number;
  /** Consecutive embed failures on one row before it is poisoned (excluded from
   *  the heal scan). */
  poisonThreshold: number;
  /**
   * BUG-MEMORYSERVER-EMBED-HEAL-NOOPERATOR-001 (bounded quarantine): the
   * cool-down window after which a poisoned row (failures >= poisonThreshold)
   * is AUTOMATICALLY re-admitted to the heal scan without operator action. A
   * row is quarantined only while its `last_failed_at` is within this window;
   * once older, it re-enters the next scan. This converts the poison ledger
   * from a permanent parking lot into a time-bounded circuit breaker — a
   * systemic "Model not initialized" burst still parks rows, but they
   * auto-recover the moment the embed subsystem is healthy again, and the
   * alarm (fed by the poison count) makes the park visible while it lasts.
   */
  poisonReentryMs: number;
  /** Auto-heal: always on; `maxActionsPerWindow` caps how many corrective
   *  actions a single alarm window may take (reinit/drain rate limit). */
  autoHeal: { enabled: true; maxActionsPerWindow: number };
  /** Alarm escalation: a non-ok verdict becomes `crit` at this many consecutive
   *  non-ok ticks (or sooner, on 2 consecutive negative-drain windows). */
  alarm: { critTicks: number };
}

export const DEFAULT_ENRICH_HEALTH_CONFIG: EnrichHealthConfig = {
  stallThresholdMs: 15 * 60 * 1000,
  successRateFloor: 0.5,
  minPasses: 3,
  poisonThreshold: 3,
  poisonReentryMs: 600_000, // 10 min
  autoHeal: { enabled: true, maxActionsPerWindow: 3 },
  alarm: { critTicks: 4 },
};

/**
 * Resolve the effective enrich/embed health config. Merges the typed `overrides`
 * over {@link DEFAULT_ENRICH_HEALTH_CONFIG}; `autoHeal.enabled` is forced to the
 * literal `true` (never unrepresentable as a disable — ADR-0013 D2). Returns a
 * fresh object every call; never throws.
 */
export function resolveEnrichHealthConfig(overrides?: {
  stallThresholdMs?: number;
  successRateFloor?: number;
  minPasses?: number;
  poisonThreshold?: number;
  poisonReentryMs?: number;
  autoHeal?: { maxActionsPerWindow?: number };
  alarm?: { critTicks?: number };
}): EnrichHealthConfig {
  return {
    stallThresholdMs: overrides?.stallThresholdMs ?? DEFAULT_ENRICH_HEALTH_CONFIG.stallThresholdMs,
    successRateFloor: overrides?.successRateFloor ?? DEFAULT_ENRICH_HEALTH_CONFIG.successRateFloor,
    minPasses: overrides?.minPasses ?? DEFAULT_ENRICH_HEALTH_CONFIG.minPasses,
    poisonThreshold: overrides?.poisonThreshold ?? DEFAULT_ENRICH_HEALTH_CONFIG.poisonThreshold,
    poisonReentryMs: overrides?.poisonReentryMs ?? DEFAULT_ENRICH_HEALTH_CONFIG.poisonReentryMs,
    autoHeal: {
      enabled: true,
      maxActionsPerWindow:
        overrides?.autoHeal?.maxActionsPerWindow ?? DEFAULT_ENRICH_HEALTH_CONFIG.autoHeal.maxActionsPerWindow,
    },
    alarm: {
      critTicks: overrides?.alarm?.critTicks ?? DEFAULT_ENRICH_HEALTH_CONFIG.alarm.critTicks,
    },
  };
}
