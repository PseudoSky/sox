/**
 * memory-server/src/backend.ts — UDS backend mode (spec §9.5, M3→M4 bridge).
 *
 * The DEFAULT execution model for memory-server is now the front-shim service-proxy
 * (§9.5): the MCP client spawns a thin stdio shim (`soxe serve memory-server`),
 * which proxies tools/call to THIS persistent, sox-owned backend over a Unix domain
 * socket. The backend holds the real tool implementation (the SQLite store, the
 * embed worker, the in-process enrich loop). Because the backend's lifetime is the
 * STORE — not the client's stdio pipe — a behaviour/code upgrade of memory-server is
 * a rolling restart of the backend BEHIND the shim, with NO client reconnect.
 *
 * This module wraps the existing in-process tool dispatcher (`TOOLS` +
 * `handleToolCall`) with `serveBackend` from @adhd/sox-service-proxy. It speaks the
 * same JSON-RPC surface the MCP `serve()` path does — `initialize`, `tools/list`,
 * `tools/call` — so the shim's cached schema and the backend's live schema match
 * byte-for-byte (the [contract:schema-hash] handshake, §9.5.3).
 *
 * [inv:no-stdout-diagnostics]: the backend is a DETACHED daemon, not the client's
 * pipe — it NEVER writes to stdout. All diagnostics go to stderr.
 *
 * The C6 permission guard is unchanged: `handleToolCall` runs the policy-env guard
 * before any db_path is opened, exactly as it does on the direct-stdio path. The
 * backend is spawned by the shim with the SAME policy-env + SOX_CONFIG_* the direct
 * serve path injects, so enforcement parity holds.
 */

import type { ToolDefinition, ToolResult } from '@adhd/sox-mcp-runtime';
import { formatToolError } from '@adhd/sox-mcp-runtime';
import type { JsonRpcRequest, JsonRpcResponse } from '@adhd/sox-service-proxy';
import { serveBackend } from '@adhd/sox-service-proxy';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { closeAllAdapters, flushPendingEmbeds, terminateEmbedWorkers, WriteQueue } from '@adhd/sox-memory-core';
import { getContentAddress, handleToolCall, resolveDbPath, TOOLS, waitForDrainSettled } from './index.js';
import { computeShutdownSafetyNetMs, SHUTDOWN_BACKUP_TIMEOUT_MS } from './shutdown-margin.js';
import { forceExit } from './hard-exit.js';

/**
 * Build the canonical `tools/list` result — the EXACT shape the MCP `serve()` path
 * returns ({ tools: [{ name, description, inputSchema }] }). The shim hashes this
 * (computeSchemaHash) and serves it to the client; publishing it to schema.json
 * lets the shim answer initialize/tools/list instantly during a backend restart.
 */
export function buildToolsListResult(): { tools: Array<Omit<ToolDefinition, 'handler'>> } {
  return {
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };
}

/** The MCP serverInfo the backend reports on initialize (content-addressed). */
function serverInfo(): { name: string; version: string } {
  return { name: 'memory-server', version: getContentAddress().short };
}

/**
 * Publish the canonical tools/list to `schemaPath` so the shim can seed its cache
 * (lifecycle.schema_path). Atomic write (tmp + rename) so a mid-restart shim never
 * reads a half-written file. Best-effort: a failure only loses the instant-cache
 * optimization (the shim falls back to reading the schema from the live backend).
 */
export function publishSchema(schemaPath: string): void {
  try {
    fs.mkdirSync(path.dirname(schemaPath), { recursive: true });
    const tmp = `${schemaPath}.tmp-${String(process.pid)}`;
    fs.writeFileSync(tmp, JSON.stringify(buildToolsListResult()), 'utf8');
    fs.renameSync(tmp, schemaPath);
  } catch (e) {
    process.stderr.write(`[memory-server backend] publishSchema failed: ${(e as Error).message}\n`);
  }
}

