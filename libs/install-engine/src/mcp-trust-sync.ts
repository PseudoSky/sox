/**
 * libs/install-engine/src/mcp-trust-sync.ts
 *
 * Durable fix: Claude Code gates every `.mcp.json` remote MCP server behind a
 * per-project trust list — `~/.claude.json` → `projects["<projectRoot>"]
 * .enabledMcpjsonServers` — approved via an interactive prompt on first use.
 * `soxe install` never wrote to this list (by design — see the historical note
 * in claude.ts's mcp-server surface). The gap: any context that cannot answer
 * an interactive prompt (a background job, a fresh headless session, a CI run)
 * silently gets ZERO tools from a correctly-installed, correctly-reachable MCP
 * server, with no error surfaced anywhere. Discovered 2026-07-18 when this
 * project's own `enabledMcpjsonServers` entry was found empty despite
 * `memory-server` being installed, reachable, and correctly configured.
 *
 * FIX: mirror mcp-project-sync.ts's #16728 pattern. On `mcp-server` install for
 * the `claude` host, append `extId` to `enabledMcpjsonServers` for the relevant
 * project root(s) — the just-installed project for a project/local-scope
 * install, or every known project root (install-registry scope guard, same as
 * mcp-project-sync) for a user/org-scope install whose entry propagates to
 * every project's `.mcp.json` anyway. On uninstall, remove exactly the entries
 * sox added, leaving any project a human explicitly trusted through the
 * interactive prompt untouched — [inv:reversible-injection].
 *
 * NOT a blanket trust flag. This appends one specific, named extId — the exact
 * extension the user just ran `soxe install <id> --host=claude` for — not a
 * `enableAllProjectMcpServers`-style bypass of the prompt for arbitrary future
 * servers. Claude-specific: other hosts (OpenCode, Codex) have no equivalent
 * blanket per-server trust gate layered on top of their MCP config file.
 *
 * `~/.claude.json`'s trust array happens to live in the SAME file as Claude's
 * user-scope MCP config (`resolveUserMcpConfigPath('claude')` from
 * mcp-project-sync.ts resolves it), but at a different, per-project-path-keyed
 * location the generic `array-merge` capability's dot-separated keyPath cannot
 * address (a project root is an arbitrary absolute path, not a dot-safe key).
 * Like mcp-project-sync.ts's reversal, this reads/writes the JSON directly.
 */

import * as fs from 'node:fs';
import { ownershipPathFor } from './data-paths.js';
import { resolveUserMcpConfigPath, knownProjectRoots } from './mcp-project-sync.js';
import { OwnershipIndex, type OwnedEntry } from './ownership.js';

// ─── Ownership entry encoding ────────────────────────────────────────────────

/** Prefix distinguishing a trust-array entry from mcp-project-sync's `mcpServers.<extId>`
 *  config-key entries, which share the same `file` (both live in ~/.claude.json). */
const TRUST_KEYPATH_PREFIX = 'trust:';

function trustEntry(claudeJsonPath: string, projectRoot: string): OwnedEntry {
  return { kind: 'config-key', file: claudeJsonPath, keyPath: `${TRUST_KEYPATH_PREFIX}${projectRoot}` };
}

function isTrustEntry(e: OwnedEntry): e is Extract<OwnedEntry, { kind: 'config-key' }> {
  return e.kind === 'config-key' && e.keyPath.startsWith(TRUST_KEYPATH_PREFIX);
}

function projectRootOf(e: Extract<OwnedEntry, { kind: 'config-key' }>): string {
  return e.keyPath.slice(TRUST_KEYPATH_PREFIX.length);
}

// ─── ~/.claude.json shape (only the fields this module touches) ─────────────

interface ClaudeJsonProjects {
  projects?: Record<string, { enabledMcpjsonServers?: unknown }>;
}

