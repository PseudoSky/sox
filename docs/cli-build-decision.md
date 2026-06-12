# CLI Build Decision — `bin/sox`

**Decision date:** 2026-06-08
**Status:** accepted
**Author:** typescript-pro (Phase P0 executor)

---

## Context

The `sox-ecosystem` monorepo has two coexisting `dist` notions that must not be conflated:

1. **Hand-maintained ESM mirrors** (`dist/memory-lib.js`, `dist/memory-cli.js`, `dist/memoryd.js`):
   These are manually authored JavaScript files that mirror their `src/` counterparts. Tools and tests
   import from `dist/*.js` directly. They are NOT compiled output — they are maintained by hand.

2. **Compiler output** from `pnpm -r build`: each extension package runs `tsc` in its own directory,
   writing compiled JavaScript to `dist/extensions/<name>/` and `dist/scripts/`. The root-level
   `tsconfig.json` covers `scripts/**/*.ts` + `extensions/**/*.ts`, compiling to `dist/` when invoked
   via `tsc` — but this output path overlaps with (1) and nothing in the repo imports from it.

The root scripts (`scripts/*.ts`) run directly via `npx tsx` without a compile step. There is no
bundler. The CLI host entrypoint (`bin/sox`) must choose one discipline.

---

## Decision: Hand-Maintained ESM Mirror (Discipline B)

**`bin/sox` is a directly runnable ESM JavaScript file. It is not compiled from TypeScript.**

### Rationale

| Factor | Analysis |
|---|---|
| Existing precedent | `dist/memory-lib.js` and peers already establish the hand-mirror pattern as the runtime contract for directly-imported modules. |
| No bundler gap | Introducing a new compile step (e.g. `tsc --outDir bin/`) would require a new tsconfig target, a `pnpm build` gate in CI, and a two-step edit cycle. None of this infrastructure exists or is warranted for P0. |
| `tsx` is devDependency only | Engine scripts run via `npx tsx` at dev time; the `bin/sox` entry point must be runnable in production contexts (`node bin/sox`) without `tsx`. Hand-authored ESM JS satisfies this without a build. |
| Engine coupling is via import | When later phases wire engine calls (`scripts/install.ts` etc.), those will be invoked via `npx tsx scripts/install.ts` as subprocess, or the CLI file will `import` the compiled `dist/scripts/*.js` output. Either path does not require `bin/sox` itself to be TypeScript. |
| Reversibility | If a later phase determines TypeScript safety is needed in `bin/sox`, the hand-maintained file can be replaced by compiled output at that point. The decision is additive and reversible. |

### Chosen discipline

> **`bin/sox` is authored as `bin/sox` (ESM JS, shebang `#!/usr/bin/env node`).**
> It imports no TypeScript sources directly.
> When it needs to invoke engine logic, it will spawn `npx tsx scripts/<script>.ts` or import
> from `dist/scripts/*.js` (pre-compiled output).

---

## src↔dist Sync Rule

For the **hand-maintained mirror** discipline, the following rule applies:

1. `bin/sox` is the sole CLI entrypoint. It lives at `bin/sox` and is directly runnable.
2. `bin/sox` is **not** generated — edits are made directly to `bin/sox`.
3. If future phases introduce TypeScript in `bin/` (e.g. `bin/sox.ts`), a `tsconfig.bin.json` must
   be added (distinct from root `tsconfig.json`) and `pnpm build:cli` must regenerate `bin/sox` before
   it is tested. Until then, no compile step is required.
4. The root `tsconfig.json` `include` list (`scripts/**/*.ts`, `extensions/**/*.ts`) does NOT include
   `bin/`. Verify this remains true if new tsconfig includes are added.
5. `dist/memory-lib.js`, `dist/memory-cli.js`, `dist/memoryd.js` remain hand-maintained as before.
   They are not affected by P0.

---

## What this decision is NOT

- It does not retire the `pnpm -r build` path (extension packages still compile via their own `tsc`).
- It does not touch `dist/scripts/` or `dist/extensions/` output.
- It does not affect the 131-test engine suite, which imports from `dist/memory-lib.js` and peers.
- It does not preclude a future migration to compiled TypeScript for the CLI host.

---

## Supersession (2026-06-08) — framework-contract-completion P0

**Superseded for extension packages by framework-contract-completion P0.**

The "Discipline B" (hand-maintained ESM mirror) decision above applies ONLY to `bin/sox` and the
root-level `dist/memory-lib.js` / `dist/memory-cli.js` / `dist/memoryd.js` mirrors. It does NOT
apply to the extension packages under `extensions/`.

Phase P0 (`framework-contract-completion`) reverses the hand-maintained approach for the 9
process-type extension packages (`mcp-server`, `hook`, `agent`, `skill`, `command`):

- Each extension package now has its own `tsconfig.json` (extending `tsconfig.base.json`) that
  compiles `src/index.ts` → `dist/index.js` via `tsc`.
- `pnpm -r build` compiles all 9 process-type packages deterministically.
- The CI validate workflow runs `pnpm -r build` after `pnpm typecheck` and before
  `validate-manifests`, so the entrypoint-reachability gate in `validate-manifests.ts` can assert
  each manifest's declared `entrypoint` resolves to a built file.
- The hand-maintained mirrors (`dist/memory-lib.js`, `dist/memory-cli.js`, `dist/memoryd.js`) are
  NOT yet removed — that retirement is Phase P1, sequenced to protect
  `extensions/hooks/memory-flush/src/index.ts` which imports from `../../../dist/memory-lib.js`.

In short: `bin/sox` is still hand-maintained per the original decision; extension packages are now
compiler-output. The two notions of `dist/` are distinct and must not be conflated.
