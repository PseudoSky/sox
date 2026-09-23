/**
 * Type surface for `tools/repin-registry-entry.mjs`.
 *
 * `tools/*.mjs` have no build step by design, so there is no emitted `.d.mts`.
 * This hand-written one exists so `scripts/entrypoint-resolution-conformance.test.ts`
 * can import the tool's entrypoint resolver under `tsc --noEmit` without an
 * `any` (TS7016) or a suppression comment.
 */

/**
 * Resolve the checksum-anchor file inside an extracted package dir.
 * Throws if the manifest's declared entrypoint escapes `dir`.
 */
export declare function resolveEntrypointFile(dir: string): string;
