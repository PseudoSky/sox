1: /**
2:  * plugin/generator.spec.ts — proves the plugin generator (the tier that
3:  * demonstrated BUG-WORKSPACE-GEN-006) scaffolds convention-correct packages.
4:  *
5:  * WHAT THIS CLOSES (FEATURE.md): `nx g @adhd/workspace-codegen-nx:plugin`
6:  * scaffolded packages whose build/verify/test config was broken until manual
7:  * repair:
8:  *   1. vite.config.ts imported `externalizeRealDeps` from the NONEXISTENT
9:  *      `tools/vite-external-deps.mjs` (real helper:
10:  *      `tools/vite-plugins/externalize.mjs`) — the config failed to load.
11:  *   2. Build emitted to the PRE-migration workspace-root dist
12:  *      (`dist/packages/...`); the injected `assets`/`verify-dist-load`
13:  *      targets read `{projectRoot}/dist` and failed against the stale layout.
14:  *   3. project.json had no `test` target invoking the vite config's test block.
15:  *
16:  * TEETH (repo AGENTS.md §7.2): every negative assertion (`not.toContain`
17:  * `'vite-external-deps'`, `not.toContain("'../../../dist/")`,
18:  * `not.toMatch(/dist\/packages/)`) targets a string the PRE-FIX generator
19:  * emitted — revert the generator patches and this suite goes red.
20:  */
21: import { describe, it, expect, beforeEach } from 'vitest';
22: import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
23: import { type Tree } from '@nx/devkit';
24: import pluginGenerator from './generator';
25: 
26: const PKG = 'apigen-plugin-ir-cache';
27: const PKG_DIR = `packages/apigen/${PKG}`;
28: const VITE_PATH = `${PKG_DIR}/vite.config.ts`;
29: const PROJECT_JSON_PATH = `${PKG_DIR}/project.json`;
30: 
31: async function scaffoldPlugin(tree: Tree, platform: 'node' | 'browser' | 'shared' = 'node') {
32:   await pluginGenerator(tree, {
33:     name: 'ir-cache',
34:     group: 'apigen',
35:     nxLayer: 'logic',
36:     platform,
37:   });
38: }
39: 
40: describe('plugin generator — BUG-WORKSPACE-GEN-006 output contract', () => {
41:   let tree: Tree;
42: 
43:   beforeEach(() => {
44:     tree = createTreeWithEmptyWorkspace();
45:   });
46: 
47:   it('node — imports externalizeRealDeps from the REAL helper path (never the stale one)', async () => {
48:     await scaffoldPlugin(tree);
49:     const viteConfig = tree.read(VITE_PATH, 'utf-8');
50:     expect(viteConfig).toContain(
51:       "import { externalizeRealDeps } from '../../../tools/vite-plugins/externalize.mjs';"
52:     );
53:     expect(viteConfig).not.toContain('vite-external-deps');
54:     expect(viteConfig).toContain('external: externalizeRealDeps(__dirname)');
55:   });
56: 
57:   it('node — wires the shared vitest pool cap', async () => {
58:     await scaffoldPlugin(tree);
59:     const viteConfig = tree.read(VITE_PATH, 'utf-8');
60:     expect(viteConfig).toContain(
61:       "import { vitestPoolOptions } from '../../../tools/vite-plugins/vitest-pool-defaults.mjs';"
62:     );
63:     expect(viteConfig).toContain('poolOptions: vitestPoolOptions');
64:   });
65: 
66:   it('node — builds to IN-TREE dist (outDir dist, no pre-migration ../../../dist)', async () => {
67:     await scaffoldPlugin(tree);
68:     const viteConfig = tree.read(VITE_PATH, 'utf-8');
69:     expect(viteConfig).toContain("outDir: 'dist',");
70:     expect(viteConfig).not.toContain("'../../../dist/");
71:     expect(viteConfig).toContain('emptyOutDir: true');
72:   });
73: 
74:   it('node — runs tests in the node environment', async () => {
75:     await scaffoldPlugin(tree);
76:     const viteConfig = tree.read(VITE_PATH, 'utf-8');
77:     expect(viteConfig).toContain("environment: 'node',");
78:   });
79: 
80:   it('node — project.json points build at {projectRoot}/dist (never dist/packages/...)', async () => {
81:     await scaffoldPlugin(tree);
82:     const projectJson = JSON.parse(tree.read(PROJECT_JSON_PATH, 'utf-8'));
83:     expect(projectJson.targets.build.options.outputPath).toBe(`${PKG_DIR}/dist`);
84:     expect(projectJson.targets.build.options.emptyOutDir).toBe(true);
85:     expect(JSON.stringify(projectJson)).not.toMatch(/dist\/packages\//);
86:   });
87: 
88:   it('node — project.json has an explicit @nx/vite:test target wired to the vite config', async () => {
89:     await scaffoldPlugin(tree);
90:     const projectJson = JSON.parse(tree.read(PROJECT_JSON_PATH, 'utf-8'));
91:     expect(projectJson.targets.test.executor).toBe('@nx/vite:test');
92:     expect(projectJson.targets.test.options.configFile).toBe(`${PKG_DIR}/vite.config.ts`);
93:   });
94: 
95:   it('node — package.json consumer entries point at the IN-TREE dist', async () => {
96:     await scaffoldPlugin(tree);
97:     const pkg = JSON.parse(tree.read(`${PKG_DIR}/package.json`, 'utf-8'));
98:     expect(pkg.main).toBe('./dist/index.js');
99:     expect(pkg.module).toBe('./dist/index.mjs');
100:     expect(pkg.types).toBe('./dist/index.d.ts');
101:     expect(pkg.typings).toBeUndefined();
102:   });
103: 
104:   it('node — release packageRoots point at the IN-TREE dist', async () => {
105:     await scaffoldPlugin(tree);
106:     const projectJson = JSON.parse(tree.read(PROJECT_JSON_PATH, 'utf-8'));
107:     expect(projectJson.targets['nx-release-publish'].options.packageRoot).toBe(`${PKG_DIR}/dist`);
108:     expect(projectJson.release.version.generatorOptions.packageRoot).toBe(`${PKG_DIR}/dist`);
109:     expect(projectJson.targets['nx-release-publish'].dependsOn).toEqual([
110:       'build',
111:       'assets',
112:       'test',
113:       'dist-manifest',
114:       'verify-dist-load',
115:       'publish-hygiene',
116:     ]);
117:   });
118: 
119:   it('shared — also wires externalize + pool options (apigen-core-client tier)', async () => {
120:     await scaffoldPlugin(tree, 'shared');
121:     const viteConfig = tree.read(VITE_PATH, 'utf-8');
122:     expect(viteConfig).toContain('external: externalizeRealDeps(__dirname)');
123:     expect(viteConfig).toContain('poolOptions: vitestPoolOptions');
124:   });
125: 
126:   it('browser — leaves external: [] and no externalize/pool injection (app bundler consumer)', async () => {
127:     await scaffoldPlugin(tree, 'browser');
128:     const viteConfig = tree.read(VITE_PATH, 'utf-8');
129:     expect(viteConfig).not.toContain('externalizeRealDeps');
130:     expect(viteConfig).not.toContain('vitestPoolOptions');
131:     expect(viteConfig).toMatch(/external:\s*\[\]/);
132:   });
133: });

(End of file - total 133 lines)