/**
 * singleton.spec.ts — Slice 1 of docs/spec/service-lifecycle.md.
 *
 * Authoritative unit tests for the cross-scope singleton machinery (NOT a
 * reimplementation — these import the real module, so they pin the shipped
 * behaviour). Covers:
 *
 *   - resolveStoreResource: db_path > socket > port precedence, x-sox-singleton-key
 *   - singletonKey: (id, store-resource), null when kind 'none'
 *   - canonicalizePath / expandConfigValue: tilde + ${VAR} + realpath collapse
 *   - findCrossScopeSharers: the §5.2 step-4 collision check (over store, not scope)
 *   - chooseSurvivor: preferred wins, else oldest-by-start, lowest-pid fallback
 *   - healSingletonDuplicates: ≤1 live = no-op; ≥2 = kill loser(s)
 *
 * Process-level helpers (processStartTime, healSingletonDuplicates) are tested
 * against REAL spawned node processes so the ps/kill path is exercised, then
 * cleaned up.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  canonicalizePath,
  chooseSurvivor,
  expandConfigValue,
  findCrossScopeSharers,
  healSingletonDuplicates,
  manifestDeclaresSingleton,
  processStartTime,
  resolveStoreResource,
  singletonKey,
  type StoreResource,
} from './singleton.js';
import { pidAlive } from './reaper.js';

let tmpDir: string;
const spawned: number[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-singleton-'));
});

afterEach(() => {
  for (const pid of spawned.splice(0)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeManifest(content: object): string {
  const p = path.join(tmpDir, 'extension.json');
  fs.writeFileSync(p, JSON.stringify(content), 'utf8');
  return p;
}

// ── expandConfigValue ──────────────────────────────────────────────────────────

describe('expandConfigValue', () => {
  it('expands ${SOX_CONFIG_*} from configEnv', () => {
    expect(expandConfigValue('${SOX_CONFIG_DB_PATH}', { SOX_CONFIG_DB_PATH: '/x/y.db' }))
      .toBe('/x/y.db');
  });

  it('expands a leading tilde', () => {
    expect(expandConfigValue('~/.memory/memory.db', {}))
      .toBe(path.join(os.homedir(), '.memory', 'memory.db'));
  });

  it('expands ${VAR} then tilde together', () => {
    expect(expandConfigValue('${SOX_CONFIG_DB_PATH}', { SOX_CONFIG_DB_PATH: '~/.memory/m.db' }))
      .toBe(path.join(os.homedir(), '.memory', 'm.db'));
  });

  it('leaves an unknown placeholder literal', () => {
    expect(expandConfigValue('${SOX_CONFIG_NOPE}', {})).toBe('${SOX_CONFIG_NOPE}');
  });
});

// ── canonicalizePath ─────────────────────────────────────────────────────────

describe('canonicalizePath', () => {
  it('collapses two spellings of an existing file to one identity', () => {
    const real = path.join(tmpDir, 'store.db');
    fs.writeFileSync(real, '');
    const viaDots = path.join(tmpDir, 'sub', '..', 'store.db');
    expect(canonicalizePath(viaDots)).toBe(canonicalizePath(real));
  });

  it('resolves a not-yet-created file via its existing parent', () => {
    const notYet = path.join(tmpDir, 'future.db');
    // realpath of tmpDir may differ from tmpDir on macOS (/var vs /private/var);
    // the canonical leaf must still match the parent's realpath + leaf.
    expect(canonicalizePath(notYet)).toBe(path.join(fs.realpathSync(tmpDir), 'future.db'));
  });

  it('returns empty for empty input', () => {
    expect(canonicalizePath('')).toBe('');
  });
});

// ── resolveStoreResource ─────────────────────────────────────────────────────

describe('resolveStoreResource', () => {
  it('keys on db_path when present (the canonical single-writer resource)', () => {
    const m = writeManifest({ lifecycle: { singleton: true } });
    const r = resolveStoreResource(m, { SOX_CONFIG_DB_PATH: path.join(tmpDir, 'x.db') });
    expect(r.kind).toBe('db');
    expect(r.value).toBe(canonicalizePath(path.join(tmpDir, 'x.db')));
  });

  it('db_path wins over a declared socket health endpoint', () => {
    const m = writeManifest({
      lifecycle: { health: { type: 'socket', endpoint: '${SOX_CONFIG_SOCK_PATH}' } },
    });
    const r = resolveStoreResource(m, {
      SOX_CONFIG_DB_PATH: path.join(tmpDir, 'x.db'),
      SOX_CONFIG_SOCK_PATH: path.join(tmpDir, 'x.sock'),
    });
    expect(r.kind).toBe('db');
  });

  it('falls back to the socket health endpoint when no db_path', () => {
    const m = writeManifest({
      lifecycle: { health: { type: 'socket', endpoint: '${SOX_CONFIG_SOCK_PATH}' } },
    });
    const r = resolveStoreResource(m, { SOX_CONFIG_SOCK_PATH: path.join(tmpDir, 'x.sock') });
    expect(r.kind).toBe('socket');
    expect(r.value).toBe(canonicalizePath(path.join(tmpDir, 'x.sock')));
  });

  it('falls back to host:port', () => {
    const m = writeManifest({ lifecycle: {} });
    const r = resolveStoreResource(m, { SOX_CONFIG_PORT: '9099', SOX_CONFIG_HOST: '127.0.0.1' });
    expect(r).toEqual<StoreResource>({ kind: 'port', value: '127.0.0.1:9099' });
  });

  it('honours an explicit x-sox-singleton-key property over db_path heuristics', () => {
    const m = writeManifest({
      config_schema: {
        properties: { store_file: { 'x-sox-singleton-key': true } },
      },
    });
    const r = resolveStoreResource(m, { SOX_CONFIG_STORE_FILE: path.join(tmpDir, 'nominated.db') });
    expect(r.kind).toBe('db');
    expect(r.value).toBe(canonicalizePath(path.join(tmpDir, 'nominated.db')));
  });

  it('returns kind none when nothing is declared', () => {
    const m = writeManifest({ lifecycle: {} });
    expect(resolveStoreResource(m, {})).toEqual<StoreResource>({ kind: 'none', value: '' });
  });

  it('does not resolve an unsubstituted socket placeholder', () => {
    const m = writeManifest({
      lifecycle: { health: { type: 'socket', endpoint: '${SOX_CONFIG_SOCK_PATH}' } },
    });
    expect(resolveStoreResource(m, {}).kind).toBe('none');
  });
});

// ── singletonKey ─────────────────────────────────────────────────────────────

describe('singletonKey', () => {
  it('combines id + store-resource', () => {
    expect(singletonKey('memory-daemon', { kind: 'db', value: '/a/b.db' }))
      .toBe('memory-daemon db:/a/b.db');
  });

  it('is null for a non-store service (kind none)', () => {
    expect(singletonKey('x', { kind: 'none', value: '' })).toBeNull();
  });

  it('two scopes sharing one db produce the SAME key (the core invariant)', () => {
    const k1 = singletonKey('memory-daemon', { kind: 'db', value: '/home/u/.memory/memory.db' });
    const k2 = singletonKey('memory-daemon', { kind: 'db', value: '/home/u/.memory/memory.db' });
    expect(k1).toBe(k2);
  });
});

// ── manifestDeclaresSingleton ─────────────────────────────────────────────────

describe('manifestDeclaresSingleton', () => {
  it('true when lifecycle.singleton is set', () => {
    expect(manifestDeclaresSingleton(writeManifest({ lifecycle: { singleton: true } }))).toBe(true);
  });
  it('false otherwise / on missing file', () => {
    expect(manifestDeclaresSingleton(writeManifest({ lifecycle: {} }))).toBe(false);
    expect(manifestDeclaresSingleton(path.join(tmpDir, 'nope.json'))).toBe(false);
  });
});

// ── findCrossScopeSharers (§5.2 step 4) ──────────────────────────────────────

describe('findCrossScopeSharers', () => {
  const db = (v: string): StoreResource => ({ kind: 'db', value: v });

  it('finds a scope sharing the SAME store even with a different socket', () => {
    const target = db('/home/u/.memory/memory.db');
    const others = [
      { scope: 'project', resource: db('/home/u/.memory/memory.db') }, // same db, diff sock
    ];
    expect(findCrossScopeSharers('user', target, others)).toEqual(['project']);
  });

  it('does NOT flag a scope pointing at a different store', () => {
    const target = db('/home/u/.memory/memory.db');
    const others = [{ scope: 'project', resource: db('/tmp/other.db') }];
    expect(findCrossScopeSharers('user', target, others)).toEqual([]);
  });

  it('ignores the target scope itself', () => {
    const target = db('/x.db');
    const others = [{ scope: 'user', resource: db('/x.db') }];
    expect(findCrossScopeSharers('user', target, others)).toEqual([]);
  });

  it('does not match across resource kinds', () => {
    const target = db('/x');
    const others = [{ scope: 'project', resource: { kind: 'socket' as const, value: '/x' } }];
    expect(findCrossScopeSharers('user', target, others)).toEqual([]);
  });

  it('returns nothing for a kind-none target', () => {
    expect(findCrossScopeSharers('user', { kind: 'none', value: '' }, [])).toEqual([]);
  });
});

// ── processStartTime / chooseSurvivor ────────────────────────────────────────

async function spawnSleeper(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], {
    detached: true, stdio: 'ignore',
  });
  child.unref();
  const pid = child.pid!;
  spawned.push(pid);
  // Give ps a moment to see it.
  await new Promise((r) => setTimeout(r, 150));
  return pid;
}

describe('processStartTime', () => {
  it('returns an epoch-ms time for a live process', async () => {
    const pid = await spawnSleeper();
    const t = processStartTime(pid);
    expect(t).not.toBeNull();
    expect(t).toBeGreaterThan(0);
    // Within a few minutes of now.
    expect(Math.abs(Date.now() - t!)).toBeLessThan(5 * 60_000);
  });

  it('returns null for a dead pid', () => {
    // A pid that is valid-range but reliably dead.
    expect(processStartTime(2_147_480)).toBeNull();
  });
});

describe('chooseSurvivor', () => {
  it('keeps the single pid when only one', () => {
    expect(chooseSurvivor([42])).toEqual({ survivor: 42, losers: [] });
  });

  it('prefers an explicitly preferred pid', () => {
    const r = chooseSurvivor([100, 200, 300], { preferred: 200 });
    expect(r.survivor).toBe(200);
    expect(r.losers.sort()).toEqual([100, 300]);
  });

  it('falls back to lowest-pid when start times are unavailable (dead pids)', () => {
    // Dead pids → processStartTime null → lowest-pid tiebreak.
    const r = chooseSurvivor([2_147_403, 2_147_401, 2_147_402]);
    expect(r.survivor).toBe(2_147_401);
  });

  it('returns survivor -1 for an empty set', () => {
    expect(chooseSurvivor([])).toEqual({ survivor: -1, losers: [] });
  });
});

// ── healSingletonDuplicates (§5.3) ───────────────────────────────────────────

describe('healSingletonDuplicates', () => {
  it('is a no-op when ≤1 live process matches (never thrash a healthy daemon)', async () => {
    const marker = path.join(tmpDir, 'solo', 'index.js');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, 'setTimeout(()=>{},60000)');
    const child = spawn(process.execPath, [marker], { detached: true, stdio: 'ignore' });
    child.unref();
    spawned.push(child.pid!);
    await new Promise((r) => setTimeout(r, 150));

    const res = await healSingletonDuplicates({
      key: 'solo db:/x', entrypointToken: marker, excludePids: [process.pid], graceMs: 1000,
    });
    expect(res.found.length).toBe(1);
    expect(res.killed).toEqual([]);
    expect(pidAlive(child.pid!)).toBe(true);
  });

  it('kills all but the survivor when ≥2 live processes match one key', async () => {
    const marker = path.join(tmpDir, 'dup', 'index.js');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, 'setTimeout(()=>{},60000)');
    const a = spawn(process.execPath, [marker], { detached: true, stdio: 'ignore' });
    const b = spawn(process.execPath, [marker], { detached: true, stdio: 'ignore' });
    a.unref(); b.unref();
    spawned.push(a.pid!, b.pid!);
    await new Promise((r) => setTimeout(r, 200));

    const res = await healSingletonDuplicates({
      key: 'dup db:/x', entrypointToken: marker, excludePids: [process.pid], graceMs: 2000,
    });
    expect(res.found.length).toBe(2);
    expect(res.killed.length).toBe(1);
    // Exactly one survives.
    await new Promise((r) => setTimeout(r, 200));
    const aliveCount = [a.pid!, b.pid!].filter((p) => pidAlive(p)).length;
    expect(aliveCount).toBe(1);
    expect(pidAlive(res.survivor)).toBe(true);
  });
});
