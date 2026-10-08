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
 *   [inv:never-managed]      — soxe never writes Claude managed tier or Codex
 *                              project-forbidden keys.
 *   [inv:boundary]           — Role B: soxe materialises bytes at discovery path;
 *                              it never asserts the host ran the content.
 *   [inv:no-regress]         — existing host-runtime e2e stays green.
 *
 * [dod.12] — a capability that cannot cleanly reverse aborts: abort / cannot reverse
 * is signalled by throwing ReverseAbortError (checked by audit + install-engine:test).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Ledger, LedgerAction } from './ledger.js';
import { OwnershipIndex, type OwnedEntry } from './ownership.js';
import type { AgentCatalogClient } from './capabilities/agent-catalog.js';

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
  /**
   * Optional agent-catalog client (for test injection). Defaults to the MCP-over-stdio
   * client that spawns the agent-mcp server. Threaded to `agent-catalog` reversal only.
   */
  catalogClient?: AgentCatalogClient;
  /**
   * e46db6ed: actions this call must NOT reverse because another, still-installed host
   * claims the same shared target (path / config key). They are still dropped from this
   * host's ledger entry; only the destructive reversal is skipped.
   */
  retain?: (action: LedgerAction) => boolean;
  /** Called with each file-drop path this call actually deleted. */
  onFileRemoved?: (absPath: string) => void;
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
    if (ctx.retain?.(action) === true) continue;
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
  // [inv:ledger-reversible]: a project ledger stores repo-relative paths (resolved against
  // ctx.scopeRoot = the workspace root), never cwd-relative ones.
  const target = path.isAbsolute(action.file) ? action.file : path.join(ctx.scopeRoot, action.file);
  switch (action.cap) {
    case 'file-drop': {
      // file-drop: delete the placed file/dir.
      // [inv:ledger-reversible]: project ledger stores repo-relative paths;
      // resolve them against ctx.scopeRoot (= workspaceRoot for project scope).
      const fileDropPath = target;
      if (fs.existsSync(fileDropPath)) {
        try {
          fs.rmSync(fileDropPath, { recursive: true, force: true });
          ctx.onFileRemoved?.(fileDropPath);
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
      if (!fs.existsSync(target)) {
        // File gone — nothing to remove. Treat as success (idempotent).
        break;
      }
      let config: Record<string, unknown>;
      try {
        config = readJsonSafe(target);
      } catch (e) {
        throw new ReverseAbortError(
          'config-merge',
          target,
          `cannot read config for reversal: ${String(e)}`,
        );
      }
      const parts = action.keyPath.split('.').filter(Boolean);
      deleteByKeyPath(config, parts);
      try {
        const dir = path.dirname(target);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(target, JSON.stringify(config, null, 2) + '\n', 'utf8');
      } catch (e) {
        throw new ReverseAbortError(
          'config-merge',
          target,
          `cannot write config after reversal: ${String(e)}`,
        );
      }
      break;
    }

    case 'array-merge': {
      // array-merge: remove ONLY the values soxe appended (deny-wins semantics).
      // [inv:ledger-reversible]: other values in the array are untouched.
      if (!fs.existsSync(target)) break;
      if (!action.values || action.values.length === 0) break;

      let config: Record<string, unknown>;
      try {
        config = readJsonSafe(target);
      } catch (e) {
        throw new ReverseAbortError(
          'array-merge',
          target,
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
        const dir = path.dirname(target);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(target, JSON.stringify(config, null, 2) + '\n', 'utf8');
      } catch (e) {
        throw new ReverseAbortError(
          'array-merge',
          target,
          `cannot write config after array-merge reversal: ${String(e)}`,
        );
      }
      break;
    }

    case 'agent-catalog': {
      // agent-catalog: retire the row from the remote catalog over its own MCP
      // surface. Idempotent — a missing row is success. The row is named from
      // the rendered agent name, which may differ from the extension id
      // (6a10f744); prefer the row name recorded at apply time.
      const { reverse: agentCatalogReverse } = await import('./capabilities/agent-catalog.js');
      const rowName = action.meta?.rowName;
      await agentCatalogReverse({
        ext: ctx.ext,
        ...(typeof rowName === 'string' && rowName !== '' ? { name: rowName } : {}),
        ...(ctx.catalogClient !== undefined ? { client: ctx.catalogClient } : {}),
      });
      break;
    }

    case 'object-array-merge': {
      // object-array-merge: remove ONLY the identity-tagged entries soxe appended.
      // [inv:ledger-reversible]: other entries (foreign identities) are untouched.
      if (!fs.existsSync(target)) break;

      const metaEntries = action.meta?.entries as Record<string, unknown>[] | undefined;
      if (!metaEntries || metaEntries.length === 0) break;

      const removedHashes = new Set(metaEntries.map((e) => JSON.stringify(e)));

      let config: Record<string, unknown>;
      try {
        config = readJsonSafe(target);
      } catch (e) {
        throw new ReverseAbortError(
          'object-array-merge',
          target,
          `cannot read config for reversal: ${String(e)}`,
        );
      }

      const parts = action.keyPath.split('.').filter(Boolean);
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
        cur[lastKey] = (existing as Record<string, unknown>[]).filter(
          (e) => !removedHashes.has(JSON.stringify(e)),
        );
      }

      try {
        const dir = path.dirname(target);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(target, JSON.stringify(config, null, 2) + '\n', 'utf8');
      } catch (e) {
        throw new ReverseAbortError(
          'object-array-merge',
          target,
          `cannot write config after object-array-merge reversal: ${String(e)}`,
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

// ─── Ownership-driven uninstall (e46db6ed) ────────────────────────────────────
//
// ADR-0004 §D6: `uninstall --host H` reverses only entries attributed to H
// and H's ledger entry. Host-independent entries (materialize, os-unit, lockfile-key,
// registry-record) carry no host and go, with the index record, only when no
// host-bearing entries remain. No `--host` means all hosts.
//
// Attribution is the UNION of the entry's install-time stamp (`OwnedEntry.host`) and
// every host whose ledger claims the same target by exact path/file(+keyPath). The stamp
// alone is not enough: `host` is deliberately not part of the ownership dedupe key, so
// two hosts placing the same path collapse into one entry stamped by whichever host
// installed last. Reading only the stamp made the outcome depend on install order and
// let the stamp holder delete a path another host still claimed. With the union, a
// shared target is removed only when the last claiming host is removed, in any order;
// when the stamp holder leaves first the stamp moves to a remaining claimant so no
// entry keeps naming a host that is gone. Host-less legacy entries (no stamp) are
// attributed only by that exact ledger match; otherwise the verb refuses and names the
// all-hosts form. The record-level `host` is informational and never used for
// attribution.

/** `--host X` names a host that has no footprint for (ext, scope): nothing was touched. */
export class HostNotInstalledError extends Error {
  constructor(
    public readonly ext: string,
    public readonly host: string,
    public readonly scope: string,
    public readonly installedHosts: string[],
  ) {
    super(
      `extension '${ext}' is not installed on host '${host}' in scope '${scope}'` +
        (installedHosts.length > 0 ? ` (installed on: ${installedHosts.join(', ')})` : ''),
    );
    this.name = 'HostNotInstalledError';
  }
}

/**
 * `--host H` on a record holding host-less legacy entries that no host's ledger
 * claims by exact path: attributing them would be a guess that could delete another
 * host's files, so the verb refuses and touches nothing.
 */
export class AmbiguousLegacyUninstallError extends Error {
  constructor(
    public readonly ext: string,
    public readonly host: string,
    public readonly scope: string,
    public readonly unattributed: string[],
  ) {
    super(
      `cannot attribute ${unattributed.length} legacy ownership entr${unattributed.length === 1 ? 'y' : 'ies'} ` +
        `of '${ext}' (scope '${scope}') to host '${host}' (${unattributed.join(', ')}). ` +
        `Nothing was removed. Remove every host at once with: soxe uninstall ${ext} -s ${scope}`,
    );
    this.name = 'AmbiguousLegacyUninstallError';
  }
}

/**
 * An uninstall failed part-way. The message states exactly what was already reversed
 * (hosts, paths) so the operator never has to guess at the divergence; reversal is
 * idempotent, so re-running the same command finishes the job.
 */
export class UninstallAbortedError extends Error {
  constructor(
    public readonly ext: string,
    public readonly scope: string,
    public readonly stage: 'host-reversal' | 'host-independent-teardown',
    public readonly failedHost: string | undefined,
    public readonly hostsReversed: string[],
    public readonly removedPaths: string[],
    public readonly cause: unknown,
  ) {
    super(
      `uninstall of '${ext}' (scope '${scope}') aborted during ${stage}` +
        (failedHost !== undefined ? ` on host '${failedHost}'` : '') +
        `: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        `Already reversed: hosts [${hostsReversed.join(', ') || 'none'}]` +
        (removedPaths.length > 0 ? `, removed paths [${removedPaths.join(', ')}]` : '') +
        `. The ownership record keeps everything not yet reversed; ` +
        `re-run the same command to finish (reversal is idempotent).`,
    );
    this.name = 'UninstallAbortedError';
  }
}

type HostBearingEntry = Extract<
  OwnedEntry,
  { kind: 'file-drop' | 'config-key' | 'array-values' | 'object-array-values' | 'agent-catalog' }
>;

const TRUST_KEYPATH_PREFIX = 'trust:';

function isHostBearingKind(e: OwnedEntry): e is HostBearingEntry {
  return (
    e.kind === 'file-drop' ||
    e.kind === 'config-key' ||
    e.kind === 'array-values' ||
    e.kind === 'object-array-values' ||
    e.kind === 'agent-catalog'
  );
}

/**
 * Host-less config-key entries written by the project `.mcp.json` / `~/.claude.json`
 * trust propagators (mcp-project-sync, mcp-trust-sync). They are reversed by those
 * modules on full removal, never by host attribution.
 */
function isPropagationEntry(e: OwnedEntry): boolean {
  if (e.kind !== 'config-key' || e.host !== undefined) return false;
  return (
    (e.file.endsWith('.mcp.json') && e.keyPath.startsWith('mcpServers.')) ||
    e.keyPath.startsWith(TRUST_KEYPATH_PREFIX)
  );
}

/** True when `e` takes part in host attribution (placed by a specific host's install). */
function isHostAttributable(e: OwnedEntry): e is HostBearingEntry {
  return isHostBearingKind(e) && !isPropagationEntry(e);
}

/** Stable identity of an entry across `OwnershipIndex.save()` (which re-reads the file). */
function entryId(e: OwnedEntry): string {
  switch (e.kind) {
    case 'file-drop':
    case 'materialize':
      return `${e.kind}:${e.path}`;
    case 'config-key':
    case 'array-values':
    case 'object-array-values':
    case 'lockfile-key':
      return `${e.kind}:${e.file}:${e.keyPath}`;
    case 'registry-record':
      return `${e.kind}:${e.extId}:${e.scope}:${e.root}`;
    case 'agent-catalog':
      return `${e.kind}:${e.name}`;
    case 'os-unit':
      return `${e.kind}:${e.label}`;
  }
}

function entryLabel(e: OwnedEntry): string {
  switch (e.kind) {
    case 'file-drop':
    case 'materialize':
      return e.path;
    case 'config-key':
    case 'array-values':
    case 'object-array-values':
      return `${e.file}#${e.keyPath}`;
    case 'agent-catalog':
      return `agent-catalog:${e.name}`;
    default:
      return e.kind;
  }
}

export interface OwnedUninstallInput {
  ext: string;
  scope: HostScope;
  /** The scope's data dir (holds ledger.json / ownership.json). */
  dataDir: string;
  /** Workspace root — project-ledger paths are repo-relative to it. */
  workspaceRoot: string;
  isProject: boolean;
  /** Host to remove; absent = all hosts. */
  host?: string;
  ownership: OwnershipIndex;
  /** Optional pre-loaded ledger (read for planning, mutated by the reversal). */
  ledger?: Ledger;
}

export interface OwnedUninstallPlan {
  /** Hosts whose ledger entry is reversed. */
  hosts: string[];
  /** Entries this uninstall removes from the record. */
  entries: OwnedEntry[];
  /** True when nothing host-bearing remains: the record and shared state go too. */
  full: boolean;
  /** Hosts that keep an install after this uninstall (empty when `full`). */
  remainingHosts: string[];
  /** Hosts with any footprint before the uninstall. */
  installedHosts: string[];
  /**
   * Kept entries whose stamp names a host being removed while another host still
   * claims them: re-stamped to that remaining host so no entry names a departed host.
   */
  restamps: Array<{ entry: OwnedEntry; host: string }>;
}

function resolveLedgerFile(file: string, workspaceRoot: string): string {
  return path.isAbsolute(file) ? file : path.join(workspaceRoot, file);
}

/** Hosts whose ledger claims `e` by exact path/file (+keyPath for config entries). */
function ledgerHostsClaiming(
  ext: string,
  e: HostBearingEntry,
  ledgerByHost: Map<string, LedgerAction[]>,
  workspaceRoot: string,
): string[] {
  const out: string[] = [];
  for (const [host, actions] of ledgerByHost) {
    const claimed = actions.some((a) => {
      switch (e.kind) {
        case 'file-drop':
          return a.cap === 'file-drop' && resolveLedgerFile(a.file, workspaceRoot) === e.path;
        case 'config-key':
          return (
            a.cap === 'config-merge' &&
            a.keyPath === e.keyPath &&
            resolveLedgerFile(a.file, workspaceRoot) === e.file
          );
        case 'array-values':
          return (
            a.cap === 'array-merge' &&
            a.keyPath === e.keyPath &&
            resolveLedgerFile(a.file, workspaceRoot) === e.file
          );
        case 'object-array-values':
          return (
            a.cap === 'object-array-merge' &&
            a.keyPath === e.keyPath &&
            resolveLedgerFile(a.file, workspaceRoot) === e.file
          );
        case 'agent-catalog': {
          if (a.cap !== 'agent-catalog') return false;
          // The reversal retires the row named by `meta.rowName`, else the extension
          // id (see reverseAction). An action only claims the entry naming that row.
          const rowName = a.meta?.['rowName'];
          return e.name === (typeof rowName === 'string' && rowName !== '' ? rowName : ext);
        }
      }
    });
    if (claimed) out.push(host);
  }
  return out;
}

/**
 * Identity of the target an action mutates. Two hosts' actions with the same identity
 * share that target, so removing one host must not reverse it while the other remains.
 * Array/object-array merges include the appended values: hosts appending different
 * values to the same array each remove only their own.
 */
function actionIdentity(a: LedgerAction, ext: string, workspaceRoot: string): string {
  const file = resolveLedgerFile(a.file, workspaceRoot);
  switch (a.cap) {
    case 'file-drop':
      return `file-drop|${file}`;
    case 'array-merge':
      return `array-merge|${file}|${a.keyPath}|${JSON.stringify([...(a.values ?? [])].sort())}`;
    case 'object-array-merge':
      return `object-array-merge|${file}|${a.keyPath}|${JSON.stringify(a.meta?.['entries'] ?? [])}`;
    case 'agent-catalog': {
      const rowName = a.meta?.['rowName'];
      return `agent-catalog|${typeof rowName === 'string' && rowName !== '' ? rowName : ext}`;
    }
    default:
      return `${a.cap}|${file}|${a.keyPath}`;
  }
}

interface ComputedPlan {
  plan: OwnedUninstallPlan;
  /** Per host-attributable entry: every host that owns it (stamp ∪ ledger claimants). */
  owners: Map<string, string[]>;
  ledgerByHost: Map<string, LedgerAction[]>;
}

function computePlan(input: OwnedUninstallInput, ledger: Ledger): ComputedPlan {
  const { ext, scope, host, ownership } = input;
  const rec = ownership.get(ext, scope);
  const entries = rec?.entries ?? [];

  const ledgerByHost = new Map<string, LedgerAction[]>();
  for (const le of ledger.entries()) {
    if (le.ext === ext && le.scope === scope) {
      ledgerByHost.set(le.host, [...(ledgerByHost.get(le.host) ?? []), ...le.actions]);
    }
  }
  const ledgerHosts = [...ledgerByHost.keys()];

  // Per-entry owner set: the stamped host UNION every host whose ledger claims it.
  const owners = new Map<string, string[]>();
  const unattributed: OwnedEntry[] = [];
  for (const e of entries) {
    if (!isHostAttributable(e)) continue;
    const o = new Set<string>(ledgerHostsClaiming(ext, e, ledgerByHost, input.workspaceRoot));
    if (e.host !== undefined) o.add(e.host);
    owners.set(entryId(e), [...o].sort());
    if (o.size === 0) unattributed.push(e);
  }

  const installed = new Set<string>(ledgerHosts);
  for (const o of owners.values()) for (const h of o) installed.add(h);
  const installedHosts = [...installed].sort();

  if (host === undefined) {
    // All hosts. owned.host is a legacy fallback only (informational elsewhere).
    const hosts = new Set<string>(ledgerHosts);
    if (rec !== undefined) hosts.add(rec.host ?? 'claude');
    return {
      plan: {
        hosts: [...hosts].sort(),
        entries: [...entries],
        full: true,
        remainingHosts: [],
        installedHosts,
        restamps: [],
      },
      owners,
      ledgerByHost,
    };
  }

  const knownViaRecord = rec !== undefined && rec.host === host && entries.some(isHostAttributable);
  if (!installed.has(host) && !knownViaRecord) {
    throw new HostNotInstalledError(ext, host, scope, installedHosts);
  }
  if (unattributed.length > 0) {
    throw new AmbiguousLegacyUninstallError(ext, host, scope, unattributed.map(entryLabel));
  }

  const target: string = host;
  const toRemove: OwnedEntry[] = [];
  const restamps: Array<{ entry: OwnedEntry; host: string }> = [];
  const keptOwners = new Set<string>();
  let keptHostBearing = 0;
  for (const e of entries) {
    const o: string[] | undefined = owners.get(entryId(e));
    if (o === undefined) continue; // host-independent or propagation: handled on full
    if (o.includes(target) && o.every((x) => x === target)) {
      toRemove.push(e);
    } else {
      keptHostBearing++;
      const others = o.filter((x) => x !== target);
      others.forEach((x) => keptOwners.add(x));
      if (e.host === target && others[0] !== undefined) restamps.push({ entry: e, host: others[0] });
    }
  }
  ledgerHosts.filter((x) => x !== target).forEach((x) => keptOwners.add(x));

  const full = keptHostBearing === 0 && keptOwners.size === 0;
  return {
    plan: {
      hosts: [host],
      entries: full ? [...entries] : toRemove,
      full,
      remainingHosts: full ? [] : [...keptOwners].sort(),
      installedHosts,
      restamps: full ? [] : restamps,
    },
    owners,
    ledgerByHost,
  };
}

/**
 * Decide, without touching anything, what `uninstall [--host H]` would reverse.
 * Throws `HostNotInstalledError` / `AmbiguousLegacyUninstallError` — both before any
 * mutation, so a refused uninstall provably touches nothing.
 */
export function planOwnedUninstall(input: OwnedUninstallInput): OwnedUninstallPlan {
  const ledger = input.ledger ?? Ledger.load(input.dataDir, { isProject: input.isProject });
  return computePlan(input, ledger).plan;
}

export interface OwnedUninstallResult {
  /** Hosts whose ledger entry was reversed. */
  hostsRemoved: string[];
  /** Filesystem paths deleted (file-drop / materialize). */
  removedPaths: string[];
  /** The ownership record is gone; the caller now removes lockfile/config/install record. */
  full: boolean;
  /** Hosts still installed (empty when `full`). */
  remainingHosts: string[];
  warnings: string[];
}

/**
 * Execute `uninstall [--host H]` against the ownership index + ledger.
 * Reverses each affected host's ledger entry, deletes the entries attributed to the
 * removed host(s), and — only when nothing host-bearing remains — the host-independent
 * entries and the record itself. Non-fatal removal problems are returned as `warnings`.
 *
 * Progress is persisted after every host: a host's attributed entries leave the
 * ownership record the moment its ledger entry is reversed, so a later failure never
 * leaves the two stores disagreeing; a failure is reported as `UninstallAbortedError`
 * naming what was already reversed. Targets shared with a host that stays installed are
 * never reversed (see `LifecycleCtx.retain`).
 *
 * `reverseHostIndependent` runs on full removal only, after every host's reversal and
 * before the host-independent filesystem entries are deleted (the CLI hooks OS-unit
 * teardown here, which needs the process supervisor). If it throws, the record keeps
 * the host-independent entries, so re-running the command retries the teardown.
 */
export async function uninstallOwned(
  input: OwnedUninstallInput & {
    catalogClient?: AgentCatalogClient;
    reverseHostIndependent?: (entries: OwnedEntry[]) => Promise<void>;
  },
): Promise<OwnedUninstallResult> {
  const { ext, scope, ownership } = input;
  // One ledger instance for planning AND reversal. The ledger FILE lives in dataDir,
  // but project-ledger paths are repo-relative to the WORKSPACE root: reverseAction
  // resolves them against ctx.scopeRoot, so that must be the workspace root.
  const ledger = input.ledger ?? Ledger.load(input.dataDir, { isProject: input.isProject });
  const { plan, owners, ledgerByHost } = computePlan(input, ledger);
  const warnings: string[] = [];
  const removedPaths: string[] = [];

  // Targets still claimed by a host this call leaves installed.
  const keptIdentities = new Set<string>();
  for (const [h, actions] of ledgerByHost) {
    if (plan.hosts.includes(h)) continue;
    for (const a of actions) keptIdentities.add(actionIdentity(a, ext, input.workspaceRoot));
  }
  const retain = (a: LedgerAction): boolean =>
    keptIdentities.has(actionIdentity(a, ext, input.workspaceRoot));

  const removeEntryPath = (e: OwnedEntry): void => {
    if (e.kind !== 'file-drop' && e.kind !== 'materialize') return;
    try {
      if (fs.existsSync(e.path)) {
        fs.rmSync(e.path, { recursive: true, force: true });
        removedPaths.push(e.path);
      }
    } catch (err) {
      warnings.push(`could not remove ${e.path}: ${String(err)}`);
    }
  };

  const reversedHosts: string[] = [];
  const handled = new Set<string>();
  const persistProgress = (): void => {
    const rec = ownership.get(ext, scope);
    if (rec === undefined) return;
    const done = rec.entries.filter((e) => {
      const o = owners.get(entryId(e));
      return (
        o !== undefined &&
        o.length > 0 &&
        !handled.has(entryId(e)) &&
        o.every((x) => reversedHosts.includes(x))
      );
    });
    if (done.length === 0) return;
    for (const e of done) {
      removeEntryPath(e);
      handled.add(entryId(e));
    }
    const gone = new Set<string>(done.map(entryId));
    ownership.record({ extId: ext, scope, entries: rec.entries.filter((e) => !gone.has(entryId(e))) });
    ownership.save();
  };

  for (const h of plan.hosts) {
    try {
      await uninstall({
        ext,
        host: h,
        scope,
        scopeRoot: input.workspaceRoot,
        isProject: input.isProject,
        ledger,
        retain,
        onFileRemoved: (p) => removedPaths.push(p),
        ...(input.catalogClient !== undefined ? { catalogClient: input.catalogClient } : {}),
      });
      reversedHosts.push(h);
      persistProgress();
    } catch (e) {
      throw new UninstallAbortedError(ext, scope, 'host-reversal', h, [...reversedHosts], [...removedPaths], e);
    }
  }

  if (plan.full && input.reverseHostIndependent !== undefined) {
    try {
      await input.reverseHostIndependent(plan.entries.filter((e) => !handled.has(entryId(e))));
    } catch (e) {
      throw new UninstallAbortedError(
        ext, scope, 'host-independent-teardown', undefined, [...reversedHosts], [...removedPaths], e,
      );
    }
  }

  for (const e of plan.entries) {
    if (!handled.has(entryId(e))) removeEntryPath(e);
  }

  const rec = ownership.get(ext, scope);
  if (plan.full) {
    if (rec !== undefined) ownership.remove(ext, scope);
  } else if (rec !== undefined) {
    const gone = new Set<string>(plan.entries.map(entryId));
    const restamp = new Map<string, string>(plan.restamps.map((r) => [entryId(r.entry), r.host]));
    ownership.record({
      extId: ext,
      scope,
      entries: rec.entries
        .filter((e) => !gone.has(entryId(e)))
        .map((e) => {
          const h = restamp.get(entryId(e));
          return h === undefined ? e : { ...e, host: h };
        }),
    });
  }
  if (rec !== undefined) ownership.save();

  // Hosts actually reversed: those with a footprint. A never-installed owned.host
  // fallback reverses nothing and is not reported.
  return {
    hostsRemoved: plan.hosts.filter((h) => plan.installedHosts.includes(h)),
    removedPaths,
    full: plan.full,
    remainingHosts: plan.remainingHosts,
    warnings,
  };
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
