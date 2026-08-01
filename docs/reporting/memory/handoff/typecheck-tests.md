# Handoff — BL-340 / BL-325 (spec typecheck gate + spec async conversion)

> **Written by the team lead, not the agent.** `bl340-325` was stopped at ~450k context on the
> owner's instruction before it could write its own. Everything below I verified against the tree
> myself after stopping it; where I did not verify something I say so.
>
> **Entry point:** [`../README.md`](../README.md) → [`../STATE.md`](../STATE.md).

**Commits:** `ed424ec` (BL-340 targets), `ff40e25` (BL-325 WIP), `1aa0dd7` (the remaining 27 files,
committed by me after stopping the agent). Tree is clean; nothing is stranded.

---

## 1. The framing — these were never two items

`libs/memory-core/tsconfig.typecheck.json` carried
`"exclude": ["src/**/*.spec.ts", "src/**/*.test.ts", ...]`. **Spec files were never typechecked.**
That is the entire reason BL-325 existed: TypeScript rejects `const db = openDb(...)` followed by
`db.executeGet(...)` instantly, because `Promise<StoreAdapter>` has no `executeGet`. Eighteen-plus
files drifted through the StoreAdapter sync→async migration because nothing ever looked.

BL-325 is not eighteen independent mistakes. It is **one missing gate** (BL-340) and its
accumulated consequences. Fix the gate first, and the consequences enumerate themselves as compile
errors instead of having to be hunted.

---

## 2. BL-340 — DONE, and the gate is real

`memory-core` now has a `typecheck-tests` target driving `tsconfig.typecheck-tests.json`, which
**includes** specs.

Two design choices in that config, both deliberate — do not "simplify" either:

- **`include` covers `src/**/*.ts`, not just the spec glob.** A spec cannot be typechecked without
  also checking the modules it imports.
- **`module: ESNext` / `moduleResolution: bundler`**, unlike the lib config's CommonJS/node10.
  Vitest runs these files as ESM and the chaos specs use `import.meta`, which node10 rejects with
  `TS1343`.

Keeping `typecheck-tests` separate from `typecheck` is what preserves triage clarity: production-only
breakage still fails `typecheck` first.

**Red→green watched by me, not taken on trust.** Appending
`const __probe: number = "not a number";` to `errors.spec.ts` makes the target fail:

```
libs/memory-core/src/errors.spec.ts:193:7 - error TS2322:
  Type 'string' is not assignable to type 'number'.
```

Removing it returns the target to green (exit 0). **The gate genuinely reads spec files.**

> ⚠️ **Trap that cost me a wrong conclusion — read before you measure anything.** `tsc` writes ANSI
> colour codes *between* `error` and `TS`, so `grep -cE "error TS"` returns **0 on a failing run**.
> I briefly believed the gate was fake because of this. Match on `Found [0-9]+ error`, or just use
> the exit code.

`memory-server` also got a target in `ed424ec`. **I have not verified memory-server's** — check it
with the same red arm before trusting it.

---

## 3. BL-325 — typecheck-clean, runtime NOT finished

`npx nx run memory-core:typecheck-tests` → **passes clean**. All 27 spec files typecheck.

`npx nx test memory-core --skip-nx-cache` → **37 failed / 454 passed / 8 skipped** (43 files, 12
failing, 5 unhandled errors). Measured once, on a clean tree, after the agent stopped.

| file | failing |
|---|---|
| `write-queue-backpressure.spec.ts` | 11 |
| `enrich.spec.ts` | 6 |
| `write-queue.spec.ts` | 5 |
| `reembed.spec.ts` | 5 |
| `write.spec.ts` | 2 |
| `write-pipeline.spec.ts` | 2 |
| `update.spec.ts` | 1 |
| `errors.spec.ts` | 1 |
| `compaction.spec.ts` | 1 |
| `concurrency-harness.spec.ts` | 1 |
| `recall-live-incident.spec.ts` | 1 |
| `chaos/queue-overflow.chaos.spec.ts` | 1 |

**The conversion is not purely mechanical.** `errors.spec.ts` needed a narrowing guard, not an
`await`:

```ts
expect(locked.ok).toBe(false);
if (locked.ok) throw new Error('expected the locked write to fail with E_BUSY');
expect(locked.error.code).toBe('E_BUSY');
```

Expect more of this shape wherever a discriminated union is asserted rather than narrowed. Helper
functions and `beforeEach` blocks that return a typed object need their **declared types** changed
too, not just an `await` added.

---

## 4. ⚠️ The number, and three wrong ones

Three agents quoted three different memory-core failure counts today — **92**, **86**, and **~19** —
each attributing them to BL-325, each in good faith. All three were snapshots of a tree being
edited underneath them while this agent worked. **The number is 37.** Do not propagate the others,
and do not treat any of them as a baseline.

This is the same discipline BL-331 and the drain-rate episode established: *every count must state
the tree state it was measured on.* A failure count taken during a concurrent edit is not a
measurement.

---

## 5. Open, and what I would NOT assume

1. **The 37 runtime failures are the work.** They are *not* all BL-325 — that is a hypothesis, not a
   finding. `write-queue-backpressure` (11) and `write-queue` (5) are 43% of the total in one
   subsystem, which smells like one shared cause rather than sixteen; find it before fixing
   individually.
2. **`enrich.spec.ts`'s 6** were A/B'd against HEAD during BL-381's work and attributed to
   `clusterStore` `ON CONFLICT` drift. That attribution **predates this tree** and has not been
   re-verified — re-check it rather than inheriting it.
3. **Do not weaken `strict`, `noUnusedLocals`, or `exactOptionalPropertyTypes`** to close anything.
4. **Do not delete BL-340/BL-325 from `BACKLOG.md` yet.** BL-340 is genuinely done and could be
   moved to `CHANGELOG.md`; BL-325 is not, and closing it on a green *typecheck* while 37 runtime
   tests fail is exactly the BL-225 failure mode this repo has been burned by five times.
5. **Roll the whole-repo gate before claiming done:** `npx nx run-many -t build,lint,test,typecheck`
   plus `typecheck-tests`, and `rm -rf dist/smoke && node scripts/smoke-test.mjs`.

**Do not run `nx build memory-server` casually** — see **BL-393**: a build's `rm -rf dist` prelude
kills the live backend, and the front-shim proxy silently respawns it onto whatever bundle is
staged, redeploying production without anyone asking.
