/**
 * libs/install-engine/src/mcp-project-sync.ts
 *
 * Deliverable 1 — durable fix for Claude Code issue #16728.
 *
 * PROBLEM: a project's `.mcp.json` *overrides* (does not inherit) user-scope MCP
 * servers. So a user/global-scope MCP install (e.g. memory-server, registered in
 * `~/.claude.json` per ADR-0004 §D4) is INVISIBLE in any project that has its own
 * `.mcp.json`. Registering globally is necessary but not sufficient.
 *
 * FIX: when a user/global-scope MCP server is installed/updated, ALSO merge its
 * server entry (`mcpServers.<extId>`) into the `.mcp.json` of every project sox
 * knows about — the project roots recorded in the install-registry
 * (`InstallRecord`s with `scope:'project'`). The merge flows through the existing
 * `config-merge` capability (foreign entries preserved, applied-hash tracked), and
 * each merged project-`.mcp.json` key is recorded in the USER-scope ownership index
 * keyed per `(extId, projectRoot)` so uninstall reverses it across every project —
 * removing exactly the sox-owned entry, leaving the project's other MCP servers
 * byte-clean ([inv:no-untracked-injection] / [inv:reversible-injection]).
 *
 * SCOPE GUARD: only `.mcp.json` of project roots in the install-registry are
 * touched — never a filesystem scan. Foreign entries are always preserved.
 *
 * The ownership entries this module writes use a special `config-key` with the
 * ABSOLUTE project `.mcp.json` path and a `keyPath` of `mcpServers.<extId>`, tagged
 * via a synthetic `projectRoot` field so reversal can target each project exactly.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readInstallRegistry, resolveInstallRegistryPath, type InstallRecord } from './install-registry.js';
import { OwnershipIndex, type OwnedEntry } from './ownership.js';
import { dataRoot, ownershipPathFor } from './data-paths.js';
import { Ledger } from './ledger.js';
import { apply as configMergeApply } from './capabilities/config-merge.js';

// ─── Host resolution (lazy require — [inv:host-registry-lazy]) ──────────────────

interface HostSurface {
  capability: string;
  paths: Record<string, string | undefined>;
}
interface HostModuleLocal {
  surfaces: Record<string, HostSurface | undefined>;
}

function loadHostRegistry(): {
  getHost(name: string): HostModuleLocal;
  expandHome(p: string): string;
} {
  const mod = require('@adhd/sox-host-registry') as {
    getHost(name: string): HostModuleLocal;
    expandHome(p: string): string;
  };
  return mod;
}

/** Resolve the absolute user-scope MCP config file (`~/.claude.json`) for a host. */
export function resolveUserMcpConfigPath(host: string): string | undefined {
  const { getHost, expandHome } = loadHostRegistry();
  let hostMod: HostModuleLocal;
  try {
    hostMod = getHost(host);
  } catch {
    return undefined;
  }
  const surface = hostMod.surfaces['mcp-server'];
  const userPath = surface?.paths['user'];
  if (userPath === undefined) return undefined;
  return path.isAbsolute(userPath) ? expandHome(userPath) : userPath;
}

/** Resolve the absolute project `.mcp.json` path for a host, given the project root. */
export function resolveProjectMcpConfigPath(host: string, projectRoot: string): string | undefined {
  const { getHost } = loadHostRegistry();
  let hostMod: HostModuleLocal;
  try {
    hostMod = getHost(host);
  } catch {
    return undefined;
  }
  const surface = hostMod.surfaces['mcp-server'];
  const projectRel = surface?.paths['project'];
  if (projectRel === undefined) return undefined;
  return path.isAbsolute(projectRel) ? projectRel : path.join(projectRoot, projectRel);
}

// ─── Server-entry source of truth ───────────────────────────────────────────────

/**
 * Read the server entry that was registered globally (`~/.claude.json` →
 * `mcpServers.<extId>`). This is the canonical value to propagate — whatever was
 * actually registered for the user is what every project inherits, byte-identical.
 * Returns undefined if the global registration is absent.
 */
