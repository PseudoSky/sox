/**
 * embedHostMain.ts — the peer-spawned, self-reaping embedding host process
 * (SPEC-EMBEDDING-FUNNEL.md §C).
 *
 * This is the compute backend of the funnel: a plain, DETACHED Node process,
 * spawned on demand by the first consumer through `ensureBackend()`'s O_EXCL
 * singleton spawn-lock. It is **never supervised** (no launchd/KeepAlive) and it
 * **reaps itself** — a debounced, ref-counted teardown retires it
 * `idleGraceMs` after the last cross-process client disconnects and in-flight
 * work drains.
 *
 * ── Compute-only (ADR-0012) ────────────────────────────────────────────────────
 *
 * The host holds NO store connection. It forwards `embedding.*` payloads 1:1 to
 * its private ONNX pool and never opens a database. It therefore cannot
 * serialize store access and must never be described as single-writer or as a
 * store serialization point; concurrent store writers are unaffected.
 *
 * ── No recursion ───────────────────────────────────────────────────────────────
 *
 * The handler forwards to `getPrivateFastembedProcess()` — the PRIVATE pool — and
 * NEVER to `getSharedFastembedProcess()`, which under `host: 'shared'` would
 * return a `FunneledFastembedClient` and dial this very host (infinite
 * recursion). The import graph is arranged so that mistake is a type error, not
 * a runtime hang.
 *
 * ── Teardown inputs are CROSS-PROCESS ─────────────────────────────────────────
 *
 *   - `activeClients` — live UDS client connections, from `serveBackend`'s
 *     `onClientCountChange` hook (the cross-process half);
 *   - `privateClient.pendingCount` — this host's own in-flight requests (the
 *     in-process half).
 *
 * `activeClients === 0 && pendingCount === 0` arms the grace timer; a new client
 * or request cancels it. On expiry the private pool is terminated, the listener
 * closed (which unlinks the socket), and the process exits 0. The private pool's
 * ONNX child is forked `detached: false`, so it dies with the host — no orphans.
 */

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { serveBackend, type BackendHandle, type JsonRpcRequest, type JsonRpcResponse } from '@adhd/sox-service-proxy';
import { resolveEmbedHostIdleGraceMs } from './embedHostConfig.js';
import { getPrivateFastembedProcess, resetPrivateFastembedProcess } from './sharedFastembedProcess.js';

/** The `embedding.*` methods the host serves. */
const HOST_METHODS = new Set([
  'embedding.init',
  'embedding.embed',
  'embedding.embedBatch',
  'embedding.reset',
  'embedding.health',
]);

function ok(id: JsonRpcRequest['id'], result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function fail(id: JsonRpcRequest['id'], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/**
 * Start the host: bind the UDS, serve `embedding.*`, and arm the debounced
 * self-reap. Resolves once the listener is up (so a caller/test can await
 * readiness); the process stays alive until the teardown fires or a signal
 * arrives.
 */
export async function runEmbedHost(): Promise<void> {
  const socketPath = process.env['SOX_EMBED_HOST_SOCKET'];
  if (!socketPath) {
    process.stderr.write(
      '[embed-host] SOX_EMBED_HOST_SOCKET is not set — the host is spawned by the funnel client, not run directly.\n',
    );
    process.exit(2);
  }

  const idleGraceMs = resolveEmbedHostIdleGraceMs();
  const privateClient = getPrivateFastembedProcess();

  let activeClients = 0;
  let idleTimer: NodeJS.Timeout | null = null;
  let shuttingDown = false;
  let handle: BackendHandle | null = null;

  const cancelIdle = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const teardown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    cancelIdle();
    try {
      await privateClient.terminate();
    } catch {
      /* best-effort — the ONNX child dies with us regardless (detached:false) */
    }
    try {
      await handle?.close();
    } catch {
      /* best-effort — the socket unlink happens inside close() */
    }
    process.exit(0);
  };

  const armIfIdle = (): void => {
    if (shuttingDown || idleTimer) return;
    if (activeClients !== 0 || privateClient.pendingCount !== 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      void teardown();
    }, idleGraceMs);
    // The listener keeps the loop alive; the timer itself must not.
    idleTimer.unref?.();
  };

  const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
    // Any inbound request is demand — cancel a pending reap.
    cancelIdle();
    const id = req.id;
    const method = req.method;

    if (!HOST_METHODS.has(method)) {
      return fail(id, -32601, `method not found: ${method}`);
    }

    try {
      if (method === 'embedding.health') {
        return ok(id, {
          started: privateClient.started,
          pendingCount: privateClient.pendingCount,
          activeClients,
          idleGraceMs,
        });
      }
      if (method === 'embedding.reset') {
        await resetPrivateFastembedProcess();
        return ok(id, { reset: true });
      }
      // embedding.init | embedding.embed | embedding.embedBatch — forward the
      // payload 1:1 to the PRIVATE pool (never the funnel accessor).
      const params = (req.params ?? {}) as Record<string, unknown>;
      const result = await privateClient.request(params);
      return ok(id, result);
    } catch (e) {
      return fail(id, -32603, e instanceof Error ? e.message : String(e));
    } finally {
      // A request may have drained the last in-flight work with no clients
      // attached (e.g. a one-shot embed) — re-arm the reap.
      if (activeClients === 0) armIfIdle();
    }
  };

  handle = await serveBackend({
    socketPath,
    handler,
    onDiagnostic: (line) => process.stderr.write(line + '\n'),
    onClientCountChange: (active) => {
      activeClients = active;
      if (active > 0) cancelIdle();
      else armIfIdle();
    },
  });

  // Arm immediately: if no client ever connects (e.g. the spawner died between
  // spawn and dial), the host must still reap rather than linger forever.
  armIfIdle();

  // A detached host can still be signalled directly (kill, OS teardown).
  process.on('SIGTERM', () => void teardown());
  process.on('SIGINT', () => void teardown());
}

/**
 * True when this module is the process entrypoint (`node dist/embedHostMain.js`).
 * `ensureBackend` spawns exactly that. A test shim that imports this module and
 * calls `runEmbedHost()` explicitly is NOT the entrypoint, so it does not
 * double-start.
 */
function isEntrypoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return resolve(fileURLToPath(import.meta.url)) === resolve(argv1);
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  runEmbedHost().catch((err: unknown) => {
    process.stderr.write(`[embed-host] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
