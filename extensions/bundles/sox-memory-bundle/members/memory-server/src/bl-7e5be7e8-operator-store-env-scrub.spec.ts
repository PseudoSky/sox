/**
 * BL-7e5be7e8 — a test that SIGTERMs a real memory-server must never back up
 * (open) the operator's production store or touch its backup dir.
 *
 * The hazard: the direct-stdio SIGTERM/SIGINT handler in index.ts runs
 * `autoBackup(resolveDbPath(undefined))`, i.e. a VACUUM INTO of whatever store
 * `SOX_CONFIG_DB_PATH` names, into `SOX_AUTO_BACKUP_DIR` (default
 * `~/.memory/backups`), followed by a retention PRUNE of that dir. `autoBackup`
 * allowlists only the SOURCE, never the destination. A spec that spawns the
 * entrypoint with `{ ...process.env }` hands the child whatever the operator's
 * shell carried, so an inherited `SOX_CONFIG_DB_PATH` made every such spec a
 * production-store reader and a potential deleter of operator backups.
 *
 * The fix (libs/memory-core/src/test-env-scrub.ts) scrubs the operator's
 * host-injected store config in both suites' vitest.setup.ts and in
 * `buildScratchEmbedEnv()`. This spec proves:
 *
 *   1. wiring — vitest.config.ts injects a decoy `SOX_CONFIG_DB_PATH` /
 *      `SOX_AUTO_BACKUP_DIR` into every worker before setupFiles run; after
 *      setup, none of the scrubbed keys is left. Removing the setup call turns
 *      this red on every run;
 *   2. control — with an UNSCRUBBED operator-shaped env, the real entrypoint,
 *      SIGTERMed, really does VACUUM INTO a backup of the configured store
 *      (the hazard is live and this spec's detector sees it);
 *   3. treatment — the same operator-shaped env passed through the harness
 *      scrub leaves the configured store unopened and the backup dir untouched.
 *
 * SAFETY INDEPENDENT OF THE FIX UNDER TEST: every child env is built as
 * `buildScratchEmbedEnv()` (a `{ ...process.env }` copy, scrubbed, with scratch
 * HOME/XDG/TMPDIR/SOX_ECOSYSTEM_HOME) and then EVERY store key is set
 * explicitly to a decoy under the arm's own scratch root — `SOX_CONFIG_DB_PATH`,
 * `SOX_AUTO_BACKUP_DIR`, `SOX_PROXY_BACKEND`. So even with the scrub disabled
 * (the BL-225 red leg) no operator value can reach the child: the source is a
 * decoy inside the scratch HOME's `.memory`, and the destination is a decoy
 * backup dir beside it. `SOX_EMBED_HOST_MAIN` points at a missing file so the
 * boot-time embed warmup fails fast instead of spawning an embed host.
 *
 * Every spawn goes through the BL-df0ea359 helpers: `spawnRealEntrypoint()`
 * (own process group), `teardownRealEntrypoint()` (whole-tree verified stop),
 * `assertCleanTeardown()`. The tsx wrapper runs index.ts in a grandchild, so a
 * wrapper-only kill would orphan the real server holding the decoy store.
 * Each arm seeds its own decoy store and backup dir in `beforeAll`; no arm
 * depends on another.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isOperatorStoreEnvKey, scrubOperatorStoreEnv } from '@adhd/sox-memory-core';
import { createStoreAdapter } from '@adhd/sox-store-adapter';
import {
  assertCleanTeardown,
  buildScratchEmbedEnv,
  spawnRealEntrypoint,
  teardownRealEntrypoint,
  TEARDOWN_WORST_CASE_MS,
  type RealEntrypointRun,
  type TeardownReport,
} from './test-support/bl-df0ea359-embed-host-isolation.js';

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const MEMORY_SERVER_DIR = path.resolve(__dirname, '..');
const TSX_BIN = path.resolve(REPO_ROOT, 'node_modules/.bin/tsx');
const ENTRY = path.join(MEMORY_SERVER_DIR, 'src', 'index.ts');

const BACKUP_FILE_RE = /^memory-\d{4}-\d{2}-\d{2}T.*\.db$/;
/** Non-rotated sentinel seeded into each decoy backup dir (never matched by the pruner). */
const BACKUP_SENTINEL = 'operator-backup-sentinel.txt';
const HANDSHAKE_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 30_000;
const ARM_TIMEOUT_MS = HANDSHAKE_TIMEOUT_MS + EXIT_TIMEOUT_MS + TEARDOWN_WORST_CASE_MS + 30_000;

