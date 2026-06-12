/**
 * libs/host-runtime/src/policy.ts — Permission policy compiler and matcher.
 *
 * [ref:deny-by-default]: when a permissions DOMAIN is declared (present in the
 * block), any path/host NOT matched by a declared pattern in that domain returns
 * false from the corresponding allows*() method. An absent domain (or absent
 * block) returns true. Every enforcement decision routes through a Policy method
 * — no ad-hoc string compares against permission arrays outside this file.
 *
 * [def:enforcement-opt-in]: enforcement applies only when a manifest declares a
 * permissions block. A manifest with NO permissions is unconstrained (legacy
 * compat, preserves [inv:no-regress]). Within a declared block, each domain
 * (fs/network/socket) that is PRESENT is enforced deny-by-default; a domain
 * ABSENT from a present block is unconstrained for that domain.
 */

import * as path from 'node:path';
import { expandTilde } from './supervisor.js';
import type { PermissionsBlock } from './supervisor.js';

// ─── Policy interface ─────────────────────────────────────────────────────────

/**
 * [shape:policy] — a compiled, queryable form of a permissions block.
 */
export interface Policy {
  /** true only when a permissions block was declared ([def:enforcement-opt-in]) */
  enforced: boolean;

  allowsFsRead(absPath: string): boolean;
  allowsFsWrite(absPath: string): boolean;
  allowsSocket(absPath: string): boolean;
  allowsNetwork(hostOrUrl: string): boolean;

  /** Serialize to [shape:policy-env] for the spawned-child contract. */
  toEnv(): Record<string, string>;
}

// ─── Glob matcher ─────────────────────────────────────────────────────────────

/**
 * Build a regex from a glob pattern.
 * Supports:
 *   - `~/` prefix → expanded via expandTilde
 *   - `**` → matches any sequence of characters including path separators
 *   - `*`  → matches any sequence of characters within a path segment (no `/`)
 *
 * [inv:dev-time-nx]: dependency-free; no runtime npm package.
 */
function globToRegex(pattern: string): RegExp {
  // Expand ~/
  const expanded = expandTilde(pattern);

  // Escape all regex meta-characters except * which we handle specially
  let regexStr = '';
  let i = 0;
  while (i < expanded.length) {
    if (expanded[i] === '*' && expanded[i + 1] === '*') {
      // ** matches across path segments
      regexStr += '.*';
      i += 2;
      // Consume trailing slash after ** if present (e.g. **/)
      if (expanded[i] === '/') {
        i++;
      }
    } else if (expanded[i] === '*') {
      // * matches within a segment (no slashes)
      regexStr += '[^/]*';
      i++;
    } else {
      // Escape regex special chars — expanded[i] is always defined here (i < expanded.length)
      regexStr += escapeRegexChar(expanded[i] as string);
      i++;
    }
  }

  return new RegExp(`^${regexStr}$`);
}