export function readGlobalServerEntry(host: string, extId: string): unknown {
  const userCfgPath = resolveUserMcpConfigPath(host);
  if (userCfgPath === undefined || !fs.existsSync(userCfgPath)) return undefined;
  try {
    const cfg = JSON.parse(fs.readFileSync(userCfgPath, 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    return cfg.mcpServers?.[extId];
  } catch {
    return undefined;
  }
}

// ─── Tracked global registration (the [inv:no-untracked-injection] counterpart) ──

/**
 * Register a user/global-scope MCP server entry into the host's user MCP config
 * (`~/.claude.json` → `mcpServers.<extId>`) WITH full ownership + ledger tracking,
 * so the injection is reversible on uninstall AND discoverable by tooling.
 * Idempotent.
 *
 * This is the tracked counterpart to a raw JSON merge. Use it ANYWHERE a user-scope
 * MCP server lands in `~/.claude.json` outside the normal `declarativeInstall` path
 * (e.g. `sox migrate-home`'s skill/MCP re-placement). A raw `mcpServers.<id> = v`
 * write leaves an UNTRACKED injection — invisible to discovery (the bug that made
 * `sync-mcp`/`upgrade --force` find nothing for a migrated server) and irreversible
 * (uninstall's ledger-driven reversal never removes a key no ledger action recorded).
 *
 * Records BOTH:
 *   1. the ledger action (appliedHash) via `config-merge` — what uninstall's
 *      `[inv:ledger-reversible]` reversal consumes to delete EXACTLY this key; and
 *   2. the ownership `config-key` entry — the inventory used for discovery and
 *      reversibility-by-inventory.
 *
 * @returns 'registered' on success, 'no-surface' if the host has no user MCP surface.
 */
export async function registerUserMcpServer(opts: {
  extId: string;
  serverEntry: unknown;
  host?: string;
  /** Data root holding ledger.json + ownership.json (default: dataRoot('user')). */
  scopeRoot?: string;
  /** Host placement base for ledger portability (default: $HOME). */
  workspaceRoot?: string;
}): Promise<'registered' | 'no-surface'> {
  const host = opts.host ?? 'claude';
  const userMcpPath = resolveUserMcpConfigPath(host);
  if (userMcpPath === undefined) return 'no-surface';

  const scopeRoot = opts.scopeRoot ?? dataRoot('user');
  const workspaceRoot = opts.workspaceRoot ?? require('node:os').homedir() as string;
  const keyPath = `mcpServers.${opts.extId}`;

  // 1. Write the value AND record the ledger action (appliedHash) so uninstall's
  //    ledger-driven reversal removes EXACTLY this key ([inv:ledger-reversible]).
  await configMergeApply({
    host,
    scope: 'user',
    scopeRoot,
    workspaceRoot,
    isProject: false,
    ext: opts.extId,
    target: { filePath: userMcpPath, keyPath },
    payload: { value: opts.serverEntry },
    // Backfill-safe: record the ledger reversal action even when the server entry
    // is already byte-present (the pre-tracking migrate-home case).
    recordWhenUnchanged: true,
  });

  // 2. Record the ownership config-key entry (inventory) — idempotent: never
  //    double-record the same (file, keyPath).
  const idx = OwnershipIndex.loadFromFile(path.join(scopeRoot, 'ownership.json'));
  const existing = idx.get(opts.extId, 'user');
  const already = (existing?.entries ?? []).some(
    (e) => e.kind === 'config-key' && e.file === userMcpPath && e.keyPath === keyPath,
  );
  if (!already) {
    idx.addEntries(opts.extId, 'user', [{ kind: 'config-key', file: userMcpPath, keyPath }], { host });
    idx.save();
  }
  return 'registered';
}

// ─── Project enumeration (install-registry only — scope guard) ──────────────────

/**
 * The distinct set of project roots sox knows about, from the install-registry.
 * ONLY project-scope records are considered ([scope-guard]: never a fs scan).
 */
export function knownProjectRoots(): string[] {
  let records: InstallRecord[];
  try {
    records = readInstallRegistry(resolveInstallRegistryPath()).installs;
  } catch {
    return [];
  }
  // Skip ephemeral roots under the OS temp dir: test runs leak `/tmp/...` project
  // roots into the install registry (BL-35), and propagating to them just re-creates
  // junk `.mcp.json` files and pollutes the ownership index. A project root under
  // os.tmpdir() is never a real install consumer. (macOS reports os.tmpdir() as
  // `/var/folders/...` while realpath adds a `/private` prefix — check both forms.)
  //
  // BL-49: the #16728 auto-merge reality probe (tools/probe-mcp-project-automerge.mjs)
  // legitimately records its throwaway FIXTURE project roots under os.tmpdir() and must
  // be able to test propagation to them. It opts out via SOX_ALLOW_TMP_PROJECT_ROOTS=1,
  // which production never sets — so the BL-35 leak guard stays fully in force everywhere
  // except a test that explicitly asks for tmp roots to count.
  const allowTmp = process.env['SOX_ALLOW_TMP_PROJECT_ROOTS'] === '1';
  const tmpDir = os.tmpdir();
  let tmpReal = tmpDir;
  try { tmpReal = fs.realpathSync(tmpDir); } catch { /* ignore */ }
  const underTmp = (p: string): boolean =>
    p === tmpDir || p.startsWith(tmpDir + path.sep) ||
    p === tmpReal || p.startsWith(tmpReal + path.sep);

  const roots = new Set<string>();
  for (const r of records) {
    if (r.scope === 'project' && typeof r.root === 'string' && r.root.length > 0) {
      if (!allowTmp && underTmp(r.root)) continue;
      roots.add(r.root);
    }
  }
  return [...roots];
}

// ─── The synthetic ownership entry for a project `.mcp.json` merge ──────────────

/**
 * Ownership-entry identity for a propagated project merge. We reuse the existing
 * `config-key` OwnedEntry kind (no schema change) — `file` is the absolute project
 * `.mcp.json`, `keyPath` is `mcpServers.<extId>`. Because every entry carries its own
 * absolute `file`, reversal targets each project deterministically.
 */
function projectMergeEntry(mcpJsonPath: string, extId: string, appliedHash?: string): OwnedEntry {
  return appliedHash !== undefined
    ? { kind: 'config-key', file: mcpJsonPath, keyPath: `mcpServers.${extId}`, appliedHash }
    : { kind: 'config-key', file: mcpJsonPath, keyPath: `mcpServers.${extId}` };
}

/** True for an ownership entry that is a propagated project-`.mcp.json` merge. */
function isProjectMcpEntry(e: OwnedEntry): e is Extract<OwnedEntry, { kind: 'config-key' }> {
  return e.kind === 'config-key' && e.file.endsWith('.mcp.json') && e.keyPath.startsWith('mcpServers.');
}

// ─── Sync result for reporting ──────────────────────────────────────────────────

export interface ProjectSyncResult {
  projectRoot: string;
  mcpJsonPath: string;
  action: 'merged' | 'up-to-date' | 'would-merge' | 'skipped';
  reason?: string;
}

export interface SyncMcpOptions {
  /** The MCP server extId (e.g. "memory-server"). */
  extId: string;
  /** The host whose surfaces resolve the config paths (default "claude"). */
  host?: string;
  /**
   * The server entry value to write at `mcpServers.<extId>`. If omitted, it is read
   * from the global `~/.claude.json` registration (the canonical source of truth).
   */
  serverEntry?: unknown;
  /** Dry-run: compute + report, but write nothing. */
  dryRun?: boolean;
  /**
   * Restrict to a single project root (used by the auto-hook so a project-scope
   * install does not re-propagate to every project). When omitted, all known
   * project roots are targeted.
   */
  onlyRoot?: string;
}

/**
 * Propagate a user/global-scope MCP server entry into every known project's
 * `.mcp.json` (durable #16728 fix). Idempotent: a project already carrying the
 * byte-identical entry is reported `up-to-date` and not rewritten.
 *
 * Records each merged key in the USER-scope ownership index keyed per
 * `(extId, projectRoot)` so uninstall reverses it across every project.
 */
export async function syncUserMcpToProjects(opts: SyncMcpOptions): Promise<ProjectSyncResult[]> {
  const host = opts.host ?? 'claude';
  const extId = opts.extId;
  const results: ProjectSyncResult[] = [];

  const serverEntry = opts.serverEntry ?? readGlobalServerEntry(host, extId);
  if (serverEntry === undefined) {
    // Nothing registered globally → nothing to propagate. Not an error.
    return results;
  }

  let roots = knownProjectRoots();
  if (opts.onlyRoot !== undefined) {
    roots = roots.filter((r) => r === opts.onlyRoot);
  }
  if (roots.length === 0) return results;

  // Accumulate the ownership entries we (re)record, keyed per project.
  const ownedEntries: OwnedEntry[] = [];
  const idx = OwnershipIndex.loadFromFile(ownershipPathFor('user'));
  // Start from any pre-existing project-merge entries we still own so re-running
  // preserves projects that may not be in the current registry slice. (We replace
  // the per-project entry below if we touch it.)
  const existing = idx.get(extId, 'user');
  const preservedOther: OwnedEntry[] = (existing?.entries ?? []).filter((e) => !isProjectMcpEntry(e));
  type ConfigKeyEntry = Extract<OwnedEntry, { kind: 'config-key' }>;
  const preservedProjectByFile = new Map<string, ConfigKeyEntry>();
  for (const e of existing?.entries ?? []) {
    if (isProjectMcpEntry(e)) preservedProjectByFile.set(e.file, e);
  }

  for (const projectRoot of roots) {
    const mcpJsonPath = resolveProjectMcpConfigPath(host, projectRoot);
    if (mcpJsonPath === undefined) {
      results.push({ projectRoot, mcpJsonPath: '', action: 'skipped', reason: 'no project mcp surface' });
      continue;
    }

    // Idempotency: is the byte-identical entry already present?
    let current: unknown;
    if (fs.existsSync(mcpJsonPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8')) as {
          mcpServers?: Record<string, unknown>;
        };
        current = cfg.mcpServers?.[extId];
      } catch {
        // Unparseable project .mcp.json — skip rather than clobber foreign content.
        results.push({ projectRoot, mcpJsonPath, action: 'skipped', reason: 'unparseable .mcp.json' });
        continue;
      }
    }
    const alreadyEqual = current !== undefined &&
      JSON.stringify(current) === JSON.stringify(serverEntry);

    if (opts.dryRun) {
      results.push({
        projectRoot,
        mcpJsonPath,
        action: alreadyEqual ? 'up-to-date' : 'would-merge',
      });
      // In dry-run, preserve the previously-recorded entry if any.
      const prev = preservedProjectByFile.get(mcpJsonPath);
      ownedEntries.push(prev ?? projectMergeEntry(mcpJsonPath, extId));
      continue;
    }

    if (alreadyEqual) {
      results.push({ projectRoot, mcpJsonPath, action: 'up-to-date' });
      ownedEntries.push(projectMergeEntry(mcpJsonPath, extId));
      continue;
    }

    // Merge via the config-merge capability (foreign entries preserved, applied-hash
    // tracked). scopeRoot is the PROJECT's resolved data dir (.adhd/sox-ecosystem)
    // so the ledger lands in the canonical location — NOT a stray ledger.json at the
    // project root. workspaceRoot is the project root (the host placement base) so the
    // project ledger stores portable relative paths (ADR-0004 splits these two roots).
    await configMergeApply({
      host,
      scope: 'project',
      scopeRoot: dataRoot('project', projectRoot),
      workspaceRoot: projectRoot,
      isProject: true,
      ext: extId,
      target: { filePath: mcpJsonPath, keyPath: `mcpServers.${extId}` },
      payload: { value: serverEntry },
    });

    results.push({ projectRoot, mcpJsonPath, action: 'merged' });
    ownedEntries.push(projectMergeEntry(mcpJsonPath, extId));
  }

  if (!opts.dryRun) {
    // Re-record the user-scope ownership entry: preserved non-project entries
    // (the global config-key, etc.) + the current project-merge inventory + any
    // previously-owned project merges for projects we did NOT touch this run.
    const touchedFiles = new Set(ownedEntries.filter(isProjectMcpEntry).map((e) => e.file));
    const untouchedProjectEntries = [...preservedProjectByFile.values()].filter(
      (e) => !touchedFiles.has(e.file),
    );
    const meta = existing?.host !== undefined ? { host: existing.host } : { host };
    idx.record({
      extId,
      scope: 'user',
      ...meta,
      ...(existing?.bundleId !== undefined ? { bundleId: existing.bundleId } : {}),
      ...(existing?.artifactChecksum !== undefined ? { artifactChecksum: existing.artifactChecksum } : {}),
      entries: [...preservedOther, ...untouchedProjectEntries, ...ownedEntries],
    });
    idx.save();
  }

  return results;
}

/**
 * Reverse every propagated project-`.mcp.json` merge for a user-scope MCP server —
 * called on user-scope uninstall. Removes EXACTLY `mcpServers.<extId>` from each
 * project `.mcp.json` we own, leaving foreign servers byte-clean. The per-project
 * config-merge reversal also clears the project ledger entry.
 *
 * Returns the list of project `.mcp.json` paths reversed (for reporting).
 */
export async function reverseUserMcpFromProjects(opts: {
  extId: string;
  host?: string;
}): Promise<string[]> {
  const host = opts.host ?? 'claude';
  const extId = opts.extId;
  const reversed: string[] = [];

  const idx = OwnershipIndex.loadFromFile(ownershipPathFor('user'));
  const rec = idx.get(extId, 'user');
  if (rec === undefined) return reversed;

  const projectEntries = rec.entries.filter(isProjectMcpEntry);

  for (const entry of projectEntries) {
    const mcpJsonPath = entry.file;
    // The project root is the dir holding `.mcp.json`.
    const projectRoot = path.dirname(mcpJsonPath);

    // Remove EXACTLY `mcpServers.<extId>` from this project's .mcp.json, preserving
    // every foreign server and top-level key. We do the deletion directly (rather
    // than via config-merge.reverse) because the project ledger stores the merge
    // target as a repo-RELATIVE path while we hold the ABSOLUTE path here — the two
    // would not match. This direct, foreign-preserving deletion is the same key
    // removal the ledger reverse performs, and we clear the ledger entry below so no
    // provenance is stranded ([inv:reversible-injection]).
    if (fs.existsSync(mcpJsonPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8')) as {
          mcpServers?: Record<string, unknown>;
        };
        if (cfg.mcpServers && Object.prototype.hasOwnProperty.call(cfg.mcpServers, extId)) {
          delete cfg.mcpServers[extId];
          fs.writeFileSync(mcpJsonPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
        }
      } catch {
        /* unparseable — leave it; nothing we can safely do */
      }
    }

    // Clear the project ledger entry for this merge so no stale provenance lingers.
    try {
      const projDataDir = dataRoot('project', projectRoot);
      const ledger = Ledger.load(projDataDir, { isProject: true });
      const actions = ledger.actionsFor(extId, host, 'project');
      if (actions.length > 0) {
        ledger.remove(extId, host, 'project');
        ledger.save();
      }
    } catch {
      /* best-effort ledger cleanup — the .mcp.json is already byte-clean */
    }

    reversed.push(mcpJsonPath);
  }

  // Strip the project-merge entries from the user-scope ownership record (the
  // caller — cmdUninstall — removes the whole record afterward; this keeps the
  // index consistent if called standalone, e.g. by sync-mcp --prune in future).
  const remaining = rec.entries.filter((e) => !isProjectMcpEntry(e));
  if (remaining.length !== rec.entries.length) {
    const meta = rec.host !== undefined ? { host: rec.host } : {};
    idx.record({
      extId,
      scope: 'user',
      ...meta,
      ...(rec.bundleId !== undefined ? { bundleId: rec.bundleId } : {}),
      ...(rec.artifactChecksum !== undefined ? { artifactChecksum: rec.artifactChecksum } : {}),
      entries: remaining,
    });
    idx.save();
  }

  return reversed;
}
