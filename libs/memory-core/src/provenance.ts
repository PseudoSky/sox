/**
 * provenance.ts — project_path resolution (E1).
 * CONTRACTS.md C1.4.
 *
 * Determinism: for a fixed process.cwd() + env + repo state, always returns the same
 * string (or null). No randomness, no LLM, no network.
 *
 * BL-56: the prior implementation derived project_path purely from
 * `git rev-parse --show-toplevel` of the SERVER process's cwd, falling back to the
 * bare cwd. For a USER-scoped (global) stdio memory-server, `process.cwd()` is merely
 * the directory the MCP client happened to launch from — so every write in a session
 * collapsed to that one bucket, a worktree-isolated agent attributed to its transient
 * worktree path, and a launch from `~` (no repo) mis-attributed every write to the
 * home dir. This module now: (1) honors an injected authoritative root, (2) canonical-
 * izes a linked worktree to its main checkout, and (3) returns null (not the bare cwd)
 * when there is no real repo — null ("no project") beats a wrong bucket.
 *
 * Remaining (tracked in BL-56): the principled per-session fix for user scope is the
 * MCP `roots` capability (the client advertises its workspace root). Until that lands,
 * a launcher/proxy can set SOX_CONFIG_PROJECT_PATH, or a project-scope install can pin
 * `config.memory-server.project_path` (injected by buildExtConfigEnv as the same env).
 */

import * as childProcess from 'node:child_process';
import * as path from 'node:path';

/** Run `git rev-parse <args>` in process.cwd(); trimmed stdout on success, else null. */
function gitRevParse(args: string[]): string | null {
  try {
    const result = childProcess.spawnSync('git', ['rev-parse', ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 2000,
    });
    if (result.status === 0 && result.stdout) {
      const out = result.stdout.trim();
      return out.length > 0 ? out : null;
    }
  } catch {
    /* git missing / not a repo / timeout — caller falls back */
  }
  return null;
}

/**
 * Resolve the caller's project root path (E1).
 *
 * Resolution order (BL-56):
 *   1. `override` (caller-supplied `project_path`), if non-empty — used as-is.
 *   2. `SOX_CONFIG_PROJECT_PATH` env, if non-empty — the host/config-injected
 *      authoritative workspace root (cascade `config.<id>.project_path` →
 *      buildExtConfigEnv, or a launcher/proxy that knows the client's real workspace).
 *      Preferred over cwd because the server's cwd is not a reliable project signal.
 *   3. `git rev-parse --show-toplevel` in `process.cwd()`. If the cwd is a LINKED
 *      worktree, the canonical MAIN checkout is returned instead of the worktree path.
 *   4. Otherwise null — a non-repo cwd is NOT a project; recording it (e.g. `~`)
 *      mis-attributes every write, so null ("unknown/global") is correct.
 *
 * @param override  Caller-supplied project_path (from write params); skips detection.
 * @returns         Absolute path string, or null when no project can be attributed.
 */
export function resolveProjectPath(override?: string): string | null {
  if (override !== undefined && override.length > 0) {
    return override;
  }

  const injected = process.env['SOX_CONFIG_PROJECT_PATH'];
  if (injected !== undefined) {
    // AUTHORITATIVE when the host set it. `cmdServe` injects the CLIENT's workspace
    // root (the dir the MCP client launched `soxe serve` from); a project-scope
    // `config.<id>.project_path` also lands here via buildExtConfigEnv. An empty
    // string means the host determined there is NO project — return null and DO NOT
    // fall through to cwd detection, because the served process's cwd is the
    // extension INSTALL directory (extDir2), not a user workspace, so cwd-git would
    // mis-attribute every write to wherever the extension happens to be installed.
    return injected.length > 0 ? injected : null;
  }

  // No host injection (non-served contexts: daemon, memory-cli, tests). Fall back to
  // cwd-based detection — here the cwd IS typically the working context.
  const top = gitRevParse(['--show-toplevel']);
  if (top === null) {
    // Not inside a git repo. Do NOT fall back to process.cwd(): a bare cwd (the home
    // dir when the client is launched from ~, a transient dir, etc.) is not a project.
    return null;
  }

  // Linked-worktree canonicalization: `--git-common-dir` points at the MAIN repo's
  // `.git`. For a linked worktree that differs from `<top>/.git`; attribute to the
  // main checkout so a worktree-isolated agent lands in the real repo bucket, not the
  // (often transient) worktree path.
  const commonDir = gitRevParse(['--path-format=absolute', '--git-common-dir']);
  if (commonDir !== null && /[\\/]\.git$/.test(commonDir)) {
    const mainRoot = path.dirname(commonDir);
    if (path.resolve(mainRoot) !== path.resolve(top)) {
      return mainRoot;
    }
  }

  return top;
}
