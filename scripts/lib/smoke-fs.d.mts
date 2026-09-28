/**
 * Hand-written declarations for the parts of `scripts/lib/smoke-fs.mjs` that TypeScript test
 * infrastructure imports (memory-server's `vitest.global-embed-scratch.ts`, BL-26291f21). The
 * implementation is plain ESM run directly by node with no build step, and `allowJs` is not
 * enabled repo-wide — same arrangement as `tools/dist-freshness.d.mts`.
 */

/** Stat-only fingerprint of a tree (relative path → `ino:birthtimeMs:size`); never reads content. */
export function treeFingerprint(root: string): Record<string, string>;

/**
 * The operator's model cache dir, resolved as the product resolves it
 * (`SOX_EMBED_CACHE_DIR` → `$XDG_CACHE_HOME/sox/models` → `$HOME/.cache/sox/models`).
 */
export function operatorModelCacheDir(env: NodeJS.ProcessEnv): string;

export interface ISeedModelCacheResult {
  seeded: boolean;
  method: 'clone' | 'copy' | null;
  reason: string;
  files: number;
  bytes: number;
}

/**
 * 3ebd7ecb: seed `dst` (a model dir) from `src` by copy-on-write clone (`cp -c -R` on darwin,
 * `cp --reflink=auto -R` elsewhere), falling back to a plain copy. The source is only read.
 */
export function seedModelCache(o: {
  src: string;
  dst: string;
  platform?: string;
  log?: (s: string) => void;
}): ISeedModelCacheResult;