/**
 * The JSON-RPC handler the backend serves. Mirrors mcp-runtime serve():
 *   - initialize → serverInfo + tools capability
 *   - tools/list → the canonical tools list
 *   - tools/call → handleToolCall(name, args) (which runs the C6 guard)
 * Notifications (no id) get no response.
 *
 * BL-62 (RESOLVED 2026-07-18): tool call arguments are passed through UNMODIFIED —
 * no `client_context.project_path` injection. That injection (removed) used to
 * override ANY omitted `arguments.project_path` with the shim's spawn-time
 * `process.cwd()` (no worktree canonicalization, computed once and frozen for the
 * shim's whole lifetime) — which silently broke `memory_topics`/`memory_list_entities`
 * /`memory_stats` (they read the top-level `project_path` key the injection targeted)
 * whenever the shim happened to be spawned from a directory with no episodes (a git
 * worktree, in the incident that surfaced this). `memory_recall` was only ever
 * accidentally immune, because its filter lives at `arguments.filters.project_path`,
 * a different key the injection never touched.
 *
 * There is no server-side inference of `project_path` anywhere anymore, for any
 * tool: a WRITE (`memory_write`/`memory_write_batch`) with no explicit
 * `project_path` is now rejected outright by memory-core
 * (`E_MISSING_PROJECT_PATH` — see write.ts) rather than silently guessing, since a
 * bad guess there permanently mis-attributes the episode. A READ omitting
 * `project_path` is a deliberate, valid "no filter / every project" request —
 * exactly `memory_recall`'s existing behavior — never something to silently
 * override with a guess about which directory the server happened to start in.
 */
export async function handleBackendRequest(
  req: JsonRpcRequest,
): Promise<JsonRpcResponse | undefined> {
  const id = req.id ?? null;

  if (req.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: serverInfo(),
        capabilities: { tools: {} },
      },
    };
  }

  if (req.method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: buildToolsListResult() };
  }

  if (req.method === 'tools/call') {
    const params = (req.params ?? {}) as {
      name?: string;
      arguments?: Record<string, unknown>;
    };
    const toolName = params.name ?? '';
    const args: Record<string, unknown> = params.arguments ?? {};
    let result: ToolResult;
    try {
      result = await handleToolCall(toolName, args);
    } catch (err) {
      result = formatToolError(err);
    }
    // Shape the CallToolResult exactly as serve() does.
    return {
      jsonrpc: '2.0',
      id,
      result: { content: result.content, ...(result.isError !== undefined ? { isError: result.isError } : {}) },
    };
  }

  // Notifications (no id) — best-effort, no response.
  if (req.id === undefined) return undefined;

  // Any other method (ping, etc.) — return an empty success rather than hang.
  return { jsonrpc: '2.0', id, result: {} };
}

// (BL-405, BL-592 §8.1a part B) A hard ceiling on the whole coordinated
// shutdown, strictly inside the reaper's SIGTERM grace. If graceful teardown
// hangs, this forces the exit anyway: staying inside the reaper's grace is
// worth more than a clean-but-late checkpoint the reaper will never wait for.
//
// Previously a hand-picked literal (4000, vs an ASSUMED 5000ms grace — a
// comment, not anything the reaper actually enforced). Now DERIVED from the
// resolved `stop_timeout_ms` the OS-unit generator injects
// (`SOX_CONFIG_STOP_TIMEOUT_MS`) minus the enforced `SOX_SHUTDOWN_SAFETY_MARGIN_MS`
// margin (`./shutdown-margin.ts`) — see that module's doc comment for why this
// is a duplicate of `libs/host-runtime/src/shutdown.ts` rather than an import.
// `computeShutdownSafetyNetMs()` is called FRESH inside `coordinatedShutdown`
// itself (not memoized here) so it always reflects the live env; this
// module-load snapshot exists only for callers (tests) that want the default
// (no `SOX_CONFIG_STOP_TIMEOUT_MS` override) value without invoking the
// function themselves.
export const SHUTDOWN_SAFETY_NET_MS = computeShutdownSafetyNetMs();
// (BL-85a62f57) `SHUTDOWN_BACKUP_TIMEOUT_MS` is now OWNED by `./shutdown-margin.js`
// (imported above) so `index.ts`'s DIRECT-STDIO `handleDirectStdioShutdown` can
// race the exact same literal without a circular import (`backend.ts` imports
// `./index.js`, so the reverse import can't happen). Re-exported here so every
// existing import site (`backend-shutdown.spec.ts`,
// `bug018-shutdown-budget-headroom.spec.ts`) keeps working unchanged. See
// `shutdown-margin.ts`'s doc comment for the full history (BL-405, BUG-018
// rebalanced) this constant's value carries forward.
export { SHUTDOWN_BACKUP_TIMEOUT_MS };

