/**
 * generator.spec.ts — proves the `plugin` generator ships the three
 * BUG-WORKSPACE-GEN-006 artifact fixes, with teeth.
 *
 * WHY THIS EXISTS: scaffolding a new plugin package (`npx nx g
 * @adhd/workspace-codegen-nx:plugin --name ac-probe --group apigen --nxLayer
 * logic --platform node`) used to emit three stale artifacts, each requiring
 * hand repair to match the repo's conventions (reference:
 * packages/apigen/apigen-plugin-batch):
 *
 * 1. `vite.config.ts` imported `externalizeRealDeps` from the non-existent
 *    `tools/vite-external-deps.mjs` (real path:
 *    `tools/vite-plugins/externalize.mjs`).
 * 2. Build emitted to the pre-migration workspace-root dist (`project.json`
 *    `outputPath: dist/packages/...`, vite `outDir: ../../../dist/...`),
 *    breaking the inferred `assets`/`verify-dist-load` targets that read
 *    in-tree `{projectRoot}/dist`.
 * 3. `project.json` had no `test` target — the `@nx/vite` vitest generator
 *    only adds one when `@nx/vite/plugin` is NOT registered
 *    (node_modules/@nx/vite/src/generators/vitest/vitest-generator.js:47-52),
 *    and this repo registers it (nx.json:60-67).
 *
 * THE TEETH: `beforeEach` registers `@nx/vite/plugin` in the in-memory tree's
 * `nx.json` to reproduce the real worktree condition. In a bare
 * `createTreeWithEmptyWorkspace()` the vitest generator WOULD add a `test`
 * target, so a naive test-target assertion would pass pre-fix (no teeth).
 * With the plugin registered, reverting any of the three fixes — the stale
 * import path, the workspace-root `outputPath`/`outDir`, or the missing
 * `test`-target patch — turns the corresponding assertion red: the test
 * fails when the bug is reintroduced. Runs by default (matches the project's
 * vitest include) and is deterministic (in-memory Tree, no filesystem).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { type Tree, readJson, writeJson } from '@nx/devkit';
import pluginGenerator from './generator';

describe('plugin generator — BUG-WORKSPACE-GEN-006 artifact fixes', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    // Mirror nx.json:60-67. With `@nx/vite/plugin` registered, the @nx/vite
    // vitest generator skips adding a `test` target, so a `test` target in
    // the generated project.json can only come from the generator's own
    // patchProjectJsonTargets — this is what gives assertion 5 its teeth.
    writeJson(tree, 'nx.json', {
      plugins: [
        {
          plugin: '@nx/vite/plugin',
          options: {
            buildTargetName: 'build',
            testTargetName: 'test',
            serveTargetName: 'serve',
            previewTargetName: 'preview',
            serveStaticTargetName: 'serve-static',
          },
        },
      ],
    });
  });

  async function scaffoldProbe() {
    await pluginGenerator(tree, {
      name: 'ac-probe',
      group: 'apigen',
      nxLayer: 'logic',
      platform: 'node',
    });
  }

  const root = 'packages/apigen/apigen-plugin-ac-probe';

  it('AC-2/AC-13.1 — imports externalizeRealDeps from the real tools path', async () => {
    await scaffoldProbe();

    const viteConfig = tree.read(`${root}/vite.config.ts`, 'utf-8');
    expect(viteConfig).toContain('../../../tools/vite-plugins/externalize.mjs');
    expect(viteConfig).not.toContain('tools/vite-external-deps.mjs');
    expect(viteConfig).toContain('external: externalizeRealDeps(__dirname)');
  });

  it('AC-3 — wires vitest-pool defaults, node environment, and the spec include', async () => {
    await scaffoldProbe();

    const viteConfig = tree.read(`${root}/vite.config.ts`, 'utf-8');
    expect(viteConfig).toContain('../../../tools/vite-plugins/vitest-pool-defaults.mjs');
    expect(viteConfig).toContain('poolOptions: vitestPoolOptions');
    expect(viteConfig).toContain("environment: 'node'");
    expect(viteConfig).toContain(
      'src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'
    );
  });

  it('AC-4/AC-13.2 — build output is in-tree (vite outDir: dist, no ../../../dist escape)', async () => {
    await scaffoldProbe();

    const viteConfig = tree.read(`${root}/vite.config.ts`, 'utf-8');
    expect(viteConfig).toContain("outDir: 'dist'");
    expect(viteConfig).not.toMatch(/\.\.\/dist/);
  });

  it('AC-5/AC-13.2 — project.json build outputPath is project-root-relative', async () => {
    await scaffoldProbe();

    const projectJson = readJson(tree, `${root}/project.json`);
    expect(projectJson.targets.build.executor).toBe('@nx/vite:build');
    expect(projectJson.targets.build.options.outputPath).toBe(`${root}/dist`);
    expect(JSON.stringify(projectJson)).not.toContain('dist/packages/');
  });

  it('AC-9/AC-13.3 — project.json has a test target wired to the generated vite config', async () => {
    await scaffoldProbe();

    const projectJson = readJson(tree, `${root}/project.json`);
    expect(projectJson.targets.test.executor).toBe('@nx/vite:test');
    expect(projectJson.targets.test.options.configFile).toBe(`${root}/vite.config.ts`);
  });
});
