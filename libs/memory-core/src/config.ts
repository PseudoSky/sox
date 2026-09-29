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
import { resolve, sep } from 'node:path';
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

/**
 * (98fe54a3) True when `dbPath` lives inside the backup directory
 * (`resolveBackupConfig().dir`, or `backupDir` when given). A backup is a
 * point-in-time snapshot: it must never be enlisted into a server's background
 * maintenance (enrich/heal/drain/compaction) nor kept open after the call that
 * touched it — prod idle-flushed and reconciled
 * `~/.memory/backups/backfill-503cdc2b-apply-….db` for hours because one
 * `memory_ping db_path=<backup>` enlisted it forever.
 */
export function isBackupStorePath(dbPath: string, backupDir?: string): boolean {
  const dir = resolve(backupDir ?? resolveBackupConfig().dir);
  const target = resolve(expandDbPath(dbPath));
  return target.startsWith(dir.endsWith(sep) ? dir : dir + sep);
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

// ── StoreGrowthConfig (BL-c5249cdd) ───────────────────────────────────────────
//
// `memory_ping`'s store-growth gauge alarms when the store has grown past what
// its live content explains. On `@tursodatabase/database` 0.7.1/0.7.2 every
// interleaved insert + in-service `OPTIMIZE INDEX` round orphans the merged-away
// FTS segments; only an offline `memory fts-rebuild` (VACUUM INTO) reclaims
// them. Measured on a copy of production: 436.1 MB before, 160.3 MB after —
// 2.72× — with identical rows.
//
// ADR-0013 D3: numeric tuning, never a switch. Both thresholds are typed config
// with a default; each MAY be tuned by env with a loud parse failure (a bad
// value is reported in `config_errors` on the gauge and the default is kept).
// Nothing here can disable the gauge or the alarm.

export interface StoreGrowthConfig {
  /**
   * Alarm when `file_bytes / live_nodes` exceeds this. Default 24 KiB ≈ 3× the
   * compacted density measured on the Aug-15 VACUUM rehearsal (97.3 MB /
   * 11,782 nodes ≈ 8.3 KB per node) — a store carrying roughly twice its
   * compacted size in orphaned pages.
   */
  bytesPerLiveNodeAlarm: number;
  /**
   * Alarm when in-service OPTIMIZE passes since the last rebuild exceed this.
   * Each pass merges ≥ 256 writes' segments (`DEFAULT_FTS_OPTIMIZE_WRITE_
   * THRESHOLD`) and orphans them; at the production copy's measured ~30 KB per
   * orphan segment (216.9 MB / 7,273) that is several MB per pass, so 32 passes
   * is on the order of one compacted store's worth of leak.
   */
  optimizePassesSinceRebuildAlarm: number;
  /** Below this many live nodes the bytes-per-node ratio is not judged — a
   *  near-empty store is all fixed overhead and would alarm meaninglessly. */
  minLiveNodes: number;
}

export const DEFAULT_STORE_GROWTH_CONFIG: StoreGrowthConfig = {
  bytesPerLiveNodeAlarm: 24 * 1024,
  optimizePassesSinceRebuildAlarm: 32,
  minLiveNodes: 500,
};

/** D3 env tuning knobs for {@link StoreGrowthConfig} (numeric only). */
export const STORE_GROWTH_ENV = Object.freeze({
  bytesPerLiveNodeAlarm: 'SOX_STORE_GROWTH_BYTES_PER_NODE_ALARM',
  optimizePassesSinceRebuildAlarm: 'SOX_STORE_GROWTH_OPTIMIZE_PASSES_ALARM',
  minLiveNodes: 'SOX_STORE_GROWTH_MIN_LIVE_NODES',
} as const);

export interface ResolvedStoreGrowthConfig {
  config: StoreGrowthConfig;
  /** One entry per env value that failed to parse (default kept). */
  errors: string[];
}

/**
 * Resolve the growth-gauge config: typed `overrides` > env (D3) > defaults.
 * Never throws; a malformed env value is reported in `errors`, never silently
 * ignored and never allowed to disable anything.
 */
export function resolveStoreGrowthConfig(
  overrides?: Partial<StoreGrowthConfig>,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedStoreGrowthConfig {
  const errors: string[] = [];
  const pick = (key: keyof StoreGrowthConfig): number => {
    const o = overrides?.[key];
    if (o !== undefined) {
      if (Number.isFinite(o) && o > 0) return o;
      errors.push(`override ${key}=${String(o)} is not a positive number; using default ${DEFAULT_STORE_GROWTH_CONFIG[key]}`);
      return DEFAULT_STORE_GROWTH_CONFIG[key];
    }
    const name = STORE_GROWTH_ENV[key];
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return DEFAULT_STORE_GROWTH_CONFIG[key];
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
    errors.push(`${name}=${JSON.stringify(raw)} is not a positive number; using default ${DEFAULT_STORE_GROWTH_CONFIG[key]}`);
    return DEFAULT_STORE_GROWTH_CONFIG[key];
  };
  return {
    config: {
      bytesPerLiveNodeAlarm: pick('bytesPerLiveNodeAlarm'),
      optimizePassesSinceRebuildAlarm: pick('optimizePassesSinceRebuildAlarm'),
      minLiveNodes: pick('minLiveNodes'),
    },
    errors,
  };
}

// ── StoreVerifyConfig (BL-fc5ab895) ────────────────────────────────────────
//
// The out-of-process `deep` integrity pass (store-adapter `deep-verify.ts`) has
// a wall-clock bound. It is TUNING (ADR-0013 D3): numeric, never a toggle —
// there is no value that turns deep verification off. The host-injected
// transport is the config cascade (ADR-0013 D5): memory-server's
// `config_schema.deep_verify_timeout_ms` arrives as
// `SOX_CONFIG_DEEP_VERIFY_TIMEOUT_MS`. A present-but-unparseable value THROWS
// here, and an out-of-range one throws `EInvalidDeepVerifyConfig` at the store
// open (store-adapter owns the range) — never a silent fallback to the default.

/** Config-cascade env key carrying `deep_verify_timeout_ms`. */
export const DEEP_VERIFY_TIMEOUT_CONFIG_ENV = 'SOX_CONFIG_DEEP_VERIFY_TIMEOUT_MS';

export interface StoreVerifyConfig {
  /** Wall-clock bound for one background deep pass, ms. `undefined` ⇒ the
   *  store-adapter default (`DEFAULT_DEEP_VERIFY_TIMEOUT_MS`). */
  deepVerifyTimeoutMs: number | undefined;
}

/**
 * Resolve the store-verify config. Precedence: typed `overrides` → the
 * config-cascade env → the store-adapter default. Throws on a present value
 * that is not a base-10 integer.
 */
export function resolveStoreVerifyConfig(
  overrides?: { deepVerifyTimeoutMs?: number },
  env: NodeJS.ProcessEnv = process.env,
): StoreVerifyConfig {
  if (overrides?.deepVerifyTimeoutMs !== undefined) {
    return { deepVerifyTimeoutMs: overrides.deepVerifyTimeoutMs };
  }
  const raw = env[DEEP_VERIFY_TIMEOUT_CONFIG_ENV];
  if (raw === undefined || raw.trim() === '') return { deepVerifyTimeoutMs: undefined };
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(
      `${DEEP_VERIFY_TIMEOUT_CONFIG_ENV}=${JSON.stringify(raw)} is not an integer number of milliseconds ` +
        `(config key deep_verify_timeout_ms). Refusing to guess — fix the config (ADR-0013 D3).`,
    );
  }
  return { deepVerifyTimeoutMs: Number.parseInt(raw.trim(), 10) };
}
