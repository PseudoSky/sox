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
  patchViteConfig(tree, projectRoot, platform);
  patchProjectJsonTargets(tree, projectRoot);
  patchPackageJsonEntries(tree, projectRoot);
  patchReleasePublish(tree, projectRoot);
  ensureReadme(tree, projectRoot, projectName);
  patchEslintrc(tree, projectRoot);
  patchTsconfigLib(tree, projectRoot);

  await formatFiles(tree);
}

function patchViteConfig(tree: Tree, dir: string, platform: 'node' | 'browser' | 'shared') {
  const vitePath = joinPathFragments(dir, 'vite.config.ts');
  if (!tree.exists(vitePath)) return;
  let content = tree.read(vitePath, 'utf-8');
  if (!content) return;

  // In-tree dist (BUG-WORKSPACE-GEN-006): the @nx/vite template emits a
  // workspace-root escape `outDir: '../../../dist/packages/...'`; the repo
  // migrated to {projectRoot}/dist (see apigen-plugin-batch/vite.config.ts:22).
  // Runs first so the emptyOutDir insert and the copy-readme plugin's outDir
  // read below both see `'dist'`.
  content = content.replace(
    /outDir:\s*['"]\.\.\/(?:\.\.\/)+dist[^'"]*['"]/,
    `outDir: 'dist'`
  );

  // Add emptyOutDir: true
  if (!content.includes('emptyOutDir')) {
    content = content.replace(/(\s*outDir:\s*['"][^'"]+['"],)/, '$1\n    emptyOutDir: true,');
  }

  // Add copy-readme plugin
  if (!content.includes('copy-readme')) {
    const match = content.match(/outDir:\s*['"]([^'"]+)['"]/);
    const outDir = match ? match[1] : 'dist';
    const plugin = `    {\n      name: 'copy-readme',\n      apply: 'build',\n      closeBundle() {\n        const fs = require('node:fs'), p = require('node:path');\n        const src = p.resolve(__dirname, 'README.md');\n        if (!fs.existsSync(src)) return;\n        const out = p.resolve(__dirname, '${outDir}');\n        fs.mkdirSync(out, { recursive: true });\n        fs.copyFileSync(src, p.join(out, 'README.md'));\n      },\n    },\n`;
    content = content.replace(/(plugins:\s*\[\n)/, `$1${plugin}`);
  }

  // BUILD-CONSIST-008 / INVESTIGATION-BUILD-TOOL-001: `platform:node` and
  // `platform:shared` libraries must externalize every real npm dependency
  // (and Node builtins) so `@nx/vite:build` never bundles heavy CJS-only
  // packages like ts-morph/typescript into the library's own output —
  // bundling them was the confirmed root cause of `verify-dist-load`
  // failures ("__filename is not defined in ES module scope" /
  // "Cannot read properties of undefined (reading 'timeOrigin')") across 10
  // apigen packages (devops-engineer session, 2026-07-20). `@adhd/*`
  // workspace packages must stay BUNDLED (not externalized) — this repo has
  // no `workspaces` linking, so an externalized `require('@adhd/x')` cannot
  // resolve from a built `dist/` artifact at runtime (BUG-WORKSPACE-NO-LINKING-001).
  // `platform:browser` libraries are left as `external: []` — they're
  // consumed by an app's own bundler, not run directly under Node, so the
  // CJS/ESM interop failure mode this fixes doesn't apply there.
  if (platform === 'node' || platform === 'shared') {
    if (!content.includes('externalizeRealDeps')) {
      content = content.replace(
        /(import \{ nxViteTsPaths \} from '@nx\/vite\/plugins\/nx-tsconfig-paths\.plugin';\n)/,
        `$1import { externalizeRealDeps } from '../../../tools/vite-plugins/externalize.mjs';\nimport { vitestPoolOptions } from '../../../tools/vite-plugins/vitest-pool-defaults.mjs';\n`
      );
    }
    content = content.replace(/external:\s*\[\]/, 'external: externalizeRealDeps(__dirname)');
    if (!content.includes('poolOptions: vitestPoolOptions')) {
      content = content.replace(/(test:\s*\{\n)/, `$1    poolOptions: vitestPoolOptions,\n`);
    }
    // BUG-WORKSPACE-GEN-006 (AC-3): the @nx/vite template defaults the test
    // environment to `'jsdom'` — the `@nx/js` schema default `'node'` is only
    // applied when options are coerced through the CLI, not in the
    // programmatic libraryGenerator call here — so force the node/shared
    // platforms to the repo's `environment: 'node'` contract.
    if (!content.includes("environment: 'node'")) {
      content = content.replace(/environment:\s*'jsdom'/, `environment: 'node'`);
    }
  }

  tree.write(vitePath, content);
}

function patchProjectJsonTargets(tree: Tree, dir: string) {
  const projectPath = joinPathFragments(dir, 'project.json');
  if (!tree.exists(projectPath)) return;
  const projectJson = readJson(tree, projectPath);
  // Entrypoint scaffolds use `nx:run-commands` — never overwrite those.
  if (projectJson?.targets?.build?.executor !== '@nx/vite:build') return;
  projectJson.targets = projectJson.targets ?? {};
  projectJson.targets.build = {
    executor: '@nx/vite:build',
    outputs: ['{options.outputPath}'],
    options: {
      outputPath: `${dir}/dist`,
      emptyOutDir: true,
    },
  };
  projectJson.targets.test = {
    executor: '@nx/vite:test',
    outputs: [`{workspaceRoot}/coverage/${dir}`],
    options: {
      configFile: `${dir}/vite.config.ts`,
    },
  };
  writeJson(tree, projectPath, projectJson);
}

function patchPackageJsonEntries(tree: Tree, dir: string) {
  const packagePath = joinPathFragments(dir, 'package.json');
  if (!tree.exists(packagePath)) return;
  const pkgJson = readJson(tree, packagePath);
  // Entrypoint package.json has no `main` — never touch those.
  if (pkgJson?.main === undefined) return;
  if (typeof pkgJson.main === 'string' && pkgJson.main.includes('dist')) return;
  pkgJson.main = './dist/index.js';
  pkgJson.module = './dist/index.mjs';
  delete pkgJson.typings;
  pkgJson.types = './dist/index.d.ts';
  writeJson(tree, packagePath, pkgJson);
}

function patchReleasePublish(tree: Tree, dir: string) {
  const projectPath = joinPathFragments(dir, 'project.json');
  if (!tree.exists(projectPath)) return;
  const projectJson = readJson(tree, projectPath);
  const pub = projectJson?.targets?.['nx-release-publish'];
  if (pub && !pub.dependsOn) {
    pub.dependsOn = ['build', 'test'];
    writeJson(tree, projectPath, projectJson);
  }
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
      },
    },
  }, null, 2) + '\n');
  tree.write(joinPathFragments(root, 'package.json'), JSON.stringify({ name: `@adhd/${name}`, version: '0.0.1', private: true }, null, 2) + '\n');
  tree.write(joinPathFragments(root, 'tsconfig.json'), JSON.stringify({ extends: '../../tsconfig.base.json', compilerOptions: { outDir: '../../dist/entrypoint' }, include: ['src'] }, null, 2) + '\n');
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

export default scaffoldGenerator;
