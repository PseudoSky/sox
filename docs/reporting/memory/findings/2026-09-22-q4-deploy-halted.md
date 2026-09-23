# Q4 deploy + 604 restore — HALTED before restart

Date: 2026-09-22 · Agent: devops-engineer · Branch: main
Analysed at `20d817a7`; HEAD at send time is `e1fbc538` (two commits landed mid-session — see §2, §3).

## Verdict

**Did NOT restart memory-server. Did NOT run the 604 restore.** Both are blocked by
facts on disk that the dispatch brief did not have. The live service still runs
pid 93638 / artifact `564840c4…`, untouched.

## 1. Merge window — the brief's oracle was wrong

`origin/main` (`8eda2358`) is **5 commits BEHIND** local `main` (`20d817a7`); local HEAD is a
strict superset (`git rev-list --left-right --count origin/main...HEAD` → `0  5`).
Checking `git log origin/main` would therefore MISS anything merged locally but unpushed.
Correct oracle: `git merge-base --is-ancestor <commit> HEAD`.

| Fix | Commit | In main? |
|---|---|---|
| recall degradation (BL-391) | `31888bcc` | **yes** |
| Q4 entity-episodes live rows | `568d31cd` | **yes** |
| near-dup auto-invalidation stop | `5c35a66a` | **yes** |
| chunk inheritance | `7fb2a200`, `aaf5772d` | **NO** (worktree `a8327434231d7047d`) |
| enrich budget bump to 300_000 | — | **NO** (`300_000` appears only in test files; `enrich-isolation.ts:121` and `embed-pipeline.ts:193` are still `120_000`) |

Proceeded without chunk-inheritance, as instructed.

## 2. registry/index.json — the hash MOVED, and that is correct

`042973a07cc42c56…` at session start → `6c828201dc7c5d9fbd923e6c26e69e9898601debcca7f2470bce56af6179f013` now.

The brief made a moving hash a STOP condition. Investigated: `git diff HEAD -- registry/index.json`
is **clean**. The move is commit `20b3d1e7` "chore(registry): repin sox to published 1.2.2 bytes",
landed mid-session by the release agent. This is a legitimate committed repin to PUBLISHED npm
bytes — not a stray `sync-index` regeneration. **`304513c4`'s pinning is intact.**

I did NOT run `registry:sync-index`, per the brief — it regenerates checksums from local disk
bytes and would have destroyed exactly that pinning.

## 3. THE BLOCKER — `nx build memory-server` would bake unauthored edits into the live store

`tools/check-suite-tree-state.mjs --project memory-server` reports **DIRTY**, 4 paths inside
the dependency set (14 projects):

```
 M libs/data/store/store-adapter/src/fts-ops.ts
 M libs/memory-core/src/recall.ts
?? libs/data/store/store-adapter/src/__tests__/turso-fts-quoted-query.bug-quote-escape.test.ts
?? libs/memory-core/src/recall-provider-call-count-invariant.spec.ts
```

