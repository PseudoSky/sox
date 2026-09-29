/**
 * testing/embed-isolation.ts — shared embed-path isolation check (BL-57ae788f).
 *
 * BL-26291f21 fixed this exact hazard for memory-server's own worker processes:
 * `vitest.global-embed-scratch.ts` mints a run-scoped scratch root and pins
 * `SOX_EMBED_CACHE_DIR`/`XDG_CACHE_HOME`/`SOX_ECOSYSTEM_HOME`; a spec
 * (`bl-26291f21-embed-scratch-isolation.spec.ts`) then asserts, against the
 * product's own resolvers, that every worker's embed paths land inside that
 * root and never under the operator's real `~/.cache/sox` or
 * `~/.adhd/sox-ecosystem`. That check (`isInside`/`operatorEmbedRoots`/
 * `embedIsolationViolations`/`assertEmbedPathsIsolated`) previously lived only
 * in memory-server's `src/test-support/bl-26291f21-embed-scratch.ts`, private
 * to that package.
 *
 * BL-57ae788f needs the identical containment logic for a SECOND consumer
 * (memory-cli's `pipeline drain` spec, and any other suite outside
 * memory-server/memory-core that can trigger a real embed). Rather than
 * re-implement path containment a second time, the generic, product-agnostic
 * part is extracted here, into memory-core, which both memory-server and
 * memory-cli already depend on. memory-server's `src/test-support/
 * bl-26291f21-embed-scratch.ts` now DELEGATES its containment algorithm to
 * this shared helper (via an `extra` hook for its two extra checks) instead
 * of carrying its own copy — its exported function signatures are unchanged,
 * so nothing downstream of it needed to change. This module is NOT
 * byte-for-byte identical to what memory-server's file carried before that
 * delegation: memory-server keeps two extra, product-specific checks this
 * shared version does not run (a `SOX_ECOSYSTEM_HOME`-under-operator check,
 * and the BL-404 `TELEMETRY_DIR_ENV`-exception check), passed in via that
 * `extra` hook rather than duplicated here.
 *
 * BL-611a711e: TEST-ONLY, and now genuinely test-only in the package's shipped
 * surface — this module lives under `src/testing/` (excluded from the main
 * `tsconfig.lib.json` build and NOT re-exported from `src/index.ts`, exactly
 * like the existing `src/testing/legacy-store.ts` convention) and is reachable
 * cross-package ONLY via the dedicated `@adhd/sox-memory-core/testing`
 * subpath (`src/testing/index.ts` → its own `tsconfig.testing.json` build →
 * `dist-testing/testing/index.js`), never via `.`/`dist/index.js`, and never via
 * a package.json `exports`/`files` entry — that subpath is in-repo-only
 * (tsconfig.base.json `paths` + each consuming suite's vitest `resolve.alias`).
 * Before this fix the module lived in `src/test-support/` (not excluded from
 * `tsconfig.lib.json`) AND was re-exported from the main barrel, so it shipped
 * as part of this package's PUBLIC npm surface (`dist/index.js`/
 * `dist/index.d.ts`) — a leak, since tsc emits any file an included root file
 * (`index.ts`) imports, regardless of `exclude`.
 *
 * Never imported by production code paths.
 *
 * PURE, dependency-free-within-the-package on purpose (BL-611a711e): this module takes the
 * embed paths it checks as a PARAMETER rather than importing `getConfiguredEmbedPaths` from
 * `../embed.js` itself. `getConfiguredEmbedPaths()` lives in `embed.ts`, which pulls in most of
 * memory-core's production dependency graph (db, sqlite-vec, fastembed, …) — importing it here
 * would drag all of that into `tsconfig.testing.json`'s build (`rootDir: ./src`, so it emits
 * whatever this subpath's files import). Each caller already imports
 * `@adhd/sox-memory-core`'s main barrel for `getConfiguredEmbedPaths()` itself; resolving paths
 * there and passing them in means this module never causes a second module-graph entry into
 * memory-core internals.
 */
import * as os from 'node:os';
import * as path from 'node:path';

/** macOS reaches /tmp and /var through /private; compare both spellings. */
function spellings(p: string): string[] {
  const n = path.resolve(p);
  const out = new Set([n]);
  if (n.startsWith('/private/')) out.add(n.slice('/private'.length));
  else if (/^\/(?:tmp|var)(?:\/|$)/.test(n)) out.add(`/private${n}`);
  return [...out];
}

