/**
 * ADR-0013 D2/D3 — typed config surface (BackupConfig skeleton).
 *
 * Pins: (a) `enabled` is the literal `true` — backup cannot be disabled by
 * type or by any env var (SOX_AUTO_BACKUP_ENABLED was deleted as an
 * anti-feature); (b) the numeric tuning defaults (6 h interval, 24 retained);
 * (c) the dir precedence — typed `config.backup.dir` seam → host-injected
 * `SOX_AUTO_BACKUP_DIR` (D5, KEPT) → `~/.memory/backups` default — and that
 * no `SOX_BACKUP_*` toggle exists or is honored.
 */
import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveBackupConfig, DEFAULT_BACKUP_CONFIG } from './config.js';
import type { BackupConfig } from './config.js';

describe('BackupConfig skeleton — ADR-0013 typed config', () => {
  it('enabled is the literal true — backup is ALWAYS on, unrepresentable as false', () => {
    const cfg: BackupConfig = resolveBackupConfig();
    // Type-level: `cfg.enabled` is `true`, so these compile-time facts hold:
    // - `const f: false = cfg.enabled` is a TYPE ERROR
    // - `{ ...cfg, enabled: false }` is a TYPE ERROR
    expect(cfg.enabled).toBe(true);
    expect(DEFAULT_BACKUP_CONFIG.enabled).toBe(true);
  });

  it('defaults: 6 h interval, 24 retained, ~/.memory/backups', () => {
    expect(DEFAULT_BACKUP_CONFIG.intervalMs).toBe(6 * 60 * 60 * 1000);
    expect(DEFAULT_BACKUP_CONFIG.retentionCount).toBe(24);
    expect(DEFAULT_BACKUP_CONFIG.dir).toBe('~/.memory/backups');
    const cfg = resolveBackupConfig();
    expect(cfg.intervalMs).toBe(6 * 60 * 60 * 1000);
    expect(cfg.retentionCount).toBe(24);
  });

  it('dir precedence: typed override > SOX_AUTO_BACKUP_DIR > default (~ expanded, resolved)', () => {
    const saved = process.env.SOX_AUTO_BACKUP_DIR;
    const savedHome = process.env.HOME;
    try {
      // Default.
      delete process.env.SOX_AUTO_BACKUP_DIR;
      expect(resolveBackupConfig().dir).toBe(join(homedir(), '.memory', 'backups'));

      // Host-injected env (D5).
      process.env.SOX_AUTO_BACKUP_DIR = '~/env-backups';
      expect(resolveBackupConfig().dir).toBe(join(homedir(), 'env-backups'));

      // Typed config seam wins over the env.
      expect(resolveBackupConfig({ dir: '~/typed-backups' }).dir).toBe(
        join(homedir(), 'typed-backups'),
      );
    } finally {
      if (saved === undefined) delete process.env.SOX_AUTO_BACKUP_DIR;
      else process.env.SOX_AUTO_BACKUP_DIR = saved;
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });

  it('no SOX_BACKUP_* toggle env var exists or is honored (ADR-0013)', () => {
    // A stale toggle-shaped var (whatever name) must not change anything:
    // there is no code path that reads one, and resolveBackupConfig's result
    // is identical whether or not it is present.
    const before = resolveBackupConfig();
    process.env.SOX_BACKUP_ENABLED = '0';
    const after = resolveBackupConfig();
    delete process.env.SOX_BACKUP_ENABLED;
    expect(after).toEqual(before);
    expect(after.enabled).toBe(true);
  });
});
