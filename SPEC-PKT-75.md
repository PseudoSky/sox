# SPEC — PKT-75 (BL-416 + BL-446 + BL-454)

Architect stage. Written from `/Users/nix/dev/ai/sox-ecosystem/.worktrees/pkt75-backlog-tooling`
(branch `feat/pkt75-backlog-tooling`). Implementer: build exactly this, do not re-litigate the
rulings below — if you hit a case not covered here, that is a spec bug, escalate it, do not
improvise.

Files in scope: `tools/allocate-bl-id.mjs`, `tools/check-backlog-markers.mjs`,
`tools/check-bl-id-integrity.mjs`. Everything else is out of bounds (§2.4).

---

## 0. The owner ruling, and what it actually requires

> **OWNER RULING 2026-08-06, verbatim: "Backlog can be shared."**

Read literally: `BACKLOG.md`/`CHANGELOG.md` are **one canonical registry**, physically located at
the **main checkout's** path, regardless of which worktree invokes the tooling. `git rev-parse
--show-toplevel` (the code currently live, landed as a drive-by in `747d087`) is **not** the fix —
it gives every worktree its own file and its own lock, which is precisely the race BL-359 was
filed to close (BL-344 filed twice, BL-354 filed four times, three renumbers). The fix is to
**revert** the resolution to `git rev-parse --git-common-dir` + `path.resolve(..., '..')`, keep the
lock on that same shared root, and add the transparency measure the ruling also mandates: **every
write and every FAIL prints the resolved absolute path**, so no caller is left assuming the tool
operated on the copy checked out in its own `cwd`.

One structural consequence the ruling does not spell out but that follows mechanically, and that
this spec is explicit about because getting it wrong silently reopens the exact bug: **a worktree's
own on-disk `BACKLOG.md` is a different file from the one these three tools read and write.** A
worktree has its own checked-out copy (tracked by its own branch) sitting at
`<worktree>/BACKLOG.md`; these tools ignore it entirely and always operate on
`<main-checkout>/BACKLOG.md`. `allocate-bl-id.mjs`'s reservation lands in the main checkout's copy,
not the invoking worktree's — BL-416's own body already describes living with this ("this item now
reuses id 416 for its own real content on the worktree side; the main-checkout placeholders for 416
and 417 still need deleting"). That reconciliation cost is accepted, not solved, by this packet.

---

## 1. Root cause (file:line, all read personally in this worktree)

**BL-416.** All three scripts resolve `REPO_ROOT` via
`execFileSync('git', ['rev-parse', '--show-toplevel'], ...)`:
`tools/allocate-bl-id.mjs:71`, `tools/check-backlog-markers.mjs:34`,
`tools/check-bl-id-integrity.mjs:70`. This landed in `747d087` (confirmed via
`git log -S'--show-toplevel' -- tools/allocate-bl-id.mjs`), a commit titled *"fix(memory-core):
delete dead memory_scope.meta write"* — unrelated to backlog tooling. BL-416 was left Open. The
load-bearing companion is the lock: `tools/allocate-bl-id.mjs:74`
(`LOCK_DIR = path.join(REPO_ROOT, '.bl-id.lock')`), claimed at `:94` (`mkdirSync(LOCK_DIR)`). Under
`--show-toplevel`, `REPO_ROOT` differs per worktree, so `LOCK_DIR` differs per worktree — two
worktrees allocating concurrently take *different* locks and can compute the same "next" id. This
is the exact race BL-359's design (`tools/allocate-bl-id.mjs:18-33`, doc comment) exists to prevent.

Current header comments in all three files (`allocate-bl-id.mjs:61-70`,
`check-backlog-markers.mjs:29-33`, `check-bl-id-integrity.mjs:65-69`) actively argue *for*
`--show-toplevel` ("BL-416: ... Resolving via `--git-common-dir` + '..' silently reads/writes the
MAIN checkout's BACKLOG.md ... `--show-toplevel` returns the CURRENT worktree's own root ... which
is what 'the repo root I was invoked from' actually means here"). That reasoning is now the thing
being reverted, per the owner ruling above — the comments must be rewritten, not just the code.

**BL-446.** `tools/allocate-bl-id.mjs`'s only argv handling is
`const DRY_RUN = process.argv.includes('--dry-run');` (`:76`). `main()` (`:115-138`) branches only
on `DRY_RUN`; anything else — `--help`, `-h`, a typo — falls into the `else` branch (`:122-137`),
acquires the lock, and appends a `RESERVED` placeholder heading to the shared `BACKLOG.md`.
`tools/check-backlog-markers.mjs` and `tools/check-bl-id-integrity.mjs` read `process.argv` **not
at all** — every invocation, with any arguments, runs the full check. Confirmed live this week per
the task brief: `check-backlog-markers.mjs --help` runs the check instead of printing usage.

**BL-454.** `tools/check-backlog-markers.mjs:89-93` matches
`/\*\*Total open: (\d+)\.\*\*/` against the file and **fails** if the integer disagrees with the
derived count (`Rule 4`) — it never rewrites the line. The prose immediately following that bold
span, in the same line, is appended to by hand by every agent that resolves or files an item, and
nothing deduplicates it. Live evidence, read directly in this worktree at `BACKLOG.md:9` (checked
out from `main`, commit `0127bab`, 2026-08-06): the line is now **far larger** than the 21,736 bytes
measured when BL-454 was filed 2026-08-05 — a `grep -n` of it returns a single line whose printed
length in this session's tool output ran to several thousand words, and it visibly repeats
`BL-413 filed 2026-08-03 from the STATE/PLAN reconciliation` and
`BL-316, BL-273, BL-254, BL-252, BL-264, BL-297 all resolved 2026-07-23 — see CHANGELOG.md`
verbatim, twice each, among other exact repeats — the same growth-without-bound BL-454 describes,
continuing unabated because nothing enforces it.

---

## 2. The change, file by file

### 2.1 `tools/allocate-bl-id.mjs`

- **Revert `REPO_ROOT`** (`:71`) to:
  ```js
  const REPO_ROOT = path.resolve(
    execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim(),
    '..',
  );
  ```
  `LOCK_DIR`, `BACKLOG`, `CHANGELOG` (`:72-74`) stay derived from this `REPO_ROOT` unchanged in
  shape — only the resolution method changes. This restores one shared lock directory across every
  worktree and the main checkout.
- **Rewrite the header comment block** (`:1-55` for the usage/behavior description, `:61-70` for
  the BL-416 rationale) to state the shared-registry semantics plainly: this script always targets
  the main checkout's `BACKLOG.md`/`CHANGELOG.md`, never the invoking worktree's own copy, by
  design (cite the owner ruling, 2026-08-06); a caller in a worktree must separately reconcile their
  own worktree's `BACKLOG.md` when writing the real item content — the reservation only guarantees
  the *number* is unique, not that the placeholder lives where the caller will actually commit their
  work.
- **Argument handling (BL-446).** Replace the single `DRY_RUN` boolean with explicit parsing at the
  top of the file, before any git/file I/O:
  ```js
  const args = process.argv.slice(2);
  const HELP = args.includes('--help') || args.includes('-h');
  const DRY_RUN = args.includes('--dry-run');
  const recognized = new Set(['--help', '-h', '--dry-run']);
  const unrecognized = args.filter((a) => !recognized.has(a));
  ```
  - If `HELP`: print a usage block to **stdout** (reuse the existing header-comment usage text
    verbatim — do not duplicate it by hand, extract it into a `USAGE` string constant that the
    header comment references, or print the header comment's usage lines directly), `process.exit(0)`.
    **No git call, no file read, no lock, no write** — this must be checked before `REPO_ROOT` is
    even computed, so `--help` never touches git or the filesystem.
  - Else if `unrecognized.length > 0`: print each unrecognized arg to **stderr** with a message
    naming it and pointing at `--help`, `process.exit(1)`. Same ordering constraint — before any
    git/file I/O.
  - Else proceed exactly as today (`DRY_RUN` branch, then the lock+allocate+write branch).
- **Resolved-path echo (owner ruling).** Immediately after computing `BACKLOG`, `CHANGELOG`,
  `LOCK_DIR` (and only on the paths that reach that point — `--help`/unrecognized-arg exits happen
  first and print nothing path-related), write three lines to **stderr** (not stdout — the
  documented stdout contract is `BL-<n>` on a single line and nothing may be added ahead of it):
  ```
  [allocate-bl-id] BACKLOG.md  -> <absolute path>
  [allocate-bl-id] CHANGELOG.md -> <absolute path>
  [allocate-bl-id] lock dir    -> <absolute path>
  ```
  Print this in both the `DRY_RUN` and the real-allocation branch, and also from the lock-timeout
  error path (`:98-104`) so a caller who hits the timeout still learns which lock file/path is
  contended. Do **not** print it before the `HELP`/unrecognized-arg checks — those must remain
  side-effect-free and silent on the path question, since they never touch the files.

### 2.2 `tools/check-backlog-markers.mjs`

- **Revert `REPO_ROOT`** (`:34`) to the same `--git-common-dir` + `'..'` form as §2.1. `FILE`
  (`:35`) stays derived from it.
- **Rewrite header comment** (`:1-23` behavior description, `:29-33` BL-416 rationale) analogously
  to §2.1: this always validates the main checkout's `BACKLOG.md`, regardless of `cwd`.
- **Argument handling (BL-446).** Same pattern as §2.1, adapted — no `--dry-run` concept here, so:
  ```js
  const args = process.argv.slice(2);
  const HELP = args.includes('--help') || args.includes('-h');
  const FIX = args.includes('--fix');
  const recognized = new Set(['--help', '-h', '--fix']);
  const unrecognized = args.filter((a) => !recognized.has(a));
  ```
  `--help` prints usage to stdout, exits 0, before any git/file I/O. Any unrecognized arg prints to
  stderr and exits 1, before any git/file I/O. This is the exact defect named in the task brief
  ("Confirmed live this week: `check-backlog-markers.mjs --help` runs the check instead of printing
  usage") — fix it identically to `allocate-bl-id.mjs`.
- **Resolved-path echo.** On every invocation that proceeds past the arg-check (i.e. not `--help`,
  not unrecognized), print to stderr, before running any rule:
  ```
  [check-backlog-markers] validating -> <absolute path to BACKLOG.md>
  ```
- **New Rule 5 — duplicate-clause detection in the `Total open` annotation (BL-454).** After Rule 4
  (`:88-94`), add a clause-level check over the *same* text already read for `totalMatch`:
  1. Locate the annotation span: everything from the start of the `**Total open: N.**` bold span to
     the end of that physical line (the corpus's existing convention keeps the whole annotation on
     one line; do not attempt multi-line parsing).
  2. Within the parenthetical trailing the bold span (from the first `(` immediately following
     `**Total open: N.**` to the line's final `)`, if present — if there is no trailing
     parenthetical, there is nothing to check, skip Rule 5 entirely), split into clauses on the
     **zero-width lookahead** boundary:
     ```js
     const CLAUSE_START = /(?=\bBL-\d+(?:,\s*BL-\d+)*\s+(?:and\s+BL-\d+\s+)?(?:resolved|filed|verified|removed|RESAMPLED|REOPENED)\b)/;
     const clauses = annotationBody.split(CLAUSE_START).map((c) => c.trim()).filter(Boolean);
     ```
     This is a heuristic, not a full parser — text that doesn't open with a recognized
     `BL-<n> <verb>` token (e.g. `BL-436 registry checksum drift armed ...`, which lacks a
     recognized verb immediately after the id — read directly at `BACKLOG.md:9` in this checkout)
     merges into the **preceding** clause rather than starting a new one. That is safe by
     construction: it only ever *coarsens* the split (two genuinely distinct passages glued into
     one comparison unit), never drops text, and it cannot cause a false dedupe unless the merged
     blob is itself an exact byte-for-byte repeat elsewhere — vanishingly unlikely and, if it ever
     happens, is still "no unique clause dropped" in letter and effect, since the entire merged
     blob would need to repeat, unique content and all. Document this limitation in the code
     comment directly above the regex; do not attempt to special-case it further.
  3. Deduplicate by exact string equality after collapsing internal whitespace runs to a single
     space and trimming — **first occurrence wins**, matching the manual dedupe already performed
     2026-08-05 ("141 → 64 clauses, no unique content dropped").
  4. If `clauses.length !== dedupedClauses.length`:
     - Default mode (no `--fix`): `warn()` (not `fail()` — this must never increment `failures` or
       change the exit code) with a message naming the duplicate count, e.g.
       `` `Total open annotation carries ${clauses.length - dedupedClauses.length} duplicate clause(s) of ${clauses.length}; run 'node tools/check-backlog-markers.mjs --fix' to regenerate.` ``
       This MUST be advisory-only. A hard fail here would immediately break every worktree's
       pre-commit hook the instant this ships, since the live file already carries duplicates
       (§1, BL-454) — see Risk R1.
     - `--fix` mode: **first**, run Rules 1–3 as normal. If `failures > 0` from those rules, do
       **not** touch the file — print the existing failure output and exit 1 (a broken heading
       grammar must not be papered over by a clause rewrite that trusts a `derivedOpen` count
       computed from that same broken input). If Rules 1–3 are clean, rewrite the `Total open` line
       in place: `` `**Total open: ${derivedOpen}.** (${dedupedClauses.join(' ')})` `` — always using
       the freshly derived count, not the original (this also incidentally fixes a stale-count Rule
       4 failure in the same write, since both numbers come from the same `derivedOpen` value). Read
       the file once more via `readFileSync`/rewrite via `writeFileSync` (not the already-loaded
       `lines` array, to avoid reconstructing line-ending edge cases — operate on the raw text and a
       single targeted string replace of the matched annotation span). Print what changed (line
       count before/after, bytes before/after) to stdout, then exit 0.
  5. If `clauses.length === dedupedClauses.length` (no duplicates): Rule 5 contributes nothing,
     `--fix` mode still exits 0 but performs no write and says so explicitly (`"no duplicate
     clauses found, nothing to fix"`).
