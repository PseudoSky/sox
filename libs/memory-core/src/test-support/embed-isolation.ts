/**
 * test-support/embed-isolation.ts — shared embed-path isolation check (BL-57ae788f).
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
 * memory-cli already depend on. memory-server's own module is left
 * UNTOUCHED by this extraction (this is purely additive) — it may adopt this
 * shared helper later without any behavior change, since the logic here is
 * byte-for-byte the same algorithm, just parameterized on the scratch-root
 * env var name instead of hardcoding memory-server's `SOX_MEMSRV_TEST_SCRATCH_ROOT`.
 *
 * TEST-ONLY: never imported by production code paths.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { getConfiguredEmbedPaths } from '../embed.js';

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

/**
 * Every reason the embed paths THIS process would resolve are not isolated
 * (empty array = isolated). `scratchRootEnvKey` names the env var the
 * caller's own scratch-root setup pins with the run-scoped root every path
 * must resolve inside. Positive containment (inside the scratch root) AND
 * negative (never under the operator's `~/.cache/sox` or
 * `~/.adhd/sox-ecosystem`), both checked against the product's own resolver
 * (`getConfiguredEmbedPaths()`), never a re-derived path.
 */
export function embedIsolationViolations(
  scratchRootEnvKey: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const out: string[] = [];
  const scratch = env[scratchRootEnvKey];
  const { cacheDir, hostSocketDir } = getConfiguredEmbedPaths();
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
  return out;
}

/** Throw (fail fast, before anything can spawn a host) when the embed paths are not isolated. */
export function assertEmbedPathsIsolated(scratchRootEnvKey: string, where: string): void {
  const v = embedIsolationViolations(scratchRootEnvKey);
  if (v.length > 0) {
    throw new Error(
      `BL-57ae788f REGRESSION (${where}): a real embed in this worker would spawn/dial the shared ` +
        `embedding host outside the test scratch root:\n  - ${v.join('\n  - ')}`,
    );
  }
}
