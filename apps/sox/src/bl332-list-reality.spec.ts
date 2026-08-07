/**
 * bl332-list-reality.spec.ts — `soxe list` reports a running service as INACTIVE (BL-332).
 *
 * Drives the REAL built `dist/apps/sox/main.js` as a subprocess against a
 * SANDBOXED SOX_ECOSYSTEM_HOME (the service-os-unit.spec.ts / bl36-bl178-bl57.spec.ts
 * pattern) — see SPEC-PKT-39.md for the full ruling.
 *
 * cmdList's default (non-`--all`, non-`--global`) render path computes `running`
 * exclusively from a runtime.json record (`rtEntry?.running===true && pidAlive(pid)`).
 * That is correct for an M1/M3 CLI-supervised service, but has NO fallback for an M4
 * (OS-unit-adopted) service — `soxe service enable` never writes a runtime.json entry
 * at all, so a genuinely live process renders INACTIVE. This mirrors `cmdService`'s
 * `status` subcommand, which already reality-checks via `identityToken` +
 * `findOrphansByIdentity` against the process table. [inv:list-never-lies]
 *
 * §3.3 of SPEC-PKT-39 rules that `list`'s RUNNING determination does not gate on
 * `platform.isLoaded()` — a live pid matching the entrypoint's identity token IS the
 * reality — so a plain detached child process (no real launchctl load) reproduces the
 * gap portably, matching `service-os-unit.spec.ts`'s existing no-real-launchctl
 * convention.
 */

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** Give the OS process table a moment to reflect a just-spawned pid before
 * scanning it (matches libs/host-runtime/src/reaper.spec.ts's convention). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CLI_MAIN = path.resolve(__dirname, '../../../dist/apps/sox/main.js');

let baseDir: string;
let home: string;
let extDir: string;
let entrypointAbsPath: string;
let spawnedPid: number | null = null;

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl332-'));
  home = path.join(baseDir, 'home');
  fs.mkdirSync(home, { recursive: true });

  // Fixture extension: test-svc @ 1.0.0, type mcp-server, entrypoint dist/index.js.
  extDir = path.join(baseDir, 'test-svc-store');
  fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(extDir, 'extension.json'),
    JSON.stringify({ id: 'test-svc', type: 'mcp-server', entrypoint: 'dist/index.js' }),
  );
  entrypointAbsPath = path.join(extDir, 'dist', 'index.js');
  // Stays alive until killed, no network. NOTE: `process.stdin.resume()` (the
  // SPEC-PKT-39 §4 fixture text) does NOT keep a detached `stdio:'ignore'`
  // child alive — stdin is /dev/null, hits EOF immediately, and the process
  // exits into a zombie/<defunct> state within the test's own sleep window
  // (reproduced with `ps -o pid,args` showing `<defunct>` — process.kill(pid,0)
  // still returns true for a zombie, so the flakiness is silent). A recurring
  // timer keeps the event loop alive regardless of stdio wiring.
  fs.writeFileSync(entrypointAbsPath, 'setInterval(() => {}, 60000);\n');

  // Lockfile: one resolved entry pointing source at extDir.
  fs.writeFileSync(
    path.join(home, 'extensions.lock'),
    JSON.stringify({
      version: 1,
      resolved: {
        'test-svc@1.0.0': { version: '1.0.0', source: `file://${extDir}`, checksum: 'sha256:test' },
      },
    }),
  );

  spawnedPid = null;
});

afterEach(() => {
  if (spawnedPid !== null) {
    try { process.kill(spawnedPid, 'SIGKILL'); } catch { /* already dead */ }
    spawnedPid = null;
  }
  try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function runList(): { code: number; rows: Array<{ id?: string; key?: string; running?: boolean; pid?: number | null }> } {
  const r = spawnSync(process.execPath, [CLI_MAIN, 'list', '--scope=user', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, SOX_ECOSYSTEM_HOME: home },
    cwd: home,
    timeout: 15000,
  });
  const code = r.status ?? -1;
  let rows: Array<{ id?: string; key?: string; running?: boolean; pid?: number | null }> = [];
  if (r.stdout && r.stdout.trim()) {
    try {
      rows = JSON.parse(r.stdout) as typeof rows;
    } catch {
      // fall through with empty rows; caller assertions will fail loudly
    }
  }
  return { code, rows };
}

function findTestSvcRow(
  rows: Array<{ id?: string; key?: string; running?: boolean; pid?: number | null }>,
): { id?: string; key?: string; running?: boolean; pid?: number | null } | undefined {
  return rows.find((r) => r.id === 'test-svc' || r.key === 'test-svc@1.0.0');
}

/** Write a runtime.json with a running:true entry for test-svc pointing at a real live pid. */
function writeRunningRuntimeRecord(pid: number): void {
  const runtimePath = path.join(home, 'runtime.json');
  fs.writeFileSync(
    runtimePath,
    JSON.stringify({
      version: 1,
      scope: 'user',
      startedAt: new Date().toISOString(),
      entries: [
        {
          key: 'test-svc@1.0.0',
          id: 'test-svc',
          type: 'mcp-server',
          scope: 'user',
          source: `file://${extDir}`,
          pid,
          running: true,
          activatedAt: new Date().toISOString(),
        },
      ],
    }),
  );
}

describe('BL-332 — soxe list reality-verifies OS-unit-adopted (M4) services', () => {
  it('AC-1: no runtime.json entry, live pid matching entrypoint identity — renders running:true, pid:<spawned>', async () => {
    // No runtime.json at all — the exact BL-332 shape (an M4 service `service
    // enable` never wrote a runtime record for).
    const child = spawn(process.execPath, [entrypointAbsPath], { detached: true, stdio: 'ignore' });
    spawnedPid = child.pid ?? null;
    child.unref();
    expect(spawnedPid).not.toBeNull();
    await sleep(250); // let the OS process table settle before scanning it

    const { code, rows } = runList();
    expect(code).not.toBe(-1);
    const row = findTestSvcRow(rows);
    expect(row).toBeDefined();
    expect(row?.running).toBe(true);
    expect(row?.pid).toBe(spawnedPid);
  });

  it('AC-2 (converse): no runtime.json entry, no live process — stays running:false, pid:null', () => {
    // Same fixture, no process spawned.
    const { code, rows } = runList();
    expect(code).not.toBe(-1);
    const row = findTestSvcRow(rows);
    expect(row).toBeDefined();
    expect(row?.running).toBe(false);
    expect(row?.pid).toBeNull();
  });

  it('AC-3 (non-regression): runtime.json already has running:true + live pid — the pre-existing M1/M3 path renders correctly, fallback does not fire spuriously', async () => {
    const child = spawn(process.execPath, [entrypointAbsPath], { detached: true, stdio: 'ignore' });
    spawnedPid = child.pid ?? null;
    child.unref();
    expect(spawnedPid).not.toBeNull();
    await sleep(250); // let the OS process table settle before scanning it
    writeRunningRuntimeRecord(spawnedPid as number);

    const { code, rows } = runList();
    expect(code).not.toBe(-1);
    const row = findTestSvcRow(rows);
    expect(row).toBeDefined();
    expect(row?.running).toBe(true);
    expect(row?.pid).toBe(spawnedPid);
  });
});
