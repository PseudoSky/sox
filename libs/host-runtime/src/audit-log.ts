/**
 * libs/host-runtime/src/audit-log.ts — Structured access-decision logger.
 *
 * Records every policy access decision made by an in-process handle so that
 * extension resource access intent is observable even without OS isolation.
 *
 * SOFT enforcement level: declaration + activation-time compiled Policy +
 * audit log of access decisions. No OS isolation (shared address space).
 * See [dod.6], [def:inproc-types], [inv:per-type].
 *
 * Usage:
 *   import { auditAccess, getAuditLog, clearAuditLog, makeInprocHandle } from './audit-log.js';
 */

import type { Policy } from './policy.js';

// ─── Audit entry shape ────────────────────────────────────────────────────────

export type AuditDecision = 'allow' | 'deny';

export type ExtensionType = 'agent' | 'skill' | 'hook' | 'command';

export type AccessDomain = 'fs' | 'socket' | 'network';

/**
 * A single structured access-decision record.
 * Emitted each time an in-process handle's policy is queried.
 */
export interface AuditEntry {
  /** The extension key (e.g. "my-agent@1.0.0") */
  extensionId: string;
  /** The extension type ([def:inproc-types]) */
  type: ExtensionType;
  /** Resource domain being accessed */
  domain: AccessDomain;
  /** The specific resource being requested (path, hostname, etc.) */
  target: string;
  /** Whether the policy permitted or denied this access */
  decision: AuditDecision;
  /** Unix epoch milliseconds */
  timestamp: number;
}

// ─── In-memory audit log ──────────────────────────────────────────────────────

const _auditLog: AuditEntry[] = [];

/**
 * Record a structured access-decision entry.
 *
 * Called by in-process handle methods (checkFs, checkSocket, checkNetwork)
 * whenever the extension's compiled Policy is consulted.
 *
 * @param extensionId - the extension key (e.g. "my-ext@1.0.0")
 * @param type        - extension type: 'agent'|'skill'|'hook'|'command'
 * @param domain      - resource domain: 'fs'|'socket'|'network'
 * @param target      - the specific resource path or hostname
 * @param decision    - 'allow' or 'deny'
 */
export function auditAccess(
  extensionId: string,
  type: ExtensionType,
  domain: AccessDomain,
  target: string,
  decision: AuditDecision,
): void {
  _auditLog.push({
    extensionId,
    type,
    domain,
    target,
    decision,
    timestamp: Date.now(),
  });
}

/**
 * Return a snapshot of all recorded audit entries (oldest-first).
 * Intended for testing and observability tooling.
 */
export function getAuditLog(): readonly AuditEntry[] {
  return [..._auditLog];
}

/**
 * Clear all audit entries.
 * Intended for test isolation; not for use in production code paths.
 */
export function clearAuditLog(): void {
  _auditLog.length = 0;
}

// ─── In-process handle with policy-checked access methods ────────────────────

/**
 * An in-process handle's policy-checking interface.
 * Attached to every activated in-process handle so callers have a checked,
 * logged path to consult the extension's compiled Policy.
 *
 * SOFT enforcement level: the check is advisory — the shared address space
 * cannot prevent a non-cooperative extension from bypassing it.
 * See [def:inproc-types], [inv:per-type], [dod.6].
 */
export interface InprocPolicyHandle {
  /** The compiled policy attached at activation time. */
  policy: Policy;
  /**
   * Check whether the extension's policy permits file-system access.
   * Audit-logs the decision and returns the policy result.
   *
   * @param absPath - absolute filesystem path being accessed
   * @param op      - 'read' or 'write'
   */
  checkFs(absPath: string, op: 'read' | 'write'): boolean;
  /**
   * Check whether the extension's policy permits socket access.
   * Audit-logs the decision and returns the policy result.
   *
   * @param absPath - absolute socket path being accessed
   */
  checkSocket(absPath: string): boolean;
  /**
   * Check whether the extension's policy permits network access.
   * Audit-logs the decision and returns the policy result.
   *
   * @param hostOrUrl - hostname or URL being accessed
   */
  checkNetwork(hostOrUrl: string): boolean;
}

/**
 * Create an InprocPolicyHandle for a given extension + compiled policy.
 * Called by each in-process adapter at activation to attach policy-aware
 * access-checking methods to the handle.
 *
 * @param extensionId - the extension key
 * @param type        - the extension type
 * @param policy      - the compiled Policy for this extension
 */
export function makeInprocHandle(
  extensionId: string,
  type: ExtensionType,
  policy: Policy,
): InprocPolicyHandle {
  return {
    policy,

    checkFs(absPath: string, op: 'read' | 'write'): boolean {
      const allowed =
        op === 'read' ? policy.allowsFsRead(absPath) : policy.allowsFsWrite(absPath);
      auditAccess(extensionId, type, 'fs', absPath, allowed ? 'allow' : 'deny');
      return allowed;
    },

    checkSocket(absPath: string): boolean {
      const allowed = policy.allowsSocket(absPath);
      auditAccess(extensionId, type, 'socket', absPath, allowed ? 'allow' : 'deny');
      return allowed;
    },

    checkNetwork(hostOrUrl: string): boolean {
      const allowed = policy.allowsNetwork(hostOrUrl);
      auditAccess(extensionId, type, 'network', hostOrUrl, allowed ? 'allow' : 'deny');
      return allowed;
    },
  };
}
