/**
 * e46db6ed — `soxe uninstall <id> --host H` removes only host H's footprint.
 *
 * CLI-level proof against the REAL built CLI (`dist/apps/sox/main.js`), complementing the
 * unit specs in libs/install-engine/src/lifecycle.spec.ts. One shared scaffold: a temp
 * HOME, workspace (cwd), and data root (SOX_ECOSYSTEM_HOME), plus a stub agent-mcp MCP
 * server (SOX_AGENT_MCP_BIN) that appends every tools/call to a log — nothing touches the
 * real HOME, ~/.adhd, or the network.
 *
 * Duration: ~25 CLI spawns across 6 tests, ~5 s total (each spawn ~0.2 s).
 * `nx test sox` depends on `build`, so dist/apps/sox/main.js exists by the time this runs.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI_MAIN = path.resolve(__dirname, '../../../dist/apps/sox/main.js');

/** Stub agent-mcp: newline-delimited JSON-RPC; logs tools/call; agent_read => not found. */
const STUB_SOURCE = String.raw`
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    return reply(msg.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'stub', version: '0' } });
  }
  const { name, arguments: args } = msg.params;
  fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ tool: name, args }) + '\n');
  if (name === 'agent_read') {
    return process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'agent not found' } }) + '\n');
  }
  reply(msg.id, { content: [{ type: 'text', text: JSON.stringify({ name: args.name }) }] });
});
`;

interface Scaffold {
  base: string;
  home: string;
  ws: string;
  data: string;
  stubLog: string;
}

let sc: Scaffold;

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-e46db6ed-'));
  const home = path.join(base, 'home');
  const ws = path.join(base, 'ws');
  const data = path.join(base, 'data');
  for (const d of [home, ws, data]) fs.mkdirSync(d, { recursive: true });
  const stub = path.join(base, 'stub-agent-mcp.cjs');
  fs.writeFileSync(stub, STUB_SOURCE);
  sc = { base, home, ws, data, stubLog: path.join(base, 'stub.log') };
  fs.writeFileSync(sc.stubLog, '');
});

afterEach(() => {
  fs.rmSync(sc.base, { recursive: true, force: true });
});

function cli(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI_MAIN, ...args], {
    encoding: 'utf8',
    cwd: sc.ws,
    env: {
      ...process.env,
      HOME: sc.home,
      SOX_ECOSYSTEM_HOME: sc.data,
      SOX_AGENT_MCP_BIN: `${process.execPath} ${path.join(sc.base, 'stub-agent-mcp.cjs')}`,
      STUB_LOG: sc.stubLog,
    },
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function writeExt(type: 'skill' | 'agent', id: string, hosts: string[]): void {
  const dir = path.join(sc.ws, 'extensions', `${type}s`, id);
  fs.mkdirSync(dir, { recursive: true });
  const entry = type === 'skill' ? 'SKILL.md' : `${id}.md`;
  const manifest: Record<string, unknown> = {
    $schema: 'https://your-registry/schemas/extension/v2.json',
    id,
    version: '0.1.0',
    type,
    title: id,
    description: `${id} fixture`,
    compatibility: { host: '>=1.0.0 <2.0.0' },
    license: 'MIT',
    runtime: 'declarative',
    entrypoint: entry,
    install: { type, hosts },
  };
  if (type === 'agent') {
    manifest['agent'] = { name: id, description: `${id} fixture agent`, model: 'sonnet', mode: 'all', tools: ['read'] };
    manifest['render'] = {
      claude: { model: 'sonnet', version: 'v0.1.0' },
      opencode: { model: 'deepseek/deepseek-flash', mode: 'all' },
      'agent-mcp': { model: 'deepseek/deepseek-flash' },
    };
  }
  fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `@adhd/sox-extension-${id}`, version: '0.1.0', private: true }));
  fs.writeFileSync(path.join(dir, entry), `# ${id}\n`);
}

const stubCalls = (tool: string): number =>
  fs.readFileSync(sc.stubLog, 'utf8').split('\n').filter((l) => l.includes(`"tool":"${tool}"`)).length;

const readJson = <T>(p: string): T => JSON.parse(fs.readFileSync(p, 'utf8')) as T;
/** Where a scope keeps ledger.json / ownership.json (project = <ws>/.adhd/sox-ecosystem). */
const dataDirOf = (scope: 'user' | 'project'): string =>
  scope === 'project' ? path.join(sc.ws, '.adhd', 'sox-ecosystem') : sc.data;
