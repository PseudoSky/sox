/**
 * entrypoint/generator.spec.ts — proves the `entrypoint` generator no longer
 * emits the pre-migration workspace-root dist layout (BUG-WORKSPACE-GEN-006
 * adjacent finding WSGEN-ADJ-001, AC-6).
 *
 * The old scaffold wrote tsconfig.json with `outDir: '../../dist/entrypoint'`
 * (workspace-root layout, retired by the pnpm/in-source-dist migration) and a
 * project.json build target with no declared outputs. The fixed scaffold emits
 * in-tree dist (`entrypoint/<name>/dist`) and declares `outputs` so nx tracks
 * and cleans the output.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { type Tree } from '@nx/devkit';
import entrypointGenerator from './generator';

describe('entrypoint generator — in-tree dist (BUG-WORKSPACE-GEN-006 AC-6)', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
  });

  it('emits tsconfig with in-tree outDir, never workspace-root dist/entrypoint', async () => {
    await entrypointGenerator(tree, {
      name: 'foo-cli',
      nxLayer: 'entrypoints',
      platform: 'node',
    });

    const rawTsconfig = tree.read('entrypoint/foo-cli/tsconfig.json', 'utf-8');
    expect(rawTsconfig).toBeTruthy();
    const tsconfig = JSON.parse(rawTsconfig as string);
    // `dist` resolves relative to the tsconfig's own directory, i.e.
    // entrypoint/foo-cli/dist — in-tree, matching entrypoint/apigen-cli etc.
    expect(tsconfig.compilerOptions.outDir).toBe('dist');
    expect(tsconfig.compilerOptions.outDir).not.toContain('../../dist/entrypoint');
  });

  it('declares build outputs so nx tracks the in-tree dist', async () => {
    await entrypointGenerator(tree, {
      name: 'foo-cli',
      nxLayer: 'entrypoints',
      platform: 'node',
    });

    const rawProject = tree.read('entrypoint/foo-cli/project.json', 'utf-8');
    expect(rawProject).toBeTruthy();
    const projectJson = JSON.parse(rawProject as string);
    expect(projectJson.targets.build.outputs).toContain('{projectRoot}/dist');
    expect(JSON.stringify(projectJson)).not.toContain('dist/entrypoint');
  });
});
