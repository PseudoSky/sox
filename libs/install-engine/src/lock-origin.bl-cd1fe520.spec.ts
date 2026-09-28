/**
 * libs/install-engine/src/lock-origin.bl-cd1fe520.spec.ts
 *
 * BL-cd1fe520 — an `npm-package:` install wrote a SELF-REFERENTIAL lockfile
 * entry, so `soxe upgrade --all` could never see a newer published version.
 *
 * Root cause: `fetchArtifact`'s `npm-package:` branch npm-installs the package
 * into the per-extension content store (`<dataRoot>/ext/<id>/node_modules/…`) and
 * returns `file://<that installed entry file>` as the resolved source. `install()`
 * persisted ONLY that string, so the lockfile forgot where the bytes came from.
 * `verifyIntegrity` — the sole is-this-current check — then hashed the installed
 * file and compared it with the checksum taken from that very same file: a
 * tautology that reports `current` forever, no matter how far the registry pin
 * has moved on. Live shape (2026-09-28): memory-server locked to
 * `file://~/.adhd/sox-ecosystem/ext/memory-server/node_modules/@adhd/sox-extension-memory-server/dist/index.js`
 * and `upgrade memory-server --all` answered "current — no change" for 38
 * consumers.
 *
 * Contract pinned here, driven through the REAL built CLI
 * (dist/apps/sox/main.js) against a sandboxed HOME + SOX_ECOSYSTEM_HOME, with a
 * fake `npm` on PATH so no network or real npm registry is involved:
 *   1. After an npm-package install the lock entry records its true `origin`
 *      (the registry package spec), not only the materialized path.
 *   2. When the registry row moves to a new published version, `upgrade --all`
 *      reports STALE, re-installs, and re-pins the lock to the new version.
 *   3. A legacy self-referential entry (no `origin`, written by the old engine)
 *      is also detected as stale once the registry pin differs.
 */

import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scopeConfigPaths } from './data-paths.js';
import { mergeLockEntry, resolveDesiredPin, type LockfileEntry } from './install.js';
import { verifyIntegrity } from './verify-integrity.js';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const CLI_MAIN = path.join(REPO_ROOT, 'dist/apps/sox/main.js');
const ID = 'bl-cd1fe520-probe';
const PKG = `@adhd/sox-extension-${ID}`;

let sandbox: string;
let workspace: string;
let dataHome: string;
let fakeHome: string;
let fakeBin: string;
let pkgFixtures: string;

function sha256(s: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(s).digest('hex');
}

function entryBody(version: string): string {
  return `// ${PKG} ${version}\nmodule.exports = { version: ${JSON.stringify(version)} };\n`;
}

/** Stage a publishable package fixture the fake npm will "download". */
function stagePackage(version: string): void {
  const dir = path.join(pkgFixtures, `${PKG.replace('/', '__')}@${version}`);
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: PKG, version, main: 'dist/index.js' }, null, 2));
  fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify({
    id: ID,
    version,
    type: 'command',
    title: `${ID} title`,
    description: `${ID} description`,
    compatibility: { host: '>=1.0.0 <2.0.0' },
    license: 'MIT',
    runtime: 'node',
    entrypoint: 'dist/index.js',
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'dist', 'index.js'), entryBody(version));
}

/** Point the workspace registry at `version` of the probe package. */
function publishRow(version: string): void {
  fs.mkdirSync(path.join(workspace, 'registry'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'registry', 'index.json'), JSON.stringify([{
    id: ID,
    type: 'command',
    version,
    title: `${ID} title`,
    description: `${ID} description`,
    source: `npm-package:${PKG}@${version}`,
    checksum: sha256(entryBody(version)),
    compatibility: { host: '>=1.0.0 <2.0.0' },
  }], null, 2));
}

/**
 * Fake `npm install <name>@<version> …`: copies the staged fixture into
 * `<cwd>/node_modules/<name>`, exactly the layout a real `npm install` leaves.
 */
function writeFakeNpm(): void {
  fs.mkdirSync(fakeBin, { recursive: true });
  const script = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] !== 'install') { process.stderr.write('fake npm: unsupported ' + args.join(' ') + '\\n'); process.exit(2); }
