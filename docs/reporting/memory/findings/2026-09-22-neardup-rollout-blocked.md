# Near-dup rollout — fix PROVEN LIVE, registry sync BLOCKED on a release (2026-09-22)

**Date:** 2026-09-22 · **Repo:** `sox-ecosystem`, MAIN checkout, branch `main` at `668ded42` or later.
**Supersedes on two points:** [`2026-09-22-neardup-deploy-handoff.md`](./2026-09-22-neardup-deploy-handoff.md)
§4 traps 1 and 9 — see §3 below. Everything else in that document still stands; read it first.

---

## 1. The near-dup fix is PROVEN IN PRODUCTION

Not merely deployed — **behaviourally proven**, which the prior session could not do.

Two throwaway episodes were written to the live store and the outcome read back from state:

| | |
|---|---|
| Probe A | `01M355EKV4FGH53BNGD338JNB7` (t_created 18:18:34.725Z) |
| Probe B | `01M355EMQY0GNJ0Z35QRRSBFNP` (t_created 18:18:35.646Z) |
| Edge | `SAME_AS`, weight **0.9940454794499297** |
| A `t_invalid` | `null` · `is_current: true` |
| B `t_invalid` | `null` · `is_current: true` |
| `near_duplicates` total | 685 → 686 (+1, fully explained by the probe pair) |

Both halves of the pass condition hold: **a `SAME_AS` edge landed AND neither node was invalidated.**
Verified independently by the dispatcher via `memory_supersession_chain` and `memory_related`, not
taken from the probe agent's report.

**Scope limit:** this exercises only the **ASYNC** near-dup path. The sync-embed path
(`SOX_SYNC_EMBED`) remains **test-covered only** and is NOT proven live.

The two probe episodes were deliberately left in the store. Remove them when convenient.

Artifact identity re-confirmed by hash (not liveness): `memory_ping.artifact` ==
`shasum -a 256 …/memory-server/dist/index.js` ==
`sha256:e21b802d6dfb9bc57f89fd7b1d3370f39367eeeb49bec47d61200cc161263eb9`.

---

## 2. ⛔ The registry sync CANNOT be completed as the prior handoff describes

The prior handoff lists `npx nx run registry:sync-index` + commit as a mechanical close-out step.
**It is not.** Doing it correctly requires a Changesets release. Evidence:

- `memory-server` is `1.3.3` locally AND `1.3.3` on npm (`npm view @adhd/sox-extension-memory-server
  version` → `1.3.3`), but with **different bytes**. `.changeset/` holds no pending changeset.
- `registry/index.json` names `source: npm-package:@adhd/sox-extension-memory-server@1.3.3` with
  checksum `sha256:4ea748…` (the pre-fix artifact). The live artifact is `sha256:e21b802d…`.
- The fixed artifact was **never published**. Syncing the checksum alone makes every npm-locator
  install fetch the pre-fix tarball and trip `CHECKSUM MISMATCH` (ADR-0005 §1).
- Therefore the compliant path is: **changeset → version bump → build → `registry:sync-index` →
  commit source+registry together → restart + hash-verify → smoke → `soxe upgrade --all`.**
  Per `PUBLISHING.md`, never a hand-bump, never a bare `npm publish`.

### 2.1 Two traps discovered the hard way on the sync itself

**TRAP A — `npx tsx scripts/build-index.ts` is NOT a drop-in for the nx target.**
The committed registry is generated WITH the publication signal `SOX_REGISTRY_PUBLISH=npm`
(`PUBLISHING.md:202`; `package.json:16` → `build-index:publish`; the branch is
`scripts/build-index.ts:282-295`, `:430`). Running the bare script without it emitted
**31 entries instead of 6**, flipped every `source` from `npm-package:…` to
`file:///Users/nix/…`, and moved three unrelated checksums (`memory-cli`, `memory-flush`,
`sox-cli`). A stop-gate caught it and the file was restored with `git restore registry/index.json`.
**If you must bypass the nx target, you MUST carry `SOX_REGISTRY_PUBLISH=npm`.**

