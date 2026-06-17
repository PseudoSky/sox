/**
 * libs/install-engine/src/capabilities/bin-link.ts
 *
 * bin-link capability — make an executable available on PATH.
 * [def:capability], [inv:host-agnostic-type]
 *
 * Action  : create a symlink (or wrapper script) at target so the binary is PATH-accessible
 * Reverse : remove the symlink/wrapper
 * Update  : compare link target vs desired target
 * Verify  : link exists AND resolves to src
 *
 * No ledger required — bin-link owns its target exclusively.
 */

import * as fs from 'fs';
import * as path from 'path';

// --- Types ---

export interface BinLinkTarget {
  /** Absolute path where the link should be placed (e.g. /usr/local/bin/my-tool). */
  linkPath: string;
}

export interface BinLinkPayload {
  /** Absolute path to the actual executable to link to. */
  srcPath: string;
}

export interface BinLinkCtx {
  host: string;
  scope: string;
  target: BinLinkTarget;
  payload: BinLinkPayload;
}

export interface Diff {
  kind: 'none' | 'update' | 'add' | 'remove';
  currentTarget?: string;
  desiredTarget?: string;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

// --- Capability ---

/**
 * apply — create a symlink at linkPath pointing to srcPath.
 * Idempotent: if symlink already points to srcPath, skip.
 */
export async function apply(ctx: BinLinkCtx): Promise<void> {
  const { linkPath } = ctx.target;
  const { srcPath } = ctx.payload;

  if (!fs.existsSync(srcPath)) {
    throw new Error(`bin-link: src not found: ${srcPath}`);
  }

  const dir = path.dirname(linkPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // If the link already exists (as file or symlink), check and possibly replace
  let linkExists = false;
  try { fs.lstatSync(linkPath); linkExists = true; } catch { /* doesn't exist */ }
  if (linkExists) {
    try {
      const current = fs.readlinkSync(linkPath);
      if (current === srcPath) return; // already correct — idempotent
      fs.unlinkSync(linkPath);
    } catch {
      // not a symlink or doesn't exist — remove if file exists
      try { fs.unlinkSync(linkPath); } catch { /* ignore */ }
    }
  }

  fs.symlinkSync(srcPath, linkPath);
  // Ensure the binary is executable
  try { fs.chmodSync(srcPath, 0o755); } catch { /* ignore on non-POSIX */ }
}

/**
 * reverse — remove the symlink placed by sox.
 */
export async function reverse(ctx: BinLinkCtx): Promise<void> {
  const { linkPath } = ctx.target;
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink() || stat.isFile()) {
      fs.unlinkSync(linkPath);
    }
  } catch {
    // already gone — no-op
  }
}

/**
 * update — compare current link target vs desired.
 */
export async function update(ctx: BinLinkCtx): Promise<Diff> {
  const { linkPath } = ctx.target;
  const { srcPath } = ctx.payload;
  try {
    fs.lstatSync(linkPath);
  } catch {
    return { kind: 'add', desiredTarget: srcPath };
  }
  try {
    const current = fs.readlinkSync(linkPath);
    if (current === srcPath) return { kind: 'none', currentTarget: current };
    return { kind: 'update', currentTarget: current, desiredTarget: srcPath };
  } catch {
    return { kind: 'update', desiredTarget: srcPath };
  }
}

/**
 * verify — link exists AND resolves to srcPath.
 */
export async function verify(ctx: BinLinkCtx): Promise<VerifyResult> {
  const { linkPath } = ctx.target;
  const { srcPath } = ctx.payload;
  try {
    const stat = fs.lstatSync(linkPath);
    if (!stat.isSymbolicLink()) {
      return { ok: false, reason: `${linkPath} exists but is not a symlink` };
    }
    const current = fs.readlinkSync(linkPath);
    if (current !== srcPath) {
      return { ok: false, reason: `symlink points to ${current}, expected ${srcPath}` };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: `link not found: ${linkPath}` };
  }
}
