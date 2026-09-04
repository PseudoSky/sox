1: import { type Tree } from '@nx/devkit';
2: import { scaffoldGenerator, type ScaffoldGeneratorSchema } from '../shared/generator';
3: 
4: interface SubGeneratorSchema {
5:   name: string;
6:   group: string;
7:   nxLayer: string;
8:   platform: 'node' | 'browser' | 'shared';
9:   access?: 'domain' | 'public';
10:   publish?: boolean;
11: }
12: 
13: export default async function (tree: Tree, opts: SubGeneratorSchema) {
14:   const full: ScaffoldGeneratorSchema = { ...opts, type: 'plugin' as const };
15:   await scaffoldGenerator(tree, full);
16: }

(End of file - total 16 lines)