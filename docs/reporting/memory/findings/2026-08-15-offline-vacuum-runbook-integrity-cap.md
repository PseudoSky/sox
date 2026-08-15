# Offline VACUUM runbook — clearing the integrity_check page-noise cap

**Status:** RUNBOOK PREPARED, NOT EXECUTED against the live store. Rehearsed against disposable
copies (2026-08-14/15, revised 2026-08-15 with a corrected before/after methodology — see
"Methodology correction" below). The destructive step (replacing `~/.memory/memory.db`) requires
explicit owner approval per the team-lead's constraint — this document stops one step short of it.

**Addresses:** `BUG-INTEGRITY-CHECK-BLINDED-BY-PAGE-NOISE-001` (CRITICAL) — the live store's
`pragma_integrity_check` probe hits its 100-message cap on benign page-accounting noise (100
allocated-but-unreachable pages), so `integrity.overall` reports `unknown`, not `ok`, and any real
damage past message #100 would never surface. Also tests the team lead's page-leak hypothesis
(measured across snapshots: 2.7MB/episode growth, `freelist_count` 0-2, ~71% file overhead).

**Prerequisite discharged:** `BUG-MEMORY-SNAPSHOT-NO-RESTORE-PATH-001`'s restore claim is now
proven, not aspirational — see `docs/decisions/0014-memory-snapshot-retention-policy.md` D5 and the
"Restore proof" section below.

## Leak-hypothesis verdict — lead number first

**`page_count` before: 34,440. After a single VACUUM INTO pass: 24,905. Delta: 9,535 pages
(27.7%), 37.2MB reclaimed out of a 134.5MB live file.** Payload (column-sum total across all user
tables) is unchanged at 36.8MB before and after — VACUUM changed only physical layout, not content.
**Verdict: CONFIRMED — the space is leaked (allocated, orphaned, never reused) and is reclaimable by
an offline VACUUM.** This is not marginal: `freelist_count` was 1 both before and after (matching
the team lead's 0-2 observation across snapshots — these pages are *not* on the freelist, i.e. not
even nominally available for reuse), and 27.7% of the file's total page count came back the moment a
compaction pass ran. Full before/after table below.

**Important scope correction, made explicit so it is not conflated with the `pragma_integrity_check`
message count:** the 100 `Page N: never used` messages that saturate the cap are **100 pages ≈
0.4MB** — that number explains only why the cap saturates, nothing about file size. The actual
leaked space, **9,535 pages ≈ 37.2MB**, is measured independently via `page_count` before/after a
VACUUM INTO pass, not by counting `integrity_check` messages (which truncate at 100 and could never
report 9,535 anything). These are two different findings that happen to come out of the same probe
run and must not be described as the same number.

**The leak does not account for all of the overhead, and that remainder is real, not further leak.**
Total overhead before VACUUM was 97.7MB (file 134.5MB − payload 36.8MB); after, 60.5MB. VACUUM
reclaimed 37.2MB of that 97.7MB — the leak — and left 60.5MB standing, **unchanged by a second VACUUM
INTO pass** (idempotent: `page_count` 24,905 → 24,905). Because a genuine leak would also be cleared
by a repeat VACUUM and this remainder was not, the 60.5MB is legitimate structural overhead — b-tree
index pages (14 indexes on `node` alone, plus `idx_fts_node`, `idx_vec_node_embedding`), FTS5 shadow
tables, and the `vec0` vector index over 6,029 vectors — not a second hidden leak. So: **partial
confirmation of the team lead's two-outcome framing, split cleanly rather than picked one side** —
some of the size (37.2MB) is leaked and reclaimable, and the majority of the remaining overhead
(60.5MB) is genuine index/structural cost the store legitimately pays. The `+35MB` growth for only
`+13` episodes between the Aug-8 snapshot and the current live file is **not fully explained by
this measurement** — this rehearsal proves *some* of that growth is reclaimable leak, not that *all*
of it is; the residual is still open.

## Methodology correction (read this before trusting the earlier same-day numbers)

