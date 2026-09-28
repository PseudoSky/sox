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
 * ## Why `syncBuiltinESMExports()`
 *
 * Patching the CommonJS `require('node:fs')` object only changes what CJS
 * callers see. ESM callers (`import * as fs from 'node:fs'`,
 * `import { existsSync } from 'node:fs'` — every memory-core spec and source
 * module, as vitest runs them) read the builtin's ESM namespace, which is a
 * SNAPSHOT of the CJS exports taken when the builtin was first loaded. Without
 * `syncBuiltinESMExports()` from `node:module` after every patch, the guard
 * sees none of those calls and never fires. Every install AND uninstall below
 * ends with that call.
 *
 * ## Coverage
 *
 * Wrapped (synchronous only): see `GUARDED_FNS`. The first argument is
 * checked for every function; the DESTINATION argument is also checked for
 * `renameSync`, `copyFileSync`, `cpSync`, `linkSync` and `symlinkSync`
 * (`guardedPathArgs`). `mkdtempSync` is checked through its prefix argument.
 * String, `Buffer` and `file:` `URL` paths are normalised and resolved to
 * absolute paths first; numeric fds are skipped.
 *
 * NOT covered here (the whole-run `vitest.global-guard.ts` diff is the
 * backstop for these): async `fs` callbacks, `fs.promises` / `node:fs/promises`,
 * streams (`createReadStream`/`createWriteStream`), `watch`, native SQLite
 * opens (better-sqlite3 / libsql / turso open files through their own
 * syscalls, not through `node:fs`), and child processes.
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
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const fs = require('node:fs') as typeof import('node:fs');

// os.userInfo().homedir ignores the HOME/USERPROFILE redirect installed by
// vitest.home-scratch-setup.ts — this is deliberately the REAL operator
// home, not whatever os.homedir() currently resolves to in this worker.
export const REAL_HOME_MEMORY_DIR = path.join(os.userInfo().homedir, '.memory');

export const GUARDED_FNS = [
  'existsSync',
  'accessSync',
  'readFileSync',
  'readdirSync',
  'statSync',
  'lstatSync',
  'realpathSync',
  'openSync',
  'mkdirSync',
  'mkdtempSync',
  'writeFileSync',
  'appendFileSync',
  'copyFileSync',
  'cpSync',
  'renameSync',
  'linkSync',
  'symlinkSync',
  'unlinkSync',
  'rmSync',
  'rmdirSync',
] as const;
type GuardedFn = (typeof GUARDED_FNS)[number];

const TWO_PATH_FNS: ReadonlySet<GuardedFn> = new Set<GuardedFn>([
  'renameSync',
  'copyFileSync',
  'cpSync',
  'linkSync',
  'symlinkSync',
]);

/** Normalise one fs path argument to an absolute string; undefined for fds and non-paths. */
export function normalizeFsPath(p: unknown): string | undefined {
  if (typeof p === 'string') return path.resolve(p);
  if (Buffer.isBuffer(p)) return path.resolve(p.toString());
  if (p instanceof URL) return p.protocol === 'file:' ? path.resolve(fileURLToPath(p)) : undefined;
  return undefined;
}

/** The normalised path arguments `fnName` touches (source, and destination where there is one). */
export function guardedPathArgs(fnName: string, args: readonly unknown[]): string[] {
  const idx = TWO_PATH_FNS.has(fnName as GuardedFn) ? [0, 1] : [0];
  const out: string[] = [];
  for (const i of idx) {
    const p = normalizeFsPath(args[i]);
    if (p !== undefined) out.push(p);
  }
  return out;
}

export function touchesRealStore(p: string, root: string = REAL_HOME_MEMORY_DIR): boolean {
  return p === root || p.startsWith(root + path.sep);
}

type AnyFn = ((...args: unknown[]) => unknown) & { native?: (...args: unknown[]) => unknown };

interface GuardState {
  /** The never-wrapped fs functions, captured once per PROCESS. */
  readonly originals: Record<GuardedFn, AnyFn>;
  touches: string[];
}

// Setup files are re-evaluated for every spec file inside the same worker
// process, but `require('node:fs')` is one process-wide object. Capturing the
// originals at module scope would, on the second spec file, capture the
// FIRST file's wrappers and stack wrapper on wrapper. The state therefore
// lives on a process-global symbol and the originals are captured exactly
// once. The spec that proves this guard fires uses `drain()` via the same
// symbol to consume the touches it made on purpose.
const STATE_KEY = Symbol.for('sox.memory-core.bl-bae70da4.fs-guard');
type GlobalWithState = typeof globalThis & { [STATE_KEY]?: GuardState };
const g = globalThis as GlobalWithState;
const state: GuardState =
  g[STATE_KEY] ??
  (g[STATE_KEY] = {
    originals: Object.fromEntries(GUARDED_FNS.map((n) => [n, fs[n] as unknown as AnyFn])) as Record<GuardedFn, AnyFn>,
    touches: [],
  });

function record(fnName: string, args: readonly unknown[]): void {
  for (const p of guardedPathArgs(fnName, args)) {
    if (touchesRealStore(p)) {
      state.touches.push(`${fnName}(${p})\n${new Error('BL-bae70da4 live-store touch').stack}`);
    }
  }
}

function wrap(fnName: string, original: AnyFn): AnyFn {
  const wrapped: AnyFn = function bl_bae70da4Guarded(this: unknown, ...args: unknown[]) {
    record(fnName, args);
    return original.apply(this ?? fs, args);
  };
  // realpathSync.native is a separate function hung off realpathSync; vite's
  // module runner calls it. Dropping it would break resolution, and leaving it
  // unwrapped would leave a hole in the guard.
  if (typeof original.native === 'function') {
    const nativeOriginal = original.native;
    wrapped.native = function bl_bae70da4GuardedNative(this: unknown, ...args: unknown[]) {
      record(`${fnName}.native`, args);
      return nativeOriginal.apply(this ?? fs, args);
    };
  }
  return wrapped;
}

export function install(): void {
  const target = fs as unknown as Record<string, unknown>;
  for (const fnName of GUARDED_FNS) target[fnName] = wrap(fnName, state.originals[fnName]);
  syncBuiltinESMExports();
}

export function uninstall(): void {
  const target = fs as unknown as Record<string, unknown>;
  for (const fnName of GUARDED_FNS) target[fnName] = state.originals[fnName];
  syncBuiltinESMExports();
}

/** Remove and return the touches recorded so far (used by the guard's own red spec). */
export function drainTouches(): string[] {
  return state.touches.splice(0, state.touches.length);
}

install();

beforeEach(() => {
  state.touches = [];
  install();
});

afterEach(() => {
  if (state.touches.length > 0) {
    const report = drainTouches();
    throw new Error(
      `BL-bae70da4 REGRESSION: ${report.length} touch(es) to the REAL operator store under ` +
        `${REAL_HOME_MEMORY_DIR} during this test — memory-core specs must run entirely against ` +
        `the scratch HOME installed by vitest.home-scratch-setup.ts:\n\n${report.join('\n---\n')}`,
    );
  }
});

afterAll(() => {
  uninstall();
});