**TRAP B — `builtFromCommit` is run-time provenance, NOT build attestation.**
`build-index.ts:476-477` stamps HEAD at index-RUN time. Because bundles **inline** their workspace
deps, that is truthful only while HEAD still matches the source the artifact was built from.
Observed live: HEAD advanced `8b26679f` → `d4160578` → `668ded42` (sox-telemetry and
embedding-provider — **both inlined into the memory-server bundle**) while the live dist predates
both. So a **CLEAN** run now produces an **UNFLAGGED WRONG** record — strictly worse than the
`provisional: true` a dirty run would have flagged.
**Rule: commit the registry while HEAD still matches the source the artifact was built from.
Anything that touches an inlined package invalidates it — rebuild + re-sync after.**

Nothing gates on `provisional`/`builtFromCommit`: the sole reader
`scripts/check-registry-sync.ts:266-273` only `console.warn`s (no non-zero exit), and
`stripProvenanceFields` (`:249-257`) removes both before drift comparison. Verified from source.

---

## 3. ⛔ CORRECTION — the `-tshm.stale-*` rotation is NOT a defect

**The prior handoff's traps 1 and 9 misattribute it to a split build. That attribution is WRONG
for this symptom.** Do not re-walk it.

It is the **designed success path**: `resetTshmAfterTruncate()`
(`libs/data/store/store-adapter/src/turso-adapter.ts:3260-3305`, rename at `:3297`) renames the
`-tshm` whenever `wal_checkpoint(TRUNCATE)` **succeeds**, driven by the 30s gated idle flush
(`libs/data/store/store-adapter/src/wal-tuning.ts:43`, `DEFAULT_IDLE_FLUSH_CEILING_MS = 30_000`).
It is bounded by the BL-591 retention sweep (`sidecar-retention.ts:34,45,58` — keepRecentN=20,
maxAge 3d, throttle 10min), invoked at `turso-adapter.ts:3340`.

Evidence it is not a split build: all 17 post-restart `close_tshm_reset` events carry
`"pid":99483` — one uninterrupted backend — and **zero** `E_FOREIGN_SQLITE_SIDECAR` events appear
in today's service log. `lsof` shows exactly ONE holder of the store (99483); wrappers 21545,
64743, 34888 hold no handle.

**Steady state is 20-26 stale files, ~2 MB.** A count of "91" is a count of ALL files in
`~/.memory`, not of stale sidecars — measuring the wrong thing produced a false alarm this session.
`~/.memory` is 5.5 G of which `backups/` is **4.6 G**; the sidecars are ~0.04% and are not the disk
problem.

**Anticorrelation worth knowing:** rotation and enrichment-pass failure are **mutually exclusive
branches**, not one cause. `resetTshmAfterTruncate` runs ONLY when TRUNCATE succeeded, so the
minutes carrying `close_checkpoint_busy` / `database is locked` (18:13, 18:14, 18:15, 18:18) have
**zero** resets.

**BL-393 negative evidence:** its doctor-tick duplicate-backend self-heal is NOT active in the
18:08–18:25Z window — zero `singleton`/`doctor`/`sigterm`/`self_heal`/`reap` events in today's
service log, no backend start banner after 18:08. BL-393's open question ("what spawns duplicate
backends") remains open but is not what was observed here.

---

## 4. The genuinely consequential findings

**P0 — `tools/plan-status.mjs` sends a filter shape the current backlog CLI rejects.**
Its argv (`:172-186`) uses `filter: {repo, family, excludeArchived, status}`; `@adhd/backlog` 1.0.0
rejects `repo`, `family`, `excludeArchived` as `additionalProperties`:
`{"code":"invalid_argument","message":"Validation failed: /data/input/filter must NOT have
additional properties"}`. The script then maps ANY non-zero exit to
`STORE UNAVAILABLE — backlog query failed (offset=0)` (`:206-215`), which is **actively
misleading** — the store is healthy (`backlog version` → `{"name":"@adhd/backlog","version":"1.0.0"}`).
**Commits are NOT blocked** (the pre-commit hook announces an advisory self-downgrade by design;
`8b26679f`, `d4160578`, `668ded42` all landed today) — the real consequence is that **no commit
gets PLAN.md/STATE.md drift actually verified.**
The fix must NOT simply drop the filter: a bare `{"view":"list"}` resolves a **shared** graph of
~1683 items and returns foreign-repo rows (adhd apigen/dispatch-spec). Port the filter to the
current schema spelling, and split `invalid_argument` from unreachable-store in the error mapping.

