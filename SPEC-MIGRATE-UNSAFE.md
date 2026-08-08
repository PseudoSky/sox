# SPEC — BUG-STOREADAPTER-MIGRATE-UNSAFE-001

Architect: stage 1 of architect → implementer → reviewer → implementer → reviewer.
Worktree: `/Users/nix/dev/ai/sox-ecosystem/.worktrees/migration-fails-open`, branch `feat/migration-fails-open`.

All line numbers below were verified by opening the file at the current worktree HEAD
(605a96c1, `main`) on 2026-08-08 — not taken from the backlog item text.

## 1. Root cause

`migrateStore()` is architected as "copy everything, never stop, record what happened" —
but the thing it hands back never lets a caller *read* what happened without independently
inspecting `tables[*].errored` on every key, and the one caller that exists
(`scripts/migrate-store-to-turso.mjs`) doesn't do that either. Two independent gaps compound:

1. **Per-table isolation with no result-level rollup.** Every regular-table copy is inside
   its own `try { ... } catch (err) { result.tables[tableName] = { rows: 0, errored: true,
   error: msg }; }` with no `throw` — confirmed at
   `libs/data/store/store-adapter/src/migration.ts:444-531` (regular tables, catch at
   526-529), `:533-565` (FTS tables, catch at 560-563), and `:569-613` (vec_node, catch at
   608-611). The outer `for` loop always continues to the next table
   (`libs/data/store/store-adapter/src/migration.ts:390`, `:444`). `_adapter_meta` is then
   stamped unconditionally at `:617-621` regardless of any prior error — the migration
   "completes" by definition, success or not.

2. **No summary field encodes that.** `MigrationResult` (`migration.ts:42-48`) is
   `{ tables, totalRows, sourceType, targetType, elapsedMs }` — no `ok`, no `errored`, no
   count of failed tables. A caller must loop `Object.values(result.tables)` and check
   `.errored` on each one itself. Nothing forces that.

3. **The one real caller doesn't do that loop.** `scripts/migrate-store-to-turso.mjs:274-285`
   builds its output object with
   `ok: values.verify ? (verifyOk ?? false) : (result.totalRows > 0)` — it reads
   `result.totalRows` (a row *count*, sums across every table including the failed ones'
   `rows: 0`) and, only when `--verify` is passed, a row-count parity check. It never touches
   `result.tables`. Confirmed: `values.verify` defaults to `false` at `migrate-store-to-turso.mjs:133`
   (`verify: { type: 'boolean', default: false }`), and every one of the script's own
   `--help` usage examples (`:33-46`) omits `--verify`. So the default path for a first-time
   operator is: sum row counts, ignore errors, report `ok` on `totalRows > 0`. One dead
   table among several healthy ones is invisible.

4. **No backup, anywhere.** `grep -n backupTo scripts/migrate-store-to-turso.mjs` — zero hits.
   `grep -n backupStore libs/data/store/store-adapter/src/*.ts` — zero hits (confirmed; the
   package has no backup concept of its own). In `--mode in-place`
   (`migrate-store-to-turso.mjs:218-224`), the Turso **target** adapter is opened on
   `values.source` — literally the same path the SQLite **source** adapter is reading from
   (`source = createSqliteAdapter({ dbPath: values.source, readonly: true })` at `:222`,
   `target = await createTursoAdapter({ dbPath: values.source })` at `:224`). If any table
   or the vec_node phase throws partway through — defect #1 above swallows it and keeps
   going — the only copy of the source has already been partially overwritten, with nothing
   to restore it from.

`libs/memory-core/src/backup.ts:125-293`'s `backupStore()` already solves "safely snapshot a
store before a risky operation" (VACUUM INTO + integrity verification, delete-on-damaged) —
but it is unusable here: `data → memory-core` is a forbidden import direction
(`libs/data/CLAUDE.md` "Boundary rules"), and `backupStore()` hard-allowlists both paths to
`~/.memory/**` (`backup.ts:103-108`), which a generic migration script must not assume. The
primitive it's built on, however, is *not* memory-core-only: `StoreAdapter.backupTo()`
(`libs/data/store/store-adapter/src/types.ts:325`, implemented at
`sqlite-adapter.ts:213-243` and `turso-adapter.ts:433-...`) lives in store-adapter itself,
takes an arbitrary `destPath`, and returns the same `AdapterBackupResult` shape
(`integrityCheck` / `integrityReport`) that `backup.ts` already knows how to interpret. This
is the mechanism to use — see §3 Decision 2.

