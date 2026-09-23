/**
 * vitest.global-setup.ts — memory-server run-scoped preamble.
 *
 * SOLE RESPONSIBILITY: say, once and loudly at the top of the run, whether the `dist/`
 * artifacts this project's `vitest.config.ts` ALIASES are older than the `src/` they were
 * built from.
 *
 * WHY (the 2026-09-22 false P0):
 * `vitest.config.ts` resolves `@adhd/sox-memory-core` to `libs/memory-core/dist/index.js` and
 * `@adhd/sox-service-proxy` to `libs/service-proxy/dist/index.js`. Neither is source. `dist/` is
 * gitignored, so `tools/check-suite-tree-state.mjs` [BL-456] printed `CLEAN` — truthfully, about
 * the source — while a worktree ran the whole suite against a six-hour-old memory-core build.
 * `recall-degradation-visibility.spec.ts` came back `2 failed | 2 passed`: AC-1 and AC-2, the two
 * ACs that exercise `memoryRecall`'s empty-corpus return branch, failed because that build
 * predated 31888bcc, which added the empty-corpus `response.degradations = degradations` line.
 * AC-3 and AC-4 take other return paths and passed. A partial, plausible-looking failure — it was
 * escalated as "main is red and shipped that way", and main was green.
 *
 * The silent direction is worse: the same alias will happily run a suite GREEN against an
 * artifact that never contained the fix the suite is certifying. Measured the same day:
 * `libs/memory-core/dist/recall.js:501` still read `provider_call_count: 0` while HEAD's
 * `src/recall.ts` read `getProviderCallCount() - beforeCount` (85844493).
 *
 * WHY THIS WARNS RATHER THAN THROWS:
 * A stale artifact does not make a result wrong, it makes it UNATTRIBUTABLE — exactly the
 * standard BL-456 already sets for a dirty source tree, which this repo also reports rather than
 * blocks. Throwing here would also hand any agent a suite it cannot clear without running
 * `npx nx build memory-core`, which BL-235 makes a destructive act (the build target `rm -rf`s
 * dist/ BEFORE it knows the rebuild succeeds) and which is routinely under embargo while a live
 * service runs out of this worktree. The HARD gate belongs where the repo already puts its
 * pre-merge gates: `node tools/check-suite-tree-state.mjs --project memory-server --require-clean`
 * now exits 1 on a stale dist as well as on a dirty tree. Set `SOX_REQUIRE_FRESH_DIST=1` to make
 * this hook throw instead, for a packet whose acceptance IS the suite result.
 */
import { resolve } from 'node:path';
import { formatStaleReport, staleDistArtifacts } from '../../../../../tools/dist-freshness.mjs';

const repoRoot = resolve(__dirname, '../../../../..');

/**
 * Exactly the packages `vitest.config.ts` aliases to a built artifact. Kept as an explicit list
 * rather than parsed out of the config: the aliases are the contract this hook exists to police,
 * so a new alias should force a deliberate edit here, not be silently covered or silently missed.
 */
export const DIST_ALIASED_PACKAGES = [
  { name: '@adhd/sox-memory-core', pkgDir: resolve(repoRoot, 'libs/memory-core') },
  { name: '@adhd/sox-service-proxy', pkgDir: resolve(repoRoot, 'libs/service-proxy') },
];

/**
 * `vitest.config.ts` declares two `projects` (`default-mock`, `real-backend`) that both
 * `extends: true`, so vitest invokes this hook once PER PROJECT in the same runner process.
 * The finding is identical both times and a banner printed twice reads as noise, which is how
 * banners stop being read. Dedupe on a process-global, not a module-local — the two
 * invocations are not guaranteed to share a module instance.
 */
const ALREADY_REPORTED = Symbol.for('sox.memory-server.distFreshnessReported');

export default function setup(): void {
  const g = globalThis as unknown as Record<symbol, boolean>;
  if (g[ALREADY_REPORTED]) return;
  g[ALREADY_REPORTED] = true;

  const stale = staleDistArtifacts(DIST_ALIASED_PACKAGES);
  if (stale.length === 0) return;

  const report = formatStaleReport(stale, {
    context: "memory-server's vitest.config.ts aliases these to dist/, not src/",
  });
  const banner = `${report}\n\n  Until rebuilt, every result from this run is UNATTRIBUTABLE — a red may be a fix that\n  already landed in src/, and a green may be a fix that never reached dist/.`;

  if (process.env['SOX_REQUIRE_FRESH_DIST'] === '1') {
    throw new Error(banner);
  }
  console.error(`\n${banner}\n`);
}
