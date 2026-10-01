# s5 — Pin bump + relock (OWNER-GATED — do not start without authorization)

## Goal

Move all `^0.7.1` manifests to `0.8.x` and relock, then re-measure the two anchors.

## Work

1. Update the **five** caret manifests (`DESIGN.md` §7): root `package.json:62`,
   `store-adapter/package.json:28`, `memory-flush:23`, `memory-server:25`,
   `memory-cli:25`. Decide the `researcher-exp/package.json:13` exact `0.7.2` scratch
   (remove or bump).
2. `pnpm install`; commit the `pnpm-lock.yaml` diff **in the same change** (AGENTS.md
   relock rule). Do not hand-fix `node_modules`.
3. `npx nx build store-adapter` (and consumers) to refresh `dist/`.
4. Re-measure and update `FTS_OPTIMIZE_LEAK_MEASURED_ON` (`store-rebuild.ts:128`) and
   `SUPPRESSION_VALID_FOR` (`integrity.ts:2454`) — **only after** re-running their guards
   on the new driver.

## Gates

`npx nx run-many -t build,lint,test,typecheck`; `node scripts/smoke-test.mjs` (0 failures);
`git diff --exit-code registry/index.json` clean. Changesets release for the three
published extensions happens separately (`PUBLISHING.md`).

## Constraints

Only on explicit owner authorization. Pin/relock only; no registry edits.
