# Handoff — test infrastructure (BL-340 / BL-325 / BL-324 / BL-343 / BL-377)

> Written 2026-07-31 by `p0-test-infra` at context rotation. Assumes you know nothing about today.
> Entry point for this program is [`../README.md`](../README.md); program state lives in
> [`../STATE.md`](../STATE.md). Read those first — this file is only the test-infrastructure thread.

**The one thing to take from this document:** the remaining failure count is an **upper bound on
test debt, not a measure of it.** One item I fixed today (BL-377) was 30 of the 162 failures I was
looking at, and it was a *production* defect hiding inside what everyone — including me — had been
calling test debt. Assume more of the remainder is real.

---

## 1. Where this actually is

### Reproduce the numbers

```bash
npx nx test memory-core   --skip-nx-cache      # the headline count
npx nx test memory-server --skip-nx-cache
npx nx run memory-core:typecheck-tests --skip-nx-cache   # spec typechecking (BL-340, new today)
npx nx run memory-core:typecheck        --skip-nx-cache   # production code
```

### Measured

| | Start of session | At my last commit (`46d94af`) |
|---|---|---|
| `memory-core` | 265 failed / 193 passed / 8 skipped (466) | **87 failed** / 393 passed / 8 skipped (488) |
| `memory-server` | 9 failed / 169 passed (178) | **3 failed** / 175 passed (178) |
| spec typecheck errors (`memory-core`) | 941 | **174** |

Total moved 466 → 488 because I added tests (3 for BL-343, plus others); nothing was removed and no
file reports `(0 test)`.

### ⚠️ Your baseline will not match mine, and here is why

