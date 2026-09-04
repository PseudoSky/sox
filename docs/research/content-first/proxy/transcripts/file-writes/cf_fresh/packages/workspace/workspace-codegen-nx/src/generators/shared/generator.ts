import {
  type Tree,
  formatFiles,
  joinPathFragments,
  logger,
  readJson,
  writeJson,
} from '@nx/devkit';
import { libraryGenerator } from '@nx/js';
import { readWorkspaceConfig, validateGroup, validatePlatform, validateNxLayer } from './workspace-config';
import { canonicalTargets, canonicalViteConfig } from './templates';

export interface ScaffoldGeneratorSchema {
  type: 'base' | 'core' | 'engine' | 'store' | 'plugin' | 'generator' | 'query' | 'types' | 'entrypoint';
  name: string;
  group: string;
  nxLayer: string;
  platform: 'node' | 'browser' | 'shared';
  access?: 'domain' | 'public';
  publish?: boolean;
}

const TYPE_TO_CLASS: Record<string, string> = {
  base: 'foundation',
  core: 'foundation',
  engine: 'foundation',
  store: 'foundation',
  query: 'foundation',
  plugin: 'optional',
  generator: 'optional',
  types: 'types',
  entrypoint: 'entrypoint',
};

export async function scaffoldGenerator(tree: Tree, schema: ScaffoldGeneratorSchema) {
  const { type, name, group, nxLayer, platform, access = 'domain', publish = false } = schema;

  // Determine directory and project name
  let dir: string;
  let projectName: string;
  let importPath: string;

  if (type === 'entrypoint') {
    // Entrypoints live under entrypoint/ with <name>/
    dir = `entrypoint/${name}`;
    projectName = name;
    importPath = `@adhd/${name}`;
  } else {
    const pkgName = `${group}-${type}-${name}`;
    dir = `packages/${group}`;
    projectName = pkgName;
    importPath = `@adhd/${pkgName}`;
  }

  // Validate against workspace config
  const config = readWorkspaceConfig(tree);
  if (type !== 'entrypoint') {
    const groupErr = validateGroup(group, config);
    if (groupErr) throw new Error(groupErr);
  }
  const platformErr = validatePlatform(platform, config);
  if (platformErr) throw new Error(platformErr);
  const nxLayerErr = validateNxLayer(nxLayer, config);
  if (nxLayerErr) throw new Error(nxLayerErr);

  logger.info(`Scaffolding ${projectName} at ${dir} (${importPath})`);

  // Generate the package
  let projectRoot: string;
  if (type === 'entrypoint') {
    projectRoot = dir;
    scaffoldEntrypoint(tree, projectRoot, projectName);
  } else {
    await libraryGenerator(tree, {
      name: projectName,
      directory: dir,
      importPath,
      publishable: true,
      bundler: 'vite',
      skipFormat: true,
    });
    projectRoot = joinPathFragments(dir, projectName);
  }

  // Fix project name and tags
  const projectJsonPath = joinPathFragments(projectRoot, 'project.json');
  if (tree.exists(projectJsonPath)) {
    const projectJson = readJson(tree, projectJsonPath);
    projectJson.name = projectName;
    projectJson.sourceRoot = `${projectRoot}/src`;
    const pkgClass = TYPE_TO_CLASS[type] || 'foundation';
    projectJson.tags = [
      `domain:${group}`,
      `pkg-kind:${type}`,
      `pkg-class:${pkgClass}`,
      `layer:${nxLayer}`,
      `platform:${platform}`,
      `access:${access}`,
    ];
    if (publish) {
      projectJson.tags.push('publish:npm');
    }
    writeJson(tree, projectJsonPath, projectJson);
    logger.info(`  Tags: ${projectJson.tags.join(', ')}`);
  }

  // Add tsconfig paths with ./ prefix for TypeScript compatibility
  const tsconfigPath = 'tsconfig.base.json';
  if (tree.exists(tsconfigPath)) {
    const tsconfig = readJson(tree, tsconfigPath);
    if (!tsconfig.compilerOptions) tsconfig.compilerOptions = {};
    if (!tsconfig.compilerOptions.paths) tsconfig.compilerOptions.paths = {};
    tsconfig.compilerOptions.paths[importPath] = [`./${projectRoot}/src/index.ts`];
    writeJson(tree, tsconfigPath, tsconfig);
  }

  // Post-generation patches (same as generate-lib.sh v4/v5)
  patchViteConfig(tree, projectRoot, projectName, platform);
  patchReleasePublish(tree, projectRoot);
  ensureReadme(tree, projectRoot, projectName);
  patchEslintrc(tree, projectRoot);
  patchTsconfigLib(tree, projectRoot);
  ensurePlaceholderSpec(tree, projectRoot, projectName);

  await formatFiles(tree);
}