// (BL-472, BUG-018 rebalanced) Bounded best-effort drain for in-flight
// Phase-B embed work AND any in-flight background heal/drain pass, before
// shutdown tears down the shared embed workers / adapter. See Decision D1
// for the ORIGINAL budget derivation (750). Deliberately smaller than
// `SHUTDOWN_BACKUP_TIMEOUT_MS` used to be: this step runs FIRST, before
// every other shutdown step, so a generous budget here starves everything
// after it of the `SHUTDOWN_SAFETY_NET_MS` envelope.
//
// (BUG-018) Cut from 750 to 500. Every real repro trial (see
// `bug018-shutdown-budget-headroom.spec.ts`'s doc comment) hit this bound's
// FULL duration under real write/embed load — it is a guaranteed-eaten cost
// on every shutdown with any in-flight embed activity, not a rare edge case.
// The work this step is protecting is explicitly recoverable
// (`healMissingVectors()` re-embeds anything discarded here on the next
// process, per BL-472's own design) — durability of the checkpoint (step 2,
// which this budget was starving) is not. 500ms remains comfortably above
// ONNX's documented warm-path latency (~50-100ms, `embed-pipeline.ts:5-8`)
// while giving the checkpoint real headroom.
export const SHUTDOWN_EMBED_DRAIN_TIMEOUT_MS = 500;

// (BL-592 §8.1a part C, BUG-018 rebalanced) Step 1 (terminateEmbedWorkers())
// was previously a bare unbounded `await` — Node timers are not blocked by a
// *pending* promise, so the overall SHUTDOWN_SAFETY_NET_MS backstop should
// still catch a stall here, but a future change that makes worker
// .terminate() do synchronous work (or a native binding that blocks the
// thread) would have had no PER-STEP backstop, only the whole-sequence one —
// and no log line to attribute a stall to this step specifically.
//
// (BUG-018) Cut from 750 to 500, symmetric with step 0's own reduction —
// same rationale: this step's OWN race gives up at this bound, but the
// underlying `terminateEmbedWorkers()` promise keeps running as a background
// loser (Node's `Promise.race` never cancels it), continuing to consume
// real CPU/IO concurrently with step 2. Shrinking the FOREGROUND wait this
// step blocks on frees more of `SHUTDOWN_SAFETY_NET_MS` for the checkpoint
// that follows, without changing that background cost.
export const SHUTDOWN_EMBED_TERMINATE_TIMEOUT_MS = 500;

let _shuttingDown = false;

/**
 * (BL-592 §8.1a part C) Log a monotonic timestamp on entry/exit of every
 * coordinatedShutdown step, to the SAME stderr sink as the function's existing
 * diagnostics, so a future stall is attributable to an exact step from one
 * incident's logs alone — the single largest gap the BUG-018 design pass
 * identified (no step logged a timestamp, so the exact 2026-08-18 stall could
 * not be pinned down further). `t0` is captured once per shutdown
 * (`coordinatedShutdown`'s own entry) via `process.hrtime.bigint()` — a
 * monotonic clock immune to wall-clock adjustments during the sequence.
 */
function logShutdownStep(t0: bigint, step: number | string, name: string, phase: 'started' | 'finished'): void {
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  process.stderr.write(
    `[memory-server backend] t+${elapsedMs.toFixed(1)}ms: step ${step} ${name} ${phase}\n`,
  );
}

/** Test-only: reset the module-level shutdown guard between specs. */
export function __resetShutdownStateForTest(): void {
  _shuttingDown = false;
}

