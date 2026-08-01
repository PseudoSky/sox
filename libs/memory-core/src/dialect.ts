/**
 * dialect.ts — one place that turns a StoreAdapter into its SQL dialects.
 *
 * BL-381. Every module outside `store-adapter`/`migration.ts` that needs
 * backend-shaped SQL goes through a dialect object rather than naming a
 * backend. Before this existed, each consumer either re-derived the dialect
 * inline (`recall.ts`, `db.ts`) or — worse — hardcoded one backend's syntax and
 * guarded it with a boolean that call sites forgot to pass (`neardup.ts`).
 *
 * `@adhd/sox-store-adapter` is imported dynamically, matching every other
 * value-level use of it in memory-core: memory-core compiles to CommonJS and a
 * static import would pull the adapter's ESM graph into every CJS consumer.
 */

import type { StoreAdapter, VectorDialect, FTSDialect } from '@adhd/sox-store-adapter';

/** The VectorDialect matching `adapter`'s backend. */
export async function vectorDialectFor(adapter: StoreAdapter): Promise<VectorDialect> {
  const { createVectorDialect } = await import('@adhd/sox-store-adapter');
  return createVectorDialect(adapter.config.type);
}

/** The FTSDialect matching `adapter`'s backend. */
export async function ftsDialectFor(adapter: StoreAdapter): Promise<FTSDialect> {
  const { createFTSDialect } = await import('@adhd/sox-store-adapter');
  return createFTSDialect(adapter.config.type);
}
