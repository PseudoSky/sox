/**
 * service-enable-cwd-scope-5f98a1ff.spec.ts
 *
 * CLI-level integration regression for backlog
 * 5f98a1ff-eb07-4399-9369-6dba0ca57e7c:
 *   "soxe service enable resolves SOX_CONFIG_DB_PATH from a cwd-relative cascade
 *    and silently binds the dev store when run from a repo root."
 *
 * Drives the REAL built `dist/apps/sox/main.js` as a subprocess with cwd set to a
 * fake repo whose project config binds `db_path=<repo>/.memory/memory-dev.db`,
 * while the user config binds `db_path=<home>/.memory/user.db`.
 *
 *   - `service enable -s user` from that repo MUST render the USER store (a user
 *     unit must never consult the cwd-derived project scope) — the regression.
 *   - `service enable -s project` with NO --root MUST refuse with
 *     E_CWD_SCOPE_MISMATCH and write NOTHING (no unit file).
 *   - `service enable -s project --root=<repo>` MUST honour the explicit root and
 *     render the project store.
 *
 * Requires a prior `npx nx build sox` (the subprocess runs the built artifact).
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI_MAIN = path.resolve(__dirname, '../../../dist/apps/sox/main.js');
const UID = '5f98a1ff-eb07-4399-9369-6dba0ca57e7c';

let base: string;
let home: string;
let repo: string;
let unitDir: string;
let userStorePath: string;
let devStorePath: string;

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI_MAIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SOX_ECOSYSTEM_HOME: home, SOX_OS_UNIT_DIR: unitDir },
    cwd: repo,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function materializeStore(storeRoot: string): void {
  const extDir = path.join(storeRoot, 'ext', 'test-daemon');
  fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(extDir, 'extension.json'),
    JSON.stringify({
      id: 'test-daemon',
      type: 'service',
      entrypoint: 'dist/index.js',
      lifecycle: { background: true, singleton: true, stop_timeout_ms: 5000 },
    }),
  );
  fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), 'process.exit(0);\n');
  fs.writeFileSync(
    path.join(storeRoot, 'extensions.lock'),
    JSON.stringify({
      version: 1,
      resolved: {
        'test-daemon@1.0.0': { version: '1.0.0', source: `file://${extDir}`, checksum: 'sha256:test' },
      },
    }),
  );
}

function writeConfig(cfgPath: string, block: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify({ config: { 'test-daemon': block } }, null, 2), 'utf8');
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-cwdscope-5f98a1ff-'));
  home = path.join(base, 'home');
  repo = path.join(base, 'repo');
  unitDir = path.join(base, 'units');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(unitDir, { recursive: true });

  userStorePath = path.join(home, '.memory', 'user.db');
  devStorePath = path.join(repo, '.memory', 'memory-dev.db');

  // user-scope install + config (the CORRECT store for a user unit)
  materializeStore(home);
  writeConfig(path.join(home, 'extensions.json'), { db_path: userStorePath });

  // project-scope install + config at the cwd (the DEV store — the bug's payload)
  const projectRoot = path.join(repo, '.adhd', 'sox-ecosystem');
  materializeStore(projectRoot);
  writeConfig(path.join(projectRoot, 'extensions.json'), { db_path: devStorePath });
});

afterEach(() => {
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function solePlist(): string {
  const f = fs.readdirSync(unitDir).find((n) => n.endsWith('.plist'));
  expect(f, 'a plist should have been written').toBeDefined();
  return fs.readFileSync(path.join(unitDir, f!), 'utf8');
}

describe(`soxe service enable — scope-deterministic store binding (backlog ${UID})`, () => {
  it(`a USER unit enabled from a repo cwd binds the user store, never the project/dev store (backlog ${UID})`, () => {
    const r = runCli(['service', 'enable', 'test-daemon', '-s', 'user', '--supervisor', 'launchd', '--allow-volatile-node', '--dry-run']);
    expect(r.code).toBe(0);

    const plist = solePlist();
    expect(plist).toContain(userStorePath);
    // the regression: the cwd's project scope must NOT leak into a user unit
    expect(plist).not.toContain('memory-dev.db');
  });

  it(`refuses 'service enable -s project' with no --root under code E_CWD_SCOPE_MISMATCH, writing nothing (backlog ${UID})`, () => {
    const before = fs.existsSync(unitDir) ? fs.readdirSync(unitDir).length : 0;
    const r = runCli(['service', 'enable', 'test-daemon', '-s', 'project', '--supervisor', 'launchd', '--allow-volatile-node', '--dry-run']);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain('E_CWD_SCOPE_MISMATCH');
    // nothing was written
    expect(fs.readdirSync(unitDir).length).toBe(before);
  });

  it(`honours an explicit --root for a project unit (backlog ${UID})`, () => {
    const r = runCli(['service', 'enable', 'test-daemon', '-s', 'project', '--root', repo, '--supervisor', 'launchd', '--allow-volatile-node', '--dry-run']);
    expect(r.code).toBe(0);
    const plist = solePlist();
    expect(plist).toContain(devStorePath);
  });
});