**WAL cap overshoot under lock contention — rank ABOVE the sidecars.**
`store_adapter.turso.wal_cap_flush_busy` fired 3x in 70s with `wal_bytes_at_trip` of
1,141,272 / 972,352 / 1,001,192 against `cap_bytes: 262144` — a **4x overshoot** — each refused with
`"step failed: Runtime error: database table is locked"`. Contention is between the backend's own
connections (enrich child + write path). Degrades write latency and will surface as user-visible
`E_BUSY`. **Cross-link `697491ef` (E_BUSY, still OPEN despite being marked refuted) — this may be
its real mechanism.** Source: `…/memory-server/logs/memory-server.live-service-2026-09-22.jsonl`
at 18:18:02.585, 18:18:36.112, 18:19:11.350.

**A classic-SQLite engine is opening the live store.** turso never creates a classic `-shm`
(`wal-ownership.ts:173-175`), so the 4 `-shm.stale-*` renames today prove a better-sqlite3 /
stock-sqlite opener. `reconcileForeignSqliteShm()` (`wal-ownership.ts:203-236`, rename `:227`) logs
the rename but records **nothing about who created the file**. Ranked candidates, NOT proven:
(a) an agent shell running the **banned** stock `sqlite3` probe — a live zsh (pid 77991) was
observed running `sqlite3 -readonly "$HOME/.memory/memory.db" "SELECT … FROM edge WHERE
rel='SUPERSEDES' …"`; (b) a `deleteSchemaRowsViaBetterSqlite3` FK/FTS-heal hatch in the backend.
Proposed: log the `-shm` inode ctime/uid on the reconcile path so the opener is attributable.

**Minute-precision `.stale-` stamps clobber same-minute artefacts** via `renameSync` onto an
existing target. The fix is a **coupled triple** — `turso-adapter.ts:3296`, `wal-ownership.ts:226`,
and the retention parser/pattern at `sidecar-retention.ts:134,159` must change **together**, or
retention breaks entirely, which is the unbounded-growth failure BL-591 fixed.

**`scripts/build-index.ts` has no per-extension scope.** The BL-390 dirty gate is repo-global, so
one agent's uncommitted edit in ANY checksum-relevant inlined path forces `--allow-dirty` and
stamps EVERY entry provisional. See also TRAP B (§2.1) — ADR candidate.

---

## 5. Still open — carry forward

- **Registry sync blocked on a Changesets release** (§2). The artifact itself is live and
  hash-verified; the registry is knowingly stale at `4ea748…`.
- **Smoke test still unrun.** `rm -rf dist/smoke && node scripts/smoke-test.mjs`, `summary.failed === 0`.
  It **never builds** — it exits 2 with a "Build first" FATAL if artifacts are missing
  (`scripts/smoke-test.mjs:773-783`), and pins `SOX_CONFIG_DB_PATH` to a scratch DB with
  `scope: project` only, so it cannot reach `~/.memory`.
- **Q4 entity-episodes branch UNMERGED** — worktree `worktree-agent-af7488fb15a0480d8` at `d294f0a3`,
  5 commits, green on turso AND sqlite, 3 blind-review rounds. **Merging it is not free:**
  `memory-core` is inlined into the bundle, so landing it makes the registry stale by definition and
  mandates rebuild + re-sync + **restart pid 99483 + re-verify by hash** in the same operation.
- **Chunk inheritance STILL UNFIXED** (`29f3a4d5`) — 1,709 episodes with no topic, 4,602 with no
  tags, structurally unreachable by topic-/tag-filtered recall (`recall.ts` uses `n.topic = ?` and
  `json_each` over tags; neither matches `NULL` or `[]`).
- **Recovery of the 685 NOT STARTED.** Owner approved: build the tool, dry-run, SAMPLE, then assess.
  `memory_curate` op `restore_neardup`; **backup FIRST**; **LEXICAL triage (Jaccard/LCS), never
  cosine and NEVER by age** — the age rule is what destroyed 260 parent documents;
  `meta.restoredFrom` for reversibility; component-wise over the `SAME_AS` graph. 255 of 260 killed
  parents still have all chunks live, so text survives in fragments; parent nodes, topics, tags and
  3,273 edges do not. 132 pairs have BOTH halves invalidated. `gcOrphanedCommunityState` tore down
  community state that clearing `t_invalid` will NOT restore. **685 is a FLOOR** — 28 more kills
  exist whose `SAME_AS` edge was cascade-deleted.
