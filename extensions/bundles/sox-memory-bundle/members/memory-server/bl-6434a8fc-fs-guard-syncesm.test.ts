/**
 * bl-6434a8fc-fs-guard-syncesm.test.ts — BL-6434a8fc: the BL-412 whole-suite
 * fs guard (./vitest.setup.ts) must actually observe calls made through an
 * ESM `import * as fs from 'node:fs'` binding, not just through the
 * CommonJS `require('node:fs')` object `install()` patches directly.
 *
 * See vitest.setup.ts's "Why syncBuiltinESMExports()" section (above
 * `install()`) for the full mechanism: Node's ESM/CJS interop for builtins
 * snapshots the CJS `module.exports` into a separate ESM namespace object
 * the first time the builtin is imported as ESM. Mutating the CJS object
 * afterwards does not retroactively update that snapshot — only
 * `syncBuiltinESMExports()` does. `install()` now calls it after every
 * patch.
 *
 * This spec makes a single, controlled `existsSync` call — through an ESM
 * `import * as fs` binding, the exact shape every production import in this
 * codebase uses — against a disposable scratch directory registered as an
 * extra guarded root (`addGuardedRootForTest`), so this proof never touches
 * the operator's real `~/.memory`. It asserts the guard recorded the call,
 * then drains the touch and removes the extra root so neither the suite's
 * own `afterEach` (which fails a test on any unresolved touch) nor later
 * tests are affected.
 *
 * This file lives at the package root, alongside vitest.setup.ts, rather
 * than under src/ — a src/ spec importing vitest.setup.ts would pull that
 * file into the production `tsconfig.json`'s `rootDir: "src"` compile
 * (typecheck-src), which excludes it, breaking that build.
 *
 * RED (fix disabled — `install()` without the `syncBuiltinESMExports()`
 * call): the `existsSync` call below resolves through the ORIGINAL,
 * unwrapped function (the ESM namespace never saw the CJS patch), so
 * nothing is recorded and `drainLiveStoreTouches()` returns `[]` —
 * `expect(touches.length).toBeGreaterThan(0)` fails.
 *
 * GREEN (fix applied): the ESM call resolves through the wrapped function,
 * `touchesRealStore()` matches the registered scratch root, and the touch
 * is recorded exactly like a CJS caller's would be.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addGuardedRootForTest, drainLiveStoreTouches, install, removeGuardedRootForTest } from './vitest.setup';

describe('BL-6434a8fc: BL-412 fs guard fires for ESM `import * as fs` callers', () => {
  let scratchDir: string | undefined;

  afterEach(() => {
    if (scratchDir !== undefined) {
      removeGuardedRootForTest(scratchDir);
      fs.rmSync(scratchDir, { recursive: true, force: true });
      scratchDir = undefined;
    }
  });

  it('records existsSync(<guarded scratch root>) made through an ESM `import * as fs` binding', () => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl-6434a8fc-'));
    addGuardedRootForTest(scratchDir);

    // Defensive re-install + drain: this spec must observe ONLY its own call.
    install();
    drainLiveStoreTouches();

    fs.existsSync(scratchDir);

    const touches = drainLiveStoreTouches();
    expect(touches.length).toBeGreaterThan(0);
    expect(touches.some((t) => t.startsWith(`existsSync(${scratchDir})`))).toBe(true);
  });
});
