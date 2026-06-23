/**
 * libs/install-engine/src/capabilities/config-merge.ts
 *
 * config-merge capability — set a key/sub-table in a shared config file.
 * [def:capability], [inv:format-aware-merge], [inv:ledger-reversible],
 * [ref:config-merge-format], [ref:ledger-reversible]
 *
 * FORMAT-AWARE: handles BOTH JSON (settings.json / .mcp.json / ~/.claude.json)
 * and TOML (codex config.toml) through the SAME entry point.
 * Format is detected from the file extension (.toml → TOML; otherwise JSON).
 *
 * Action  : set keyPath to value in target file; record ledger action with appliedHash
 * Reverse : read ledger; remove ONLY sox-owned key (foreign keys untouched)
 * Update  : compare current value hash vs appliedHash in ledger
 * Verify  : key present AND value hash matches ledger entry
 *
 * [inv:ledger-reversible]: every apply writes a LedgerAction with appliedHash.
 * [inv:never-managed]: callers must not pass managed/forbidden keys — not enforced here.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Ledger, LedgerAction } from '../ledger.js';

// --- Types ---

export interface ConfigMergeTarget {
  /** Absolute path to the shared config file (JSON or TOML). */
  filePath: string;
  /** Dot-separated key path within the file, e.g. "mcpServers.tokenguard". */
  keyPath: string;
}

export interface ConfigMergePayload {
  /** The value to set at keyPath. Must be JSON-serialisable. */
  value: unknown;
}

export interface ConfigMergeCtx {
  host: string;
  scope: string;
  /**
   * The resolved data directory (ADR-0004 §D2: `.adhd/sox-ecosystem` for the
   * scope) used to locate the ledger. NOT the host placement root.
   */
  scopeRoot: string;
  /**
   * Workspace root — the base for project-scope relative ledger paths
   * (portability). When omitted, falls back to scopeRoot for back-compat.
   */
  workspaceRoot?: string;
  /** Whether this is a project-scope install (affects ledger portability). */
  isProject?: boolean;
  ext: string;
  target: ConfigMergeTarget;
  payload: ConfigMergePayload;
  ledger?: Ledger;
}

export interface Diff {
  kind: 'none' | 'update' | 'add' | 'remove';
  currentHash?: string | undefined;
  appliedHash?: string | undefined;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

// --- Minimal TOML parser/writer ---
// We implement a minimal subset of TOML sufficient for config-merge:
// - Flat key=value (strings, integers, booleans)
// - Dot-notation keys (table headers [a.b])
// - Quoted and unquoted keys
// - Inline tables for MCP entry values
//
// No external dependency — avoids adding toml to node_modules.

type TomlValue = string | number | boolean | null | TomlTable | TomlValue[];
interface TomlTable { [key: string]: TomlValue }

function isTomlTable(v: TomlValue | undefined): v is TomlTable {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse a TOML string into a nested object (subset). */
export function parseToml(src: string): TomlTable {
  const root: TomlTable = {};
  let current: TomlTable = root;
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === undefined) continue;
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    // Table header: [a.b.c] or [[array.table]]
    if (line.startsWith('[')) {
      // Skip array-of-tables (not needed for config-merge)
      const isArray = line.startsWith('[[');
      const end = isArray ? line.indexOf(']]') : line.indexOf(']');
      if (end === -1) continue;
      const headerRaw = isArray ? line.slice(2, end) : line.slice(1, end);
      const parts = splitTomlKey(headerRaw.trim());
      current = root;
      for (const part of parts) {
        if (!isTomlTable(current[part])) {
          current[part] = {};
        }
        current = current[part] as TomlTable;
      }
      continue;
    }

    // Key = value
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const rawKey = line.slice(0, eqIdx).trim();
    const rawVal = line.slice(eqIdx + 1).trim();
    const keys = splitTomlKey(rawKey);
    let obj = current;
    for (let k = 0; k < keys.length - 1; k++) {
      const seg = keys[k];
      if (seg === undefined) continue;
      if (!isTomlTable(obj[seg])) obj[seg] = {};
      obj = obj[seg] as TomlTable;
    }
    const lastKey = keys[keys.length - 1];
    if (lastKey === undefined) continue;
    obj[lastKey] = parseTomlValue(rawVal);
  }
  return root;
}

