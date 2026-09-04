1: /// <reference types='vitest' />
2: import { defineConfig } from 'vite';
3: import dts from 'vite-plugin-dts';
4: import * as path from 'path';
5: import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
6: import { externalizeRealDeps } from '../../../tools/vite-plugins/externalize.mjs';
7: 
8: import { vitestPoolOptions } from '../../../tools/vite-plugins/vitest-pool-defaults.mjs';
9: export default defineConfig({
10:   root: __dirname,
11:   cacheDir: '../../../node_modules/.vite/packages/apigen/plugins/batch',
12: 
13:   plugins: [
14:     nxViteTsPaths(),
15:     dts({
16:       entryRoot: 'src',
17:       tsconfigPath: path.join(__dirname, 'tsconfig.lib.json'),
18:     }),
19:   ],
20: 
21:   build: {
22:     outDir: 'dist',
23:     emptyOutDir: true,
24:     reportCompressedSize: true,
25:     commonjsOptions: {
26:       transformMixedEsModules: true,
27:     },
28:     lib: {
29:       entry: 'src/index.ts',
30:       name: 'apigen-plugin-batch',
31:       fileName: 'index',
32:       formats: ['es', 'cjs'],
33:     },
34:     rollupOptions: {
35:       // Bundle only @adhd/* workspace source (no workspace symlinks in
36:       // this repo — see tools/vite-plugins/externalize.mjs); externalize
37:       // every real npm dependency + Node builtin. See BACKLOG.md
38:       // INVESTIGATION-BUILD-TOOL-001.
39:       external: externalizeRealDeps(__dirname),
40:     },
41:   },
42: 
43:   test: {
44:     poolOptions: vitestPoolOptions,
45:     globals: true,
46:     cache: {
47:       dir: '../../../node_modules/.vitest',
48:     },
49:     environment: 'node',
50:     include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
51:     reporters: ['default'],
52:     coverage: {
53:       reportsDirectory: '../../../coverage/packages/apigen/plugins/batch',
54:       provider: 'v8',
55:     },
56:   },
57: });

(End of file - total 57 lines)