const spec = args[1];
const at = spec.lastIndexOf('@');
const name = spec.slice(0, at);
const src = path.join(process.env.FAKE_NPM_PKGS, name.replace('/', '__') + '@' + spec.slice(at + 1));
if (!fs.existsSync(src)) { process.stderr.write('fake npm: no fixture for ' + spec + '\\n'); process.exit(1); }
const dst = path.join(process.cwd(), 'node_modules', ...name.split('/'));
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
`;
  fs.writeFileSync(path.join(fakeBin, 'npm'), script, { mode: 0o755 });
}

function runCli(args: string[]): { code: number; out: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fakeHome,
    SOX_ECOSYSTEM_HOME: dataHome,
    FAKE_NPM_PKGS: pkgFixtures,
    PATH: `${fakeBin}${path.delimiter}${process.env['PATH'] ?? ''}`,
  };
  const r = spawnSync(process.execPath, [CLI_MAIN, ...args], { encoding: 'utf8', env, cwd: workspace });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

function lockPath(): string {
  return scopeConfigPaths('project', workspace).lockfile;
}

function readLockEntry(): Record<string, unknown> {
  const lock = JSON.parse(fs.readFileSync(lockPath(), 'utf8')) as { resolved: Record<string, Record<string, unknown>> };
  const entry = lock.resolved[ID];
  if (entry === undefined) throw new Error(`no lock entry for ${ID} in ${lockPath()}`);
  return entry;
}

function installProbe(): { code: number; out: string } {
  return runCli(['install', ID, '--scope', 'project', '--root', workspace]);
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-cd1fe520-'));
  workspace = path.join(sandbox, 'ws');
  dataHome = path.join(sandbox, 'data');
  fakeHome = path.join(sandbox, 'home');
  fakeBin = path.join(sandbox, 'bin');
  pkgFixtures = path.join(sandbox, 'pkgs');
  for (const d of [workspace, dataHome, fakeHome, pkgFixtures]) fs.mkdirSync(d, { recursive: true });
  writeFakeNpm();
  stagePackage('1.0.0');
  stagePackage('1.1.0');
  publishRow('1.0.0');
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('BL-cd1fe520 — npm-package lock entry records its origin; upgrade compares against it', () => {
  it('precondition: the built CLI exists', () => {
    expect(fs.existsSync(CLI_MAIN), `build first: npx nx build sox (${CLI_MAIN})`).toBe(true);
  });

  it('records the registry package spec as origin, not only the self-referential installed path', () => {
    const r = installProbe();
    expect(r.code, r.out).toBe(0);
    const entry = readLockEntry();
    const storeEntry = path.join(dataHome, 'ext'); // never used as the origin
    // The materialized artifact is still where the runtime loads it from…
    expect(String(entry['source'])).toContain(path.join('node_modules', ...PKG.split('/'), 'dist', 'index.js'));
    // …but the lock now remembers where those bytes came from.
    expect(entry['origin'], JSON.stringify(entry)).toBe(`npm-package:${PKG}@1.0.0`);
    expect(String(entry['origin'])).not.toContain(storeEntry);
    expect(entry['checksum']).toBe(sha256(entryBody('1.0.0')));
  });

  it('upgrade --all detects a newer published version, re-installs it and re-pins the lock', () => {
    expect(installProbe().code).toBe(0);
    publishRow('1.1.0'); // a release moved the registry pin

    const up = runCli(['upgrade', ID, '--all']);
    expect(up.out).not.toMatch(/→ current .*no change/);
    expect(up.out).toMatch(/STALE/);
    expect(up.code, up.out).toBe(0);

    const entry = readLockEntry();
    expect(entry['checksum']).toBe(sha256(entryBody('1.1.0')));
    expect(entry['origin']).toBe(`npm-package:${PKG}@1.1.0`);
    const installed = fs.readFileSync(String(entry['source']).slice('file://'.length), 'utf8');
    expect(installed).toBe(entryBody('1.1.0'));

    // Idempotent: a second pass against the same pin makes no change.
    const again = runCli(['upgrade', ID, '--all']);
    expect(again.code, again.out).toBe(0);
    expect(again.out).toMatch(/→ current .*no change/);
  });

  it('a legacy self-referential entry (no origin) is stale once the registry pin differs', async () => {
    expect(installProbe().code).toBe(0);
    // Rewrite the entry into the exact shape the old engine wrote.
    const lock = JSON.parse(fs.readFileSync(lockPath(), 'utf8')) as { resolved: Record<string, Record<string, unknown>> };
    delete lock.resolved[ID]!['origin'];
    fs.writeFileSync(lockPath(), JSON.stringify(lock, null, 2));

    // Without registry context the tautology is all that can be checked.
    const bare = await verifyIntegrity('project', ID, { lockfilePath: lockPath() });
    expect(bare.status).toBe('current');

    publishRow('1.1.0');
    const up = runCli(['upgrade', ID, '--all']);
    expect(up.out).toMatch(/STALE/);
    expect(up.code, up.out).toBe(0);
    const entry = readLockEntry();
    expect(entry['origin']).toBe(`npm-package:${PKG}@1.1.0`);
    expect(entry['checksum']).toBe(sha256(entryBody('1.1.0')));
  });
});

describe('BL-cd1fe520 — secondary lock writers merge instead of re-creating the self-reference', () => {
  const store = '/data/ext';
  const prev: LockfileEntry = {
    source: 'file:///data/ext/x/node_modules/@a/x/dist/index.js',
    checksum: 'sha256:aa',
    resolved_at: 't0',
    bundle_id: 'b',
    origin: 'npm-package:@a/x@1.0.0',
  };

  it('same bytes keep the recorded origin and bundle_id', () => {
    const m = mergeLockEntry(prev, { source: prev.source, checksum: 'sha256:aa', origin: prev.source, storeRoot: store });
    expect(m.origin).toBe('npm-package:@a/x@1.0.0');
    expect(m.bundle_id).toBe('b');
  });

  it('a content-store path is never recorded as an origin', () => {
    const m = mergeLockEntry(prev, { source: prev.source, checksum: 'sha256:bb', origin: prev.source, storeRoot: store });
    expect(m.origin).toBeUndefined();
    expect(m.bundle_id).toBe('b');
  });

  it('a repo artifact outside the store is its own origin', () => {
    const m = mergeLockEntry(undefined, { source: 'file:///repo/x/dist/index.js', checksum: 'sha256:cc', origin: 'file:///repo/x/dist/index.js', storeRoot: store });
    expect(m.origin).toBe('file:///repo/x/dist/index.js');
  });
});

describe('BL-cd1fe520 — verifyIntegrity freshness against a desired pin', () => {
  let dir: string;
  let lockFile: string;
  let copy: string;
  let repo: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-cd1fe520-vi-'));
    copy = path.join(dir, 'store', 'index.js');
    repo = path.join(dir, 'repo', 'index.js');
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.mkdirSync(path.dirname(repo), { recursive: true });
    fs.writeFileSync(copy, 'v1');
    fs.writeFileSync(repo, 'v1');
    lockFile = path.join(dir, 'extensions.lock');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function writeLock(entry: LockfileEntry): void {
    fs.writeFileSync(lockFile, JSON.stringify({ lockfileVersion: 2, resolved: { x: entry } }));
  }

  it('a rebuilt file:// origin is stale even though the materialized copy is intact', async () => {
    writeLock({ source: `file://${copy}`, checksum: sha256('v1'), resolved_at: 't', origin: `file://${repo}` });
    expect((await verifyIntegrity('project', 'x', { lockfilePath: lockFile, desired: null })).status).toBe('current');
    fs.writeFileSync(repo, 'v2');
    const v = await verifyIntegrity('project', 'x', { lockfilePath: lockFile, desired: null });
    expect(v.status).toBe('stale');
    expect(v.reason).toMatch(/origin .* changed/);
    // Frozen verification (no desired) still judges only the installed bytes.
    expect((await verifyIntegrity('project', 'x', { lockfilePath: lockFile })).status).toBe('current');
  });

  it('an explicit configured locator the entry was not resolved from is stale', async () => {
    writeLock({ source: `file://${copy}`, checksum: sha256('v1'), resolved_at: 't', origin: 'npm-package:@a/x@1.0.0' });
    const same = resolveDesiredPin('x', [], 'npm-package:@a/x@1.0.0');
    expect((await verifyIntegrity('project', 'x', { lockfilePath: lockFile, desired: same })).status).toBe('current');
    const moved = resolveDesiredPin('x', [], 'npm-package:@a/x@2.0.0');
    expect((await verifyIntegrity('project', 'x', { lockfilePath: lockFile, desired: moved })).status).toBe('stale');
  });
});
