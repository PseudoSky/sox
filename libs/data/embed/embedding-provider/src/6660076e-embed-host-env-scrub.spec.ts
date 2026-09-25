/**
 * 6660076e — the embedding host never inherits its spawner's identity env
 * (ADR-0022 §5, docs/spec/service-lifecycle.md §5).
 *
 * The host used to be spawned with the spawner's whole env, including
 * `SOX_SERVICE_ID`. `findOrphansByServiceId` and the OS-truth `ps` pass then
 * treated the shared host as memory-server's own process, so a memory-server
 * restart reaped it. `buildEmbedHostEnv` forwards an allowlist and denies the
 * identity/config/permission keys, reporting each denied key by name.
 */
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEmbedHostEnv } from './embedHostConfig.js';
import { FunneledFastembedClient } from './funnelClient.js';
import {
  applyEnv,
  destroyFunnelDir,
  funnelEnvVars,
  hostPids,
  makeFunnelDir,
} from './test-support/funnelHarness.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

describe('6660076e — buildEmbedHostEnv', () => {
  const parent: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    USER: 'u',
    LOGNAME: 'u',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    LC_CTYPE: 'UTF-8',
    TZ: 'UTC',
    TMPDIR: '/tmp/',
    XDG_CACHE_HOME: '/home/u/.cache',
    HTTPS_PROXY: 'http://proxy:3128',
    NODE_OPTIONS: '--import tsx',
    NODE_EXTRA_CA_CERTS: '/ca.pem',
    SOX_ECOSYSTEM_HOME: '/data',
    SOX_EMBED_EXECUTION_PROVIDER: 'cpu',
    SOX_SERVICE_ID: 'memory-server',
    SOX_TELEMETRY_INIT: '{"service":"memory-server"}',
    SOX_CONFIG_DB_PATH: '/db',
    SOX_PERM_FS: 'rw',
    SOX_PROXY_BACKEND: '1',
    SOX_EMBED_HOST_MAIN: '/x.js',
    TERM: 'xterm',
    SECRET_TOKEN: 'shh',
    AWS_ACCESS_KEY_ID: 'AKIA',
  };

  it.each([
    ['PATH', true],
    ['HOME', true],
    ['USER', true],
    ['LOGNAME', true],
    ['LANG', true],
    ['LC_ALL', true],
    ['LC_CTYPE', true],
    ['TZ', true],
    ['TMPDIR', true],
    ['XDG_CACHE_HOME', true],
    ['HTTPS_PROXY', true],
    ['NODE_OPTIONS', true],
    ['NODE_EXTRA_CA_CERTS', true],
    ['SOX_ECOSYSTEM_HOME', true],
    ['SOX_EMBED_EXECUTION_PROVIDER', true],
    ['SOX_SERVICE_ID', false],
    ['SOX_TELEMETRY_INIT', false],
    ['SOX_CONFIG_DB_PATH', false],
    ['SOX_PERM_FS', false],
    ['SOX_PROXY_BACKEND', false],
    ['SOX_EMBED_HOST_MAIN', false],
    ['TERM', false],
    ['SECRET_TOKEN', false],
    ['AWS_ACCESS_KEY_ID', false],
  ])('%s forwarded = %s', (key, forwarded) => {
    const { env } = buildEmbedHostEnv(parent);
    expect(key in env).toBe(forwarded);
    if (forwarded) expect(env[key]).toBe(parent[key]);
  });

  it('names every denied key (never silent) and every dropped key', () => {
    const { denied, dropped } = buildEmbedHostEnv(parent);
    expect(denied).toEqual([
      'SOX_CONFIG_DB_PATH',
      'SOX_EMBED_HOST_MAIN',
      'SOX_PERM_FS',
      'SOX_PROXY_BACKEND',
      'SOX_SERVICE_ID',
      'SOX_TELEMETRY_INIT',
    ]);
    expect(dropped).toEqual(['AWS_ACCESS_KEY_ID', 'SECRET_TOKEN', 'TERM']);
  });
});

describe('6660076e — a live host spawned by a service carries none of its identity env', () => {
  it('ps -E shows no SOX_SERVICE_ID / SOX_CONFIG_* / SOX_PERM_* on the host; provenance is argv', async () => {
    const f = makeFunnelDir('sox-6660076e');
    cleanups.push(() => destroyFunnelDir(f));
    cleanups.push(
      applyEnv({
        ...funnelEnvVars(f),
        SOX_SERVICE_ID: 'memory-server-test',
        SOX_CONFIG_DB_PATH: '/nonexistent/memory.db',
        SOX_PERM_FS: 'rw',
      }),
    );

    const client = new FunneledFastembedClient();
    await client.request({ type: 'init', model: 'stub', cacheDir: f.cache }, 30_000);
    const [pid] = hostPids(f.shimPath);
    expect(pid).toBeDefined();

    // BSD/macOS `ps -E` appends the process environment to its command line.
    const withEnv = execFileSync('ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    expect(withEnv).toContain(f.shimPath);
    const tokens = withEnv.split(/\s+/);
    expect(tokens.filter((t) => t.startsWith('SOX_SERVICE_ID='))).toEqual([]);
    expect(tokens.filter((t) => t.startsWith('SOX_CONFIG_'))).toEqual([]);
    expect(tokens.filter((t) => t.startsWith('SOX_PERM_'))).toEqual([]);
    // Positive control: the env IS visible, and forwarded keys are present.
    expect(tokens.some((t) => t.startsWith('SOX_ECOSYSTEM_HOME='))).toBe(true);
    // Provenance survives as a single `--flag=value` argv element.
    expect(tokens).toContain('--spawner-service=memory-server-test');
  }, 60_000);
});