function escapeRegexChar(ch: string): string {
  // Characters that are special in regex and need escaping
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Test whether `subject` matches `pattern` (glob).
 * For path matching, `subject` is first normalized to absolute via expandTilde +
 * path.resolve so `~/` in subjects also works.
 */
function matchGlob(pattern: string, subject: string): boolean {
  const regex = globToRegex(pattern);
  return regex.test(subject);
}

/**
 * Normalize a path subject: expand `~/` and resolve to absolute.
 */
function normalizePath(p: string): string {
  return path.resolve(expandTilde(p));
}

/**
 * Normalize a network subject (hostname or URL-prefix).
 * For URLs, extract the hostname; bare hostnames are left as-is.
 */
function normalizeNetwork(hostOrUrl: string): string {
  try {
    const u = new URL(hostOrUrl);
    return u.hostname;
  } catch {
    // Not a URL — treat as bare hostname / pattern subject
    return hostOrUrl;
  }
}

// ─── Domain checker ───────────────────────────────────────────────────────────

/**
 * Check whether `subject` is permitted by `patterns`.
 * If `patterns` is undefined/absent the domain is unconstrained → returns true.
 * If `patterns` is present (even empty) → deny-by-default: must match at least
 * one pattern ([ref:deny-by-default]).
 */
function isPathAllowed(
  patterns: string[] | undefined,
  subject: string,
  normalize: (s: string) => string = normalizePath,
): boolean {
  if (patterns === undefined) {
    // Domain absent → unconstrained
    return true;
  }
  const norm = normalize(subject);
  return patterns.some((p) => matchGlob(p, norm));
}

// ─── Policy implementation ────────────────────────────────────────────────────

/** Internal structure that backs a compiled Policy. */
interface PolicyData {
  enforced: boolean;
  fsRead: string[] | undefined;
  fsWrite: string[] | undefined;
  socket: string[] | undefined;
  network: string[] | undefined;
}

function buildPolicy(data: PolicyData): Policy {
  return {
    enforced: data.enforced,

    allowsFsRead(absPath: string): boolean {
      if (!data.enforced) return true;
      return isPathAllowed(data.fsRead, absPath, normalizePath);
    },

    allowsFsWrite(absPath: string): boolean {
      if (!data.enforced) return true;
      return isPathAllowed(data.fsWrite, absPath, normalizePath);
    },

    allowsSocket(absPath: string): boolean {
      if (!data.enforced) return true;
      return isPathAllowed(data.socket, absPath, normalizePath);
    },

    allowsNetwork(hostOrUrl: string): boolean {
      if (!data.enforced) return true;
      return isPathAllowed(data.network, hostOrUrl, normalizeNetwork);
    },

    toEnv(): Record<string, string> {
      // [shape:policy-env]: JSON arrays; undefined domain → empty array in env
      // (the child rebuilds via compilePolicyFromEnv; SOX_PERM_ENFORCE presence
      // signals enforcement mode).
      const env: Record<string, string> = {};
      if (data.enforced) {
        env['SOX_PERM_ENFORCE'] = '1';
      }
      env['SOX_PERM_FS_READ'] = JSON.stringify(data.fsRead ?? []);
      env['SOX_PERM_FS_WRITE'] = JSON.stringify(data.fsWrite ?? []);
      env['SOX_PERM_SOCKET'] = JSON.stringify(data.socket ?? []);
      env['SOX_PERM_NETWORK'] = JSON.stringify(data.network ?? []);
      return env;
    },
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compile a PermissionsBlock into a queryable Policy.
 *
 * - `perms === undefined` → `enforced=false`, every `allows*()` returns true
 *   (legacy compat, [def:enforcement-opt-in]).
 * - A present domain → deny-by-default within that domain ([ref:deny-by-default]).
 * - An absent domain within a present block → unconstrained for that domain.
 */
export function compilePolicy(perms: PermissionsBlock | undefined): Policy {
  if (perms === undefined) {
    return buildPolicy({
      enforced: false,
      fsRead: undefined,
      fsWrite: undefined,
      socket: undefined,
      network: undefined,
    });
  }

  return buildPolicy({
    enforced: true,
    // Deny-by-default applies at the sub-key level within a domain:
    //   - If `fs` is present and `fs.read` is explicitly an array → enforce that list.
    //   - If `fs` is present but `fs.read` is undefined → unconstrained for read.
    //   - If `fs` is absent entirely → undefined → unconstrained for all fs.
    //   - Same logic applies for socket.paths and network.outbound.
    fsRead: perms.fs !== undefined ? perms.fs.read : undefined,
    fsWrite: perms.fs !== undefined ? perms.fs.write : undefined,
    socket: perms.socket !== undefined ? perms.socket.paths : undefined,
    network: perms.network !== undefined ? perms.network.outbound : undefined,
  });
}

/**
 * Rebuild a Policy from [shape:policy-env] environment variables.
 *
 * This is the inverse of `Policy.toEnv()` — used by a spawned child at startup
 * to reconstruct its enforcement policy from the injected env vars.
 *
 * Round-trip contract ([policy-core.4]): for any Policy `p` produced by
 * `compilePolicy(perms)`, `compilePolicyFromEnv(p.toEnv())` must yield identical
 * allow/deny decisions for all subjects.
 *
 * - `SOX_PERM_ENFORCE` absent → `enforced=false`, every `allows*()` returns true.
 * - `SOX_PERM_ENFORCE` present → each domain reconstructed from its JSON array.
 *   An empty array `[]` means deny-by-default for that domain (no subject passes).
 */
export function compilePolicyFromEnv(env: Record<string, string | undefined>): Policy {
  if (!env['SOX_PERM_ENFORCE']) {
    return buildPolicy({
      enforced: false,
      fsRead: undefined,
      fsWrite: undefined,
      socket: undefined,
      network: undefined,
    });
  }

  function parseArr(key: string): string[] | undefined {
    const raw = env[key];
    if (raw === undefined) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed as string[];
      }
    } catch {
      // Malformed env var — treat as unconstrained to avoid false-denial
    }
    return undefined;
  }

  // In toEnv() all 4 SOX_PERM_* keys are always written (possibly as "[]").
  // So when SOX_PERM_ENFORCE is present the arrays are always defined.
  // We parse them directly; a missing key is treated as unconstrained.
  return buildPolicy({
    enforced: true,
    fsRead: parseArr('SOX_PERM_FS_READ'),
    fsWrite: parseArr('SOX_PERM_FS_WRITE'),
    socket: parseArr('SOX_PERM_SOCKET'),
    network: parseArr('SOX_PERM_NETWORK'),
  });
}
