/**
 * BL-f03d2bb6 — a `serve()`d MCP stdio server MUST exit when its client closes
 * stdin.
 *
 * Spec: docs/spec/service-lifecycle.md §2 M3 — "Client closes stdin/the pipe →
 * process exits. soxe does not stop it." The MCP stdio binding makes the client
 * the supervisor; closing the child's stdin is the portable graceful-shutdown
 * signal. Before this fix, `serve()` wired graceful shutdown on SIGTERM/SIGINT
 * only, and the SDK's StdioServerTransport (1.29.0) never listens for
 * 'end'/'close' on stdin, so EOF tore nothing down.
 *
 * ── Why the fixture binds `uds` alongside `stdio` ─────────────────────────────
 * A *stdio-only* `serve()`d process already happens to exit on EOF: Node closes
 * the read end of a pipe at EOF and drops its ref, so there is nothing left to
 * pin the event loop and no fix is needed to observe an exit (verified — a bare
 * stdio fixture exits 0 on EOF with the old code). That makes a stdio-only
 * fixture useless as a regression guard: it can never go red.
 *
 * To make the socket-level contract observable, the fixture ALSO binds a `uds`
 * transport. The UDS listener is a `net.Server` the runtime owns and nothing
 * else closes — exactly the class of handle §2 M3 requires EOF to tear down. So
 * without the EOF path the process stays resident (RED) and with it the same
 * graceful shutdown SIGTERM runs closes every transport and the loop drains
 * (GREEN). This mirrors the real failure: `soxe serve <mcp-server> --no-proxy`
 * hung because a runtime-owned handle outlived the closed stdin.
 *
 * The fixture is written to a scratch dir and run through `tsx` (the repo's
 * established pattern for spawning a real TS entrypoint — see
 * memory-server's bl-df0ea359 helpers) importing the runtime SOURCE, so the
 * test measures the fix under test and not a stale built `dist/`.
 */
import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const TSX_BIN = path.resolve(REPO_ROOT, 'node_modules/.bin/tsx');
/** Runtime entry — tsx resolves the `.js` specifier to the sibling `index.ts`. */
const RUNTIME_ENTRY = path.resolve(__dirname, 'index.js');

const READY_TIMEOUT_MS = 10_000;
const EXIT_TIMEOUT_MS = 10_000;

const INIT =
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":' +
  '{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"bl-f03d2bb6","version":"0.0.0"}}}';
const INITIALIZED = '{"jsonrpc":"2.0","method":"notifications/initialized"}';
const LIST = '{"jsonrpc":"2.0","id":2,"method":"tools/list"}';

/** Write the child entry into `dir`, returning its path. */
function writeFixture(dir: string): string {
  const entry = path.join(dir, 'bl-f03d2bb6-entry.ts');
  fs.writeFileSync(
    entry,
    [
      `import { serve, defineTool } from ${JSON.stringify(RUNTIME_ENTRY)};`,
      `const socketPath = process.argv[2];`,
      `serve(`,
      `  [`,
      `    defineTool({`,
      `      name: 'bl_f03d2bb6_ping',`,
      `      description: 'BL-f03d2bb6 liveness fixture.',`,
      `      inputSchema: { type: 'object', properties: {} },`,
      `      handler: () => ({ content: [{ type: 'text', text: 'pong' }] }),`,
      `    }),`,
      `  ],`,
      `  {`,
      `    name: 'bl-f03d2bb6-fixture',`,
      `    transport: { transports: ['stdio', 'uds'], socketPath },`,
      `  },`,
      `);`,
      ``,
    ].join('\n'),
  );
  return entry;
}

describe('BL-f03d2bb6 — serve()d stdio server exits on stdin EOF', () => {
  it('exits 0 when the client closes stdin (spec §2 M3)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-f03d2bb6-'));
    const socketPath = path.join(dir, 'm.sock');
    const entry = writeFixture(dir);

    let stdout = '';
    let stderr = '';
    let child: ChildProcessWithoutNullStreams | undefined;

    try {
      child = spawn(TSX_BIN, [entry, socketPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      const c = child;
      c.stdout.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      c.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });

      c.stdin.write(INIT + '\n');
      c.stdin.write(INITIALIZED + '\n');
      c.stdin.write(LIST + '\n');

      // Wait until the server has completed `initialize` — proving it is fully
      // bound (stdio + uds) before we close stdin, so the EOF path is the only
      // thing under test.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `fixture did not answer initialize within ${READY_TIMEOUT_MS}ms\n` +
                `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
            ),
          );
        }, READY_TIMEOUT_MS);
        c.stdout.on('data', () => {
          if (stdout.includes('"id":1')) {
            clearTimeout(timer);
            resolve();
          }
        });
        c.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      // The client's graceful-shutdown signal: close stdin.
      c.stdin.end();

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          c.kill('SIGKILL');
          reject(
            new Error(
              `server did not exit within ${EXIT_TIMEOUT_MS}ms after stdin EOF ` +
                `(spec §2 M3 violated)\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
            ),
          );
        }, EXIT_TIMEOUT_MS);
        c.once('close', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
        c.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      expect(exitCode).toBe(0);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
