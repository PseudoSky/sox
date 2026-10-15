/**
 * bl-0c9c76b4-exports.spec.ts
 *
 * Failure mode: `DEFAULT_CLUSTER_NODE_CAP` / `ClusterDegradation` exist in
 * cluster.ts but are dropped from (or never added to) the package root, so
 * `@adhd/sox-memory-server` cannot import them and re-declares its own copy of
 * the cap or the degradation shape.
 * Tier: S (imports the real package root `./index.js`; no store, no mocks).
 * Gap (P/H/X): none — the root's runtime export surface and its type surface
 * are both directly observable in-process.
 * Item: 0c9c76b4 AC10. Risk map: AC10 root export of the cap constant -> removed
 * from the `export {}` list; AC10 root export of the type -> removed from the
 * `export type {}` list (the compile-checked usage below then fails typecheck,
 * and the runtime-shape test fails on the discriminant it exercises).
 * Red run (recorded 2026-10-15, worktree recluster-fix-c1):
 *   Fault seeded: delete `DEFAULT_CLUSTER_NODE_CAP` from the cluster export list in index.ts.
 *   Command: npx nx test memory-core -- libs/memory-core/src/bl-0c9c76b4-exports.spec.ts
 *   Exit 1 (2 failed): `DEFAULT_CLUSTER_NODE_CAP is exported ...`
 *     AssertionError: expected undefined to be 16000; and `ClusterDegradation ...`
 *     AssertionError: expected 'cap undefined' to be 'cap 16000'.
 *   Type half: delete `ClusterDegradation` from the `export type {}` list, run
 *   `npx nx typecheck memory-core` -> exit 1,
 *   `bl-0c9c76b4-exports.spec.ts:24:41 error TS2305: Module './index.js' has no exported member 'ClusterDegradation'`.
 *   Restored byte-identical (shasum -c) and re-run green: 2 passed, exit 0.
 */
import { describe, it, expect } from 'vitest';
import * as root from './index.js';
import { DEFAULT_CLUSTER_NODE_CAP, type ClusterDegradation } from './index.js';
import { DEFAULT_CLUSTER_NODE_CAP as source } from './cluster.js';

describe('0c9c76b4 AC10 package root exports', () => {
  it('0c9c76b4 AC10: DEFAULT_CLUSTER_NODE_CAP is exported from the package root and is the cluster.ts value', () => {
    expect(root.DEFAULT_CLUSTER_NODE_CAP).toBe(source);
    expect(DEFAULT_CLUSTER_NODE_CAP).toBe(16_000);
  });

  it('0c9c76b4 AC10: ClusterDegradation is exported as a type covering both reasons (compile-checked)', () => {
    // These literals only typecheck if the root-exported union has exactly these
    // two discriminants with these fields; `nx typecheck` is the gate for the
    // type half of AC10, this test pins the runtime shape consumers branch on.
    const refused: ClusterDegradation = { reason: 'nodeCap', episodeCount: 20_000, nodeCap: DEFAULT_CLUSTER_NODE_CAP };
    const aborted: ClusterDegradation = { reason: 'budget', episodeCount: 9_000, budgetMs: 540_000, elapsedMs: 541_000 };
    const label = (d: ClusterDegradation): string =>
      d.reason === 'nodeCap' ? `cap ${d.nodeCap}` : `budget ${d.budgetMs}`;
    expect(label(refused)).toBe('cap 16000');
    expect(label(aborted)).toBe('budget 540000');
  });
});
