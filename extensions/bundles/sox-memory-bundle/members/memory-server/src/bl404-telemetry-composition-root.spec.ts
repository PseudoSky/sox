/**
 * bl404-telemetry-composition-root.spec.ts — BL-404 acceptance.
 *
 * BEFORE this fix: nothing outside a spec file ever called `initTelemetry()`
 * (a repo-wide grep found only `libs/memory-core/src/bl401-telemetry-substrate.spec.ts`).
 * The live memory-server ran on `@adhd/sox-telemetry`'s module-level fallback
 * state — `role:'test'` (defeating BL-353's population separation) and
 * `logSink:'none'` (the `DurableJsonlSink` never constructed, so the BL-365
 * crash-durability guarantee protected a sink production never instantiated).
 * `memory_stats.telemetry_self_check.role` reported `"test"` on the live
 * production service.
 *
 * This spec proves two things, one black-box and one white-box:
 *
 *   1. (black-box, real spawned process) The actual `require.main === module`
 *      entrypoint in `index.ts` — run for real via `tsx`, not imported
 *      in-process — reports `telemetry_self_check.role === 'live-service'`
 *      over a genuine MCP stdio round trip. This is exactly the surface that
 *      was observed broken in production.
 *
 *   2. (white-box) The exact options object the entrypoint passes to
 *      `initTelemetry()` — `MEMORY_SERVER_TELEMETRY_INIT_OPTIONS`, exported
 *      from `index.ts` so this test asserts against the SAME object the
 *      composition root uses, not a copy-pasted duplicate that could drift —
 *      really does configure `service:'memory-server'` and `logSink:'file'`:
 *      a `log.info()` call under it durably lands a JSONL record on disk
 *      carrying both fields.
 *
 * Neither test builds `dist/` (CONTRACTS: never `npx nx build memory-server`
 * from a shared checkout — BL-393, a build's `rm -rf dist` prelude can
 * silently redeploy the live production backend). Test 1 runs the TypeScript
 * SOURCE directly via `tsx`, which esbuild-transforms on the fly without
 * touching any `dist/` artifact.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  initTelemetry,
  log,
  telemetrySelfCheck,
  _resetTelemetryForTest,
} from '@adhd/sox-telemetry';
import { MEMORY_SERVER_TELEMETRY_INIT_OPTIONS } from './index.js';

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const MEMORY_SERVER_DIR = path.resolve(__dirname, '..');
const TSX_BIN = path.resolve(REPO_ROOT, 'node_modules/.bin/tsx');
const ENTRY = path.join(MEMORY_SERVER_DIR, 'src', 'index.ts');

interface JsonRpcMsg {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: { serverInfo?: { name: string; version: string }; content?: Array<{ type: string; text?: string }> };
}

/** Spawn the real entrypoint via tsx (never imported in-process — this is the
 *  ONLY way to actually exercise `if (require.main === module)`) and drive one
 *  MCP initialize + tools/call round trip over its real stdio pipes. */
async function callMemoryStatsOnRealEntrypoint(
  env: NodeJS.ProcessEnv,
  dbPath: string,
): Promise<Record<string, unknown>> {
  const child = spawn(TSX_BIN, [ENTRY], {
    cwd: MEMORY_SERVER_DIR,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdoutBuf = '';
  const responses: JsonRpcMsg[] = [];
  child.stdout.on('data', (d: Buffer) => {
    stdoutBuf += d.toString();
    let idx: number;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (line.trim()) {
        try {
          responses.push(JSON.parse(line) as JsonRpcMsg);
        } catch {
          // Non-JSON-RPC stdout noise would corrupt the MCP channel by design
          // (LogSink deliberately excludes 'stdout') — if this ever fires it
          // is itself a regression worth seeing in test output.
        }
      }
    }
  });
  let stderrBuf = '';
  child.stderr.on('data', (d: Buffer) => {
    stderrBuf += d.toString();
  });

  function send(msg: JsonRpcMsg): void {
    child.stdin.write(JSON.stringify(msg) + '\n');
  }

  async function waitFor(id: number, timeoutMs: number): Promise<JsonRpcMsg> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const r = responses.find((r) => r.id === id);
      if (r) return r;
      if (child.exitCode !== null) {
        throw new Error(
          `memory-server exited early (code ${child.exitCode}) before responding to id ${id}.\nstderr:\n${stderrBuf}`,
        );
      }
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error(`timeout waiting for response id ${id}.\nstderr so far:\n${stderrBuf}`);
  }

  try {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'bl404-spec', version: '0.0.0' },
      },
    });
    await waitFor(1, 20_000);

    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'memory_stats', arguments: { db_path: dbPath } },
    });
    const statsResp = await waitFor(2, 20_000);

    const text = statsResp.result?.content?.[0]?.text;
    if (typeof text !== 'string') {
      throw new Error(`memory_stats returned no text content: ${JSON.stringify(statsResp)}`);
    }
    return JSON.parse(text) as Record<string, unknown>;
  } finally {
    child.kill('SIGKILL');
  }
}

describe('BL-404: memory-server telemetry composition root', () => {
  describe('black-box: the real spawned entrypoint (tsx, never dist/, never in-process import)', () => {
    it(
      'reports telemetry_self_check.role === "live-service" over a genuine MCP round trip',
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl404-e2e-'));
        const dbPath = path.join(dir, 'test.db');
        try {
          const body = await callMemoryStatsOnRealEntrypoint(
            { ...process.env, SOX_ECOSYSTEM_HOME: path.join(dir, 'home') },
            dbPath,
          );
          const check = body['telemetry_self_check'] as Record<string, unknown> | undefined;
          expect(check).toBeDefined();
          // THE regression: before BL-404, this was 'test' on the live production
          // service (the module-level @adhd/sox-telemetry fallback role) even
          // though NODE_ENV was never 'test' and no VITEST_WORKER_ID was set —
          // because nothing ever called initTelemetry() to override it.
          expect(check!['role']).toBe('live-service');
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
      30_000,
    );
  });

  describe('white-box: MEMORY_SERVER_TELEMETRY_INIT_OPTIONS (the exact object the entrypoint passes)', () => {
    afterEach(() => {
      _resetTelemetryForTest();
    });

    it('is shaped service:"memory-server", role:"live-service", logSink:"file"', () => {
      expect(MEMORY_SERVER_TELEMETRY_INIT_OPTIONS).toEqual({
        service: 'memory-server',
        role: 'live-service',
        logSink: 'file',
      });
    });

    it('durably persists a role:"live-service"/service:"memory-server" JSONL record when initialised with it', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl404-whitebox-'));
      try {
        const handle = initTelemetry({ ...MEMORY_SERVER_TELEMETRY_INIT_OPTIONS, logDir: dir });
        expect(telemetrySelfCheck().role).toBe('live-service');

        log.info('bl404_test_event', {});
        handle.close();

        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
        expect(files.length).toBeGreaterThan(0);
        const lines = fs
          .readFileSync(path.join(dir, files[0]!), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>);
        const rec = lines.find((l) => l['event'] === 'bl404_test_event');
        expect(rec).toBeDefined();
        expect(rec!['service']).toBe('memory-server');
        expect(rec!['role']).toBe('live-service');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
