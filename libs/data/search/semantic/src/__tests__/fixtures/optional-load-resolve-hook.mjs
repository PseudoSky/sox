/**
 * optional-load-resolve-hook.mjs — the armed guard for the optional-loadability
 * invariant of @adhd/sox-semantic.
 *
 * Loaded by `optional-load-guard.mjs` through `module.register()`, so it sees
 * EVERY bare-specifier resolution the module graph performs — including the
 * static imports at the top of `dist/index.js` and anything reached
 * transitively. That reach matters: an earlier draft of this invariant assumed
 * only sox-semantic's own two imports had to be lazy, but `@adhd/sox-hybrid-search`
 * (a mandatory dependency) re-exports `cross-encoder.js`, which statically
 * imports `@adhd/sox-embedding-provider` — so a static hybrid-search import
 * resolves the optional package on every path. The guard catches that; a guard
 * scoped to sox-semantic's own file would not.
 *
 * It both RECORDS every specifier (the evidence the caller asserts on) and
 * THROWS on the optional heavy two (so a regression cannot pass silently — the
 * import simply fails).
 */
import { appendFileSync } from 'node:fs';

/** @type {{ heavy: string[], logFile: string }} */
let config = { heavy: [], logFile: '' };

/**
 * Receives the `data` payload passed to `module.register()`.
 * @param {{ heavy?: string[], logFile?: string }} data
 */
export function initialize(data) {
  config = { heavy: data?.heavy ?? [], logFile: data?.logFile ?? '' };
}

/**
 * @param {string} specifier
 * @param {unknown} context
 * @param {(specifier: string, context: unknown) => Promise<unknown>} nextResolve
 */
export async function resolve(specifier, context, nextResolve) {
  if (config.logFile) {
    // Recorded BEFORE the throw, so a red run still shows which specifier
    // tripped the guard.
    appendFileSync(config.logFile, `${specifier}\n`);
  }
  if (config.heavy.includes(specifier)) {
    throw new Error(
      `OPTIONAL-LOAD GUARD: "${specifier}" was resolved — it must never be requested on the DI-injected path`,
    );
  }
  return nextResolve(specifier, context);
}