interface JsonRpcMsg {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: unknown;
}

interface DecoyArm {
  root: string;
  store: string;
  backups: string;
  /** The operator-shaped env: scrubbed scratch base + every store key set to a decoy. */
  operatorEnv: NodeJS.ProcessEnv;
  teardown: TeardownReport | null;
}

interface SigtermOutcome {
  stderr: string;
  /** Exit code of the tsx wrapper (it relays the server's exit). */
  code: number | null;
  teardown: TeardownReport;
}

/** Create an arm's scratch root, decoy store (a real sqlite store) and decoy backup dir. */
async function seedArm(label: string): Promise<DecoyArm> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sox-bl-7e5be7e8-${label}-`));
  const { env, home } = buildScratchEmbedEnv(root);
  fs.mkdirSync(env['TMPDIR'] as string, { recursive: true });
  const store = path.join(home, '.memory', 'memory.db');
  const backups = path.join(home, '.memory', 'backups');
  fs.mkdirSync(backups, { recursive: true });
  fs.writeFileSync(path.join(backups, BACKUP_SENTINEL), 'decoy operator backup dir\n');

  // Explicit dbPath (never the SOX_CONFIG_DB_PATH fallback); the worker's STORE_ADAPTER
  // (sqlite, vitest.setup.ts) is the engine the spawned child inherits.
  const adapter = await createStoreAdapter({ dbPath: store });
  try {
    await adapter.exec('CREATE TABLE IF NOT EXISTS bl_7e5be7e8_seed (v TEXT); INSERT INTO bl_7e5be7e8_seed VALUES (\'decoy\');');
  } finally {
    await adapter.close();
  }

  const operatorEnv: NodeJS.ProcessEnv = {
    ...env,
    SOX_EMBED_HOST_MAIN: path.join(root, 'no-embed-host.js'),
    SOX_CONFIG_DB_PATH: store,
    SOX_AUTO_BACKUP_DIR: backups,
    SOX_PROXY_BACKEND: '0',
  };
  return { root, store, backups, operatorEnv, teardown: null };
}

/**
 * Spawn the real entrypoint (direct-stdio mode) in its own process group, complete the MCP
 * initialize handshake (the SIGTERM handler is installed before `serve()`), SIGTERM the
 * whole group, and collect stderr until every writer of the pipes is gone. Always ends with
 * the whole-tree verified stop, whatever failed before it.
 */
async function bootAndSigterm(arm: DecoyArm, env: NodeJS.ProcessEnv): Promise<SigtermOutcome> {
  const run: RealEntrypointRun = spawnRealEntrypoint({
    tsxBin: TSX_BIN,
    entry: ENTRY,
    cwd: MEMORY_SERVER_DIR,
    env,
    scratchRoot: arm.root,
  });
  const { child } = run;
  let stderr = '';
  let stdoutBuf = '';
  const responses = new Map<number, JsonRpcMsg>();
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
  child.stdout.on('data', (d: Buffer) => {
    stdoutBuf += d.toString();
    let idx: number;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcMsg;
        if (typeof msg.id === 'number') responses.set(msg.id, msg);
      } catch (err) {
        stderr += `[spec] non-JSON stdout line ignored (${String(err)}): ${line}\n`;
      }
    }
  });
  // 'close' fires once every holder of the stdio pipes (wrapper AND the tsx grandchild
  // running index.ts) has exited, so the server's final stderr lines are never lost.
  let code: number | null = null;
  const closed = new Promise<boolean>((resolve) => {
    child.on('close', (c) => { code = c; resolve(true); });
  });

  try {
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bl-7e5be7e8-spec', version: '0.0.0' } },
    }) + '\n');
    const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
    while (!responses.has(1)) {
      if (Date.now() > deadline || child.exitCode !== null) {
        throw new Error(`no initialize response (exit=${child.exitCode}); stderr:\n${stderr}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const pgid = child.pid;
    if (pgid === undefined) throw new Error('spawned entrypoint has no pid');
    process.kill(-pgid, 'SIGTERM');
    const exited = await Promise.race([
      closed,
      new Promise<boolean>((r) => { const t = setTimeout(() => r(false), EXIT_TIMEOUT_MS); t.unref(); }),
    ]);
    if (!exited) throw new Error(`entrypoint did not exit within ${EXIT_TIMEOUT_MS}ms of SIGTERM; stderr:\n${stderr}`);
  } finally {
    arm.teardown = await teardownRealEntrypoint(run);
  }
  return { stderr, code, teardown: arm.teardown };
}

