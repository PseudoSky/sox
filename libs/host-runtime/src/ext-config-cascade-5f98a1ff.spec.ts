/**
 * libs/host-runtime/src/ext-config-cascade-5f98a1ff.spec.ts
 *
 * Regression for backlog 5f98a1ff-eb07-4399-9369-6dba0ca57e7c:
 *   "soxe service enable resolves SOX_CONFIG_DB_PATH from a cwd-relative cascade
 *    and silently binds the dev store when run from a repo root."
 *
 * The cascade must be SCOPE-DETERMINISTIC: a user/org unit's config never comes
 * from the cwd-derived project/local scopes, and project/local require an explicit
 * root (refusing, with E_CWD_SCOPE_MISMATCH, rather than falling back to cwd).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  E_CWD_SCOPE_MISMATCH,
  CwdScopeMismatchError,
  cascadeScopesForUnitScope,
  assertScopeConsistent,
  buildScopeDeterministicExtConfigEnv,
} from './ext-config-cascade.js';

const UID = '5f98a1ff-eb07-4399-9369-6dba0ca57e7c';

let tmpRoot: string;
let home: string;
let projectRoot: string;
const savedHome = process.env['SOX_ECOSYSTEM_HOME'];

function writeConfig(configPath: string, extId: string, block: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ config: { [extId]: block } }, null, 2), 'utf8');
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-cascade-5f98a1ff-'));
  home = path.join(tmpRoot, 'home');
  projectRoot = path.join(tmpRoot, 'repo');
  fs.mkdirSync(home, { recursive: true });
  process.env['SOX_ECOSYSTEM_HOME'] = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env['SOX_ECOSYSTEM_HOME'];
  else process.env['SOX_ECOSYSTEM_HOME'] = savedHome;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe(`scope-deterministic cascade — backlog ${UID}`, () => {
  it(`names the participating scopes per unit scope (backlog ${UID})`, () => {
    expect(cascadeScopesForUnitScope('org')).toEqual(['org']);
    expect(cascadeScopesForUnitScope('user')).toEqual(['org', 'user']);
    expect(cascadeScopesForUnitScope('project')).toEqual(['org', 'user', 'project']);
    expect(cascadeScopesForUnitScope('local')).toEqual(['org', 'user', 'project', 'local']);
  });

  it(`refuses a project-scope cascade with no explicit root under code E_CWD_SCOPE_MISMATCH (backlog ${UID})`, () => {
    let caught: unknown;
    try {
      buildScopeDeterministicExtConfigEnv('svc', 'project', undefined);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CwdScopeMismatchError);
    expect((caught as CwdScopeMismatchError).code).toBe(E_CWD_SCOPE_MISMATCH);
    expect((caught as Error).message).toContain(E_CWD_SCOPE_MISMATCH);
    // local too
    expect(() => buildScopeDeterministicExtConfigEnv('svc', 'local', '')).toThrowError(
      CwdScopeMismatchError,
    );
  });

  it(`never binds the project store sitting at the cwd/root into a USER unit (backlog ${UID})`, () => {
    const userDb = path.join(home, '.memory', 'user.db');
    // user-scope config ⇒ the correct store for a user unit
    writeConfig(path.join(home, 'extensions.json'), 'svc', {
      db_path: userDb,
    });
    // project-scope config at the invocation root ⇒ the DEV store (the bug's payload)
    writeConfig(path.join(projectRoot, '.adhd', 'sox-ecosystem', 'extensions.json'), 'svc', {
      db_path: path.join(projectRoot, '.memory', 'memory-dev.db'),
    });

    // Pass projectRoot as `root` — for a user unit it MUST be ignored.
    const { env, provenance } = buildScopeDeterministicExtConfigEnv('svc', 'user', projectRoot);

    expect(env['SOX_CONFIG_DB_PATH']).toBe(userDb);
    expect(env['SOX_CONFIG_DB_PATH']).not.toContain('memory-dev.db');
    expect(provenance['SOX_CONFIG_DB_PATH']).toBe('user');
  });

  it(`refuses a cross-scope winner at the write boundary (backlog ${UID})`, () => {
    expect(() => assertScopeConsistent('user', { SOX_CONFIG_DB_PATH: 'project' })).toThrowError(
      CwdScopeMismatchError,
    );
    expect(() => assertScopeConsistent('org', { SOX_CONFIG_DB_PATH: 'local' })).toThrowError(
      CwdScopeMismatchError,
    );
    // in-scope winners are accepted
    expect(() => assertScopeConsistent('user', { SOX_CONFIG_DB_PATH: 'user' })).not.toThrow();
    expect(() => assertScopeConsistent('user', { SOX_CONFIG_DB_PATH: 'org' })).not.toThrow();
  });
});
