/**
 * env-policy-spawn.spec.ts — BL-344 acceptance, on a REAL spawned process.
 *
 * `env-policy.spec.ts` tests the scrub function. This file tests the thing that
 * actually failed in production: what is present in the environment of a child
 * that `ProcessSupervisor` really spawned, under `policy.enforced`.
 *
 * That distinction is the whole reason BL-344 took hours to find. The var WAS
 * present in the generated launchd `.plist` and ABSENT from `ps eww <backend-pid>`,
 * so every check that stopped short of the running process reported a false
 * green. BL-344's acceptance therefore demands a spawned process, and this
 * suite spawns one: a real `node` child that writes its own `process.env` to a
 * file, which we then read back.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessSupervisor } from './supervisor.js';

let dir: string;
let childScript: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bl344-spawn-'));
  childScript = join(dir, 'dump-env.cjs');
  // The child records its OWN environment — the only evidence that counts.
  writeFileSync(
    childScript,
    `const fs = require('node:fs');
     fs.writeFileSync(process.argv[2], JSON.stringify(process.env));
     setInterval(() => {}, 1000);   // stay alive; the supervisor stops us
    `,
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Spawn a real child through the ENFORCED policy path and return its env. */
async function spawnAndReadChildEnv(label: string): Promise<Record<string, string>> {
  const out = join(dir, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  const sup = new ProcessSupervisor({
    key: `bl344-${label}-${Math.random().toString(36).slice(2, 8)}`,
    entrypointPath: childScript,
    args: [out],
    // A permissions block is what flips policy.enforced -> true, which is the
    // branch that scrubs. Without it the child inherits process.env wholesale
    // and the test would prove nothing.
    permissions: { fs: { read: [dir + '/**'], write: [dir + '/**'] } },
    lifecycle: {},
  });

  await sup.start();
  // The child writes synchronously on startup; poll briefly for the file.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !existsSync(out)) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const raw = existsSync(out) ? readFileSync(out, 'utf8') : '';
  await sup.stop();
  expect(raw, 'child never wrote its env — spawn failed').not.toBe('');
  return JSON.parse(raw) as Record<string, string>;
}

describe('BL-344 — acceptance on a real spawned process', () => {
  it('a NOVEL SOX_* tunable reaches the spawned child', async () => {
    // BL-344 acceptance (1): "set a novel SOX_* var not on any current
    // allowlist ... assert the var IS present". Under the five old allowlists
    // this was dropped by construction, silently, for every spawn path.
    const key = 'SOX_BL344_NOVEL_TUNABLE';
    const prev = process.env[key];
    process.env[key] = 'reached-the-child';
    try {
      const childEnv = await spawnAndReadChildEnv('novel');
      expect(childEnv[key]).toBe('reached-the-child');
    } finally {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  }, 20_000);

  it('the real shipped tunables that were silently dropped now arrive', async () => {
    // Each of these was documented, shipped, and non-functional in the deployed
    // configuration — including the recall guard and the telemetry rotation cap.
    const vars = {
      SOX_MEMORY_LOG_LEVEL: 'debug',
      SOX_MEMORY_LOG_MAX_BYTES: '5000000',
      SOX_RECALL_EMBED_TIMEOUT_MS: '2000',
      SOX_DISABLE_EMBED_HEAL: '1',
      SOX_DISABLE_PERIODIC_ENRICH: '1',
    };
    const prev: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      prev[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      const childEnv = await spawnAndReadChildEnv('shipped');
      for (const [k, v] of Object.entries(vars)) {
        expect(childEnv[k], `${k} must reach the spawned child`).toBe(v);
      }
    } finally {
      for (const k of Object.keys(vars)) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  }, 20_000);

  it('an inherited SOX_PERM_* does NOT widen the spawned child\'s sandbox', async () => {
    // BL-344 acceptance (2), the security half. Forwarding `SOX_*` would be a
    // privilege-escalation vector without this deny rule, so it is asserted on
    // the real child, not just on the pure function.
    const prevEnforce = process.env['SOX_PERM_ENFORCE'];
    const prevWrite = process.env['SOX_PERM_FS_WRITE'];
    process.env['SOX_PERM_ENFORCE'] = '0';
    process.env['SOX_PERM_FS_WRITE'] = '["/**"]';
    try {
      const childEnv = await spawnAndReadChildEnv('perm');
      // Enforcement stays ON and the inherited widening is gone: the
      // authoritative policy is applied after the scrub.
      expect(childEnv['SOX_PERM_ENFORCE']).toBe('1');
      expect(childEnv['SOX_PERM_FS_WRITE']).not.toBe('["/**"]');
    } finally {
      if (prevEnforce === undefined) delete process.env['SOX_PERM_ENFORCE'];
      else process.env['SOX_PERM_ENFORCE'] = prevEnforce;
      if (prevWrite === undefined) delete process.env['SOX_PERM_FS_WRITE'];
      else process.env['SOX_PERM_FS_WRITE'] = prevWrite;
    }
  }, 20_000);

  it('NEGATIVE CONTROL: an arbitrary non-SOX_ var is still scrubbed from the child', async () => {
    // Proves the scrub is intact and this suite is not passing because
    // everything leaks. Without this, all three tests above would also pass
    // against a plain `...process.env` passthrough.
    const key = 'BL344_ARBITRARY_SECRET';
    const prev = process.env[key];
    process.env[key] = 'must-not-leak';
    try {
      const childEnv = await spawnAndReadChildEnv('negative');
      expect(childEnv[key]).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  }, 20_000);
});
