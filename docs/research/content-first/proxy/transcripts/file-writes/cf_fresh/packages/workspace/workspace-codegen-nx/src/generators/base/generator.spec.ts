/**
 * generator.spec.ts — proves the `base` generator's build-executor
 * enforcement (INVESTIGATION-BUILD-TOOL-001 generator-enforcement item).
 *
 * WHY THIS EXISTS: 10 `@nx/vite:build` `platform:node`/`platform:shared`
 * apigen packages shipped broken `verify-dist-load`-failing dist bundles
 * (`ReferenceError: __filename is not defined in ES module scope`) because
 * their `vite.config.ts` bundled real npm dependencies (ts-morph,
 * typescript) instead of externalizing them — see BACKLOG.md
 * INVESTIGATION-BUILD-TOOL-001 / BUG-BUILD-VITE-EXTERNAL-BUNDLING-001. The
 * fix (`tools/vite-external-deps.mjs`'s `externalizeRealDeps`) only prevents
 * a RECURRENCE if newly-scaffolded packages get it automatically. This test
 * drives the actual `base` generator (the same codepath every tier
 * delegates through — see `shared/generator.ts`) against a real in-memory
 * Tree and asserts the generated `vite.config.ts` on disk-equivalent content
 * actually wires the externalization call — not just that the generator
 * "ran without throwing".
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { type Tree } from '@nx/devkit';
import baseGenerator from './generator';

describe('base generator — vite external-deps enforcement', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
  });

  it('platform:node — wires externalizeRealDeps(__dirname) into rollupOptions.external', async () => {
    await baseGenerator(tree, {
      name: 'widget',
      group: 'billing',
      nxLayer: 'logic',
      platform: 'node',
    });

    const viteConfig = tree.read(
      'packages/billing/billing-base-widget/vite.config.ts',
      'utf-8'
    );
    expect(viteConfig).toContain(
      "import { externalizeRealDeps } from '../../../tools/vite-plugins/externalize.mjs';"
    );
    expect(viteConfig).toContain(
      "import { vitestPoolOptions } from '../../../tools/vite-plugins/vitest-pool-defaults.mjs';"
    );
    expect(viteConfig).toContain('external: externalizeRealDeps(__dirname)');
    expect(viteConfig).toContain('poolOptions: vitestPoolOptions');
    // The bug this closes: the generator once imported the nonexistent
    // `tools/vite-external-deps.mjs` and left `external: []` (bundling every
    // real npm dep) — BUG-WORKSPACE-GEN-006 / INVESTIGATION-BUILD-TOOL-001.
    expect(viteConfig).not.toContain('tools/vite-external-deps.mjs');
    expect(viteConfig).not.toMatch(/external:\s*\[\]/);
    // In-tree dist is part of the canonical template (BUG-WORKSPACE-GEN-006).
    expect(viteConfig).toContain('root: __dirname');
    expect(viteConfig).toContain("outDir: 'dist'");
  });

  it('platform:shared — also wires externalizeRealDeps (apigen-core-client\'s tier)', async () => {
    await baseGenerator(tree, {
      name: 'widget',
      group: 'billing',
      nxLayer: 'shared',
      platform: 'shared',
    });

    const viteConfig = tree.read(
      'packages/billing/billing-base-widget/vite.config.ts',
      'utf-8'
    );
    expect(viteConfig).toContain('external: externalizeRealDeps(__dirname)');
  });

  it('platform:browser — leaves external: [] alone (consumed by an app bundler, not Node)', async () => {
    await baseGenerator(tree, {
      name: 'widget',
      group: 'billing',
      nxLayer: 'ui-primitives',
      platform: 'browser',
    });

    const viteConfig = tree.read(
      'packages/billing/billing-base-widget/vite.config.ts',
      'utf-8'
    );
    expect(viteConfig).not.toContain('externalizeRealDeps');
    expect(viteConfig).toMatch(/external:\s*\[\]/);
  });
});
