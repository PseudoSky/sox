/**
 * Hand-written declarations for `tools/dist-freshness.mjs`.
 *
 * The implementation is plain ESM JavaScript (it is imported by `check-suite-tree-state.mjs`,
 * a node script run directly with no build step), so there is no emitted `.d.mts`. TypeScript
 * consumers — memory-server's `vitest.global-setup.ts` and its regression spec — need one, and
 * `allowJs` is not enabled repo-wide.
 */

/** Newest file found under a directory tree, with its mtime in epoch milliseconds. */
export interface INewestFile {
  mtimeMs: number;
  file: string;
}

/** Staleness verdict for one package directory. */
export interface IDistFreshnessVerdict {
  name: string;
  pkgDir: string;
  /** True when `src/` is newer than `dist/`, or `dist/` is absent while `src/` exists. */
  stale: boolean;
  /** Human-readable explanation; `null` exactly when `stale` is false. */
  reason: string | null;
  newestSrc: INewestFile | null;
  newestDist: INewestFile | null;
  /** `newestSrc - newestDist` in ms; `null` when one side is missing. */
  lagMs: number | null;
}

export interface IPackageSpec {
  pkgDir: string;
  name?: string;
  srcSubdir?: string;
  distSubdir?: string;
}

export function newestFileUnder(
  dir: string,
  opts?: { skipPattern?: RegExp },
): INewestFile | null;

export function inspectPackage(
  pkgDir: string,
  opts?: { srcSubdir?: string; distSubdir?: string; name?: string },
): IDistFreshnessVerdict;

export function staleDistArtifacts(pkgs: IPackageSpec[]): IDistFreshnessVerdict[];

export function formatStaleReport(
  stale: IDistFreshnessVerdict[],
  opts?: { context?: string },
): string;
