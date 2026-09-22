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
 *   - `inFlight` — THIS host's own request depth, incremented synchronously at
 *     the top of every handler invocation and decremented in its `finally` (the
 *     in-process half). It is deliberately NOT the private pool's
 *     `pendingCount`: that counter is incremented only AFTER `ensureProcess()`
 *     (the fork) resolves, so it reads 0 during a cold-start fork and would arm
 *     a reap over live work. `inFlight` is the synchronous truth.
 *
 * `activeClients === 0 && inFlight === 0` arms the grace timer; a new client
 * or request cancels it. On expiry the private pool is terminated, the listener
 * closed (which unlinks the socket), and the process exits 0. The private pool's
 * ONNX child is forked `detached: false`, so it dies with the host — no orphans.
 *
 * ── The accessor is resolved at EVERY use, never captured ──────────────────────
 *
 * `embedding.reset` terminates AND nulls the private singleton
 * (`resetPrivateFastembedProcess()`); a host that captured the accessor once
 * would keep forwarding through the terminated reference and answer every later
 * request with `shared fastembed process terminated`. Every use
 * (the request handler, `armIfIdle`, `teardown`, `health`) therefore calls
 * `getPrivateFastembedProcess()` fresh.
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

  let activeClients = 0;
  /**
   * This host's own in-flight request depth. Incremented synchronously before
   * the handler's first `await` and decremented in its `finally`, so it covers a
   * request's entire synchronous prefix — including the cold-start fork, where
   * the private pool's `pendingCount` still reads 0.
   */
  let inFlight = 0;
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
      // Resolve the accessor at teardown time: a preceding `embedding.reset`
      // may have swapped the private singleton for a fresh one.
      await getPrivateFastembedProcess().terminate();
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
    if (activeClients !== 0 || inFlight !== 0) return;
    // Defensive second gate: the private pool's own counter, resolved per use so
    // a post-reset pool is never the stale terminated reference.
    if (getPrivateFastembedProcess().pendingCount !== 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      void teardown();
    }, idleGraceMs);
    // The listener keeps the loop alive; the timer itself must not.
    idleTimer.unref?.();
  };

  const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
    // Any inbound request is demand — cancel a pending reap, and count this
    // request as in-flight BEFORE the first await (the synchronous prefix).
    cancelIdle();
    inFlight++;
    const id = req.id;
    const method = req.method;

    try {
      if (!HOST_METHODS.has(method)) {
        return fail(id, -32601, `method not found: ${method}`);
      }

      if (method === 'embedding.health') {
        const pc = getPrivateFastembedProcess();
        return ok(id, {
          started: pc.started,
          pendingCount: pc.pendingCount,
          inFlight,
          activeClients,
          idleGraceMs,
        });
      }
      if (method === 'embedding.reset') {
        await resetPrivateFastembedProcess();
        return ok(id, { reset: true });
      }
      // embedding.init | embedding.embed | embedding.embedBatch — forward the
      // payload 1:1 to the PRIVATE pool (never the funnel accessor), resolving
      // it per use so a reset mid-life never leaves us on a terminated pool.
      const params = (req.params ?? {}) as Record<string, unknown>;
      const result = await getPrivateFastembedProcess().request(params);
      return ok(id, result);
    } catch (e) {
      return fail(id, -32603, e instanceof Error ? e.message : String(e));
    } finally {
      inFlight--;
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
