/**
 * vitest.home-guard-setup.ts — BL-bae70da4 structural defence.
 *
 * `vitest.home-scratch-setup.ts` redirects `os.homedir()` for this worker so
 * no memory-core spec resolves a `~/.memory`-shaped path into the operator's
 * real store. This file is the belt: it fails the CURRENT test immediately,
 * with a stack trace pointing at the offending spec, if anything in this
 * worker still touches the real `~/.memory/**` — whether that's a future
 * spec hardcoding the real path, a helper capturing `os.homedir()` before
 * the redirect ran, or the redirect itself regressing.
 *
 * Mirrors memory-server's BL-412 guard
 * (extensions/bundles/sox-memory-bundle/members/memory-server/vitest.setup.ts)
 * — read there for the full rationale on why `fs` is obtained via
 * `createRequire` instead of `vi.spyOn`/reassigning the ESM namespace object
 * (both throw `TypeError: Cannot redefine property` here). That reasoning is
 * unchanged; this file is a straight port scoped to memory-core's guarded
 * root.
 *
 * IMPORTANT: this guard alone would NOT have caught the BL-bae70da4
 * incident by itself if it ran only as a before/after directory-listing
 * diff — the offending directory was created AND removed by the same
 * spec's own `afterEach` within one run. Intercepting the `fs` calls
 * synchronously, as they happen, is what makes this catch it regardless of
 * whether the caller cleans up after itself. `vitest.global-guard.ts`
 * layers a second, coarser check (across the whole run, from the
 * unaffected globalSetup process) as a backstop for anything that opens the
 * real store through a path this interception cannot see (e.g. a native
 * addon's own direct syscalls that never go through Node's `fs` module).
 */
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const fs = require('node:fs') as typeof import('node:fs');

// os.userInfo().homedir ignores the HOME/USERPROFILE redirect installed by
// vitest.home-scratch-setup.ts — this is deliberately the REAL operator
// home, not whatever os.homedir() currently resolves to in this worker.
const REAL_HOME_MEMORY_DIR = path.join(os.userInfo().homedir, '.memory');

let liveStoreTouches: string[] = [];

function touchesRealStore(p: unknown): p is string {
  return typeof p === 'string' && (p === REAL_HOME_MEMORY_DIR || p.startsWith(REAL_HOME_MEMORY_DIR + path.sep));
}

const GUARDED_FNS = [
  'existsSync',
  'readFileSync',
  'statSync',
  'openSync',
  'mkdirSync',
  'writeFileSync',
  'lstatSync',
  'rmSync',
  'rmdirSync',
  'renameSync',
] as const;
type GuardedFn = (typeof GUARDED_FNS)[number];

// Captured once, at module-load time, before this file or any spec has a
// chance to wrap anything — every (re-)installation always delegates to
// these exact references, so re-arming in beforeEach is idempotent no
// matter how many times some other cleanup routine reassigns one of these
// `fs` properties back to a bare original.
const trueOriginals = {} as Record<GuardedFn, (...args: unknown[]) => unknown>;
for (const fnName of GUARDED_FNS) {
  trueOriginals[fnName] = fs[fnName] as unknown as (...args: unknown[]) => unknown;
}

function install(): void {
  for (const fnName of GUARDED_FNS) {
    const original = trueOriginals[fnName];
    (fs as unknown as Record<string, unknown>)[fnName] = function bl_bae70da4Guarded(...args: unknown[]) {
      if (touchesRealStore(args[0])) {
        liveStoreTouches.push(`${fnName}(${String(args[0])})\n${new Error('BL-bae70da4 live-store touch').stack}`);
      }
      return original.apply(fs, args);
    };
  }
}

install();

beforeEach(() => {
  liveStoreTouches = [];
  install();
});

afterEach(() => {
  if (liveStoreTouches.length > 0) {
    const report = liveStoreTouches.splice(0, liveStoreTouches.length);
    throw new Error(
      `BL-bae70da4 REGRESSION: ${report.length} touch(es) to the REAL operator store under ` +
        `${REAL_HOME_MEMORY_DIR} during this test — memory-core specs must run entirely against ` +
        `the scratch HOME installed by vitest.home-scratch-setup.ts:\n\n${report.join('\n---\n')}`,
    );
  }
});
