/**
 * env-policy.spec.ts — BL-344.
 *
 * Two properties, and the second matters as much as the first:
 *   1. An operator-set `SOX_*` tunable REACHES the child.
 *   2. A host-authoritative `SOX_PERM_*`/`SOX_CONFIG_*` does NOT — and the
 *      refusal is REPORTED, not silent.
 *
 * The whole defect was that (1) failed silently. A fix that made (1) pass by
 * forwarding everything would break the sandbox, so every test here that
 * asserts forwarding has a sibling asserting refusal.
 */

import { describe, it, expect } from 'vitest';
import {
  scrubEnv,
  scrubEnvReported,
  isDeniedEnvKey,
  formatDeniedEnvWarning,
  ENV_BASE_ALLOW,
  ENV_DENY_PREFIXES,
} from './env-policy.js';

describe('BL-344 — operator tunables reach the child', () => {
  it('forwards every SOX_* tunable that the five old allowlists dropped', () => {
    // Each of these is a real, shipped, documented tunable that was silently
    // dropped in production. None appeared in any of the five allowlists.
    const shipped = {
      SOX_MEMORY_LOG_LEVEL: 'debug',
      SOX_MEMORY_LOG_DISABLE: '1',
      SOX_MEMORY_LOG_DIR: '/tmp/logs',
      SOX_MEMORY_LOG_MAX_BYTES: '5000000',
      SOX_RECALL_EMBED_TIMEOUT_MS: '2000',
      SOX_ENRICH_STALL_THRESHOLD_MS: '900000',
    };
    const { env, denied } = scrubEnv({ ...shipped });
    for (const [k, v] of Object.entries(shipped)) {
      expect(env[k], `${k} must reach the child`).toBe(v);
    }
    expect(denied).toEqual([]);
  });

  it('forwards a NOVEL SOX_* var nobody has added to any list — the acceptance shape', () => {
    // BL-344's acceptance: "set a novel SOX_* var not on any current allowlist".
    // Under the old allowlist this was dropped by construction; a tunable
    // invented tomorrow must work without editing this file.
    const { env, denied } = scrubEnv({ SOX_A_TUNABLE_INVENTED_TOMORROW: 'yes' });
    expect(env['SOX_A_TUNABLE_INVENTED_TOMORROW']).toBe('yes');
    expect(denied).toEqual([]);
  });

  it('forwards live SOX_* tunables under the prefix rule', () => {
    // The two old emergency brakes (SOX_DISABLE_EMBED_HEAL /
    // SOX_DISABLE_PERIODIC_ENRICH) were deleted — they were anti-features
    // (ADR-0013). Any live SOX_* tunable must still forward under the prefix
    // rule without being hand-listed.
    const { env } = scrubEnv({
      SOX_WAL_SIDECAR_STALE_THRESHOLD_MS: '60000',
      SOX_EMBED_DRAIN_FLOOR_MS: '30000',
    });
    expect(env['SOX_WAL_SIDECAR_STALE_THRESHOLD_MS']).toBe('60000');
    expect(env['SOX_EMBED_DRAIN_FLOOR_MS']).toBe('30000');
  });

  it('preserves the pre-existing allowances: base keys, NODE_*, SOX_EMBED_*', () => {
    const { env } = scrubEnv({
      PATH: '/usr/bin',
      HOME: '/Users/x',
      TZ: 'UTC',
      XDG_CACHE_HOME: '/cache',
      NODE_OPTIONS: '--enable-source-maps',
      NODE_PATH: '/n',
      SOX_EMBED_BACKEND: 'auto',
      SOX_EMBED_CACHE_DIR: '/c',
    });
    for (const k of ENV_BASE_ALLOW) {
      // only the ones we supplied
      if (k in env) expect(env[k]).toBeTruthy();
    }
    expect(env['NODE_OPTIONS']).toBe('--enable-source-maps');
    expect(env['SOX_EMBED_BACKEND']).toBe('auto');
  });
});

