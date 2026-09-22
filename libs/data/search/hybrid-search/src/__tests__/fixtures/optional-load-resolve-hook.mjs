/**
 * optional-load-resolve-hook.mjs — the armed guard for the optional-loadability
 * invariant of @adhd/sox-hybrid-search.
 *
 * Loaded by `optional-load-guard.mjs` through `module.register()`, so it sees
 * EVERY bare-specifier resolution the module graph performs — including the
 * static imports at the top of `dist/index.js` and anything reached
 * transitively. That reach matters: `@adhd/sox-hybrid-search`'s entrypoint
 * re-exports `cross-encoder.js`, which used to statically import
 * `@adhd/sox-embedding-provider` — so a plain `import '@adhd/sox-hybrid-search'`
 * (for the pure `fuse()`, say) resolved the optional native chain. The guard
 * catches that; a guard scoped to one file would not.
 *
 * It both RECORDS every specifier (the evidence the caller asserts on) and
 * THROWS on the optional heavy two (so a regression cannot pass silently — the
 * import simply fails, and the caller additionally proves the failure is the
 * honest, named-specifier degradation and not a bare ERR_MODULE_NOT_FOUND).
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
      `OPTIONAL-LOAD GUARD: "${specifier}" was resolved — it must never be requested on the pure path ` +
        `(fuse/normalize/rrfFuse, or StoreSearchBackend over injected backends)`,
    );
  }
  return nextResolve(specifier, context);
}
