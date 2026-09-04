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
    patchProjectJson(projectJson, projectRoot);
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
  patchReleasePublish(tree, projectRoot);
  patchPackageJson(tree, projectRoot);
  ensureReadme(tree, projectRoot, projectName);
  patchEslintrc(tree, projectRoot);
  patchTsconfigLib(tree, projectRoot);

  await formatFiles(tree);
}

interface GeneratedTarget {
  executor?: string;
  options?: Record<string, unknown>;
  outputs?: unknown[];
}

interface GeneratedProjectJson {
  targets?: Record<string, GeneratedTarget>;
  release?: { version?: { generatorOptions?: Record<string, unknown> } };
}

/**
 * BUG-WORKSPACE-GEN-006: the `@nx/js:library` vite scaffold still emits the
 * PRE-migration workspace-root dist layout (`build.options.outputPath:
 * dist/{projectRoot}`, release `packageRoot: dist/{projectRoot}`) and no
 * `test` target. The repo is on IN-TREE dist — the injected `assets` and
 * `verify-dist-load` targets read `{projectRoot}/dist` and fail against the
 * stale layout (`assets: no dist ... (build first)`). Mirror the reference
 * package (apigen-plugin-batch): in-tree dist, explicit `@nx/vite:test`
 * target, and release packageRoots pointing at `{projectRoot}/dist`.
 */
function patchProjectJson(projectJson: GeneratedProjectJson, projectRoot: string) {
  const targets = (projectJson.targets ??= {});
  const build = targets.build;
  // Only vite-bundled libraries get the repairs: entrypoints use
  // `nx:run-commands` and must not gain vite targets/options.
  if (!build || build.executor !== '@nx/vite:build') return;
  build.options ??= {};
  build.options.outputPath = `${projectRoot}/dist`;
  build.options.emptyOutDir = true;
  if (!targets.test) {
    targets.test = {
      executor: '@nx/vite:test',
      outputs: [`{workspaceRoot}/coverage/${projectRoot}`],
      options: {
        configFile: `${projectRoot}/vite.config.ts`,
      },
    };
  } else {
    // The @nx/vite configuration generator already created a `test` target
    // (executor + reportsDirectory) but no `configFile` — nothing invoked the
    // vite config's test block via nx (BUG-WORKSPACE-GEN-006). Wire it.
    targets.test.executor ??= '@nx/vite:test';
    targets.test.options ??= {};
    targets.test.options.configFile = `${projectRoot}/vite.config.ts`;
  }
  const pub = targets['nx-release-publish'];
  if (pub) {
    pub.options ??= {};
    pub.options.packageRoot = `${projectRoot}/dist`;
  }
  if (projectJson.release?.version?.generatorOptions) {
    projectJson.release.version.generatorOptions.packageRoot = `${projectRoot}/dist`;
  }
}

function patchViteConfig(tree: Tree, dir: string, platform: 'node' | 'browser' | 'shared') {
  const vitePath = joinPathFragments(dir, 'vite.config.ts');
  if (!tree.exists(vitePath)) return;
  let content = tree.read(vitePath, 'utf-8');
  if (!content) return;

  // BUG-WORKSPACE-GEN-006: the `@nx/vite` scaffold emits
  // `build.outDir: '../../../dist/packages/...'` — the PRE-migration
  // workspace-root dist. The repo is on in-tree dist — emit to `dist` under
  // the project root (mirror apigen-plugin-batch/vite.config.ts). The
  // template already carries `emptyOutDir: true`, so the guard below no-ops.
  content = content.replace(/(\s*outDir:\s*)'[^']*'/, "$1'dist'");

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
        `$1import { externalizeRealDeps } from '../../../tools/vite-plugins/externalize.mjs';\n` +
          `import { vitestPoolOptions } from '../../../tools/vite-plugins/vitest-pool-defaults.mjs';\n`
      );
    }
    content = content.replace(/external:\s*\[\]/, 'external: externalizeRealDeps(__dirname)');
    // BUG-WORKSPACE-GEN-006: repo conventions — node test environment and the
    // shared vitest pool cap (DEBT-TEST-CPU-OVERSUBSCRIBED-001), mirroring
    // apigen-plugin-batch/vite.config.ts.
    content = content.replace("environment: 'jsdom',", "environment: 'node',");
    content = content.replace(/(test:\s*\{\s*\n\s*globals: true,)/, '$1\n    poolOptions: vitestPoolOptions,');
  }

  tree.write(vitePath, content);
}

/**
 * BUG-WORKSPACE-GEN-006: the publish pipeline's gates (`assets`,
 * `verify-dist-load`, `dist-manifest`, `publish-hygiene`) must run before a
 * release. A project-level `dependsOn` REPLACES nx.json's targetDefault for
 * that target, so a short list silently drops gates — write the full list the
 * reference package (apigen-plugin-batch/project.json) uses. Also point the
 * publish packageRoot at the IN-TREE dist (`{projectRoot}/dist`), not the
 * pre-migration `dist/{projectRoot}`.
 */
function patchReleasePublish(tree: Tree, dir: string) {
  const projectPath = joinPathFragments(dir, 'project.json');
  if (!tree.exists(projectPath)) return;
  const projectJson = readJson(tree, projectPath);
  const pub = projectJson?.targets?.['nx-release-publish'];
  if (pub) {
    pub.dependsOn = [
      'build',
      'assets',
      'test',
      'dist-manifest',
      'verify-dist-load',
      'publish-hygiene',
    ];
    pub.options ??= {};
    pub.options.packageRoot = `${dir}/dist`;
    writeJson(tree, projectPath, projectJson);
  }
}

/**
 * BUG-WORKSPACE-GEN-006: the `@nx/js:library` scaffold writes the PRE-migration
 * package.json consumer entries (`main: "./index.js"` at the package root —
 * a file that does not exist there; the build emits to `{projectRoot}/dist`).
 * Repoint them at the in-tree dist and use the repo's `types` field, mirroring
 * the reference package (apigen-plugin-batch/package.json). Guarded to
 * packages that carry a `main` (vite libraries); entrypoints (no `main`) and
 * already-migrated shapes are left untouched.
 */
function patchPackageJson(tree: Tree, dir: string) {
  const pkgPath = joinPathFragments(dir, 'package.json');
  if (!tree.exists(pkgPath)) return;
  const pkg = readJson(tree, pkgPath) as Record<string, unknown> | undefined;
  if (!pkg || typeof pkg.main !== 'string') return;
  if (pkg.main === './dist/index.js' && pkg.module === './dist/index.mjs') return;
  pkg.main = './dist/index.js';
  pkg.module = './dist/index.mjs';
  pkg.types = './dist/index.d.ts';
  delete pkg.typings;
  if (!Array.isArray(pkg.files)) {
    pkg.files = ['dist'];
  }
  writeJson(tree, pkgPath, pkg);
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
