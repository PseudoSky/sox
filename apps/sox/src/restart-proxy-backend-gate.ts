/**
 * [inv:unload-then-reap] (§8.5) gate helpers extracted from
 * `restartProxyBackend` (main.ts) for regression coverage. Nothing exercised
 * the call into `unloadOsUnitUnlessFrontShim` (platform/label wiring, unload
 * thunk invocation) or the `if (!shimIsUnit)` re-enable branch — the BL
 * a49ca837 test suite covers `restartAndVerify`'s `kickstart:false`
 * excludePids path, not this call site. A dropped gate here (e.g. always
 * re-enabling, or re-enabling when the unit IS the front-shim, or the wrong
 * platform/label reaching `unloadOsUnitUnlessFrontShim`) would stay green
 * under every existing suite.
 *
 * Kept as two separate functions — NOT merged into one "core" — because
 * `reEnableOwnedOsUnit` must run strictly AFTER the backend has been
 * verified-stopped and re-ensured on new code (BUG-023): merging the calls
 * would silently reorder the re-enable ahead of the re-ensure.
 *
 * `deps` is injected so a test can fake the real os-unit/process-state
 * functions. Production callers pass the real functions (see main.ts).
 */

import type { unloadOsUnitUnlessFrontShim as UnloadOsUnitUnlessFrontShimFn } from './proxy-backend-front-shim.js';

export interface DetermineShimIsUnitDeps {
  unloadOsUnitUnlessFrontShim: typeof UnloadOsUnitUnlessFrontShimFn;
}

export interface DetermineShimIsUnitParams {
  extId: string;
  platform: Parameters<typeof UnloadOsUnitUnlessFrontShimFn>[0]['platform'];
  label: string;
  log: (m: string) => void;
  unload: () => void;
  deps: DetermineShimIsUnitDeps;
}

/**
 * Runs `unloadOsUnitUnlessFrontShim` with the platform/label/unload thunk
 * derived by the caller, and returns whether the on-disk unit's real argv
 * IS the front-shim. Must run BEFORE the verified-stop of the live backend
 * (`[inv:unload-then-reap]`) so the OS supervisor cannot resurrect it mid-reap.
 */
export function determineShimIsUnit(
  params: DetermineShimIsUnitParams,
): { shimIsUnit: boolean } {
  const { extId, platform, label, log, unload, deps } = params;
  return deps.unloadOsUnitUnlessFrontShim({
    extId,
    platform,
    label,
    unload,
    log: (m) => log(`${m} (${extId})`),
  });
}

export interface ReEnableAfterRestartGateDeps<TReenable> {
  reEnableOwnedOsUnit: (
    extId: string,
    scope: string,
    root: string,
    log: (m: string) => void,
  ) => TReenable;
}

/**
 * BUG-023 guard: re-enables the owned os-unit ONLY when `shimIsUnit` is
 * false. When `shimIsUnit` is true, `unloadOsUnitUnlessFrontShim` never
 * unloaded anything (the unit IS the front-shim), so there is nothing here
 * to re-enable — calling `reEnableOwnedOsUnit` in that case would be wrong
 * (it targets an os-unit the restart never touched). Must run AFTER the
 * fresh backend has been verified-stopped + re-ensured on new code.
 */
export function reEnableAfterRestartGate<TReenable>(
  shimIsUnit: boolean,
  extId: string,
  scope: string,
  root: string,
  log: (m: string) => void,
  deps: ReEnableAfterRestartGateDeps<TReenable>,
): TReenable | undefined {
  if (shimIsUnit) return undefined;
  return deps.reEnableOwnedOsUnit(extId, scope, root, log);
}
