/**
 * plugin/generator.spec.ts — proves the plugin generator (the tier that
 * demonstrated BUG-WORKSPACE-GEN-006) scaffolds convention-correct packages.
 *
 * WHAT THIS CLOSES (FEATURE.md): `nx g @adhd/workspace-codegen-nx:plugin`
 * scaffolded packages whose build/verify/test config was broken until manual
 * repair:
 *   1. vite.config.ts imported `externalizeRealDeps` from the NONEXISTENT
 *      `tools/vite-external-deps.mjs` (real helper:
 *      `tools/vite-plugins/externalize.mjs`) — the config failed to load.
 *   2. Build emitted to the PRE-migration workspace-root dist
 *      (`dist/packages/...`); the injected `assets`/`verify-dist-load`
 *      targets read `{projectRoot}/dist` and failed against the stale layout.
 *   3. project.json had no `test` target invoking the vite config's test block.
 *
 * TEETH (repo AGENTS.md §7.2): every negative assertion (`not.toContain`
 * `'vite-external-deps'`, `not.toContain("'../../../dist/")`,
 * `not.toMatch(/dist\/packages/)`) targets a string the PRE-FIX generator
 * emitted — revert the generator patches and this suite goes red.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { type Tree } from '@nx/devkit';
import pluginGenerator from './generator';

const PKG = 'apigen-plugin-ir-cache';
const PKG_DIR = `packages/apigen/${PKG}`;
const VITE_PATH = `${PKG_DIR}/vite.config.ts`;
const PROJECT_JSON_PATH = `${PKG_DIR}/project.json`;

async function scaffoldPlugin(tree: Tree, platform: 'node' | 'browser' | 'shared' = 'node') {
  await pluginGenerator(tree, {
    name: 'ir-cache',
    group: 'apigen',
    nxLayer: 'logic',
    platform,
  });
}

describe('plugin generator — BUG-WORKSPACE-GEN-006 output contract', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
  });

  it('node — imports externalizeRealDeps from the REAL helper path (never the stale one)', async () => {
    await scaffoldPlugin(tree);
    const viteConfig = tree.read(VITE_PATH, 'utf-8');
    expect(viteConfig).toContain(
      "import { externalizeRealDeps } from '../../../tools/vite-plugins/externalize.mjs';"
    );
    expect(viteConfig).not.toContain('vite-external-deps');
    expect(viteConfig).toContain('external: externalizeRealDeps(__dirname)');
  });

  it('node — wires the shared vitest pool cap', async () => {
    await scaffoldPlugin(tree);
    const viteConfig = tree.read(VITE_PATH, 'utf-8');
    expect(viteConfig).toContain(
      "import { vitestPoolOptions } from '../../../tools/vite-plugins/vitest-pool-defaults.mjs';"
    );
    expect(viteConfig).toContain('poolOptions: vitestPoolOptions');
  });

  it('node — builds to IN-TREE dist (outDir dist, no pre-migration ../../../dist)', async () => {
    await scaffoldPlugin(tree);
    const viteConfig = tree.read(VITE_PATH, 'utf-8');
    expect(viteConfig).toContain("outDir: 'dist',");
    expect(viteConfig).not.toContain("'../../../dist/");
    expect(viteConfig).toContain('emptyOutDir: true');
  });

  it('node — runs tests in the node environment', async () => {
    await scaffoldPlugin(tree);
    const viteConfig = tree.read(VITE_PATH, 'utf-8');
    expect(viteConfig).toContain("environment: 'node',");
  });

  it('node — project.json points build at {projectRoot}/dist (never dist/packages/...)', async () => {
    await scaffoldPlugin(tree);
    const projectJson = JSON.parse(tree.read(PROJECT_JSON_PATH, 'utf-8'));
    expect(projectJson.targets.build.options.outputPath).toBe(`${PKG_DIR}/dist`);
    expect(projectJson.targets.build.options.emptyOutDir).toBe(true);
    expect(JSON.stringify(projectJson)).not.toMatch(/dist\/packages\//);
  });

  it('node — project.json has an explicit @nx/vite:test target wired to the vite config', async () => {
    await scaffoldPlugin(tree);
    const projectJson = JSON.parse(tree.read(PROJECT_JSON_PATH, 'utf-8'));
    expect(projectJson.targets.test.executor).toBe('@nx/vite:test');
    expect(projectJson.targets.test.options.configFile).toBe(`${PKG_DIR}/vite.config.ts`);
  });

  it('node — package.json consumer entries point at the IN-TREE dist', async () => {
    await scaffoldPlugin(tree);
    const pkg = JSON.parse(tree.read(`${PKG_DIR}/package.json`, 'utf-8'));
    expect(pkg.main).toBe('./dist/index.js');
    expect(pkg.module).toBe('./dist/index.mjs');
    expect(pkg.types).toBe('./dist/index.d.ts');
    expect(pkg.typings).toBeUndefined();
  });

  it('node — release packageRoots point at the IN-TREE dist', async () => {
    await scaffoldPlugin(tree);
    const projectJson = JSON.parse(tree.read(PROJECT_JSON_PATH, 'utf-8'));
    expect(projectJson.targets['nx-release-publish'].options.packageRoot).toBe(`${PKG_DIR}/dist`);
    expect(projectJson.release.version.generatorOptions.packageRoot).toBe(`${PKG_DIR}/dist`);
    expect(projectJson.targets['nx-release-publish'].dependsOn).toEqual([
      'build',
      'assets',
      'test',
      'dist-manifest',
      'verify-dist-load',
      'publish-hygiene',
    ]);
  });

  it('shared — also wires externalize + pool options (apigen-core-client tier)', async () => {
    await scaffoldPlugin(tree, 'shared');
    const viteConfig = tree.read(VITE_PATH, 'utf-8');
    expect(viteConfig).toContain('external: externalizeRealDeps(__dirname)');
    expect(viteConfig).toContain('poolOptions: vitestPoolOptions');
  });

  it('browser — leaves external: [] and no externalize/pool injection (app bundler consumer)', async () => {
    await scaffoldPlugin(tree, 'browser');
    const viteConfig = tree.read(VITE_PATH, 'utf-8');
    expect(viteConfig).not.toContain('externalizeRealDeps');
    expect(viteConfig).not.toContain('vitestPoolOptions');
    expect(viteConfig).toMatch(/external:\s*\[\]/);
  });
});
