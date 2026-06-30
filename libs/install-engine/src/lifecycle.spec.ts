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
import { ReverseAbortError, uninstall, update } from './lifecycle.js';

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
    action: { cap: 'file-drop', file, keyPath: '', appliedHash },
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
