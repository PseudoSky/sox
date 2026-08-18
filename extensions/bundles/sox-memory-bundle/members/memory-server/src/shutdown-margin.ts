/**
 * memory-server/src/shutdown-margin.ts — BL-592 / docs/spec/service-lifecycle.md
 * §8.1a part B.
 *
 * Derives `coordinatedShutdown`'s internal safety-net timeout from the resolved
 * `stop_timeout_ms` grace the host-runtime OS-unit generator injects, instead of a
 * hand-picked literal that can silently drift from what the reaper actually waits
 * before escalating to SIGKILL.
 *
 * This is a DELIBERATE, DOCUMENTED DUPLICATE of
 * `libs/host-runtime/src/shutdown.ts`'s `SOX_SHUTDOWN_SAFETY_MARGIN_MS` /
 * `resolveShutdownSafetyNetMs` / `resolveStopTimeoutMsFromEnv` — not an import.
 * `@adhd/sox-host-runtime` is a private workspace package not available to this
 * bundle at runtime (see `index.ts`'s own doc comment on the same constraint,
 * lines ~30-31: memory-server ships as a standalone CommonJS process, including via
 * a published npm install with no workspace `node_modules` at all). Drift between
 * this copy and the host-runtime canonical values is guarded by
 * `bl592-shutdown-margin.spec.ts`, which asserts this file's literal against the
 * live host-runtime export (available at TEST time via the workspace `tsconfig`
 * path mapping, never bundled into the shipped artifact).
 */

/** MUST equal `libs/host-runtime/src/shutdown.ts`'s `SOX_SHUTDOWN_SAFETY_MARGIN_MS`. */
export const SOX_SHUTDOWN_SAFETY_MARGIN_MS = 1000;

/**
 * Read the resolved `stop_timeout_ms` this backend was told to expect, from the
 * env var the OS-unit generator injects (`SOX_CONFIG_STOP_TIMEOUT_MS`,
 * `libs/host-runtime/src/os-unit.ts`'s `deriveOsUnitSpec`). Falls back to 5000
 * (matching `cmdService`'s own final fallback) when absent/invalid — a bare test
 * spawn, or a backend started outside the OS-unit generator entirely.
 */
export function resolveStopTimeoutMs(env: NodeJS.ProcessEnv = process.env, fallbackMs = 5000): number {
  const raw = env['SOX_CONFIG_STOP_TIMEOUT_MS'];
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallbackMs;
}

/**
 * Compute `coordinatedShutdown`'s safety-net timeout: the resolved stop-timeout
 * minus the enforced margin, floored at 0. Called FRESH on every shutdown (not
 * memoized at module load) so a test can set `process.env` before triggering a
 * signal and observe the derived value change without a module re-import — the
 * concrete proof this is computed, not a literal (BL-592 acceptance criterion 2).
 */
export function computeShutdownSafetyNetMs(env: NodeJS.ProcessEnv = process.env): number {
  const stopTimeoutMs = resolveStopTimeoutMs(env);
  const net = stopTimeoutMs - SOX_SHUTDOWN_SAFETY_MARGIN_MS;
  return net > 0 ? net : 0;
}
