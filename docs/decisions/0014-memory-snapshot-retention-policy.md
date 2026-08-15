# ADR-0014 — Retention policy for pre-operation memory.db snapshots

**Status:** PROPOSED — design only, not implemented (2026-08-14/15).
**Owner:** architect-reviewer (design), pending owner review.
**Relates to:** ADR-0007 (memory single-writer architecture), ADR-0013 (feature switches are typed
config, not env vars — D4 "one-shot operator actions are explicit invocations"),
`BUG-MEMORY-SNAPSHOT-BACKUPS-NEVER-PRUNED-001` (the triggering item), and the newly-filed
`BUG-MEMORY-SNAPSHOT-NO-RESTORE-PATH-001` (filed during this investigation — see Context).

## Context

### The measured problem

`~/.adhd/sox-ecosystem/memory/` is 1.4GB, almost entirely unpruned database snapshots (measured
2026-08-15 via `du`/`ls -la`, corroborated live 2026-08-14/15 via `ls -la
~/.adhd/sox-ecosystem/memory/`):

```
110M  memory/prerebuild-20260809-010352/memory.db
105M  memory/bl328-live/copy.db
100M  memory/predeploy-20260803-203722/memory.db
 99M  memory/predeploy-20260803-201146/memory.db
 97M  memory/predeploy-20260803-190609/memory.db
 66M  memory/s5-preenable-20260731-182303/memory.db
```

Three near-identical ~100MB snapshots exist from a single Aug 3 deploy sequence (19:06, 20:11,
20:37). The oldest live snapshot at time of writing is `s5-preenable-20260731-182303/` (from Jul
31, 12+ days old). The live store itself is only ~19MB — the snapshots are roughly 75x the size of
what they protect. Nothing reclaims any of it.

The full directory listing (`ls -la ~/.adhd/sox-ecosystem/memory/`, run 2026-08-14) shows the
complete population, not just the six items called out in the bug report:

```
backlog-preimport-20260730/        bl331-predeploy-20260731-180139/
bl328-analyze.mjs (+ 7 sibling .mjs scripts)   bl342-prebuild-20260804-175811/
bl328-live/                        corrections-20260730/
dist-rescue-20260730/              log-analysis/
logs/                              predeploy-20260803-190609/
predeploy-20260803-201146/         predeploy-20260803-203722/
predeploy-20260804-144740/         prerebuild-20260731-150126/
prerebuild-20260804-184044/        prerebuild-20260809-010352/
prerestart-20260731-174637/        s5-preenable-20260731-182303/
src-rescue-20260730/               withdrawn-bl321/
```

### Finding 1 — there is no code that creates these snapshots

I searched for the creation mechanism before designing anything to prune, on the theory that a
policy should hook the same place that writes. There isn't one to hook.

`rg -n "predeploy|prerebuild|preenable|VACUUM INTO" --glob '!node_modules' --glob '!dist'` across
the whole repo returns zero non-documentation hits for `predeploy`/`prerebuild`/`preenable` as a
path fragment or identifier. The only `VACUUM INTO` call sites in the codebase are
`libs/data/store/store-adapter/src/sqlite-adapter.ts:325` and
`libs/data/store/store-adapter/src/turso-adapter.ts:1085`, both invoked exclusively through
`libs/memory-core/src/backup.ts:209-211` (`backupStore`). That function is hard-allowlisted:
`isPathInMemoryAllowlist()` (`backup.ts:105`) requires both source and destination to live under
`~/.memory/**`, enforced at `backup.ts:144-156` — refusing with `E_ALLOWLIST` and creating no file
otherwise. `~/.adhd/sox-ecosystem/memory/` is categorically outside that allowlist. `backupStore`
could not have written any of the files above even if something had called it.

