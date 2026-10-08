/**
 * libs/install-engine/src/lifecycle.spec.ts
 *
 * Unit tests for lifecycle.ts (update/uninstall) and diff.ts.
 *
 * Invariants verified:
 *   [inv:ledger-reversible] — apply→reverse round-trip restores file; foreign keys untouched.
 *   [inv:host-agnostic-type] — no literal host paths appear outside libs/host-registry.
 *   [inv:boundary]          — verification tops out at present+valid (no host exec).
 *   [dod.5]                 — external edit to a ledger-tracked file is reported drifted.
 *   [dod.12]                — capability that cannot cleanly reverse aborts (ReverseAbortError).
 *   [install-lifecycle.2]   — install→diff(+drift)→update→uninstall of a markdown agent on real FS.
 *   [install-lifecycle.5]   — abort path covered.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diff, diffAll } from './diff.js';
import { Ledger } from './ledger.js';
import type { AgentCatalogClient } from './capabilities/agent-catalog.js';
import {
  AmbiguousLegacyUninstallError,
  HostNotInstalledError,
  UninstallAbortedError,
  ReverseAbortError,
  uninstall,
  uninstallOwned,
  update,
} from './lifecycle.js';
import { OwnershipIndex, type OwnedEntry } from './ownership.js';

// ─── Test fixtures ────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-spec-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function sha256OfValue(value: unknown): string {
  const s = JSON.stringify(value);
  return 'sha256:' + crypto.createHash('sha256').update(s).digest('hex');
}

function sha256OfFile(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return 'sha256:' + crypto.createHash('sha256').update(data).digest('hex');
}

// Helper: create a ledger with a file-drop action (with appliedHash)
function makeFileDropLedger(
  file: string,
  appliedHash?: string,
  ext = 'test-agent',
  host = 'claude',
  scope = 'project',
): Ledger {
  const ledger = Ledger.load(tmpDir, { isProject: false });
  ledger.record({
    ext,
    host,
    scope,
    action: { cap: 'file-drop', file, keyPath: '', ...(appliedHash !== undefined ? { appliedHash } : {}) },
  });
  ledger.save();
  return ledger;
}

// Helper: create a ledger with a config-merge action
function makeConfigMergeLedger(
  file: string,
  keyPath: string,
  appliedHash: string,
  ext = 'test-agent',
  host = 'claude',
  scope = 'project',
): Ledger {
  const ledger = Ledger.load(tmpDir, { isProject: false });
  ledger.record({
    ext,
    host,
    scope,
    action: { cap: 'config-merge', file, keyPath, appliedHash },
  });
  ledger.save();
  return ledger;
}

// ─── [install-lifecycle.2] declarative install → diff(+drift) → update → uninstall ────

describe('[install-lifecycle.2] markdown agent lifecycle on real FS', () => {
  it('install places file, diff shows up-to-date, external edit shows drifted, uninstall removes', async () => {
    // Setup: target directory (simulating .claude/agents/ at project scope)
    const agentsDir = path.join(tmpDir, '.claude', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    const agentFile = path.join(agentsDir, 'my-agent.md');

    // 1. "Install" — place the agent file
    const agentContent = '# My Agent\n\nThis is a markdown agent for testing.\n';
    fs.writeFileSync(agentFile, agentContent, 'utf8');

    // Record the file-drop in the ledger WITH appliedHash (simulate what install() does)
    const appliedHash = sha256OfFile(agentFile);
    const ledger = makeFileDropLedger(agentFile, appliedHash, 'my-agent', 'claude', 'project');

    // 2. diff shows up-to-date
    const d1 = diff('my-agent', 'claude', 'project', tmpDir, { ledger });
    expect(d1.clean).toBe(true);
    expect(d1.actions[0]?.kind).toBe('up-to-date');

    // 3. External edit — simulate a drift ([dod.5])
    fs.writeFileSync(agentFile, agentContent + '\n## Drift\nExternally added section.\n', 'utf8');

    // diff now reports drifted
    const d2 = diff('my-agent', 'claude', 'project', tmpDir, { ledger });
    expect(d2.clean).toBe(false);
    expect(d2.actions[0]?.kind).toBe('drifted');

    // 4. Update — restore from a new source
    const newSrcFile = path.join(tmpDir, 'new-agent.md');
    const updatedContent = '# My Agent v2\n\nUpdated content.\n';
    fs.writeFileSync(newSrcFile, updatedContent, 'utf8');

    const updateResult = await update({
      ext: 'my-agent',
      host: 'claude',
      scope: 'project',
      scopeRoot: tmpDir,
      workspaceRoot: tmpDir,
      isProject: false,
      ledger,
      newSrcPath: newSrcFile,
    });
    expect(updateResult.kind).toBe('updated');
    expect(updateResult.actions.length).toBeGreaterThan(0);

    // Verify file was updated on disk
    const onDisk = fs.readFileSync(agentFile, 'utf8');
    expect(onDisk).toBe(updatedContent);

    // 5. Uninstall — removes the file
    await uninstall({
      ext: 'my-agent',
      host: 'claude',
      scope: 'project',
      scopeRoot: tmpDir,
      isProject: false,
      ledger,
    });

    // File must be gone ([inv:ledger-reversible])
    expect(fs.existsSync(agentFile)).toBe(false);

    // Ledger entry must be removed
    const ledger2 = Ledger.load(tmpDir, { isProject: false });
    expect(ledger2.actionsFor('my-agent', 'claude', 'project')).toHaveLength(0);
  });
});

// ─── [inv:ledger-reversible] — config-merge round-trip ───────────────────────

describe('[inv:ledger-reversible] config-merge round-trip', () => {
  it('apply→reverse restores file, foreign keys untouched', async () => {
    const configFile = path.join(tmpDir, 'settings.json');
    const soxValue = { command: 'node', args: ['/path/to/server.js'] };
    const foreign = { foreignKey: 'keep-this', nested: { a: 1 } };

    // Simulate apply: write merged config with soxe value + foreign key
    const merged = { ...foreign, mcpServers: { 'my-server': soxValue } };
    fs.writeFileSync(configFile, JSON.stringify(merged, null, 2) + '\n', 'utf8');

    const hash = sha256OfValue(soxValue);
    const ledger = makeConfigMergeLedger(configFile, 'mcpServers.my-server', hash);

    // diff shows up-to-date
    const d1 = diff('test-agent', 'claude', 'project', tmpDir, { ledger });
    expect(d1.actions[0]?.kind).toBe('up-to-date');

    // Uninstall (reverse)
    await uninstall({ ext: 'test-agent', host: 'claude', scope: 'project', scopeRoot: tmpDir, ledger });

    // Sox-owned key is gone
    const after = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<string, unknown>;
    expect((after['mcpServers'] as Record<string, unknown> | undefined)?.['my-server']).toBeUndefined();

    // Foreign key is still present ([inv:ledger-reversible])
    expect(after['foreignKey']).toBe('keep-this');
    expect((after['nested'] as Record<string, unknown>)?.['a']).toBe(1);
  });
});

// ─── [dod.5] drift detection ──────────────────────────────────────────────────

describe('[dod.5] drift detection — external edit reported as drifted', () => {
  it('external edit to config-merge target shows drifted', () => {
    const configFile = path.join(tmpDir, '.mcp.json');
    const soxValue = { command: 'node', args: ['server.js'] };
    const appliedHash = sha256OfValue(soxValue);

    // Write initial config with soxe value
    fs.writeFileSync(configFile, JSON.stringify({ mcpServers: { 'my-server': soxValue } }, null, 2) + '\n', 'utf8');

    const ledger = makeConfigMergeLedger(configFile, 'mcpServers.my-server', appliedHash);

    // Initially up-to-date
    const d1 = diff('test-agent', 'claude', 'project', tmpDir, { ledger });
    expect(d1.actions[0]?.kind).toBe('up-to-date');

    // External edit — someone changed the server command
    const driftedValue = { command: 'python3', args: ['server.py'] };
    fs.writeFileSync(configFile, JSON.stringify({ mcpServers: { 'my-server': driftedValue } }, null, 2) + '\n', 'utf8');

    // Now shows drifted ([dod.5])
    const d2 = diff('test-agent', 'claude', 'project', tmpDir, { ledger });
    expect(d2.clean).toBe(false);
    expect(d2.actions[0]?.kind).toBe('drifted');
  });

  it('file-drop with recorded hash shows drifted on external edit', () => {
    const agentFile = path.join(tmpDir, 'agent.md');
    const original = '# Agent\nOriginal.\n';
    fs.writeFileSync(agentFile, original, 'utf8');

    const appliedHash = sha256OfFile(agentFile);
    const ledger = makeFileDropLedger(agentFile, appliedHash);

    // Up-to-date
    const d1 = diff('test-agent', 'claude', 'project', tmpDir, { ledger });
    expect(d1.actions[0]?.kind).toBe('up-to-date');

    // External edit
    fs.writeFileSync(agentFile, original + '\n## External addition\n', 'utf8');

    // Drifted ([dod.5])
    const d2 = diff('test-agent', 'claude', 'project', tmpDir, { ledger });
    expect(d2.actions[0]?.kind).toBe('drifted');
  });
});

// ─── [dod.12] abort path ─────────────────────────────────────────────────────

describe('[dod.12] abort path — capability that cannot cleanly reverse throws ReverseAbortError', () => {
  it('materialize capability throws ReverseAbortError on uninstall', async () => {
    const ledger = Ledger.load(tmpDir, { isProject: false });
    ledger.record({
      ext: 'my-ext', host: 'claude', scope: 'project',
      action: { cap: 'materialize', file: '/some/artifact', keyPath: '' },
    });
    ledger.save();

    await expect(
      uninstall({ ext: 'my-ext', host: 'claude', scope: 'project', scopeRoot: tmpDir, ledger }),
    ).rejects.toThrow(ReverseAbortError);
  });

  it('bin-link capability throws ReverseAbortError on uninstall', async () => {
    const ledger = Ledger.load(tmpDir, { isProject: false });
    ledger.record({
      ext: 'my-cmd', host: 'claude', scope: 'project',
      action: { cap: 'bin-link', file: '/usr/local/bin/my-cmd', keyPath: '' },
    });
    ledger.save();

    await expect(
      uninstall({ ext: 'my-cmd', host: 'claude', scope: 'project', scopeRoot: tmpDir, ledger }),
    ).rejects.toThrow(ReverseAbortError);
  });

  it('run-service capability throws ReverseAbortError on uninstall', async () => {
    const ledger = Ledger.load(tmpDir, { isProject: false });
    ledger.record({
      ext: 'my-service', host: 'claude', scope: 'project',
      action: { cap: 'run-service', file: '/path/to/service', keyPath: '' },
    });
    ledger.save();

    await expect(
      uninstall({ ext: 'my-service', host: 'claude', scope: 'project', scopeRoot: tmpDir, ledger }),
    ).rejects.toThrow(ReverseAbortError);
  });

  // [install-lifecycle.5]: abort error message must match grep for abort|cannot.*reverse|reversib
  it('abort error message contains abort/cannot-reverse/reversib keywords ([install-lifecycle.5])', async () => {
    const ledger = Ledger.load(tmpDir, { isProject: false });
    ledger.record({
      ext: 'my-ext', host: 'claude', scope: 'project',
      action: { cap: 'materialize', file: '/some/artifact', keyPath: '' },
    });
    ledger.save();

    let thrown: Error | null = null;
    try {
      await uninstall({ ext: 'my-ext', host: 'claude', scope: 'project', scopeRoot: tmpDir, ledger });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
    // grep -niE 'abort|cannot.*reverse|reversib' — must match
    expect(thrown?.message).toMatch(/abort|cannot.*reverse|reversib/i);
  });
});

// ─── file-drop uninstall ─────────────────────────────────────────────────────

describe('file-drop uninstall', () => {
  it('removes a placed file from disk', async () => {
    const targetFile = path.join(tmpDir, 'dropped-agent.md');
    fs.writeFileSync(targetFile, '# Agent\n', 'utf8');

    const ledger = makeFileDropLedger(targetFile);
    await uninstall({ ext: 'test-agent', host: 'claude', scope: 'project', scopeRoot: tmpDir, ledger });

    expect(fs.existsSync(targetFile)).toBe(false);
  });

  it('is idempotent — no-op if file already gone', async () => {
    const targetFile = path.join(tmpDir, 'already-gone.md');
    // Do NOT create the file — it never exists

    const ledger = makeFileDropLedger(targetFile);
    // Should not throw
    await expect(
      uninstall({ ext: 'test-agent', host: 'claude', scope: 'project', scopeRoot: tmpDir, ledger }),
    ).resolves.not.toThrow();
  });

  it('is a no-op if no ledger entry exists', async () => {
    const ledger = Ledger.load(tmpDir, { isProject: false }); // empty ledger
    await expect(
      uninstall({ ext: 'no-such-ext', host: 'claude', scope: 'project', scopeRoot: tmpDir, ledger }),
    ).resolves.not.toThrow();
  });
});

// ─── config-merge uninstall ───────────────────────────────────────────────────

describe('config-merge uninstall [inv:ledger-reversible]', () => {
  it('removes only sox-owned keyPath; foreign keys preserved', async () => {
    const configFile = path.join(tmpDir, 'settings.json');
    const original = {
      foreignKey: 'stay',
      mcpServers: {
        'my-server': { command: 'node' },
        'other-server': { command: 'python' },
      },
    };
    fs.writeFileSync(configFile, JSON.stringify(original, null, 2) + '\n', 'utf8');

    const ledger = Ledger.load(tmpDir, { isProject: false });
    ledger.record({
      ext: 'my-server',
      host: 'claude',
      scope: 'project',
      action: { cap: 'config-merge', file: configFile, keyPath: 'mcpServers.my-server', appliedHash: 'sha256:abc' },
    });
    ledger.save();

    await uninstall({ ext: 'my-server', host: 'claude', scope: 'project', scopeRoot: tmpDir, ledger });

    const after = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<string, unknown>;
    // Sox-owned key gone
    expect((after['mcpServers'] as Record<string, unknown>)?.['my-server']).toBeUndefined();
    // Foreign key stays ([inv:ledger-reversible])
    expect(after['foreignKey']).toBe('stay');
    // Other server key stays
    expect((after['mcpServers'] as Record<string, unknown>)?.['other-server']).toBeDefined();
  });
});

// ─── diff missing ─────────────────────────────────────────────────────────────

describe('diff missing', () => {
  it('reports missing when target file does not exist', () => {
    const missingFile = path.join(tmpDir, 'nonexistent.md');
    const ledger = makeFileDropLedger(missingFile, 'sha256:abc');
    const result = diff('test-agent', 'claude', 'project', tmpDir, { ledger });
    expect(result.actions[0]?.kind).toBe('missing');
    expect(result.clean).toBe(false);
  });
});

// ─── diffAll ─────────────────────────────────────────────────────────────────

describe('diffAll', () => {
  it('returns diffs for all ledger entries', () => {
    const f1 = path.join(tmpDir, 'a.md');
    const f2 = path.join(tmpDir, 'b.md');
    fs.writeFileSync(f1, '# A\n', 'utf8');
    // f2 does not exist — will be missing

    const hash1 = sha256OfFile(f1);

    const ledger = Ledger.load(tmpDir, { isProject: false });
    ledger.record({ ext: 'agent-a', host: 'claude', scope: 'project', action: { cap: 'file-drop', file: f1, keyPath: '', appliedHash: hash1 } });
    ledger.record({ ext: 'agent-b', host: 'claude', scope: 'project', action: { cap: 'file-drop', file: f2, keyPath: '', appliedHash: 'sha256:abc' } });
    ledger.save();

    const results = diffAll(tmpDir, { ledger });
    expect(results).toHaveLength(2);
    const a = results.find((r) => r.ext === 'agent-a');
    const b = results.find((r) => r.ext === 'agent-b');
    expect(a?.clean).toBe(true);
    expect(b?.clean).toBe(false);
    expect(b?.actions[0]?.kind).toBe('missing');
  });
});

// ─── update file-drop ────────────────────────────────────────────────────────

describe('update file-drop', () => {
  it('copies new source to target when content changed', async () => {
    const targetFile = path.join(tmpDir, 'agent.md');
    fs.writeFileSync(targetFile, '# Old\n', 'utf8');

    const ledger = makeFileDropLedger(targetFile);
    const newSrc = path.join(tmpDir, 'agent-new.md');
    fs.writeFileSync(newSrc, '# New\n', 'utf8');

    const result = await update({
      ext: 'test-agent', host: 'claude', scope: 'project', scopeRoot: tmpDir,
      workspaceRoot: tmpDir, isProject: false, ledger,
      newSrcPath: newSrc,
    });

    expect(result.kind).toBe('updated');
    expect(fs.readFileSync(targetFile, 'utf8')).toBe('# New\n');
  });

  it('returns kind=none when source matches target (idempotent)', async () => {
    const targetFile = path.join(tmpDir, 'agent.md');
    const content = '# Same\n';
    fs.writeFileSync(targetFile, content, 'utf8');

    const ledger = makeFileDropLedger(targetFile);
    const srcFile = path.join(tmpDir, 'agent-src.md');
    fs.writeFileSync(srcFile, content, 'utf8'); // identical content

    const result = await update({
      ext: 'test-agent', host: 'claude', scope: 'project', scopeRoot: tmpDir,
      workspaceRoot: tmpDir, isProject: false, ledger,
      newSrcPath: srcFile,
    });

    expect(result.kind).toBe('none');
  });
});

// ─── e46db6ed — host-attributed uninstall (uninstallOwned / planOwnedUninstall) ──────
//
// Unit scope: Ledger + OwnershipIndex on a temp dir, an injected fake catalog client.
// No process is spawned and nothing touches the network or the real data root.

describe('e46db6ed — uninstall --host H reverses only H', () => {
  type Kind = 'skill' | 'agent';
  let ws: string; // workspace root (project scope) / fake HOME (user scope)
  let dataDir: string;
  let deletes: string[];
  let client: AgentCatalogClient;

  beforeEach(() => {
    ws = path.join(tmpDir, 'ws');
    dataDir = path.join(ws, '.sox');
    fs.mkdirSync(dataDir, { recursive: true });
    deletes = [];
    client = {
      upsert: async () => {
        throw new Error('upsert must not be called by uninstall');
      },
      read: async () => null,
      delete: async (name: string) => {
        deletes.push(name);
      },
    };
  });

  const ownFile = (): string => path.join(dataDir, 'ownership.json');
  const hostPath = (host: string, ext: string, kind: Kind): string =>
    kind === 'agent'
      ? path.join(ws, `.${host}`, 'agents', `${ext}.md`)
      : path.join(ws, `.${host}`, 'skills', ext, 'SKILL.md');

  /**
   * Seed what a real install of `ext` on `hosts` leaves behind: the placed file, a
   * ledger file-drop action (repo-relative at project scope), and a host-stamped
   * ownership entry. `agent-mcp` gets a catalog row instead of a file.
   */
  function seed(opts: {
    ext: string;
    hosts: string[];
    scope: 'project' | 'user';
    kind?: Kind;
    stamp?: boolean;
    extra?: OwnedEntry[];
  }): void {
    const kind = opts.kind ?? 'skill';
    const isProject = opts.scope === 'project';
    const ledger = Ledger.load(dataDir, { isProject });
    const own = OwnershipIndex.loadFromFile(ownFile());
    for (const host of opts.hosts) {
      if (host === 'agent-mcp') {
        ledger.record({
          ext: opts.ext,
          host,
          scope: opts.scope,
          action: { cap: 'agent-catalog', file: 'agent-mcp:catalog', keyPath: '', meta: { rowName: `${opts.ext}-row` } },
        });
        own.addEntries(opts.ext, opts.scope, [
          { kind: 'agent-catalog', name: opts.ext, ...(opts.stamp === false ? {} : { host }) },
        ], { host });
        continue;
      }
      const p = hostPath(host, opts.ext, kind);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, `${host} ${opts.ext}\n`);
      ledger.record({
        ext: opts.ext,
        host,
        scope: opts.scope,
        action: { cap: 'file-drop', file: isProject ? path.relative(ws, p) : p, keyPath: '', appliedHash: 'sha256:x' },
      });
      own.addEntries(opts.ext, opts.scope, [
        { kind: 'file-drop', path: p, ...(opts.stamp === false ? {} : { host }) },
      ], { host });
    }
    if (opts.extra) own.addEntries(opts.ext, opts.scope, opts.extra);
    ledger.save();
    own.save();
  }

  const run = (ext: string, scope: 'project' | 'user', host?: string) =>
    uninstallOwned({
      ext,
      scope,
      dataDir,
      workspaceRoot: ws,
      isProject: scope === 'project',
      ownership: OwnershipIndex.loadFromFile(ownFile()),
      catalogClient: client,
      ...(host !== undefined ? { host } : {}),
    });

  const ledgerHostsOf = (ext: string): string[] =>
    Ledger.load(dataDir).entries().filter((e) => e.ext === ext).map((e) => e.host).sort();
  const record = (ext: string, scope: string) => OwnershipIndex.loadFromFile(ownFile()).get(ext, scope);

  it('e46db6ed AC1 — project agent on claude,opencode,agent-mcp: one catalog delete, nothing left', async () => {
    seed({ ext: 'reviewer', hosts: ['claude', 'opencode', 'agent-mcp'], scope: 'project', kind: 'agent' });
    const paths = [hostPath('claude', 'reviewer', 'agent'), hostPath('opencode', 'reviewer', 'agent')];
    for (const p of paths) expect(fs.existsSync(p)).toBe(true);

    const r = await run('reviewer', 'project');

    expect(deletes).toEqual(['reviewer-row']);
    expect(ledgerHostsOf('reviewer')).toEqual([]);
    expect(record('reviewer', 'project')).toBeUndefined();
    for (const p of paths) expect(fs.existsSync(p)).toBe(false);
    expect(r.full).toBe(true);
  });

  it('e46db6ed AC2 — a repeat uninstall finds nothing and deletes no catalog row again', async () => {
    seed({ ext: 'reviewer', hosts: ['claude', 'opencode', 'agent-mcp'], scope: 'project', kind: 'agent' });
    await run('reviewer', 'project');
    deletes.length = 0;

    const again = await run('reviewer', 'project');

    expect(deletes).toEqual([]);
    expect(again.hostsRemoved).toEqual([]);
    expect(again.removedPaths).toEqual([]);
  });

  it('e46db6ed AC3 — skill on claude+opencode: --host opencode removes only opencode', async () => {
    seed({ ext: 'tui', hosts: ['claude', 'opencode'], scope: 'user' });
    const claudeP = hostPath('claude', 'tui', 'skill');
    const openP = hostPath('opencode', 'tui', 'skill');

    const r = await run('tui', 'user', 'opencode');

    expect(fs.existsSync(openP)).toBe(false);
    expect(fs.existsSync(claudeP)).toBe(true);
    expect(ledgerHostsOf('tui')).toEqual(['claude']);
    const rec = record('tui', 'user');
    expect(rec?.entries.map((e) => (e.kind === 'file-drop' ? e.path : ''))).toEqual([claudeP]);
    expect(r.hostsRemoved).toEqual(['opencode']);
    expect(r.full).toBe(false);
    expect(r.remainingHosts).toEqual(['claude']);
  });

  it('e46db6ed AC4 — the last --host takes the ownership record and ledger with it', async () => {
    seed({ ext: 'tui', hosts: ['claude', 'opencode'], scope: 'user' });
    await run('tui', 'user', 'opencode');
    expect(fs.existsSync(hostPath('claude', 'tui', 'skill'))).toBe(true);
    expect(record('tui', 'user')).toBeDefined();

    const r = await run('tui', 'user', 'claude');

    expect(fs.existsSync(hostPath('claude', 'tui', 'skill'))).toBe(false);
    expect(ledgerHostsOf('tui')).toEqual([]);
    expect(record('tui', 'user')).toBeUndefined();
    expect(r.full).toBe(true);
    expect(r.remainingHosts).toEqual([]);
  });

  it('e46db6ed AC5 — --host never installed throws and touches nothing', async () => {
    seed({ ext: 'tui', hosts: ['claude', 'opencode'], scope: 'user' });
    const before = [fs.readFileSync(ownFile(), 'utf8'), fs.readFileSync(path.join(dataDir, 'ledger.json'), 'utf8')];

    await expect(run('tui', 'user', 'codex')).rejects.toBeInstanceOf(HostNotInstalledError);

    expect(fs.readFileSync(ownFile(), 'utf8')).toBe(before[0]);
    expect(fs.readFileSync(path.join(dataDir, 'ledger.json'), 'utf8')).toBe(before[1]);
    expect(fs.existsSync(hostPath('claude', 'tui', 'skill'))).toBe(true);
    expect(fs.existsSync(hostPath('opencode', 'tui', 'skill'))).toBe(true);
    expect(deletes).toEqual([]);
  });

  it('e46db6ed AC6 — no --host removes every host and reports them all', async () => {
    seed({ ext: 'tui', hosts: ['claude', 'opencode', 'agent-mcp'], scope: 'user' });

    const r = await run('tui', 'user');

    expect(r.hostsRemoved).toEqual(['agent-mcp', 'claude', 'opencode']);
    expect(r.full).toBe(true);
    expect(deletes).toEqual(['tui-row']);
  });

  it.each([
    ['claude', 'opencode'],
    ['opencode', 'claude'],
  ])('e46db6ed AC7 — install %s then %s: per-host removals preserve foreign keys, record goes last', async (first, second) => {
    // A shared host config per host, each with a foreign key beside sox's.
    const cfg = (h: string): string => path.join(ws, `.${h}`, 'settings.json');
    const entries: OwnedEntry[] = [];
    const ledger = Ledger.load(dataDir);
    for (const h of [first, second]) {
      fs.mkdirSync(path.dirname(cfg(h)), { recursive: true });
      fs.writeFileSync(cfg(h), JSON.stringify({ foreign: h, mcpServers: { svc: { command: 'x' } } }));
      ledger.record({
        ext: 'svc',
        host: h,
        scope: 'user',
        action: { cap: 'config-merge', file: cfg(h), keyPath: 'mcpServers.svc', appliedHash: 'sha256:x' },
      });
      entries.push({ kind: 'config-key', file: cfg(h), keyPath: 'mcpServers.svc', host: h });
    }
    ledger.save();
    const own = OwnershipIndex.loadFromFile(ownFile());
    // Install order decides the (informational) record-level host; it must not matter.
    own.addEntries('svc', 'user', [entries[0]!], { host: first });
    own.addEntries('svc', 'user', [entries[1]!], { host: second });
    own.save();
    const read = (h: string): Record<string, unknown> => JSON.parse(fs.readFileSync(cfg(h), 'utf8')) as Record<string, unknown>;

    const r1 = await run('svc', 'user', 'claude');
    expect(r1.full).toBe(false);
    expect(read('claude')).toEqual({ foreign: 'claude', mcpServers: {} });
    expect(read('opencode')).toEqual({ foreign: 'opencode', mcpServers: { svc: { command: 'x' } } });
    expect(record('svc', 'user')).toBeDefined();

    const r2 = await run('svc', 'user', 'opencode');
    expect(r2.full).toBe(true);
    expect(read('opencode')).toEqual({ foreign: 'opencode', mcpServers: {} });
    expect(record('svc', 'user')).toBeUndefined();
    expect(ledgerHostsOf('svc')).toEqual([]);
  });

  it('e46db6ed AC7 — a stale last-writer record host is never used for attribution', async () => {
    seed({ ext: 'tui', hosts: ['claude', 'opencode'], scope: 'user' });
    // addEntries left record.host = 'opencode' (last writer). Removing claude must not read it.
    expect(record('tui', 'user')?.host).toBe('opencode');

    await run('tui', 'user', 'claude');

    expect(fs.existsSync(hostPath('claude', 'tui', 'skill'))).toBe(false);
    expect(fs.existsSync(hostPath('opencode', 'tui', 'skill'))).toBe(true);
  });

  it('e46db6ed AC8 — legacy host-less record: --host attributes by exact ledger path, never another host', async () => {
    seed({ ext: 'tui', hosts: ['claude', 'opencode'], scope: 'project', stamp: false });
    expect(record('tui', 'project')?.entries.every((e) => e.kind !== 'file-drop' || e.host === undefined)).toBe(true);

    const r = await run('tui', 'project', 'claude');

    expect(fs.existsSync(hostPath('claude', 'tui', 'skill'))).toBe(false);
    expect(fs.existsSync(hostPath('opencode', 'tui', 'skill'))).toBe(true);
    expect(r.full).toBe(false);
    expect(ledgerHostsOf('tui')).toEqual(['opencode']);
    expect(record('tui', 'project')?.entries).toHaveLength(1);
  });

  it('e46db6ed AC8 — legacy entry no ledger claims: refuse, name the all-hosts form, touch nothing', async () => {
    seed({
      ext: 'tui',
      hosts: ['claude', 'opencode'],
      scope: 'user',
      stamp: false,
      extra: [{ kind: 'file-drop', path: path.join(ws, 'mystery', 'tui') }],
    });
    fs.mkdirSync(path.join(ws, 'mystery'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'mystery', 'tui'), 'x');
    const before = fs.readFileSync(ownFile(), 'utf8');

    const err = await run('tui', 'user', 'claude').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AmbiguousLegacyUninstallError);
    expect((err as Error).message).toContain('soxe uninstall tui -s user');
    expect(fs.readFileSync(ownFile(), 'utf8')).toBe(before);
    expect(fs.existsSync(hostPath('claude', 'tui', 'skill'))).toBe(true);
    expect(fs.existsSync(path.join(ws, 'mystery', 'tui'))).toBe(true);

    // The named all-hosts form works and removes the unattributed entry too.
    const all = await run('tui', 'user');
    expect(all.full).toBe(true);
    expect(fs.existsSync(path.join(ws, 'mystery', 'tui'))).toBe(false);
  });

  it('host-independent entries (materialize, propagation) wait for the last host; os-unit hook runs once, last', async () => {
    const store = path.join(ws, 'ext', 'svc');
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(store, 'index.js'), '1');
    seed({
      ext: 'svc',
      hosts: ['claude', 'opencode'],
      scope: 'user',
      extra: [
        { kind: 'materialize', path: store },
        { kind: 'config-key', file: path.join(ws, 'proj', '.mcp.json'), keyPath: 'mcpServers.svc' },
        { kind: 'os-unit', label: 'svc.unit', unitPath: '/x/svc.plist', supervisor: 'launchd', appliedHash: 'h' },
      ],
    });
    const seen: string[][] = [];
    const withHook = (host?: string) =>
      uninstallOwned({
        ext: 'svc',
        scope: 'user',
        dataDir,
        workspaceRoot: ws,
        isProject: false,
        ownership: OwnershipIndex.loadFromFile(ownFile()),
        catalogClient: client,
        reverseHostIndependent: async (es) => {
          seen.push(es.map((e) => e.kind));
        },
        ...(host !== undefined ? { host } : {}),
      });

    await withHook('claude');
    expect(fs.existsSync(store)).toBe(true);
    expect(seen).toEqual([]);
    expect(record('svc', 'user')?.entries.map((e) => e.kind).sort()).toEqual(
      ['config-key', 'file-drop', 'materialize', 'os-unit'],
    );

    await withHook('opencode');
    expect(fs.existsSync(store)).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('os-unit');
    expect(record('svc', 'user')).toBeUndefined();
  });

  // ── e46db6ed static-review corrections (B1) ────────────────────────────────────────

  it.each([
    ['claude', 'opencode', 'claude', 'opencode'],
    ['claude', 'opencode', 'opencode', 'claude'],
    ['opencode', 'claude', 'claude', 'opencode'],
    ['opencode', 'claude', 'opencode', 'claude'],
  ])(
    'e46db6ed AC7 — shared path, installed %s then %s, removed %s then %s: survives until the last host',
    async (installFirst, installSecond, removeFirst, removeSecond) => {
      const shared = path.join(ws, '.shared', 'skills', 'tui', 'SKILL.md');
      fs.mkdirSync(path.dirname(shared), { recursive: true });
      fs.writeFileSync(shared, 'shared\n');
      const own = OwnershipIndex.loadFromFile(ownFile());
      const ledger = Ledger.load(dataDir, { isProject: true });
      for (const h of [installFirst, installSecond]) {
        const unique = hostPath(h, 'tui', 'skill');
        fs.mkdirSync(path.dirname(unique), { recursive: true });
        fs.writeFileSync(unique, `${h}\n`);
        for (const f of [shared, unique]) {
          ledger.record({
            ext: 'tui', host: h, scope: 'project',
            action: { cap: 'file-drop', file: path.relative(ws, f), keyPath: '', appliedHash: 'sha256:x' },
          });
        }
        // Same path on two hosts collapses into ONE entry (host is not in the dedupe
        // key): whichever host installs last holds the stamp.
        own.addEntries('tui', 'project', [
          { kind: 'file-drop', path: shared, host: h },
          { kind: 'file-drop', path: unique, host: h },
        ], { host: h });
      }
      ledger.save();
      own.save();
      expect(record('tui', 'project')?.entries.filter((e) => e.kind === 'file-drop' && e.path === shared)).toHaveLength(1);

      const r1 = await run('tui', 'project', removeFirst);

      expect(r1.full).toBe(false);
      expect(r1.remainingHosts).toEqual([removeSecond]);
      expect(fs.existsSync(shared)).toBe(true); // still claimed by removeSecond
      expect(fs.existsSync(hostPath(removeFirst, 'tui', 'skill'))).toBe(false);
      expect(fs.existsSync(hostPath(removeSecond, 'tui', 'skill'))).toBe(true);
      expect(ledgerHostsOf('tui')).toEqual([removeSecond]);
      // The entry never names a host that is gone, whichever order the hosts installed in.
      expect(record('tui', 'project')?.entries.map((e) => (e.kind === 'file-drop' ? [e.path, e.host] : []))).toEqual(
        expect.arrayContaining([[shared, removeSecond], [hostPath(removeSecond, 'tui', 'skill'), removeSecond]]),
      );

      const r2 = await run('tui', 'project', removeSecond);

      expect(r2.full).toBe(true);
      expect(fs.existsSync(shared)).toBe(false);
      expect(fs.existsSync(hostPath(removeSecond, 'tui', 'skill'))).toBe(false);
      expect(ledgerHostsOf('tui')).toEqual([]);
      expect(record('tui', 'project')).toBeUndefined();
    },
  );

  it('e46db6ed AC7 — a config key two hosts both merged is reversed only by the last host', async () => {
    const cfg = path.join(ws, '.shared', 'settings.json');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, JSON.stringify({ foreign: 1, mcpServers: { svc: { command: 'x' } } }));
    const ledger = Ledger.load(dataDir, { isProject: true });
    const own = OwnershipIndex.loadFromFile(ownFile());
    for (const h of ['claude', 'opencode']) {
      ledger.record({
        ext: 'svc', host: h, scope: 'project',
        action: { cap: 'config-merge', file: path.relative(ws, cfg), keyPath: 'mcpServers.svc', appliedHash: 'sha256:x' },
      });
      own.addEntries('svc', 'project', [{ kind: 'config-key', file: cfg, keyPath: 'mcpServers.svc', host: h }], { host: h });
    }
    ledger.save();
    own.save();
    const read = (): Record<string, unknown> => JSON.parse(fs.readFileSync(cfg, 'utf8')) as Record<string, unknown>;

    await run('svc', 'project', 'opencode'); // the stamp holder goes first

    expect(read()).toEqual({ foreign: 1, mcpServers: { svc: { command: 'x' } } });
    await run('svc', 'project', 'claude');
    expect(read()).toEqual({ foreign: 1, mcpServers: {} });
    expect(record('svc', 'project')).toBeUndefined();
  });

  describe.each([
    { first: 'claude', second: 'opencode' },
    { first: 'opencode', second: 'claude' },
  ])('e46db6ed AC7 — a target owned by another host ONLY via its stamp (remove $first, then $second)', ({ first, second }) => {
    function seedStampOnly(): { shared: string; cfg: string; arr: string } {
      seed({ ext: 'tui', hosts: ['claude', 'opencode'], scope: 'project' });
      const shared = path.join(ws, '.shared', 'tui.md');
      const cfg = path.join(ws, '.shared', 'settings.json');
      const arr = path.join(ws, '.shared', 'perm.json');
      fs.mkdirSync(path.dirname(shared), { recursive: true });
      fs.writeFileSync(shared, 'shared\n');
      fs.writeFileSync(cfg, JSON.stringify({ foreign: 1, mcpServers: { tui: { command: 'x' } } }));
      fs.writeFileSync(arr, JSON.stringify({ allow: ['keep', 'a'] }));
      // Only CLAUDE has ledger actions for these targets; the sole evidence that
      // OPENCODE owns them is the ownership stamp.
      const ledger = Ledger.load(dataDir, { isProject: true });
      ledger.record({ ext: 'tui', host: 'claude', scope: 'project',
        action: { cap: 'file-drop', file: path.relative(ws, shared), keyPath: '', appliedHash: 'sha256:x' } });
      ledger.record({ ext: 'tui', host: 'claude', scope: 'project',
        action: { cap: 'config-merge', file: path.relative(ws, cfg), keyPath: 'mcpServers.tui', appliedHash: 'sha256:x' } });
      ledger.record({ ext: 'tui', host: 'claude', scope: 'project',
        action: { cap: 'array-merge', file: path.relative(ws, arr), keyPath: 'allow', values: ['a'], appliedHash: 'sha256:x' } });
      ledger.save();
      const own = OwnershipIndex.loadFromFile(ownFile());
      own.addEntries('tui', 'project', [
        { kind: 'file-drop', path: shared, host: 'opencode' },
        { kind: 'config-key', file: cfg, keyPath: 'mcpServers.tui', host: 'opencode' },
        { kind: 'array-values', file: arr, keyPath: 'allow', values: ['a'], host: 'opencode' },
      ], { host: 'opencode' });
      own.save();
      return { shared, cfg, arr };
    }
    const readJson = (f: string): unknown => JSON.parse(fs.readFileSync(f, 'utf8'));

    it('is never reversed by the other host, and goes when its stamped owner and the claimant are both gone', async () => {
      const { shared, cfg, arr } = seedStampOnly();

      await run('tui', 'project', first);

      expect(fs.existsSync(shared)).toBe(true);
      expect(readJson(cfg)).toEqual({ foreign: 1, mcpServers: { tui: { command: 'x' } } });
      expect(readJson(arr)).toEqual({ allow: ['keep', 'a'] });

      const r2 = await run('tui', 'project', second);

      expect(r2.full).toBe(true);
      expect(fs.existsSync(shared)).toBe(false);
      expect(readJson(cfg)).toEqual({ foreign: 1, mcpServers: {} });
      expect(readJson(arr)).toEqual({ allow: ['keep'] });
      expect(record('tui', 'project')).toBeUndefined();
    });
  });

  it('e46db6ed AC7 — hosts appending DIFFERENT array values to one key each remove only their own', async () => {
    const cfg = path.join(ws, '.shared', 'perm.json');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, JSON.stringify({ allow: ['keep', 'a', 'b'] }));
    const ledger = Ledger.load(dataDir, { isProject: true });
    for (const [h, v] of [['claude', 'a'], ['opencode', 'b']] as const) {
      ledger.record({
        ext: 'svc', host: h, scope: 'project',
        action: { cap: 'array-merge', file: path.relative(ws, cfg), keyPath: 'allow', values: [v], appliedHash: 'sha256:x' },
      });
    }
    ledger.save();

    await run('svc', 'project', 'claude');

    expect((JSON.parse(fs.readFileSync(cfg, 'utf8')) as { allow: string[] }).allow).toEqual(['keep', 'b']);
  });

  it('e46db6ed AC2 — a project-scope LEDGER-ONLY file-drop (no ownership entry) is deleted from the workspace root', async () => {
    const p = hostPath('claude', 'orphan', 'skill');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x');
    const ledger = Ledger.load(dataDir, { isProject: true });
    ledger.record({
      ext: 'orphan', host: 'claude', scope: 'project',
      action: { cap: 'file-drop', file: path.relative(ws, p), keyPath: '', appliedHash: 'sha256:x' },
    });
    ledger.save();
    expect(record('orphan', 'project')).toBeUndefined();

    const r = await run('orphan', 'project', 'claude');

    expect(fs.existsSync(p)).toBe(false);
    expect(r.hostsRemoved).toEqual(['claude']);
    expect(ledgerHostsOf('orphan')).toEqual([]);
  });

  it('e46db6ed AC1 — host 2 aborting reports what host 1 already reversed and persists host 1 progress', async () => {
    seed({ ext: 'tui', hosts: ['claude', 'opencode'], scope: 'project' });
    const ledger = Ledger.load(dataDir, { isProject: true });
    ledger.record({
      ext: 'tui', host: 'opencode', scope: 'project',
      action: { cap: 'bin-link', file: 'bin/tui', keyPath: '', appliedHash: 'sha256:x' },
    });
    ledger.save();

    const err = await run('tui', 'project').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UninstallAbortedError);
    const aborted = err as UninstallAbortedError;
    expect(aborted.failedHost).toBe('opencode');
    expect(aborted.hostsReversed).toEqual(['claude']);
    expect(aborted.removedPaths).toEqual([hostPath('claude', 'tui', 'skill')]);
    expect(aborted.message).toContain('Already reversed: hosts [claude]');
    // claude is gone from BOTH stores; opencode (the failed host) is fully intact in both.
    expect(ledgerHostsOf('tui')).toEqual(['opencode']);
    expect(fs.existsSync(hostPath('claude', 'tui', 'skill'))).toBe(false);
    expect(fs.existsSync(hostPath('opencode', 'tui', 'skill'))).toBe(true);
    expect(record('tui', 'project')?.entries.map((e) => (e.kind === 'file-drop' ? e.host : ''))).toEqual(['opencode']);
  });

  it('e46db6ed AC6 — hostsRemoved lists only hosts actually reversed (no rec.host fallback)', async () => {
    const store = path.join(ws, 'ext', 'svc');
    fs.mkdirSync(store, { recursive: true });
    const own = OwnershipIndex.loadFromFile(ownFile());
    // Host-independent entry only: no ledger, nothing host-bearing; record.host is just informational.
    own.addEntries('svc', 'user', [{ kind: 'materialize', path: store }], { host: 'claude' });
    own.save();

    const r = await run('svc', 'user');

    expect(r.hostsRemoved).toEqual([]);
    expect(r.full).toBe(true);
    expect(fs.existsSync(store)).toBe(false);
  });

  it('e46db6ed AC8 — an agent-catalog action without rowName claims only the entry named after the ext id', async () => {
    const ledger = Ledger.load(dataDir, { isProject: false });
    ledger.record({
      ext: 'tui', host: 'agent-mcp', scope: 'user',
      action: { cap: 'agent-catalog', file: 'agent-mcp:catalog', keyPath: '' },
    });
    ledger.save();
    const own = OwnershipIndex.loadFromFile(ownFile());
    own.addEntries('tui', 'user', [{ kind: 'agent-catalog', name: 'some-other-row' }], { host: 'claude' });
    own.save();
    // The legacy entry is NOT the row that action retires (it would retire 'tui'): nobody owns it.
    const refused = await run('tui', 'user', 'agent-mcp').catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(AmbiguousLegacyUninstallError);
    expect(deletes).toEqual([]);

    // The entry named after the ext id IS the one that action reverses.
    const own2 = OwnershipIndex.loadFromFile(ownFile());
    own2.remove('tui', 'user');
    own2.addEntries('tui', 'user', [{ kind: 'agent-catalog', name: 'tui' }], { host: 'claude' });
    own2.save();
    const ok = await run('tui', 'user', 'agent-mcp');
    expect(deletes).toEqual(['tui']);
    expect(ok.hostsRemoved).toEqual(['agent-mcp']);
  });

  it('e46db6ed AC1 — a failing OS-unit teardown reports what was reversed and a retry finishes idempotently', async () => {
    seed({
      ext: 'svc',
      hosts: ['claude', 'opencode'],
      scope: 'user',
      extra: [{ kind: 'os-unit', label: 'svc.unit', unitPath: '/x/svc.plist', supervisor: 'launchd', appliedHash: 'h' }],
    });
    let teardown = 0;
    const attempt = () =>
      uninstallOwned({
        ext: 'svc', scope: 'user', dataDir, workspaceRoot: ws, isProject: false,
        ownership: OwnershipIndex.loadFromFile(ownFile()),
        catalogClient: client,
        reverseHostIndependent: async () => {
          teardown++;
          if (teardown === 1) throw new Error('launchctl unload failed');
        },
      });

    const err = await attempt().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UninstallAbortedError);
    expect((err as UninstallAbortedError).stage).toBe('host-independent-teardown');
    expect((err as Error).message).toContain('launchctl unload failed');
    expect((err as UninstallAbortedError).hostsReversed).toEqual(['claude', 'opencode']);
    // Ledger and host files are gone; the record keeps ONLY what teardown still has to do.
    expect(ledgerHostsOf('svc')).toEqual([]);
    expect(fs.existsSync(hostPath('claude', 'svc', 'skill'))).toBe(false);
    expect(record('svc', 'user')?.entries.map((e) => e.kind)).toEqual(['os-unit']);

    const retry = await attempt();

    expect(teardown).toBe(2);
    expect(retry.full).toBe(true);
    expect(record('svc', 'user')).toBeUndefined();
  });

  it('install stamps OwnedEntry.host and a re-install replaces a legacy host-less entry', () => {
    const own = OwnershipIndex.loadFromFile(ownFile());
    own.addEntries('tui', 'user', [{ kind: 'file-drop', path: '/p' }]);
    own.addEntries('tui', 'user', [{ kind: 'file-drop', path: '/p', host: 'claude' }]);
    own.save();
    expect(record('tui', 'user')?.entries).toEqual([{ kind: 'file-drop', path: '/p', host: 'claude' }]);
  });
});
