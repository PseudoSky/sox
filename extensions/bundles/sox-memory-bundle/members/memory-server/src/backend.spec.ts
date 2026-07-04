/**
 * backend.spec.ts — memory-server UDS backend mode (spec §9.5, M3→M4 bridge).
 *
 * Proves the backend JSON-RPC handler mirrors the MCP serve() surface:
 *   - initialize → serverInfo (content-addressed version) + tools capability
 *   - tools/list → the canonical 19-tool list (same shape serve() returns)
 *   - tools/call → routes to handleToolCall (here: memory_ping, no db touched)
 *   - the published schema.json hashes identically to the live tools/list
 *     ([contract:schema-hash], §9.5.3) so the shim's cache matches the backend.
 *   - runBackend binds a real UDS that a dialBackend client can round-trip against.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { computeSchemaHash, dialBackend, type BackendConnection } from '@adhd/sox-service-proxy';
import {
  buildToolsListResult,
  handleBackendRequest,
  publishSchema,
  runBackend,
} from './backend.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-mem-backend-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

describe('memory-server backend handler', () => {
  it('tools/list returns the canonical 20-tool surface', async () => {
    const resp = await handleBackendRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const result = resp?.result as { tools: Array<{ name: string }> };
    expect(result.tools.length).toBe(20);
    expect(result.tools.map((t) => t.name)).toContain('memory_ping');
    expect(result.tools.map((t) => t.name)).toContain('memory_update');
  });

  it('initialize returns content-addressed serverInfo + tools capability', async () => {
    const resp = await handleBackendRequest({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} });
    const result = resp?.result as { serverInfo: { name: string; version: string }; capabilities: { tools: object } };
    expect(result.serverInfo.name).toBe('memory-server');
    expect(typeof result.serverInfo.version).toBe('string');
    expect(result.serverInfo.version.length).toBeGreaterThan(0);
    expect(result.capabilities.tools).toBeDefined();
  });

  it('tools/call routes memory_ping through handleToolCall without touching a db', async () => {
    const resp = await handleBackendRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'memory_ping', arguments: {} },
    });
    const result = resp?.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain('ok');
  });

  it('notifications (no id) get no response', async () => {
    const resp = await handleBackendRequest({ jsonrpc: '2.0', method: 'some/notification' });
    expect(resp).toBeUndefined();
  });

  it('published schema.json hashes identically to the live tools/list', () => {
    const dir = tmpDir();
    const schemaPath = path.join(dir, 'schema.json');
    publishSchema(schemaPath);
    expect(fs.existsSync(schemaPath)).toBe(true);
    const fromFile = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    const live = buildToolsListResult();
    // [contract:schema-hash]: the shim serves the cached schema, the backend the
    // live one — they MUST hash identically or a behaviour upgrade would wrongly
    // be flagged as an interface change.
    expect(computeSchemaHash(fromFile)).toBe(computeSchemaHash(live));
  });

  // ── BL-170: the losing singleton racer must EXIT, never idle as a zombie ──────
  //
  // serveBackend's SA-4 probe correctly refuses a live socket with E_LIVE_SOCKET
  // ([SA-4] in libs/service-proxy/src/backend.spec.ts proves the refusal). What was
  // NOT tested — and what left orphaned backends on the live box twice — is the
  // CALLER's behaviour: runBackend swallowed the rejection (void, no .catch) so the
  // losing process idled forever with no signal handlers wired. This pins the fix:
  // runBackend catches the rejection, writes a stderr diagnostic, and exits 1
  // (via the injectable `exit` seam so the test runner survives).
  it('[BL-170] runBackend exits(1) with a stderr diagnostic when the socket is held by a live backend', async () => {
    const dir = tmpDir();
    const sock = path.join(dir, 'backend.sock');

    // Occupy the socket with a real live backend (the singleton winner).
    const winner = await runBackend({ socketPath: sock });
    cleanups.push(() => winner.close());

    // Capture stderr diagnostics without silencing them.
    const stderrLines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrLines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    cleanups.push(() => {
      process.stderr.write = origWrite;
    });

    // The loser: same socket, injected exit seam that throws a sentinel instead
    // of killing the test runner.
    class ExitSentinel extends Error {
      constructor(public readonly code: number) {
        super(`exit(${String(code)})`);
      }
    }
    let exitCode: number | undefined;
    const loser = runBackend({
      socketPath: sock,
      exit: (code: number): never => {
        exitCode = code;
        throw new ExitSentinel(code);
      },
    });

    await expect(loser).rejects.toBeInstanceOf(ExitSentinel);
    expect(exitCode).toBe(1);

    const all = stderrLines.join('');
    expect(all).toContain('E_LIVE_SOCKET');
    expect(all).toContain('BL-170');

    // The winner is untouched — still serving.
    const conn: BackendConnection = dialBackend({ socketPath: sock, onDiagnostic: () => {} });
    cleanups.push(() => conn.close());
    const resp = await conn.send({ jsonrpc: '2.0', id: 99, method: 'tools/list' });
    expect((resp.result as { tools: unknown[] }).tools.length).toBe(20);
  });

  it('runBackend binds a UDS that a dialBackend client round-trips against', async () => {
    const dir = tmpDir();
    const sock = path.join(dir, 'backend.sock');
    const schemaPath = path.join(dir, 'schema.json');
    const handle = await runBackend({ socketPath: sock, schemaPath });
    cleanups.push(() => handle.close());

    // The schema was published on start.
    expect(fs.existsSync(schemaPath)).toBe(true);

    const conn: BackendConnection = dialBackend({ socketPath: sock, onDiagnostic: () => {} });
    cleanups.push(() => conn.close());

    const listResp = await conn.send({ jsonrpc: '2.0', id: 10, method: 'tools/list' });
    const tools = (listResp.result as { tools: unknown[] }).tools;
    expect(tools.length).toBe(20);

    const pingResp = await conn.send({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'memory_ping', arguments: {} },
    });
    expect(pingResp.error).toBeUndefined();
    const pingResult = pingResp.result as { content: Array<{ text: string }> };
    expect(pingResult.content[0]?.text).toContain('ok');
  });
});