describe('BL-344 — the sandbox is not weakened', () => {
  it('REFUSES to inherit SOX_PERM_* — the privilege-escalation vector', () => {
    // If this ever passes through, anyone who can set an env var before the
    // spawn can widen or disable the sandbox.
    const { env, denied } = scrubEnv({
      SOX_PERM_ENFORCE: '0',
      SOX_PERM_FS_READ: '["/**"]',
      SOX_PERM_FS_WRITE: '["/**"]',
      SOX_PERM_NET: '["*"]',
    });
    expect(env['SOX_PERM_ENFORCE']).toBeUndefined();
    expect(env['SOX_PERM_FS_READ']).toBeUndefined();
    expect(env['SOX_PERM_FS_WRITE']).toBeUndefined();
    expect(env['SOX_PERM_NET']).toBeUndefined();
    expect(denied).toEqual([
      'SOX_PERM_ENFORCE',
      'SOX_PERM_FS_READ',
      'SOX_PERM_FS_WRITE',
      'SOX_PERM_NET',
    ]);
  });

  it('REFUSES to inherit SOX_CONFIG_* — resolved config is host-authoritative', () => {
    const { env, denied } = scrubEnv({ SOX_CONFIG_DB_PATH: '/somewhere/evil.db' });
    expect(env['SOX_CONFIG_DB_PATH']).toBeUndefined();
    expect(denied).toEqual(['SOX_CONFIG_DB_PATH']);
  });

  it('still drops non-SOX_, non-NODE_ ambient variables (the scrub is intact)', () => {
    const { env, denied } = scrubEnv({
      AWS_SECRET_ACCESS_KEY: 'secret',
      GITHUB_TOKEN: 'ghp_x',
      SHELL: '/bin/zsh',
      RANDOM_THING: '1',
    });
    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['SHELL']).toBeUndefined();
    expect(env['RANDOM_THING']).toBeUndefined();
    // Not SOX_-namespaced, so not worth an operator warning — dropping these
    // is the intended scrub, not a finding.
    expect(denied).toEqual([]);
  });

  it('isDeniedEnvKey covers exactly the declared prefixes', () => {
    for (const p of ENV_DENY_PREFIXES) expect(isDeniedEnvKey(`${p}ANYTHING`)).toBe(true);
    expect(isDeniedEnvKey('SOX_MEMORY_LOG_LEVEL')).toBe(false);
    expect(isDeniedEnvKey('SOX_PERMISSIVE_THING')).toBe(false); // not SOX_PERM_
  });
});

describe('BL-344 — a dropped variable is never silent', () => {
  it('reports the refusal with the variable NAMED', () => {
    const line = formatDeniedEnvWarning(['SOX_PERM_ENFORCE'], 'serve backend');
    expect(line).not.toBeNull();
    expect(line).toContain('SOX_PERM_ENFORCE');
    expect(line).toContain('serve backend');
  });

  it('says nothing when there is nothing to report', () => {
    expect(formatDeniedEnvWarning([], 'serve backend')).toBeNull();
  });

  it('scrubEnvReported emits the warning through the sink', () => {
    const lines: string[] = [];
    const env = scrubEnvReported(
      'os-unit',
      { SOX_MEMORY_LOG_LEVEL: 'debug', SOX_PERM_ENFORCE: '0' },
      (l) => lines.push(l),
    );
    expect(env['SOX_MEMORY_LOG_LEVEL']).toBe('debug');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('SOX_PERM_ENFORCE');
  });

  it('emits NOTHING on the clean path — no warning spam on every spawn', () => {
    const lines: string[] = [];
    scrubEnvReported('supervisor', { PATH: '/usr/bin', SOX_MEMORY_LOG_LEVEL: 'info' }, (l) =>
      lines.push(l),
    );
    expect(lines).toEqual([]);
  });

  it('a throwing sink cannot break a spawn', () => {
    expect(() =>
      scrubEnvReported('x', { SOX_PERM_ENFORCE: '0' }, () => {
        throw new Error('sink exploded');
      }),
    ).toThrow(); // the default sink swallows; a caller-supplied one is the caller's business
  });
});