/**
 * (BL-405) The SOLE shutdown sequence for the backend process.
 *
 * Previously TWO independent `process.on('SIGTERM', ...)` listeners raced to
 * call `process.exit()`: this module's own (which called `closeAllAdapters()`
 * WITHOUT awaiting it, then closed the UDS handle and exited) and a second,
 * unrelated one in `index.ts` (which ran a full VACUUM INTO pre-restart
 * backup, then exited). Node fires every registered listener for a signal —
 * it does not pick one — so both ran concurrently and whichever finished
 * first killed the whole process, aborting the other's in-flight async work.
 *
 * Verified empirically (disposable backend, 30 real writes generating a
 * 3.2MB WAL, SIGTERM sent immediately after): the process exited in under a
 * second, logged "shutting down", and the WAL file was BYTE-IDENTICAL
 * afterward — the real checkpoint (`closeDbWithLease`'s
 * `PRAGMA wal_checkpoint(TRUNCATE)`) never ran to completion despite the log
 * line implying a clean shutdown. `index.ts` no longer registers a
 * competing handler in backend mode (`SOX_PROXY_BACKEND=1`) — this is now the
 * only listener, and its steps are SEQUENCED, not raced:
 *
 *   0. (BL-472) Bounded best-effort drain of in-flight Phase-B embed work and
 *      any in-flight background heal/drain pass — see the step's own comment
 *      below for why this must run before step 1.
 *   1. Terminate the shared fastembed/onnx child processes FIRST.
 *      `closeAllAdapters()`/`handle.close()` used to run while those children
 *      were still alive; when the parent then exited out from under them,
 *      the fastembed child's own in-flight `process.send()` threw an
 *      uncaught EPIPE — a fatal crash, reproduced on every SIGTERM tested,
 *      not just under load (see `terminateEmbedWorkers()` in `embed.ts`).
 *   2. AWAIT the real checkpoint+close on BOTH connection sets:
 *      `closeAllAdapters()` (→ `closeDbWithLease` → `PRAGMA
 *      wal_checkpoint(TRUNCATE)` + `adapter.close()` + lease release — what
 *      BL-330 credits for crash recovery) AND, as of the SECOND half of
 *      BL-405, `WriteQueue.closeAllForShutdown()`. These are TWO DIFFERENT
 *      connections to the SAME store: `WriteQueue._create()` opens its
 *      dedicated write connection via the bare `openDb()`, which is NEVER
 *      inserted into `getDb()`'s `adapterCache` — so `closeAllAdapters()`
 *      alone never touched the connection that actually took every write.
 *      Reproduced directly (see `WriteQueue.closeAllForShutdown`'s own doc
 *      comment): with only `closeAllAdapters()` awaited, a real 2000-write
 *      WAL was left at 4152 bytes (not truncated to ~0) and the write
 *      queue's connection was STILL OPEN and accepting further writes after
 *      "shutdown" had already finished. Both must complete, not race an
 *      unrelated handle-close.
 *   3. (ff7d9e24) NO VACUUM IN THE SHUTDOWN PATH. This step used to fire the
 *      pre-restart `autoBackup()` (a `VACUUM INTO`) best-effort, racing its
 *      own `SHUTDOWN_BACKUP_TIMEOUT_MS` timeout — but `Promise.race` never
 *      cancels the loser, and a synchronously-blocking `VACUUM INTO` (today's
 *      `SqliteAdapterImpl.backupTo()`) held the event loop for its entire
 *      duration, so neither that race nor the whole-sequence safety net
 *      could even be scheduled until the VACUUM returned. When the reaper's
 *      SIGTERM grace expired first, the VACUUM INTO was cut off mid-write,
 *      landing a torn/empty backup file under the FINAL rotated-backup name
 *      (production incident: three 4 KB `.db` files with 0 commit frames).
 *      Step 3 now UNCONDITIONALLY SKIPS the backup (logged, never silent) —
 *      durability here is already provided by step 2's WAL checkpoint
 *      (`closeAllAdapters()` + `WriteQueue.closeAllForShutdown()`). A
 *      `VACUUM INTO` backup is taken only by the periodic/idle `autoBackup()`
 *      path (`backup.ts`), which is never racing a shutdown deadline and can
 *      stage+verify+atomically-rename its result.
 *   4. Close the UDS listener and exit.
 *
 * `_shuttingDown` makes the whole sequence idempotent: SIGTERM and SIGINT can
 * both fire (e.g. a terminal Ctrl-C during a `soxe service restart`), and a
 * second signal while shutdown is already in flight must not re-enter it.
 */