- **What must NOT change in this file:** Rules 1–4's existing logic and exit-code semantics
  (`failures` accumulation, the `fail()`/exit(1) contract) — Rule 5 is strictly additive and, in its
  non-`--fix` form, must never affect `process.exit` code. The zero-arg invocation used by
  `check-bl-id-integrity.mjs`'s delegate call (`check-bl-id-integrity.mjs:101-107`, no argv passed)
  must continue to behave exactly as it does today (validate-only, Rule 5 in warn-only mode).

### 2.3 `tools/check-bl-id-integrity.mjs`

- **Two separate roots, not one** (this is the one place this spec adds a requirement beyond the
  literal backlog text — see §3, Decision D4, for the reasoning):
  ```js
  // Canonical registry root — same as allocate-bl-id.mjs / check-backlog-markers.mjs.
  const REPO_ROOT = path.resolve(
    execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim(),
    '..',
  );
  const BACKLOG = path.join(REPO_ROOT, 'BACKLOG.md');
  const CHANGELOG = path.join(REPO_ROOT, 'CHANGELOG.md');

  // The commit actually in progress lives in the INVOKING worktree, not necessarily REPO_ROOT.
  const INVOKING_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  ```
  `REPO_ROOT`/`BACKLOG`/`CHANGELOG` are used exactly as today for the content reads (`:110-111`,
  rules 2 and 3). `INVOKING_ROOT` replaces `REPO_ROOT` as the `cwd` for **both** git subprocess
  calls that inspect the staged commit: the scope check (`:82-87`,
  `execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: REPO_ROOT, ... })` →
  `cwd: INVOKING_ROOT`) and the advisory Files-overlap diff (`:160-163`,
  `execFileSync('git', ['diff', '--cached', '-U0', '--', 'BACKLOG.md'], { cwd: REPO_ROOT, ... })` →
  `cwd: INVOKING_ROOT`). These two calls answer "what is being committed right now, in the
  repository this hook is actually running against" — a worktree-local question — and must not be
  redirected to the main checkout's index, which may be staged completely differently by an
  unrelated concurrent agent.
