# Near-dup invalidation — deploy state, traps, and open threads (2026-09-22)

**Date:** 2026-09-22 · **Repo:** `sox-ecosystem`, MAIN checkout, branch `main` at `a1b50621` or later.
**Scope:** what shipped to source, what is (and is not) live, what the next agent must do, and the
traps this session paid for.

> **Measured vs. conjecture.** Every number in §1 was measured against a read-only copy of
> `~/.memory/memory.db` and is recorded in full in the two committed analyses below. Where a claim is
> inference rather than measurement it is labelled **CONJECTURE** inline. Nothing in this document
> asserts a deploy outcome — see §3.

**Full evidence, already committed (`092afdcc`) — do not restate their numbers, read them:**

| Doc | Contents |
|---|---|
| [`2026-09-22-neardup-algorithm-analysis.md`](./2026-09-22-neardup-algorithm-analysis.md) | Loss accounting over all 685 pairs, attribution rule, embedding-geometry investigation |
| [`2026-09-22-neardup-invalidation-fix-plan.md`](./2026-09-22-neardup-invalidation-fix-plan.md) | The fix design that shipped |

---

## 1. The defect — confirmed and measured

memory-core's automatic near-duplicate pass invalidated the **older** node of any pair at
cosine ≥ 0.95, recording no reason and creating no `SUPERSEDES` edge. Root cause:
`applyNearDupResult` (`libs/memory-core/src/enrich.ts`) issued a bare `UPDATE node SET t_invalid = ?`.
Downstream, `memoryGetSupersessionChain` treated "no `SUPERSEDES` edge" as "self is canonical", so an
invalidated node **self-reported `is_current: true`**.

Measured over all 685 pairs:

| Measurement | Value |
|---|---|
| Victim content destroyed | ~1.1 MB (796,314 bytes structural + 304,709 independent) |
| Tokens present in victims, absent from survivors | 25,650 |
| Victims fully vocabulary-contained by their survivor | 73 of 682 |
| Non-`SAME_AS` edges orphaned | 3,273 across 328 victims |
| Topics destroyed / tag sets destroyed | 242 / 277 |
| Pairs where the SURVIVOR is itself now invalidated (neither half in live recall) | 132 |
| Structural pairs (parent vs. its own chunk) | 263; 261 invalidated; 260 of those killed the PARENT |
| Estimated false positives | ~383 of 682 (range 324–467) |
| Hand-verified sample | 24 pairs → 16 true dup / 7 false / 1 ambiguous |

**685 is a floor, not the population.** Of 852 invalidated episodes, 689 appear in a live `SAME_AS`
edge. Of the remaining 163, **28 were invalidated <20 s after creation** — the near-dup signature —
but their edge is gone, deleted by `ON DELETE CASCADE`.

**Not a regression.** The behaviour dates to `361c324f` (2026-07-04). Chunking metadata loss dates to
`7a30ea5a` (2026-06-21). The `entity_episodes` count mismatch dates to `0ff4d8129` (2026-07-02), the
file's first commit.

**Mass event.** 2026-07-04: 354 of 421 independent kills inside two hours, consistent with a bulk
re-embed re-running the pass — the heal paths reach `applyNearDupResult`. (The *correlation* is
measured; attributing it specifically to a bulk re-embed is **CONJECTURE**.)

### 1.1 The false positives are not the embedding model

Ruled out, with measurements:

- **Threshold is not loose.** Random unrelated episode pairs in this store average cosine **0.6127**
  (sd 0.0710, p99 0.7686). Only **4 of 179,700** sampled pairs reach 0.95 — a **+4.75 σ** cut.
- **Anisotropy: FALSIFIED.**
- **Normalization bug: RULED OUT.** Vector norms span 0.99999956–1.00000040 at 768 dims.

The actual cause is **25 degenerate embedding clusters (154 vectors)** whose members differ by
≤ 0.0057 per coordinate. They are day-localised to 2026-06-22, 06-23, 06-26 and 08-15. The largest
holds 16 mutually unrelated texts written 15:31–15:39 on 2026-06-26, with 37 episodes within 0.99 of
a single vector.

