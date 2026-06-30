/**
 * libs/install-engine/src/capabilities/capabilities.spec.ts
 *
 * Unit tests for all six capabilities + ledger.
 *
 * Covers:
 *   [capability-engine.1] All six capabilities export apply/reverse/update/verify
 *   [capability-engine.2] config-merge is format-aware (json AND toml round-trips)
 *   [capability-engine.3] config-merge/array-merge record ledger actions; reverse is exact
 *   [capability-engine.4] ledger.ts exists; project ledger paths are repo-relative
 *   [capability-engine.5] Capabilities are idempotent (double-apply == single-apply)
 *
 * Each capability is exercised with apply→verify→reverse round-trips in a temp dir.
 * Foreign-key-survives case is tested for both config-merge and array-merge.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Ledger, sha256 } from '../ledger.js';
import * as arrayMerge from './array-merge.js';
import * as binLink from './bin-link.js';
import * as configMerge from './config-merge.js';
import * as fileDrop from './file-drop.js';
import * as materialize from './materialize.js';
import * as runService from './run-service.js';

// --- Test helpers ---

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sox-cap-test-'));
}

function rmrf(p: string): void {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ============================================================================
// Ledger tests
// ============================================================================

describe('ledger — [capability-engine.4]', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => rmrf(dir));

  it('creates a new ledger file on save()', () => {
    const ledger = Ledger.load(dir);
    ledger.record({
      ext: 'my-ext@1.0.0',
      host: 'claude',
      scope: 'project',
      action: { cap: 'config-merge', file: '.claude/settings.json', keyPath: 'mcpServers.x', appliedHash: 'sha256:abc' },
    });
    ledger.save();
    // ADR-0004 §D2: Ledger.load(dataDir) writes <dataDir>/ledger.json directly
    // (the caller passes the already-resolved data dir; no extra .soxe subdir).
    expect(fs.existsSync(path.join(dir, 'ledger.json'))).toBe(true);
  });

  it('records and retrieves actions', () => {
    const ledger = Ledger.load(dir);
    ledger.record({ ext: 'ext@1', host: 'claude', scope: 'project', action: { cap: 'config-merge', file: 'settings.json', keyPath: 'a.b', appliedHash: 'sha256:x' } });
    ledger.save();

    const l2 = Ledger.load(dir);
    const actions = l2.actionsFor('ext@1', 'claude', 'project');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ cap: 'config-merge', keyPath: 'a.b' });
  });

  it('remove() clears the entry', () => {
    const ledger = Ledger.load(dir);
    ledger.record({ ext: 'ext@1', host: 'claude', scope: 'project', action: { cap: 'array-merge', file: 'settings.json', keyPath: 'arr', values: ['v1'] } });
    ledger.save();
    ledger.remove('ext@1', 'claude', 'project');
    ledger.save();

    const l2 = Ledger.load(dir);
    expect(l2.actionsFor('ext@1', 'claude', 'project')).toHaveLength(0);
  });

  it('project ledger enforces repo-relative paths — no absolute paths [capability-engine.4]', () => {
    const ledger = Ledger.load(dir, { isProject: true });
    expect(() => {
      ledger.record({
        ext: 'ext@1', host: 'claude', scope: 'project',
        action: { cap: 'config-merge', file: '/absolute/path/settings.json', keyPath: 'a', appliedHash: 'x' },
      });
    }).toThrow(/absolute/);
  });

  it('project ledger enforces repo-relative paths — no user-home paths', () => {
    const ledger = Ledger.load(dir, { isProject: true });
    expect(() => {
      ledger.record({
        ext: 'ext@1', host: 'claude', scope: 'project',
        action: { cap: 'config-merge', file: '~/settings.json', keyPath: 'a', appliedHash: 'x' },
      });
    }).toThrow(/user-home|absolute/i);
  });

  it('sha256 utility produces correct format', () => {
    const h = sha256({ key: 'value' });
    expect(h).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('assertAllPortable passes for repo-relative paths', () => {
    const ledger = Ledger.load(dir, { isProject: true });
    ledger.record({ ext: 'ext@1', host: 'claude', scope: 'project', action: { cap: 'config-merge', file: '.claude/settings.json', keyPath: 'a', appliedHash: 'x' } });
    expect(() => ledger.assertAllPortable()).not.toThrow();
  });
});

// ============================================================================
// file-drop capability
// ============================================================================

describe('file-drop — [capability-engine.1] [capability-engine.5]', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => rmrf(dir));

  it('exports apply / reverse / update / verify', () => {
    expect(typeof fileDrop.apply).toBe('function');
    expect(typeof fileDrop.reverse).toBe('function');
    expect(typeof fileDrop.update).toBe('function');
    expect(typeof fileDrop.verify).toBe('function');
  });

  it('apply: places a file at dest', async () => {
    const src = path.join(dir, 'src.md');
    const dest = path.join(dir, 'agents', 'my-agent.md');
    fs.writeFileSync(src, '# agent');
    const ctx: fileDrop.FileDropCtx = { host: 'claude', scope: 'user', target: { destPath: dest }, payload: { srcPath: src } };
    await fileDrop.apply(ctx);
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest, 'utf8')).toBe('# agent');
  });

  it('verify: ok after apply', async () => {
    const src = path.join(dir, 'src.md');
    const dest = path.join(dir, 'dest.md');
    fs.writeFileSync(src, 'hello');
    const ctx: fileDrop.FileDropCtx = { host: 'claude', scope: 'user', target: { destPath: dest }, payload: { srcPath: src } };
    await fileDrop.apply(ctx);
    const r = await fileDrop.verify(ctx);
    expect(r.ok).toBe(true);
  });

  it('reverse: removes dest', async () => {
    const src = path.join(dir, 'src.md');
    const dest = path.join(dir, 'dest.md');
    fs.writeFileSync(src, 'hello');
    const ctx: fileDrop.FileDropCtx = { host: 'claude', scope: 'user', target: { destPath: dest }, payload: { srcPath: src } };
    await fileDrop.apply(ctx);
    await fileDrop.reverse(ctx);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('apply is idempotent — double-apply produces same result [capability-engine.5]', async () => {
    const src = path.join(dir, 'src.md');
    const dest = path.join(dir, 'dest.md');
    fs.writeFileSync(src, 'content');
    const ctx: fileDrop.FileDropCtx = { host: 'claude', scope: 'user', target: { destPath: dest }, payload: { srcPath: src } };
    await fileDrop.apply(ctx);
    const mtime1 = fs.statSync(dest).mtimeMs;
    // Small delay to detect if file is re-written
    await new Promise((r) => setTimeout(r, 20));
    await fileDrop.apply(ctx);
    const mtime2 = fs.statSync(dest).mtimeMs;
    expect(mtime2).toBe(mtime1); // file not re-written
  });

  it('update returns "add" when dest is absent', async () => {
    const src = path.join(dir, 'src.md');
    fs.writeFileSync(src, 'hi');
    const ctx: fileDrop.FileDropCtx = { host: 'claude', scope: 'user', target: { destPath: path.join(dir, 'missing.md') }, payload: { srcPath: src } };
    const diff = await fileDrop.update(ctx);
    expect(diff.kind).toBe('add');
  });

  it('update returns "update" when dest differs', async () => {
    const src = path.join(dir, 'src.md');
    const dest = path.join(dir, 'dest.md');
    fs.writeFileSync(src, 'new content');
    fs.writeFileSync(dest, 'old content');
    const ctx: fileDrop.FileDropCtx = { host: 'claude', scope: 'user', target: { destPath: dest }, payload: { srcPath: src } };
    const diff = await fileDrop.update(ctx);
    expect(diff.kind).toBe('update');
  });

  it('apply works on a directory src', async () => {
    const srcDir = path.join(dir, 'skill-src');
    const dest = path.join(dir, 'skill-dest');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'SKILL.md'), '# skill');
    const ctx: fileDrop.FileDropCtx = { host: 'claude', scope: 'user', target: { destPath: dest }, payload: { srcPath: srcDir } };
    await fileDrop.apply(ctx);
    expect(fs.existsSync(path.join(dest, 'SKILL.md'))).toBe(true);
  });
});

// ============================================================================
// config-merge capability (JSON)
// ============================================================================

describe('config-merge JSON — [capability-engine.1] [capability-engine.3] [capability-engine.5]', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => rmrf(dir));

  function makeCtx(filePath: string, keyPath: string, value: unknown, ledger?: Ledger): configMerge.ConfigMergeCtx {
    return {
      host: 'claude', scope: 'user', scopeRoot: dir, ext: 'ext@1.0',
      target: { filePath, keyPath },
      payload: { value },
      ledger,
    };
  }

  it('exports apply / reverse / update / verify', () => {
    expect(typeof configMerge.apply).toBe('function');
    expect(typeof configMerge.reverse).toBe('function');
    expect(typeof configMerge.update).toBe('function');
    expect(typeof configMerge.verify).toBe('function');
  });

  it('apply: sets a key in an empty JSON file', async () => {
    const fp = path.join(dir, 'settings.json');
    const ctx = makeCtx(fp, 'mcpServers.my-server', { command: 'node', args: ['index.js'] });
    await configMerge.apply(ctx);
    const data = JSON.parse(fs.readFileSync(fp, 'utf8')) as Record<string, unknown>;
    expect((data['mcpServers'] as Record<string, unknown>)['my-server']).toMatchObject({ command: 'node' });
  });

  it('verify: ok after apply', async () => {
    const fp = path.join(dir, 'settings.json');
    const ctx = makeCtx(fp, 'key.sub', 'value');
    await configMerge.apply(ctx);
    const r = await configMerge.verify(ctx);
    expect(r.ok).toBe(true);
  });

  it('reverse: removes ONLY soxe key; foreign key survives [capability-engine.3]', async () => {
    const fp = path.join(dir, 'settings.json');
    // Pre-populate with a foreign key
    fs.writeFileSync(fp, JSON.stringify({ mcpServers: { foreign: { command: 'other' } } }, null, 2));

    const ledger = Ledger.load(dir);
    const ctx = makeCtx(fp, 'mcpServers.sox-server', { command: 'sox-bin' }, ledger);
    await configMerge.apply(ctx);

    // foreign key still present
    const after = JSON.parse(fs.readFileSync(fp, 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(after.mcpServers['foreign']).toBeDefined();
    expect(after.mcpServers['sox-server']).toBeDefined();

    // reverse
    await configMerge.reverse(ctx);
    const reversed = JSON.parse(fs.readFileSync(fp, 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(reversed.mcpServers['foreign']).toBeDefined();   // foreign survives!
    expect(reversed.mcpServers['sox-server']).toBeUndefined(); // soxe key removed
  });

  it('apply is idempotent — records one ledger action only [capability-engine.5]', async () => {
    const fp = path.join(dir, 'settings.json');
    const ledger = Ledger.load(dir);
    const ctx = makeCtx(fp, 'a.b', 'val', ledger);
    await configMerge.apply(ctx);
    await configMerge.apply(ctx); // second apply — same value, should be no-op
    const actions = ledger.actionsFor('ext@1.0', 'claude', 'user');
    expect(actions).toHaveLength(1); // only one recorded
  });

  it('ledger action includes appliedHash [capability-engine.3]', async () => {
    const fp = path.join(dir, 'settings.json');
    const ledger = Ledger.load(dir);
    const ctx = makeCtx(fp, 'x.y', { foo: 'bar' }, ledger);
    await configMerge.apply(ctx);
    const actions = ledger.actionsFor('ext@1.0', 'claude', 'user');
    expect(actions[0]).toBeDefined();
    expect(actions[0]!.appliedHash).toMatch(/^sha256:/);
  });

  it('update: "none" when value unchanged', async () => {
    const fp = path.join(dir, 'settings.json');
    const ctx = makeCtx(fp, 'k', 'v');
    await configMerge.apply(ctx);
    const diff = await configMerge.update(ctx);
    expect(diff.kind).toBe('none');
  });

  it('apply→reverse round-trip restores file to pre-apply state', async () => {
    const fp = path.join(dir, 'settings.json');
    const initial = { existing: true };
    fs.writeFileSync(fp, JSON.stringify(initial, null, 2));
    const ledger = Ledger.load(dir);
    const ctx = makeCtx(fp, 'newKey', 'newVal', ledger);
    await configMerge.apply(ctx);
    await configMerge.reverse(ctx);
    const data = JSON.parse(fs.readFileSync(fp, 'utf8')) as Record<string, unknown>;
    expect(data['newKey']).toBeUndefined();
    expect(data['existing']).toBe(true); // original key preserved
  });
});

// ============================================================================
// config-merge capability (TOML) — [capability-engine.2]
// ============================================================================

describe('config-merge TOML — [capability-engine.2]', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => rmrf(dir));

  it('exports parseToml and stringifyToml', () => {
    expect(typeof configMerge.parseToml).toBe('function');
    expect(typeof configMerge.stringifyToml).toBe('function');
  });

  it('parseToml: parses flat key=value', () => {
    const src = `model = "o4-mini"\ntimeout = 30\n`;
    const result = configMerge.parseToml(src);
    expect(result['model']).toBe('o4-mini');
    expect(result['timeout']).toBe(30);
  });

  it('parseToml: parses table headers', () => {
    const src = `[mcp_servers.my-server]\ncommand = "node"\nargs = ["index.js"]\n`;
    const result = configMerge.parseToml(src);
    const servers = result['mcp_servers'] as Record<string, unknown>;
    const s = servers['my-server'] as Record<string, unknown>;
    expect(s['command']).toBe('node');
  });

  it('stringifyToml: round-trips flat values', () => {
    const obj = { model: 'o4-mini', timeout: 30, debug: true };
    const toml = configMerge.stringifyToml(obj);
    const parsed = configMerge.parseToml(toml);
    expect(parsed['model']).toBe('o4-mini');
    expect(parsed['timeout']).toBe(30);
    expect(parsed['debug']).toBe(true);
  });

  it('apply: sets a key in a TOML file [capability-engine.2]', async () => {
    const fp = path.join(dir, 'config.toml');
    fs.writeFileSync(fp, `model = "o4-mini"\n`);
    const ledger = Ledger.load(dir);
    const ctx: configMerge.ConfigMergeCtx = {
      host: 'codex', scope: 'user', scopeRoot: dir, ext: 'my-agent@1.0',
      target: { filePath: fp, keyPath: 'approval_policy' },
      payload: { value: 'auto' },
      ledger,
    };
    await configMerge.apply(ctx);
    const raw = fs.readFileSync(fp, 'utf8');
    expect(raw).toContain('approval_policy');
  });

  it('apply→reverse TOML round-trip: foreign key survives [capability-engine.2]', async () => {
    const fp = path.join(dir, 'config.toml');
    fs.writeFileSync(fp, `model = "o4-mini"\n`);
    const ledger = Ledger.load(dir);
    const ctx: configMerge.ConfigMergeCtx = {
      host: 'codex', scope: 'user', scopeRoot: dir, ext: 'my-agent@1.0',
      target: { filePath: fp, keyPath: 'approval_policy' },
      payload: { value: 'auto' },
      ledger,
    };
    await configMerge.apply(ctx);
    await configMerge.reverse(ctx);
    const raw = fs.readFileSync(fp, 'utf8');
    // Foreign key 'model' must survive
    const parsed = configMerge.parseToml(raw);
    expect(parsed['model']).toBe('o4-mini');
    expect(parsed['approval_policy']).toBeUndefined();
  });

  it('TOML apply is idempotent [capability-engine.5]', async () => {
    const fp = path.join(dir, 'config.toml');
    fs.writeFileSync(fp, `model = "o4-mini"\n`);
    const ledger = Ledger.load(dir);
    const ctx: configMerge.ConfigMergeCtx = {
      host: 'codex', scope: 'user', scopeRoot: dir, ext: 'agent@1',
      target: { filePath: fp, keyPath: 'timeout' },
      payload: { value: 60 },
      ledger,
    };
    await configMerge.apply(ctx);
    await configMerge.apply(ctx); // idempotent
    const actions = ledger.actionsFor('agent@1', 'codex', 'user');
    expect(actions.length).toBe(1);
  });
});

// ============================================================================
// array-merge capability
// ============================================================================

describe('array-merge — [capability-engine.1] [capability-engine.3] [capability-engine.5]', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => rmrf(dir));

  function makeCtx(filePath: string, keyPath: string, values: string[], ledger?: Ledger): arrayMerge.ArrayMergeCtx {
    return {
      host: 'claude', scope: 'project', scopeRoot: dir, ext: 'ext@2.0',
      target: { filePath, keyPath },
      payload: { values },
      ledger,
    };
  }

  it('exports apply / reverse / update / verify', () => {
    expect(typeof arrayMerge.apply).toBe('function');
    expect(typeof arrayMerge.reverse).toBe('function');
    expect(typeof arrayMerge.update).toBe('function');
    expect(typeof arrayMerge.verify).toBe('function');
  });

  it('apply: appends values to array', async () => {
    const fp = path.join(dir, 'settings.json');
    const ctx = makeCtx(fp, 'enabledMcpjsonServers', ['my-server']);
    await arrayMerge.apply(ctx);
    const data = JSON.parse(fs.readFileSync(fp, 'utf8')) as { enabledMcpjsonServers: string[] };
    expect(data.enabledMcpjsonServers).toContain('my-server');
  });

  it('deny-wins: duplicate value not re-appended [capability-engine.5]', async () => {
    const fp = path.join(dir, 'settings.json');
    fs.writeFileSync(fp, JSON.stringify({ tags: ['existing'] }, null, 2));
    const ledger = Ledger.load(dir);
    const ctx = makeCtx(fp, 'tags', ['existing', 'new'], ledger);
    await arrayMerge.apply(ctx);
    const data = JSON.parse(fs.readFileSync(fp, 'utf8')) as { tags: string[] };
    const count = data.tags.filter((v) => v === 'existing').length;
    expect(count).toBe(1); // not duplicated
    expect(data.tags).toContain('new');
  });

  it('apply is idempotent — second apply is no-op [capability-engine.5]', async () => {
    const fp = path.join(dir, 'settings.json');
    const ledger = Ledger.load(dir);
    const ctx = makeCtx(fp, 'servers', ['s1', 's2'], ledger);
    await arrayMerge.apply(ctx);
    await arrayMerge.apply(ctx);
    const actions = ledger.actionsFor('ext@2.0', 'claude', 'project');
    expect(actions).toHaveLength(1); // only one recorded
  });

  it('ledger action includes exact appended values [capability-engine.3]', async () => {
    const fp = path.join(dir, 'settings.json');
    const ledger = Ledger.load(dir);
    const ctx = makeCtx(fp, 'arr', ['v1', 'v2'], ledger);
    await arrayMerge.apply(ctx);
    const actions = ledger.actionsFor('ext@2.0', 'claude', 'project');
    expect(actions[0]).toBeDefined();
    expect(actions[0]!.cap).toBe('array-merge');
    expect(actions[0]!.values).toEqual(['v1', 'v2']);
  });

  it('reverse: removes ONLY soxe values; foreign values survive [capability-engine.3]', async () => {
    const fp = path.join(dir, 'settings.json');
    // Pre-populate with a foreign value
    fs.writeFileSync(fp, JSON.stringify({ arr: ['foreign-value'] }, null, 2));

    const ledger = Ledger.load(dir);
    const ctx = makeCtx(fp, 'arr', ['sox-value'], ledger);
    await arrayMerge.apply(ctx);

    // both present after apply
    const after = JSON.parse(fs.readFileSync(fp, 'utf8')) as { arr: string[] };
    expect(after.arr).toContain('foreign-value');
    expect(after.arr).toContain('sox-value');

    // reverse
    await arrayMerge.reverse(ctx);
    const reversed = JSON.parse(fs.readFileSync(fp, 'utf8')) as { arr: string[] };
    expect(reversed.arr).toContain('foreign-value');   // foreign survives!
    expect(reversed.arr).not.toContain('sox-value');   // soxe value removed
  });

  it('verify: ok when all values present', async () => {
    const fp = path.join(dir, 'settings.json');
    const ctx = makeCtx(fp, 'items', ['a', 'b']);
    await arrayMerge.apply(ctx);
    const r = await arrayMerge.verify(ctx);
    expect(r.ok).toBe(true);
  });

  it('verify: fails when a value is missing', async () => {
    const fp = path.join(dir, 'settings.json');
    fs.writeFileSync(fp, JSON.stringify({ items: ['a'] }, null, 2));
    const ctx = makeCtx(fp, 'items', ['a', 'b']);
    const r = await arrayMerge.verify(ctx);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('b');
  });
});

// ============================================================================
// bin-link capability
// ============================================================================

describe('bin-link — [capability-engine.1] [capability-engine.5]', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => rmrf(dir));

  it('exports apply / reverse / update / verify', () => {
    expect(typeof binLink.apply).toBe('function');
    expect(typeof binLink.reverse).toBe('function');
    expect(typeof binLink.update).toBe('function');
    expect(typeof binLink.verify).toBe('function');
  });

  it('apply: creates a symlink', async () => {
    const src = path.join(dir, 'my-tool');
    const link = path.join(dir, 'bin', 'my-tool');
    fs.writeFileSync(src, '#!/usr/bin/env node\nconsole.log("hi")');
    const ctx: binLink.BinLinkCtx = { host: 'claude', scope: 'user', target: { linkPath: link }, payload: { srcPath: src } };
    await binLink.apply(ctx);
    expect(fs.existsSync(link) || fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('verify: ok after apply', async () => {
    const src = path.join(dir, 'tool');
    const link = path.join(dir, 'link');
    fs.writeFileSync(src, '#!');
    const ctx: binLink.BinLinkCtx = { host: 'claude', scope: 'user', target: { linkPath: link }, payload: { srcPath: src } };
    await binLink.apply(ctx);
    const r = await binLink.verify(ctx);
    expect(r.ok).toBe(true);
  });

  it('reverse: removes the link', async () => {
    const src = path.join(dir, 'tool');
    const link = path.join(dir, 'link');
    fs.writeFileSync(src, '#!');
    const ctx: binLink.BinLinkCtx = { host: 'claude', scope: 'user', target: { linkPath: link }, payload: { srcPath: src } };
    await binLink.apply(ctx);
    await binLink.reverse(ctx);
    expect(fs.existsSync(link)).toBe(false);
  });

  it('apply is idempotent — second apply is no-op [capability-engine.5]', async () => {
    const src = path.join(dir, 'tool');
    const link = path.join(dir, 'link');
    fs.writeFileSync(src, '#!');
    const ctx: binLink.BinLinkCtx = { host: 'claude', scope: 'user', target: { linkPath: link }, payload: { srcPath: src } };
    await binLink.apply(ctx);
    await expect(binLink.apply(ctx)).resolves.not.toThrow();
    const r = await binLink.verify(ctx);
    expect(r.ok).toBe(true);
  });

  it('update: "add" when link absent', async () => {
    const src = path.join(dir, 'tool');
    fs.writeFileSync(src, '#!');
    const ctx: binLink.BinLinkCtx = { host: 'claude', scope: 'user', target: { linkPath: path.join(dir, 'link') }, payload: { srcPath: src } };
    const diff = await binLink.update(ctx);
    expect(diff.kind).toBe('add');
  });
});

// ============================================================================
// run-service capability
// ============================================================================

describe('run-service — [capability-engine.1] [capability-engine.5]', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => rmrf(dir));

  const spec: runService.ServiceSpec = { command: '/usr/bin/node', args: ['server.js'], env: { PORT: '3000' } };

  function makeCtx(): runService.RunServiceCtx {
    return {
      host: 'claude', scope: 'project',
      target: { scopeRoot: dir, serviceId: 'my-service' },
      payload: { spec },
    };
  }

  it('exports apply / reverse / update / verify', () => {
    expect(typeof runService.apply).toBe('function');
    expect(typeof runService.reverse).toBe('function');
    expect(typeof runService.update).toBe('function');
    expect(typeof runService.verify).toBe('function');
  });

  it('apply: writes service manifest', async () => {
    const ctx = makeCtx();
    await runService.apply(ctx);
    const mp = path.join(dir, 'services', 'my-service.json');
    expect(fs.existsSync(mp)).toBe(true);
    const data = JSON.parse(fs.readFileSync(mp, 'utf8')) as { serviceId: string; spec: runService.ServiceSpec };
    expect(data.serviceId).toBe('my-service');
    expect(data.spec.command).toBe('/usr/bin/node');
  });

  it('verify: ok after apply', async () => {
    const ctx = makeCtx();
    await runService.apply(ctx);
    const r = await runService.verify(ctx);
    expect(r.ok).toBe(true);
  });

  it('reverse: removes manifest', async () => {
    const ctx = makeCtx();
    await runService.apply(ctx);
    await runService.reverse(ctx);
    const mp = path.join(dir, 'services', 'my-service.json');
    expect(fs.existsSync(mp)).toBe(false);
  });

  it('apply is idempotent [capability-engine.5]', async () => {
    const ctx = makeCtx();
    await runService.apply(ctx);
    const mp = path.join(dir, 'services', 'my-service.json');
    const mtime1 = fs.statSync(mp).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await runService.apply(ctx);
    const mtime2 = fs.statSync(mp).mtimeMs;
    expect(mtime2).toBe(mtime1);
  });

  it('update: "add" when manifest absent', async () => {
    const ctx = makeCtx();
    const diff = await runService.update(ctx);
    expect(diff.kind).toBe('add');
  });

  it('update: "none" when spec unchanged', async () => {
    const ctx = makeCtx();
    await runService.apply(ctx);
    const diff = await runService.update(ctx);
    expect(diff.kind).toBe('none');
  });
});

// ============================================================================
// materialize capability
// ============================================================================

describe('materialize — [capability-engine.1] [capability-engine.5]', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => rmrf(dir));

  function buildSrc(): string {
    const src = path.join(dir, 'dist');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'index.js'), 'console.log("hello")');
    return src;
  }

  function makeCtx(src: string): materialize.MaterializeCtx {
    return {
      host: 'claude', scope: 'user',
      target: { storeRoot: path.join(dir, 'store'), extRef: 'my-server@1.0.0' },
      payload: { srcPath: src },
    };
  }

  it('exports apply / reverse / update / verify', () => {
    expect(typeof materialize.apply).toBe('function');
    expect(typeof materialize.reverse).toBe('function');
    expect(typeof materialize.update).toBe('function');
    expect(typeof materialize.verify).toBe('function');
  });

  it('apply: copies dist to store path', async () => {
    const src = buildSrc();
    const ctx = makeCtx(src);
    await materialize.apply(ctx);
    const stored = path.join(dir, 'store', 'my-server@1.0.0', 'index.js');
    expect(fs.existsSync(stored)).toBe(true);
  });

  it('verify: ok after apply', async () => {
    const src = buildSrc();
    const ctx = makeCtx(src);
    await materialize.apply(ctx);
    const r = await materialize.verify(ctx);
    expect(r.ok).toBe(true);
  });

  it('reverse: removes store path', async () => {
    const src = buildSrc();
    const ctx = makeCtx(src);
    await materialize.apply(ctx);
    await materialize.reverse(ctx);
    expect(fs.existsSync(path.join(dir, 'store', 'my-server@1.0.0'))).toBe(false);
  });

  it('apply is idempotent — second apply is no-op [capability-engine.5]', async () => {
    const src = buildSrc();
    const ctx = makeCtx(src);
    await materialize.apply(ctx);
    const stored = path.join(dir, 'store', 'my-server@1.0.0', 'index.js');
    const mtime1 = fs.statSync(stored).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await materialize.apply(ctx);
    const mtime2 = fs.statSync(stored).mtimeMs;
    expect(mtime2).toBe(mtime1);
  });

  it('update: "add" when store absent', async () => {
    const src = buildSrc();
    const ctx = makeCtx(src);
    const diff = await materialize.update(ctx);
    expect(diff.kind).toBe('add');
  });

  it('update: "none" when content matches', async () => {
    const src = buildSrc();
    const ctx = makeCtx(src);
    await materialize.apply(ctx);
    const diff = await materialize.update(ctx);
    expect(diff.kind).toBe('none');
  });

  it('update: "update" when source changes', async () => {
    const src = buildSrc();
    const ctx = makeCtx(src);
    await materialize.apply(ctx);
    // Change source
    fs.writeFileSync(path.join(src, 'index.js'), 'console.log("v2")');
    const diff = await materialize.update(ctx);
    expect(diff.kind).toBe('update');
  });

  it('defaultStoreRoot() returns the ext dir under the user data root (ADR-0004)', () => {
    // This test asserts the genuine DEFAULT path, so it must run with
    // SOX_ECOSYSTEM_HOME unset (the suite-wide setup sandboxes it to a tmp dir for
    // write-isolation — BL-35). defaultStoreRoot() only computes a string, no I/O,
    // so temporarily clearing the override is side-effect-free.
    const saved = process.env['SOX_ECOSYSTEM_HOME'];
    delete process.env['SOX_ECOSYSTEM_HOME'];
    try {
      const root = materialize.defaultStoreRoot();
      // ADR-0004 §D2: $userDataRoot/ext (default ~/.adhd/sox-ecosystem/ext).
      expect(root).toContain(path.join('.adhd', 'sox-ecosystem', 'ext'));
    } finally {
      if (saved === undefined) delete process.env['SOX_ECOSYSTEM_HOME'];
      else process.env['SOX_ECOSYSTEM_HOME'] = saved;
    }
  });
});
