/**
 * libs/install-engine/src/capabilities/object-array-merge.ts
 *
 * object-array-merge capability — append object entries to an array in a shared
 * config file with identity-scoped reversible removal.
 * [def:capability], [inv:ledger-reversible], [ref:ledger-reversible]
 *
 * Unlike array-merge (which works with string[]), this works with arrays of
 * objects where each entry carries a stable identity field (e.g. `_sox: <extId>`).
 * Used for Claude Code PostToolUse hooks: the hook requires a { matcher, hooks }
 * object appended to settings.json → hooks.PostToolUse[], and uninstall must
 * remove ONLY sox-added entries while leaving foreign hooks intact.
 *
 * Identity-scoped: append entries tagged with a stable identity; reverse removes
 * ONLY entries carrying that identity. Foreign entries (same shape, different
 * identity, or no identity field) are untouched.
 *
 * Action  : append entries to the target array, skip if identity already present
 * Reverse : remove entries carrying the sox identity field from the ledger
 * Update  : diff desired identity entries vs currently installed
 * Verify  : all desired identity entries present in target array
 */

import * as fs from 'fs';
import * as path from 'path';

import { Ledger, LedgerAction } from '../ledger.js';

// --- Types ---

export interface ObjectArrayMergeTarget {
  /** Absolute path to the shared config file (JSON). */
  filePath: string;
  /** Dot-separated key path to the array field, e.g. "hooks.PostToolUse". */
  keyPath: string;
}

export interface ObjectArrayMergePayload {
  /** Object entries to append (deny-wins by identity — not re-appended). */
  entries: Record<string, unknown>[];
  /** The field name used for stable identity matching (e.g. "_sox"). */
  identityField: string;
  /** The value that soxe writes into identityField (e.g. the extension id). */
  identityValue: string;
}

export interface ObjectArrayMergeCtx {
  host: string;
  scope: string;
  scopeRoot: string;
  isProject?: boolean;
  ext: string;
  target: ObjectArrayMergeTarget;
  payload: ObjectArrayMergePayload;
  ledger?: Ledger;
}

export interface Diff {
  kind: 'none' | 'update' | 'add' | 'remove';
  toAdd?: string[];
  toRemove?: string[];
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  missing?: string[];
}

// --- Helpers ---