- **Rewrite header comment** (`:1-59` behavior description, `:65-69` BL-416 rationale) to describe
  both roots and why they differ — this is the file most likely to confuse a future reader, since it
  is the only one of the three that legitimately needs two different resolutions at once.
- **Argument handling (BL-446).** Same pattern: `--help`/`-h` prints usage, exits 0, before any git
  call; any unrecognized arg exits 1 before any git call; zero args (the pre-commit hook's own
  invocation, `.husky/pre-commit`, and the test harness) behaves exactly as today.
- **Resolved-path echo.** Print both roots to stderr immediately after computing them, before the
  staged-files scope check:
  ```
  [check-bl-id-integrity] registry root (BACKLOG/CHANGELOG) -> <REPO_ROOT>
  [check-bl-id-integrity] invoking worktree root             -> <INVOKING_ROOT>
  ```
  Print this even on the early "skipped" exit (`:88-91`) — a caller who sees "skipped" for a commit
  they expected to be checked needs exactly this information to understand why.
- **What must NOT change:** the delegate call to `check-backlog-markers.mjs` (`:101-107`) passes no
  argv today and must continue to pass none — `check-backlog-markers.mjs` re-derives its own
  `REPO_ROOT` internally regardless of the parent's `cwd`, so no argument threading is needed. Rules
  2–4's logic (`:109-190`) is otherwise unchanged; only the `cwd` values feeding the two `git diff`
  calls move as described above.

