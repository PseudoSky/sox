/**
 * libs/host-runtime/src/shutdown.ts — BL-592 / docs/spec/service-lifecycle.md §8.1a
 * (grace-margin discipline).
 *
 * Canonical, single-sourced definition of the margin every service's own internal
 * shutdown safety-net timeout must sit inside its resolved `stop_timeout_ms` grace
 * by. Before this module existed, `memory-server`'s `SHUTDOWN_SAFETY_NET_MS` (4000)
 * and `tokenguard`'s bare `setTimeout(..., 5000)` were two independently hand-picked
 * literals that happened to agree with an ASSUMED 5000ms reaper grace — tokenguard's
 * literally TIED its own safety net to the same value as its declared
 * `lifecycle.stop_timeout_ms` (both 5000), a race, not a margin: whichever of the
 * service's own timer and the reaper's SIGKILL escalation fired first was
 * scheduler-dependent (BUG-018).
 *
 * `resolveShutdownSafetyNetMs` is the one function that turns a resolved grace into
 * a safety-net timeout with a guaranteed positive margin. Every service that owns a
 * shutdown safety-net timer should compute it FROM this function (or a same-shaped
 * local mirror — `memory-server` and `tokenguard` are bundled and run standalone,
 * outside this workspace's `node_modules` graph, so they cannot import this private
 * package at runtime; see their own shutdown-margin modules' doc comments for the
 * drift-detection test that keeps their local literal equal to
 * `SOX_SHUTDOWN_SAFETY_MARGIN_MS` below), never re-derive the number from scratch.
 *
 * The resolved `stop_timeout_ms` a service should plug in here is the SAME value
 * the OS-unit generator (`os-unit.ts`'s `deriveOsUnitSpec`) resolves from the
 * manifest and injects as `SOX_CONFIG_STOP_TIMEOUT_MS` — see
 * `resolveStopTimeoutMsFromEnv` below, the counterpart reader.
 */

/**
 * The mandatory gap between a service's resolved SIGTERM grace (what the reaper
 * will wait before escalating to SIGKILL) and that service's own internal
 * shutdown safety-net timeout (the point at which the service force-exits itself
 * rather than trust every awaited teardown step to finish in time).
 *
 * 1000ms, chosen so a service's safety net always fires with room to spare before
 * the reaper's SIGKILL — never simultaneously, never after.
 */
export const SOX_SHUTDOWN_SAFETY_MARGIN_MS = 1000;

/**
 * Derive a service's internal shutdown safety-net timeout from its resolved
 * `stop_timeout_ms` grace, enforcing `SOX_SHUTDOWN_SAFETY_MARGIN_MS` of headroom.
 * Never negative — floors at 0 (immediate force-exit) for a pathologically small
 * declared grace rather than producing a negative `setTimeout` delay.
 */
export function resolveShutdownSafetyNetMs(
  stopTimeoutMs: number,
  marginMs: number = SOX_SHUTDOWN_SAFETY_MARGIN_MS,
): number {
  const net = stopTimeoutMs - marginMs;
  return net > 0 ? net : 0;
}

/**
 * Read the resolved `stop_timeout_ms` a service was told to expect, from the env
 * var the OS-unit generator already injects (`SOX_CONFIG_STOP_TIMEOUT_MS`,
 * `os-unit.ts`'s `deriveOsUnitSpec`) — never re-derived per service, so it can
 * never drift from what `cmdService`'s `graceMs` resolver (§8.1a part A) actually
 * uses. Falls back to `fallbackMs` (default 5000, matching `cmdService`'s own
 * final fallback) when absent or invalid — e.g. a bare test spawn, or a process
 * started outside the OS-unit generator entirely (in-process supervisor, direct
 * `node dist/index.js`).
 */
export function resolveStopTimeoutMsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fallbackMs = 5000,
): number {
  const raw = env['SOX_CONFIG_STOP_TIMEOUT_MS'];
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallbackMs;
}
