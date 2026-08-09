/**
 * bl497-env.setup.ts — ambient-env capture for bl497-min-content-length.spec.ts.
 *
 * BL-497 review caveat 1: the spec statically imports cluster.js at collection
 * time, so an ambient `SOX_CLUSTER_MIN_CONTENT_LENGTH` exported in the shell/CI
 * would be baked into `CLUSTER_ELIGIBLE_SQL` and break the assertions that pin
 * the DEFAULT floor at 20 (reproduced: expected 40-vs-20 at spec :160). This
 * module MUST be the spec's FIRST import — before any import that
 * (transitively) loads cluster.js — so the ambient value is captured and
 * stripped before the clusterer's config-time read, making the default-floor
 * import deterministic under ANY exported value. The spec restores the captured
 * value in its own afterAll so no other spec file ever observes the strip.
 *
 * Not registered as a vitest setupFiles entry: it is imported by the one spec
 * that needs it, so the strip has zero effect on every other spec file.
 */
export const AMBIENT_SOX_CLUSTER_MIN_CONTENT_LENGTH = process.env['SOX_CLUSTER_MIN_CONTENT_LENGTH'];
delete process.env['SOX_CLUSTER_MIN_CONTENT_LENGTH'];