### 2.4 Out of bounds — do not touch, and why

- **`BACKLOG.md` / `CHANGELOG.md` themselves.** Every test in this packet must run against a scratch
  git repo (see §4, Risk R1) — never invoke a write-path form of any of these three scripts against
  the real `/Users/nix/dev/ai/sox-ecosystem` checkout as part of implementing or verifying this fix.
  Read-only invocations (`check-backlog-markers.mjs` with no `--fix`, `check-bl-id-integrity.mjs`
  with nothing of interest staged) from inside the worktree are fine and expected — after §2.1–2.3
  land, they will correctly report on the **main checkout's** `BACKLOG.md`, not this worktree's; that
  is the intended new behavior, not a bug to chase.
- **`.husky/pre-commit`.** Do not add automatic `--fix` invocation here. Regenerating the shared
  annotation is a deliberate, reviewed action an agent takes and commits explicitly — auto-firing it
  on every commit that touches `BACKLOG.md` would silently rewrite shared, historically-accreted
  prose on someone else's commit with no diff review. The hook's existing two-line invocation
  (`node tools/check-bl-id-integrity.mjs`) needs no edit; it already calls into the fixed code once
  §2.3 lands.
- **`tools/plan-status.mjs`, `tools/commit-mine.mjs`, `tools/check-amend-shared-index.mjs`,
  `tools/unstage-orphans.mjs`, `tools/install-git-hooks.mjs`.** Different tools, different root
  causes (several already resolved under PKT-76/PKT-77), no code path from this packet touches them.
  `install-git-hooks.mjs` in particular needs no re-run — hooks live at the shared
  `<git-common-dir>/hooks/`, confirmed live in this worktree
  (`.git` here is a 77-byte gitlink to `/Users/nix/dev/ai/sox-ecosystem/.git/worktrees/...`, and
  `/Users/nix/dev/ai/sox-ecosystem/.git/hooks/pre-commit` already exists, mode `0755`) — so this
  worktree already has the real hook without any setup step.
- **`tools/verify-native-abi.mjs`.** Cited only as an analogy in the current (soon-reverted) header
  comments — it uses `--git-common-dir` for an unrelated purpose (finding a shared native-module
  install root) and its own logic must not be touched or imitated beyond the analogy already drawn.

---

## 3. Every decision, ruled

**D1 — Which root-resolution semantics win: `--show-toplevel` (per-worktree) or
`--git-common-dir` + `'..'` (shared)?**
**Ruling: shared, per the owner's explicit 2026-08-06 ruling.** Losing alternative
(`--show-toplevel`, the code currently live): correctly targets "the file I can see," but silently
reopens BL-359's id-collision race the instant two worktrees allocate concurrently, because the lock
follows the same resolution and stops being shared. The owner's ruling forecloses this option
explicitly ("Backlog can be shared" is stated as the answer to the very question BL-416's body
raised, not as a hint).