export async function coordinatedShutdown(
  sig: string,
  getHandle: () => { close: () => Promise<void> } | null,
  /**
   * `null` skips the pre-restart backup step entirely rather than guessing a
   * path. `runBackend()` only passes a path here when `SOX_CONFIG_DB_PATH`
   * was explicitly set — the same signal a real deployed backend always has
   * (the host runtime injects it) and a bare test spawn never does.
   * `resolveDbPath(undefined)` returns `null` when unconfigured (BL 0c3522c2
   * fail-closed), so any stray SIGTERM reaching an unconfigured backend
   * (e.g. a leaked `process.on()` listener from an earlier test in the same
   * worker) will skip the backup step entirely and exit cleanly. Without this
   * guard, a stray SIGTERM would have opened a real connection to the LIVE
   * production store at `~/.memory/memory.db` purely as a side effect — the
   * bug reproduced while adding this suite's own regression tests
   * (`store.integrity.repair_failed db_path: /Users/nix/.memory/memory.db`
   * from a plain `nx test` run). BL-62 established the same rule for
   * `project_path`: never infer, only use what's explicit.
   */
  /**
   * (ff7d9e24) Kept for logging/API continuity even though step 3 no longer
   * runs a backup for either value: a `null` logs "no store configured", a
   * non-null path logs "skipping" naming that path. Neither ever opens the
   * store. `runBackend()` only passes a real path when `SOX_CONFIG_DB_PATH`
   * was explicitly set (`resolveDbPath(undefined)` returns `null`
   * otherwise, BL 0c3522c2 fail-closed) — that distinction still matters for
   * the log line even with the backup itself removed.
   */
  dbPathForBackup: string | null,
  exit: (code: number) => never,
): Promise<void> {
  if (_shuttingDown) return;
  _shuttingDown = true;
  process.stderr.write(`[memory-server backend] ${sig} — shutting down\n`);

  const t0 = process.hrtime.bigint();
  // (BL-592 §8.1a part B) Computed FRESH per-shutdown from the resolved
  // stop-timeout the OS-unit generator injected — see SHUTDOWN_SAFETY_NET_MS's
  // own doc comment above and ./shutdown-margin.ts.
  const safetyNetMs = computeShutdownSafetyNetMs();
  const safetyNet = setTimeout(() => {
    process.stderr.write(
      `[memory-server backend] shutdown exceeded ${safetyNetMs}ms safety net — ` +
      `force-exiting (BL-405: a teardown step hung; trading a clean finish for staying inside ` +
      `the reaper's grace)\n`,
    );
    exit(0);
  }, safetyNetMs);
  if (typeof safetyNet.unref === 'function') safetyNet.unref();

  // 0. (BL-472) Best-effort, BOUNDED drain of BOTH in-flight fire-and-forget
  //    seams schedulePhaseBAndWake can leave running: the Phase-B embed pass
  //    itself (flushPendingEmbeds, embed-pipeline.ts's `inFlight` set) and the
  //    debounced wakeDrain('write') heal-shaped background pass
  //    (waitForDrainSettled, index.ts's `_drainInFlightPromise`) — these are
  //    TWO SEPARATE tracking mechanisms in two separate modules; neither
  //    covers the other. Must run BEFORE step 1: `schedulePendingEmbeds`'s
  //    embed() call depends on the shared fastembed/ONNX worker
  //    terminateEmbedWorkers() is about to kill, and both seams' follow-up
  //    wq.enqueue() calls depend on the adapter closeAllAdapters()/
  //    closeAllForShutdown() are about to close. Draining first gives
  //    in-flight work — already paid for in CPU/ONNX time — a real chance to
  //    land instead of being discarded as E_IO or a worker-terminated
  //    rejection. Bounded so a slow/stuck pass cannot itself blow
  //    SHUTDOWN_SAFETY_NET_MS.
  logShutdownStep(t0, 0, 'flushPendingEmbeds+waitForDrainSettled', 'started');
  try {
    const timedOut = await Promise.race([
      Promise.all([flushPendingEmbeds(), waitForDrainSettled()]).then(() => false),
      new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(true), SHUTDOWN_EMBED_DRAIN_TIMEOUT_MS);
        if (typeof t.unref === 'function') t.unref();
      }),
    ]);
    if (timedOut) {
      process.stderr.write(
        `[memory-server backend] Phase-B/heal-drain exceeded ${SHUTDOWN_EMBED_DRAIN_TIMEOUT_MS}ms — ` +
        `proceeding with shutdown; any embedding still in flight is discarded and will be ` +
        `recovered by the next process's healMissingVectors() pass (BL-472)\n`,
      );
    }
  } catch (err) {
    process.stderr.write(`[memory-server backend] Phase-B/heal-drain failed: ${err}\n`);
  }
  logShutdownStep(t0, 0, 'flushPendingEmbeds+waitForDrainSettled', 'finished');

  // 1. Shared child processes first (BL-405) — kill() lets them exit cleanly
  //    instead of crashing on a send() to a channel the parent has already torn down.
  //    (BL-592 §8.1a part C) Bounded symmetrically with step 0 — see
  //    SHUTDOWN_EMBED_TERMINATE_TIMEOUT_MS's doc comment above. The overall
  //    safety net still governs the whole sequence; this per-step race exists
  //    so a stall specifically HERE is attributable and does not silently eat
  //    every other step's share of the safety-net envelope.
  logShutdownStep(t0, 1, 'terminateEmbedWorkers', 'started');
  try {
    const timedOut = await Promise.race([
      terminateEmbedWorkers().then(() => false),
      new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(true), SHUTDOWN_EMBED_TERMINATE_TIMEOUT_MS);
        if (typeof t.unref === 'function') t.unref();
      }),
    ]);
    if (timedOut) {
      process.stderr.write(
        `[memory-server backend] terminateEmbedWorkers exceeded ${SHUTDOWN_EMBED_TERMINATE_TIMEOUT_MS}ms — ` +
        `proceeding with shutdown; the overall safety net still bounds the whole sequence (BL-592)\n`,
      );
    }
  } catch (err) {
    process.stderr.write(`[memory-server backend] shared embed-worker teardown failed: ${err}\n`);
  }
  logShutdownStep(t0, 1, 'terminateEmbedWorkers', 'finished');

  // 2. The real checkpoint — AWAITED (BL-405: previously fire-and-forget).
  //    SA-8 / BL-128: close all DB connections with lease release so the lock
  //    file is cleaned up before process exit.
  logShutdownStep(t0, 2, 'closeAllAdapters', 'started');
  try {
    await closeAllAdapters();
  } catch (err) {
    process.stderr.write(`[memory-server backend] closeAllAdapters failed: ${err}\n`);
  }
  logShutdownStep(t0, 2, 'closeAllAdapters', 'finished');

  // 2b. (BL-405, second half) The write queue's DEDICATED connection is a
  //     SEPARATE handle from anything `closeAllAdapters()` touches — see this
  //     function's doc comment and `WriteQueue.closeAllForShutdown()`'s own
  //     doc comment for the full reproduction. Without this step the
  //     connection that actually took every write was never checkpointed or
  //     closed by shutdown at all.
  logShutdownStep(t0, '2b', 'WriteQueue.closeAllForShutdown', 'started');
  try {
    await WriteQueue.closeAllForShutdown();
  } catch (err) {
    process.stderr.write(`[memory-server backend] WriteQueue.closeAllForShutdown failed: ${err}\n`);
  }
  logShutdownStep(t0, '2b', 'WriteQueue.closeAllForShutdown', 'finished');

  // 3. (ff7d9e24) NO VACUUM IN THE SHUTDOWN PATH. This step used to fire the
  //    pre-restart `autoBackup()` (a `VACUUM INTO`) best-effort, racing its
  //    own `SHUTDOWN_BACKUP_TIMEOUT_MS` timeout — but `Promise.race` never
  //    cancels the loser, and `SqliteAdapterImpl.backupTo()`'s `VACUUM INTO`
  //    is a synchronous better-sqlite3 call that blocks the event loop for
  //    its entire duration, so neither that race nor `SHUTDOWN_SAFETY_NET_MS`
  //    above could even be scheduled until the VACUUM returned. When the
  //    reaper's SIGTERM grace expired first, the VACUUM INTO was cut off
  //    mid-write, landing a torn/empty backup file under the FINAL
  //    rotated-backup name (production incident: three 4 KB `.db` files with
  //    0 commit frames). The fix is to never run a VACUUM here at all —
  //    durability is already provided by step 2's WAL checkpoint
  //    (`closeAllAdapters()` + `WriteQueue.closeAllForShutdown()`), which ran
  //    unconditionally above regardless of `dbPathForBackup`. A `VACUUM INTO`
  //    backup is now taken only by the periodic/idle `autoBackup()` path
  //    (`backup.ts`), which is never racing a shutdown deadline and can
  //    stage+verify+atomically-rename its result.
  logShutdownStep(t0, 3, 'pre-restart backup', 'started');
  if (dbPathForBackup === null) {
    process.stderr.write(
      `[memory-server backend] ${sig}: no store configured (SOX_CONFIG_DB_PATH unset) — skipping pre-restart backup\n`,
    );
  } else {
    process.stderr.write(
      `[memory-server backend] ${sig}: skipping pre-restart backup for ${dbPathForBackup} ` +
      `(ff7d9e24: no VACUUM in shutdown path — see the periodic/idle autoBackup() path in backup.ts for backups)\n`,
    );
  }
  logShutdownStep(t0, 3, 'pre-restart backup', 'finished');

  clearTimeout(safetyNet);

  // 4. Close the listener and exit.
  logShutdownStep(t0, 4, 'handle.close', 'started');
  const handle = getHandle();
  if (handle) {
    try {
      await handle.close();
    } catch (err) {
      process.stderr.write(`[memory-server backend] handle.close() failed: ${err}\n`);
    }
  }
  logShutdownStep(t0, 4, 'handle.close', 'finished');
  exit(0);
}

