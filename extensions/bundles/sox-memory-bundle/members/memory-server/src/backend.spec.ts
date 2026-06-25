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
  it('tools/list returns the canonical 19-tool surface', async () => {
    const resp = await handleBackendRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const result = resp?.result as { tools: Array<{ name: string }> };
    expect(result.tools.length).toBe(19);
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
    expect(tools.length).toBe(19);

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
