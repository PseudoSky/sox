/**
 * libs/install-engine/src/capabilities/materialize.ts
 *
 * materialize capability — place built extension code at a stable store path.
 * [def:capability], [inv:host-agnostic-type]
 *
 * Puts the compiled extension at a versioned, stable path in the soxe store
 * (default: ~/.sox/ext/<ext>@<version>/) so that host pointers (MCP config,
 * bin-links) don't break when the source workspace moves.
 *
 * Action  : copy built dist at src → store path; create/update a latest symlink
 * Reverse : remove the versioned store path (and latest symlink if pointing there)
 * Update  : compare src hash vs stored hash
 * Verify  : store path present AND hash matches
 *
 * No shared file — no ledger for this capability (it owns its store path).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { storeRootFor } from '../data-paths.js';

// --- Types ---

export interface MaterializeTarget {
  /**
   * Absolute path to the soxe store root (default: ~/.sox/ext/).
   * Allows tests to redirect to a temp dir.
   */
  storeRoot: string;
  /** Extension id + version, e.g. "my-server@1.2.3". */
  extRef: string;
}

export interface MaterializePayload {
  /**
   * Absolute path to the built artifact directory to materialize.
   *
   * For compiled extensions this is the dist/ directory produced by tsc.
   * For bundled extensions this is the bundle output directory produced by
   * tools/bundle-extension.cjs — which contains bundle/index.js as the
   * standard self-contained artifact. The copyRecursive logic handles both
   * conventions transparently since it copies the entire directory tree.
   */
  srcPath: string;
}

export interface MaterializeCtx {
  host: string;
  scope: string;
  target: MaterializeTarget;
  payload: MaterializePayload;
}

export interface Diff {
  kind: 'none' | 'update' | 'add' | 'remove';
  srcHash?: string;
  storedHash?: string;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  storePath?: string;
}

// --- Helpers ---

export function defaultStoreRoot(): string {
  // ADR-0004 §D2/§D1: default store root = $userDataRoot/ext.
  return storeRootFor('user');
}

function storePath(storeRoot: string, extRef: string): string {
  return path.join(storeRoot, extRef);
}

function latestLinkPath(storeRoot: string, extId: string): string {
  return path.join(storeRoot, extId + '@latest');
}

function hashDir(dirPath: string): string {
  const hash = crypto.createHash('sha256');
  const entries = fs.readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const child = path.join(dirPath, entry.name);
    hash.update(entry.name + ':');
    if (entry.isDirectory()) {
      hash.update('dir:' + hashDir(child));
    } else {
      const data = fs.readFileSync(child);
      hash.update('file:' + crypto.createHash('sha256').update(data).digest('hex'));
    }
  }
  return 'sha256:' + hash.digest('hex');
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

function extIdFromRef(extRef: string): string {
  // "my-server@1.2.3" → "my-server"
  const at = extRef.lastIndexOf('@');
  return at === -1 ? extRef : extRef.slice(0, at);
}

// --- Capability ---

/**
 * apply — copy srcPath to the versioned store path.
 * Idempotent: if content hash matches, skip the copy.
 * Creates a @latest symlink after copy.
 */
export async function apply(ctx: MaterializeCtx): Promise<void> {
  const { storeRoot, extRef } = ctx.target;
  const { srcPath } = ctx.payload;

  if (!fs.existsSync(srcPath)) {
    throw new Error(`materialize: src not found: ${srcPath}`);
  }

  const dest = storePath(storeRoot, extRef);
  const srcHash = hashDir(srcPath);

  // Idempotent: if dest exists and hash matches, no-op
  if (fs.existsSync(dest)) {
    const destHash = hashDir(dest);
    if (srcHash === destHash) {
      // Still update latest symlink in case it's missing
      updateLatestLink(storeRoot, extRef);
      return;
    }
    // Content differs — remove and re-copy
    fs.rmSync(dest, { recursive: true, force: true });
  }

  copyRecursive(srcPath, dest);
  updateLatestLink(storeRoot, extRef);
}

function updateLatestLink(storeRoot: string, extRef: string): void {
  const extId = extIdFromRef(extRef);
  const linkPath = latestLinkPath(storeRoot, extId);
  const dest = storePath(storeRoot, extRef);
  try {
    if (fs.existsSync(linkPath) || fs.lstatSync(linkPath).isSymbolicLink()) {
      fs.unlinkSync(linkPath);
    }
  } catch { /* ignore */ }
  try { fs.symlinkSync(dest, linkPath); } catch { /* ignore on platforms that don't support it */ }
}

/**
 * reverse — remove the versioned store path and latest symlink.
 */
export async function reverse(ctx: MaterializeCtx): Promise<void> {
  const { storeRoot, extRef } = ctx.target;
  const dest = storePath(storeRoot, extRef);
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  const extId = extIdFromRef(extRef);
  const linkPath = latestLinkPath(storeRoot, extId);
  try {
    if (fs.existsSync(linkPath) || fs.lstatSync(linkPath).isSymbolicLink()) {
      fs.unlinkSync(linkPath);
    }
  } catch { /* ignore */ }
}

/**
 * update — compare src hash vs stored hash.
 */
export async function update(ctx: MaterializeCtx): Promise<Diff> {
  const { storeRoot, extRef } = ctx.target;
  const { srcPath } = ctx.payload;
  if (!fs.existsSync(srcPath)) return { kind: 'none' };
  const srcHash = hashDir(srcPath);
  const dest = storePath(storeRoot, extRef);
  if (!fs.existsSync(dest)) return { kind: 'add', srcHash };
  const storedHash = hashDir(dest);
  if (srcHash === storedHash) return { kind: 'none', srcHash, storedHash };
  return { kind: 'update', srcHash, storedHash };
}

/**
 * verify — store path present and hash matches src.
 */
export async function verify(ctx: MaterializeCtx): Promise<VerifyResult> {
  const { storeRoot, extRef } = ctx.target;
  const { srcPath } = ctx.payload;
  const dest = storePath(storeRoot, extRef);

  if (!fs.existsSync(dest)) {
    return { ok: false, reason: `store path not found: ${dest}` };
  }
  if (!fs.existsSync(srcPath)) {
    // src gone — can only verify that dest exists
    return { ok: true, storePath: dest };
  }
  const srcHash = hashDir(srcPath);
  const storedHash = hashDir(dest);
  if (srcHash !== storedHash) {
    return { ok: false, reason: `hash mismatch: src=${srcHash} stored=${storedHash}`, storePath: dest };
  }
  return { ok: true, storePath: dest };
}
