/**
 * libs/install-engine/src/install-registry.ts — Global install ledger (P9)
 *
 * Tracks every successful `soxe install` across all projects on this machine.
 * Written using atomic rename. All writes are best-effort — a failure here must
 * never fail the install.
 *
 * File: $SOX_ECOSYSTEM_HOME/install-registry.json (ADR-0004 §D7; default
 * ~/.adhd/sox-ecosystem/install-registry.json). Resolved via the data-paths leaf
 * (kept in parity with the host-runtime resolver by data-paths.parity.spec.ts).
 * Natural key for dedup: (extId, scope, root)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { installRegistryPath } from './data-paths.js';

// ─── Schema ───────────────────────────────────────────────────────────────────

export interface InstallRecord {
  /** Extension ID (bare, no version) */
  extId: string;
  /** Version resolved at install time (e.g. "0.1.0") */
  version: string;
  /** Scope under which the extension was installed */
  scope: 'user' | 'project' | 'local';
  /** Absolute path to the root directory used at install time (the --root value) */
  root: string;
  /** ISO 8601 timestamp of the first install of this extId+scope+root combination */
  installedAt: string;
  /** ISO 8601 timestamp of the most recent `soxe install` that touched this record */
  updatedAt: string;
  /** Source URI from the lockfile entry at install time (file:// or https://) */
  source: string;
}

export interface InstallRegistry {
  version: 1;
  installs: InstallRecord[];
}

// ─── Path resolution ──────────────────────────────────────────────────────────

export function resolveInstallRegistryPath(): string {
  // ADR-0004 §D7: global install ledger under the user data root.
  return installRegistryPath();
}

// ─── Read / write ─────────────────────────────────────────────────────────────

export function readInstallRegistry(registryPath: string): InstallRegistry {
  if (!fs.existsSync(registryPath)) {
    return { version: 1, installs: [] };
  }
  try {
    const raw = fs.readFileSync(registryPath, 'utf8');
    const parsed = JSON.parse(raw) as InstallRegistry;
    if (!Array.isArray(parsed.installs)) {
      return { version: 1, installs: [] };
    }
    return parsed;
  } catch {
    return { version: 1, installs: [] };
  }
}

export function writeInstallRegistryAtomic(
  registryPath: string,
  registry: InstallRegistry,
): void {
  const dir = path.dirname(registryPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = registryPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, registryPath);
}

// ─── Upsert ───────────────────────────────────────────────────────────────────

export interface UpsertInstallRecordOpts {
  extId: string;
  version: string;
  scope: string;
  root: string;
  source: string;
}

/**
 * Upsert an install record into ~/.sox/install-registry.json.
 * Natural key: (extId, scope, root). If the same extension is reinstalled or
 * updated at the same scope+root, the existing record is updated in place —
 * version, updatedAt, source are refreshed; installedAt is preserved.
 * Best-effort: callers must wrap in try/catch and continue on failure.
 */
export function upsertInstallRecord(opts: UpsertInstallRecordOpts): void {
  const registryPath = resolveInstallRegistryPath();
  const registry = readInstallRegistry(registryPath);

  const now = new Date().toISOString();
  const scope = opts.scope as 'user' | 'project' | 'local';

  const existingIdx = registry.installs.findIndex(
    (r) => r.extId === opts.extId && r.scope === scope && r.root === opts.root,
  );

  if (existingIdx !== -1) {
    const existing = registry.installs[existingIdx]!;
    registry.installs[existingIdx] = {
      ...existing,
      version: opts.version,
      updatedAt: now,
      source: opts.source,
    };
  } else {
    registry.installs.push({
      extId: opts.extId,
      version: opts.version,
      scope,
      root: opts.root,
      installedAt: now,
      updatedAt: now,
      source: opts.source,
    });
  }

  writeInstallRegistryAtomic(registryPath, registry);
}

// ─── Remove ───────────────────────────────────────────────────────────────────

/**
 * Remove the install record matching (extId, scope, root) from the ledger.
 * No-op if no matching record exists.
 * Best-effort: callers must wrap in try/catch and continue on failure.
 */
export function removeInstallRecord(
  extId: string,
  scope: string,
  root: string,
): void {
  const registryPath = resolveInstallRegistryPath();
  const registry = readInstallRegistry(registryPath);
  const filtered = registry.installs.filter(
    (r) => !(r.extId === extId && r.scope === scope && r.root === root),
  );
  if (filtered.length === registry.installs.length) return; // no-op: no matching record
  writeInstallRegistryAtomic(registryPath, { version: 1, installs: filtered });
}
