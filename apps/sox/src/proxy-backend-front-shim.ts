/**
 * proxy-backend-front-shim.ts — BL a49ca837 (redeploy severs sessions).
 *
 * Extracted seam for the `shimIsUnit` predicate + unload gate that
 * `restartProxyBackend` (apps/sox/src/main.ts) applies before verified-stopping
 * a proxy backend. `main.ts` exports nothing and defines every collaborator
 * (`unloadOwnedOsUnitsBeforeReap`, `mcpServerIsProxyMode`, etc.) as file-local
 * functions, so this predicate + gate is pulled into its own module purely to
 * make it independently unit-testable (mirrors the `grace-ms.ts` extraction,
 * commit d9af44de).
 *
 * Mirrors the os-unit execArgs predicate (~main.ts:5169): when this
 * extension's os-unit IS the port-listening front-shim, the unit runs
 * `soxe serve <id> --port <port>` — it does NOT supervise the detached
 * backend process being verified-stopped/re-ensured (ensure-backend.ts spawns
 * detached:true). Unloading/re-enabling that unit is pointless churn on a
 * process the restart never touches, so `unload()` is skipped whenever the
 * unit is the front-shim.
 */

export interface UnloadUnlessFrontShimOpts {
  /** Config env resolved for this extension (mirrors main.ts's `configEnv`). */
  configEnv: Record<string, string | undefined>;
  /** True iff this extension's mcp-server manifest runs in proxy mode. */
  proxyMode: boolean;
  /** Best-effort unload of the owned os-unit; invoked only when NOT the front-shim. */
  unload: () => void;
  log?: (m: string) => void;
}

export interface UnloadUnlessFrontShimResult {
  /** True iff the os-unit IS the port-listening front-shim (SOX_CONFIG_PORT set + proxy mode). */
  shimIsUnit: boolean;
}

/**
 * Compute `shimIsUnit` and call `unload()` unless the os-unit is the
 * front-shim. Returns `shimIsUnit` so the caller can also gate the matching
 * re-enable step (main.ts ~2626) on the same single predicate — never
 * duplicate it (commit 36520052 called out duplication as the hazard that
 * regressed BL a49ca837).
 */
export function unloadOsUnitUnlessFrontShim(
  opts: UnloadUnlessFrontShimOpts,
): UnloadUnlessFrontShimResult {
  const log = opts.log ?? (() => { /* no-op */ });
  const shimIsUnit = Boolean(opts.configEnv['SOX_CONFIG_PORT']) && opts.proxyMode;

  if (!shimIsUnit) {
    opts.unload();
  } else {
    log('skip unload: os-unit is the front-shim, does not supervise the detached backend');
  }

  return { shimIsUnit };
}