/**
 * Run memory-server as a persistent UDS backend (§9.5.4). Binds `socketPath`,
 * publishes the schema (if `schemaPath` given), and serves until SIGTERM/SIGINT.
 * Resolves when the listener is bound (for tests); in production it runs forever.
 *
 * BL-170: a singleton racer that LOSES the bind (E_LIVE_SOCKET from serveBackend's
 * SA-4 probe, or a raw EADDRINUSE race) MUST exit — never idle as an orphaned
 * zombie holding a warmed model and ignoring SIGTERM. Two hardenings here:
 *   1. SIGTERM/SIGINT handlers are wired BEFORE the async bind, so even a backend
 *      stuck pre-bind drains on signal ([contract:signal]).
 *   2. A serveBackend rejection is caught, logged to stderr
 *      ([inv:no-stdout-diagnostics]), and the process exits 1 so the winning
 *      singleton self-heals without a manual reap.
 * `exit` is an injectable seam so the regression test can assert the exit path
 * without killing the test runner; production callers omit it, and the default
 * routes through `forceExit` (862129b5 TUR-F) rather than a bare `process.exit`
 * — so a shutdown whose teardown is wedged behind an in-flight driver op
 * SIGKILLs instead of waiting for the blocked native step (measured up to 21
 * min). Both call sites below (`coordinatedShutdown`'s safety net at ~L352 and
 * its normal completion at ~L487) already go through this seam; neither is a
 * bare `process.exit`.
 */
