/**
 * libs/install-engine/src/diff.ts
 *
 * diff — ledger vs disk drift detection, cross-scope.
 *
 * Invariants carried from _shared.md:
 *   [inv:ledger-reversible]  — ledger is the source of truth for what sox placed.
 *   [inv:host-agnostic-type] — targets come from ledger (resolved at install time
 *                              via host-registry; no literal paths here).
 *   [inv:boundary]           — verification tops out at "present + valid at target";
 *                              sox never asserts the foreign host ran the content.
 *   [dod.5]                  — external edit to a ledger-tracked file is reported
 *                              as "drifted" by diff.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Ledger, LedgerAction } from './ledger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Result of diffing a single ledger action against disk.
 *
 *   up-to-date  — file/key present, hash matches the applied hash.
 *   drifted     — file/key present but hash differs from the applied hash
 *                 ([dod.5]: external edit detected).
 *   missing     — the target file/key sox placed is no longer present.
 *   will-change — the desired value differs from what was applied (update pending).
 */
export type DiffKind = 'up-to-date' | 'drifted' | 'missing' | 'will-change';

export interface ActionDiff {
  /** Capability that placed this content. */
  cap: LedgerAction['cap'];
  /** File path tracked by this action. */
  file: string;
  /** Key path within the file (for config-merge / array-merge). */
  keyPath: string;
  /** Diff result. */
  kind: DiffKind;
  /** Current on-disk hash (if the file is present). */
  currentHash?: string | undefined;
  /** Hash recorded in the ledger at apply time. */
  appliedHash?: string | undefined;
}

