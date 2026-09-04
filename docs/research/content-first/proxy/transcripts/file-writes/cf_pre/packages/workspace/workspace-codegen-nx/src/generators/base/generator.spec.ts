1: /**
2:  * generator.spec.ts — proves the `base` generator's build-executor
3:  * enforcement (INVESTIGATION-BUILD-TOOL-001 generator-enforcement item).
4:  *
5:  * WHY THIS EXISTS: 10 `@nx/vite:build` `platform:node`/`platform:shared`
6:  * apigen packages shipped broken `verify-dist-load`-failing dist bundles
7:  * (`ReferenceError: __filename is not defined in ES module scope`) because
8:  * their `vite.config.ts` bundled real npm dependencies (ts-morph,
9:  * typescript) instead of externalizing them — see BACKLOG.md
10:  * INVESTIGATION-BUILD-TOOL-001 / BUG-BUILD-VITE-EXTERNAL-BUNDLING-001. The
11:  * fix (`tools/vite-external-deps.mjs`'s `externalizeRealDeps`) only prevents
12:  * a RECURRENCE if newly-scaffolded packages get it automatically. This test
13:  * drives the actual `base` generator (the same codepath every tier
14:  * delegates through — see `shared/generator.ts`) against a real in-memory
15:  * Tree and asserts the generated `vite.config.ts` on disk-equivalent content
16:  * actually wires the externalization call — not just that the generator
17:  * "ran without throwing".
18:  */
19: import { describe, it, expect, beforeEach } from 'vitest';
20: import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
21: import { type Tree } from '@nx/devkit';
22: import baseGenerator from './generator';
23: 
24: describe('base generator — vite external-deps enforcement', () => {
25:   let tree: Tree;
26: 
27:   beforeEach(() => {
28:     tree = createTreeWithEmptyWorkspace();
29:   });
30: 
31:   it('platform:node — wires externalizeRealDeps(__dirname) into rollupOptions.external', async () => {
32:     await baseGenerator(tree, {
33:       name: 'widget',
34:       group: 'billing',
35:       nxLayer: 'logic',
36:       platform: 'node',
37:     });
38: 
39:     const viteConfig = tree.read(
40:       'packages/billing/billing-base-widget/vite.config.ts',
41:       'utf-8'
42:     );
43:     expect(viteConfig).toContain(
44:       "import { externalizeRealDeps } from '../../../tools/vite-external-deps.mjs';"
45:     );
46:     expect(viteConfig).toContain('external: externalizeRealDeps(__dirname)');
47:     // The bug this closes: a bare `external: []` bundles every real npm dep.
48:     expect(viteConfig).not.toMatch(/external:\s*\[\]/);
49:   });
50: 
51:   it('platform:shared — also wires externalizeRealDeps (apigen-core-client\'s tier)', async () => {
52:     await baseGenerator(tree, {
53:       name: 'widget',
54:       group: 'billing',
55:       nxLayer: 'shared',
56:       platform: 'shared',
57:     });
58: 
59:     const viteConfig = tree.read(
60:       'packages/billing/billing-base-widget/vite.config.ts',
61:       'utf-8'
62:     );
63:     expect(viteConfig).toContain('external: externalizeRealDeps(__dirname)');
64:   });
65: 
66:   it('platform:browser — leaves external: [] alone (consumed by an app bundler, not Node)', async () => {
67:     await baseGenerator(tree, {
68:       name: 'widget',
69:       group: 'billing',
70:       nxLayer: 'ui-primitives',
71:       platform: 'browser',
72:     });
73: 
74:     const viteConfig = tree.read(
75:       'packages/billing/billing-base-widget/vite.config.ts',
76:       'utf-8'
77:     );
78:     expect(viteConfig).not.toContain('externalizeRealDeps');
79:     expect(viteConfig).toMatch(/external:\s*\[\]/);
80:   });
81: });

(End of file - total 81 lines)