function listBackups(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => BACKUP_FILE_RE.test(f)).sort();
}

describe('BL-7e5be7e8: a SIGTERMed test memory-server never backs up the operator store', () => {
  const arms: DecoyArm[] = [];
  let control: DecoyArm;
  let treatment: DecoyArm;

  beforeAll(async () => {
    control = await seedArm('control');
    treatment = await seedArm('treatment');
    arms.push(control, treatment);
  }, 60_000);

  afterAll(() => {
    // Only remove a scratch root from under a tree that is verifiably gone.
    for (const arm of arms) {
      if (arm.teardown === null || arm.teardown.survivors.length === 0) {
        fs.rmSync(arm.root, { recursive: true, force: true });
      }
    }
  });

  it('[BL-7e5be7e8 wiring] vitest.setup.ts scrubbed the decoy operator store config vitest.config.ts injected', () => {
    const leaked = Object.keys(process.env).filter(isOperatorStoreEnvKey);
    expect(leaked).toEqual([]);
  });

  it('[BL-7e5be7e8 scrub] removes every SOX_CONFIG_* key and the backend/backup keys, nothing else', () => {
    const env: NodeJS.ProcessEnv = {
      SOX_CONFIG_DB_PATH: '/x/memory.db',
      SOX_CONFIG_PROJECT_PATH: '/x',
      SOX_PROXY_BACKEND: '1',
      SOX_PROXY_BACKEND_SOCKET: '/x.sock',
      SOX_PROXY_BACKEND_SCHEMA: '/x.json',
      SOX_AUTO_BACKUP_DIR: '/x/backups',
      SOX_ECOSYSTEM_HOME: '/keep',
      STORE_ADAPTER: 'sqlite',
      HOME: '/keep-home',
    };
    expect(scrubOperatorStoreEnv(env)).toEqual([
      'SOX_AUTO_BACKUP_DIR',
      'SOX_CONFIG_DB_PATH',
      'SOX_CONFIG_PROJECT_PATH',
      'SOX_PROXY_BACKEND',
      'SOX_PROXY_BACKEND_SCHEMA',
      'SOX_PROXY_BACKEND_SOCKET',
    ]);
    expect(env).toEqual({ SOX_ECOSYSTEM_HOME: '/keep', STORE_ADAPTER: 'sqlite', HOME: '/keep-home' });
  });

  it('[BL-7e5be7e8 control] UNSCRUBBED operator env: SIGTERM really backs up the configured store', async () => {
    expect(listBackups(control.backups)).toEqual([]);
    const run = await bootAndSigterm(control, { ...control.operatorEnv });
    assertCleanTeardown(run.teardown);
    expect(run.stderr).toContain('running pre-restart backup');
    expect(run.stderr).toContain(`pre-restart backup saved: ${control.backups}${path.sep}`);
    expect(listBackups(control.backups)).toHaveLength(1);
    expect(fs.existsSync(path.join(control.backups, BACKUP_SENTINEL))).toBe(true);
  }, ARM_TIMEOUT_MS);

  it('[BL-7e5be7e8 treatment] harness-scrubbed env: SIGTERM leaves the configured store and backup dir untouched', async () => {
    const storeMtimeBefore = fs.statSync(treatment.store).mtimeMs;
    const backupDirBefore = fs.readdirSync(treatment.backups).sort();
    const backupDirMtimeBefore = fs.statSync(treatment.backups).mtimeMs;

    const env = { ...treatment.operatorEnv };
    scrubOperatorStoreEnv(env);
    const run = await bootAndSigterm(treatment, env);
    assertCleanTeardown(run.teardown);

    expect(run.stderr).toContain('no store configured (SOX_CONFIG_DB_PATH unset) — skipping pre-restart backup');
    expect(run.stderr).not.toContain('running pre-restart backup');
    expect(fs.readdirSync(treatment.backups).sort()).toEqual(backupDirBefore);
    expect(fs.statSync(treatment.backups).mtimeMs).toBe(backupDirMtimeBefore);
    expect(fs.statSync(treatment.store).mtimeMs).toBe(storeMtimeBefore);
  }, ARM_TIMEOUT_MS);
});
