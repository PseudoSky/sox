/**
 * Canonical emitted-config templates for `@adhd/workspace-codegen-nx`
 * generators (BUG-WORKSPACE-GEN-006).
 *
 * Prior design drifted from repo conventions because `shared/generator.ts`
 * regex-patched whatever `@nx/js:libraryGenerator` emitted; every migration
 * changed the base scaffold and the regexes silently missed, re-introducing
 * stale artifacts (nonexistent `tools/vite-external-deps.mjs` import,
 * workspace-root `dist/...` layout, no `test` target). These builders
 * OVERWRITE the emitted `vite.config.ts` / `project.json` targets with a
 * deterministic canonical shape that mirrors the repo's migrated reference
 * packages verbatim:
 *   - `packages/apigen/apigen-plugin-batch/{vite.config.ts,project.json}`
 *   - `packages/apigen/apigen-plugin-jsonschema/{vite.config.ts,project.json}`
 */

export interface CanonicalViteConfigOptions {
  /** Nx project root, e.g. 'packages/apigen/apigen-plugin-batch'. */
  projectRoot: string;
  /** Nx project name, e.g. 'apigen-plugin-batch'. */
  projectName: string;
  /** Platform tag. node/shared externalize real deps; browser does not. */
  platform: 'node' | 'browser' | 'shared';
  /** Relative path from projectRoot up to the workspace root ('../../../' or '../../'). */
  rel: string;
}

/**
 * The full `vite.config.ts` a scaffolded package must contain: in-tree dist
 * (`root: __dirname`, `build.outDir: 'dist'`), the real
 * `tools/vite-plugins/externalize.mjs` / `vitest-pool-defaults.mjs` imports,
 * and the canonical test block. Browser scaffolds keep `external: []` (their
 * output is consumed by an app bundler, not run directly under Node).
 */
export function canonicalViteConfig(opts: CanonicalViteConfigOptions): string {
  const { projectRoot, projectName, platform, rel } = opts;
  const externalize = platform === 'node' || platform === 'shared';

  const imports = externalize
    ? `import { externalizeRealDeps } from '${rel}tools/vite-plugins/externalize.mjs';
import { vitestPoolOptions } from '${rel}tools/vite-plugins/vitest-pool-defaults.mjs';
`
    : '';

  const rollupOptions = externalize
    ? `    rollupOptions: {
      // Bundle only @adhd/* workspace source (no workspace symlinks in
      // this repo — see tools/vite-plugins/externalize.mjs); externalize
      // every real npm dependency + Node builtin.
      external: externalizeRealDeps(__dirname),
    }`
    : `    rollupOptions: {
      // Browser libs are consumed by an app's own bundler — nothing is
      // externalized here.
      external: [],
    }`;

  const poolOptions = externalize ? `    poolOptions: vitestPoolOptions,\n` : '';
  const environment = externalize ? `    environment: 'node',\n` : '';

  return `/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
${imports}
export default defineConfig({
  root: __dirname,
  cacheDir: '${rel}node_modules/.vite/${projectRoot}',

  plugins: [
    nxViteTsPaths(),
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(__dirname, 'tsconfig.lib.json'),
    }),
  ],

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    lib: {
      entry: 'src/index.ts',
      name: '${projectName}',
      fileName: 'index',
      formats: ['es', 'cjs'],
    },
${rollupOptions},
  },

  test: {
${poolOptions}    globals: true,
    cache: {
      dir: '${rel}node_modules/.vitest',
    },
${environment}    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '${rel}coverage/${projectRoot}',
      provider: 'v8',
    },
  },
});
`;
}

/**
 * The canonical `project.json` targets every scaffolded (non-entrypoint)
 * package must carry: an in-tree-dist `build` (`@nx/vite:build`), a
 * `test` target wired to the emitted `vite.config.ts`, and an
 * `nx-release-publish` that depends on the plugin-injected
 * `verify-dist-load`/`dist-manifest`/`publish-hygiene` gates. Mirrors
 * `packages/apigen/apigen-plugin-batch/project.json` targets verbatim.
 */
export function canonicalTargets(projectRoot: string): {
  build: {
    executor: '@nx/vite:build';
    outputs: ['{options.outputPath}'];
    options: { outputPath: string; emptyOutDir: boolean };
  };
  test: {
    executor: '@nx/vite:test';
    outputs: [string];
    options: { configFile: string };
  };
  'nx-release-publish': {
    dependsOn: ['build', 'test', 'verify-dist-load', 'dist-manifest', 'publish-hygiene'];
    executor: '@nx/js:release-publish';
    options: { packageRoot: string };
  };
} {
  return {
    build: {
      executor: '@nx/vite:build',
      outputs: ['{options.outputPath}'],
      options: {
        outputPath: `${projectRoot}/dist`,
        emptyOutDir: true,
      },
    },
    test: {
      executor: '@nx/vite:test',
      outputs: [`{workspaceRoot}/coverage/${projectRoot}`],
      options: {
        configFile: `${projectRoot}/vite.config.ts`,
      },
    },
    'nx-release-publish': {
      dependsOn: ['build', 'test', 'verify-dist-load', 'dist-manifest', 'publish-hygiene'],
      executor: '@nx/js:release-publish',
      options: {
        packageRoot: '{projectRoot}/dist',
      },
    },
  };
}
