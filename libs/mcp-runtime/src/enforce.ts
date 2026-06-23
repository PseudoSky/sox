/**
 * libs/mcp-runtime/src/enforce.ts — C6 policy-env enforcement at the resource sink.
 *
 * [inv:c6-holds]: enforces declared permissions from [def:policy-env] in every
 * spawn path (claude-stdio + sox-service). No unenforced path is introduced.
 *
 * [ref:policy-env-enforce]: reads [def:policy-env] via compilePolicyFromEnv
 * (from libs/host-runtime/src/policy.ts — imported, NOT vendored) and enforces
 * at the resource sink before the OS resource, on every path (stdio + sse).
 *
 * [def:enforcement-opt-in]: enforcement applies only when SOX_PERM_ENFORCE is
 * present in the environment. Absent → every allows*() returns true (legacy compat).
 */

import type { Policy } from '@adhd/sox-host-runtime';
import { compilePolicyFromEnv } from '@adhd/sox-host-runtime';

export type { Policy };

/**
 * Derive the current enforcement policy from the process environment.
 *
 * This is the single enforcement point for @adhd/sox-mcp-runtime — called before
 * any resource sink in both the stdio and sse/http transport paths.
 *
 * [ref:policy-env-enforce]: reads SOX_PERM_ENFORCE + SOX_PERM_FS_* +
 * SOX_PERM_SOCKET + SOX_PERM_NETWORK from process.env; injected by the
 * supervisor via toEnv() before spawning.
 *
 * Tests set process.env keys in beforeEach and delete them in afterEach
 * (same pattern as permission-guard.spec.ts).
 */
export function getPolicy(): Policy {
  return compilePolicyFromEnv(process.env as Record<string, string | undefined>);
}

/**
 * Enforcement result returned by resource-sink guards.
 * null → access allowed.
 * EnforcementDenial → access denied with reason.
 */
export interface EnforcementDenial {
  denied: true;
  reason: string;
}

/**
 * Check whether file-system access (both read AND write) to `absPath` is
 * permitted under the current policy.
 *
 * Called by transport handlers before any OS-level file I/O. Covers the
 * [inv:c6-holds] requirement for the fs domain.
 *
 * Returns null if allowed, EnforcementDenial if denied.
 */
export function checkFsAccess(absPath: string): EnforcementDenial | null {
  const policy = getPolicy();
  if (!policy.enforced) return null;
  if (!policy.allowsFsRead(absPath) || !policy.allowsFsWrite(absPath)) {
    return {
      denied: true,
      reason: `permission denied: path ${absPath} outside declared fs allowlist`,
    };
  }
  return null;
}

/**
 * Check whether network access to `hostOrUrl` is permitted under the current policy.
 *
 * Returns null if allowed, EnforcementDenial if denied.
 */
export function checkNetworkAccess(hostOrUrl: string): EnforcementDenial | null {
  const policy = getPolicy();
  if (!policy.enforced) return null;
  if (!policy.allowsNetwork(hostOrUrl)) {
    return {
      denied: true,
      reason: `permission denied: network access to ${hostOrUrl} outside declared allowlist`,
    };
  }
  return null;
}

/**
 * Check whether socket access to `absPath` is permitted under the current policy.
 *
 * Returns null if allowed, EnforcementDenial if denied.
 */
export function checkSocketAccess(absPath: string): EnforcementDenial | null {
  const policy = getPolicy();
  if (!policy.enforced) return null;
  if (!policy.allowsSocket(absPath)) {
    return {
      denied: true,
      reason: `permission denied: socket access to ${absPath} outside declared allowlist`,
    };
  }
  return null;
}