What actually creates them: agents (human or LLM) running manual `cp`/`cp -r` by hand, following
runbook prose. `~/.adhd/sox-ecosystem/memory/GO-LIVE-RUNBOOK.md` step 3 (lines 40-43) instructs:
`cp ~/.memory/memory.db ~/.memory/memory.db.<ts>.pre-golive` — note this convention targets
`~/.memory/` with a `.pre-golive` suffix, which is *neither* naming scheme actually on disk. The
`<label>-<ts>/` directories under `~/.adhd/sox-ecosystem/memory/` are a second, different, informal
convention, documented after the fact in `docs/reporting/memory/STATE.md:256` ("prerebuild-...
working `dist/`, store-adapter + memory-core dists, plist"),
`docs/reporting/memory/findings/bl331-root-cause.md:330`, and
`docs/reporting/memory/handoff/perf.md:356` — never specified anywhere as a single source of truth.
Two incompatible conventions coexist in the one runbook I found; the population on disk implements
neither one consistently (`bl331-predeploy-...` and `predeploy-...` and `s5-preenable-...` are
three different label shapes for what are meant to be two logical operation classes).

**This reframes the design problem.** The bug report's ask ("extend the writer to prune") assumes a
writer worth extending. There is none — the first artifact this ADR's implementation will need is
the pruning tool itself, standalone, not an extension to existing machinery.

### Finding 2 — these snapshots are write-only; nothing restores from them

I searched for a restore path before assuming pruning was even safe to reason about: `rg -i
"rollback|restoreSnapshot|restore-snapshot"` across `tools/`, `scripts/`, `apps/`,
`libs/host-runtime`, `libs/memory-core`, `extensions/bundles/sox-memory-bundle` (excluding
`node_modules`/`dist`) returns hits only in `libs/memory-core/src/db.ts`, `apps/sox/src/main.ts`,
`libs/memory-core/src/embed-pipeline.ts`, `libs/memory-core/src/errors.spec.ts`,
`scripts/workspace-package-scan.test.mjs`, `tools/test-federation.js` — all unrelated comments about
environment-variable rollback or general git rollback, none about restoring a snapshot directory
into a live store. `GO-LIVE-RUNBOOK.md`'s own rollback section (lines 52-56) is manual prose ("Stop
the server, restore `~/.memory/memory.db.<ts>.pre-golive` over `~/.memory/memory.db` ... restart"),
not automation, and only covers its own naming convention — not the `<label>-<ts>` directories that
are what is actually accumulating.

**This is a bigger finding than the disk usage, and I am saying so plainly per the instruction to
falsify the framing if warranted:** a backup nobody can restore is not a backup. The safety argument
underpinning the whole retention question — "keep these because we'll need them when corruption
recurs" — is currently unverified. Nobody has proven an end-to-end restore from one of these
directories works. I filed this as `BUG-MEMORY-SNAPSHOT-NO-RESTORE-PATH-001`
(cross-linked to this item and to `DEBT-PROCESS-CP-SNAPSHOT-STALE-WAL-001`, which documents a
related defect: `cp` of a live WAL-mode store does not capture recent writes — see Finding 4). The
premise is not *wrong* — snapshots retained for corruption recovery is a real and correct instinct
— but it is currently aspirational. The Decision below treats this as a hard prerequisite, not a
nice-to-have (see D5).

### Finding 3 — the label taxonomy is real but the strings are not validated

Checking whether `predeploy`/`prerebuild`/`preenable` correspond to genuinely distinct operations
(not just distinct spellings of the same thing):

- `predeploy-*` — before a deploy/config change. `bl331-root-cause.md:330` confirms:
  "Snapshots taken before the change: `bl331-predeploy-20260731-180139/`" for a plist
  environment-variable fix.
- `prerebuild-*` — before `npx nx build`. `STATE.md:256`: "db + WAL, **working `dist/`**,
  store-adapter + memory-core dists, plist" — this class exists specifically because of the
  repo-wide constraint that `nx build` starts with `rm -rf dist` and cannot be undone by rebuilding
  if the source doesn't currently compile (see the repo's CLAUDE.md "a diagnostic `nx build` is a
  destructive operation" section) — so this class protects more than the db.
- `s5-preenable-*` / `preenable-*` — before `soxe service enable`.
- `prerestart-*` — before a service restart.

These four are a real, distinct-lifecycle taxonomy: each is triggered by a specific destructive
operation and its retained artifact set differs (`prerebuild` snapshots include `dist/`; `predeploy`
snapshots as observed are db-only). But the *labels* are ad hoc strings typed by whichever agent ran
the operation, not validated against an enum — `predeploy-20260803-190609` and
`bl331-predeploy-20260731-180139` are the same logical class with different formats (optional
ticket-ID prefix). Any class-matching logic must tolerate that.

**`bl328-live/copy.db` is NOT a pre-operation safety snapshot, confirming the framing's suspicion.**
Sitting alongside it are `bl328-analyze.mjs`, `bl328-degree.mjs`, `bl328-embed.mjs`,
`bl328-extract.mjs`, `bl328-g4-detail.mjs`, `bl328-sample.mjs`, `bl328-scale.mjs`,
`bl328-store-sweep.mjs` — a full set of offline research/analysis scripts for BL-328. `copy.db` is a
working copy taken for **offline analysis**, not disaster recovery. Likewise `backlog-preimport-*`,
`corrections-20260730/`, `dist-rescue-20260730/`, `src-rescue-20260730/`, `withdrawn-bl321/` are
incident-specific artifacts named and explained individually in `GO-LIVE-RUNBOOK.md`'s "Snapshots
stored here" table (lines 13-21) — several contain recovery *scripts and payloads*
(`corrections-20260730/dbrepair/restore.mjs`, `repair.mjs`, `verify.mjs`, per the runbook), not bare
db copies. These are heterogeneous, hand-curated, individually-significant artifacts, not a
homogeneous rotation of disposable safety copies.

### Finding 4 — full-copy `cp`, not `VACUUM INTO`; genuine duplication of a better mechanism

None of the operator snapshots use `VACUUM INTO`. They use `cp`/`cp -r` of the live file, per
`GO-LIVE-RUNBOOK.md:42` and its own explicit caveat (lines 60-62): **"`cp` of a live Turso store
does NOT capture recent writes"** — proven there by a probe write that a concurrent `cp` missed.
The runbook's mitigation is "stop the server first," a strictly worse and more disruptive mechanism
than what already exists in this codebase: `backupStore()` (`libs/memory-core/src/backup.ts`)
already runs `VACUUM INTO` **while the server keeps running** — `backup.ts:118`: "`VACUUM INTO` is
atomic at the SQLite page level: even with concurrent WAL writers..." — and follows it with a full
integrity verification (`backup.ts:209-211`, `verifyStoreIntegrity`). This exact defect (`cp` of a
live WAL-mode store losing recent writes) is independently tracked as
`DEBT-PROCESS-CP-SNAPSHOT-STALE-WAL-001`, which I cross-linked to the new restore-path item.
This is duplication in the strict sense requested: the manual runbook convention reinvents a
strictly worse version of a mechanism that already exists and is proven (per the bug report, "CLI
already does this correctly... verified working 2026-08-14: 'VACUUM INTO complete, integrity
verified across 6 probes'").

### Finding 5 — `libs/host-runtime/src/gc.ts` is not a fit; rejected as a reuse target

`gc.ts` performs liveness-probed cleanup of the **process supervisor registry**
(`~/.sox/supervisors.json`), not file retention: `probeEntryLiveness()` (`gc.ts:68-88`) does a
`process.kill(pid, 0)` OS-table check plus a Unix-socket connect probe; `readGlobalRegistry()`
(`gc.ts:161-177`) runs this probe lazily on every registry read and removes dead entries as a
side-effect of reading. The entire mechanism is keyed on **process liveness**, has no notion of
"file," "age," or "count," and runs opportunistically on every read rather than on any explicit or
scheduled trigger. Extending it to also prune static snapshot directories would bolt an unrelated
domain (file retention) onto process-liveness code for no shared logic. Rejected — different domain,
different trigger, different data shape.

### Finding 6 — `sink.ts`'s `_pruneOldFiles()` is the right idiom to match, but insufficient alone

`libs/observability/sox-telemetry/src/sink.ts:_pruneOldFiles()` (lines 244-270) is a good structural
precedent: an anchored filename regex (`sink.ts:249`, matching the *full* `<component>-<date>` shape
rather than a bare prefix — explicitly to avoid a collision class documented in the class doc
comment), `readdirSync` + filter + lexicographic sort (`:250-256`), then a count-cap loop that shifts
the oldest off the sorted array and `unlinkSync`s it (`:260-269`). Crucially, it runs **synchronously
inline inside the operation that just created a new file** (`_rotateSizeExceeded()`, `:221-242`), not
in a background daemon or timer. This is strong in-repo evidence for *where* pruning belongs
structurally (invoked, not scheduled) and *how* to enumerate a directory of ad hoc timestamped
artifacts safely (anchored regex, never a loose substring match). Its policy shape is insufficient by
itself: pure count-cap, no notion of class, no age floor, no "never touch the newest" invariant
beyond what the sort ordering already implies. This ADR reuses the mechanics, not the policy.

### Finding 7 — an adjacent retention gap exists in the *same* subsystem, on a *different* directory

`libs/memory-core/src/config.ts:21-42` defines `BackupConfig.retentionCount` (default `24`) for the
scheduled auto-backup written to `~/.memory/backups/` — a wholly different directory from the one
this ADR is about. `rg -n "prune|readdirSync|unlinkSync" libs/memory-core/src/backup.ts` finds only
two `unlinkSync` calls (`backup.ts:233`, `:288`), both single-file cleanup after a **failed** backup
attempt (`try { fs.unlinkSync(resolvedDst) }` around error paths) — not retention enforcement of
successful backups. `retentionCount` is a typed, documented, default-24 config field with **zero
code anywhere reading it to prune**. This is a second "designed on paper, never wired up" retention
gap in the memory-core backup subsystem, filed into `BUG-MEMORY-SNAPSHOT-NO-RESTORE-PATH-001`
alongside the restore-path gap rather than as a third separate item, since both are "retention
machinery discussed and typed but never implemented" in the same file. It is explicitly **out of
scope** for this ADR's Decision (different directory, different trigger, different config surface)
but is flagged so the two problems are not conflated during implementation.

## Decision

Design a standalone, explicitly-invoked retention tool for `~/.adhd/sox-ecosystem/memory/`,
report-first with an explicit confirm-gated apply mode, scoped only to the four validated
operation-lifecycle classes. This section states the full policy; **no code from this ADR is
implemented yet** (see Status).

### D1 — Class taxonomy: four validated classes, everything else is permanently out of scope

Only entries matching one of four anchored patterns are eligible for any automated retention logic:

| Class | Pattern (anchored, optional ticket/stage prefix) | Trigger |
|---|---|---|
| `predeploy` | `^(?:[a-z0-9]+-)?predeploy-\d{8}-\d{6}` | Before a deploy / config change |
| `prerebuild` | `^(?:[a-z0-9]+-)?prerebuild-\d{8}-\d{6}` | Before `nx build` (also `prebuild-*`, observed as `bl342-prebuild-...`) |
| `preenable` | `^(?:[a-z0-9]+-)?(?:s\d+-)?preenable-\d{8}-\d{6}` | Before `soxe service enable` |
| `prerestart` | `^(?:[a-z0-9]+-)?prerestart-\d{8}-\d{6}` | Before a service restart |

Anything not matching one of these four (per Finding 3: `bl328-live/`, `backlog-preimport-*`,
`corrections-*`, `dist-rescue-*`, `src-rescue-*`, `withdrawn-*`, `log-analysis/`, `logs/`, loose
`.mjs` scripts) is **never touched by this tool**, unconditionally, forever — not "not yet
supported," but deliberately excluded because these are heterogeneous, individually-significant
incident artifacts whose lifecycle is "keep until the owner explicitly clears it," not
count-or-age. A policy built for homogeneous disposable safety copies must not be applied to
artifacts proven (Finding 3) to be something else. If these ever need a retention policy, it is a
separate design with a different shape (owner sign-off, not time/count).

### D2 — Per-class retention: never-prune-latest, count floor, age floor, both required

For each of the four classes independently:

1. **The single most recent snapshot in a class is never eligible for pruning, unconditionally,
   regardless of age.** This is enforced twice: once as a filter (excluded from the candidate set
   before any other rule runs) and once as a runtime invariant inside the delete loop itself (assert
   the entry being deleted is not the most-recent-per-class; throw rather than silently skip if the
   assertion somehow fails — defense in depth against a bug elsewhere in the selection logic).
2. **Count floor N = 3** per class (bug report requires N ≥ 2; picking 3, not 2, specifically
   because the measured Aug 3 evidence shows three legitimate same-day snapshots — 19:06, 20:11,
   20:37 — from one deploy sequence with retries. N = 2 would make the *middle* one of a
   same-day multi-attempt sequence prunable the moment a fourth attempt lands, which is exactly the
   "still-relevant, still same incident window" case the bug report's safety framing warns against.
3. **Age floor: 14 days.** The bug report's own evidence ("12 days old... safe to prune") describes
   an observed instance, not a mandate for 12 as the threshold; I am setting the floor higher than
   the observed-safe case specifically because the stated cost asymmetry (bounded disk cost vs.
   unbounded data-loss cost) means the floor should be conservative, not the minimum defensible
   number. 14 days is also stated explicitly in this document rather than left as an implicit
   default, per the instruction not to leave the bias implicit.
4. **A snapshot is eligible for pruning only when ALL of the following hold:** it is not the
   class's most-recent; strictly more than `N=3` newer siblings exist in its class; and its age
   exceeds 14 days. All three conditions are independent AND-gated — none alone is sufficient.

### D3 — In-flight / concurrency safety: time-based settling, not invented locking

These directories are plain filesystem copies (not open SQLite connections), so there is no
existing lock primitive to check. Rather than inventing new IPC or a lock file (which nothing else
writing to this directory would honor anyway, since Finding 1 established there is no shared
writer to cooperate with), the design uses:

1. **The 14-day age floor already excludes anything recently written** by a wide margin — nothing
   "5 minutes before a migration in flight" can ever reach the age floor.
2. **A separate, much shorter "settling window" (10 minutes) governs the *report* step itself**,
   independent of the prune eligibility rule: any entry whose mtime is within 10 minutes of "now"
   at query time is excluded from class enumeration entirely (not counted toward the count floor,
   not eligible to be "most recent" for D2's protection rule, not shown as prunable or safe) — so a
   `cp -r` still in progress when the report runs is never partially counted in either direction.
3. **Immediately before any actual delete, re-`stat` the target directory and abort that single
   deletion (not the whole run) if its mtime changed since the report was generated** — narrows,
   without eliminating, the TOCTOU window between "decided to delete" and "deleted."
4. These are deliberately weaker guarantees than a real lock. That is an accepted tradeoff given
   D4/D5 below: the tool never deletes without a human running `--apply --confirm` and reviewing
   the printed list first, so the settling window only needs to cover the gap between the report
   being generated and a human confirming it — not indefinite unattended safety.

### D4 — Report-first; automatic apply is rejected

Default invocation only reports: class, live count, protected-most-recent, kept-under-floor,
eligible-for-prune (with age/count reasons), and explicitly-out-of-scope entries. Deletion requires
a second, explicit `--apply --confirm` invocation that **re-prints the exact list** immediately
before deleting and refuses to run if the list is empty or would ever include a class's most-recent
entry (the D2 defense-in-depth check). No cron, no launchd timer, no wiring into any deploy/rebuild
step. Reasons, argued rather than merely asserted per the instruction:

- Finding 2 makes automatic deletion premature on its own: the safety case for keeping these files
  at all is currently unverified until a restore path exists (see D5). Automating deletion of the
  one thing you'd reach for in a corruption incident, before proving you can use it, inverts the
  stated cost asymmetry.
- Finding 1 means there is no natural, already-existing hook point to attach automatic pruning to —
  building one means inventing the writer and the pruner in the same change, which couples a new
  destructive capability to a new creation capability with no operational track record on either.
- ADR-0013 D4 ("one-shot operator actions are explicit invocations, never env-gated") is direct
  precedent in this codebase for treating destructive-adjacent, judgment-requiring actions as
  explicit human invocations rather than ambient/automatic behavior. Deleting the artifact whose
  entire purpose is disaster recovery is exactly this class of action.
- This repo runs many concurrent agents routinely (per repo CLAUDE.md); D3's settling-window
  approach is adequate for a human-gated apply reviewed shortly after a report, but is not strong
  enough to trust as a background/automatic trigger with no one reading the list first.

### D5 — Hard prerequisite: do not exercise `--apply` before a restore path exists

Because Finding 2 established these snapshots are currently write-only, this ADR's Decision
explicitly states: **`--apply` must not be run against production data until
`BUG-MEMORY-SNAPSHOT-NO-RESTORE-PATH-001` has at least a documented, exercised (not just written)
restore procedure** — even a manual one, as long as someone has actually restored a snapshot to a
scratch location and run `integrity_check` against it. `--report` mode has no such prerequisite and
can land and run immediately once implemented.

### D6 — Recommend (not implement) migrating db-bearing snapshot capture to `VACUUM INTO`

Per the bug report's ask #3 and Finding 4: future snapshot *creation* (a separate piece of work
from this ADR's *retention* tool — Finding 1 established no creation code exists to migrate today)
should capture the SQLite portion via `backupStore()`/`VACUUM INTO` rather than `cp`, eliminating
the "must stop the server" caveat and gaining integrity verification for free. This can't be a
wholesale swap: `backupStore` is allowlisted to `~/.memory/**`
(`isPathInMemoryAllowlist`, `backup.ts:105`, enforced `:144-156`), and `prerebuild` snapshots
(Finding 3) also capture non-db artifacts (`dist/`, plist) that VACUUM INTO cannot touch and that
have no natural home under `~/.memory/**`. Recommended split for a future creation tool: db portion
via `VACUUM INTO` under an allowlist-extended `~/.memory/snapshots/<class>/<ts>/memory.db`;
non-db artifacts continue as plain `cp -r` under `~/.adhd/sox-ecosystem/memory/<class>-<ts>/`. The
retention tool designed in D1-D4 is agnostic to which mechanism produced a given directory — it
only reasons about directory names and mtimes — so this migration can happen independently, before
or after the retention tool ships, without changing the retention policy itself.

### D7 — Tool shape and location

`tools/snapshot-gc.mjs`, matching this repo's existing convention for explicit, dry-run-default
operational scripts (`tools/commit-mine.mjs`, `tools/unstage-orphans.mjs` — both report-by-default,
require an explicit apply flag, and print exactly what would change before changing it). Not a new
pattern; matching an established one.

## Alternatives considered

1. **Extend `libs/host-runtime/src/gc.ts`.** Rejected — Finding 5: wrong domain (process liveness
   vs. static files), wrong trigger (opportunistic-on-read vs. explicit), no shared logic worth
   factoring.
2. **Automatic pruning on a schedule (cron/launchd timer).** Rejected per D4: no restore path yet
   (Finding 2), no existing hook to attach to (Finding 1), and direct in-repo precedent (ADR-0013
   D4) against ambient automatic behavior for judgment-requiring destructive actions.
3. **Prune from inside the (currently nonexistent) creation call, i.e. "next snapshot deletes old
   ones."** Rejected — there is no single writer to hook (Finding 1); inventing the writer and the
   pruner together means a bug in the new writer (e.g., a partial `cp -r` failure) could delete the
   last-known-good copy before the new one is verified. Creation and retention should ship and be
   verified independently.
4. **Pure age-based pruning, no count floor.** Rejected — violates the bug report's explicit
   `N >= 2` constraint and Finding 3's Aug-3 evidence: an age-only rule with a short floor would
   have pruned below any safety margin the moment three same-day snapshots existed.
5. **Move all snapshot creation to `backupStore`/`VACUUM INTO` immediately and drop the `cp`-based
   convention outright, as part of this change.** Not rejected outright — folded into D6 as a
   recommendation for the (separate, unbuilt) creation path — but not adopted as *this* ADR's
   Decision because it conflates two different problems (creation mechanism vs. retention policy)
   that Finding 1 already showed have no code coupling today, and because `VACUUM INTO` alone
   cannot capture the non-db artifacts (`dist/`, plist) that at least the `prerebuild` class
   depends on (Finding 3).

## Consequences

**Positive:** bounded disk growth going forward once `--apply` is actually run; an explicit,
auditable report of what exists and why each entry is or isn't eligible, replacing "browse the
directory by hand"; zero risk of auto-deleting the wrong thing, because nothing is automatic.

**Negative:** does not reclaim any space on its own — a human has to run `--apply --confirm` at
least once, possibly repeatedly, for the 1.4GB to shrink. The heterogeneous incident-artifact
directories (Finding 3: `bl328-live/`, `corrections-*`, `dist-rescue-*`, `src-rescue-*`,
`withdrawn-*`) remain permanently unmanaged by this tool by design and will need a human to
periodically review and archive or delete by hand — this ADR does not solve that, and says so
rather than silently leaving it out.

**Prerequisite (blocking, not optional):** per D5, `--apply` may not be exercised in production
until `BUG-MEMORY-SNAPSHOT-NO-RESTORE-PATH-001` has at least one proven manual restore. This is a
sequencing constraint on implementation, not on this ADR's approval — the report-only path has no
such dependency.

**Related, explicitly out of scope for this ADR:** `BackupConfig.retentionCount`
(`libs/memory-core/src/config.ts:21-42`) governs a *different* directory (`~/.memory/backups/`) and
is separately unenforced (Finding 7, tracked in `BUG-MEMORY-SNAPSHOT-NO-RESTORE-PATH-001`). Do not
conflate its implementation with this ADR's `tools/snapshot-gc.mjs` — they operate on different
paths with different triggers.

## Acceptance tests (for the eventual implementation, not run here — design only)

1. **Most-recent-never-pruned, unconditionally regardless of age:** seed a class with one entry
   dated 60 days old and no siblings; assert `--report` marks it `protected` (not `eligible`) and
   `--apply --confirm` on the full eligible set leaves it on disk. Repeat with 10 siblings all older
   than the age floor — the single most-recent of the 11 must still survive.
2. **Count floor holds under a same-day burst:** seed a class with 3 entries all timestamped within
   one hour, all older than the age floor; assert zero are eligible (count floor of 3 not yet
   exceeded). Add a 4th, older-than-floor entry; assert exactly one (the oldest) becomes eligible.
3. **Age floor holds independent of count:** seed a class with 10 entries, all younger than 14 days;
   assert zero are eligible regardless of count.
4. **Unclassified directories are never touched:** seed `bl328-live/`, `corrections-20260101/`, and
   a directory with no recognized prefix alongside a fully-eligible `predeploy-*` entry; run
   `--apply --confirm`; assert only the `predeploy-*` entry's eligible members are affected and the
   three non-matching directories are byte-for-byte untouched (mtime unchanged).
5. **Label-format tolerance:** assert `predeploy-20260803-190609`, `bl331-predeploy-20260731-180139`
   both classify as `predeploy`; assert `s5-preenable-20260731-182303` and a hypothetical
   `preenable-20260801-000000` both classify as `preenable`.
6. **Settling window excludes just-written entries from both protection and eligibility:** create an
   entry with mtime `now - 2 minutes`; assert `--report` excludes it entirely from its class's
   enumeration (not shown as protected, not shown as eligible, not counted toward the count floor).
7. **Report/apply divergence guard:** generate a report, then (simulating a concurrent write) touch
   one of the entries slated for deletion between report and apply; assert `--apply --confirm`
   skips exactly that entry (does not delete it) and reports why, while proceeding with the
   remaining unaffected entries.
8. **Runtime invariant fires on a deliberately corrupted candidate list:** construct a test harness
   that injects a class's most-recent entry into the delete list directly (bypassing the normal
   filter, simulating a hypothetical future bug in selection logic); assert the delete loop throws
   rather than deleting it.
9. **`--apply` without `--confirm` is a no-op:** assert running `--apply` alone performs zero
   filesystem mutations and exits non-zero with a message pointing at `--confirm`.
10. **Empty eligible set refuses cleanly:** with only protected/under-floor entries present, assert
    `--apply --confirm` reports "nothing to prune" and performs zero mutations, rather than silently
    succeeding in a way indistinguishable from "pruned everything eligible."