> The clusters themselves are **measured**. Their **ORIGIN is CONJECTURE** — no mechanism producing
> them has been identified or reproduced. Day-localisation is suggestive of a batching or
> session-state fault in the embedder, not evidence of one. Tracked as backlog item `81cc2211` (§6).

---

## 2. What shipped to source

| Commit | Change |
|---|---|
| `5c35a66a` | Near-dup auto-invalidation **stopped**. The pass now writes a `SAME_AS` edge only, carrying cosine / status / model / detector in `meta`. `DERIVED_FROM` parent↔chunk exemption on **both** the sync and async write paths. Durable source-scan guard against anonymous `t_invalid` writers. Soft-invalidated candidates fall through. 10 commits, 2 blind-review rounds. |
| `e356a0b2` | Supersession chain: `is_current` now derives from the **queried node's own `t_invalid`**; canonical is the **newest live** node (it was the oldest, contradicting its own comment); an unknown uid returns a structured `E_NOT_FOUND` instead of throwing. 3 commits, 2 blind-review rounds. |
| `a1b50621` | Completed an unrelated in-progress BL-404 telemetry singleton refactor (4 stranded globals) that was blocking every build in memory-server's 14-project dependency set. |

Suites, run on a stable HEAD against a **clean** tree: memory-core 88/88 files, 747 passed / 8
skipped; memory-server 45/45 files, 280 passed. Both exit 0.

---

## 3. Deploy state — read this before anything else

The fix is merged to **source** (`5c35a66a`, `e356a0b2`) and the bundle has been **rebuilt**: the
artifact on disk is `sha256:e21b802d6dfb9bc57f89fd7b1d3370f39367eeeb49bec47d61200cc161263eb9`,
rebuilt 2026-09-22T17:50Z. **The live process had not adopted it**: pid 87027 (started
2026-09-22T17:45:55Z) still reported the pre-fix
`sha256:4ea748572b1e85156ce04b32e28f335625bcf6811ab1c84337d86e5f685a3638` — a parent executing an
artifact that no longer exists on disk, while its freshly spawned children load the new one (see the
split-service trap, §4.1). A restart to resolve that split was in flight; **its outcome is not known
and is deliberately not asserted here.**

**Execute this check rather than trusting any status sentence, including this one:**

- `memory_ping` reports `sha256:4ea7485…f685a3638` → the restart did **not** take; the process is
  still running pre-fix code and the invalidation pass may still be firing.
- `memory_ping` reports `sha256:e21b802d…61263eb9` → it did.

### Remaining deploy steps

```
npx nx run-many -t build --projects=memory-core,memory-server,memory-cli,memory-flush   # done 17:50Z
npx nx run registry:sync-index          # commit the regenerated registry/index.json
rm -rf dist/smoke && node scripts/smoke-test.mjs      # summary.failed must be 0
soxe service disable memory-server --host <host> --scope user
soxe service enable  memory-server --host <host> --scope user \
    --node-path=/opt/homebrew/Cellar/node/26.5.1/bin/node
# then: diff the plist (§4.3), verify artifact adoption (§4.2), live probe (§4.8)
```

### Rollback

**Rollback target: `c36b3ba0`** — verified as `5c35a66a^`, the last commit before either fix merge
(`git log -1 --format='%h' 5c35a66a^` → `c36b3ba0`). It is the **state to return to**, not a commit
to revert: `git revert c36b3ba0` is docs-only and would accomplish nothing. Roll back by
resetting/checking out to it.

And a real rollback is that **plus** rebuild **plus** `npx nx run registry:sync-index` **plus**
service restart, or the old `dist/` stays live (BUG-028) and the service keeps executing an artifact
that exists in no commit.

---

## 4. Traps that cost real time on 2026-09-22