function readClaudeJson(claudeJsonPath: string): ClaudeJsonProjects | undefined {
  if (!fs.existsSync(claudeJsonPath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')) as ClaudeJsonProjects;
  } catch {
    return undefined;
  }
}

function writeClaudeJson(claudeJsonPath: string, cfg: ClaudeJsonProjects): void {
  fs.writeFileSync(claudeJsonPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

// ─── Sync (install) ──────────────────────────────────────────────────────────

export interface TrustSyncResult {
  projectRoot: string;
  claudeJsonPath: string;
  action: 'trusted' | 'up-to-date' | 'would-trust' | 'skipped';
  reason?: string;
}

export interface SyncTrustOptions {
  /** The MCP server extId (e.g. "memory-server"). */
  extId: string;
  /** The host to resolve the trust file for (default "claude"; a no-op for any other host). */
  host?: string;
  /** Dry-run: compute + report, but write nothing. */
  dryRun?: boolean;
  /**
   * Explicit target project roots. When omitted, defaults to every known
   * project root (install-registry scope guard — [scope-guard]: never a fs
   * scan) — matching mcp-project-sync's user/org propagation, since a
   * user/org-scope MCP server's `.mcp.json` entry is itself propagated to
   * every known project.
   */
  roots?: string[];
}

/**
 * Ensure `extId` is present in `enabledMcpjsonServers` for each target project
 * root's entry in `~/.claude.json`. A project root Claude Code has never opened
 * (no `projects["<root>"]` entry yet) is skipped, not invented — this only
 * extends trust where Claude already has a stanza to extend it in.
 * Idempotent: a project already carrying the entry is reported `up-to-date`.
 */
export async function syncMcpTrustToProjects(opts: SyncTrustOptions): Promise<TrustSyncResult[]> {
  const host = opts.host ?? 'claude';
  const extId = opts.extId;
  const results: TrustSyncResult[] = [];

  if (host !== 'claude') return results; // trust gate is Claude-specific

  const claudeJsonPath = resolveUserMcpConfigPath(host);
  if (claudeJsonPath === undefined) return results;

  const roots = opts.roots ?? knownProjectRoots();
  if (roots.length === 0) return results;

  const idx = OwnershipIndex.loadFromFile(ownershipPathFor('user'));
  const existing = idx.get(extId, 'user');
  const preservedOther = (existing?.entries ?? []).filter((e) => !isTrustEntry(e));
  const ownedEntries: OwnedEntry[] = [];

  const cfg = readClaudeJson(claudeJsonPath);
  if (cfg === undefined && fs.existsSync(claudeJsonPath)) {
    // Present but unparseable — do not clobber foreign content.
    for (const projectRoot of roots) {
      results.push({ projectRoot, claudeJsonPath, action: 'skipped', reason: 'unparseable ~/.claude.json' });
    }
    return results;
  }
  const projects = cfg?.projects ?? {};

  let dirty = false;
  for (const projectRoot of roots) {
    const projEntry = projects[projectRoot];
    if (projEntry === undefined) {
      // Claude has never seen this project — nothing to extend trust into yet.
      // (It will pick up the entry on a future sync once the project entry exists.)
      results.push({ projectRoot, claudeJsonPath, action: 'skipped', reason: 'no ~/.claude.json project entry yet' });
      continue;
    }
    const arr = Array.isArray(projEntry.enabledMcpjsonServers)
      ? (projEntry.enabledMcpjsonServers as unknown[]).map(String)
      : [];
    if (arr.includes(extId)) {
      results.push({ projectRoot, claudeJsonPath, action: 'up-to-date' });
      ownedEntries.push(trustEntry(claudeJsonPath, projectRoot));
      continue;
    }
    if (opts.dryRun) {
      results.push({ projectRoot, claudeJsonPath, action: 'would-trust' });
      ownedEntries.push(trustEntry(claudeJsonPath, projectRoot));
      continue;
    }
    projEntry.enabledMcpjsonServers = [...arr, extId];
    dirty = true;
    results.push({ projectRoot, claudeJsonPath, action: 'trusted' });
    ownedEntries.push(trustEntry(claudeJsonPath, projectRoot));
  }

  if (!opts.dryRun) {
    if (dirty) writeClaudeJson(claudeJsonPath, cfg ?? { projects });
    const meta = existing?.host !== undefined ? { host: existing.host } : { host };
    idx.record({
      extId,
      scope: 'user',
      ...meta,
      ...(existing?.bundleId !== undefined ? { bundleId: existing.bundleId } : {}),
      ...(existing?.artifactChecksum !== undefined ? { artifactChecksum: existing.artifactChecksum } : {}),
      entries: [...preservedOther, ...ownedEntries],
    });
    idx.save();
  }

  return results;
}

// ─── Reverse (uninstall) ──────────────────────────────────────────────────────

/**
 * Remove `extId` from `enabledMcpjsonServers` for every project root sox
 * granted trust to on install — leaving any entry a human approved through
 * Claude's own interactive prompt (never recorded here) untouched.
 * Returns the list of project roots reversed.
 */
export async function reverseMcpTrustFromProjects(opts: {
  extId: string;
  host?: string;
}): Promise<string[]> {
  const host = opts.host ?? 'claude';
  const extId = opts.extId;
  const reversed: string[] = [];

  if (host !== 'claude') return reversed;

  const idx = OwnershipIndex.loadFromFile(ownershipPathFor('user'));
  const rec = idx.get(extId, 'user');
  if (rec === undefined) return reversed;

  const trustEntries = rec.entries.filter(isTrustEntry);
  if (trustEntries.length === 0) return reversed;

  const claudeJsonPath = resolveUserMcpConfigPath(host);
  if (claudeJsonPath === undefined) return reversed;

  const cfg = readClaudeJson(claudeJsonPath);
  if (cfg?.projects !== undefined) {
    let dirty = false;
    for (const entry of trustEntries) {
      const projectRoot = projectRootOf(entry);
      const projEntry = cfg.projects[projectRoot];
      if (projEntry === undefined) continue;
      const arr = Array.isArray(projEntry.enabledMcpjsonServers)
        ? (projEntry.enabledMcpjsonServers as unknown[]).map(String)
        : [];
      if (!arr.includes(extId)) continue;
      projEntry.enabledMcpjsonServers = arr.filter((v) => v !== extId);
      dirty = true;
      reversed.push(projectRoot);
    }
    if (dirty) writeClaudeJson(claudeJsonPath, cfg);
  }

  const remaining = rec.entries.filter((e) => !isTrustEntry(e));
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
