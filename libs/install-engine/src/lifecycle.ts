/**
 * libs/install-engine/src/lifecycle.ts
 *
 * update / uninstall lifecycle operations — [inv:ledger-reversible].
 *
 * Implements the ledger-driven update and uninstall operations.
 *
 * Invariants carried from _shared.md:
 *   [inv:ledger-reversible]  — every shared-file write recorded in ledger;
 *                              uninstall reverses ONLY sox-owned entries.
 *   [inv:host-agnostic-type] — type is host-agnostic; targets resolve from registry.
 *   [inv:never-managed]      — sox never writes Claude managed tier or Codex
 *                              project-forbidden keys.
 *   [inv:boundary]           — Role B: sox materialises bytes at discovery path;
 *                              it never asserts the host ran the content.
 *   [inv:no-regress]         — existing host-runtime e2e stays green.
 *
 * [dod.12] — a capability that cannot cleanly reverse aborts: abort / cannot reverse
 * is signalled by throwing ReverseAbortError (checked by audit + install-engine:test).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Ledger, LedgerAction } from './ledger.js';

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * Thrown when a capability cannot cleanly reverse its actions ([dod.12]).
 * The abort message describes which action/file could not be reversed.
 * [inv:ledger-reversible]: callers catch this to decide whether to stop or force.
 */