1. **Rebuilding `dist/` underneath a running service SPLITS it.** This session's own deploy did
   exactly that. The parent process keeps the old artifact resident in memory while newly spawned
   children (`enrich-process-host.js`, `fastembedProcessHost.js`) load the **new** one. Mixed
   versions against a single store produced `E_FOREIGN_SQLITE_SIDECAR` for every other client, about
   one `memory.db-tshm.stale-*` rotation per minute, and enrichment failures — observed
   `passes_failed: 284`, `last_pass_ok: false`, `embeds_failed: 4`, `heals_failed: 4`. **The store
   itself stayed healthy throughout** (`store_ok: true`, integrity `ok`, all six probes passing), so
   this is an availability failure, not data loss.
   **Rule: never rebuild a bundle whose service is live without restarting it in the same operation,
   and never leave a build half-deployed.**

2. **`memory_ping`'s `artifact` field is exactly `shasum -a 256 <bundle>/dist/index.js`.** Adoption
   verification is a direct string comparison against the rebuilt file. Process liveness is not
   verification (BUG-028).
3. **After `soxe service enable`, diff the regenerated plist against a pre-restart backup.**
   `~/Library/LaunchAgents/com.sox.user.memory-server.plist` must still carry
   `SOX_CONFIG_DB_PATH=/Users/nix/.memory/memory.db`, `SOX_CONFIG_PORT=3099`,
   `SOX_CONFIG_STOP_TIMEOUT_MS`, `SOX_PROTOCOL_ENABLED=0`,
   `SOX_HOME` / `SOX_REPO_ROOT=/Users/nix/dev/ai/claude-agents`, and `SOX_AGENT_NAME`. This is the
   BL-375 shell-env rebuild trap with a sharper edge: **if `SOX_CONFIG_DB_PATH` is dropped, the
   process comes up HEALTHY and every verification probe silently writes to the WRONG STORE.**
4. **Post-fix, `memory_near_duplicates` total GOES UP, not down.** It was 685. The fix stops *new*
   invalidation; it repairs nothing, and a probe write adds a pair. **A rising number is not a failed
   deploy** — it is the most likely reason someone declares a successful deploy failed.
5. **`check-suite-tree-state` is a snapshot, not a lock.** A full suite started against a clean tree
   silently straddled four commits when another agent committed mid-run. That result was
   unattributable, was discarded, and had to be re-run.
6. **Piping `nx test` through `tail` reports `tail`'s exit code.** A red suite was reported as
   "exit 0". Capture nx's exit status separately.
7. **The stock `sqlite3` CLI cannot open this store** — Turso-internal FTS objects produce
   `malformed database schema ... near USING`. Use `@tursodatabase/database`
   `connect(path, {readOnly: true})` against a **copy**.
8. **The near-dup pass is asynchronous** (`time_to_vector_ms` p99 ≈ 61.5 s; no `SOX_SYNC_EMBED` in
   the plist). Poll for the `SAME_AS` edge; do not assert immediately after a probe write. Two probe
   episodes must differ in content hash or the second is rejected `E_DEDUP`.
9. **Observed and UNTRIAGED: `E_FOREIGN_SQLITE_SIDECAR` (BUG-026) recurring for other sessions, with
   FOUR concurrent memory-server processes alive** — pids 21545 (22 days old), 64743 (4 days), 87027,
   87344. That is a singleton violation and is the likely cause of recall failures other agents are
   reporting. The split-service condition in trap 1 is a confirmed producer of the same
   `E_FOREIGN_SQLITE_SIDECAR` signature, so treat the two together. **Nothing was killed and nothing
   should be killed without the owner's decision.**

---

## 5. Still open — carry forward

- **Deploy completion and live verification** (§3).
- **Q4 entity-episodes branch is UNMERGED** — worktree `worktree-agent-af7488fb15a0480d8`, 5 commits,
  green on turso **and** sqlite, 3 blind-review rounds. A transaction wrap was added and then
  **reverted by architecture decision**: it could not deliver a snapshot under any topology, because
  per-row enrichment runs outside it, and on sqlite it made an unrelated write hard-throw. A narrow
  straddling race is **accepted and documented**; the permanent fix is item `5b6af6cb`.
- **Chunk inheritance is STILL UNFIXED** — 1,709 episodes with no topic and 4,602 with no tags are
  structurally unreachable by topic- or tag-filtered recall: `recall.ts` uses `n.topic = ?` and
  `json_each` over tags, and neither matches `NULL` or `[]`.