- **memory-server graceful-stop window insufficient** — `kill -TERM` did not stop the backend within
  `SOX_CONFIG_STOP_TIMEOUT_MS=5000`; alive and in R state ~15 s later. WAL replayed on restart
  rather than cleanly checkpointed at exit. No harm resulted. Lead for the service-lifecycle owner.
- **`typecheck-tests` not in CI and already red** (BL-490). **`sox-telemetry` missing from the
  commitlint scope enum.**
- **MCP transports down this session:** `backlog` (CONNECTION_CLOSED), `agent-mcp`, `search`
  (CONNECT_TIMEOUT), `gitnexus` (dropped mid-session). **The backlog CLI is unaffected and works** —
  use it directly.
- **Docs still describing the old semantics:** `memory-server/CLAUDE.md:367`,
  `libs/memory-core/README.md:240-245`, `docs/plan/memory-enrichment/CONTRACTS.md:308`,
  `docs/plan/memory-refactor/contracts/analysis.ts:96`.
- **`NOTES.md` items 6-11 untriaged.** One unexplained, non-reproducing test failure.

---

## 6. Process notes that paid off — keep them

- **Blind review** (diff + the word "Review", no context) found a real defect every round last
  session, including two the fixes themselves introduced.
- **Verify every subagent claim from git/tests/state, never from its report.** Applied this session
  to the probe (PASS confirmed independently) and to the architect verdict (its load-bearing claim
  about `provisional` was re-grepped from source before acting).
- **Put a STOP-GATE in every dispatch brief that changes a generated file.** The registry corruption
  in §2.1 TRAP A was caught by nothing else.
- **`check-suite-tree-state` is a SNAPSHOT, not a lock** — a 12-minute suite straddled four commits
  and its result was unattributable.
- **Piping `nx` through `tail` reports tail's exit code.** A red suite read as "exit 0".
- **The stock `sqlite3` CLI CANNOT open this store** (Turso FTS objects → `malformed database schema
  … near USING`). Use `@tursodatabase/database` `connect(path,{readOnly:true})` on a **COPY**.
- **backlog:** `create` has no citations field (use body prose); `query --text` reports `total` as
  **CORPUS SIZE**, not match count; the backlog SKILL doc documents a verb surface the binary does
  not have; and this store **reassigns an item's UID on every body write** — resolve by content
  before citing a UID.

---

## 7. ⛔ The dispatcher does not release — it dispatches

Recorded here as a standing constraint for whoever picks this up, and as the explicit reason the
registry sync in §2 was **not** executed by the dispatcher this session.

**The dispatcher may not directly perform a release, a build, a deploy, or a service restart.**
It decomposes the work, assembles the brief, dispatches an executor, and then verifies the outcome
from git / tests / live state. It never runs the release itself, however small the step looks.

This applies specifically to every step of the rollout sequence:

- `npx nx build <project>` / `run-many -t build` — **dispatch it.** A build `rm -rf`s `dist/` first
  (BL-235) and can destroy a live artifact that cannot be restored.
- `npx nx run registry:sync-index` / `scripts/build-index.ts` — **dispatch it**, with a stop-gate on
  the diff. This session proved why: the bare script without `SOX_REGISTRY_PUBLISH=npm` silently
  produced a corrupt 31-entry registry (§2.1 TRAP A).
- Changesets version bump / `npm publish` — **dispatch it**, per `PUBLISHING.md`. Never hand-bump.
- `soxe service enable|disable` / any restart of a live service — **dispatch it**, paired with the
  rebuild in the SAME operation, and verify adoption by hash afterwards (BUG-028).
- `node bin/soxe upgrade --all` — **dispatch it.**

What the dispatcher MAY do directly: read-only verification. `git log/diff/status`, `rg`, `shasum`,
`lsof`, `ps`, reading files, and read-only MCP calls (`memory_ping`, `memory_stats`,
`memory_supersession_chain`, `memory_related`). Reading state to check an executor's claim is the
dispatcher's core job and is never delegated.

**Corollary — the dispatcher does not edit its own agent definition.** Changing the dispatcher's
governing spec is a change to the operator's system prompt. It requires the operator's explicit,
unambiguous instruction naming that file, and it is made in the agent-catalog source
(`claude-agents/categories/dispatch/agents/dispatcher.md`), never in an installed plugin cache copy,
never inferred from a loosely-worded request.