const ledgerHosts = (id: string, scope: 'user' | 'project' = 'user'): string[] =>
  readJson<{ entries: Array<{ ext: string; host: string }> }>(path.join(dataDirOf(scope), 'ledger.json'))
    .entries.filter((e) => e.ext === id).map((e) => e.host).sort();
const ownedRecord = (
  id: string,
  scope: 'user' | 'project' = 'user',
): { entries: Array<{ kind: string; path?: string; host?: string }> } | undefined => {
  const f = path.join(dataDirOf(scope), 'ownership.json');
  return fs.existsSync(f)
    ? readJson<{ owned: Array<{ extId: string; entries: Array<{ kind: string; path?: string; host?: string }> }> }>(f)
        .owned.find((r) => r.extId === id)
    : undefined;
};

const skillPath = (host: 'claude' | 'opencode', id: string): string =>
  host === 'claude' ? path.join(sc.home, '.claude', 'skills', id) : path.join(sc.home, '.config', 'opencode', 'skills', id);

describe('e46db6ed — soxe uninstall --host attribution (real CLI)', () => {
  it('e46db6ed AC1 + AC2 — project agent on claude,opencode,agent-mcp: one catalog delete, all gone, 2nd uninstall exits 1', () => {
    writeExt('agent', 'e46-agent', ['claude', 'opencode', 'agent-mcp']);
    const inst = cli(['install', 'e46-agent', '--host=claude,opencode,agent-mcp', '--scope=project', `--root=${sc.ws}`]);
    expect(inst.code, inst.stderr).toBe(0);
    expect(ledgerHosts('e46-agent', 'project')).toEqual(['agent-mcp', 'claude', 'opencode']);
    expect(ownedRecord('e46-agent', 'project')?.entries.map((e) => e.host).sort()).toEqual(['agent-mcp', 'claude', 'opencode']);
    expect(stubCalls('agent_create')).toBe(1);

    const un = cli(['uninstall', 'e46-agent', '-s', 'project', `--root=${sc.ws}`]);

    expect(un.code, un.stderr).toBe(0);
    expect(stubCalls('agent_delete')).toBe(1);
    expect(ledgerHosts('e46-agent', 'project')).toEqual([]);
    expect(ownedRecord('e46-agent', 'project')).toBeUndefined();
    for (const f of ['.claude', '.opencode']) {
      expect(fs.existsSync(path.join(sc.ws, f, 'agents', 'e46-agent.md')), f).toBe(false);
    }
    expect(un.stdout).toMatch(/hosts removed\s+agent-mcp, claude, opencode/);

    const again = cli(['uninstall', 'e46-agent', '-s', 'project', `--root=${sc.ws}`]);
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/not found/);
    expect(stubCalls('agent_delete')).toBe(1);
  });

  it('e46db6ed AC3 + AC4 — user skill on claude+opencode: --host opencode, then --host claude takes the shared state', () => {
    writeExt('skill', 'e46-skill', ['claude', 'opencode']);
    expect(cli(['install', 'e46-skill', '--host=claude,opencode', '--scope=user', `--root=${sc.ws}`]).code).toBe(0);
    // Shared state a service-style install would also have written for (id, scope).
    const lockfile = path.join(sc.base, 'lock.json');
    const config = path.join(sc.base, 'extensions.json');
    fs.writeFileSync(lockfile, JSON.stringify({ lockfileVersion: 1, resolved: { 'e46-skill': { source: 'file:///x', checksum: 'sha256:0' } } }));
    fs.writeFileSync(config, JSON.stringify({ install: [{ id: 'e46-skill' }, { id: 'other' }] }));
    const registry = path.join(sc.data, 'install-registry.json');
    fs.writeFileSync(registry, JSON.stringify({ version: 1, installs: [{ extId: 'e46-skill', version: '0.1.0', scope: 'user', root: sc.ws, installedAt: 't', updatedAt: 't', source: 'file:///x' }] }));
    const shared = [`--lockfile=${lockfile}`, `--config=${config}`];

    const first = cli(['uninstall', 'e46-skill', '--host', 'opencode', '--scope', 'user', `--root=${sc.ws}`, ...shared]);

    expect(first.code, first.stderr).toBe(0);
    expect(fs.existsSync(skillPath('opencode', 'e46-skill'))).toBe(false);
    expect(fs.existsSync(skillPath('claude', 'e46-skill'))).toBe(true);
    expect(ledgerHosts('e46-skill')).toEqual(['claude']);
    expect(ownedRecord('e46-skill')?.entries.map((e) => e.host)).toEqual(['claude']);
    expect(first.stdout).toContain('opencode');
    expect(first.stdout).not.toContain('claude');
    // Shared state survives a partial uninstall.
    expect(readJson<{ resolved: Record<string, unknown> }>(lockfile).resolved).toHaveProperty('e46-skill');
    expect(readJson<{ install: Array<{ id: string }> }>(config).install.map((e) => e.id)).toEqual(['e46-skill', 'other']);
    expect(readJson<{ installs: unknown[] }>(registry).installs).toHaveLength(1);

    const last = cli(['uninstall', 'e46-skill', '--host', 'claude', '--scope', 'user', `--root=${sc.ws}`, ...shared]);

    expect(last.code, last.stderr).toBe(0);
    expect(fs.existsSync(skillPath('claude', 'e46-skill'))).toBe(false);
    expect(ledgerHosts('e46-skill')).toEqual([]);
    expect(ownedRecord('e46-skill')).toBeUndefined();
    expect(readJson<{ resolved: Record<string, unknown> }>(lockfile).resolved).not.toHaveProperty('e46-skill');
    expect(readJson<{ install: Array<{ id: string }> }>(config).install.map((e) => e.id)).toEqual(['other']);
    expect(readJson<{ installs: unknown[] }>(registry).installs).toHaveLength(0);
  });

  it('e46db6ed AC5 — --host never installed exits non-zero and touches nothing', () => {
    writeExt('skill', 'e46-skill', ['claude', 'opencode']);
    expect(cli(['install', 'e46-skill', '--host=claude,opencode', '--scope=user', `--root=${sc.ws}`]).code).toBe(0);
    const before = [fs.readFileSync(path.join(sc.data, 'ownership.json'), 'utf8'), fs.readFileSync(path.join(sc.data, 'ledger.json'), 'utf8')];

    const r = cli(['uninstall', 'e46-skill', '--host', 'codex', '--scope', 'user', `--root=${sc.ws}`]);

    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/not installed on host 'codex'/);
    expect([fs.readFileSync(path.join(sc.data, 'ownership.json'), 'utf8'), fs.readFileSync(path.join(sc.data, 'ledger.json'), 'utf8')]).toEqual(before);
    expect(fs.existsSync(skillPath('claude', 'e46-skill'))).toBe(true);
    expect(fs.existsSync(skillPath('opencode', 'e46-skill'))).toBe(true);
  });

  it.each([
    ['claude,opencode', 'claude', 'opencode'],
    ['opencode,claude', 'opencode', 'claude'],
  ])('e46db6ed AC7 — install order %s: --host A, --host B, and no --host agree', (order, a, b) => {
    writeExt('skill', 'e46-skill', ['claude', 'opencode']);
    const inst = (): void => {
      // Sequential single-host installs so the install ORDER really differs.
      for (const h of order.split(',')) {
        expect(cli(['install', 'e46-skill', `--host=${h}`, '--scope=user', `--root=${sc.ws}`]).code).toBe(0);
      }
    };
    const p = (h: string): string => skillPath(h as 'claude' | 'opencode', 'e46-skill');

    inst();
    expect(cli(['uninstall', 'e46-skill', '--host', a, '--scope', 'user', `--root=${sc.ws}`]).code).toBe(0);
    expect([fs.existsSync(p(a)), fs.existsSync(p(b))]).toEqual([false, true]);
    expect(ownedRecord('e46-skill')).toBeDefined();
    expect(cli(['uninstall', 'e46-skill', '--host', b, '--scope', 'user', `--root=${sc.ws}`]).code).toBe(0);
    expect([fs.existsSync(p(a)), fs.existsSync(p(b))]).toEqual([false, false]);
    expect(ownedRecord('e46-skill')).toBeUndefined();

    inst();
    const all = cli(['uninstall', 'e46-skill', '--scope', 'user', `--root=${sc.ws}`]);
    expect(all.code, all.stderr).toBe(0);
    expect([fs.existsSync(p(a)), fs.existsSync(p(b))]).toEqual([false, false]);
    expect(ownedRecord('e46-skill')).toBeUndefined();
    expect(all.stdout).toMatch(/hosts removed\s+claude, opencode/);
  });

  it('e46db6ed AC8 — legacy host-less record: attributes by ledger path, refuses what it cannot attribute', () => {
    writeExt('skill', 'e46-skill', ['claude', 'opencode']);
    expect(cli(['install', 'e46-skill', '--host=claude,opencode', '--scope=user', `--root=${sc.ws}`]).code).toBe(0);
    // Strip the stamps: this is what a pre-e46db6ed record looks like on disk.
    const ownFile = path.join(sc.data, 'ownership.json');
    const own = readJson<{ owned: Array<{ entries: Array<Record<string, unknown>> }> }>(ownFile);
    for (const r of own.owned) for (const e of r.entries) delete e['host'];
    fs.writeFileSync(ownFile, JSON.stringify(own));

    const ok = cli(['uninstall', 'e46-skill', '--host', 'opencode', '--scope', 'user', `--root=${sc.ws}`]);
    expect(ok.code, ok.stderr).toBe(0);
    expect(fs.existsSync(skillPath('opencode', 'e46-skill'))).toBe(false);
    expect(fs.existsSync(skillPath('claude', 'e46-skill'))).toBe(true);

    // An entry no host's ledger claims: --host must refuse and name the all-hosts form.
    const mystery = path.join(sc.base, 'mystery');
    fs.mkdirSync(mystery);
    const own2 = readJson<{ owned: Array<{ entries: Array<Record<string, unknown>> }> }>(ownFile);
    own2.owned[0]!.entries.push({ kind: 'file-drop', path: mystery });
    fs.writeFileSync(ownFile, JSON.stringify(own2));
    const refused = cli(['uninstall', 'e46-skill', '--host', 'claude', '--scope', 'user', `--root=${sc.ws}`]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('soxe uninstall e46-skill -s user');
    expect(fs.existsSync(skillPath('claude', 'e46-skill'))).toBe(true);
    expect(fs.existsSync(mystery)).toBe(true);

    expect(cli(['uninstall', 'e46-skill', '--scope', 'user', `--root=${sc.ws}`]).code).toBe(0);
    expect(fs.existsSync(skillPath('claude', 'e46-skill'))).toBe(false);
    expect(fs.existsSync(mystery)).toBe(false);
  });

  it('e46db6ed AC1 — no --host reverses claude trust grants even when another host installed last', () => {
    writeExt('skill', 'e46-skill', ['claude', 'opencode']);
    for (const h of ['claude', 'opencode']) {
      expect(cli(['install', 'e46-skill', `--host=${h}`, '--scope=user', `--root=${sc.ws}`]).code).toBe(0);
    }
    const ownFile = path.join(sc.data, 'ownership.json');
    const own = readJson<{ owned: Array<{ extId: string; host?: string; entries: Array<Record<string, unknown>> }> }>(ownFile);
    const rec = own.owned.find((r) => r.extId === 'e46-skill')!;
    // opencode installed last: the (informational) record host is NOT claude.
    expect(rec.host).toBe('opencode');
    const claudeJson = path.join(sc.home, '.claude.json');
    const proj = path.join(sc.base, 'some-project');
    fs.writeFileSync(claudeJson, JSON.stringify({ projects: { [proj]: { enabledMcpjsonServers: ['e46-skill', 'keep'] } } }));
    rec.entries.push({ kind: 'config-key', file: claudeJson, keyPath: `trust:${proj}` });
    fs.writeFileSync(ownFile, JSON.stringify(own));

    const un = cli(['uninstall', 'e46-skill', '--scope', 'user', `--root=${sc.ws}`]);

    expect(un.code, un.stderr).toBe(0);
    expect(un.stdout).toContain('mcp-trust removed');
    expect(readJson<{ projects: Record<string, { enabledMcpjsonServers: string[] }> }>(claudeJson).projects[proj]!.enabledMcpjsonServers).toEqual(['keep']);
  });

  it('e46db6ed AC1 — an unreadable extensions.json is reported on stderr, never swallowed', () => {
    writeExt('skill', 'e46-skill', ['claude']);
    expect(cli(['install', 'e46-skill', '--host=claude', '--scope=user', `--root=${sc.ws}`]).code).toBe(0);
    const config = path.join(sc.base, 'extensions.json');
    fs.writeFileSync(config, '{ not json');

    const un = cli(['uninstall', 'e46-skill', '--scope', 'user', `--root=${sc.ws}`, `--config=${config}`]);

    expect(un.code, un.stderr).toBe(0);
    expect(un.stderr).toMatch(/could not update .*extensions\.json/);
    expect(fs.existsSync(skillPath('claude', 'e46-skill'))).toBe(false);
  });
});