An earlier run of this rehearsal (2026-08-14 23:46/23:47, superseded) measured "before" as a VACUUM
INTO copy of live and "after" as a second VACUUM INTO pass on that copy — i.e. it compared an
*already-compacted* file to itself again, which can only ever show "stable" and cannot answer the
leak question at all. That run's conclusion ("no hidden damage") is not wrong on its own narrow
terms (integrity, not size) but the comparison it ran was not a true before/after and is superseded
by the measurement below. **Revision 2** (`tools/rehearse-live-vacuum.mjs`, current version) fixes
this: the BEFORE state is measured with a **read-only connection directly against the live file**
(pure `PRAGMA`/`SELECT` reads, zero mutation — the same class of read `memory_stats`' own deep probe
already performs), and only the AFTER state is a VACUUM INTO copy.

## Rehearsal evidence — before/after, single VACUUM INTO pass

Ran `node --import tsx tools/rehearse-live-vacuum.mjs` (2026-08-15, revised version). Full JSON is
at the bottom of this document.

| Metric | Before (live, read-only) | After (1 VACUUM INTO pass) | After (2nd pass, idempotency) |
|---|---|---|---|
| `page_count` | 34,440 | 24,905 | 24,905 |
| `page_size` | 4096 | 4096 | 4096 |
| `freelist_count` | 1 | 1 | 1 |
| file size | 134.5 MB | 97.3 MB | 97.3 MB |
| payload (column-sum) | 36.8 MB | 36.8 MB | 36.8 MB |
| overhead | 97.7 MB (72.6%) | 60.5 MB (62.2%) | 60.5 MB (62.2%) |
| `integrity_check` raw messages | 101 (100 leaked-page + 1 known FTS FP) | 1 (the known FTS FP only) | 1 |
| `integrity_check` hits 100-cap | **yes** | **no** | no |
| new/unexplained messages once cap cleared | n/a | **none** — `other_messages: []` | none |
| row counts (nodes/edges/episodes/vectors) | 11782/61722/5879/6029 | 11782/61722/5879/6029 | 11782/61722/5879/6029 |

Per-table payload breakdown (both before and after — unchanged, confirming VACUUM touched layout
only): `node` 14.67MB, `vec_node` 17.69MB, `edge` 3.64MB, `organizer_queue` 0.80MB, `_adapter_meta`
0.01MB, all other tables ~0. This roughly matches the team lead's own per-table breakdown on the Aug
8 snapshot (node 12.3MB/vec_node 15.4MB/edge 3.2MB at a smaller row count) — consistent growth.

