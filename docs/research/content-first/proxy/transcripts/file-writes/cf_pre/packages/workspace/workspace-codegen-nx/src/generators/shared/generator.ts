1: import {
2:   type Tree,
3:   formatFiles,
4:   joinPathFragments,
5:   logger,
6:   readJson,
7:   writeJson,
8: } from '@nx/devkit';
9: import { libraryGenerator } from '@nx/js';
10: import { readWorkspaceConfig, validateGroup, validatePlatform, validateNxLayer } from './workspace-config';
11: 
12: export interface ScaffoldGeneratorSchema {
13:   type: 'base' | 'core' | 'engine' | 'store' | 'plugin' | 'generator' | 'query' | 'types' | 'entrypoint';
14:   name: string;
15:   group: string;
16:   nxLayer: string;
17:   platform: 'node' | 'browser' | 'shared';
18:   access?: 'domain' | 'public';
19:   publish?: boolean;
20: }
21: 
22: const TYPE_TO_CLASS: Record<string, string> = {
23:   base: 'foundation',
24:   core: 'foundation',
25:   engine: 'foundation',
26:   store: 'foundation',
27:   query: 'foundation',
28:   plugin: 'optional',
29:   generator: 'optional',
30:   types: 'types',
31:   entrypoint: 'entrypoint',
32: };
33: 
34: export async function scaffoldGenerator(tree: Tree, schema: ScaffoldGeneratorSchema) {
35:   const { type, name, group, nxLayer, platform, access = 'domain', publish = false } = schema;
36: 
37:   // Determine directory and project name
38:   let dir: string;
39:   let projectName: string;
40:   let importPath: string;
41: 
42:   if (type === 'entrypoint') {
43:     // Entrypoints live under entrypoint/ with <name>/
44:     dir = `entrypoint/${name}`;
45:     projectName = name;
46:     importPath = `@adhd/${name}`;
47:   } else {
48:     const pkgName = `${group}-${type}-${name}`;
49:     dir = `packages/${group}`;
50:     projectName = pkgName;
51:     importPath = `@adhd/${pkgName}`;
52:   }
53: 
54:   // Validate against workspace config
55:   const config = readWorkspaceConfig(tree);
56:   if (type !== 'entrypoint') {
57:     const groupErr = validateGroup(group, config);
58:     if (groupErr) throw new Error(groupErr);
59:   }
60:   const platformErr = validatePlatform(platform, config);
61:   if (platformErr) throw new Error(platformErr);
62:   const nxLayerErr = validateNxLayer(nxLayer, config);
63:   if (nxLayerErr) throw new Error(nxLayerErr);
64: 
65:   logger.info(`Scaffolding ${projectName} at ${dir} (${importPath})`);
66: 
67:   // Generate the package
68:   let projectRoot: string;
69:   if (type === 'entrypoint') {
70:     projectRoot = dir;
71:     scaffoldEntrypoint(tree, projectRoot, projectName);
72:   } else {
73:     await libraryGenerator(tree, {
74:       name: projectName,
75:       directory: dir,
76:       importPath,
77:       publishable: true,
78:       bundler: 'vite',
79:       skipFormat: true,
80:     });
81:     projectRoot = joinPathFragments(dir, projectName);
82:   }
83: 
84:   // Fix project name and tags
85:   const projectJsonPath = joinPathFragments(projectRoot, 'project.json');
86:   if (tree.exists(projectJsonPath)) {
87:     const projectJson = readJson(tree, projectJsonPath);
88:     projectJson.name = projectName;
89:     projectJson.sourceRoot = `${projectRoot}/src`;
90:     const pkgClass = TYPE_TO_CLASS[type] || 'foundation';
91:     projectJson.tags = [
92:       `domain:${group}`,
93:       `pkg-kind:${type}`,
94:       `pkg-class:${pkgClass}`,
95:       `layer:${nxLayer}`,
96:       `platform:${platform}`,
97:       `access:${access}`,
98:     ];
99:     if (publish) {
100:       projectJson.tags.push('publish:npm');
101:     }
102:     patchProjectJson(projectJson, projectRoot);
103:     writeJson(tree, projectJsonPath, projectJson);
104:     logger.info(`  Tags: ${projectJson.tags.join(', ')}`);
105:   }
106: 
107:   // Add tsconfig paths with ./ prefix for TypeScript compatibility
108:   const tsconfigPath = 'tsconfig.base.json';
109:   if (tree.exists(tsconfigPath)) {
110:     const tsconfig = readJson(tree, tsconfigPath);
111:     if (!tsconfig.compilerOptions) tsconfig.compilerOptions = {};
112:     if (!tsconfig.compilerOptions.paths) tsconfig.compilerOptions.paths = {};
113:     tsconfig.compilerOptions.paths[importPath] = [`./${projectRoot}/src/index.ts`];
114:     writeJson(tree, tsconfigPath, tsconfig);
115:   }
116: 
117:   // Post-generation patches (same as generate-lib.sh v4/v5)
118:   patchViteConfig(tree, projectRoot, platform);
119:   patchReleasePublish(tree, projectRoot);
120:   ensureReadme(tree, projectRoot, projectName);
121:   patchEslintrc(tree, projectRoot);
122:   patchTsconfigLib(tree, projectRoot);
123: 
124:   await formatFiles(tree);
125: }
126: 
127: /**
128:  * BUG-WORKSPACE-GEN-006: the `@nx/js:library` vite scaffold still emits the
129:  * PRE-migration workspace-root dist layout (`build.options.outputPath:
130:  * dist/{projectRoot}`, release `packageRoot: dist/{projectRoot}`) and no
131:  * `test` target. The repo is on IN-TREE dist — the injected `assets` and
132:  * `verify-dist-load` targets read `{projectRoot}/dist` and fail against the
133:  * stale layout (`assets: no dist ... (build first)`). Mirror the reference
134:  * package (apigen-plugin-batch): in-tree dist, explicit `@nx/vite:test`
135:  * target, and release packageRoots pointing at `{projectRoot}/dist`.
136:  */
137: function patchProjectJson(
138:   projectJson: {
139:     targets?: Record<string, any>;
140:     release?: { version?: { generatorOptions?: Record<string, any> } };
141:   },
142:   projectRoot: string
143: ) {
144:   const build = projectJson.targets?.build;
145:   // Only vite-bundled libraries get the repairs: entrypoints use
146:   // `nx:run-commands` and must not gain vite targets/options.
147:   if (!build || build.executor !== '@nx/vite:build') return;
148:   build.options ??= {};
149:   build.options.outputPath = `${projectRoot}/dist`;
150:   build.options.emptyOutDir = true;
151:   if (!projectJson.targets?.test) {
152:     projectJson.targets!.test = {
153:       executor: '@nx/vite:test',
154:       outputs: [`{workspaceRoot}/coverage/${projectRoot}`],
155:       options: {
156:         configFile: `${projectRoot}/vite.config.ts`,
157:       },
158:     };
159:   }
160:   const pub = projectJson.targets?.['nx-release-publish'];
161:   if (pub) {
162:     pub.options ??= {};
163:     pub.options.packageRoot = `${projectRoot}/dist`;
164:   }
165:   if (projectJson.release?.version?.generatorOptions) {
166:     projectJson.release.version.generatorOptions.packageRoot = `${projectRoot}/dist`;
167:   }
168: }
169: 
170: function patchViteConfig(tree: Tree, dir: string, platform: 'node' | 'browser' | 'shared') {
171:   const vitePath = joinPathFragments(dir, 'vite.config.ts');
172:   if (!tree.exists(vitePath)) return;
173:   let content = tree.read(vitePath, 'utf-8');
174:   if (!content) return;
175: 
176:   // BUG-WORKSPACE-GEN-006: the `@nx/vite` scaffold emits `build.ln` pointing
177:   // at the PRE-migration workspace-root dist (`../../../dist/packages/...`).
178:   // The repo is on in-tree dist — rename to vite's `outDir: 'dist'` under the
179:   // project root; the `emptyOutDir` guard directly below then adds the
180:   // rebuild flag (mirror apigen-plugin-batch/vite.config.ts).
181:   content = content.replace(/ln:\s*'[^']*',/, "outDir: 'dist',");
182: 
183:   // Add emptyOutDir: true
184:   if (!content.includes('emptyOutDir')) {
185:     content = content.replace(/(\s*outDir:\s*['"][^'"]+['"],)/, '$1\n    emptyOutDir: true,');
186:   }
187: 
188:   // Add copy-readme plugin
189:   if (!content.includes('copy-readme')) {
190:     const match = content.match(/outDir:\s*['"]([^'"]+)['"]/);
191:     const outDir = match ? match[1] : 'dist';
192:     const plugin = `    {\n      name: 'copy-readme',\n      apply: 'build',\n      closeBundle() {\n        const fs = require('node:fs'), p = require('node:path');\n        const src = p.resolve(__dirname, 'README.md');\n        if (!fs.existsSync(src)) return;\n        const out = p.resolve(__dirname, '${outDir}');\n        fs.mkdirSync(out, { recursive: true });\n        fs.copyFileSync(src, p.join(out, 'README.md'));\n      },\n    },\n`;
193:     content = content.replace(/(plugins:\s*\[\n)/, `$1${plugin}`);
194:   }
195: 
196:   // BUILD-CONSIST-008 / INVESTIGATION-BUILD-TOOL-001: `platform:node` and
197:   // `platform:shared` libraries must externalize every real npm dependency
198:   // (and Node builtins) so `@nx/vite:build` never bundles heavy CJS-only
199:   // packages like ts-morph/typescript into the library's own output —
200:   // bundling them was the confirmed root cause of `verify-dist-load`
201:   // failures ("__filename is not defined in ES module scope" /
202:   // "Cannot read properties of undefined (reading 'timeOrigin')") across 10
203:   // apigen packages (devops-engineer session, 2026-07-20). `@adhd/*`
204:   // workspace packages must stay BUNDLED (not externalized) — this repo has
205:   // no `workspaces` linking, so an externalized `require('@adhd/x')` cannot
206:   // resolve from a built `dist/` artifact at runtime (BUG-WORKSPACE-NO-LINKING-001).
207:   // `platform:browser` libraries are left as `external: []` — they're
208:   // consumed by an app's own bundler, not run directly under Node, so the
209:   // CJS/ESM interop failure mode this fixes doesn't apply there.
210:   if (platform === 'node' || platform === 'shared') {
211:     if (!content.includes('externalizeRealDeps')) {
212:       content = content.replace(
213:         /(import \{ nxViteTsPaths \} from '@nx\/vite\/plugins\/nx-tsconfig-paths\.plugin';\n)/,
214:         `$1import { externalizeRealDeps } from '../../../tools/vite-plugins/externalize.mjs';\n` +
215:           `import { vitestPoolOptions } from '../../../tools/vite-plugins/vitest-pool-defaults.mjs';\n`
216:       );
217:     }
218:     content = content.replace(/external:\s*\[\]/, 'external: externalizeRealDeps(__dirname)');
219:     // BUG-WORKSPACE-GEN-006: repo conventions — node test environment and the
220:     // shared vitest pool cap (DEBT-TEST-CPU-OVERSUBSCRIBED-001), mirroring
221:     // apigen-plugin-batch/vite.config.ts.
222:     content = content.replace("environment: 'jsdom',", "environment: 'node',");
223:     content = content.replace(/(test:\s*\{\s*\n\s*globals: true,)/, '$1\n    poolOptions: vitestPoolOptions,');
224:   }
225: 
226:   tree.write(vitePath, content);
227: }
228: 
229: /**
230:  * BUG-WORKSPACE-GEN-006: the publish pipeline's gates (`assets`,
231:  * `verify-dist-load`, `dist-manifest`, `publish-hygiene`) must run before a
232:  * release. A project-level `dependsOn` REPLACES nx.json's targetDefault for
233:  * that target, so a short list silently drops gates — write the full list the
234:  * reference package (apigen-plugin-batch/project.json) uses. Also point the
235:  * publish packageRoot at the IN-TREE dist (`{projectRoot}/dist`), not the
236:  * pre-migration `dist/{projectRoot}`.
237:  */
238: function patchReleasePublish(tree: Tree, dir: string) {
239:   const projectPath = joinPathFragments(dir, 'project.json');
240:   if (!tree.exists(projectPath)) return;
241:   const projectJson = readJson(tree, projectPath);
242:   const pub = projectJson?.targets?.['nx-release-publish'];
243:   if (pub) {
244:     pub.dependsOn = [
245:       'build',
246:       'assets',
247:       'test',
248:       'dist-manifest',
249:       'verify-dist-load',
250:       'publish-hygiene',
251:     ];
252:     pub.options ??= {};
253:     pub.options.packageRoot = `${dir}/dist`;
254:     writeJson(tree, projectPath, projectJson);
255:   }
256: }
257: 
258: function ensureReadme(tree: Tree, dir: string, projectName: string) {
259:   const readmePath = joinPathFragments(dir, 'README.md');
260:   if (tree.exists(readmePath)) return;
261:   tree.write(
262:     readmePath,
263:     `# @adhd/${projectName}\n\n> TODO: one-line description of \`${projectName}\`.\n\n\`\`\`bash\nnpm install @adhd/${projectName}\n\`\`\`\n`
264:   );
265: }
266: 
267: function patchEslintrc(tree: Tree, dir: string) {
268:   const eslintPath = joinPathFragments(dir, '.eslintrc.json');
269:   if (!tree.exists(eslintPath)) return;
270:   const eslint = readJson(tree, eslintPath);
271:   if (eslint.ignorePatterns && !eslint.ignorePatterns.some((p: string) => p.includes('vite.config'))) {
272:     eslint.ignorePatterns.push('vite.config.js', 'vite.config.ts', 'vite.config.mjs', 'vite.config.mts');
273:     writeJson(tree, eslintPath, eslint);
274:   }
275: }
276: 
277: function scaffoldEntrypoint(tree: Tree, root: string, name: string) {
278:   tree.write(joinPathFragments(root, 'src/index.ts'), `// Entrypoint: @adhd/${name}\n`);
279:   tree.write(joinPathFragments(root, 'project.json'), JSON.stringify({
280:     name,
281:     $schema: '../../node_modules/nx/schemas/project-schema.json',
282:     sourceRoot: `${root}/src`,
283:     projectType: 'application',
284:     tags: [`entrypoint:${name}`, 'pkg-class:entrypoint', 'platform:node'],
285:     targets: {
286:       build: {
287:         executor: 'nx:run-commands',
288:         options: { command: `tsc -p ${root}/tsconfig.json` },
289:       },
290:     },
291:   }, null, 2) + '\n');
292:   tree.write(joinPathFragments(root, 'package.json'), JSON.stringify({ name: `@adhd/${name}`, version: '0.0.1', private: true }, null, 2) + '\n');
293:   tree.write(joinPathFragments(root, 'tsconfig.json'), JSON.stringify({ extends: '../../tsconfig.base.json', compilerOptions: { outDir: '../../dist/entrypoint' }, include: ['src'] }, null, 2) + '\n');
294: }
295: 
296: function patchTsconfigLib(tree: Tree, dir: string) {
297:   const tsconfigLibPath = joinPathFragments(dir, 'tsconfig.lib.json');
298:   if (!tree.exists(tsconfigLibPath)) return;
299:   const tsconfigLib = readJson(tree, tsconfigLibPath);
300:   if (tsconfigLib.exclude && !tsconfigLib.exclude.includes('src/test/**')) {
301:     tsconfigLib.exclude.push('src/test/**');
302:     writeJson(tree, tsconfigLibPath, tsconfigLib);
303:   }
304: }
305: 
306: export default scaffoldGenerator;

(End of file - total 306 lines)