`related.ts` **merged mid-session** as `e1fbc538` ("filter invalidated neighbours before LIMIT
in memoryGetRelated") and is no longer contamination. `recall.ts` now carries
`.changeset/recall-provider-call-count-empty-corpus-fix.md`, so it too is mid-merge — **the
dependency set may be clean shortly**, which is the fact that decides retry-vs-replan.
`nx build memory-server` runs `^build`
(`dependsOn: ["^build"]`), which rebuilds `memory-core` from this dirty source — pushing
another agent's mid-review work into the live memory store's read path. That is BL-456,
and the BL-235 staging swap does not protect against it: staging only guarantees
"`<outdir>` untouched **on failure**". A *successful* build of unvetted source swaps in fine.

## 4. The Q4 fix cannot be delivered cleanly from this checkout

I bundled to a scratch outdir (bypassing `^build`, so live `dist/` was never touched):
probe `3be50b43…`. Result — a **half-fix**:

- `invalidated_count` × 3 in the probe, but all from `memory-server/src/index.ts` (the entry,
  compiled from source) — the MCP *surface*.
- `tsconfig.base.json:37` maps `@adhd/sox-memory-core` → `libs/memory-core/**dist**`, and
  `libs/memory-core/dist/entity-episodes.js` was built **21:21:42** while the Q4 commit landed
  **21:24:31**. The dist is stale by ~3 min and contains none of the live-row filtering.

So the probe exposes the field without the implementation behind it. Shipping that is worse
than shipping nothing. Delivering real Q4 requires rebuilding `memory-core` — which from this
tree means contaminating it per §3.

## 5. The restore is impossible — `restore_neardup` is not merged and not even committed

Worktree `agent-a859d261541f17488` HEAD is `3218573b` ("chore(ci): alphabetize commit
scopes"), which IS in main but is only a CI-docs commit. The op itself is **uncommitted**
there:

```
 M extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts
 M libs/memory-core/src/curate.ts
?? libs/memory-core/src/restore-neardup.ts
?? libs/memory-core/src/restore-neardup.spec.ts
```

`restore_neardup` appears nowhere in main source outside `docs/`. It cannot be in any
artifact built from main, so the 604 restore cannot run. Per the brief, I did not merge it.
**This removes the urgency premise**: the only remaining payoff from a restart was Q4, which
§4 shows is not cleanly available. No store backup was taken because no write was attempted.

## 6. HEADLINE FINDING — the live artifact contains code that exists in no commit

`libs/data/store/store-adapter/src/fts-ops.ts` is **uncommitted**, and its quote-strip is
already compiled into the running artifact `564840c4` (`t.replace(/"/g` × 2 in both live and
probe). The live `memory-server` is therefore **not reproducible from any commit in this repo**.

This is not a cosmetic drift. That diff's own comment records a production incident: Turso's
Tantivy parser rejects the triple-quoted token that `buildMatchQuery` emits, so
**the BM25 arm silently returned zero rows for any recall whose query contained a double
quote** — caught by recall.ts's BL-391 handler and downgraded to an `fts:` degradation
(observed live, pid 99483, 2026-09-22T19:57:59Z). The fix is real and is running; it just
isn't committed. If anyone rebuilds from a clean tree, **the fix silently disappears from
production.** This needs an owner.

## 7. LIVE OUTAGE discovered at close — memory-server has zero running processes

Not caused by this session: `dist/index.js` is still byte-identical at
`564840c4…`, and no restart was ever performed.

```
soxe service status memory-server
  loaded:     yes
  owner:      os-unit
  live pids:  (none)
  entrypoint: .../memory-server/dist/index.js
```

`memory_ping` → `backend unavailable`. `ps`/`pgrep` show no node process on the artifact.
The launchd unit is loaded but nothing is running.

**The plist trap the brief warned about does NOT apply.** I did not re-enable the service, so
the unit file was never regenerated, and its env block is intact:

```
SOX_CONFIG_DB_PATH   /Users/nix/.memory/memory.db
SOX_CONFIG_PORT      3099   ·   SOX_CONFIG_HTTP_PORT 3099
SOX_CONFIG_STOP_TIMEOUT_MS 5000   ·   SOX_SERVICE_ID memory-server
```

Recovery is **safe and does not deploy anything new** — the on-disk artifact is the same
`564840c4` that was blessed and running, so `soxe service restart memory-server` restores
service without shipping a single unreviewed line. I attempted exactly that and it was
**blocked by the auto-mode permission classifier as a "Production Deploy"**. I did not work
around it. This needs a human green-light; it is a one-command fix.

Episode count was NOT captured — the store is only reachable through the server, which is down.

## Backlog filed

- `995b5fe4-167c-4d8a-8db3-ab95e007a2ac` — live artifact contains uncommitted `fts-ops.ts` (§6)
- `8412f6a8-e861-47b0-93e6-8d170a32f743` — stale `libs/*/dist` degrades bundles to a half-fix (§4)

## Recommended next step

**First: get the service back up** (§7) — one `soxe service restart memory-server`, no new code.

**Then: do not rebuild-and-transplant right now.** With the restore off the table, the only payoff is
`invalidated_count` on one MCP tool, and buying it means a clean-worktree build + `pnpm install`
+ a `dist/` transplant while the release agent holds `package.json`, `PUBLISHING.md`, and
`scripts/build-index.ts` modified. Bad trade.

Preferred: **wait for `recall.ts` to merge** (its changeset exists), which likely leaves the
dependency set clean, then `npx nx build memory-server` becomes legitimate and Step 2–4 run as
the brief intended. Separately, `fts-ops.ts` (§6) needs an owner before anyone builds from clean.

A restart is ~2 minutes whenever green-lit: the pre-restart artifact is backed up at
`…/scratchpad/memory-server-dist-564840c4/` (verified `564840c4…`), so the swap is reversible.

Citations: [main@20d817a7, devops-engineer, claude, Q4-deploy]
1: tsconfig.base.json:37
2: libs/memory-core/src/entity-episodes.ts
3: libs/memory-core/src/related.ts
4: libs/data/store/store-adapter/src/fts-ops.ts
5: tools/bundle-extension.cjs:348-365
6: extensions/bundles/sox-memory-bundle/members/memory-server/project.json
7: libs/host-runtime/src/loader.ts:491

---

## 8. PRE-FLIGHT: restore scope measured independently from the store (read-only)

Taken while holding for `restore-land`, from a COPY of `~/.memory/memory.db` opened
`readOnly` via `@tursodatabase/database` (server was down, `memory.db-wal` 0 bytes, so the
copy is clean). The stock `sqlite3` CLI was never used.

**Baseline:**

| metric | value |
|---|---|
| live episodes | **7058** |
| invalidated episodes | **852** |
| total episodes | 7910 |
| rows carrying `meta.restoredFrom` | **0** |

`restoredFrom = 0` independently confirms the brief's claim that `restore_neardup` has
never been applied anywhere. It also means the post-apply authorship check (step 5c) starts
from a clean zero — any row bearing `restoredFrom` afterwards is unambiguously ours.

Note the live count is **7058**, not the ~6,882 the brief cited; agents have been writing
throughout. Use 7058 as the pre-restore baseline, and expect `7058 + 604 = 7662` after.

**The expected dry-run partition reconciles EXACTLY against the store:**

```
604 planned + 3 withheld + 82 true-duplicates + 163 out-of-scope = 852 = invalidated total ✓
```

Measured directly:

| partition | measured | expected |
|---|---|---|
| invalidated WITH a live `SAME_AS` edge (= policy scope + true-dups) | **689** | 607 + 82 = 689 ✓ |
| invalidated WITHOUT a live `SAME_AS` edge (out of scope) | **163** | 163 ✓ |

The brief's phrase "163 edge-less invalidated episodes" means *lacking the near-dup
`SAME_AS` edge*, NOT literally edge-free — only **3** invalidated episodes have no edges of
any kind. Worth fixing in the vocabulary before someone greps for the wrong thing.

**⚠️ ONE NUMBER DOES NOT RECONCILE — resolve before applying.** The brief expects **3**
withheld, "each carrying a live SUPERSEDES edge = recorded human intent". Measured within
the in-scope `SAME_AS` set:

| | count |
|---|---|
| in-scope AND carries a live `SUPERSEDES` (either direction) | **6** |
| …as SRC (it supersedes something) | 2 |
| …as DST (it is superseded by something) | 4 |

**6, not 3** — and no directional split yields 3 either. Caveat: this is my approximation of
the op's scope rule, not the op's own logic (it is unmerged, so I have not read it). The op
may scope more narrowly (e.g. requiring the surviving twin to be live, or a similarity
threshold), which would legitimately reduce 6 → 3.

Consequence for step 5d: if the dry run reports `withheld: 3`, that is NOT self-evidently
correct — there are 6 in-scope rows carrying recorded human intent, and the 3 not withheld
would be **restored despite a live SUPERSEDES edge**. Reconcile which rule is right BEFORE
`dry_run: false`. The 604/163/689 figures are confirmed and can be trusted.

Citations: [main@bb4ec0a8, devops-engineer, claude, Q4-deploy, 8: ~/.memory/memory.db (read-only copy), 9: docs/ops/memory-server-playbook.md]

## 9. The 6-vs-3 withheld question — RECONCILED, no divergence

Resolved by reading `libs/memory-core/src/restore-neardup.ts` after it landed (`4903f76c`).
My measured 6 and the op's reported 3 describe the same reality:

1. **The op counts DST only** (`:375-382`): it joins `node n ON n.rowid = e.dst`, i.e. nodes
   superseded BY something, with `e.t_invalid IS NULL AND e.t_expired IS NULL`. My 2 SRC rows
   (rows that supersede something else) are correctly NOT withheld — superseding something is
   not a statement that you wanted *this* row deleted. **6 → 4.**
2. **Guard ORDER** (`:937-938`): `withheld_true_duplicate` is evaluated BEFORE
   `intent_superseded`, so a row that is both is counted under the former. The counters
   partition rather than overlap. That accounts for the 4th. **4 → 3.**

Independently: applying the op's exact predicate to my 689-row `SAME_AS` set yields 4, and
policy scope is 607 (689 − 82 true-duplicates), leaving 3 in scope. Matches the op's own
comment ("3 of the 607 policy-scope members carry one").

**Conclusion: none of the 6 is restored despite recorded human intent.** The 2 SRC rows were
never in scope; the 4th is withheld under a different label. The alarm in §8 is retracted.

Two accountings must BOTH hold at dry-run time before applying:
- the op's own invariant: `planned + withheld_intent_superseded = policy_scope_members` (604 + 3 = 607)
- my store-derived partition: `604 + 3 + 82 + 163 = 852` = total invalidated episodes

## 10. Vocabulary correction worth propagating

"163 edge-less invalidated episodes" means **lacking a live `SAME_AS` edge**, NOT edge-free.
Only **3** invalidated episodes have no edges of any kind. Anyone grepping for literally
edge-less rows will find 3, match the expected withheld count by coincidence, and believe
they have found the withheld set. They have not.

## 11. Expected-count drift

The brief's ~6,882 baseline is stale; live episodes measured **7058**. A hardcoded
expected-count assertion would fail here for the wrong reason. Expect **7662** after a
604-row restore.

**A SUB-604 APPLIED COUNT IS SUCCESS, NOT FAILURE — do not misread it.** `restore-land`
measured `members_already_live: 558`: of the 689 `SAME_AS` population, 558 were already live
at 21:54. If further rows go live between measurement and apply, the `already_live` guard
absorbs them and the applied count lands BELOW 604. An apply reporting e.g. "587 restored +
17 already_live" — or even "restored 46" — is the guard working exactly as designed to make
a re-run non-double-restoring. **The field that signals a real problem is `notWritten`, which
must be empty.** Anyone comparing the applied count against a hardcoded 604 will conclude the
op failed when it succeeded.

## 12. Why commits are blocked (the real cause — NOT the restore commit)

Commits fail in `.husky/pre-commit`'s `npx nx affected --target=lint`, with 13
`@nx/enforce-module-boundaries` errors ("Static imports of lazy-loaded libraries are
forbidden", naming `store-adapter`) in files such as `tools/rehearse-live-vacuum.mjs`.

**The cause is a lint COVERAGE GAP, not the restore op.** A `sox-ecosystem:lint` target was
created tonight; `nx run-many -t lint` previously covered none of `scripts/` or `tools/`, so
these violations are pre-existing and are surfacing on the target's first run. They belong to
the agent who owns `scripts/`/`tools/`.

`4903f76c` (the commit carrying the 604 restore) is NOT responsible. Its shape is suggestive —
it adds `await import('@adhd/sox-store-adapter')` at `restore-neardup.ts:489` with a type-only
static import at `:146` — but the rule names `scripts/generate-test-store.mjs` and
`scripts/migrate-store-to-turso.mjs` as the lazy-loaders, and `4903f76c` touches neither.
Verified: it changes exactly 5 files (`restore-neardup.ts`, `restore-neardup.spec.ts`,
`curate.ts`, `memory-server/src/index.ts`, `.changeset/restore-neardup-curate-op.md`).

Recorded because the wrong attribution would send the next reader to audit the one commit
carrying the restore.

## 13. Deploy status: BLOCKED ON PERMISSIONS, nothing applied

Both actions are user-approved yet DENIED in this agent's session:

```
soxe service restart memory-server   → DENIED  [Production Deploy]
npx nx build memory-core             → DENIED  [Modify Shared Resources]
```

The classifier gates the session that RUNS the command. The approval was given in the
dispatcher's session and relayed as a message, which is not an approval token for this one.
Unblocking requires a settings Bash rule (`npx nx build *`, `node bin/soxe service restart *`)
or the user running the two commands.

**Having a peer agent run it instead was deliberately NOT done** — that launders a permission
decision this session was denied.

State at time of writing: live artifact `564840c4` unchanged, service down (zero live pids),
`restore_neardup` absent from the running artifact, store untouched, no backup needed because
nothing was written.

**Both** `memory-core` and `memory-server` must be rebuilt — memory-server inlines memory-core
through the `dist` alias (`tsconfig.base.json:37`). Rebuilding only the bundle reproduces the
§4 half-fix. Verify Q4 BEHAVIOURALLY via `memory_related` / `memory_entity_episodes`, never by
grepping the artifact for `invalidated_count`.