function patchViteConfig(tree: Tree, dir: string, projectName: string, platform: 'node' | 'browser' | 'shared') {
  const vitePath = joinPathFragments(dir, 'vite.config.ts');
  if (!tree.exists(vitePath)) return;
  // Overwrite the libraryGenerator-emitted config with the canonical template
  // (BUG-WORKSPACE-GEN-006): in-tree dist, real tools/vite-plugins/* imports,
  // canonical test block. No regex patching — the template is the contract.
  const rel = dir.startsWith('entrypoint/') ? '../../' : '../../../';
  tree.write(
    vitePath,
    canonicalViteConfig({ projectRoot: dir, projectName, platform, rel })
  );
}

function patchReleasePublish(tree: Tree, dir: string) {
  const projectPath = joinPathFragments(dir, 'project.json');
  if (!tree.exists(projectPath)) return;
  // Only vite-based library scaffolds get the canonical targets. Entrypoint
  // scaffolds hand-write their own `nx:run-commands` tsc build target and
  // have no vite.config — merging canonical vite targets there would clobber
  // their build (BUG-WORKSPACE-GEN-006 regression guard).
  if (!tree.exists(joinPathFragments(dir, 'vite.config.ts'))) return;
  const projectJson = readJson(tree, projectPath);
  // Merge the canonical build/test/nx-release-publish targets over whatever
  // libraryGenerator emitted (BUG-WORKSPACE-GEN-006): in-tree dist outputPath,
  // a real `test` target, and a publish gate that depends on the injected
  // verify-dist-load/dist-manifest/publish-hygiene targets.
  projectJson.targets = { ...projectJson.targets, ...canonicalTargets(dir) };
  if (!projectJson.targets.lint) {
    projectJson.targets.lint = { executor: '@nx/eslint:lint' };
  }
  // libraryGenerator emits release.version.generatorOptions.packageRoot as
  // the pre-migration "dist/{projectRoot}" — the same stale-layout family as
  // the build outputPath (BUG-WORKSPACE-GEN-006). The repo convention is the
  // source root: both apigen-plugin-batch/project.json and
  // workspace-codegen-nx/project.json use "{projectRoot}".
  if (projectJson.release?.version?.generatorOptions?.packageRoot?.startsWith('dist/')) {
    projectJson.release.version.generatorOptions.packageRoot = '{projectRoot}';
  }
  writeJson(tree, projectPath, projectJson);
}

function ensureReadme(tree: Tree, dir: string, projectName: string) {
  const readmePath = joinPathFragments(dir, 'README.md');
  if (tree.exists(readmePath)) return;
  tree.write(
    readmePath,
    `# @adhd/${projectName}\n\n> TODO: one-line description of \`${projectName}\`.\n\n\`\`\`bash\nnpm install @adhd/${projectName}\n\`\`\`\n`
  );
}

