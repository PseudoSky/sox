/**
 * tokenguard/src/shutdown-margin.ts — BL-592 / docs/spec/service-lifecycle.md
 * §8.1a part B.
 *
 * Derives tokenguard's internal shutdown safety-net timeout from the resolved
 * `stop_timeout_ms` grace the host-runtime OS-unit generator injects, instead of
 * the bare `setTimeout(() => process.exit(0), 5000)` this module used to run —
 * which was IDENTICAL to tokenguard's own declared `lifecycle.stop_timeout_ms`
 * (`extension.json`, also 5000): a RACE against the reaper's own SIGKILL
 * escalation, not a margin. If tokenguard's own timer and the reaper's poll both
 * resolved at t=5000ms, which won was scheduler-dependent (BUG-018).
 *
 * This is a DELIBERATE, DOCUMENTED DUPLICATE of
 * `libs/host-runtime/src/shutdown.ts`'s `SOX_SHUTDOWN_SAFETY_MARGIN_MS` /
 * `resolveShutdownSafetyNetMs` / `resolveStopTimeoutMsFromEnv` — not an import.
 * tokenguard is bundled and ships as a standalone process outside this
 * workspace's `node_modules` graph at runtime, and per [inv:c7-no-reach-in] it
 * depends only on `@adhd/sox-tokenguard-core` — `@adhd/sox-host-runtime` is a
 * private workspace package it must not pull into its shipped bundle. Drift
 * between this copy and the host-runtime canonical values is guarded by
 * `bl592-shutdown-margin.spec.ts` in `libs/host-runtime`, which regex-checks
 * this file's literal against the live host-runtime export.
 */

/** MUST equal `libs/host-runtime/src/shutdown.ts`'s `SOX_SHUTDOWN_SAFETY_MARGIN_MS`. */
export const SOX_SHUTDOWN_SAFETY_MARGIN_MS = 1000;

/**
 * Read the resolved `stop_timeout_ms` this service was told to expect, from the
 * env var the OS-unit generator injects (`SOX_CONFIG_STOP_TIMEOUT_MS`,
 * `libs/host-runtime/src/os-unit.ts`'s `deriveOsUnitSpec`). Falls back to 5000
 * (matching `cmdService`'s own final fallback, and tokenguard's declared
 * `extension.json` `lifecycle.stop_timeout_ms`) when absent/invalid.
 */
export function resolveStopTimeoutMs(env: NodeJS.ProcessEnv = process.env, fallbackMs = 5000): number {
  const raw = env['SOX_CONFIG_STOP_TIMEOUT_MS'];
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallbackMs;
}

/**
 * Compute the shutdown safety-net timeout: the resolved stop-timeout minus the
 * enforced margin, floored at 0. Called FRESH at shutdown time (not memoized at
 * module load) so it always reflects the live env.
 */
export function computeShutdownSafetyNetMs(env: NodeJS.ProcessEnv = process.env): number {
  const stopTimeoutMs = resolveStopTimeoutMs(env);
  const net = stopTimeoutMs - SOX_SHUTDOWN_SAFETY_MARGIN_MS;
  return net > 0 ? net : 0;
}
