/**
 * libs/install-engine/src/required-config-seed.bl0c3522c2.spec.ts
 *
 * BL 0c3522c2 — memory-server fails closed: it never infers a store path, so the
 * path has to come from `config.memory-server.db_path` (injected as
 * SOX_CONFIG_DB_PATH). Before this change a non-interactive `soxe install` only
 * WARNED that the required key was unset, and an interactive one offered no
 * default, so nothing ever seeded it — the runtime's hard-coded
 * `~/.memory/memory.db` guess was the only thing that made an install work.
 *
 * Contract pinned here:
 *   - `x-sox-scope-default[<scope>]` seeds a REQUIRED key on a non-interactive
 *     install (user → ~/.memory/memory.db, project → ~/.memory/memory-dev.db for
 *     memory-server), persisted into THAT scope's config file.
 *   - An exported `SOX_CONFIG_<KEY>` wins over the scope default (explicit value).
 *   - A key already set in any cascade scope is never overwritten.
 *   - A scope with no declared default (local/org) is left unset → warning.
 *
 * The e2e cases drive the REAL built CLI (dist/apps/sox/main.js) against a
 * sandboxed workspace + SOX_ECOSYSTEM_HOME, so no real home config is touched.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configEnvKey,
  fetchArtifact,
  findManifestForSource,
  resolveRequiredConfigSeed,
  type ConfigSchemaProperty,
} from './install.js';
import { scopeConfigPaths } from './data-paths.js';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const CLI_MAIN = path.join(REPO_ROOT, 'dist/apps/sox/main.js');
const PROBE = 'bl0c35probe';
const SCOPE_DEFAULTS = { user: '~/.memory-probe/user.db', project: '~/.memory-probe/dev.db' };

// ── Pure resolver ─────────────────────────────────────────────────────────────

describe('resolveRequiredConfigSeed — BL 0c3522c2', () => {
  const prop: ConfigSchemaProperty = { type: 'string', 'x-sox-scope-default': SCOPE_DEFAULTS };

  it('maps keys to SOX_CONFIG_* exactly like buildExtConfigEnv', () => {
    expect(configEnvKey('db_path')).toBe('SOX_CONFIG_DB_PATH');
    expect(configEnvKey('recall-ceiling-ms')).toBe('SOX_CONFIG_RECALL_CEILING_MS');
  });

  it('returns the per-scope default for user and project', () => {
    expect(resolveRequiredConfigSeed('db_path', prop, 'user', {})).toEqual({ source: 'scope-default', value: SCOPE_DEFAULTS.user });
    expect(resolveRequiredConfigSeed('db_path', prop, 'project', {})).toEqual({ source: 'scope-default', value: SCOPE_DEFAULTS.project });
  });

  it('returns null for a scope with no declared default (local/org fail closed)', () => {
    expect(resolveRequiredConfigSeed('db_path', prop, 'local', {})).toBeNull();
    expect(resolveRequiredConfigSeed('db_path', prop, 'org', {})).toBeNull();
    expect(resolveRequiredConfigSeed('db_path', { type: 'string' }, 'user', {})).toBeNull();
  });

  it('an exported SOX_CONFIG_<KEY> outranks the scope default; blank env is absent', () => {
    expect(resolveRequiredConfigSeed('db_path', prop, 'project', { SOX_CONFIG_DB_PATH: '/tmp/x.db' }))
      .toEqual({ source: 'env', value: '/tmp/x.db', envKey: 'SOX_CONFIG_DB_PATH' });
    expect(resolveRequiredConfigSeed('db_path', prop, 'project', { SOX_CONFIG_DB_PATH: '  ' }))
      .toEqual({ source: 'scope-default', value: SCOPE_DEFAULTS.project });
  });

  it('ignores the generic x-sox-default (non-interactive installs do not start seeding every default)', () => {
    expect(resolveRequiredConfigSeed('port', { type: 'integer', 'x-sox-default': 9099 }, 'user', {})).toBeNull();
  });
});

// ── The real manifest ─────────────────────────────────────────────────────────

describe('memory-server manifest — BL 0c3522c2 seeds db_path per scope', () => {
  it('declares db_path required with user → memory.db and project → memory-dev.db', () => {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(REPO_ROOT, 'extensions/bundles/sox-memory-bundle/members/memory-server/extension.json'), 'utf8',
    )) as { config_schema: { required: string[]; properties: Record<string, ConfigSchemaProperty> } };
    expect(manifest.config_schema.required).toContain('db_path');
    const dbProp = manifest.config_schema.properties['db_path'];
    expect(dbProp?.['x-sox-scope-default']).toEqual({
      user: '~/.memory/memory.db',
      project: '~/.memory/memory-dev.db',
    });
  });
});

// ── End-to-end through the built CLI ──────────────────────────────────────────

let workspace: string;
let dataHome: string;
let savedHome: string | undefined;

function makeProbeExtension(root: string): string {
  const extDir = path.join(root, 'extensions', 'agents', PROBE);
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(path.join(extDir, 'extension.json'), JSON.stringify({
    $schema: 'https://your-registry/schemas/extension/v2.json',
    id: PROBE,
    version: '0.1.0',
    type: 'agent',
    title: `${PROBE} title`,
    description: `${PROBE} description`,
    compatibility: { host: '>=1.0.0 <2.0.0' },
    license: 'MIT',
    runtime: 'declarative',
    entrypoint: `${PROBE}.md`,
    install: { type: 'agent', hosts: ['opencode'] },
    config_schema: {
      type: 'object',
      additionalProperties: true,
      required: ['db_path'],
      properties: { db_path: { type: 'string', 'x-sox-scope-default': SCOPE_DEFAULTS } },
    },
  }, null, 2));
  fs.writeFileSync(path.join(extDir, 'package.json'),
    JSON.stringify({ name: `@adhd/sox-extension-${PROBE}`, version: '0.1.0', private: true }));
  fs.writeFileSync(path.join(extDir, `${PROBE}.md`), `---\nname: ${PROBE}\ndescription: probe\n---\n\n# ${PROBE}\n`);
  return extDir;
}

function runCli(args: string[], extraEnv: Record<string, string> = {}): { code: number; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, SOX_ECOSYSTEM_HOME: dataHome, ...extraEnv };
  // Never let the caller's shell leak an explicit value into the seed decision.
  if (!('SOX_CONFIG_DB_PATH' in extraEnv)) delete env['SOX_CONFIG_DB_PATH'];
  const r = spawnSync(process.execPath, [CLI_MAIN, ...args], { encoding: 'utf8', env, cwd: workspace });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

function seededDbPath(scope: 'user' | 'project' | 'local'): unknown {
  const p = scopeConfigPaths(scope, workspace).config;
  if (!fs.existsSync(p)) return undefined;
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8')) as { config?: Record<string, Record<string, unknown>> };
  return cfg.config?.[PROBE]?.['db_path'];
}

let savedSandbox: string | undefined;

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl0c35-'));
  workspace = path.join(base, 'workspace');
  dataHome = path.join(base, 'data');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(dataHome, { recursive: true });
  // scopeConfigPaths('user') reads SOX_ECOSYSTEM_HOME at call time.
  savedHome = process.env['SOX_ECOSYSTEM_HOME'];
  process.env['SOX_ECOSYSTEM_HOME'] = dataHome;
  // Host-side writes are NOT covered by SOX_ECOSYSTEM_HOME: without this, the
  // `install --scope user` case below writes bl0c35probe.md into the REAL
  // ~/.config/opencode/agents/ on every test run.
  savedSandbox = process.env['SOX_SANDBOX_ROOT'];
  process.env['SOX_SANDBOX_ROOT'] = base;
  makeProbeExtension(workspace);
});

afterEach(() => {
  if (savedHome === undefined) delete process.env['SOX_ECOSYSTEM_HOME'];
  else process.env['SOX_ECOSYSTEM_HOME'] = savedHome;
  if (savedSandbox === undefined) delete process.env['SOX_SANDBOX_ROOT'];
  else process.env['SOX_SANDBOX_ROOT'] = savedSandbox;
  fs.rmSync(path.dirname(workspace), { recursive: true, force: true });
});

describe('soxe install — BL 0c3522c2 seeds a required key from x-sox-scope-default', () => {
  it('user scope seeds the user default into the user config', () => {
    const r = runCli(['install', PROBE, '--scope', 'user', '--root', workspace]);
    expect(r.code, r.out).toBe(0);
    expect(seededDbPath('user')).toBe(SCOPE_DEFAULTS.user);
  });

  it('project scope seeds the project default into the project config', () => {
    const r = runCli(['install', PROBE, '--scope', 'project', '--root', workspace]);
    expect(r.code, r.out).toBe(0);
    expect(seededDbPath('project')).toBe(SCOPE_DEFAULTS.project);
  });

  it('an exported SOX_CONFIG_DB_PATH is persisted instead of the scope default', () => {
    const r = runCli(['install', PROBE, '--scope', 'project', '--root', workspace], { SOX_CONFIG_DB_PATH: '/tmp/explicit.db' });
    expect(r.code, r.out).toBe(0);
    expect(seededDbPath('project')).toBe('/tmp/explicit.db');
  });

  it('a value already set in the cascade is never overwritten', () => {
    const p = scopeConfigPaths('project', workspace).config;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ config: { [PROBE]: { db_path: '/tmp/hand-set.db' } } }, null, 2));
    const r = runCli(['install', PROBE, '--scope', 'project', '--root', workspace]);
    expect(r.code, r.out).toBe(0);
    expect(seededDbPath('project')).toBe('/tmp/hand-set.db');
  });

  it('local scope has no declared default: nothing is seeded and the install warns', () => {
    const r = runCli(['install', PROBE, '--scope', 'local', '--root', workspace]);
    expect(r.code, r.out).toBe(0);
    expect(seededDbPath('local')).toBeUndefined();
    expect(r.out).toMatch(/required config key 'db_path'/);
  });
});

// ── Extension NOT under --root (registry file:// row / npm-package store) ─────

describe('soxe install — BL 0c3522c2 seeds even when the manifest is not under --root', () => {
  it('findManifestForSource walks up from a file:// entrypoint to the matching extension.json', () => {
    const extDir = path.join(path.dirname(workspace), 'elsewhere', PROBE);
    fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'extension.json'), JSON.stringify({ id: PROBE, type: 'agent' }));
    fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), '');
    expect(findManifestForSource(`file://${path.join(extDir, 'dist', 'index.js')}`, PROBE)?.id).toBe(PROBE);
    expect(findManifestForSource(`file://${extDir}`, PROBE)?.id).toBe(PROBE);
    expect(findManifestForSource(`file://${extDir}`, 'some-other-id')).toBeNull();
    expect(findManifestForSource('npm-package:@x/y@1.0.0', PROBE)).toBeNull();
  });

  it('project install resolved through a registry file:// row outside --root still seeds db_path', async () => {
    // Move the probe out of the workspace: only the registry row points at it.
    const inRoot = path.join(workspace, 'extensions');
    const outside = path.join(path.dirname(workspace), 'outside');
    const extDir = makeProbeExtension(outside);
    fs.rmSync(inRoot, { recursive: true, force: true });
    const { checksum } = await fetchArtifact(`file://${extDir}`);
    fs.mkdirSync(path.join(workspace, 'registry'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'registry', 'index.json'), JSON.stringify([{
      id: PROBE, type: 'agent', title: PROBE, description: PROBE,
      source: `file://${extDir}`, checksum, compatibility: { host: '>=1.0.0 <2.0.0' },
    }], null, 2));
    const r = runCli(['install', PROBE, '--scope', 'project', '--root', workspace]);
    expect(r.code, r.out).toBe(0);
    expect(seededDbPath('project')).toBe(SCOPE_DEFAULTS.project);
  });
});