## 2. The change, file by file

### `libs/data/store/store-adapter/src/migration.ts` — IN SCOPE

- Add `ok: boolean` and `erroredTables: string[]` to `MigrationResult` (§3 Decision 1).
- Compute both right before `return result;` (currently line 626), from `result.tables`
  only — never from `totalRows`.
- **Do NOT change the per-table catch-and-continue control flow.** Leave 444-531, 533-565,
  569-613 exactly as they are (§3 Decision 3 rules out abort-and-rollback). The only change
  in this file is the addition of the two summary fields and the code that derives them.
- **Do NOT touch `stampAdapterMeta`/§6 (615-621).** Stamping `migrated_from`/`migrated_at`
  even on a partially-failed run is correct and out of scope — it's a provenance fact
  ("a migration attempt touched this target at this time"), not a success claim. `result.ok`
  is the success claim; conflating the two would be a second field encoding the same bug in
  a new place.

### `scripts/migrate-store-to-turso.mjs` — IN SCOPE

- Change `verify`'s `parseArgs` default from `false` to effectively `true`: keep
  `verify: { type: 'boolean', default: true }` and add a new `'no-verify': { type: 'boolean',
  default: false }`, then compute `const verify = values.verify && !values['no-verify'];`
  (§3 Decision 4 — Node's `util.parseArgs` does **not** auto-negate a `default: true` boolean
  via `--no-x`; do not assume it does, confirm by reading the flag with `--no-verify` passed
  and asserting `values['no-verify'] === true` before relying on it).
- Add a mandatory pre-migration backup step (§3 Decision 2) gated by a new
  `'no-backup-i-understand-the-risk': { type: 'boolean', default: false }` flag, positioned
  in `main()` **before** the "Create adapters based on mode/direction" block
  (`migrate-store-to-turso.mjs:212` today) — specifically before `target` is ever created,
  because in `--mode in-place` creating `target` opens a second connection onto the same file
  `source` is about to be read from (§1.4). Exact placement and logic in §3 Decision 2/5/6.