**Conclusion, stated plainly per the instruction not to hedge: the leak hypothesis is CONFIRMED, and
no hidden damage was found once the cap cleared.** `other_messages` (the bucket for anything that
isn't a page-accounting message or the known Turso FTS false positive) is empty both before and
after — nothing was masked by the cap; the 100 messages consuming it were exactly what they claimed
to be. Per the item's own instruction ("if damage appears once the cap clears... treat it as newly
VISIBLE, not newly caused by the VACUUM"): the converse holds here too — **no damage appearing is
real evidence of health, not an artifact of the rehearsal.**

This does **not** by itself prove the *live* file is undamaged in the fullest sense — the AFTER
measurement is on a copy, not live itself, and the swap step is still gated on owner approval. But
the BEFORE measurement (page_count, freelist_count, payload, raw integrity_check) in this revision
**was taken directly against the live file, read-only** — that half of the evidence is not a proxy.

## Restore proof (discharges the D5 blocker)

Ran `node --import tsx tools/prove-snapshot-restore.mjs <snapshot-dir>` against two real
pre-operation snapshots (`prerebuild-20260809-010352/`, `s5-preenable-20260731-182303/`), each
entirely offline, against disposable copies, never touching the source snapshot or
`~/.memory/memory.db`. Both passed all three proof gates:

1. **Row counts match** between an independent read-only reference copy and a separately-restored
   copy opened via the exact same `openDb()` call the memory-server backend uses on every start.
2. **Content-level spot check**: a real episode was located in the reference copy, a real
   `memoryRecall()` query run against the restored copy, and the returned content was
   byte-identical to the source — not just a matching row count.
3. **`verifyStoreIntegrity(depth:'deep')`**: `damaged: []` on both restored copies (both also hit
   the same page-noise cap as the live store — see Corroboration below).

Full output is in the commit alongside `tools/prove-snapshot-restore.mjs`. This proves the specific
restore mechanism (copy `memory.db`+`-wal`, open via `openDb`) works, twice, across snapshots 9
days apart in age and from two different operation classes. It does not prove every one of the ~15
other snapshot directories restores cleanly — only that the mechanism is sound.

## Corroboration: the page-noise is not new

`BUG-INTEGRITY-CHECK-BLINDED-BY-PAGE-NOISE-001` itself already notes the `prerebuild-20260809-010352`
snapshot (Aug 8) exhibits the identical `Page N: never used` pattern. My restore-proof run
independently reproduces this: `tools/prove-snapshot-restore.mjs` output for both snapshots shows
`integrity.unknown[0].probe: "pragma_integrity_check"` with the same "hit the 100-message cap"
detail. Whatever accumulates these pages has been present for at least the ~2 weeks spanned by the
two snapshots tested, consistent with the CRITICAL item's own timeline claim.

## The production runbook (NOT executed — stops before the destructive step)

Ordered per the CRITICAL item's own sequencing requirement ("do not VACUUM casually").

1. **Preconditions.** All gates green. No agent mid-write against `~/.memory/memory.db` (check via
   `soxe service status memory-server` or equivalent — the exact live-verification command is a
   `CONTRIBUTING.md` §2 mcp-server concern, not restated here).
2. **Take a fresh, verified snapshot of the live store before touching anything**, using the
   already-proven mechanism: `backupStore(~/.memory/memory.db, ~/.memory/backups/pre-vacuum-<ts>/memory.db)`
   (or the `memory-cli backup` CLI wrapper, `extensions/bundles/sox-memory-bundle/members/memory-cli/src/index.ts:467-524`).
   This is a `VACUUM INTO`, safe against concurrent writers per `backup.ts:118` — it does not require
   stopping the server. Confirm its `integrityReport.status === 'verified'` before proceeding; if it
   comes back `unverified` or `damaged`, STOP — do not proceed to step 3.
3. **Stop the live memory-server** (its supervisor/service control, never `kill -9` — per
   `docs/spec/service-lifecycle.md`). The CRITICAL item explicitly calls for this: "A VACUUM racing
   the live service is precisely the multiprocess-WAL scenario implicated in the corruption class."
   Even though `VACUUM INTO` alone is documented as safe against concurrent writers, the *swap* step
   below (replacing the file the server has open) is not, so the server must be down for steps 4-6.
4. **Run `backupStore(~/.memory/memory.db, ~/.memory/memory.db.vacuumed-<ts>)`** — same mechanism
   rehearsed above, now against the stopped live file, writing to a **new** filename (never
   overwrite in place). Confirm `integrityReport.status === 'verified'` and `damaged.length === 0`.
   If not, STOP — the original `~/.memory/memory.db` is untouched; abort and restart the server on
   the pre-existing file.
5. **Verify row counts match** between `~/.memory/memory.db` (still present, untouched) and
   `~/.memory/memory.db.vacuumed-<ts>` before swapping anything — reuse the counting logic in
   `tools/rehearse-live-vacuum.mjs`. If they don't match exactly, STOP.
6. **Atomic swap, old file preserved (never deleted):**
   `mv ~/.memory/memory.db ~/.memory/memory.db.pre-vacuum-<ts>` then
   `mv ~/.memory/memory.db.vacuumed-<ts> ~/.memory/memory.db`. Both are single `rename(2)` calls
   inside the same filesystem — atomic, no window where the path is empty. The pre-vacuum file stays
   on disk as an immediate rollback path (delete it only after step 8 passes and some soak period —
   how long is an owner call, not this runbook's).
7. **Restart the server.**
8. **Re-run the deep probe against the now-live file** (the same `memory_stats` deep call that found
   this in the first place, or `verifyStoreIntegrity(depth:'deep')` via a fresh `openDbReadOnly`).
   Confirm `integrity.overall` is no longer `unknown` — record whatever it now says, including if
   real damage appears. Per the item's own instruction: if damage appears now, it was **always
   there** and is newly visible, not caused by this procedure — report it as such, do not treat it
   as a new regression.
9. **Rollback path, if step 8 finds something worse than before:** stop the server, restore
   `~/.memory/memory.db.pre-vacuum-<ts>` over `~/.memory/memory.db`, restart. Nothing about this
   procedure makes that file unusable — it was never modified.

Steps 3, 4, 6, 7, and 9 are the ones requiring the live server down and touching the real file.
**None of them have been executed.** Everything executed so far (the Rehearsal Evidence and Restore
Proof sections above) ran exclusively against disposable copies under `~/.memory/backups/` and a
system tmpdir.

## Artifacts left on disk for review

- `~/.memory/backups/vacuum-rehearsal-2026-08-15T04-53-20-099Z/{vacuumed.db,vacuumed-pass2.db}` —
  the Revision 2 rehearsal copies (the ones the table above is measured from). Not cleaned up
  (script supports `--clean`; not passed) so they can be inspected directly.
- `~/.memory/backups/vacuum-rehearsal-2026-08-15T04-47-21-190Z/{baseline.db,vacuumed.db}` — the
  superseded Revision 1 rehearsal copies (see "Methodology correction"). Left in place, not deleted.
- `tools/rehearse-live-vacuum.mjs` — repeatable; safe to re-run any number of times (BEFORE
  measurement is read-only against live, AFTER measurements write to fresh timestamped directories).
- `tools/prove-snapshot-restore.mjs` — repeatable against any `<class>-<ts>/` snapshot directory.

## Full JSON — Revision 2 rehearsal run (2026-08-15T04:53Z)

```json
{
  "rehearsal_dir": "/Users/nix/.memory/backups/vacuum-rehearsal-2026-08-15T04-53-20-099Z",
  "steps": {
    "before_live": {
      "page_count": 34440, "page_size": 4096, "freelist_count": 1,
      "file_bytes": 141066240, "file_mb": 134.5,
      "payload_bytes": 38588048, "payload_mb": 36.8,
      "overhead_mb": 97.7, "overhead_pct": 72.6,
      "payload_per_table_mb": {
        "edge": 3.64, "node": 14.67, "organizer_queue": 0.8, "vec_node": 17.69,
        "_adapter_meta": 0.01, "__drizzle_migrations": 0, "memory_scope": 0,
        "sox_store_meta": 0, "request_ledger": 0, "promotion_queue": 0, "_sox_engine": 0
      },
      "payload_skipped_tables": [],
      "integrity_check": {
        "total_messages": 101, "hit_cap": true,
        "leaked_page_messages": 100, "known_fts_false_positives": 1, "other_messages": []
      },
      "counts": { "nodes": 11782, "edges": 61722, "episodes": 5879, "vectors": 6029 }
    },
    "vacuum_into_result": { "integrity_report": "verified" },
    "after_vacuum_pass1": {
      "page_count": 24905, "page_size": 4096, "freelist_count": 1,
      "file_bytes": 102010880, "file_mb": 97.3,
      "payload_bytes": 38588330, "payload_mb": 36.8,
      "overhead_mb": 60.5, "overhead_pct": 62.2,
      "integrity_check": {
        "total_messages": 1, "hit_cap": false,
        "leaked_page_messages": 0, "known_fts_false_positives": 1, "other_messages": []
      },
      "counts": { "nodes": 11782, "edges": 61722, "episodes": 5879, "vectors": 6029 }
    },
    "after_vacuum_pass2": {
      "page_count": 24905, "page_size": 4096, "freelist_count": 1,
      "file_bytes": 102010880, "file_mb": 97.3,
      "payload_bytes": 38588106, "payload_mb": 36.8,
      "integrity_check": { "total_messages": 1, "hit_cap": false, "leaked_page_messages": 0, "other_messages": [] },
      "counts": { "nodes": 11782, "edges": 61722, "episodes": 5879, "vectors": 6029 }
    },
    "counts_preserved_before_vs_after": true
  },
  "pass": true,
  "verdict": {
    "page_count_before": 34440, "page_count_after": 24905,
    "page_count_delta": 9535, "page_count_delta_pct": 27.7,
    "file_mb_before": 134.5, "file_mb_after": 97.3, "file_mb_reclaimed": 37.2,
    "payload_mb_before": 36.8, "payload_mb_after": 36.8, "payload_stable_across_vacuum": true,
    "leaked_page_messages_before": 100, "leaked_page_messages_after": 0,
    "integrity_check_hit_cap_before": true, "integrity_check_hit_cap_after": false,
    "integrity_check_now_completes": true,
    "new_messages_revealed_once_cap_cleared": [],
    "counts_preserved": true,
    "second_pass_page_count": 24905, "stable_on_second_pass": true,
    "leak_hypothesis": "CONFIRMED: VACUUM reclaimed a large fraction of page_count — the space was leaked (allocated, orphaned, never reused) and IS reclaimable by an offline VACUUM."
  }
}
```

---

## EXECUTED — production VACUUM, 2026-08-15

Owner-approved and executed by the team-lead session. Downtime **05:17:38Z → 05:25:42Z (8m04s)**.

| Metric | Before (live) | After (live, post-swap) |
|---|---|---|
| page_count | 34,454 | 24,913 |
| freelist_count | 2 | 1 |
| file size | 134.59 MB | 97.31 MB |
| payload (column-sum) | 36.81 MB | 36.81 MB |
| nodes / edges / episodes / vectors | 11786 / 61726 / 6637 / 6033 | identical |

**Reclaimed 9,541 pages / 37.28 MB (−27.7%)** — matches the rehearsal (9,535 / 37.2MB) to within 6 pages of
drift accumulated between rehearsal and execution. `backupStore()` integrity report: **verified** across all
six probes including `pragma_integrity_check`. Post-restart `memory_stats`: `integrity.overall: "ok"`,
`healthy: true`, `damaged: []`, `unknown: []` — previously `"unknown"` / `healthy: false` with the
100-message cap saturated. A real `memory_recall` returned correct content with vec+fts provenance.

### Deviations from the runbook as written

1. **Order changed: server stopped BEFORE the backup.** Step 2 (fresh backup while live) is impossible —
   the running server holds the experimental-multiprocess-WAL lock and a second opener fails with
   `Database is already open with experimental multiprocess WAL in another process`. Stopping first is
   also strictly safer (cold copy, zero concurrent writers). **Fix the runbook: step 2 must follow step 3.**
2. **An orphan survived the unload.** `launchctl bootout` removed the unit but pid 97360 (PPID 1, started
   23:11:43) kept `memory.db` + `-wal` open — the `[inv:unload-then-reap]` case. Cleared with SIGTERM
   (exited in 7s; never SIGKILL, a clean close releases the lease). **The runbook must include an explicit
   post-unload survivor check**, or the VACUUM runs against a store another process still holds.
3. **`VACUUM INTO` via the raw turso driver FAILS** — `index method is an experimental feature. Enable with
   --experimental-index-method flag` (the vec0 index). Must go through `backupStore()`, which owns the
   experimental-flag handling (`backup.ts:7-11`). A raw-driver attempt left a 4KB stub + an 84MB `-wal`
   which had to be removed. **Runbook should name `backupStore()` explicitly as the only supported path.**
4. **Used `launchctl bootout`/`bootstrap` on the existing plist rather than `soxe service disable`/`enable`.**
   `disable` removes the unit and `enable` regenerates it, which risks BL-375 shell-sourced env drop.
   Unload/reload of the same file keeps env identical by construction. Plist also backed up beforehand.
5. **Stale sidecars must be moved with the swap.** The old `-wal`/`-shm` would otherwise sit beside the new
   file under the same basename — a stale WAL index against a different database. Moved to
   `memory.db.pre-vacuum-orig-<ts>-{wal,shm}`.

### Rollback artifacts — DO NOT DELETE without owner approval

    ~/.memory/memory.db.pre-vacuum-20260815-051940            141,123,584 B  (cold cp, pre-stop)
    ~/.memory/memory.db.pre-vacuum-orig-20260815-051940       141,123,584 B  (renamed original)
    ~/.memory/memory.db.pre-vacuum-orig-20260815-051940-{wal,shm}

Two byte-identical copies of the original are retained deliberately.

### LEAK-RATE BASELINE — the reason this measurement exists

`page_count = 24,913` at **2026-08-15T05:23Z**, immediately post-VACUUM, freelist_count 1.

The 9,541 pages reclaimed accumulated over the store's whole lifetime with no denominator, so we cannot
tell a slow constant bleed from a burst. **Re-measure `page_count` against this baseline in a few days of
normal operation** — the delta is the leak RATE, and it is the measurement that turns
BUG-INTEGRITY-CHECK-BLINDED-BY-PAGE-NOISE-001 from a cleanup into a diagnosis. Without it, this VACUUM
destroyed the only signal we had.

Note the 60.5 MB of structural overhead is unchanged and expected (26 indexes, FTS5 shadow tables, vec0
over 6,033 vectors) — only the leak was reclaimable.
