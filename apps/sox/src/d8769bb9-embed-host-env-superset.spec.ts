/**
 * d8769bb9 — the embed-host env allowlist must stay a superset of
 * `env-policy.ts`'s `ENV_BASE_ALLOW`.
 *
 * `libs/data/embed/embedding-provider/src/embedHostConfig.ts` maintains its
 * own `EMBED_HOST_ENV_FORWARD_EXACT` set, hand-copied from `ENV_BASE_ALLOW`
 * rather than importing it, because `embedding-provider` is tagged
 * `area:data` and `env-policy.ts` lives in `@adhd/sox-host-runtime`
 * (`area:platform`) — `eslint.config.js`'s `@nx/enforce-module-boundaries`
 * `depConstraints` restrict `area:data` to `onlyDependOnLibsWithTags:
 * ['area:data', 'area:shared']`, so a direct import is not available. Both
 * packages are public (ADR-0006 is not the blocker here — it governs a
 * public package bundling a PRIVATE `@adhd/sox-*` lib; the area-tag
 * direction is what forbids this specific import).
 *
 * `apps/sox` (`type:app`, no `area:*` tag) is unconstrained by the area rule
 * and already depends on `@adhd/sox-host-runtime`; this spec adds
 * `@adhd/sox-embedding-provider` as a devDependency so ONE test can see both
 * lists and assert the equivalence the two hand-maintained copies rely on:
 * every key `env-policy.ts` forwards to an in-process child, the embed host
 * must also forward, otherwise a var that reaches every OTHER spawned child
 * silently stops at the embed host's boundary.
 *
 * Deleting `'TMPDIR'` from `EMBED_HOST_ENV_FORWARD_EXACT` in
 * `embedHostConfig.ts` fails this spec's `forwards TMPDIR` case with
 * `dropped: ['TMPDIR']` instead of `env: { TMPDIR: 'v' }`.
 */
import { describe, expect, it } from 'vitest';
import { ENV_BASE_ALLOW } from '@adhd/sox-host-runtime';
import { buildEmbedHostEnv } from '@adhd/sox-embedding-provider';

describe('d8769bb9: embed-host env allowlist is a superset of ENV_BASE_ALLOW', () => {
  for (const key of ENV_BASE_ALLOW) {
    it(`forwards ${key}`, () => {
      const { env, denied, dropped } = buildEmbedHostEnv({ [key]: 'v' });
      expect(dropped).not.toContain(key);
      expect(denied).not.toContain(key);
      expect(env[key]).toBe('v');
    });
  }

  it('does not silently regress if ENV_BASE_ALLOW grows without embedHostConfig.ts following', () => {
    // Sanity: the loop above is non-empty, so a future key added to
    // ENV_BASE_ALLOW without a matching embed-host entry fails a NEW `it`
    // block automatically, by construction of the loop — this assertion
    // just documents that ENV_BASE_ALLOW is non-trivial so the loop is
    // exercising real cases, not vacuously passing on an empty list.
    expect(ENV_BASE_ALLOW.length).toBeGreaterThan(0);
  });
});
