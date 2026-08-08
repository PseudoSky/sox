/**
 * bl202-test-target-depends-on-own-build.spec.ts — BL-202.
 *
 * `libs/memory-core/project.json`'s `test` target had no `dependsOn`, so it
 * inherited `nx.json`'s workspace default `["^build"]` — build the project's
 * DEPENDENCIES, never the project's OWN build. `npx nx test memory-core`
 * therefore never rebuilt `libs/memory-core/dist` before running specs.
 *
 * `telemetry-crash-durability.spec.ts` (BL-365) `execFileSync`s a child
 * process that `require()`s `libs/memory-core/dist/telemetry.js` directly —
 * the one spec file in this project whose test bodies depend on the
 * project's own compiled output existing and being current. With `dist`
 * absent or stale, those 5 tests fail with `Command failed` / `expected +0
 * to be N` — not because the code under test is wrong, but because of
 * incidental nx-cache/build state at invocation time. Same config, same
 * source tree, different result: exactly the "suite-count variance is
 * inadmissible evidence" defect class this packet exists to close.
 *
 * Same root cause, same shape, as the `sox:test` defect fixed in commit
 * 9ac235d3 (`apps/sox/project.json` gained `dependsOn: ["build", "^build"]`
 * for the identical reason: `bl218-registry-resolved.spec.ts` execs
 * `dist/apps/sox/main.js`).
 *
 * This test reads `project.json` directly with `node:fs` + `JSON.parse`
 * rather than shelling out to `npx nx show project memory-core --json`,
 * because (1) `nx show` spawns a subprocess and depends on the nx daemon's
 * own health — ironic for a test whose entire point is "don't let
 * build-graph plumbing leak into test results"; (2) `nx show --json`
 * resolves `targetDefaults` merges, which is MORE than this test needs to
 * assert — it should pin the literal config written to this file, not
 * re-derive nx's merge semantics; (3) a subprocess spawn is a genuine flake
 * surface to add to a test whose entire purpose is proving something is NOT
 * flaky.
 *
 * RED arm (pre-fix `project.json`, no `test.dependsOn`): this test fails,
 * since `dependsOn` is absent from the `test` target entirely.
 * GREEN arm (post-fix `project.json`): this test passes.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('BL-202: memory-core test target depends on its own build', () => {
  it('project.json test target dependsOn includes both "build" and "^build"', () => {
    const projectJsonPath = join(__dirname, '..', 'project.json');
    const raw = readFileSync(projectJsonPath, 'utf8');
    const json = JSON.parse(raw) as {
      targets?: { test?: { dependsOn?: unknown } };
    };

    const dependsOn = json.targets?.test?.dependsOn;

    expect(Array.isArray(dependsOn)).toBe(true);
    expect(dependsOn).toContain('build');
    expect(dependsOn).toContain('^build');
  });
});
