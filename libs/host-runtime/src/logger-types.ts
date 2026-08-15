/**
 * libs/host-runtime/src/logger-types.ts — Dependency-injected logger interface.
 *
 * host-runtime accepts an optional injected logger via DI (ADR-0006).
 * When no logger is provided, defaults to no-op for debug/info and console for warn/error.
 */

export interface RuntimeLogger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/**
 * createDefaultLogger — Default logger when no injected logger is provided.
 * - debug/info: no-op (silent)
 * - warn/error: console output (preserves current observable behavior)
 */
export function createDefaultLogger(): RuntimeLogger {
  return {
    debug: () => { /* no-op */ },
    info: () => { /* no-op */ },
    warn: (event: string, fields?: Record<string, unknown>) => {
      const msg = fields ? `${event} ${JSON.stringify(fields)}` : event;
      console.warn(`[host-runtime] ${msg}`);
    },
    error: (event: string, fields?: Record<string, unknown>) => {
      const msg = fields ? `${event} ${JSON.stringify(fields)}` : event;
      console.error(`[host-runtime] ${msg}`);
    },
  };
}