/** True when `p` is `root` or lies beneath it (in any /private spelling). */
export function isInside(p: string, root: string): boolean {
  for (const a of spellings(p)) {
    for (const r of spellings(root)) {
      if (a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep)) return true;
    }
  }
  return false;
}

/**
 * The operator's real embed roots, derived from the passwd entry
 * (`os.userInfo().homedir`), never from `HOME` — a harness that overrides
 * `HOME` must not be able to talk this check out of seeing the real home.
 */
export function operatorEmbedRoots(): { modelCacheRoot: string; ecosystemHome: string } {
  const home = os.userInfo().homedir;
  return {
    modelCacheRoot: path.join(home, '.cache', 'sox'),
    ecosystemHome: path.join(home, '.adhd', 'sox-ecosystem'),
  };
}

/** The embed paths a caller's own `getConfiguredEmbedPaths()` resolved, passed in by the caller. */
export interface ConfiguredEmbedPaths {
  cacheDir: string;
  hostSocketDir: string;
}

/**
 * Every reason the embed paths THIS process would resolve are not isolated
 * (empty array = isolated). `scratchRootEnvKey` names the env var the
 * caller's own scratch-root setup pins with the run-scoped root every path
 * must resolve inside. `paths` is the caller's own `getConfiguredEmbedPaths()`
 * result — this module never re-derives it (BL-611a711e: kept as a caller
 * input, not an internal import, so this module stays outside memory-core's
 * main module graph — see the file header). Positive containment (inside the
 * scratch root) AND negative (never under the operator's `~/.cache/sox` or
 * `~/.adhd/sox-ecosystem`) are both checked. `extra`, if supplied, is called
 * with `(env, operatorRoots)` and its returned violation strings are appended
 * — the extension point BL-611a711e item 3 uses so memory-server's own extra
 * checks (SOX_ECOSYSTEM_HOME, BL-404 telemetry-dir exception) can layer on
 * top of this shared base without forking the algorithm.
 */
export function embedIsolationViolations(
  scratchRootEnvKey: string,
  paths: ConfiguredEmbedPaths,
  env: NodeJS.ProcessEnv = process.env,
  extra?: (env: NodeJS.ProcessEnv, op: { modelCacheRoot: string; ecosystemHome: string }) => string[],
): string[] {
  const out: string[] = [];
  const scratch = env[scratchRootEnvKey];
  const { cacheDir, hostSocketDir } = paths;
  const op = operatorEmbedRoots();
  if (scratch === undefined || scratch === '') {
    out.push(`${scratchRootEnvKey} is unset — the scratch-root setup did not run for this worker`);
  } else {
    if (!isInside(cacheDir, scratch)) {
      out.push(`embed model cache ${cacheDir} is outside the run scratch root ${scratch}`);
    }
    if (!isInside(hostSocketDir, scratch)) {
      out.push(`embed host socket dir ${hostSocketDir} is outside the run scratch root ${scratch}`);
    }
  }
  for (const [what, p] of [
    ['embed model cache', cacheDir],
    ['embed host socket dir', hostSocketDir],
  ] as const) {
    for (const root of [op.modelCacheRoot, op.ecosystemHome]) {
      if (isInside(p, root)) out.push(`${what} ${p} resolves under the OPERATOR's ${root}`);
    }
  }
  if (extra) out.push(...extra(env, op));
  return out;
}

/** Throw (fail fast, before anything can spawn a host) when the embed paths are not isolated. */
export function assertEmbedPathsIsolated(
  scratchRootEnvKey: string,
  paths: ConfiguredEmbedPaths,
  where: string,
  extra?: (env: NodeJS.ProcessEnv, op: { modelCacheRoot: string; ecosystemHome: string }) => string[],
): void {
  const v = embedIsolationViolations(scratchRootEnvKey, paths, process.env, extra);
  if (v.length > 0) {
    throw new Error(
      `BL-57ae788f REGRESSION (${where}): a real embed in this worker would spawn/dial the shared ` +
        `embedding host outside the test scratch root:\n  - ${v.join('\n  - ')}`,
    );
  }
}
