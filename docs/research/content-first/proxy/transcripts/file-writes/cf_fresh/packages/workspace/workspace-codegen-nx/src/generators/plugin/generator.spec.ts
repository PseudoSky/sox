/**
 * plugin/generator.spec.ts — proves the `plugin` generator (BUG-WORKSPACE-GEN-006)
 * emits migration-correct configs, mirroring the repo's in-tree-dist convention
 * (reference: packages/apigen/apigen-plugin-batch).
 *
 * WHY THIS EXISTS: every newly scaffolded plugin used to ship THREE stale
 * artifacts requiring manual repair (FEATURE.md BUG-WORKSPACE-GEN-006):
 *   1. vite.config.ts imported `externalizeRealDeps` from the nonexistent
 *      `tools/vite-external-deps.mjs` (real path: tools/vite-plugins/externalize.mjs);
 *   2. build emitted to the pre-migration workspace-root dist
 *      (`dist/packages/...` project.json outputPath + `../../../dist/...`
 *      vite outDir), so the injected `assets`/`verify-dist-load` targets
 *      failed (`assets: no dist ... (build first)`);
 *   3. project.json had no `test` target even though vite.config carried a
 *      test block.
 * This spec drives the real `plugin` generator against an in-memory Tree and
 * asserts the emitted `project.json` + `vite.config.ts` carry the canonical
 * shape — and that no stale artifact string survives anywhere in the output.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { type Tree } from '@nx/devkit';
import pluginGenerator from './generator';

describe('plugin generator — BUG-WORKSPACE-GEN-006 (no stale scaffold artifacts)', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
  });

  it('emits canonical in-tree-dist project.json with a test target and publish gate', async () => {
    // Exact FEATURE.md reproduction: --name ir-cache --group apigen
    // --nxLayer logic --platform node
    await pluginGenerator(tree, {
      name: 'ir-cache',
      group: 'apigen',
      nxLayer: 'logic',
      platform: 'node',
    });

    const rawProject = tree.read(
      'packages/apigen/apigen-plugin-ir-cache/project.json',
      'utf-8'
    );
    expect(rawProject).toBeTruthy();
    const projectJson = JSON.parse(rawProject as string);

    // (b) in-tree dist: outputPath under the package's own root, never
    // workspace-root dist/packages/...
    expect(projectJson.targets.build.options.outputPath).toBe(
      'packages/apigen/apigen-plugin-ir-cache/dist'
    );
    expect(JSON.stringify(projectJson)).not.toContain('dist/packages/');

    // (c) a real `test` target wired to the emitted vite.config.ts
    expect(projectJson.targets.test.executor).toBe('@nx/vite:test');
    expect(projectJson.targets.test.options.configFile).toBe(
      'packages/apigen/apigen-plugin-ir-cache/vite.config.ts'
    );

    // publish gate depends on the injected verify targets
    expect(projectJson.targets['nx-release-publish'].dependsOn).toEqual([
      'build',
      'test',
      'verify-dist-load',
      'dist-manifest',
      'publish-hygiene',
    ]);
    expect(projectJson.targets['nx-release-publish'].options.packageRoot).toBe(
      '{projectRoot}/dist'
    );

    // 4th stale artifact (discovered in a real scaffold): libraryGenerator
    // emits release.version.generatorOptions.packageRoot as the pre-migration
    // "dist/{projectRoot}" — the generator must rewrite it to the source-root
    // convention ({projectRoot}, mirroring workspace-codegen-nx/project.json).
    expect(projectJson.release.version.generatorOptions.packageRoot).toBe(
      '{projectRoot}'
    );
    expect(
      JSON.stringify(projectJson)
    ).not.toContain('"packageRoot": "dist/');
  });

  it('emits canonical vite.config.ts with real tools/vite-plugins imports and in-tree outDir', async () => {
    await pluginGenerator(tree, {
      name: 'ir-cache',
      group: 'apigen',
      nxLayer: 'logic',
      platform: 'node',
    });

    const viteConfig = tree.read(
      'packages/apigen/apigen-plugin-ir-cache/vite.config.ts',
      'utf-8'
    );
    expect(viteConfig).toBeTruthy();

    // (a) real import paths — the nonexistent tools/vite-external-deps.mjs
    // must not appear anywhere in the emitted config
    expect(viteConfig).toContain(
      "import { externalizeRealDeps } from '../../../tools/vite-plugins/externalize.mjs';"
    );
    expect(viteConfig).toContain(
      "import { vitestPoolOptions } from '../../../tools/vite-plugins/vitest-pool-defaults.mjs';"
    );
    expect(viteConfig).not.toContain('tools/vite-external-deps.mjs');

    // (b) in-tree dist layout in vite terms
    expect(viteConfig).toContain('root: __dirname');
    expect(viteConfig).toContain("outDir: 'dist'");
    expect(viteConfig).not.toContain('../../../dist/');

    // externalization actually wired, test pool actually applied
    expect(viteConfig).toContain('external: externalizeRealDeps(__dirname)');
    expect(viteConfig).toContain('poolOptions: vitestPoolOptions');
    expect(viteConfig).toContain("environment: 'node'");
  });

  it('emits a syntactically well-formed vite.config.ts (no template-assembly artifacts)', async () => {
    await pluginGenerator(tree, {
      name: 'ir-cache',
      group: 'apigen',
      nxLayer: 'logic',
      platform: 'node',
    });

    const viteConfig = tree.read(
      'packages/apigen/apigen-plugin-ir-cache/vite.config.ts',
      'utf-8'
    );
    expect(viteConfig).toBeTruthy();
    const vite = viteConfig as string;

    // Regression teeth without a TS-parser dependency: the canonical template
    // once emitted `},,` (rollupOptions block + stray comma), which every
    // substring assertion above stayed green against while the artifact was
    // invalid. Assert the assembly artifacts that signal a malformed emit:
    // no doubled punctuation, balanced braces, proper file close.
    expect(vite).not.toMatch(/,,/);
    expect(vite).not.toMatch(/;;/);
    expect(vite).not.toMatch(/\[\],\]/);
    expect(vite.split('{').length - 1).toBe(vite.split('}').length - 1);
    expect(vite.trimEnd().endsWith('});')).toBe(true);
  });

  it('emits at least one runnable spec so a fresh scaffold passes nx test (AC-3)', async () => {
    await pluginGenerator(tree, {
      name: 'ir-cache',
      group: 'apigen',
      nxLayer: 'logic',
      platform: 'node',
    });

    // Consumer outcome, not implementation shape: vitest's include glob
    // (src/**/*.{test,spec}...) must match at least one spec file. The
    // placeholder only fires when libraryGenerator emitted none.
    const libDir = 'packages/apigen/apigen-plugin-ir-cache/src/lib';
    expect(tree.exists(libDir)).toBe(true);
    const specs = tree
      .children(libDir)
      .filter((f) => /\.(spec|test)\.(ts|tsx|js|jsx|mts|cts)$/.test(f));
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      const content = tree.read(`${libDir}/${spec}`, 'utf-8');
      expect(content).toBeTruthy();
      expect(content).toMatch(/describe\(|it\(|test\(/);
    }
  });
});
