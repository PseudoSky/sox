/**
 * libs/install-engine/src/capabilities/array-merge.ts
 *
 * array-merge capability — append values to an array in a shared config file.
 * [def:capability], [inv:ledger-reversible], [ref:ledger-reversible]
 *
 * Deny-wins: if a value is already present, do NOT append it again.
 * Records the exact appended values in the ledger ([shape:ledger-action]).
 * Reverse removes ONLY the values soxe appended — foreign values untouched.
 *
 * Works on both JSON and TOML targets (format detected from file extension).
 * Delegates JSON/TOML read-write to config-merge helpers.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Ledger, LedgerAction } from '../ledger.js';

// --- Types ---

export interface ArrayMergeTarget {
  /** Absolute path to the shared config file (JSON or TOML). */
  filePath: string;
  /** Dot-separated key path to the array field, e.g. "projects[repo].enabledMcpjsonServers". */
  keyPath: string;
}

export interface ArrayMergePayload {
  /** Values to append (deny-wins — duplicates are not re-appended). */
  values: string[];
}

export interface ArrayMergeCtx {
  host: string;
  scope: string;
  scopeRoot: string;
  isProject?: boolean;
  ext: string;
  target: ArrayMergeTarget;
  payload: ArrayMergePayload;
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

// --- Helpers (minimal, inline — avoids cross-import cycle with config-merge) ---

function isToml(filePath: string): boolean {
  return filePath.endsWith('.toml');
}

function readConfig(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8');
  if (isToml(filePath)) {
    // Minimal TOML reader — reuse same approach as config-merge
    return parseTomlFlat(raw);
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

/** Very small TOML reader that just builds a flat nested object for array fields. */
function parseTomlFlat(src: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let current: Record<string, unknown> = root;
  for (const rawLine of src.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      const isArray = line.startsWith('[[');
      const end = isArray ? line.indexOf(']]') : line.indexOf(']');
      if (end === -1) continue;
      const header = isArray ? line.slice(2, end) : line.slice(1, end);
      const parts = header.trim().split('.').map((p) => p.trim().replace(/^["']|["']$/g, ''));
      current = root;
      for (const p of parts) {
        if (typeof current[p] !== 'object' || current[p] === null) current[p] = {};
        current = current[p] as Record<string, unknown>;
      }
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (v.startsWith('[')) {
      const inner = v.slice(1, v.lastIndexOf(']')).trim();
      current[k] = inner ? inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')) : [];
    } else {
      current[k] = v.replace(/^["']|["']$/g, '');
    }
  }
  return root;
}

function writeConfig(filePath: string, data: Record<string, unknown>): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (isToml(filePath)) {
    fs.writeFileSync(filePath, serializeTomlFlat(data), 'utf8');
  } else {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }
}

function serializeTomlFlat(obj: Record<string, unknown>, prefix: string[] = []): string {
  const lines: string[] = [];
  const tables: Array<{ keys: string[]; val: Record<string, unknown> }> = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      tables.push({ keys: [...prefix, k], val: v as Record<string, unknown> });
    } else if (Array.isArray(v)) {
      lines.push(`${k} = [${(v as unknown[]).map((x) => JSON.stringify(x)).join(', ')}]`);
    } else {
      lines.push(`${k} = ${JSON.stringify(v)}`);
    }
  }
  let out = '';
  if (prefix.length > 0 && lines.length > 0) {
    out += `[${prefix.join('.')}]\n` + lines.join('\n') + '\n';
  } else if (lines.length > 0) {
    out += lines.join('\n') + '\n';
  }
  for (const { keys, val } of tables) {
    out += '\n' + serializeTomlFlat(val, keys);
  }
  return out;
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
 * apply — append values to the target array (deny-wins: no duplicates).
 * Records a LedgerAction with the exact values appended ([inv:ledger-reversible]).
 * Idempotent: re-apply is a no-op if all values are already present.
 */
export async function apply(ctx: ArrayMergeCtx): Promise<void> {
  const { filePath, keyPath } = ctx.target;
  const { values } = ctx.payload;
  const parts = parseKeyPath(keyPath);

  const config = readConfig(filePath);
  const existing = getByKeyPath(config, parts);
  const arr: string[] = Array.isArray(existing)
    ? (existing as unknown[]).map(String)
    : [];

  // Deny-wins: only append values not already in the array
  const toAdd = values.filter((v) => !arr.includes(v));
  if (toAdd.length === 0) return; // idempotent — nothing to do

  const updated = [...arr, ...toAdd];
  setByKeyPath(config, parts, updated);
  writeConfig(filePath, config);

  const ledger = ctx.ledger ?? Ledger.load(ctx.scopeRoot, ctx.isProject !== undefined ? { isProject: ctx.isProject } : undefined);
  const action: LedgerAction = {
    cap: 'array-merge',
    file: ctx.target.filePath,
    keyPath,
    values: toAdd, // exact appended values
  };
  ledger.record({ ext: ctx.ext, host: ctx.host, scope: ctx.scope, action });
  ledger.save();
}

/**
 * reverse — remove ONLY the values soxe appended (from ledger), leave others.
 * Foreign values present before sox's apply are preserved ([inv:ledger-reversible]).
 */
export async function reverse(ctx: ArrayMergeCtx): Promise<void> {
  const { filePath, keyPath } = ctx.target;
  const ledger = ctx.ledger ?? Ledger.load(ctx.scopeRoot, ctx.isProject !== undefined ? { isProject: ctx.isProject } : undefined);
  const actions = ledger.actionsFor(ctx.ext, ctx.host, ctx.scope);
  const matched = actions.filter(
    (a) => a.cap === 'array-merge' && a.file === filePath && a.keyPath === keyPath
  );
  if (matched.length === 0) return;

  // Collect all values soxe appended across all ledger actions for this key
  const soxValues = new Set<string>(
    matched.flatMap((a) => a.values ?? [])
  );
  if (soxValues.size === 0) return;

  if (!fs.existsSync(filePath)) {
    ledger.remove(ctx.ext, ctx.host, ctx.scope);
    ledger.save();
    return;
  }

  const config = readConfig(filePath);
  const parts = parseKeyPath(keyPath);
  const existing = getByKeyPath(config, parts);
  const arr: string[] = Array.isArray(existing) ? (existing as unknown[]).map(String) : [];

  const updated = arr.filter((v) => !soxValues.has(v));
  setByKeyPath(config, parts, updated);
  writeConfig(filePath, config);

  ledger.remove(ctx.ext, ctx.host, ctx.scope);
  ledger.save();
}

/**
 * update — diff desired values vs currently installed values.
 */
export async function update(ctx: ArrayMergeCtx): Promise<Diff> {
  const { filePath, keyPath } = ctx.target;
  const { values } = ctx.payload;

  if (!fs.existsSync(filePath)) return { kind: 'add', toAdd: values };

  const config = readConfig(filePath);
  const parts = parseKeyPath(keyPath);
  const existing = getByKeyPath(config, parts);
  const arr: string[] = Array.isArray(existing) ? (existing as unknown[]).map(String) : [];

  const toAdd = values.filter((v) => !arr.includes(v));
  if (toAdd.length === 0) return { kind: 'none' };
  return { kind: 'update', toAdd };
}

/**
 * verify — all payload values present in the target array.
 */
export async function verify(ctx: ArrayMergeCtx): Promise<VerifyResult> {
  const { filePath, keyPath } = ctx.target;
  const { values } = ctx.payload;

  if (!fs.existsSync(filePath)) {
    return { ok: false, reason: `config file not found: ${filePath}`, missing: values };
  }
  const config = readConfig(filePath);
  const parts = parseKeyPath(keyPath);
  const existing = getByKeyPath(config, parts);
  const arr: string[] = Array.isArray(existing) ? (existing as unknown[]).map(String) : [];
  const missing = values.filter((v) => !arr.includes(v));
  if (missing.length > 0) {
    return { ok: false, reason: `missing values: ${missing.join(', ')}`, missing };
  }
  return { ok: true };
}