export async function runBackend(opts: {
  socketPath: string;
  schemaPath?: string;
  /** Test seam: invoked instead of process.exit on a fatal bind failure. */
  exit?: (code: number) => never;
}): Promise<{ close: () => Promise<void> }> {
  const exit: (code: number) => never =
    opts.exit ?? ((code: number): never => forceExit(code, 'backend_exit'));

  if (opts.schemaPath) publishSchema(opts.schemaPath);

  // BL-170 (2): wire signal handlers BEFORE the bind — a backend stuck pre-bind
  // must still honour SIGTERM instead of requiring a SIGKILL escalation.
  // BL-405: this is now the ONLY SIGTERM/SIGINT listener in backend mode — see
  // `coordinatedShutdown`'s doc comment for why a second, independent listener
  // (formerly in index.ts) was actively harmful.
  let handle: { socketPath: string; close: () => Promise<void> } | null = null;
  // BL-405 / BL 0c3522c2: only back up a path that was EXPLICITLY configured.
  // BL 0c3522c2 (mirrors BL-405 in index.ts): back up only a CONFIGURED store.
  // An unconfigured process has no store to back up — it must not guess one.
  const dbPathForBackup = resolveDbPath(undefined);
  process.on('SIGTERM', () => { void coordinatedShutdown('SIGTERM', () => handle, dbPathForBackup, exit); });
  process.on('SIGINT', () => { void coordinatedShutdown('SIGINT', () => handle, dbPathForBackup, exit); });

  try {
    handle = await serveBackend({
      socketPath: opts.socketPath,
      handler: handleBackendRequest,
      onDiagnostic: (l) => process.stderr.write(l + '\n'),
    });
  } catch (err) {
    // BL-170 (1): the losing singleton racer dies loudly instead of idling.
    const code = (err as { code?: string }).code ?? 'E_BIND_FAILED';
    process.stderr.write(
      `[memory-server backend] FATAL (${code}): ${(err as Error).message} — ` +
        `losing singleton racer exiting (BL-170)\n`,
    );
    return exit(1);
  }

  process.stderr.write(
    `[memory-server backend] listening on ${handle.socketPath} ` +
      `(version ${serverInfo().version})\n`,
  );

  const bound = handle;
  return { close: () => bound.close() };
}
