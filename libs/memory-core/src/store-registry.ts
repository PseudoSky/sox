/**
 * store-registry.ts — Named-store registry (SA-6 / BL-130, CONTRACTS §I/H).
 *
 * Resolves a logical store name (`store:"user"`, `store:"project"`, etc.) to a
 * physical db_path via `~/.memory/registry.json`. Every resolved path is echoed
 * alongside a fingerprint (file size + mtime) so callers can verify they are
 * reading the expected store.
 *
 * The raw `db_path` parameter is still accepted with a deprecation warning —
 * callers SHOULD migrate to `store:"<name>"` to avoid path-guessing.
 *
 * [inv:store-registry-misroute] — an unknown name NEVER creates a new file.
 * It returns a structured error (code: E_UNKNOWN_STORE).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expandDbPath } from './db.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type StoreRegistry = Record<string, string>;

export interface ResolvedStore {
  /** The logical store name (from `store` param). */
  name: string;
  /** The resolved absolute path. */
  path: string;
  /** File fingerprint: `${size}:${mtimeMs}` for quick identity check. */
  fingerprint: string;
  /** True when resolved via the store name (not via raw db_path). */
  viaRegistry: boolean;
}

export interface StoreResolveError {
  code: 'E_UNKNOWN_STORE';
  message: string;
  name: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Default registry path. Computed lazily so that tests can set HOME via
 * process.env before calling registry functions.
 */
function getRegistryPath(): string {
  return path.join(os.homedir(), '.memory', 'registry.json');
}

// ── Registry I/O ──────────────────────────────────────────────────────────────

/**
 * Read the store registry from disk.
 * Returns an empty object if the file does not exist or is malformed.
 */
export function readStoreRegistry(): StoreRegistry {
  const registryPath = getRegistryPath();
  try {
    if (!fs.existsSync(registryPath)) return {};
    const raw = fs.readFileSync(registryPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as StoreRegistry;
    }
    return {};
  } catch {
    return {};
  }
}

// ── Fingerprint ────────────────────────────────────────────────────────────────

/**
 * Compute a quick file fingerprint: `${size}:${mtimeMs}`.
 * Returns an empty string if the file does not exist or is unreadable.
 */
export function computeFingerprint(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return '';
  }
}

// ── Resolution ────────────────────────────────────────────────────────────────

/**
 * Resolve a `store` name to a ResolvedStore.
 *
 * 1. Reads `~/.memory/registry.json`.
 * 2. Looks up the name.
 * 3. If found → returns `{ name, path: resolved, fingerprint, viaRegistry: true }`.
 * 4. If NOT found → returns `{ code: 'E_UNKNOWN_STORE', message, name }`.
 *
 * NEVER writes to disk.
 */
export function resolveStoreName(
  name: string,
): ResolvedStore | StoreResolveError {
  const trimmed = name.trim();
  if (!trimmed) {
    return {
      code: 'E_UNKNOWN_STORE',
      message: 'Store name is empty',
      name: trimmed,
    };
  }

  const registry = readStoreRegistry();
  const rawPath = registry[trimmed];

  if (!rawPath || typeof rawPath !== 'string') {
    return {
      code: 'E_UNKNOWN_STORE',
      message: `Store "${trimmed}" is not registered in ~/.memory/registry.json. ` +
        `Available names: ${Object.keys(registry).join(', ') || '(none)'}. ` +
        `Use memory init --store <name> --path <db_path> to register, or pass db_path directly.`,
      name: trimmed,
    };
  }

  const resolvedPath = path.resolve(expandDbPath(rawPath));
  return {
    name: trimmed,
    path: resolvedPath,
    fingerprint: computeFingerprint(resolvedPath),
    viaRegistry: true,
  };
}

/**
 * Resolve either a `store` name or a raw `db_path`.
 *
 * Precedence:
 *   1. `store` param → resolveStoreName (registry lookup).
 *   2. `db_path` param → accept with deprecation warning (console.warn).
 *   3. Neither → returns null for caller to use default.
 *
 * When `store` is given AND `db_path` is also given, `store` wins (registry
 * is authoritative; the caller should not pass both).
 */
export function resolveStoreOrDbPath(
  store: unknown,
  dbPath: unknown,
): ResolvedStore | StoreResolveError | null {
  // `store` param takes precedence
  if (typeof store === 'string' && store.trim()) {
    if (typeof dbPath === 'string' && dbPath.trim()) {
      console.warn(
        `[sox-memory] Both "store" and "db_path" provided. "store" takes precedence (registry is authoritative).`,
      );
    }
    return resolveStoreName(store);
  }

  // `db_path` param — accept with deprecation warning
  if (typeof dbPath === 'string' && dbPath.trim()) {
    const resolvedPath = path.resolve(expandDbPath(dbPath));
    console.warn(
      `[sox-memory] DEPRECATED: raw "db_path" parameter "${dbPath}" resolved to "${resolvedPath}". ` +
        `Use "store" instead (e.g., store:"default") to avoid path-guessing. ` +
        `This path will be removed in the next minor version.`,
    );
    return {
      name: '(raw db_path)',
      path: resolvedPath,
      fingerprint: computeFingerprint(resolvedPath),
      viaRegistry: false,
    };
  }

  return null;
}
