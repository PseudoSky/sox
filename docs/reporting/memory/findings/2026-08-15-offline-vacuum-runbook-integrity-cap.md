# Offline VACUUM runbook — clearing the integrity_check page-noise cap

**Status:** RUNBOOK PREPARED, NOT EXECUTED against the live store. Rehearsed twice against
disposable copies (2026-08-14/15). The destructive step (replacing `~/.memory/memory.db`) requires
explicit owner approval per the team-lead's constraint — this document stops one step short of it.

**Addresses:** `BUG-INTEGRITY-CHECK-BLINDED-BY-PAGE-NOISE-001` (CRITICAL) — the live store's
`pragma_integrity_check` probe hits its 100-message cap on benign page-accounting noise (100
allocated-but-unreachable pages), so `integrity.overall` reports `unknown`, not `ok`, and any real
damage past message #100 would never surface.

**Prerequisite discharged:** `BUG-MEMORY-SNAPSHOT-NO-RESTORE-PATH-001`'s restore claim is now
proven, not aspirational — see `docs/decisions/0014-memory-snapshot-retention-policy.md` D5 and the
"Restore proof" section below.

## Rehearsal evidence (the decisive part — answers "is there damage hiding past the cap?")

Ran `node --import tsx tools/rehearse-live-vacuum.mjs` twice (2026-08-14 23:46 and 23:47 local).
Full JSON output of the second, clean run is reproduced at the bottom of this document. Summary:

| Step | What it does | Result |
|---|---|---|
| 0 | Read-only `verifyStoreIntegrity(depth:'deep')` directly against **live** `~/.memory/memory.db` (no copy, no write, no stop) | `hit_cap: true` — independently reproduces the CRITICAL finding. `damaged: []`. |
| 1 | `backupStore()` (`libs/memory-core/src/backup.ts:127`, `VACUUM INTO`) of **live** `memory.db` → `baseline.db`, a live-consistent copy, single VACUUM INTO pass | `integrity_report: "verified"` |
| 2 | `verifyStoreIntegrity(deep)` on `baseline.db` | `hit_cap: false`, `integrity_check_probe.status: "ok"`, `damaged: []` — **the cap clears in one pass** |
| 3 | Second VACUUM INTO pass, `baseline.db` → `vacuumed.db` (idempotency check) | `integrity_report: "verified"` |
| 4 | `verifyStoreIntegrity(deep)` on `vacuumed.db` | `hit_cap: false`, `damaged: []` — stable, no regression on a second pass |
| 5 | Row counts: `baseline.db` vs `vacuumed.db` | `nodes: 11782`, `edges: 61722`, `episodes: 5879`, `vectors: 6029` — **identical**, VACUUM changed physical layout only |

**Conclusion: no hidden damage was found.** The 100 pages that saturated the cap were exactly what
the probe's own message said — reclaimable free space from allocated-but-unreachable pages — not a
mask for corruption. Once VACUUM INTO removes them, `pragma_integrity_check` completes cleanly
under the cap on the first pass, and a second pass changes nothing. Per the item's own instruction
("if damage appears once the cap clears... treat it as newly VISIBLE, not newly caused by the
VACUUM"): the converse also holds — **no damage appearing once the cap clears is real evidence of
health, not an artifact of the rehearsal.**

This does **not** by itself prove the *live* file is undamaged — it proves a live-consistent copy
of it, taken seconds ago via the proven read-only VACUUM INTO path, is undamaged. The gap between
"a copy taken via VACUUM INTO is clean" and "the live file itself is clean" is exactly the
distinction `pragma_integrity_check`'s `unknown` verdict exists to flag, and closing it fully
requires the production step below.

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

- `~/.memory/backups/vacuum-rehearsal-2026-08-15T04-47-21-190Z/{baseline.db,vacuumed.db}` — the
  rehearsal copies from the clean run below. Not cleaned up (script supports `--clean`; not passed)
  so they can be inspected directly, e.g. re-run `verifyStoreIntegrity` a third time independently.
- `tools/rehearse-live-vacuum.mjs` — repeatable; safe to re-run any number of times (every step is
  either read-only against live or writes to a fresh timestamped directory).
- `tools/prove-snapshot-restore.mjs` — repeatable against any `<class>-<ts>/` snapshot directory.

## Full JSON — second rehearsal run (2026-08-15T04:47Z)

```json
{
  "rehearsal_dir": "/Users/nix/.memory/backups/vacuum-rehearsal-2026-08-15T04-47-21-190Z",
  "steps": {
    "live_integrity_before_any_action": {
      "ok": true,
      "probes_run": 32,
      "damaged": [],
      "integrity_check_probe": {
        "status": "unknown",
        "detail": "integrity_check output hit the 100-message cap (101 message(s) seen) and no un-filtered damage remained after discarding 1 known Turso FTS false positive(s) and 100 page-accounting message(s). Truncated output cannot show the store is clean — the messages past the cap were never emitted. Re-run after an offline VACUUM to clear the noise that filled the cap. 100 allocated-but-unreachable page(s) were seen and are NOT counted as damage — that is reclaimable free space, recovered by an offline VACUUM."
      },
      "hit_cap": true
    },
    "baseline_backup": { "ok": true, "integrity_report": "verified" },
    "baseline_integrity": {
      "ok": true,
      "probes_run": 32,
      "damaged": [],
      "integrity_check_probe": {
        "status": "ok",
        "detail": "integrity_check clean after filtering 1 known Turso FTS false positive(s)."
      },
      "hit_cap": false
    },
    "baseline_counts": { "nodes": 11782, "edges": 61722, "episodes": 5879, "vectors": 6029 },
    "vacuum_pass": { "ok": true, "integrity_report": "verified" },
    "vacuumed_integrity": {
      "ok": true,
      "probes_run": 32,
      "damaged": [],
      "integrity_check_probe": {
        "status": "ok",
        "detail": "integrity_check clean after filtering 1 known Turso FTS false positive(s)."
      },
      "hit_cap": false
    },
    "vacuumed_counts": { "nodes": 11782, "edges": 61722, "episodes": 5879, "vectors": 6029 },
    "counts_preserved": true
  },
  "pass": true,
  "summary": {
    "live_hit_cap_before_any_vacuum": true,
    "single_vacuum_into_pass_cleared_cap": true,
    "second_pass_stable": true,
    "new_damage_after_vacuum": false,
    "counts_preserved": true
  }
}
```
