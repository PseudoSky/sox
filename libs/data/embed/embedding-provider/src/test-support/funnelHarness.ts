/**
 * test-support/funnelHarness.ts — shared real-process harness for the embedding
 * funnel specs (ADR-0022). Test-only: excluded from the library build
 * (`tsconfig.lib.json`), never shipped in `dist/`.
 *
 * The host under test is the REAL `src/embedHostMain.ts`, run through a unique
 * per-test `.mjs` shim under the tsx loader; its private ONNX pool is pointed at
 * a STATEFUL stub IPC host (`SOX_FASTEMBED_HOST_PATH`), so no model is ever
 * downloaded. The stub mirrors `fastembedProcessHost.ts`: `embed`/`embedBatch`
 * before `init` answer "Model not initialized".
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC_DIR = path.resolve(__dirname, '..');

/** `file://` URL of the real host source the shim imports. */
export const EMBED_HOST_TS_URL = pathToFileURL(path.join(SRC_DIR, 'embedHostMain.ts')).href;

export interface StubOpts {
  /** Delay before each embed/embedBatch reply. */
  delayMs?: number;
  /** Delay before the init reply. */
  initDelayMs?: number;
  /** Ignore `{__shutdown:true}` so `terminate()` waits its full grace. */
  ignoreShutdown?: boolean;
}

/** Source of the stateful stub private host (fastembed-host IPC protocol). */
export function stubHostSource(o: StubOpts = {}): string {
  const delayMs = o.delayMs ?? 0;
  const initDelayMs = o.initDelayMs ?? 0;
  return [
    `let q = Promise.resolve();`,
    `let model = null;`,
    `process.on('message', (msg) => {`,
    o.ignoreShutdown
      ? `  if (msg && msg.__shutdown) return; // deliberately ignored`
      : `  if (msg && msg.__shutdown) { try { process.disconnect(); } catch (e) { process.stderr.write(String(e)); } return; }`,
    `  q = q.then(() => new Promise((resolve) => {`,
    `    const reply = (r) => { if (process.connected) process.send(Object.assign({ id: msg.id }, r)); resolve(); };`,
    `    if (msg.type === 'init') {`,
    `      setTimeout(() => { model = msg.model; reply({ initOk: true, dim: 3, execution_provider: 'cpu' }); }, ${initDelayMs});`,
    `      return;`,
    `    }`,
    `    if (msg.type === 'embed' || msg.type === 'embedBatch') {`,
    `      if (model === null) { reply({ error: 'Model not initialized' }); return; }`,
    `      setTimeout(() => {`,
    `        if (msg.type === 'embed') reply({ embedding: [0, 0, 0] });`,
    `        else reply({ embeddings: (msg.texts || []).map(() => [0, 0, 0]) });`,
    `      }, ${delayMs});`,
    `      return;`,
    `    }`,
    `    reply({ error: 'unknown request type ' + String(msg.type) });`,
    `  }));`,
    `});`,
    '',
  ].join('\n');
}

/** Source of a host shim that runs the real host from `hostSrcUrl`. */
export function hostShimSource(hostSrcUrl: string, extra = ''): string {
  return [
    `// ${extra || 'embed host test shim'}`,
    `const mod = await import(${JSON.stringify(hostSrcUrl)});`,
    `await mod.runEmbedHost();`,
    '',
  ].join('\n');
}

export interface FunnelDir {
  dir: string;
  home: string;
  cache: string;
  stubPath: string;
  shimPath: string;
}

/** Create an isolated funnel sandbox (temp home, cache, stub, shim). */
export function makeFunnelDir(prefix: string, stub: StubOpts = {}, shimTag = ''): FunnelDir {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const home = path.join(dir, 'sox-home');
  const cache = path.join(dir, 'models');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  const stubPath = path.join(dir, 'fastembedProcessHost-stub.mjs');
  fs.writeFileSync(stubPath, stubHostSource(stub));
  const hostDir = path.join(dir, 'host');
  fs.mkdirSync(hostDir);
  const shimPath = path.join(hostDir, 'embedHostMain-testshim.mjs');
  fs.writeFileSync(shimPath, hostShimSource(EMBED_HOST_TS_URL, shimTag));
  return { dir, home, cache, stubPath, shimPath };
}

/** The env an in-process consumer needs to spawn hosts inside the sandbox. */
export function funnelEnvVars(f: FunnelDir, hostMain = f.shimPath): Record<string, string> {
  const base = process.env['NODE_OPTIONS'] ?? '';
  return {
    NODE_OPTIONS: base.includes('--import tsx') ? base : `${base} --import tsx`.trim(),
    SOX_ECOSYSTEM_HOME: f.home,
    SOX_FASTEMBED_HOST_PATH: f.stubPath,
    SOX_EMBED_HOST_MAIN: hostMain,
    SOX_EMBED_EXECUTION_PROVIDER: 'cpu',
  };
}

/** Apply `vars` to `process.env`; returns a function restoring the previous values. */
export function applyEnv(vars: Record<string, string | undefined>): () => void {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

export interface PsRow {
  pid: number;
  command: string;
}

export function psRows(): PsRow[] {
  const out = execFileSync('ps', ['-axww', '-o', 'pid=,command='], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const rows: PsRow[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), command: m[2] ?? '' });
  }
  return rows;
}

/** Pids whose command line contains `needle` (never this test process). */
export function pidsMatching(needle: string): number[] {
  return psRows()
    .filter((r) => r.pid !== process.pid && r.command.includes(needle))
    .map((r) => r.pid);
}

/** Live host pids spawned from `shimPath`. */
export function hostPids(shimPath: string): number[] {
  return psRows()
    .filter((r) => r.pid !== process.pid && r.command.includes(`${shimPath} --socket=`))
    .map((r) => r.pid);
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Bounded poll (no fixed sleep) until `pred()` is true. */
export async function waitFor(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor: ${what} not observed within ${timeoutMs}ms`);
}

export function killPid(pid: number, signal: NodeJS.Signals = 'SIGKILL'): void {
  // Never signal pid 0 / negative pids (that targets a whole process group).
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, signal);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
  }
}

/** Kill every process whose command line references the sandbox, then remove it. */
export function destroyFunnelDir(f: FunnelDir): void {
  for (const pid of pidsMatching(f.dir)) killPid(pid);
  fs.rmSync(f.dir, { recursive: true, force: true });
}

/** Parsed records from every `embed-host` jsonl file under `home`, in file order. */
export function readHostTelemetry(home: string): Array<Record<string, unknown>> {
  const dir = path.join(home, 'embed-host', 'logs');
  if (!fs.existsSync(dir)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      out.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return out;
}