- Rewrite the `ok` computation at `:274-285` to read `result.ok` (never `result.totalRows`)
  combined with the verify outcome (§3 Decision 7's exact formula).
- Add `backup_path` (string | null) and `verify_skipped_reason` (string | undefined) to the
  output JSON object so an operator can see, in the one line the script prints, whether a
  backup was taken and whether verify actually ran.
- Guard the bottom-of-file `main();` call so the module is importable by a test without
  executing the CLI (§3 Decision 8): change the unconditional `main();` (currently line 302)
  to
  ```js
  if (import.meta.url === `file://${process.argv[1]}`) {
    main();
  }
  ```
  and add `export { main, computeFinalOk, resolveBackupDecision };` (or equivalent named
  exports — see §3 Decision 8 for exact function boundaries) so the acceptance-criteria test
  can import and unit-test the pure logic without spawning a subprocess or touching a real
  Turso connection.
- **Do NOT change `verifyParity()`'s row-count-only semantics or its remote-Turso-URL skip**
  (`:66-122`, `:74-77`). Extending it to check the vec_node-per-episode invariant, or to run
  against remote Turso targets, is explicitly out of scope — see §3 Decision 9.
- **Do NOT add idempotency / `INSERT OR IGNORE`/upsert semantics.** Out of scope — see §3
  Decision 10.

### Files that are OUT OF BOUNDS — do not touch

- `libs/memory-core/src/backup.ts` — this packet does not call it, does not change its
  allowlist, does not change its signature. `data → memory-core` stays a one-way, forbidden-
  reverse boundary; the fix in this packet lives entirely inside `store-adapter` (a `data`
  package) and the CLI script, which is allowed to depend on it.
- `libs/data/store/store-adapter/src/sqlite-adapter.ts` / `turso-adapter.ts` — `backupTo()`
  is already correct and already tested (`__tests__/backup-verdict.bl341-bl449.test.ts`).
  Reuse it verbatim; do not modify its integrity-check semantics as a side effect of wiring
  it into the script.
- `libs/data/store/store-adapter/src/types.ts` — `AdapterBackupResult`/`AdapterBackupOptions`
  already have the shape needed (`integrityReport.status`). No new fields required.
- Any file under `extensions/` or `libs/memory-core/` beyond what's named above. This bug is
  fully contained in `store-adapter` + the one CLI script that calls it.

## 3. Every decision, ruled

**Decision 1 — Where does `ok` live?**
Add `ok: boolean` to `MigrationResult` itself (library layer, `migration.ts`), computed as
`Object.values(result.tables).every((t) => !t.errored)`, not only at the CLI layer.
*Losing alternative:* compute `ok` only inside `migrate-store-to-turso.mjs`, leave
`MigrationResult` unchanged. **Loses** because the backlog item's own defect #2
("`MigrationResult` has no `ok` field") is filed independently of defect #4 (the CLI's
wrong formula) — the published package (`@adhd/sox-store-adapter@0.3.0`, live on npm) is
consumed directly by callers other than this script (the item's own motivating fact: "a
downstream consumer... is expected to adopt `@adhd/sox-store-adapter` next", now shipped as
of 2026-08-07). Fixing only the CLI leaves the exact same footgun for every future direct
caller of `migrateStore()`.

**Decision 2 — Where does backup live: inside `migrateStore()`, or in the CLI script?**
In the CLI script (`scripts/migrate-store-to-turso.mjs`), calling `source.backupTo(backupPath)`
directly — not inside `migration.ts`.
*Losing alternative A:* add a `backupPath` option to `MigrationOptions` and have
`migrateStore()` back up internally. **Loses** because `migrateStore()`'s documented contract
(`migration.ts:1-8`) is "the caller opens (and closes) both adapters... this keeps the
function testable without path/driver concerns" — it operates on two already-open
`StoreAdapter` instances and is deliberately blind to filesystem paths and to which adapter
is "the real source" vs "a throwaway test fixture". By the time `migrateStore(source, target)`
is called in `--mode in-place`, `target` (Turso, opened on the same path as `source`) already
exists and may already have touched the file — backing up *after* that point is too late.
The backup must happen before `target` is created at all, which only the CLI (which owns
adapter construction) can sequence correctly.
*Losing alternative B:* route through `libs/memory-core/src/backup.ts`'s `backupStore()`.
**Loses** on two independent grounds: (a) `data → memory-core` is a forbidden import
direction for `store-adapter`, and while the *script* isn't itself a `data` package and could
technically import `memory-core`, doing so pulls a domain-composer dependency into a script
whose only job is to shell out to a generic adapter package, for no benefit; (b)
`backupStore()` hard-allowlists both paths to `~/.memory/**` (`backup.ts:103-108`, checked
via `isPathInMemoryAllowlist`) — this migration script is explicitly general-purpose (its own
usage examples pass `data/memory.db`, `data/memory-turso.db`, arbitrary Turso URLs), so an
allowlist scoped to the live production store directory would break every non-`~/.memory`
invocation, including this packet's own test fixtures.

**Decision 3 — Fail-closed (abort-and-rollback) vs. complete-then-report-honestly vs.
complete-into-a-copy-and-swap.**
**Chosen: complete-then-report-honestly**, i.e. keep the existing per-table
catch-and-continue *execution* semantics, but make the *reporting* fail closed (`ok:false`
whenever anything errored) and make a pre-migration backup mandatory so "complete" is always
recoverable.
*Losing alternative A — abort-and-rollback:* the moment any table errors, undo everything
copied so far and leave the target untouched. **Loses**, at this packet's scope, for a
structural reason, not a preference: by the time a table 3-of-12 errors, tables 1-2 have
already been committed to `target` in their own per-batch transactions
(`migration.ts:507-520`, one `target.transaction(...)` per `batchSize`-row chunk — not one
transaction for the whole migration). "Rollback" would require either (a) wrapping the
*entire* multi-table, batched copy in one cross-table transaction, which most backends
(certainly Turso's own transaction model, `types.ts` transaction modes) are not built to hold
open for a large multi-GB store migration, or (b) deleting/dropping every table already
created on `target` after the fact, which for `--mode in-place` means DROPping tables on
the *source file itself* — actively more destructive than what defect #1 already does today.
Neither is a contained fix; both are a second migration-safety subsystem. And critically, it
still wouldn't fix `--mode in-place`'s core hazard (target IS source) — only a backup does
that, so abort-and-rollback doesn't even let this packet skip the backup requirement; it just
adds cost on top of it.
*Losing alternative B — complete-into-a-copy-and-swap:* for `--mode in-place`, instead of
opening the Turso target directly on `values.source`, always migrate into a shadow path
(`values.source + '.turso-swap'`) and atomically rename it over `values.source` only on
success. **Loses on scope, not correctness** — it is arguably the more elegant fix for the
in-place hazard specifically, and if a future packet wants to build it, the mandatory backup
this packet adds does not block it. But it requires re-plumbing adapter construction (shadow
path allocation, cleanup-on-failure, Turso's on-disk file semantics — WAL/shm sidecars — under
an atomic rename, and doing the equivalent for the *forward, non-in-place* path so the two
modes don't diverge in safety guarantees) — surface well beyond a bug-fix packet sized at
~26 turns. The mandatory backup delivers the same recovery guarantee (restore from the
pre-migration snapshot) at a fraction of the implementation risk, and is what the backlog
item's own fix sketch and acceptance criteria ask for ("with backup wired in, the original
source file is provably restorable to its pre-migration state" — this is a backup-and-restore
acceptance bar, not a copy-and-swap one).

**Decision 4 — `--verify` default.**
Default to **on** (`true`), with an explicit `--no-verify` escape hatch. Confirmed
`util.parseArgs` requires this to be hand-rolled: there is no built-in auto-negation of a
`default: true` boolean via a `--no-x` flag in Node's `parseArgs` — declare a *second*,
independent `'no-verify'` option and AND it against `verify` in code (see §2). Do not assume
the implicit negation exists; if it turns out `parseArgs` in the Node version this repo runs
does support it, that's a bonus, not a requirement — the explicit AND is correct either way
and doesn't regress if the assumption is wrong.
*Losing alternative:* leave `--verify` opt-in, just fix the `ok` formula. **Loses** because
the backlog item's fix sketch is explicit ("Make `--verify` (or an equivalent post-migration
check) the DEFAULT, not opt-in") and the whole point of this packet is that a first-time
operator following the script's own `--help` examples currently gets zero verification — an
opt-in default doesn't change that population's behavior at all, only power users who already
knew to pass the flag.

**Decision 5 — When is backup mandatory?**
Whenever the resolved **source** is a local file path (i.e. `!isTursoUrl(values.source)`),
regardless of `--mode` or `--direction`. Skipped (no-op, not an error) when source is a
remote Turso URL — there is no local file for `backupTo()`'s `VACUUM INTO` to snapshot.
*Losing alternative A:* only require backup for `--mode in-place` (the mode that literally
reuses the source path as the target path). **Loses** because the backlog item's fix sketch
explicitly says "mandatory pre-step before any **in-place or forward** migration" — forward
(`--mode copy`, `--direction forward`, the common go-live path) is named too, even though the
source is opened `readonly: true` there and copy-mode alone cannot corrupt it. Treating backup
as unconditional-for-any-local-source is simpler to reason about operationally ("a migration
always has a snapshot to fall back to, no exceptions except an explicit override") than a
mode-conditional rule an operator has to remember.
*Losing alternative B:* require backup even for remote-Turso sources by pulling a full remote
snapshot down first. **Loses** — out of scope; nothing about this bug concerns remote-source
data loss (the remote store is never written to by this script in `--direction forward`), and
building a remote-Turso-to-local-file snapshot mechanism is a different, larger feature than
"stop reporting false success."

**Decision 6 — What gates proceeding, once a backup is attempted?**
Mirror `backup.ts`'s existing policy exactly: `integrityReport.status === 'damaged'` → delete
the backup file and **abort the migration** (exit 1, `migrateStore()` is never called).
`integrityReport.status === 'unverified'` → **keep the backup, warn loudly to stderr, and
proceed** — do not block on "could not verify", only on "verified broken". If
`integrityReport` is `undefined` (shouldn't happen — this script never sets
`skipIntegrityCheck`), fall back to `integrityCheck !== 'ok'` as the damaged test, matching
`backup.ts:225-226`'s own fallback.
*Losing alternative:* block on `unverified` too (fail closed on any non-`ok` verdict).
**Loses** because `backup.ts`'s own doc comment (`backup.ts:217-223`) explains exactly why
not: blocking on unverified makes small or noisy stores permanently unbackupable (the
non-convergence trap the comment names as BL-360) — nothing was found broken, something
merely couldn't be checked. Diverging from the sibling implementation's already-reasoned
policy, in the same repo, for no new information, is not defensible.

**Decision 7 — Final `ok` formula in the CLI script.**
```js
const ok = result.ok && (verifyOk === false ? false : true);
```
i.e.: `ok` is `false` if any table errored (`result.ok`, from Decision 1) — unconditionally,
whether or not verify ran — AND `false` if verify *ran and found a mismatch*
(`verifyOk === false`). A skipped verify (`verifyOk === undefined`, e.g. because
`--no-verify` was passed, or `verifyParity` no-oped on a remote Turso URL) does **not**
independently flip `ok` to `false` — it is surfaced separately via the new
`verify_skipped_reason` field (§2) so the operator can tell "verified and clean" apart from
"not verified, here's why" apart from "verified and broken", instead of collapsing all three
into one boolean the way the current code already does with `verifyOk ?? false`.
*Losing alternative:* also require `result.totalRows > 0` for `ok`, as the current code does
in its non-verify branch. **Loses explicitly per the architect brief**: "`ok` must be derived
from whether anything errored, never from a row count." A legitimately empty source store
(zero rows, zero errors) must report `ok: true`; requiring `totalRows > 0` produces a false
negative for that case and is exactly the class of "plausible number that doesn't mean what a
reader assumes" this packet exists to eliminate.
*Losing alternative:* treat `verifyOk === undefined` as a failure (`ok: false`) whenever
`verify` was requested but couldn't run. **Loses** because that would make the *new* default-on
verify (Decision 4) turn every remote-Turso-target migration into an automatic reported
failure even when nothing is wrong — a regression for the one population (Turso go-lives)
this bug report is centrally about. Surfacing the gap honestly (a distinct field) beats
manufacturing a false negative to compensate for a capability gap (Decision 9) this packet
isn't fixing.

**Decision 8 — Testability: what gets extracted and exported from the `.mjs` script.**
Export three things as named exports, and guard the bottom-of-file `main()` invocation
(§2) so importing the module for tests never runs the CLI:
- `computeFinalOk(result, verify, verifyOk)` — the pure function implementing Decision 7's
  formula. Signature: `(result: MigrationResult, verify: boolean, verifyOk: boolean | undefined) => boolean`.
- `resolveBackupDecision(sourcePath, noBackupOverride)` — pure function implementing
  Decision 5: returns `{ shouldBackup: boolean, reason?: string }`.
- `main` itself (already effectively exported by being the only top-level function — make it
  an explicit named export instead of an anonymous invocation) so an end-to-end test can call
  it directly with a monkeypatched `process.argv`/`process.exit`, if the reviewer/implementer
  judges a full-`main()` test worth the trouble; not required by the acceptance criteria
  below, which only need `computeFinalOk`.
*Losing alternative:* test only via `child_process.spawnSync` on the real script. **Loses**
on turn budget — spawning a real subprocess against real SQLite/Turso fixture files for every
assertion (including the RED-arm assertion, which must run *before* the fix exists) multiplies
the cost of every test iteration for no coverage benefit over a direct unit test of the pure
formula, given `computeFinalOk` contains 100% of the logic defect #4 is about. A subprocess
E2E test remains valuable defense-in-depth but is not the vehicle for the BL-ID-named
acceptance test itself (see §4).

**Decision 9 — Deep vec_node/episode-completeness verification (fix sketch bullet: extend
verify "for vec_node specifically, verify every live episode with content has a
corresponding non-null vec_node row").**
**Out of scope for this packet.** `store-adapter` is deliberately domain-agnostic — it knows
about tables and rows, not "episodes" or "content" (that's `memory-core` vocabulary, and
`libs/data/CLAUDE.md`'s boundary rules forbid `data → memory-core`). Building an
episode-aware invariant check inside a generic migration script would either (a) violate that
boundary by importing memory-core schema knowledge into `store-adapter`'s consumer script, or
(b) hardcode `memory-core`'s current schema (an `episode`/`node` table shape, a `content`
column) into a script that's supposed to work for any store shape. This is real, valuable
follow-on work — but it is a distinct feature (schema-aware verification) layered on top of
the fail-open bug class this packet closes, and the architect brief's curated four-defect list
(catch-and-continue, no `ok` field, `--verify` opt-in default, `ok` from row count) does not
include it. File it as a follow-up backlog item at implementation time if not already tracked
(check for an existing item first, per the dedupe-before-filing house rule) rather than
silently expanding this packet's scope.

**Decision 10 — Idempotency / `INSERT OR IGNORE` / retry-safety.**
**Out of scope for this packet**, for the same reason as Decision 9: not in the architect
brief's four-defect list, and the mandatory backup (Decision 2/5) already gives an operator a
recovery path after a partial failure (restore from the pre-migration snapshot, fix whatever
made the table error, re-run against the restored source) without this packet also having to
design upsert semantics across two SQL dialects (SQLite `INSERT OR IGNORE` vs. Turso's
libsql dialect) that the current `migrateStore()` doesn't attempt at all today. File as a
follow-up if not already tracked.

## 4. Acceptance criteria (each names a BL-id — this packet's id throughout: BUG-STOREADAPTER-MIGRATE-UNSAFE-001)

For every criterion: RED = what must fail *before* your fix exists (i.e., against the
`migration.ts`/`migrate-store-to-turso.mjs` exactly as read in §1); GREEN = what must pass
after.

1. **`MigrationResult.ok` reflects per-table errors, not row counts — library layer.**
   Test (new, in `libs/data/store/store-adapter/src/__tests__/migration.test.ts`, name it
   with the BL-id in the `it(...)` description): migrate a source with 2 healthy tables and 1
   table whose `columnTransforms` entry throws (reuses the existing `columnTransforms` option,
   `migration.ts:31`/`:502`/`:512` — no new test infrastructure needed; a transform function
   that does `throw new Error('BUG-STOREADAPTER-MIGRATE-UNSAFE-001 forced failure')` for the
   third table forces exactly the `catch` at `:526-529` to fire on that table while the other
   two commit normally).
   - Assert `result.tables['badTable'].errored === true`.
   - Assert `result.totalRows > 0` (the other two tables copied — this is the "one dead table
     is invisible among healthy ones" shape from §1.3).
   - Assert `result.ok === false`.
   - **RED arm:** run this test against the current `migration.ts` (no `ok` field at all) —
     it fails to compile/fails the assertion because `result.ok` is `undefined`, not `false`.
     Confirm this by temporarily reading the field with `// @ts-expect-error` removed or by
     running the test file before the interface change lands; do not skip this step because
     "obviously" adding a missing field is red — TypeScript will refuse to compile a test that
     references a field that doesn't exist yet, which the implementer must SEE happen (a
     compile failure counts as the required RED, but only if actually run and observed).
   - **GREEN arm:** after adding `ok` to the interface and computing it correctly, this test
     passes and `result.tables['badTable'].errored === true` remains true (the execution
     semantics did not change per Decision 3 — only the reporting did).

2. **`ok` is false with `errored` tables even when `totalRows > 0` — the exact inversion at
   the CLI's old `:275`.** Test (new, `scripts/migrate-store-to-turso.test.ts` or similarly
   named, runs under `npx nx test sox-ecosystem` per `vitest.config.ts`'s
   `include: ['scripts/**/*.test.ts']`): call the exported `computeFinalOk(result, verify,
   verifyOk)` directly with a hand-built `MigrationResult` where `ok: false` (one table
   errored) and `totalRows: 500` (other tables succeeded) and `verify: false`,
   `verifyOk: undefined`.
   - Assert `computeFinalOk(...) === false`.
   - **RED arm:** before this fix, the equivalent inline expression in the script was
     `values.verify ? (verifyOk ?? false) : (result.totalRows > 0)` — evaluated with the same
     inputs (`verify: false`, `totalRows: 500`) that expression returns `true`. Write the RED
     assertion as a comment or a second, explicitly-marked "regression" test that evaluates
     the OLD formula inline (`values.verify ? (verifyOk ?? false) : (result.totalRows > 0)`,
     copied verbatim as a local const expression, not re-imported) against the same fixture
     and asserts it returns `true` — proving the old code's answer was wrong, before asserting
     the new code's answer is right. This makes the inversion itself part of the permanent
     regression suite, not just a historical artifact in this spec.
   - **GREEN arm:** `computeFinalOk` (the shipped implementation) returns `false` for the
     same input.

3. **Mandatory backup is provably restorable — `--mode in-place`, the acute hazard from §1.4.**
   Test (new, integration-style, in `scripts/migrate-store-to-turso.test.ts`, using a real
   temp SQLite file — **never** any path under `~/.memory/**`, per the Hazards section of the
   architect brief and this spec's §5):
   - Build a small SQLite fixture file with a couple of tables and rows.
   - Call `resolveBackupDecision(fixturePath, /* noBackupOverride */ false)` and assert
     `shouldBackup === true`.
   - Run the actual backup path (either by calling `main()` with `process.argv` set to
     `--mode in-place --source <fixturePath>` and intercepting `process.exit`, or by directly
     exercising whatever backup helper function the implementer factors the "open source
     adapter, call `backupTo`, check `integrityReport.status`" sequence into — implementer's
     choice, but it must be a named, individually-testable function per Decision 8's spirit).
   - Assert a backup file exists at the path the implementation chose (per §2's requirement
     to surface `backup_path` in the output — the test can read that field back).
   - Assert the **original fixture file's row data is byte-identical / row-identical** to what
     it was before the migration ran, by reading rows from the backup file directly with
     `better-sqlite3` and comparing them to a snapshot taken before the migration call.
   - **RED arm:** run the equivalent flow against the current script — no backup file is ever
     created (grep the working directory for any new file matching the chosen naming
     convention; there will be none), so the "provably restorable" assertion has nothing to
     assert against and fails by construction (file-not-found).
   - **GREEN arm:** backup file exists, is a valid SQLite file (openable), and its row content
     matches the pre-migration snapshot.

4. **`--verify` runs by default.** Test: invoke the flag-parsing logic (or `main()` with
   `process.argv` intercepted) with no `--verify`/`--no-verify` flag at all, against a small
   forward-mode fixture (SQLite → local-file Turso, both openable without a remote server —
   `migration-e2e.test.ts` already does this pattern; reuse it). Assert `verifyParity` (or
   whatever wraps it) actually executed — e.g. via a spy/mock replacing `verifyParity`, or by
   asserting `verify_skipped_reason` is absent/undefined and `verify_ok` is a defined boolean
   in the output.
   - **RED arm:** run the same invocation against the current script — `values.verify` is
     `false` by default (`migrate-store-to-turso.mjs:133` today), so the verify branch
     (`:268-271` today) never executes; assert (against the pre-fix code, or by inspecting
     `parseArgs`'s declared default directly) that the default is `false`.
   - **GREEN arm:** default is `true`; verify actually runs; `--no-verify` suppresses it
     (assert that explicitly too — the escape hatch must work, not just the new default).

## 5. Risks

- **Data-destroying risk #1: never point any fixture at `~/.memory/*`.** Every test in this
  packet that exercises `backupTo()`/`VACUUM INTO` or opens a Turso adapter on a local file
  must use a fresh `mkdtempSync(join(tmpdir(), ...))` path, exactly as the existing
  `migration.test.ts`/`migration-e2e.test.ts` already do (`beforeAll`/`afterAll` pattern at
  `migration.test.ts:30-38`). Copy that pattern; do not invent a new fixture-location
  convention.
- **Data-destroying risk #2: `--mode in-place` test must never run against a file the
  implementer or reviewer cares about.** The whole point of criterion 3 is to prove the
  backup survives a real in-place run — meaning the test genuinely lets `migrateStore()`
  mutate the fixture file. Triple-check the fixture path is a fresh temp file created by the
  test itself, never an argument or env var that could accidentally resolve to a real store.
- **`nx build` / `nx test` are destructive on this repo (BL-235/BL-456) — do not diagnostic-build.**
  `store-adapter` ships a `dist/` consumed by other packages (`libs/memory-core` imports
  `@adhd/sox-store-adapter`). Changing `migration.ts`'s exported interface
  (`MigrationResult` gains a field) is source-compatible (additive), but run
  `npx nx build store-adapter` for real only once the source change is final and you intend
  to keep the result — never as a "let's see if it compiles" probe. Use
  `npx nx typecheck store-adapter` (non-destructive) to iterate on type errors instead.
- **This is a published package — the `MigrationResult` change is a public API surface
  change.** `@adhd/sox-store-adapter` is `"private": false` at version `0.3.0`
  (`libs/data/store/store-adapter/package.json`). Adding `ok`/`erroredTables` to an exported
  interface will trip `npx tsx scripts/check-changeset-surface.ts` once `dist/*.d.ts` is
  rebuilt and diffed against the last-published `.d.ts`. Add a changeset
  (`.changeset/<slug>.md`, format: YAML frontmatter `'@adhd/sox-store-adapter': minor` — under
  this repo's 0.x policy a breaking-or-additive-public-type change bumps **minor**, per this
  packet's brief, not **major** and not **patch**) in the SAME change that edits
  `migration.ts`. Do not add a changeset for `scripts/migrate-store-to-turso.mjs` — it is not
  a published package.
- **Downstream consumer is live, not hypothetical.** `@adhd/sox-store-adapter@0.3.0` is
  already published and (per the product-manager's 2026-08-08 re-verification note on the
  backlog item) may already be in use by an external consumer. The `ok`/`erroredTables`
  addition is additive/non-breaking to existing callers (nothing is removed or retyped), so
  this is safe to ship without a major bump — but do not, in the same change, alter
  `TableMigrationResult`'s existing fields (`rows`/`errored`/`error`/`skipped`/`reason`,
  `migration.ts:34-40`) or `MigrationOptions`. Only additive fields on `MigrationResult`.
- **Turso is not opt-in; never touch `needsWriteSerialization`/`concurrentTransactions`.**
  Nothing in this packet's change list requires touching either flag
  (`AdapterCapabilities`, `types.ts`) — flagging this only because the task's Hazards section
  calls it out explicitly and one prior agent got it wrong on unrelated work.

## 6. The gate

Run, in this order, once source changes are final:

1. `npx nx typecheck store-adapter` — iterate here first; non-destructive.
2. `npx nx lint store-adapter`
3. `npx nx test store-adapter` — runs `migration.test.ts`/`migration-e2e.test.ts` plus the new
   criterion-1 test. Report tree state alongside the result:
   `node tools/check-suite-tree-state.mjs --project store-adapter`.
4. `npx nx build store-adapter` — only once (2) and (3) are green; this is the destructive
   step (BL-235), run it exactly once with intent to keep the artifact.
5. `npx nx test sox-ecosystem` (root aggregate; covers `scripts/**/*.test.ts` per
   `vitest.config.ts` — this is where criteria 2/3/4's new
   `scripts/migrate-store-to-turso.test.ts` lives and runs). Report tree state:
   `node tools/check-suite-tree-state.mjs --project sox-ecosystem`.
6. `npx tsx scripts/check-changeset-surface.ts` — confirm the changeset added in §5 satisfies
   the gate (this may require `dist/` to be current from step 4 — do not re-run step 4 a
   second time to "make sure"; trust the one build already done).
7. Whole-repo affected sweep before commit, per house rules:
   `npx nx affected -t lint,test,typecheck` (do NOT add `build` to this sweep — every affected
   `build` target is independently destructive per project; step 4 already covered the one
   that matters here, and nothing else in the affected set should need rebuilding for this
   change).
8. **Do not pass `--skip-nx-cache`** to any of the above (owner instruction).

Do not mark the backlog item resolved until every acceptance-criteria test in §4 has been
observed RED (against pre-fix code) and GREEN (against post-fix code) by the implementer or
reviewer directly — not "would fail," run it. Transition status via
`backlog_transition_status`/`backlog_resolve_item` (repo `sox-ecosystem`, humanId
`BUG-STOREADAPTER-MIGRATE-UNSAFE-001`) and attach citations via `backlog_add_citation` for the
final file:line locations of the fix — there is no `BACKLOG.md`/`CHANGELOG.md` to hand-edit
(ADR-0011); the graph is the only record.
