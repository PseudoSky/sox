/**
 * bl401-stages-declared-live.spec.ts — BL-401 acceptance, black-box.
 *
 * The BL-401 acceptance signal is a single number on the status surface of the
 * REAL server process:
 *
 *     memory_stats.telemetry_self_check.stages_declared
 *
 * It read **0** on the live production backend (pid 8820 / artifact
 * `4d2773bad484`, and still on pid 4214 / `b5ea0465614b` on 2026-08-04) because
 * `@adhd/sox-telemetry`'s stage substrate had no production consumer. Every
 * test written for it passed; each one declared its own catalog.
 *
 * So this spec deliberately does NOT construct a catalog. It spawns the real
 * `require.main === module` entrypoint via `tsx` and reads the number back over
 * a genuine MCP stdio round trip — the exact surface, and the exact field,
 * observed broken in production. A test that declares its own stages could
 * never have caught this; that is precisely how the gap survived a green suite.
 *
 * It also asserts the two remaining BL-401 gaps on that same real process:
 *   - gap 4: `telemetry_self_check.otel.state === 'ready'` — the SDK genuinely
 *     came up in a production-shaped process, not just in a unit test.
 *   - gap 6: `metric_persistence` reports a durable snapshot file path.
 *
 * `dist/` is never built (BL-393/BL-235: a build's `rm -rf dist` prelude can
 * silently redeploy the live backend). `tsx` transforms the source on the fly.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const MEMORY_SERVER_DIR = path.resolve(__dirname, '..');
const TSX_BIN = path.resolve(REPO_ROOT, 'node_modules/.bin/tsx');
const ENTRY = path.join(MEMORY_SERVER_DIR, 'src', 'index.ts');

interface JsonRpcMsg {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: { content?: Array<{ type: string; text?: string }> };
}

async function callMemoryStatsOnRealEntrypoint(
  env: NodeJS.ProcessEnv,
  dbPath: string,
): Promise<Record<string, unknown>> {
  const child = spawn(TSX_BIN, [ENTRY], { cwd: MEMORY_SERVER_DIR, env, stdio: ['pipe', 'pipe', 'pipe'] });

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
          // stdout is never a legal telemetry sink — noise here would corrupt
          // the MCP JSON-RPC channel and is itself a regression worth seeing.
        }
      }
    }
  });
  let stderrBuf = '';
  child.stderr.on('data', (d: Buffer) => {
    stderrBuf += d.toString();
  });

  const send = (msg: JsonRpcMsg): void => {
    child.stdin.write(JSON.stringify(msg) + '\n');
  };

  async function waitFor(id: number, timeoutMs: number): Promise<JsonRpcMsg> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const r = responses.find((m) => m.id === id);
      if (r) return r;
      if (child.exitCode !== null) {
        throw new Error(`memory-server exited early (code ${child.exitCode}).\nstderr:\n${stderrBuf}`);
      }
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error(`timeout waiting for id ${id}.\nstderr so far:\n${stderrBuf}`);
  }

  try {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bl401-spec', version: '0.0.0' } },
    });
    await waitFor(1, 20_000);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_stats', arguments: { db_path: dbPath } } });
    const resp = await waitFor(2, 20_000);
    const text = resp.result?.content?.[0]?.text;
    if (typeof text !== 'string') throw new Error(`memory_stats returned no text: ${JSON.stringify(resp)}`);
    return JSON.parse(text) as Record<string, unknown>;
  } finally {
    child.kill('SIGKILL');
  }
}

describe('BL-401: the real spawned memory-server reports a non-zero stage inventory', () => {
  it(
    'memory_stats.telemetry_self_check.stages_declared > 0, with memory-core stages present by name',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl401-live-'));
      const dbPath = path.join(dir, 'test.db');
      try {
        const body = await callMemoryStatsOnRealEntrypoint(
          { ...process.env, SOX_ECOSYSTEM_HOME: path.join(dir, 'home') },
          dbPath,
        );
        const check = body['telemetry_self_check'] as Record<string, unknown> | undefined;
        expect(check).toBeDefined();

        // THE regression. `0` here is what BL-351's acceptance was never met on.
        expect(check!['stages_declared']).toBeGreaterThan(0);

        const stages = (check!['stages'] as Array<{ stage: string; package: string }>).map((s) => s.stage);
        expect(stages).toContain('memory-core.write_queue');
        expect(stages).toContain('memory-core.embed');

        // BL-404's field, re-asserted here so a regression in either shows up
        // in one place: the live population must not be labelled as the test
        // population (BL-353).
        expect(check!['role']).toBe('live-service');

        // gap 4 — the SDK really came up in a production-shaped process.
        const otel = check!['otel'] as Record<string, unknown>;
        expect(otel).toBeDefined();
        expect(otel['state']).toBe('ready');
        expect(otel['spans_enabled']).toBe(true);

        // gap 6 — durable metric persistence is configured, with a real path.
        const persistence = check!['metric_persistence'] as Record<string, unknown>;
        expect(persistence).toBeDefined();
        expect(typeof persistence['file']).toBe('string');
        expect(persistence['file'] as string).toContain('.metrics-snapshot-');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