function splitTomlKey(raw: string): string[] {
  // Split on unquoted dots
  const parts: string[] = [];
  let cur = '';
  let inQuote = false;
  let quoteChar = '';
  for (const ch of raw) {
    if (inQuote) {
      if (ch === quoteChar) { inQuote = false; } else { cur += ch; }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === '.') {
      parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur.trim());
  return parts;
}

function parseTomlValue(raw: string): TomlValue {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if ((raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  if (raw.startsWith('{')) {
    return parseTomlInlineTable(raw);
  }
  if (raw.startsWith('[')) {
    return parseTomlArray(raw);
  }
  const n = Number(raw);
  if (!isNaN(n) && raw !== '') return n;
  return raw;
}

function parseTomlInlineTable(raw: string): TomlTable {
  const inner = raw.slice(1, raw.lastIndexOf('}')).trim();
  const result: TomlTable = {};
  if (!inner) return result;
  // Simple split on ", " — works for non-nested inline tables
  const pairs = inner.split(',');
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    result[k] = parseTomlValue(v);
  }
  return result;
}

function parseTomlArray(raw: string): TomlValue[] {
  const inner = raw.slice(1, raw.lastIndexOf(']')).trim();
  if (!inner) return [];
  return inner.split(',').map((s) => parseTomlValue(s.trim()));
}

/** Serialise a nested object back to TOML (subset). */
export function stringifyToml(obj: TomlTable, prefix: string[] = []): string {
  const lines: string[] = [];
  const tables: Array<{ keys: string[]; val: TomlTable }> = [];

  for (const [k, v] of Object.entries(obj)) {
    if (isTomlTable(v)) {
      tables.push({ keys: [...prefix, k], val: v });
    } else {
      lines.push(`${tomlKeyStr(k)} = ${tomlValStr(v)}`);
    }
  }

  let out = prefix.length === 0 && lines.length > 0 ? lines.join('\n') + '\n' : '';
  if (prefix.length > 0 && lines.length > 0) {
    out = `[${prefix.join('.')}]\n` + lines.join('\n') + '\n';
  }

  for (const { keys, val } of tables) {
    out += '\n' + stringifyToml(val, keys);
  }
  return out;
}

function tomlKeyStr(k: string): string {
  // Quote key if it contains special chars
  if (/^[a-zA-Z0-9_-]+$/.test(k)) return k;
  return `"${k}"`;
}

function tomlValStr(v: TomlValue): string {
  if (typeof v === 'string') return `"${v}"`;
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (v === null) return 'null';
  if (Array.isArray(v)) return '[' + v.map(tomlValStr).join(', ') + ']';
  if (isTomlTable(v)) {
    const pairs = Object.entries(v).map(([k, val]) => `${tomlKeyStr(k)} = ${tomlValStr(val)}`);
    return '{ ' + pairs.join(', ') + ' }';
  }
  return String(v);
}

// --- JSON helpers ---

function readJson(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

function writeJson(filePath: string, data: Record<string, unknown>): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function readToml(filePath: string): TomlTable {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8');
  return parseToml(raw);
}

function writeToml(filePath: string, data: TomlTable): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, stringifyToml(data), 'utf8');
}

function isToml(filePath: string): boolean {
  return filePath.endsWith('.toml');
}

// --- Key path helpers ---

/** Parse a keyPath string like "a.b.c" or "a[0].b" into segments. */
function parseKeyPath(keyPath: string): string[] {
  return keyPath.split('.').filter(Boolean);
}

/** Get a value by keyPath from a nested object. */
function getByKeyPath(obj: Record<string, unknown>, parts: string[]): unknown {
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Set a value by keyPath in a nested object (mutates). */
function setByKeyPath(obj: Record<string, unknown>, parts: string[], value: unknown): void {
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (p === undefined) continue;
    if (cur[p] === null || typeof cur[p] !== 'object' || Array.isArray(cur[p])) {
      cur[p] = {};
    }
    cur = cur[p] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (last !== undefined) cur[last] = value;
}

/** Delete a key by keyPath from a nested object (mutates). */
function deleteByKeyPath(obj: Record<string, unknown>, parts: string[]): void {
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (p === undefined) continue;
    if (cur[p] === null || typeof cur[p] !== 'object') return;
    cur = cur[p] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (last !== undefined) delete cur[last];
}

// --- Hashing ---

function sha256(value: unknown): string {
  // JSON.stringify(undefined) returns undefined (not a string), so we must guard.
  const s = value === undefined ? '\0undefined' : JSON.stringify(value);
  return 'sha256:' + crypto.createHash('sha256').update(s).digest('hex');
}

// --- Read/write the config file (format-aware) ---

function readConfig(filePath: string): Record<string, unknown> {
  if (isToml(filePath)) {
    return readToml(filePath) as Record<string, unknown>;
  }
  return readJson(filePath);
}

function writeConfig(filePath: string, data: Record<string, unknown>): void {
  if (isToml(filePath)) {
    writeToml(filePath, data as TomlTable);
  } else {
    writeJson(filePath, data);
  }
}

// --- Capability ---

/**
 * apply — set keyPath to value in the target config file.
 * Idempotent: if current hash matches payload hash, skip.
 * Records a LedgerAction with appliedHash ([inv:ledger-reversible]).
 */
export async function apply(ctx: ConfigMergeCtx): Promise<void> {
  const { filePath, keyPath } = ctx.target;
  const { value } = ctx.payload;
  const parts = parseKeyPath(keyPath);

  const config = readConfig(filePath);
  const current = getByKeyPath(config, parts);
  const newHash = sha256(value);
  const currentHash = sha256(current);

  // Idempotent: already set to the same value
  if (current !== undefined && currentHash === newHash) return;

  setByKeyPath(config, parts, value);
  writeConfig(filePath, config);

  // Record ledger action.
  // [inv:ledger-reversible]: project ledger must store repo-relative paths.
  // config-merge targets (e.g. .mcp.json) are absolute at install time but must
  // be stored relative to scopeRoot (= workspaceRoot for project scope) so the
  // ledger remains portable (committed to the repo without machine-specific paths).
  const ledger = ctx.ledger ?? Ledger.load(ctx.scopeRoot, ctx.isProject !== undefined ? { isProject: ctx.isProject } : undefined);
  // Project-ledger portability: store paths relative to the WORKSPACE root (the
  // host placement base), not the data dir. ADR-0004 splits these two roots.
  const relBase = ctx.workspaceRoot ?? ctx.scopeRoot;
  const ledgerFilePath = ctx.isProject
    ? path.relative(relBase, ctx.target.filePath)
    : ctx.target.filePath;
  const action: LedgerAction = {
    cap: 'config-merge',
    file: ledgerFilePath,
    keyPath,
    appliedHash: newHash,
  };
  ledger.record({ ext: ctx.ext, host: ctx.host, scope: ctx.scope, action });
  ledger.save();
}

/**
 * reverse — remove ONLY sox-owned key identified in the ledger.
 * Foreign keys at other keyPaths are untouched ([inv:ledger-reversible]).
 */
export async function reverse(ctx: ConfigMergeCtx): Promise<void> {
  const { filePath, keyPath } = ctx.target;
  const ledger = ctx.ledger ?? Ledger.load(ctx.scopeRoot, ctx.isProject !== undefined ? { isProject: ctx.isProject } : undefined);
  const actions = ledger.actionsFor(ctx.ext, ctx.host, ctx.scope);
  const matched = actions.filter(
    (a) => a.cap === 'config-merge' && a.file === filePath && a.keyPath === keyPath
  );
  if (matched.length === 0) return; // nothing to reverse

  if (!fs.existsSync(filePath)) return;
  const config = readConfig(filePath);
  const parts = parseKeyPath(keyPath);
  deleteByKeyPath(config, parts);
  writeConfig(filePath, config);

  ledger.remove(ctx.ext, ctx.host, ctx.scope);
  ledger.save();
}

/**
 * update — compare current value hash vs ledger appliedHash.
 */
export async function update(ctx: ConfigMergeCtx): Promise<Diff> {
  const { filePath, keyPath } = ctx.target;
  const ledger = ctx.ledger ?? Ledger.load(ctx.scopeRoot, ctx.isProject !== undefined ? { isProject: ctx.isProject } : undefined);
  const actions = ledger.actionsFor(ctx.ext, ctx.host, ctx.scope);
  const matched = actions.find(
    (a) => a.cap === 'config-merge' && a.file === filePath && a.keyPath === keyPath
  );

  if (!fs.existsSync(filePath)) return { kind: 'add' };
  const config = readConfig(filePath);
  const parts = parseKeyPath(keyPath);
  const current = getByKeyPath(config, parts);

  if (current === undefined) {
    if (matched?.appliedHash !== undefined) {
      return { kind: 'add' as const, appliedHash: matched.appliedHash };
    }
    return { kind: 'add' };
  }

  const currentHash = sha256(current);
  if (!matched) return { kind: 'update', currentHash };
  if (currentHash === matched.appliedHash) return { kind: 'none', currentHash, appliedHash: matched.appliedHash };
  const diffResult: Diff = { kind: 'update', currentHash };
  if (matched.appliedHash !== undefined) diffResult.appliedHash = matched.appliedHash;
  return diffResult;
}

/**
 * verify — key present AND value hash matches the applied hash in the ledger.
 */
export async function verify(ctx: ConfigMergeCtx): Promise<VerifyResult> {
  const { filePath, keyPath } = ctx.target;
  if (!fs.existsSync(filePath)) {
    return { ok: false, reason: `config file not found: ${filePath}` };
  }
  const config = readConfig(filePath);
  const parts = parseKeyPath(keyPath);
  const current = getByKeyPath(config, parts);
  if (current === undefined) {
    return { ok: false, reason: `keyPath not found: ${keyPath}` };
  }
  const ledger = ctx.ledger ?? Ledger.load(ctx.scopeRoot, ctx.isProject !== undefined ? { isProject: ctx.isProject } : undefined);
  const actions = ledger.actionsFor(ctx.ext, ctx.host, ctx.scope);
  const matched = actions.find(
    (a) => a.cap === 'config-merge' && a.file === filePath && a.keyPath === keyPath
  );
  if (!matched) return { ok: true }; // no ledger entry — present is sufficient
  const currentHash = sha256(current);
  if (currentHash !== matched.appliedHash) {
    return { ok: false, reason: `value drifted: current=${currentHash} applied=${matched.appliedHash}` };
  }
  return { ok: true };
}
