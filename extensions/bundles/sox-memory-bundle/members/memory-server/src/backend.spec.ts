/**
 * backend.spec.ts — memory-server UDS backend mode (spec §9.5, M3→M4 bridge).
 *
 * Proves the backend JSON-RPC handler mirrors the MCP serve() surface:
 *   - initialize → serverInfo (content-addressed version) + tools capability
   *   - tools/list → the canonical 20-tool list (same shape serve() returns)
 *   - tools/call → routes to handleToolCall (here: memory_ping, no db touched —
 *     see BL-412: this was FALSE until the memory_ping guard landed; a bare
 *     memory_ping used to fall through to the real ~/.memory/memory.db and
 *     register it into the enrich loop's openedPaths. The regression test for
 *     that fix lives in bl412-ping-no-live-store.spec.ts; the assertions below
 *     were tightened to assert `store.configured === false` directly so this
 *     file can no longer silently regress the claim its own comment makes.)
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
    const savedConfig = process.env['SOX_CONFIG_DB_PATH'];
    delete process.env['SOX_CONFIG_DB_PATH'];
    cleanups.push(() => {
      if (savedConfig === undefined) delete process.env['SOX_CONFIG_DB_PATH'];
      else process.env['SOX_CONFIG_DB_PATH'] = savedConfig;
    });

    const resp = await handleBackendRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'memory_ping', arguments: {} },
    });
    const result = resp?.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain('ok');
    // BL-412: with no arguments and no host-injected SOX_CONFIG_DB_PATH, this
    // must NOT open a connection to the guessed live store — the comment
    // above ("no db touched") is only true because of this assertion.
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { store: { configured?: boolean } | null };
    expect(parsed.store?.configured).toBe(false);
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

// ── BL-62 (RESOLVED 2026-07-18): no server-side project_path inference ─────────
//
// The old `client_context.project_path` injection (a per-request frame the shim
// attached, sourced from its OWN spawn-time process.cwd() — no worktree
// canonicalization, frozen for the shim's whole lifetime) is GONE. It used to
// silently override any omitted `arguments.project_path`, which broke
// memory_topics/memory_list_entities/memory_stats (they read the top-level
// project_path key the injection targeted) whenever the shim was spawned from a
// directory with zero episodes — a git worktree, in the incident that surfaced
// this. memory_recall was only ever accidentally immune (its filter lives at
// `arguments.filters.project_path`, a key the injection never touched).
//
// New contract, proved below against a REAL scratch store (not memory_ping,
// which touches no db and can't prove anything about project_path resolution):
//   - WRITES reject outright with E_MISSING_PROJECT_PATH when project_path is
//     omitted — no fallback to client_context, env, or cwd, ever.
//   - READS omitting project_path get NO filter (search every project) — never
//     silently scoped to whatever the (now-removed) client_context said.
//   - `client_context` in the wire payload is inert: present or absent, valid or
//     malformed, it has zero effect on any tool's behavior.

describe('BL-62 — no server-side project_path inference (resolved)', () => {
  function scratchDbPath(): string {
    return path.join(tmpDir(), 'test.db');
  }

  it('memory_write with client_context but NO explicit project_path is REJECTED (no fallback to context)', async () => {
    const resp = await handleBackendRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'memory_write',
        arguments: { content: 'hello', db_path: scratchDbPath() },
        client_context: { project_path: '/workspace/project-a' },
      } as unknown as Record<string, unknown>,
    });
    const result = resp?.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('E_MISSING_PROJECT_PATH');
  });

  it('memory_write with NO project_path and NO client_context is ALSO rejected (no cwd/env fallback either)', async () => {
    const resp = await handleBackendRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'memory_write', arguments: { content: 'hello', db_path: scratchDbPath() } },
    });
    const result = resp?.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('E_MISSING_PROJECT_PATH');
  });

  it('memory_write with explicit project_path succeeds and stores exactly that value — client_context (if present) is ignored, never merged', async () => {
    const dbPath = scratchDbPath();
    const resp = await handleBackendRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'memory_write',
        arguments: { content: 'hello from project-real', project_path: '/real/project', db_path: dbPath },
        client_context: { project_path: '/decoy/project' },
      } as unknown as Record<string, unknown>,
    });
    const result = resp?.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).not.toBe(true);
    const written = JSON.parse(result.content[0]?.text ?? '{}') as { enrichment?: { project_path?: string } };
    expect(written.enrichment?.project_path).toBe('/real/project');

    // Confirm via a scoped read: filtering by the DECOY path finds nothing;
    // filtering by the REAL path finds it.
    const decoyRead = await handleBackendRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'memory_recall', arguments: { db_path: dbPath, filters: { project_path: '/decoy/project' } } },
    });
    const decoyResult = JSON.parse((decoyRead?.result as { content: Array<{ text: string }> }).content[0]?.text ?? '{}') as { results: unknown[] };
    expect(decoyResult.results.length).toBe(0);

    const realRead = await handleBackendRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'memory_recall', arguments: { db_path: dbPath, filters: { project_path: '/real/project' } } },
    });
    const realResult = JSON.parse((realRead?.result as { content: Array<{ text: string }> }).content[0]?.text ?? '{}') as { results: unknown[] };
    expect(realResult.results.length).toBe(1);
  });

  it('memory_topics with client_context present but NO explicit project_path returns UNSCOPED results (not silently filtered to the context value)', async () => {
    const dbPath = scratchDbPath();
    // Write an episode explicitly attributed to a project the client_context does NOT match.
    await handleBackendRequest({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'memory_write',
        arguments: { content: 'cve research notes', topic: 'cve-research', project_path: '/actual/project', db_path: dbPath },
      },
    });

    // Query topics with a client_context pointing at a DIFFERENT (empty) project.
    // Before the fix, this would have silently scoped to '/some/other/worktree'
    // (zero episodes there) and returned an empty topics list, even though data
    // clearly exists — exactly the reported bug.
    const resp = await handleBackendRequest({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'memory_topics',
        arguments: { db_path: dbPath },
        client_context: { project_path: '/some/other/worktree' },
      } as unknown as Record<string, unknown>,
    });
    const result = resp?.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { topics: Array<{ topic: string }>; total: number };
    expect(parsed.total).toBeGreaterThan(0);
    expect(parsed.topics.some((t) => t.topic === 'cve-research')).toBe(true);
  });

  it('malformed/null client_context is gracefully ignored (does not crash the backend)', async () => {
    for (const badContext of [{ project_path: 42 }, null, { project_path: '' }]) {
      const resp = await handleBackendRequest({
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: {
          name: 'memory_ping',
          arguments: {},
          client_context: badContext,
        } as unknown as Record<string, unknown>,
      });
      const result = resp?.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).not.toBe(true);
      expect(result.content[0]?.text).toContain('ok');
    }
  });
});