function patchEslintrc(tree: Tree, dir: string) {
  const eslintPath = joinPathFragments(dir, '.eslintrc.json');
  if (!tree.exists(eslintPath)) return;
  const eslint = readJson(tree, eslintPath);
  if (eslint.ignorePatterns && !eslint.ignorePatterns.some((p: string) => p.includes('vite.config'))) {
    eslint.ignorePatterns.push('vite.config.js', 'vite.config.ts', 'vite.config.mjs', 'vite.config.mts');
    writeJson(tree, eslintPath, eslint);
  }
}

function scaffoldEntrypoint(tree: Tree, root: string, name: string) {
  tree.write(joinPathFragments(root, 'src/index.ts'), `// Entrypoint: @adhd/${name}\n`);
  tree.write(joinPathFragments(root, 'project.json'), JSON.stringify({
    name,
    $schema: '../../node_modules/nx/schemas/project-schema.json',
    sourceRoot: `${root}/src`,
    projectType: 'application',
    tags: [`entrypoint:${name}`, 'pkg-class:entrypoint', 'platform:node'],
    targets: {
      build: {
        executor: 'nx:run-commands',
        options: { command: `tsc -p ${root}/tsconfig.json` },
        // In-tree dist (BUG-WORKSPACE-GEN-006): tsc emits to entrypoint/<name>/dist
        // via the tsconfig outDir below; declare it so nx tracks/cleans it.
        outputs: ['{projectRoot}/dist'],
      },
    },
  }, null, 2) + '\n');
  tree.write(joinPathFragments(root, 'package.json'), JSON.stringify({ name: `@adhd/${name}`, version: '0.0.1', private: true }, null, 2) + '\n');
  // In-tree dist: `dist` resolves relative to this tsconfig, i.e. entrypoint/<name>/dist
  // (BUG-WORKSPACE-GEN-006 — the old '../../dist/entrypoint' was the pre-migration
  // workspace-root layout).
  tree.write(joinPathFragments(root, 'tsconfig.json'), JSON.stringify({ extends: '../../tsconfig.base.json', compilerOptions: { outDir: 'dist' }, include: ['src'] }, null, 2) + '\n');
}

function patchTsconfigLib(tree: Tree, dir: string) {
  const tsconfigLibPath = joinPathFragments(dir, 'tsconfig.lib.json');
  if (!tree.exists(tsconfigLibPath)) return;
  const tsconfigLib = readJson(tree, tsconfigLibPath);
  if (tsconfigLib.exclude && !tsconfigLib.exclude.includes('src/test/**')) {
    tsconfigLib.exclude.push('src/test/**');
    writeJson(tree, tsconfigLibPath, tsconfigLib);
  }
}

function ensurePlaceholderSpec(tree: Tree, dir: string, projectName: string) {
  // Only vite-based library scaffolds get a test target (patchReleasePublish);
  // vitest exits 1 when its include glob matches nothing, so a fresh scaffold
  // must carry at least one spec (AC-3 of BUG-WORKSPACE-GEN-006). Entrypoint
  // scaffolds have no test target — skip them.
  if (!tree.exists(joinPathFragments(dir, 'vite.config.ts'))) return;
  // libraryGenerator already emits src/lib/<name>.spec.ts in current Nx — if
  // any spec/test file exists, the scaffold is already runnable; don't add a
  // duplicate (observed in a real scaffold: a second, redundant spec was
  // created before this guard).
  const libDir = joinPathFragments(dir, 'src/lib');
  if (tree.exists(libDir)) {
    const hasSpec = tree
      .children(libDir)
      .some((f) => /\.(spec|test)\.(ts|tsx|js|jsx|mts|cts)$/.test(f));
    if (hasSpec) return;
  }
  const specPath = joinPathFragments(dir, 'src/lib', `${projectName}.spec.ts`);
  if (tree.exists(specPath)) return;
  tree.write(
    specPath,
    `import { describe, it, expect } from 'vitest';\n\ndescribe('${projectName}', () => {\n  it('scaffolds cleanly', () => {\n    expect(true).toBe(true);\n  });\n});\n`
  );
}

export default scaffoldGenerator;