**D2 — Does reverting the file path alone suffice, or must the lock move with it?**
**Ruling: both move together, non-negotiably.** `LOCK_DIR` is derived from the same `REPO_ROOT`
constant as `BACKLOG`/`CHANGELOG` in the current code (`allocate-bl-id.mjs:72-74`) — there is no
version of this fix where they resolve differently, because a lock that doesn't sit next to the file
it's protecting protects nothing. Stated explicitly because BL-416's body itself flags this as the
exact mistake a naive revert would make ("Reverting only the file path and not the lock leaves the
race open").

**D3 — Where does the resolved-path echo go: stdout or stderr?**
**Ruling: stderr, for all three scripts, in every case.** Losing alternative: stdout. `allocate-bl-id.mjs`'s
documented output contract (`:39`, "Output (stdout, single line): BL-<n>") is real — nothing in the
repo currently parses it programmatically (verified: `grep -rn '$(.*allocate-bl-id' .` outside this
worktree returns nothing but doc prose), but the contract is *the* line the CHANGELOG (`:1651-1652`)
documents as the interface, and adding a second stdout line breaks any future `id=$(node
tools/allocate-bl-id.mjs)` caller silently and expensively (they'd capture two lines and downstream
code parsing "the id" would see garbage). `check-backlog-markers.mjs`/`check-bl-id-integrity.mjs`
have no stdout contract to protect, but keep them on stderr too, for one consistent convention
across the family rather than a per-file judgment call.

**D4 — `check-bl-id-integrity.mjs`'s two `git diff --cached` calls (`:82-87`, `:160-163`): should
their `cwd` follow the reverted (shared) `REPO_ROOT`, or stay worktree-local?**
**Ruling: worktree-local — this is a distinct question from D1 and does not automatically inherit
D1's answer.** Neither backlog item names this subtlety; it is this spec's own finding, read
directly at `check-bl-id-integrity.mjs:82-87` (`git diff --cached --name-only`, gating the entire
scope of the checker) and `:160-163` (the advisory Files-overlap diff). Both calls answer "what is
staged in the commit currently happening" — a property of the invoking process's own working
directory and index, never the main checkout's, regardless of where `BACKLOG.md`/`CHANGELOG.md`
physically live. If these two calls were redirected to `cwd: REPO_ROOT` (the naive "just apply D1
everywhere" reading), the gate at `:88-91` — the scope check whose entire purpose (documented at
`:50-55` and `:74-81`, and tested live per its own comment, "Verified live 2026-08-01: BL-397 was
caught in exactly this transient state") is to skip commits that don't touch `BACKLOG.md`/
`CHANGELOG.md` — would instead answer based on whatever the **main checkout's** index happens to
hold at that instant, which any other concurrently active agent can change out from under a
worktree's commit with zero relationship to what's actually being committed. Concretely: a worktree
committing an unrelated file (say, `foo.ts`) while the main checkout happens to have `BACKLOG.md`
staged from someone else's in-progress work would incorrectly *not* skip, and would run the full
check against a file the current commit never touches — the opposite of a false negative, a false
positive that blocks or misattributes on totally unrelated work. Losing alternative: reuse
`REPO_ROOT` uniformly across the file "for consistency." It loses because consistency of *code shape*
is not the goal here — correctness of *what question each call answers* is, and these two calls ask
a different question than the content reads at `:110-111` do.

**D5 — BL-454: full mechanical regeneration of the annotation from item markers, a length cap, or
duplicate-clause removal?**
**Ruling: duplicate-clause removal (the fix sketch's option (a), narrowed).** The item itself offers
three options with none chosen: (a) a tool owns and regenerates the annotation from item markers,
(b) cap the annotation at one sentence by rule, (c) drop the prose entirely and keep only the count.
(c) loses immediately against this packet's own acceptance text ("no unique clause dropped" — dropping
all prose drops every clause, unique or not, so it cannot satisfy the stated bar). (b) loses because
the prose is hand-authored historical narrative (each clause names what a specific resolved/filed id
did and why), not something a fixed one-sentence cap can hold without discarding real information —
and the item's own "cost" framing is about *duplication*, not about total length being intrinsically
too long. (a) as literally stated — regenerate the whole annotation "from item markers" — is not
achievable either: the per-item narrative text (what BL-338 actually fixed, in prose) does not exist
as a structured field anywhere in the heading grammar Rules 1–4 already parse; only the id and status
word do. The achievable, correct-scope version of (a) is: mechanically deduplicate exact-repeat
clauses within the existing hand-authored text, which is exactly what was done by hand 2026-08-05
("141 → 64 clauses, no unique content dropped") and exactly what this packet's acceptance text asks
for ("duplicate clauses reduced deterministically and no unique clause dropped"). That is Rule 5 as
specified in §2.2.

**D6 — Should Rule 5's duplicate-clause finding block the commit (like Rules 1–4) or warn?**
**Ruling: warn-only in default mode; a commit is blocked only via the explicit `--fix` write path's
own Rule 1–3 gating (§2.2 step 4), never via Rule 5 itself.** A hard fail here would, on the day this
ships, immediately fail `check-bl-id-integrity.mjs` (which delegates into `check-backlog-markers.mjs`)
for **every** agent in **every** worktree that touches `BACKLOG.md`, because the live file already
carries the exact duplicate clauses described in §1 — this is not a hypothetical, it was read
directly in this checkout. See Risk R1.

**D7 — Does `--fix` run automatically as part of the pre-commit hook once it exists?**
**Ruling: no — manual, opt-in only.** See §2.4. A losing alternative (auto-`--fix` in the hook) would
rewrite shared prose on an unrelated commit with no chance for the committer to review the diff
before it lands on the one file every agent in the repo reads.

**D8 — Test execution: nx target or standalone script?**
**Ruling: standalone `node tools/test-bl<id>-<slug>.mjs`, following the existing
`tools/test-bl465-commit-mine-index-resync.mjs` precedent.** `tools/*.mjs` (root-level, outside
`tools/baseline-capture/`) is not an nx project — verified via `npx nx show projects` in this
worktree, which lists no project rooted at `tools`. The root `vitest.config.ts` explicitly scopes to
`extensions/**/*.test.ts` and `scripts/**/*.test.ts` only (read at `vitest.config.ts:15`), so these
files are unreachable from any `nx test`/`vitest` invocation regardless. This is not a gap this
packet should close (wiring `tools/test-bl*.mjs` into a runner is BL-466, already filed, separate,
out of scope) — it means the "nx targets only" house rule does not apply to files with no nx project,
and the correct verification mechanism is direct `node` execution, exactly as BL-465 did.

---

## 4. Acceptance criteria (by BL id), each with its RED arm

All tests below run against **scratch git repos** created inside the test script (`fs.mkdtempSync`),
never against the real checkout. `fs.mkdtempSync` on macOS resolves under `/tmp`, which is itself a
symlink to `/private/tmp` — call `fs.realpathSync()` on every scratch dir immediately after creating
it, and use the realpath consistently for every subsequent comparison (including comparing two
processes' echoed "resolved path" stderr lines) or path-identity assertions will spuriously fail on a
`/tmp` vs `/private/tmp` spelling mismatch, not a real defect.

### BL-416 — `tools/test-bl416-shared-registry-lock.mjs`

Setup: `mainRepo = scratchRepo()` (git init, one commit with a valid `BACKLOG.md` carrying
`**Total open: 0.**` and an empty `CHANGELOG.md`, matching the shape `scratchRepo()` already builds
in `test-bl465-commit-mine-index-resync.mjs`). `wtRepoA = git worktree add <dir> -b wt-a` off
`mainRepo`. `wtRepoB = git worktree add <dir> -b wt-b` off `mainRepo`.

1. **Targeting.** Run `node <abs path to allocate-bl-id.mjs>` with `cwd: wtRepoA`. Assert:
   - stdout is exactly one line matching `/^BL-\d+$/`.
   - `readFileSync(join(mainRepo, 'BACKLOG.md'))` contains a `### BL-<n> — RESERVED` heading for
     the printed id.
   - `readFileSync(join(wtRepoA, 'BACKLOG.md'))` does **not** contain that heading — it is
     byte-identical to what it was before the run.
   - `RED (today, `--show-toplevel`)`: the placeholder lands in `wtRepoA`'s own `BACKLOG.md`, and
     `mainRepo`'s is untouched — this assertion set fails in exactly the way that inverts, proving
     the current code targets the wrong file.
2. **Committable at its actual location.** `git -C mainRepo add BACKLOG.md && git -C mainRepo commit
   -m test-bl416` must exit 0. This is a sanity check on write well-formedness, not a red/green
   discriminator by itself (both the current and fixed code produce a git-clean append to
   *wherever* they write) — keep it because the task's acceptance text asks for it verbatim ("a
   `BACKLOG.md` the caller can read back and commit"), satisfied here against the file's actual
   owning repo.
3. **Same lock, deterministically.** Extend `allocate-bl-id.mjs` per §2.1 to echo the resolved
   `LOCK_DIR` to stderr on every real-allocation run. Run once with `cwd: wtRepoA`, once with
   `cwd: mainRepo` itself (sequentially, not concurrently, to keep this assertion non-racy). Capture
   each run's stderr, extract the `lock dir -> <path>` line, `fs.realpathSync()` both. Assert they
   are the **identical string**.
   - `RED (today)`: `wtRepoA`'s echoed lock dir is `<wtRepoA>/.bl-id.lock`; `mainRepo`'s is
     `<mainRepo>/.bl-id.lock` — different strings, assertion fails deterministically (no timing
     dependency).
4. **Corroborating, not load-bearing: 8-way cross-worktree race.** Spawn 8 concurrent
   `allocate-bl-id.mjs` invocations, 4 with `cwd: wtRepoA`, 4 with `cwd: wtRepoB` (via
   `Promise.all` of `spawnSync`... actually use async `spawn` + promise wrapper so they overlap in
   wall-clock time), collect all 8 stdout ids. Assert 8 unique values. Document in the test's own
   header comment that this arm is **not guaranteed deterministically red** against the current
   code (a timing-dependent race may or may not collide on a given run) — it corroborates assertion
   3, it does not replace it as the acceptance-defining check.

### BL-446 — `tools/test-bl446-arg-validation.mjs`

For **each** of the three scripts (`allocate-bl-id.mjs`, `check-backlog-markers.mjs`,
`check-bl-id-integrity.mjs`), against a fresh scratch repo per script (reuse `scratchRepo()`):

1. **`--help` (and `-h`).** Run with `cwd: scratchRoot`. Assert: exit code 0; stdout contains the
   literal substring `Usage`; for `allocate-bl-id.mjs` specifically, `BACKLOG.md`'s content hash
   (sha256 before vs. after) is unchanged.
   - `RED (today)`: `allocate-bl-id.mjs --help` exits 0 but the hash **changes** (a placeholder was
     appended) — assertion fails. `check-backlog-markers.mjs --help` / `check-bl-id-integrity.mjs
     --help` run the real check and print its pass/fail summary, not usage text — stdout does not
     contain `Usage`, assertion fails.
2. **Unrecognized argument** (`--this-is-not-a-flag`). Assert: exit code non-zero; for
   `allocate-bl-id.mjs` specifically, `BACKLOG.md` hash unchanged.
   - `RED (today)`: `allocate-bl-id.mjs --this-is-not-a-flag` falls through to the write path, exits
     0, hash changes — assertion fails on both counts. `check-backlog-markers.mjs
     --this-is-not-a-flag` / `check-bl-id-integrity.mjs --this-is-not-a-flag` ignore the arg
     entirely and exit based on unrelated validation state (0 on this clean fixture) — assertion
     "non-zero" fails.
3. **Zero-arg regression guard.** Re-run each script with no arguments at all against the same
   fixtures and assert behavior is unchanged from pre-fix (this is the "did not break the hook"
   check — `check-bl-id-integrity.mjs` in particular must still delegate to
   `check-backlog-markers.mjs` with no argv and both must still exit 0 on a clean fixture).

### BL-454 — `tools/test-bl454-annotation-dedupe.mjs`

Build a fixture `BACKLOG.md` in a scratch repo whose header line is, verbatim (matching the real
corpus's convention exactly, so the clause-boundary regex is exercised the same way it will be
against the real file):

```
**Total open: 2.** (BL-100 resolved 2026-01-01 from PKT-1 — did a thing, see CHANGELOG.md. BL-101 filed 2026-01-02 — a distinct thing. BL-100 resolved 2026-01-01 from PKT-1 — did a thing, see CHANGELOG.md. BL-102 resolved 2026-01-03 from PKT-2 — a third, unrelated thing, see CHANGELOG.md.)
```

with exactly two `### BL-<n>` headings below it whose status markers derive `Total open: 2` as
correct (so Rules 1–4 pass clean and the fixture isolates Rule 5). The `BL-100 ... did a thing`
clause is repeated verbatim (the injected duplicate); `BL-101` and `BL-102` are each unique.

1. **Default mode.** Run `check-backlog-markers.mjs` with no flags. Assert: exit code 0 (Rules 1–4
   still pass); stderr contains a message naming a duplicate count (`1` duplicate of `4` clauses, or
   equivalent phrasing per §2.2 step 4); the fixture file on disk is **byte-identical** before and
   after (advisory must never write).
   - `RED (today)`: no such message exists anywhere in output — there is no notion of clause
     duplication in the current code at all; assertion "stderr mentions a duplicate count" fails
     because the substring is simply absent.
2. **`--fix` mode.** Run `check-backlog-markers.mjs --fix`. Assert: exit code 0; the rewritten
   `Total open` line contains the `BL-100 resolved ... did a thing` clause **exactly once**; the
   `BL-101` and `BL-102` clauses are each still present, verbatim, somewhere in the line; the leading
   count still reads `2`; running `check-backlog-markers.mjs` (no flags) again against the fixed file
   now reports **zero** duplicate clauses.
   - `RED (today)`: `--fix` is not a recognized flag at all — no code path writes the file, so the
     duplicate clause still appears twice post-run; assertion "exactly once" fails (finds it twice).
3. **Rules 1–3 gate `--fix` (§2.2 step 4).** Second fixture: same annotation duplicate, but also a
   genuine duplicate `### BL-100` heading (Rule 3 violation) elsewhere in the file. Run
   `check-backlog-markers.mjs --fix`. Assert: exit code 1; the normal Rule 3 failure message is
   printed; the file is **byte-identical** before and after — `--fix` must refuse to write on top of
   a broken heading grammar.
   - `RED`: not applicable as a discriminator against *today's* code (today's code has no `--fix` at
     all, so this scenario can't regress from a prior working state) — this is a forward-looking
     safety assertion the implementer must build correctly the first time, not a revert check.

---

## 5. Risks

**R1 — Rule 5 must never be wired as blocking, or every worktree's pre-commit hook breaks the
instant this ships.** The live `BACKLOG.md` (main checkout, as of this spec being written)
demonstrably carries duplicate clauses right now (§1). If Rule 5 were implemented as a `fail()`
call incrementing the same `failures` counter as Rules 1–4, the very next commit anyone makes
touching `BACKLOG.md`/`CHANGELOG.md`, in any worktree, would be rejected by
`check-bl-id-integrity.mjs` — which delegates into `check-backlog-markers.mjs` — until someone
manually runs `--fix` against the live file. §2.2/§3-D6 specify warn-only in default mode
specifically to avoid this. **Do not deviate from this even if it seems more "correct" to enforce
zero duplicates — that enforcement, if wanted at all, is a separate, deliberately-sequenced follow-up
(run `--fix` against the live file first, verify the diff, commit it, then flip the check to
blocking) and is explicitly out of scope for this packet.**

**R2 — No test may write to the real repo's `BACKLOG.md`/`CHANGELOG.md`.** After §2.1–2.3 land,
every one of these three scripts, invoked with **no path override** (there isn't one — the resolved
root is always computed internally), will target
`/Users/nix/dev/ai/sox-ecosystem/BACKLOG.md` when run from anywhere under that tree, including this
worktree. That file is being actively edited by other concurrent agents per this session's own
system context. §4's tests construct disposable `git init` scratch repos precisely so no invocation
under test ever resolves to the real path. When manually smoke-testing after the fix lands (§6),
only run the **zero-argument, read-only** forms (`check-backlog-markers.mjs`,
`check-bl-id-integrity.mjs` with nothing of interest staged) directly in this worktree — never
`allocate-bl-id.mjs` without `--dry-run`, and never `check-backlog-markers.mjs --fix`, against the
real tree, as part of implementing or verifying this packet.

**R3 — No `dist/` artifact, no `nx build`, involved anywhere in this packet.** All three files are
unbundled root-level `.mjs` scripts run directly by `node`; there is nothing to build and nothing
BL-235's destructive-`rm -rf`-before-rebuild hazard applies to. The one thing to avoid regardless:
do not run `npx nx build`/`npx nx test` on any *unrelated* project as a side effect of "just
checking something" — stay inside `node tools/...` invocations for this packet's own verification.

**R4 — Hook self-breakage.** This packet edits the exact scripts `.husky/pre-commit` runs
(`check-bl-id-integrity.mjs`, which delegates to `check-backlog-markers.mjs`) on every commit that
touches `BACKLOG.md`/`CHANGELOG.md`. After each edit, before committing that edit, verify the hook
still runs cleanly for a commit that does **not** touch either file (the common case — most commits
in this worktree, including the commit of this very spec file, will not stage `BACKLOG.md`) and
separately verify it for a commit that does (§4's tests cover the mechanics in isolation; also do
one real `git commit` in this worktree of a change that touches neither file, and confirm
`check-bl-id-integrity.mjs`'s "skipped" line still fires and the commit succeeds — this is the
cheapest possible live check that the arg-parsing changes didn't break the zero-arg path the hook
depends on).

---

## 6. The gate

No nx project owns any of `tools/allocate-bl-id.mjs`, `tools/check-backlog-markers.mjs`,
`tools/check-bl-id-integrity.mjs`, or the three new `tools/test-bl*.mjs` files (§3-D8). The gate is
therefore:

1. `node tools/test-bl416-shared-registry-lock.mjs` — watched fail against the current
   `--show-toplevel` code (checkout the pre-fix version of `allocate-bl-id.mjs` into a scratch copy,
   or `git stash`-free equivalent: run the test against `git show HEAD:tools/allocate-bl-id.mjs`
   materialized to a temp file, since `git stash` is banned repo-wide) before your fix, then watched
   pass after.
2. `node tools/test-bl446-arg-validation.mjs` — same red-then-green discipline, all three scripts.
3. `node tools/test-bl454-annotation-dedupe.mjs` — same.
4. `node tools/check-backlog-markers.mjs` (zero-arg, from inside this worktree) — must exit 0 and
   its stderr "validating ->" line must print the **main checkout's** absolute path
   (`/Users/nix/dev/ai/sox-ecosystem/BACKLOG.md`), confirming D1 landed correctly. Read-only, no
   risk (R2).
5. `node tools/check-bl-id-integrity.mjs` (zero-arg, from inside this worktree, nothing of interest
   staged) — must print the "skipped" line and both resolved-root stderr lines, and exit 0.
6. One real `git commit` in this worktree, of a change that touches neither `BACKLOG.md` nor
   `CHANGELOG.md` (e.g. this spec file itself, or the new `tools/test-bl*.mjs` files), through the
   real installed hook — confirms R4 without needing a separate hook-reinstall step (§2.4: hooks are
   already shared and live in this worktree).
7. `npx nx run-many -t build,lint,test,typecheck` is **not required** for this packet specifically
   (nothing changed under any nx project), but if the implementer's diff accidentally touches
   anything nx-tracked, run the standard project-scoped `npx nx lint/test/typecheck <project>` for
   whatever was touched, per the repo's own house rules — this should not happen if the change stays
   scoped to §2.1–2.3 plus the three new test files.

Do **not** pass `--skip-nx-cache` anywhere (moot here since no nx targets are in play, but stated for
completeness per house rules). Report `node tools/check-suite-tree-state.mjs --project <p>` only if
you end up running an nx test target for an unrelated reason — expected: you will not.
