1: import { builtinModules } from 'node:module';
2: import { computeRealDependencyNames } from '../nx-plugins/deps/compute-real-deps.js';
3: 
4: /**
5:  * Returns the `build.rollupOptions.external` array a `platform:node` /
6:  * `platform:shared` library's `vite.config.ts` should use: every REAL npm
7:  * dependency reachable from the package — its own `dependencies` +
8:  * `peerDependencies`, PLUS the same from every `@adhd/*` workspace package it
9:  * (transitively) depends on — plus every Node builtin. `@adhd/*` package
10:  * names themselves are never externalized.
11:  *
12:  * WHY `@adhd/*` packages stay bundled (not externalized): this monorepo's
13:  * root `package.json` has no `workspaces` field and `node_modules/@adhd/*`
14:  * has no symlinks to the in-repo packages — there is no yarn/npm workspace
15:  * linking at all. `@adhd/*` imports only resolve today via Nx's
16:  * `tsconfig.base.json` path mapping, which vite's `nxViteTsPaths()` plugin
17:  * follows straight to SOURCE at build time. An unbundled
18:  * `require('@adhd/x')` (e.g. from an `@nx/js:tsc` build, or from an
19:  * externalized vite build) has nothing to resolve against at runtime and
20:  * throws `Cannot find module '@adhd/x'` / `ERR_MODULE_NOT_FOUND` — verified
21:  * directly in this repo (devops-engineer session, 2026-07-20): switching
22:  * `apigen-core-client` to `@nx/js:tsc` made its own `require('@adhd/apigen-
23:  * base-logical')` fail exactly this way, and `agent-mcp`/`decompile-cli`/
24:  * `agent-engine-compiler`/`agent-engine-orchestrator` (already on
25:  * `@nx/js:tsc`, already depending on sibling `@adhd/*` packages at runtime,
26:  * not just types) fail identically today — see BACKLOG.md
27:  * `BUG-WORKSPACE-NO-LINKING-001`. Bundling `@adhd/*` source is the only
28:  * mechanism in this repo that currently makes cross-package runtime imports
29:  * work, so it must stay bundled even while everything else is externalized.
30:  *

(Showing lines 1-30 of 80. Use offset=31 to continue.)