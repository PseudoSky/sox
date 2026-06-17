/**
 * libs/install-engine/src/capabilities/file-drop.ts
 *
 * file-drop capability — place a file or directory at a host discovery path.
 * [def:capability], [inv:boundary], [inv:host-agnostic-type]
 *
 * Action  : copy src → target (idempotent — skip if hash matches)
 * Reverse : delete target (only if it was placed by sox)
 * Update  : compare src hash vs installed hash → produce diff
 * Verify  : target present AND content hash matches
 *
 * This capability does NOT write to the ledger because it owns its target
 * exclusively (no shared file).  Idempotency is guaranteed by hash comparison.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// --- Types ---

export interface FileDropTarget {
  /** Absolute path where the file/dir should be placed. */
  destPath: string;
}

export interface FileDropPayload {
  /** Absolute path to the source file or directory to place. */
  srcPath: string;
}

export interface FileDropCtx {
  host: string;
  scope: string;
  target: FileDropTarget;
  payload: FileDropPayload;
}

export interface Diff {
  kind: 'none' | 'update' | 'add' | 'remove';
  srcHash?: string;
  installedHash?: string;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

// --- Helpers ---

function hashFile(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return 'sha256:' + crypto.createHash('sha256').update(data).digest('hex');
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
      hash.update('file:' + hashFile(child));
    }
  }
  return 'sha256:' + hash.digest('hex');
}

function hashPath(p: string): string {
  if (!fs.existsSync(p)) return '';
  const stat = fs.statSync(p);
  if (stat.isDirectory()) return hashDir(p);
  return hashFile(p);
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

function removeRecursive(p: string): void {
  if (!fs.existsSync(p)) return;
  const stat = fs.statSync(p);
  if (stat.isDirectory()) {
    fs.rmSync(p, { recursive: true, force: true });
  } else {
    fs.unlinkSync(p);
  }
}

// --- Capability ---

/**
 * apply — idempotent: copy src to dest if dest is absent or hash differs.
 */
export async function apply(ctx: FileDropCtx): Promise<void> {
  const { srcPath } = ctx.payload;
  const { destPath } = ctx.target;
  if (!fs.existsSync(srcPath)) {
    throw new Error(`file-drop: src not found: ${srcPath}`);
  }
  const srcHash = hashPath(srcPath);
  const destHash = hashPath(destPath);
  if (srcHash === destHash) return; // already identical — no-op
  copyRecursive(srcPath, destPath);
}

/**
 * reverse — remove the target placed by sox.
 */
export async function reverse(ctx: FileDropCtx): Promise<void> {
  removeRecursive(ctx.target.destPath);
}

/**
 * update — compute diff between source and installed target.
 */
export async function update(ctx: FileDropCtx): Promise<Diff> {
  const { srcPath } = ctx.payload;
  const { destPath } = ctx.target;
  if (!fs.existsSync(srcPath)) return { kind: 'none' };
  const srcHash = hashPath(srcPath);
  if (!fs.existsSync(destPath)) {
    return { kind: 'add', srcHash };
  }
  const installedHash = hashPath(destPath);
  if (srcHash === installedHash) return { kind: 'none', srcHash, installedHash };
  return { kind: 'update', srcHash, installedHash };
}

/**
 * verify — target present and content hash matches source.
 */
export async function verify(ctx: FileDropCtx): Promise<VerifyResult> {
  const { destPath } = ctx.target;
  const { srcPath } = ctx.payload;
  if (!fs.existsSync(destPath)) {
    return { ok: false, reason: `target not found: ${destPath}` };
  }
  if (!fs.existsSync(srcPath)) {
    return { ok: true }; // src gone but target exists — caller's concern
  }
  const srcHash = hashPath(srcPath);
  const destHash = hashPath(destPath);
  if (srcHash !== destHash) {
    return { ok: false, reason: `hash mismatch: src=${srcHash} dest=${destHash}` };
  }
  return { ok: true };
}