- **Recovery of the 685 is NOT STARTED.** The owner approved: build the tool, dry-run, sample, then
  assess. Design: a `memory_curate` op `restore_neardup`; backup first; **LEXICAL triage
  (Jaccard / LCS), never cosine and never age**; `meta.restoredFrom` for reversibility;
  component-wise over the `SAME_AS` graph. Note that **255 of the 260 killed parents still have all
  their chunks live**, so the text largely survives in fragments — the parent node, its topic, its
  tags and its edges do not. `gcOrphanedCommunityState` tore down community state that clearing
  `t_invalid` will **not** restore.
- **Re-embed amplifier fix (`61fbf2e0`) is UNVERIFIED end-to-end.**
- **Three tests that could not fail** were found and fixed this session. `typecheck-tests` is **not
  in CI** and is already red from BL-490.
- **Backlog-store drift went unverified for every commit on 2026-09-22, including this one.**
  Measured while committing this document: `node tools/plan-status.mjs --check` exits **2** hard with
  `STORE UNAVAILABLE — backlog query failed (offset=0)`; the pre-commit hook then **downgrades itself
  to advisory by design and says so** ("store availability must never gate a commit"). So this is not
  a silently swallowed error — it is an announced advisory downgrade whose real consequence is that
  no commit today had `PLAN.md`/`STATE.md` drift actually checked. Re-run `--check` by hand once the
  store is reachable.
- **`sox-telemetry` is missing from the commitlint scope enum.**
- **Backlog `query --text` reports `total` as CORPUS SIZE, not match count** — verified: a nonsense
  query and a real query both returned 1670. Ranking itself does work. Unverified claims about the
  same tool: vector-index-on-write failure, dedupe scoring quality, `citations[]` rejection,
  UID-migration mechanics.
- **Docs still describing the old semantics:** `memory-server/CLAUDE.md:367`,
  `libs/memory-core/README.md:240-245`, `docs/plan/memory-enrichment/CONTRACTS.md:308`,
  `docs/plan/memory-refactor/contracts/analysis.ts:96`. Left untouched deliberately — outside this
  session's write set.
- **Two other agents were editing this repo concurrently on 2026-09-22** (observed, not inferred):
  one continuing the BL-404 telemetry singleton work past `a1b50621`, with a new untracked
  `docs/decisions/0018-sox-telemetry-process-wide-singleton-slot.md`; one doing embedding-provider
  lock work across six files (`fastembedLock*`, `fastembedProcessHost*`, `sharedFastembedProcess*`).
  Note that committing **anything** in this repo triggers an 18-project `nx lint` from the
  pre-commit hook — a live hazard next to BL-235.
- **`NOTES.md` items 6–11 untriaged.** One unexplained, non-reproducing test failure from the
  straddled run (§4.4).

---

## 6. Backlog items filed 2026-09-22

⚠️ **These are UIDs, not `BL-<n>` ids, and this store REASSIGNS an item's UID on every body write.**
Every id below is a **point-in-time reference as of 2026-09-22**, read back and byte-matched at
filing time by the filing session, and **not re-verified by this document**. Resolve by content
before citing one.

| UID | Subject |
|---|---|
| `c56aea0a` | Root: near-dup invalidation (UID chain `148601b7`→`ce982b89`→`1c25eb4f`→`c56aea0a`) |
| `866650df` | `entity_episodes` count mismatch |
| `29f3a4d5` | Chunk topic/tags not inherited |
| `697491ef` | `E_BUSY` — **REFUTED as a defect**, still OPEN |
| `81cc2211` | Degenerate embedding batches |
| `0a4b81b7` | `applyNearDupResult` metadata destruction + survivor-by-age |
| `61fbf2e0` | Bulk re-embed re-runs the near-dup pass |
| `9b879ca9` | `related.ts` slice-before-filter |
| `53874283` | entity-episodes N+1 |
| `48d2c16e` | Two conflicting canonical definitions |
| `5b6af6cb` | Collapse three reads into one windowed query |
| `03f8651d` | sqlite adapter has no `_withTxLock` |