export interface ExtensionDiff {
  ext: string;
  host: string;
  scope: string;
  actions: ActionDiff[];
  /** true iff all actions are up-to-date */
  clean: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sha256(value: unknown): string {
  const s = value === undefined ? '\0undefined' : JSON.stringify(value);
  return 'sha256:' + crypto.createHash('sha256').update(s).digest('hex');
}

function hashFile(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return 'sha256:' + crypto.createHash('sha256').update(data).digest('hex');
}

/** Read a config file — format-aware (TOML for .toml; JSON otherwise). */
function readConfigForDiff(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (filePath.endsWith('.toml')) {
      return parseTomlForDiff(raw);
    }
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Minimal TOML parser for diff — handles the key=value / [table] subset needed
 * to read config-merge output. Same logic as capabilities/config-merge.ts.
 */
function parseTomlForDiff(src: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let current: Record<string, unknown> = root;
  const lines = src.split('\n');
  for (const raw of lines) {
    if (raw === undefined) continue;
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    if (line.startsWith('[') && !line.startsWith('[[')) {
      const end = line.indexOf(']');
      if (end === -1) continue;
      const header = line.slice(1, end).trim();
      const parts = header.split('.').map((s) => s.replace(/^["']|["']$/g, '').trim());
      current = root;
      for (const part of parts) {
        if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) {
          current[part] = {};
        }
        current = current[part] as Record<string, unknown>;
      }
      continue;
    }

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const rawKey = line.slice(0, eqIdx).trim().replace(/^["']|["']$/g, '');
    const rawVal = line.slice(eqIdx + 1).trim();
    current[rawKey] = parseTomlValueForDiff(rawVal);
  }
  return root;
}

function parseTomlValueForDiff(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if ((raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  if (raw.startsWith('{')) {
    // Inline table — treat as opaque string for diff purposes
    return raw;
  }
  const n = Number(raw);
  if (!isNaN(n) && raw !== '') return n;
  return raw;
}

function getByKeyPath(obj: Record<string, unknown>, parts: string[]): unknown {
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

// ─── Per-action diff ─────────────────────────────────────────────────────────

function diffAction(action: LedgerAction, scopeRoot?: string): ActionDiff {
  // Resolve relative paths (project ledger stores repo-relative paths).
  // [inv:ledger-reversible]: absolute paths used for user scope; relative for project.
  const resolveFile = (f: string): string =>
    path.isAbsolute(f) ? f : (scopeRoot !== undefined ? path.join(scopeRoot, f) : f);
  // Shadow action.file with resolved path for all checks below.
  const actionFile = resolveFile(action.file);
  const resolvedAction = { ...action, file: actionFile };
  action = resolvedAction;
  const base: ActionDiff = {
    cap: action.cap,
    file: action.file,
    keyPath: action.keyPath,
    kind: 'up-to-date',
    appliedHash: action.appliedHash,
  };

  switch (action.cap) {
    case 'file-drop': {
      if (!fs.existsSync(action.file)) {
        return { ...base, kind: 'missing' };
      }
      if (action.appliedHash === undefined) {
        // No hash recorded — treat as up-to-date (older install).
        return { ...base, kind: 'up-to-date' };
      }
      const currentHash = hashFile(action.file);
      if (currentHash === action.appliedHash) {
        return { ...base, kind: 'up-to-date', currentHash };
      }
      // [dod.5]: external edit — hash differs.
      return { ...base, kind: 'drifted', currentHash };
    }

    case 'config-merge': {
      if (!fs.existsSync(action.file)) {
        return { ...base, kind: 'missing' };
      }
      const config = readConfigForDiff(action.file);
      const parts = action.keyPath.split('.').filter(Boolean);
      const current = getByKeyPath(config, parts);
      if (current === undefined) {
        return { ...base, kind: 'missing' };
      }
      const currentHash = sha256(current);
      if (action.appliedHash === undefined) {
        return { ...base, kind: 'up-to-date', currentHash };
      }
      if (currentHash === action.appliedHash) {
        return { ...base, kind: 'up-to-date', currentHash };
      }
      // [dod.5]: external edit detected.
      return { ...base, kind: 'drifted', currentHash };
    }

    case 'array-merge': {
      if (!fs.existsSync(action.file)) {
        return { ...base, kind: 'missing' };
      }
      if (!action.values || action.values.length === 0) {
        return { ...base, kind: 'up-to-date' };
      }
      const config = readConfigForDiff(action.file);
      const parts = action.keyPath.split('.').filter(Boolean);
      const current = getByKeyPath(config, parts);
      if (!Array.isArray(current)) {
        return { ...base, kind: 'missing' };
      }
      const currentSet = new Set(current.map(String));
      const allPresent = action.values.every((v) => currentSet.has(v));
      if (!allPresent) {
        return { ...base, kind: 'drifted' };
      }
      return { ...base, kind: 'up-to-date' };
    }

    case 'materialize':
    case 'bin-link':
    case 'run-service': {
      // These are not tracked by content hash in the ledger.
      // Presence check: does the file exist?
      if (!fs.existsSync(action.file)) {
        return { ...base, kind: 'missing' };
      }
      return { ...base, kind: 'up-to-date' };
    }

    default: {
      // Unknown capability — treat as up-to-date (conservative).
      return { ...base, kind: 'up-to-date' };
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * diff — compare ledger vs disk for a given (ext, host, scope).
 *
 * Returns an ExtensionDiff with per-action results.
 * [dod.5]: external edits show as 'drifted'.
 * [inv:boundary]: verification tops out at present+valid; no host-execution assertion.
 */
export function diff(
  ext: string,
  host: string,
  scope: string,
  scopeRoot: string,
  opts?: { ledger?: Ledger; isProject?: boolean },
): ExtensionDiff {
  const ledger =
    opts?.ledger ?? Ledger.load(scopeRoot, { isProject: opts?.isProject ?? false });
  const actions = ledger.actionsFor(ext, host, scope);

  const actionDiffs = actions.map((a) => diffAction(a, scopeRoot));
  const clean = actionDiffs.every((a) => a.kind === 'up-to-date');

  return { ext, host, scope, actions: actionDiffs, clean };
}

/**
 * diffAll — diff every entry in the ledger at scopeRoot.
 * Useful for cross-scope drift reports.
 */
export function diffAll(
  scopeRoot: string,
  opts?: { ledger?: Ledger; isProject?: boolean },
): ExtensionDiff[] {
  const ledger =
    opts?.ledger ?? Ledger.load(scopeRoot, { isProject: opts?.isProject ?? false });
  return ledger.entries().map((entry) =>
    diff(entry.ext, entry.host, entry.scope, scopeRoot, opts?.isProject !== undefined ? { ledger, isProject: opts.isProject } : { ledger }),
  );
}
