/**
 * @adhd/sox-nx:atomic-tsc — BL-235 (remainder) / BL-242.
 *
 * `@nx/js:tsc` defaults to `clean: true` ("Remove previous output before build" —
 * @nx/js/src/executors/tsc/schema.json). That default flows into
 * `NormalizedExecutorOptions.deleteOutputPath`, which does an unconditional
 * `fs.rmSync(outputPath, { recursive: true, force: true })` *before* compiling
 * (@nx/js/src/utils/typescript/compilation.js). If the source does not compile,
 * the previous working artifact is destroyed and unrecoverable — the only way back
 * is a successful build, which is exactly what has just failed. `clean: false` is
 * not an acceptable substitute: it reintroduces the BL-4 stale-dist class
 * (libs/data/CLAUDE.md) where a deleted source file leaves a stale `.js` behind.
 *
 * This executor delegates to nx's own `tscExecutor` — the literal compilation
 * pipeline `@nx/js:tsc` runs, same options contract, same tsc.impl.js — but points
 * its `outputPath` at a fresh, empty staging directory instead of the real one.
 * `clean`'s pre-build rm therefore only ever touches a directory nothing has
 * written to yet. Only after a successful compile is the staging directory swapped
 * into place, via the same stage → commit-by-rename → rollback pattern already
 * proven for esbuild bundles in tools/bundle-extension.cjs (search "BL-235" there):
 *
 *   1. Compute `<outputPath>.staging-<pid>`, remove any leftover, create fresh.
 *   2. Delegate to the real tscExecutor with outputPath = staging dir.
 *   3. On failure/throw: delete staging, leave outputPath untouched, `{success:false}`.
 *   4. On success: rename outputPath -> `<outputPath>.prev-<pid>` (if it exists),
 *      rename staging -> outputPath. If either rename fails, roll back to the
 *      prior directory and report failure. Otherwise delete the `.prev-<pid>` dir.
 *
 * Clean-output semantics are preserved (staging always starts empty, so a file that
 * is no longer produced by this compile simply does not appear after the swap) —
 * without the destroy-before-build window that made `@nx/js:tsc` dangerous.
 *
 * WATCH MODE: staging+swap is only meaningful for one-shot builds. In `--watch`,
 * the TypeScript watch host holds the staging directory open across many
 * incremental compiles; swapping it out from under the host after the first
 * success would break every write after that (the host still references the old
 * absolute path). So `watch: true` bypasses staging entirely and delegates straight
 * to the real tscExecutor — identical behavior to using `@nx/js:tsc` directly.
 * Atomicity is a one-shot-build guarantee here, which is what `nx build` needs.
 *
 * [inv:nx-free-core] — this file imports @nx/devkit and @nx/js; it is adapter code
 * (packages/sox-nx is the designated home for nx-devkit-consuming code), not
 * libs/authoring core, which must stay devkit-free.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ExecutorContext } from '@nx/devkit';
import type { ExecutorOptions as TscExecutorOptions } from '@nx/js/src/utils/schema';
// `tscExecutor` is nx's real compilation pipeline for `@nx/js:tsc` — the exact same
// tsc.impl.js this executor stands in for (verified: `Object.keys(require(...))`
// includes `tscExecutor`, an async generator). @nx/js's package.json declares no
// "exports" map (checked against the installed node_modules/@nx/js/package.json),
// so this deep import is not blocked by Node's package-exports enforcement — but it
// is still an internal path, not @nx/js's public API, and could move on a future
// @nx/js major. Pinned version in this workspace: nx/@nx/js 22.7.5. If this import
// ever fails to resolve after an @nx/js bump, that is the signal to re-verify the
// internal path against the new version rather than silently falling back to
// destructive `@nx/js:tsc` semantics.
//
// A plain `import` (not `require`) is used deliberately: when nx loads this local
// plugin executor straight from TypeScript source (its own staleness-avoidance
// behavior for non-node_modules plugins — see nx's `resolveImplementation` /
// `tryResolveFromSource` in config/schema-utils.js), it registers a TS transpiler
// and evaluates the module in the workspace's module context, which is ESM
// (root package.json has "type": "module"). A bare `require()` call throws
// "require is not defined in ES module scope" there even though it works fine
// once compiled to this package's own CJS `dist/` output — `import` works in both.
import { tscExecutor } from '@nx/js/src/executors/tsc/tsc.impl.js';

interface TscCompilationResult {
  success: boolean;
  outfile?: string;
}

export type AtomicTscExecutorSchema = TscExecutorOptions;

export default async function* atomicTscExecutor(
  options: AtomicTscExecutorSchema,
  context: ExecutorContext,
): AsyncGenerator<TscCompilationResult, TscCompilationResult, unknown> {
  const projectLabel = context.projectName ?? '(unknown project)';

  if (options.watch) {
    console.warn(
      `atomic-tsc: [${projectLabel}] watch mode is not staged/atomic — delegating straight to ` +
        'the underlying tsc compilation (same behavior as @nx/js:tsc). One-shot builds ' +
        "(`nx build <project>`) get the full stage + atomic-swap guarantee.",
    );
    const result = yield* tscExecutor(options, context);
    return result ?? { success: false };
  }

  if (!options.outputPath) {
    console.error(`atomic-tsc: [${projectLabel}] missing required option "outputPath"`);
    return { success: false };
  }

  const workspaceRoot = context.root;
  const relativeOutputPath = options.outputPath;
  const absOutputPath = path.join(workspaceRoot, relativeOutputPath);
  const pid = process.pid;
  const relativeStagingPath = `${relativeOutputPath}.staging-${pid}`;
  const absStagingPath = path.join(workspaceRoot, relativeStagingPath);
  const absPrevPath = `${absOutputPath}.prev-${pid}`;

  // Fresh, empty staging dir — the real outputPath is never touched until commit.
  fs.rmSync(absStagingPath, { recursive: true, force: true });
  fs.mkdirSync(absStagingPath, { recursive: true });

  console.log(
    `atomic-tsc: [${projectLabel}] compiling → ${relativeOutputPath} ` +
      `(staged via ${path.basename(absStagingPath)})`,
  );

  const stagedOptions: TscExecutorOptions = {
    ...options,
    outputPath: relativeStagingPath,
    // Staging always starts empty, so the pre-build rm this triggers inside
    // tscExecutor is a harmless no-op against a directory nothing has written to.
    clean: true,
  };

  let lastResult: TscCompilationResult | undefined;
  try {
    for await (const result of tscExecutor(stagedOptions, context)) {
      lastResult = result;
    }
  } catch (err) {
    // The staged compile threw. `outputPath` was never touched — the previous
    // working artifact (if any) is still there.
    fs.rmSync(absStagingPath, { recursive: true, force: true });
    console.error(
      `atomic-tsc: [${projectLabel}] compilation threw — existing output left intact at ` +
        relativeOutputPath,
    );
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return { success: false };
  }

  if (!lastResult || !lastResult.success) {
    // The staged compile ran but reported failure (type errors, etc). Same
    // guarantee: `outputPath` was never touched.
    fs.rmSync(absStagingPath, { recursive: true, force: true });
    console.error(
      `atomic-tsc: [${projectLabel}] build failed — existing output left intact at ` +
        relativeOutputPath,
    );
    return { success: false };
  }

  // COMMIT — swap staging into place. Everything above succeeded, so this is the
  // only window in which outputPath is not a valid artifact, and it is bounded by
  // two renames within one directory rather than a compile's worth of work.
  const hadPrev = fs.existsSync(absOutputPath);
  try {
    if (hadPrev) fs.renameSync(absOutputPath, absPrevPath);
    fs.renameSync(absStagingPath, absOutputPath);
  } catch (err) {
    // Roll back to the previous artifact rather than leaving a hole.
    if (hadPrev && !fs.existsSync(absOutputPath) && fs.existsSync(absPrevPath)) {
      fs.renameSync(absPrevPath, absOutputPath);
    }
    fs.rmSync(absStagingPath, { recursive: true, force: true });
    console.error(
      `atomic-tsc: [${projectLabel}] could not swap staged output into place for ` +
        relativeOutputPath,
    );
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return { success: false };
  }
  if (hadPrev) fs.rmSync(absPrevPath, { recursive: true, force: true });

  console.log(`atomic-tsc: [${projectLabel}] committed → ${relativeOutputPath}`);
  return lastResult.outfile !== undefined
    ? { success: true, outfile: lastResult.outfile }
    : { success: true };
}
