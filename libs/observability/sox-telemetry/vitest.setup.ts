/**
 * vitest.setup.ts — hermetic-telemetry sandbox for `sox-telemetry`'s own specs.
 *
 * Defect it closes: `03be90c3` — "test runs write telemetry to the production
 * log dir". `runtime.ts`'s `ecosystemHome()` resolves to
 * `~/.adhd/sox-ecosystem` whenever `SOX_ECOSYSTEM_HOME` is unset, and
 * `initTelemetry()` defaults `logSink` to `'file'`, so a spec that initialises
 * telemetry without an explicit `logDir` writes real records (and, since
 * 979c54… S1, a real startup snapshot) straight into the user's production
 * telemetry directory.
 *
 * Mirroring the repo-root sandbox (`scripts/test-env-setup.ts:26-49`), this
 * file redirects BOTH `SOX_ECOSYSTEM_HOME` and `SOX_TEST_ECOSYSTEM_HOME` at a
 * per-test-file `mkdtemp` scratch root in `beforeAll` — before any test body
 * runs. Both variables are read at CALL time (`ecosystemHome()`; the host
 * runtime's `data-paths.ts`), so setting them here is sufficient to redirect
 * every in-process write for the file.
 *
 * Teardown restores the saved values, removes the scratch root, and fails the
 * file if the scratch root ever equalled the real root, or if this run brought
 * the real `~/.adhd/sox-ecosystem` root into existence. The absence of a real
 * `s1/` under that root is additionally asserted per test in
 * `metrics-snapshot-cadence.spec.ts`'s `afterEach` (acceptance (b)).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll } from 'vitest';

/** The real, production data root — never a place for a test write. */
const REAL_ROOT = path.join(os.homedir(), '.adhd', 'sox-ecosystem');

let scratchHome: string | undefined;
let savedEcosystemHome: string | undefined;
let savedTestEcosystemHome: string | undefined;
let realRootExistedBefore = false;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(() => {
  // A per-file isolated data root that looks like ~/.adhd/sox-ecosystem/ but
  // lives in a temp dir that can never be the real user data root.
  scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-telemetry-test-home-'));

  // Guard BEFORE redirecting anything: the scratch root must never resolve to
  // the real root. If it somehow did, every "isolated" write below would be a
  // production write.
  if (path.resolve(scratchHome) === path.resolve(REAL_ROOT)) {
    throw new Error(
      `[sox-telemetry vitest.setup] BUG: scratch home resolved to the real telemetry root (${REAL_ROOT}). Aborting.`,
    );
  }

  // A real checkout has the production root already; on a clean machine it does
  // not. Remember which, so teardown can tell "was always there" from "this run
  // created it".
  realRootExistedBefore = fs.existsSync(REAL_ROOT);

  savedEcosystemHome = process.env['SOX_ECOSYSTEM_HOME'];
  savedTestEcosystemHome = process.env['SOX_TEST_ECOSYSTEM_HOME'];
  process.env['SOX_ECOSYSTEM_HOME'] = scratchHome;
  process.env['SOX_TEST_ECOSYSTEM_HOME'] = scratchHome;
});

afterAll(() => {
  const failures: Error[] = [];

  // Guard again — a mutation during the run must not leave the scratch root
  // pointing at production.
  if (scratchHome !== undefined && path.resolve(scratchHome) === path.resolve(REAL_ROOT)) {
    failures.push(
      new Error(`[sox-telemetry vitest.setup] scratch home is the real telemetry root (${REAL_ROOT}).`),
    );
  }

  restoreEnv('SOX_ECOSYSTEM_HOME', savedEcosystemHome);
  restoreEnv('SOX_TEST_ECOSYSTEM_HOME', savedTestEcosystemHome);

  if (scratchHome !== undefined) {
    try {
      fs.rmSync(scratchHome, { recursive: true, force: true });
    } catch (err) {
      // Best-effort cleanup — never fail teardown on it, but never let an
      // untraced catch slip past either (repo constraint: no empty catch).
      process.stderr.write(
        `[sox-telemetry vitest.setup] WARNING: scratch cleanup failed (${
          err instanceof Error ? err.message : String(err)
        })\n`,
      );
    }
  }

  // The real root must never have been CREATED by this run. If it existed
  // before (a real production checkout), it may still exist — we only fail when
  // this run is what brought it into being.
  if (!realRootExistedBefore && fs.existsSync(REAL_ROOT)) {
    failures.push(
      new Error(
        `[sox-telemetry vitest.setup] BUG: this run created the real telemetry root ${REAL_ROOT} — test telemetry leaked to production (03be90c3).`,
      ),
    );
  }

  if (failures.length > 0) throw failures[0];
});
