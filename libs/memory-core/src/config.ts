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