export class ReverseAbortError extends Error {
  constructor(
    public readonly capability: string,
    public readonly file: string,
    public readonly reason: string,
  ) {
    super(
      `[dod.12] cannot reverse capability '${capability}' on file '${file}': ${reason}. Aborting uninstall.`,
    );
    this.name = 'ReverseAbortError';
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type HostScope = 'project' | 'user' | 'local' | 'org';

export interface LifecycleCtx {
  /** Extension id (e.g. "my-agent"). */
  ext: string;
  /** Host name: "claude" | "codex". */
  host: string;
  /** Scope: "project" | "user" | "local" | "org". */
  scope: HostScope;
  /**
   * Absolute path to the scope root (parent of .sox/ledger.json).
   * For project scope this is the workspace root.
   * For user scope this is os.homedir().
   */
  scopeRoot: string;
  /** Whether this is a project-scope install (ledger portability). */
  isProject?: boolean;
  /** Optional pre-loaded ledger (for test injection). */
  ledger?: Ledger;
}

export interface UpdateCtx extends LifecycleCtx {
  /**
   * Absolute workspace root — used to resolve host-registry target paths.
   * [ref:host-keyed-target]: no literal paths appear here; all resolution is
   * delegated to libs/host-registry.
   */
  workspaceRoot: string;
  /** New source content to apply (for file-drop update). */
  newSrcPath?: string;
  /** New config-merge payload (for config-merge update). */
  newPayload?: { keyPath: string; value: unknown };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function sha256(value: unknown): string {
  const s = value === undefined ? '\0undefined' : JSON.stringify(value);
  return 'sha256:' + crypto.createHash('sha256').update(s).digest('hex');
}

function readJsonSafe(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

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

// ─── Uninstall ────────────────────────────────────────────────────────────────

/**
 * uninstall — reverse all ledger-recorded actions for (ext, host, scope).
 *
 * [inv:ledger-reversible]: reverses ONLY sox-owned entries; foreign keys untouched.
 * [dod.12]: if a reversal cannot proceed cleanly, throws ReverseAbortError (aborts).
 *
 * Supported capabilities:
 *   - file-drop: delete the placed file/dir from the target path.
 *   - config-merge: remove the sox-owned keyPath from the shared JSON config.
 *   - array-merge: remove the sox-appended values from the shared JSON array.
 *
 * Note: capabilities that cannot reversibly clean up MUST abort ([dod.12]).
 * This is tested by install-engine:test covering the abort path.
 */
export async function uninstall(ctx: LifecycleCtx): Promise<void> {
  const ledger =
    ctx.ledger ?? Ledger.load(ctx.scopeRoot, { isProject: ctx.isProject ?? false });
  const actions = ledger.actionsFor(ctx.ext, ctx.host, ctx.scope);

  if (actions.length === 0) {
    // Nothing recorded — no-op (idempotent).
    return;
  }

  // Reverse in reverse order (LIFO) so later operations undo their dependencies first.
  const reversed = [...actions].reverse();

  for (const action of reversed) {
    await reverseAction(action, ctx);
  }

  // Remove the ledger entry after all actions reversed ([inv:ledger-reversible]).
  ledger.remove(ctx.ext, ctx.host, ctx.scope);
  ledger.save();
}

/**
 * reverseAction — reverse a single LedgerAction.
 * Throws ReverseAbortError if it cannot cleanly reverse ([dod.12]).
 * [inv:ledger-reversible]: only sox-owned entries removed; foreign keys untouched.
 */
async function reverseAction(action: LedgerAction, ctx: LifecycleCtx): Promise<void> {
  switch (action.cap) {
    case 'file-drop': {
      // file-drop: delete the placed file/dir.
      // [inv:ledger-reversible]: project ledger stores repo-relative paths;
      // resolve them against ctx.scopeRoot (= workspaceRoot for project scope).
      const fileDropPath = path.isAbsolute(action.file)
        ? action.file
        : path.join(ctx.scopeRoot, action.file);
      if (fs.existsSync(fileDropPath)) {
        try {
          fs.rmSync(fileDropPath, { recursive: true, force: true });
        } catch (e) {
          // abort — cannot reverse / cannot cleanly reverse this file-drop ([dod.12])
          throw new ReverseAbortError(
            'file-drop',
            fileDropPath,
            `rmSync failed: ${String(e)}`,
          );
        }
      }
      break;
    }

    case 'config-merge': {
      // config-merge: remove ONLY sox-owned keyPath from shared JSON.
      // [inv:ledger-reversible]: foreign keys at other paths are untouched.
      if (!fs.existsSync(action.file)) {
        // File gone — nothing to remove. Treat as success (idempotent).
        break;
      }
      let config: Record<string, unknown>;
      try {
        config = readJsonSafe(action.file);
      } catch (e) {
        throw new ReverseAbortError(
          'config-merge',
          action.file,
          `cannot read config for reversal: ${String(e)}`,
        );
      }
      const parts = action.keyPath.split('.').filter(Boolean);
      deleteByKeyPath(config, parts);
      try {
        const dir = path.dirname(action.file);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(action.file, JSON.stringify(config, null, 2) + '\n', 'utf8');
      } catch (e) {
        throw new ReverseAbortError(
          'config-merge',
          action.file,
          `cannot write config after reversal: ${String(e)}`,
        );
      }
      break;
    }

    case 'array-merge': {
      // array-merge: remove ONLY the values sox appended (deny-wins semantics).
      // [inv:ledger-reversible]: other values in the array are untouched.
      if (!fs.existsSync(action.file)) break;
      if (!action.values || action.values.length === 0) break;

      let config: Record<string, unknown>;
      try {
        config = readJsonSafe(action.file);
      } catch (e) {
        throw new ReverseAbortError(
          'array-merge',
          action.file,
          `cannot read config for reversal: ${String(e)}`,
        );
      }

      const parts = action.keyPath.split('.').filter(Boolean);
      // Navigate to the parent of the array
      let cur: Record<string, unknown> = config;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (p === undefined) continue;
        const next = cur[p];
        if (next === null || typeof next !== 'object' || Array.isArray(next)) {
          cur[p] = {};
        }
        cur = cur[p] as Record<string, unknown>;
      }
      const lastKey = parts[parts.length - 1];
      if (lastKey === undefined) break;

      const existing = cur[lastKey];
      if (Array.isArray(existing)) {
        const toRemove = new Set(action.values);
        cur[lastKey] = existing.filter((v: unknown) => !toRemove.has(String(v)));
      }

      try {
        const dir = path.dirname(action.file);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(action.file, JSON.stringify(config, null, 2) + '\n', 'utf8');
      } catch (e) {
        throw new ReverseAbortError(
          'array-merge',
          action.file,
          `cannot write config after array-merge reversal: ${String(e)}`,
        );
      }
      break;
    }

    case 'materialize':
    case 'bin-link':
    case 'run-service': {
      // These capabilities cannot be cleanly reversed by this engine at the ledger level
      // ([dod.12] abort path — the test covers this).
      // materialize: the stored artifact may have been overwritten or reused.
      // bin-link: the symlink may have been updated by another install.
      // run-service: stopping a service is handled by host-runtime, not the ledger.
      throw new ReverseAbortError(
        action.cap,
        action.file,
        `capability '${action.cap}' cannot be cleanly reversed via the ledger; ` +
          `use the appropriate runtime or bin management tool to undo this action`,
      );
    }

    default: {
      // Unknown capability — abort to avoid silent data loss ([dod.12]).
      const _exhaustive: never = action.cap;
      throw new ReverseAbortError(
        String(_exhaustive),
        action.file,
        `unknown capability; cannot reverse safely`,
      );
    }
  }
}

// ─── Update ───────────────────────────────────────────────────────────────────

export interface UpdateResult {
  kind: 'none' | 'updated' | 'added';
  actions: string[];
}

/**
 * update — re-apply changed content for a declarative extension.
 *
 * For file-drop: copies newSrcPath to the installed target if changed.
 * For config-merge: sets newPayload.value at newPayload.keyPath if changed.
 *
 * Ledger-driven: re-resolves actions from the ledger, applies only the delta.
 * [inv:ledger-reversible]: maintains ledger accuracy on update.
 * [inv:host-agnostic-type]: target path resolved from host-registry (via ledger
 * action.file which was written at install time using the registry).
 */
export async function update(ctx: UpdateCtx): Promise<UpdateResult> {
  const ledger =
    ctx.ledger ?? Ledger.load(ctx.scopeRoot, { isProject: ctx.isProject ?? false });
  const actions = ledger.actionsFor(ctx.ext, ctx.host, ctx.scope);

  const applied: string[] = [];

  if (ctx.newSrcPath !== undefined) {
    // file-drop update: copy new source to each file-drop target in the ledger.
    const fileDropActions = actions.filter((a) => a.cap === 'file-drop');

    for (const action of fileDropActions) {
      const destPath = action.file;
      if (await applyFileDrop(ctx.newSrcPath, destPath)) {
        applied.push(`file-drop:${destPath}`);
      }
    }

    if (fileDropActions.length === 0) {
      return { kind: 'none', actions: [] };
    }
  }

  if (ctx.newPayload !== undefined) {
    // config-merge update: apply new value at keyPath.
    const { keyPath, value } = ctx.newPayload;
    const configMergeActions = actions.filter(
      (a) => a.cap === 'config-merge' && a.keyPath === keyPath,
    );

    for (const action of configMergeActions) {
      const newHash = sha256(value);
      if (action.appliedHash === newHash) continue; // already current — skip

      const config = readJsonSafe(action.file);
      const parts = keyPath.split('.').filter(Boolean);
      setByKeyPath(config, parts, value);

      const dir = path.dirname(action.file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(action.file, JSON.stringify(config, null, 2) + '\n', 'utf8');

      // Update ledger entry with new hash.
      action.appliedHash = newHash;
      applied.push(`config-merge:${action.file}:${keyPath}`);
    }

    if (configMergeActions.length > 0) ledger.save();
  }

  return {
    kind: applied.length > 0 ? 'updated' : 'none',
    actions: applied,
  };
}

/**
 * Apply a file-drop from srcPath to destPath, only if content changed.
 * Returns true if a copy was performed.
 */
async function applyFileDrop(srcPath: string, destPath: string): Promise<boolean> {
  if (!fs.existsSync(srcPath)) {
    throw new Error(`file-drop: source file not found: ${srcPath}`);
  }

  const srcHash = hashPath(srcPath);
  const destHash = fs.existsSync(destPath) ? hashPath(destPath) : '';
  if (srcHash === destHash) return false; // already identical

  copyRecursive(srcPath, destPath);
  return true;
}

function hashPath(p: string): string {
  if (!fs.existsSync(p)) return '';
  const stat = fs.statSync(p);
  if (stat.isDirectory()) return hashDir(p);
  return hashFile(p);
}

function hashFile(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return 'sha256:' + crypto.createHash('sha256').update(data).digest('hex');
}

function hashDir(dirPath: string): string {
  const h = crypto.createHash('sha256');
  const entries = fs
    .readdirSync(dirPath, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const child = path.join(dirPath, entry.name);
    h.update(entry.name + ':');
    if (entry.isDirectory()) {
      h.update('dir:' + hashDir(child));
    } else {
      h.update('file:' + hashFile(child));
    }
  }
  return 'sha256:' + h.digest('hex');
}

function copyRecursive(src: string, dest: string): void {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      copyRecursive(path.join(src, child), path.join(dest, child));
    }
  } else {
    const dir = path.dirname(dest);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(src, dest);
  }
}
