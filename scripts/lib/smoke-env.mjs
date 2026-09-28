/**
 * scripts/lib/smoke-env.mjs — the environment every process the smoke harness
 * spawns runs with (BL-173, BL-501, BL-635, 26121495).
 *
 * Pure (no I/O) so tools/test-26121495-smoke-embed-host-isolation.mjs can feed
 * the exact env the harness uses through the product's own socket-path and
 * model-cache resolution and prove containment.
 *
 * 26121495: an embedding host inherits HOME, TMPDIR and XDG_CACHE_HOME from its
 * spawner (ADR-0022 §5) and resolves from them:
 *   - its model cache — `SOX_EMBED_CACHE_DIR` → `$XDG_CACHE_HOME/sox/models` →
 *     `$HOME/.cache/sox/models` (libs/data/embed/embedding-provider/src/index.ts);
 *   - its socket — `$SOX_ECOSYSTEM_HOME/run/<key>.sock`, falling back to
 *     `os.tmpdir()/sox-uds/` when that path exceeds the 104-byte sun_path budget
 *     (libs/service-proxy/src/socket-path.ts, BL-578).
 * So the harness pins every one of those inputs inside the run: a short data-root
 * alias (so the socket never needs the tmp fallback), a run-owned XDG cache and
 * TMPDIR, and no inherited SOX_EMBED_CACHE_DIR.
 */

/**
 * @typedef {object} SmokeEnvConfig
 * @property {string} dataRoot       SOX_ECOSYSTEM_HOME for children (the SHORT alias)
 * @property {string} xdgCacheHome   run-owned XDG_CACHE_HOME (model cache parent)
 * @property {string} tmpdir         run-owned TMPDIR (short: the BL-578 fallback parent)
 * @property {string} fastembedLock  run-owned SOX_FASTEMBED_LOCK_PATH
 * @property {string} memoryHome     scratch $HOME for the memory-server legs
 */

/**
 * Env block injected into every child process the harness spawns. `undefined`
 * values are dropped by child_process, which is how an inherited key is removed.
 *
 * @param {NodeJS.ProcessEnv} base  the harness's own process.env
 * @param {SmokeEnvConfig} cfg
 */
export function buildSmokeEnv(base, cfg) {
  return {
    ...base,
    NODE_NO_WARNINGS: '1',
    // BL-173: redirect the data root away from the live user installation.
    // 26121495: via the short alias, so no socket falls back to the OS temp dir.
    SOX_ECOSYSTEM_HOME: cfg.dataRoot,
    // 26121495: the model cache and every temp-dir socket fallback resolve
    // inside the run, whatever the operator's shell exported.
    XDG_CACHE_HOME: cfg.xdgCacheHome,
    TMPDIR: cfg.tmpdir,
    SOX_EMBED_CACHE_DIR: undefined,
    // The BL-331 advisory fastembed lock defaults to os.tmpdir(); a `soxe serve`
    // child has no TMPDIR (env-policy ENV_BASE_ALLOW), so pin it in the run too.
    SOX_FASTEMBED_LOCK_PATH: cfg.fastembedLock,
    // BL-501: every process this harness execs (memory-server, memory-cli, ...)
    // is a synthetic spawn of the real compiled binary, not a genuine
    // production/operator invocation. Without this signal those spawns report
    // telemetry role:'live-service'/'cli' identically to a real one — see
    // resolveProcessRole() in @adhd/sox-telemetry and docs/reporting/memory/
    // findings/2026-08-17-store-connection-lifetime-forensics.md §1d.
    SOX_TELEMETRY_HARNESS: '1',
  };
}

/**
 * buildSmokeEnv() plus a scratch $HOME — used for EVERY memory-server leg, so
 * `~/.memory/**` fs-permission expansion (BL-635) and anything else keyed on
 * os.homedir() resolves inside the run. Scoped to memory-server (not folded into
 * buildSmokeEnv) so no other extension's children have $HOME redirected.
 *
 * @param {NodeJS.ProcessEnv} base
 * @param {SmokeEnvConfig} cfg
 */
export function buildMemoryServerEnv(base, cfg) {
  return { ...buildSmokeEnv(base, cfg), HOME: cfg.memoryHome };
}