Re-running immediately after `46d94af` gave **95 failed** and **203** spec typecheck errors. That
delta is **not** drift in my work — it is `p0-adapter-integrity`'s **uncommitted** BL-381 change
sitting in the shared tree (`neardup.ts`, `dialect.ts` (new), `embed-pipeline.ts`, `enrich.ts`,
`update.ts`, `write.ts`, `index.ts`, and memory-server's `index.ts`). It makes `VectorDialect` a
required parameter, deliberately, so that a call site which forgets it is a compile error.

**Take a fresh baseline before you attribute anything to yourself.** `git status` first; if that work
is still uncommitted or has since landed, your numbers legitimately differ from both figures above.
`npx nx run memory-core:typecheck` reported **0** errors at the time of writing, so their production
side was complete in-tree.

---

## 2. What is left, by cluster

`memory-core`, 21 failing files. **The codemods are exhausted** — I ran them to fixpoint and they
report zero edits. Everything below is a distinct judgement call, not a sweep. Counts are the
dominant causes from the last full run; they shift as you fix things.

| Cluster | Approx. | What it is | How to approach |
|---|---|---|---|
| Deliberately-invalid fixtures | ~10 | Specs pass a knowingly-bad shape to assert an error path, e.g. `write.spec.ts:335` passing `{ content }` with no `project_path` against `WriteParams`. TypeScript is right; the *test* is intentionally wrong. | `as unknown as WriteParams` **with a comment saying why**. Do not "fix" the fixture — you would delete the assertion. |
| `noUncheckedIndexedAccess` / nullability | ~35 | `executeGet` returns `T \| null`; better-sqlite3 returned `T \| undefined`. Plus `arr[0]` now `T \| undefined`. Shows as TS18047/TS18048/TS2532. | `!` is idiomatic here — a null in a test should fail loudly. Mechanical but needs a human eye per site. |
| Genuine assertion drift | ~25 | `expected false to be true`, `expected null not to be null`, `expected 0 to be 1`. Behaviour changed under the specs. | **Triage each one.** This is where the next BL-377 is hiding. Do not batch-fix. |
| Lifecycle / connection | ~13 | `statement has been finalized`, `cannot start a transaction within a transaction`, `The database connection is not open`. Concentrated in `write-queue*.spec.ts`, `chaos/`. | Likely real ordering/teardown bugs. Treat as product suspects. |
| Leftover `raw` helpers | ~12 | `TS6133: 'raw' is declared but its value is never read` after the sweep in §5. | Delete the helper. Trivial. |

`memory-server`, 3 failing:

- `recall-parity.test.ts` — **BL-367**, see §4. Unresolved and important.
- `async-embed.spec.ts:287` — `memory_ping` returns `store: null` on a fresh tmp store. BL-324
  symptom group 2 attributes this to a `SQLITE_READONLY_DBMOVED` unhandled rejection from
  `pragmaSet` during `_openDbInner`. I saw that rejection; I did not root-cause it.
- `memory-tools.spec.ts:195` — `provider_call_count` is 1, expected 0. Note CHANGELOG's BL-254
  entry says this counter was *fixed to actually increment*; the assertion may now be the stale
  side. **Check which is right before changing either.**

---

## 3. Methodology warning — read before triaging §2

BL-377 is the case that should change how you read the remaining count.

`export.ts:295` and `reembed.ts:250` did `(adapter as SqliteAdapter).unwrap()` with no capability
guard. That cast is *asserted, never checked*. On sqlite the handle's `.prepare().all()` is
synchronous and returns an array; on **Turso — which is the default** — it is asynchronous and
returns a Promise. So `for (const ep of episodes)` threw `TypeError: episodes is not iterable`, and
the export and re-embed paths were non-functional on the backend the system actually runs.

It presented as 30 red tests in two spec files. It looked exactly like the other 132.

`db.ts` performs the same unwrap **correctly**, gated on `adapter.capabilities` (`db.ts:371`,
`:894`). The codebase already knew the pattern; those two sites skipped it.

**What I would look at next on that basis**, in order:

1. **The "genuine assertion drift" cluster** (~25). A wrong *value* is the signature of a real
   defect; a `TypeError` is usually drift. This is the highest-yield place to find the next BL-377.
2. **Any remaining unchecked adapter cast.** `p0-adapter-integrity` filed **BL-379** for exactly
   this — "unchecked adapter casts still live in six production sites." That item and this handoff
   are describing the same class of bug; read it before starting.
3. **`backup.ts:171`/`:202`.** Distinct from BL-377 and deliberately excluded from it: those
   *explicitly* `createSqliteAdapter(...)`, i.e. sqlite-only on purpose rather than by accident.
   The open question is whether Turso stores can be backed up at all. **Unanswered.**

---

## 4. BL-367 — cross-backend recall parity. **UNRESOLVED. Biggest unknown in the project.**

`recall-parity.test.ts` compared `RecallResult.uid` across two independent stores. `memoryWrite`
mints a fresh `ulid()` per episode (`write.ts:301`), so two stores writing the same corpus share
**zero** uids. Overlap was **0 by construction** — the test could not have passed under any
behaviour of either backend. Nobody noticed because it also carried the frozen-`{skip}` bug (§6) and
had never executed.

So the correct statement is stronger than "this test never ran": **it would have proven nothing if
it had.** There has never been working cross-backend recall-parity coverage.

I corrected the comparison to use `content`. First honest measurement:

```
AssertionError: expected 0.52 to be greater than or equal to 0.8
  recall-parity.test.ts:230
```

**I did not lower the threshold, and you should not either.**

### The team lead asked two questions. Here is how far I got — I did not finish this.

**Q: recall-quality divergence, or harness artifact?** My read is **probably a real divergence**,
but I did **not** run the isolating experiment, so treat this as reasoning from the fixture, not a
measurement:

- Corpus is identical — the same `EPISODES` array is written to both stores.
- Queries are identical — the same `QUERIES` array.
- Embeddings are deterministic and identical — `beforeEach` installs
  `DeterministicTestProvider`, and `vitest.setup.ts` sets `SOX_SYNC_EMBED=1`.
- Both backends return results — the test `continue`s past any query where either side is empty,
  and `expect(queriesRan).toBeGreaterThan(0)` passes.

That rules out differing corpora, embedding non-determinism, and one-side-empty as explanations.
What remains is genuine retrieval/ranking divergence. **My leading suspect is the FTS/BM25 arm**
(cf. BL-347, dead FTS index; the Turso FTS dialect differs) — but recall fuses vector + BM25 +
temporal, and **I never isolated the arms**, so I cannot tell you which one diverges. That is the
experiment to run: query each arm separately against both backends.

**Q: is the 0.80 bar justified?** **My honest answer is that it was never validated.** The bar was
written together with the uid comparison, which means the author never observed the test pass — so
0.80 was never calibrated against a real passing run. I would call it **aspirational**, not
empirical. That said, "two backends agree on 52% of the top 5 for identical input" is a poor result
on its face regardless of where the bar sits, so I would not reach for re-calibration first.

**Hand-over:** the correctness-vs-test question is open. Nobody knows the answer yet. Do not let
this get quietly reframed as a threshold-tuning task.

---

## 5. Traps that cost me time

**The frozen-`{skip}` trap.** Vitest evaluates a test's options object during the *synchronous*
`describe()` collection pass, before any hook runs:

```ts
let hasTurso = false;
beforeAll(async () => { hasTurso = await tursoAvailable(); });   // too late, always
it('...', { skip: !hasTurso }, async () => { ... });             // frozen skip:true forever
```

The test is permanently skipped while reporting green. Two files had this — `recall-parity.test.ts`
and `heal-backend-agnostic.test.ts`, the only two dedicated cross-backend tests — since the day they
were written. Fixed in `15ff307` by resolving availability **synchronously at module load** via a
file-existence check on the driver.

Now guarded: **`sox/no-hook-assigned-skip`** (`tools/eslint-local/no-hook-assigned-skip.cjs`,
wired in `eslint.config.js`). Verified against the *real* pre-fix files at `15ff307^`, not just a
fixture. **Safe** patterns it correctly ignores: `throughput-golden.spec.ts` (5 sites),
`turso-clean-room.test.ts`, `embed.spec.ts`'s `it.skipIf(!RUN_REAL_EMBED)` — all resolve
synchronously at module load — and the 8 deliberate `it.skip` negative controls in `memory-core`.

**Lint patterns can silently exclude the files you care about.** `memory-server`'s `lint` target
covered only `src/**`, but its cross-backend tests live at the *package root*. The guard above would
not have covered the files it was written for. Fixed; filed as **BL-366**. The residual repo-wide
`lintFilePatterns` audit is **still open** — only `memory-server` was checked.

**A library build can compile your test files.** `store-adapter`, `blob-store` and
`claim-verification` excluded only `src/**/*.spec.ts`, not `*.test.ts`, so a type error in one test
file took down `store-adapter:build` and with it every downstream consumer — it blocked me for a
while on a file I had no reason to read. Fixed (BL-357); the audit landed at **3 of 21**
`tsconfig.lib.json` files affected.

**My own codemod bug, so you recognise the shape.** A position-driven await-fixer produced
`await x()[0]`, which parses as `await (x()[0])` — a different program that still typechecks, so the
error never cleared and each round appended another `await`, stacking 45 on one line. It shipped in
`9009fe7` and was repaired in `46d94af`. **A non-decreasing error count with a non-zero edit count
means the loop is looping, not converging.** I misread that signal for several rounds.

**Codemod scope discipline.** Extending the `raw()`→adapter sweep to bare `db.prepare(...)`
receivers took the suite **96 → 109**, because `enrich.spec.ts` and `cluster-subset.spec.ts` hold a
genuinely raw `new Database(...)` in a variable also called `db`. I reverted and used an explicit
receiver allowlist. Not every `db` is an adapter.

**`grep` is a shell function here** and returns nothing, silently, on a file containing a raw NUL
byte. Use `/usr/bin/grep` whenever you are proving something is **absent** (BL-371).

---

## 6. Two filed items that were actively misleading

Both are the same lesson: **an item's own severity or root-cause claim is not evidence.** Verify
before you plan around it.

**BL-323** claimed to be "very likely the dominant contributor to the ~266/267 pre-existing
memory-core test failures," and was a **P0 blocker** in the plan on that basis. The code was already
fixed and covered. I verified by *reintroducing the bug* rather than by inspection: the spec fails
2/3 with the original `TypeError` at `db.ts:372`, and passes when restored. Measured impact: total
failures moved 178 → 162, so **16 tests**, not the dominant contributor. Closed, lifecycle run.

**BL-342** asserts `tags = ''` breaks `memory_stats`. Measured with a per-column fixture: **it does
not** — `with_tags` only tests `tags IS NOT NULL` (`stats.ts:98`) and never parses. The column that
actually kills the tool is **`enrich_ver`**, at exactly the reported `stats.ts:120`
(`json_extract(enrich_ver, '$.note')`). An agent repairing only `tags` would have watched a
`json_valid(tags)` sweep come back clean and reported success while the tool stayed dead — and the
sweep quoted *in the item* would have corroborated the wrong conclusion. BL-342 now carries a
warning banner; it remains open for its two real defects (restore path not normalising, no schema
guard). **Data repair belongs in the adapter's verify-and-repair path (BL-352), never a manual write
to `~/.memory/*`.**

Practical consequence of BL-343 landing: `memory_stats` now **reports** the true column list and
rowids via `malformed_rows: { count, columns, sample_rowids }`. Run it on the live store instead of
writing another bespoke `json_valid()` sweep.

The general principle BL-343 encodes, worth carrying into other aggregates: **if you make something
skip a bad row, you must count and report it** — otherwise you have traded a loud failure for a
quietly wrong number, which is worse.

---

## 7. What landed (all committed)

| Item | Commits | State |
|---|---|---|
| BL-340 `typecheck-tests` targets | `ed424ec` | Landed, `memory-core` + `memory-server` |
| BL-325 spec async/adapter drift | `ff40e25` → `46d94af` | **Partial** — 265 → 87 failures |
| BL-324 memory-server | `42aa5aa`, `e614aef` | **Partial** — 9 → 3 |
| Frozen-`{skip}` + lint guard | `15ff307`, `68f9437` | Done; BL-366 residual audit open |
| BL-357 lib builds compiling tests | `1289a1d`, `beb6ead` | Done, audit complete (3 of 21) |
| BL-343 row-level resilience | `fbdd7fb`, `723ec1d`, `2c02a1e` | Done, in CHANGELOG |
| BL-323 verify + close | `2c02a1e` | Closed, in CHANGELOG |
| BL-377 export/reembed on Turso | `5b5dddc`, `2aba21c` | Fixed |
| BL-367 recall parity | `8f9de23`, `42aa5aa` | **OPEN — see §4** |

`ed424ec` note: `memory-core:typecheck-tests` was intentionally **red** at that commit — that is
BL-340's stated acceptance condition while BL-325 is unfixed.

### Conventions I followed, please continue

- `git diff --cached --name-only` **must be empty** before staging. Multiple agents share this
  checkout; I twice found another agent's work in the tree and once staged. Stage explicit paths
  only — never `git add -A`/`.`/`-a`.
- `node tools/check-backlog-markers.mjs` and `node tools/check-no-nul-bytes.mjs` before every commit.
- Allocate BL ids programmatically as `max(existing)+1` (BL-359 — three collisions in one afternoon).
- Never mark RESOLVED without a red→green you personally watched fail and then pass.
- The live `memory-server` runs off
  `extensions/bundles/sox-memory-bundle/members/memory-server/dist/`. I fixed `src/index.ts`
  (BL-324's `linkChunksToParent` floating promise) and **deliberately did not rebuild**. That fix is
  **not deployed.**
