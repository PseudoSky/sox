/**
 * BL-7e5be7e8 — a test that SIGTERMs a real memory-server must never back up
 * (open) the operator's production store or touch its backup dir.
 *
 * The hazard: the direct-stdio SIGTERM/SIGINT handler in index.ts runs
 * `autoBackup(resolveDbPath(undefined))`, i.e. a VACUUM INTO of whatever store
 * `SOX_CONFIG_DB_PATH` names, into `SOX_AUTO_BACKUP_DIR` (default
 * `~/.memory/backups`), followed by a retention PRUNE of that dir. A spec that
 * spawns the entrypoint with `{ ...process.env }` hands the child whatever the
 * operator's shell carried, so an inherited `SOX_CONFIG_DB_PATH` made every such
 * spec a production-store reader and a potential deleter of operator backups.
 *
 * The fix (libs/memory-core/src/test-env-scrub.ts) scrubs the operator's
 * host-injected store config in both suites' vitest.setup.ts. This spec proves:
 *
 *   1. wiring — after setup, this worker's environment carries none of the
 *      scrubbed keys (run the suite with `SOX_CONFIG_DB_PATH=<decoy>` exported
 *      to exercise this for real);
 *   2. control — with an UNSCRUBBED operator-shaped env, the real entrypoint,
 *      SIGTERMed, really does VACUUM INTO a backup of the configured store
 *      (the hazard is live and this spec's detector sees it);
 *   3. treatment — the same env passed through the harness scrub leaves the
 *      configured store unopened and the backup dir untouched on SIGTERM.
 *
 * Every arm runs against a DECOY: a scratch `$HOME` whose `.memory/memory.db`
 * stands in for the operator store. `autoBackup` only backs up sources inside
 * `os.homedir()/.memory`, so the child's scratch HOME is what makes the decoy
 * eligible, and the real `~/.memory` is outside the child's allowlist in every
 * arm. `SOX_EMBED_HOST_MAIN` points at a missing file so the boot-time embed
 * warmup fails fast instead of spawning a detached embed host that would
 * outlive the test.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isOperatorStoreEnvKey, scrubOperatorStoreEnv } from '@adhd/sox-memory-core';

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const MEMORY_SERVER_DIR = path.resolve(__dirname, '..');
const TSX_BIN = path.resolve(REPO_ROOT, 'node_modules/.bin/tsx');
const ENTRY = path.join(MEMORY_SERVER_DIR, 'src', 'index.ts');

const BACKUP_FILE_RE = /^memory-\d{4}-\d{2}-\d{2}T.*\.db$/;

interface JsonRpcMsg {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: unknown;
}

interface SigtermRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

/**
 * Spawn the real entrypoint (direct-stdio mode), complete the MCP initialize
 * handshake (so the SIGTERM handler, installed before `serve()`, is live),
 * optionally make one tools/call, then SIGTERM it and wait for exit.
 */
async function bootCallAndSigterm(
  env: NodeJS.ProcessEnv,
  toolCall: { name: string; arguments: Record<string, unknown> } | null,
): Promise<SigtermRun> {
  const child = spawn(TSX_BIN, [ENTRY], { cwd: MEMORY_SERVER_DIR, env, stdio: ['pipe', 'pipe', 'pipe'] });
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
  const exited = new Promise<SigtermRun>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
  const send = (msg: Record<string, unknown>): void => { child.stdin.write(JSON.stringify(msg) + '\n'); };
  const waitFor = async (id: number, timeoutMs: number): Promise<JsonRpcMsg> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = responses.get(id);
      if (hit) return hit;
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no JSON-RPC response for id ${id} (exit=${child.exitCode}); stderr:\n${stderr}`);
  };

  try {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bl-7e5be7e8-spec', version: '0.0.0' } },
    });
    await waitFor(1, 30_000);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    if (toolCall) {
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: toolCall });
      const resp = await waitFor(2, 30_000);
      if (resp.error !== undefined) throw new Error(`tools/call failed: ${JSON.stringify(resp.error)}`);
    }
    child.kill('SIGTERM');
    const outcome = await Promise.race([
      exited,
      new Promise<null>((r) => { const t = setTimeout(() => r(null), 30_000); t.unref(); }),
    ]);
    if (outcome === null) throw new Error(`child did not exit within 30s of SIGTERM; stderr:\n${stderr}`);
    return outcome;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

function listBackups(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => BACKUP_FILE_RE.test(f)).sort();
}

describe('BL-7e5be7e8: a SIGTERMed test memory-server never backs up the operator store', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl-7e5be7e8-'));
  const decoyHome = path.join(scratch, 'home');
  const decoyStore = path.join(decoyHome, '.memory', 'memory.db');
  const decoyBackups = path.join(decoyHome, '.memory', 'backups');
  fs.mkdirSync(path.dirname(decoyStore), { recursive: true });

  /** The environment an operator shell under a sox host would hand a test. */
  const operatorShapedEnv = (): NodeJS.ProcessEnv => ({
    ...process.env,
    HOME: decoyHome,
    SOX_ECOSYSTEM_HOME: path.join(scratch, 'eco'),
    SOX_EMBED_HOST_MAIN: path.join(scratch, 'no-embed-host.js'),
    SOX_CONFIG_DB_PATH: decoyStore,
  });

  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('[BL-7e5be7e8 wiring] vitest.setup.ts left no operator store config in this worker', () => {
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
    // memory_stats with no db_path resolves SOX_CONFIG_DB_PATH and creates the decoy store.
    const run = await bootCallAndSigterm(operatorShapedEnv(), { name: 'memory_stats', arguments: {} });
    expect(fs.existsSync(decoyStore)).toBe(true);
    expect(run.stderr).toContain('running pre-restart backup');
    expect(run.stderr).toContain(`pre-restart backup saved: ${decoyBackups}${path.sep}`);
    expect(listBackups(decoyBackups)).toHaveLength(1);
  }, 90_000);

  it('[BL-7e5be7e8 treatment] harness-scrubbed env: SIGTERM leaves the configured store and backup dir untouched', async () => {
    // Bump the decoy's mtime past the control arm's idempotency marker, so an
    // unscrubbed child WOULD write a second backup rather than skip as unchanged.
    const bumped = new Date(Date.now() + 5_000);
    fs.utimesSync(decoyStore, bumped, bumped);
    const storeMtimeBefore = fs.statSync(decoyStore).mtimeMs;
    const backupsBefore = listBackups(decoyBackups);
    const backupDirMtimeBefore = fs.statSync(decoyBackups).mtimeMs;

    const env = operatorShapedEnv();
    scrubOperatorStoreEnv(env);
    const run = await bootCallAndSigterm(env, null);

    expect(run.stderr).toContain('no store configured (SOX_CONFIG_DB_PATH unset) — skipping pre-restart backup');
    expect(run.stderr).not.toContain('running pre-restart backup');
    expect(run.code).toBe(0);
    expect(listBackups(decoyBackups)).toEqual(backupsBefore);
    expect(fs.statSync(decoyBackups).mtimeMs).toBe(backupDirMtimeBefore);
    expect(fs.statSync(decoyStore).mtimeMs).toBe(storeMtimeBefore);
  }, 90_000);
});