function readConfig(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

function writeConfig(filePath: string, data: Record<string, unknown>): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function parseKeyPath(keyPath: string): string[] {
  return keyPath.split('.').filter(Boolean);
}

function getByKeyPath(obj: Record<string, unknown>, parts: string[]): unknown {
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function setByKeyPath(obj: Record<string, unknown>, parts: string[], value: unknown): void {
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (p === undefined) continue;
    if (typeof cur[p] !== 'object' || cur[p] === null || Array.isArray(cur[p])) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (last !== undefined) cur[last] = value;
}

// --- Capability ---

/**
 * apply — append entries to the target object array (deny-wins by identity).
 * Records a LedgerAction with the exact entries appended ([inv:ledger-reversible]).
 * Idempotent: re-apply is a no-op if the identity is already present.
 */
export async function apply(ctx: ObjectArrayMergeCtx): Promise<void> {
  const { filePath, keyPath } = ctx.target;
  const { entries, identityField, identityValue } = ctx.payload;
  const parts = parseKeyPath(keyPath);

  const config = readConfig(filePath);
  const existing = getByKeyPath(config, parts);
  const arr: Record<string, unknown>[] = Array.isArray(existing)
    ? (existing as Record<string, unknown>[])
    : [];

  // Deny-wins: only append entries whose identity is NOT already in the array
  const existingIdentities = new Set(
    arr
      .filter((e) => e[identityField] === identityValue)
      .map((e) => JSON.stringify(e)),
  );
  const toAdd = entries.filter(
    (e) => !existingIdentities.has(JSON.stringify(e)),
  );
  if (toAdd.length === 0) return; // idempotent — nothing to do

  const updated = [...arr, ...toAdd];
  setByKeyPath(config, parts, updated);
  writeConfig(filePath, config);

  const ledger = ctx.ledger ?? Ledger.load(ctx.scopeRoot, ctx.isProject !== undefined ? { isProject: ctx.isProject } : undefined);
  const action: LedgerAction = {
    cap: 'object-array-merge',
    file: ctx.target.filePath,
    keyPath,
    // Store the serialized entries + identity so reverse can match them exactly.
    meta: {
      entries: toAdd,
      identityField,
      identityValue,
    },
  };
  ledger.record({ ext: ctx.ext, host: ctx.host, scope: ctx.scope, action });
  ledger.save();
}

/**
 * reverse — remove ONLY the entries soxe appended (from ledger), leave others.
 * Foreign entries present before sox's apply are preserved ([inv:ledger-reversible]).
 */
export async function reverse(ctx: ObjectArrayMergeCtx): Promise<void> {
  const { filePath, keyPath } = ctx.target;
  const ledger = ctx.ledger ?? Ledger.load(ctx.scopeRoot, ctx.isProject !== undefined ? { isProject: ctx.isProject } : undefined);
  const actions = ledger.actionsFor(ctx.ext, ctx.host, ctx.scope);
  const matched = actions.filter(
    (a) => a.cap === 'object-array-merge' && a.file === filePath && a.keyPath === keyPath,
  );
  if (matched.length === 0) return;

  // Collect all identity entries soxe appended across all ledger actions for this key
  const removedHashes = new Set<string>();
  for (const a of matched) {
    const metaEntries = a.meta?.entries as Record<string, unknown>[] | undefined;
    if (Array.isArray(metaEntries)) {
      for (const e of metaEntries) {
        removedHashes.add(JSON.stringify(e));
      }
    }
  }
  if (removedHashes.size === 0) return;

  if (!fs.existsSync(filePath)) {
    ledger.remove(ctx.ext, ctx.host, ctx.scope);
    ledger.save();
    return;
  }

  const config = readConfig(filePath);
  const parts = parseKeyPath(keyPath);
  const existing = getByKeyPath(config, parts);
  const arr: Record<string, unknown>[] = Array.isArray(existing)
    ? (existing as Record<string, unknown>[])
    : [];

  const updated = arr.filter((e) => !removedHashes.has(JSON.stringify(e)));
  setByKeyPath(config, parts, updated);
  writeConfig(filePath, config);

  ledger.remove(ctx.ext, ctx.host, ctx.scope);
  ledger.save();
}

/**
 * update — diff desired entries vs currently installed.
 */
export async function update(ctx: ObjectArrayMergeCtx): Promise<Diff> {
  const { filePath, keyPath } = ctx.target;
  const { entries, identityField, identityValue } = ctx.payload;

  if (!fs.existsSync(filePath)) return { kind: 'add' };

  const config = readConfig(filePath);
  const parts = parseKeyPath(keyPath);
  const existing = getByKeyPath(config, parts);
  const arr: Record<string, unknown>[] = Array.isArray(existing)
    ? (existing as Record<string, unknown>[])
    : [];

  // Check if all desired entries with our identity are present
  const ourEntries = arr.filter((e) => e[identityField] === identityValue);
  const ourHashes = new Set(ourEntries.map((e) => JSON.stringify(e)));
  const desiredHashes = new Set(entries.map((e) => JSON.stringify(e)));

  const toAdd = entries.filter((e) => !ourHashes.has(JSON.stringify(e)));
  if (toAdd.length === 0 && ourHashes.size === desiredHashes.size) return { kind: 'none' };
  return { kind: 'update' };
}

/**
 * verify — all desired identity entries present in the target array.
 */
export async function verify(ctx: ObjectArrayMergeCtx): Promise<VerifyResult> {
  const { filePath, keyPath } = ctx.target;
  const { entries, identityField, identityValue } = ctx.payload;

  if (!fs.existsSync(filePath)) {
    return { ok: false, reason: `config file not found: ${filePath}`, missing: entries.map((e) => JSON.stringify(e)) };
  }
  const config = readConfig(filePath);
  const parts = parseKeyPath(keyPath);
  const existing = getByKeyPath(config, parts);
  const arr: Record<string, unknown>[] = Array.isArray(existing)
    ? (existing as Record<string, unknown>[])
    : [];

  const ourEntries = arr.filter((e) => e[identityField] === identityValue);
  const ourHashes = new Set(ourEntries.map((e) => JSON.stringify(e)));
  const missing = entries.filter((e) => !ourHashes.has(JSON.stringify(e)));
  if (missing.length > 0) {
    return { ok: false, reason: `missing entries for identity '${identityValue}'`, missing: missing.map((e) => JSON.stringify(e)) };
  }
  return { ok: true };
}
