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

/** The ESM-only `@decimalturn/toml-patch` module, loaded on first use. The lib
 *  builds with `module: Node16`, so this literal `import()` stays native in the
 *  CommonJS output and loads the ESM package on every supported Node. */
type TomlPatchLib = typeof import('@decimalturn/toml-patch', { with: { 'resolution-mode': 'import' } });

let tomlPatchLib: Promise<TomlPatchLib> | undefined;

function loadTomlPatch(): Promise<TomlPatchLib> {
  tomlPatchLib ??= import('@decimalturn/toml-patch');
  return tomlPatchLib;
}

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
  /**
   * Record the ledger action even when the target key is ALREADY set to the
   * byte-identical value (apply normally short-circuits the whole operation in
   * that case). Used to BACKFILL tracking for an injection that landed in the
   * config file outside the install path (e.g. a pre-tracking `migrate-home`),
   * so the ledger gains the reversal action without rewriting the file.
   * Idempotent: a matching ledger action is never double-recorded.
   */
  recordWhenUnchanged?: boolean;
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

// --- TOML (via @decimalturn/toml-patch) ---
// The previous hand-rolled subset parser/serializer corrupted real codex configs on
// every merge: it dropped comments, split multi-line strings into stray tables, left
// strings unescaped, and mis-parsed quoted keys. toml-patch parses the full TOML spec
// and patches only the changed values, so untouched text stays byte-identical.

type TomlValue = string | number | boolean | null | TomlTable | TomlValue[];
interface TomlTable { [key: string]: TomlValue }

/** Parse a TOML string into a nested object. Rejects on invalid TOML. */
export async function parseToml(src: string): Promise<TomlTable> {
  const lib = await loadTomlPatch();
  return lib.parse(src) as TomlTable;
}

/** Serialise a nested object to TOML. */
export async function stringifyToml(obj: TomlTable): Promise<string> {
  const lib = await loadTomlPatch();
  return lib.stringify(obj);
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

async function readToml(filePath: string): Promise<TomlTable> {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8');
  return await parseToml(raw);
}

async function writeToml(filePath: string, data: TomlTable): Promise<void> {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const lib = await loadTomlPatch();
  const out = existing.trim() === '' ? lib.stringify(data) : lib.patch(existing, data);
  fs.writeFileSync(filePath, out, 'utf8');
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

async function readConfig(filePath: string): Promise<Record<string, unknown>> {
  if (isToml(filePath)) {
    return (await readToml(filePath)) as Record<string, unknown>;
  }
  return readJson(filePath);
}

async function writeConfig(filePath: string, data: Record<string, unknown>): Promise<void> {
  if (isToml(filePath)) {
    await writeToml(filePath, data as TomlTable);
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

  const config = await readConfig(filePath);
  const current = getByKeyPath(config, parts);
  const newHash = sha256(value);
  const currentHash = sha256(current);

  // Idempotent: already set to the same value. Normally a complete no-op; but a
  // backfill (recordWhenUnchanged) still falls through to ensure the LEDGER carries
  // the reversal action even though the file needs no rewrite.
  const unchanged = current !== undefined && currentHash === newHash;
  if (unchanged && ctx.recordWhenUnchanged !== true) return;

  if (!unchanged) {
    setByKeyPath(config, parts, value);
    await writeConfig(filePath, config);
  }

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
  // Never double-record: a re-applied/backfilled key keeps a single action.
  const already = ledger
    .actionsFor(ctx.ext, ctx.host, ctx.scope)
    .some((a) => a.cap === 'config-merge' && a.file === ledgerFilePath && a.keyPath === keyPath);
  if (already) return;
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
  const config = await readConfig(filePath);
  const parts = parseKeyPath(keyPath);
  deleteByKeyPath(config, parts);
  await writeConfig(filePath, config);

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
  const config = await readConfig(filePath);
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
  const config = await readConfig(filePath);
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
