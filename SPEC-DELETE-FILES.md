# SPEC — delete root `BACKLOG.md`/`CHANGELOG.md`; repoint `plan-status.mjs` at the backlog graph

**Author:** architect stage, `feat/delete-markdown-backlog`, worktree
`/Users/nix/dev/ai/sox-ecosystem/.worktrees/delete-markdown-backlog`.
**Reads relied on:** [`docs/decisions/0011-backlog-tool-write-destination.md`](../../docs/decisions/0011-backlog-tool-write-destination.md)
(ADR-0011, ACCEPTED, all citations below verified live against this worktree 2026-08-07),
[`docs/decisions/0009-backlog-source-of-truth.md`](../../docs/decisions/0009-backlog-source-of-truth.md)
(SUPERSEDED, evidence section still correct per its own header).
**Scope:** the **root** `BACKLOG.md`/`CHANGELOG.md` only. Sub-project files with the same name
(`libs/data/*/BACKLOG.md`, `libs/data/*/AGENTS.md`, `docs/plan/runtime-productionization/BACKLOG.md`,
`libs/authoring/src/templates/**` scaffolding that writes a *new* per-extension `CHANGELOG.md`) are
**out of bounds** — see "Files out of bounds" below. ADR-0011 and this packet are scoped to the
`BL-*` family and the two root files that family lived in; nothing else.

---

## 0. Precondition check the implementer must run first, before editing anything

The dispatch brief states the graph is "complete and verified" with ~320 migrated items, all
existence-audited. This spec was written against a live read, not the brief's claim alone:

```
$ mcp__backlog__backlog_export_json {repo:"sox-ecosystem", family:"BL", limit:500}
  -> 417 items total (RESOLVED + OPEN + others), citations: 467 CHANGELOG.md, 11 BACKLOG.md, 7 other
```

Re-run an equivalent count (`backlog list-items --filter '{"repo":"sox-ecosystem","family":"BL"}'`
paginated, or `backlog export-json`) at implementation time and diff the count against 417. If it is
lower, STOP — the migration regressed since this spec was written and the citation-pinning step
(§6) will silently under-cover. If it is higher (more items filed since), proceed; the pinning
script in §6 is written to discover citations dynamically, not against a hardcoded list.

---

## 1. Root cause (personally verified, file:line)

1. **`tools/plan-status.mjs:39`** — `const BACKLOG = resolve(ROOT, 'BACKLOG.md');` is the sole data
   source. **`tools/plan-status.mjs:102-119`** (`readBacklogStatuses`) regexes
   `/^### BL-(\d+) — ([^\n]*)$/gm` out of that file and builds the `Map<number, statusString>` that
   every downstream consumer (`isOpen` at line 123, `classify` at 153-158, `renderPlanBlock` at
   173-210, `renderStateBlock` at 212-248, `auditProse` at 368-421 via `model.statuses`) reads. This
   is the one function that must change; per ADR-0011 §"R2" the rest is untouched by design.

2. **`tools/check-backlog-markers.mjs:90,97`** — resolves `FILE = path.join(REPO_ROOT, 'BACKLOG.md')`
   and validates heading grammar against it. Deleting the file makes every run of this script either
   throw on `readFileSync` (ENOENT, an unhandled exception — worse than a clean failure) or, if run
   from a stale mental model, silently validate nothing.

3. **`tools/check-bl-id-integrity.mjs:156-157`** reads both `BACKLOG.md` and `CHANGELOG.md`
   unconditionally at module load (`readFileSync(BACKLOG, 'utf8')` line 203). It also reads
   **`.bl-id-counter.json`** (line 257) for checks 4/5, and is **invoked unconditionally by every
   commit** — `.husky/pre-commit:21` calls `node tools/check-bl-id-integrity.mjs` with no `if` guard,
   unlike the `plan-status.mjs --check` call three lines later which IS conditioned on
   `BACKLOG.md`/`PLAN.md`/`STATE.md` being staged (`.husky/pre-commit:34-37`). This distinction is
   load-bearing for §5's ruling below — the two scripts cannot receive symmetric retirement
   treatment without breaking pre-commit for every future commit.

4. **`tools/bl-id-counter.mjs:11,18`** — its watermark computation is
   `max(highest BL-N in BACKLOG.md headings, highest BL-N in either CHANGELOG.md grammar, graph max)`
   per its own header comment. Both markdown inputs disappear.

5. **`tools/allocate-bl-id.mjs`** is already a retired no-I/O stub (verified by reading it in full —
   its default path prints `RETIREMENT_MESSAGE` and exits 1, zero filesystem/git calls). It needs no
   further edit for correctness, but see §5.6 for a real, currently-failing test it breaks.

6. **478 citations across the graph point at these two files and go dead the instant they are
   deleted** — measured via `backlog_export_json`:
   - 433 citations `{file: "CHANGELOG.md", lines: "N-M"}` (a spot check: `BL-337` → `290-322`,
     `BL-150` → `4747-4784`).
   - 34 citations `{file: "CHANGELOG.md"}` with no `lines`, only `context` prose.
   - 11 citations pointing at `BACKLOG.md` (10 as a bare `{file: "/Users/nix/dev/ai/sox-ecosystem/BACKLOG.md"}`
     with an absolute, machine-specific path baked in — a pre-existing data-quality defect, not
     introduced here, out of scope to fix beyond what commit-pinning already repairs; 1,
     `BL-423`, as `{file:"BACKLOG.md", lines:"9"}`).
   - **`CHANGELOG.md` has been edited 3 times since the 2026-08-06 migration** (verified:
     `git log --oneline --since="2026-08-06T17:00:00" -- CHANGELOG.md` → `469d1ab1`, `c40b186b`,
     `e4b2140f`). Line numbers recorded in citations created before those edits may already be
     off by a few lines relative to current HEAD, **independent of this packet**. Commit-pinning
     (§6) preserves whatever a citation currently points at, correct or not — it does not audit or
     repair citation accuracy. That is out of scope here; see Risk R5.

7. **`docs/reporting/memory/README.md:8,20,40,48,58`**, **`CONTRIBUTING.md:163-231`**,
   **`AGENTS.md:11,80-86,204-240`**, **`docs/reporting/memory/STATE.md:9`**,
   **`docs/reporting/memory/PLAN.md:6-8,15,17`** all instruct agents to read or hand-edit the file
   about to be deleted. Grepped and read in full; itemized file-by-file in §3.

---

## 2. Every decision, ruled

### D1 — status mapping: markdown marker prose → graph `status` enum

The graph's `status` field is the single source `isOpen()` reads. **Graph `priority` is NOT
consulted** — `plan-status.mjs` never had a priority-driven code path (`OUT_OF_SCOPE` at
lines 89-100 is a hardcoded id allowlist, not priority-derived); its output tables have no priority
column (`renderPlanBlock`/`renderStateBlock` columns are Packet/Status/Targets/Still-open only).
**Do not add a priority column or a priority-based filter — that is a scope expansion nobody asked
for and it is not needed to reach parity.**

Old open-set (`isOpen`, `tools/plan-status.mjs:123`): `{OPEN, REOPENED, BLOCKED}`; anything else
(including absence) is closed.

**Ruling — new open-set, mapped from the graph's status enum**
(`backlog_transition_status`'s documented enum):

| Graph status | Open? | Reasoning |
|---|---|---|
| `OPEN` | **open** | direct carry-over |
| `IN_PROGRESS` | **open** | actively worked, not done — old markdown had no separate marker for this, it was just `OPEN` prose; treat the same |
| `PARTIAL` | **open** | some work remains on the item itself (distinct from a *packet's* PARTIAL status, which is derived separately in `classify()` — an item-level PARTIAL still counts as "not done" for that id) |
| `OUTSTANDING` | **open** | same reasoning as PARTIAL — work remains |
| `DEFERRED` | **open** | intentionally not being worked now, but not resolved; same shape as the `OUT_OF_SCOPE` id list already does — those ids stay in `openIds` and are only *excluded from the unscheduled/no-packet warning*, never treated as done. A `DEFERRED` id that needs the same treatment gets added to `OUT_OF_SCOPE` by hand, same as today. |
| `BLOCKED` | **open** | direct carry-over |
| `MIXED` | **open** | ambiguous/partial by definition — fail toward "still needs attention," not toward "done" |
| `UNKNOWN` | **open** | **conservative default.** An unverified state must never be silently counted as closed — that is the exact failure mode BL-225 exists to prevent (a status recorded without a red→green verification). Old markdown had no equivalent value; if it had, the same reasoning would apply. |
| `FIXED`, `RESOLVED`, `DONE`, `SHIPPED`, `VERIFIED` | **closed** | verified-complete states |
| `REMOVED`, `MITIGATED`, `SUPERSEDED`, `INVALID`, `DUPLICATE`, `WONTFIX` | **closed** | terminal, no further action states — direct carry-over of markdown's `CLOSED`/`WONTFIX` treatment |
| lowercase `open` / `closed` aliases | mapped to the same buckets by case-insensitive match | schema documents these as valid literal values distinct from the enum; treat identically to `OPEN`/`RESOLVED` respectively |

Implementation: `isOpen(statuses, id)` stays a pure function of `(Map, id) => boolean` with the
**same signature** it has today (`tools/plan-status.mjs:123`) — only the membership set changes,
from `['OPEN','REOPENED','BLOCKED']` to the open-set above. Every caller (`classify`, `build`,
`auditProse`) is untouched. **Do not inline the open-set check anywhere else — one set, one place.**

**Losing alternative — treat `UNKNOWN`/`MIXED`/`DEFERRED` as closed (i.e., only `OPEN`/`BLOCKED` are
open).** Loses because it silently drops real open work from `openIds`/`unscheduled`, recreating
exactly the "PLAN.md named 39 already-closed ids" / "62% uncovered" failure class this whole tool
exists to prevent (`tools/plan-status.mjs:8-11`), just inverted (now hiding open work instead of
naming closed work as open).

### D2 — data source mechanism: shell out to the `backlog` CLI, not the MCP protocol, not a direct
library import

`plan-status.mjs` must run synchronously inside `.husky/pre-commit` (no async MCP session available
in a git hook) and must match the house pattern already used by every sibling script in `tools/` —
`check-bl-id-integrity.mjs:152-155`, `check-backlog-markers.mjs:86-89`, and `backlog-stats.mjs:46`
all resolve state via `execFileSync('git', [...])`. `backlog` is a first-class CLI on `PATH`
(verified: `which backlog` → `/Users/nix/Library/pnpm/backlog`, `backlog version` →
`{"name":"@adhd/backlog","version":"0.1.4"}`) with the exact same command surface as the MCP tools
(verified: `backlog list-items --filter '<json>'` and `backlog get-item --repo <r> --human-id <id>`
both return the identical JSON shape the MCP tool returns). Use it the same way `git` is used today.

**Ruling:** `readGraphStatuses()` (renamed from `readBacklogStatuses`, see D7) calls
```js
execFileSync(BACKLOG_BIN, ['list-items', '--filter', JSON.stringify({ repo: 'sox-ecosystem', family: 'BL', excludeArchived: false, limit: PAGE, offset })], { encoding: 'utf8' })
```
paginated (`PAGE = 200`, loop incrementing `offset` until a page returns fewer than `PAGE` items —
**never trust an assumed single-call max**; 417 known live items already exceeds a naive default
`limit`), where `BACKLOG_BIN = process.env.PLAN_STATUS_BACKLOG_BIN || 'backlog'` (the same
env-var-override-for-testability pattern `tools/test-bl446-arg-validation.mjs:37-45` already
establishes for `allocate-bl-id.mjs`/etc — this lets a test point at a fake `backlog` script without
touching the real graph). `excludeArchived: false` is required — `staleRefs` (line 167) needs closed
ids too, so the query must return the full family, not just currently-open items.

**Losing alternative — import `@adhd/backlog`'s internals as a library dependency.** Loses: that
package's `src/` is not a published/stable API surface for this repo to depend on directly (its CLI
and MCP tool surface *is* the stable contract — the same reasoning ADR-0009 already used when it
refused to reach into `renderItemBlock` to fix rendering rather than routing around it). Adding it as
a `package.json` dependency also drags an external repo's release cadence into this repo's build.

**Losing alternative — have `plan-status.mjs` open an MCP client connection itself.** Loses: no
synchronous, dependency-free MCP client exists in this repo's toolchain today, and the script must
run inside a `sh` pre-commit hook with no astronomy for bootstrapping an async session per invocation
(every other guard in `.husky/pre-commit` is a synchronous `node` process that exits).

### D3 — pagination and error handling: a CLI failure must be loud, never silently "zero items"

If `execFileSync` throws (binary not found, non-zero exit, malformed JSON), `readGraphStatuses()`
must **rethrow with a clear, actionable message** (name the command that failed, the exit code, and
point at `backlog version`/`backlog ping`-equivalent troubleshooting) — **never catch-and-return an
empty Map.** An empty Map silently reports every packet as `NO-TARGET`/every id as absent-therefore-
closed, which is a false "everything is done" reading — the single worst failure mode this script
can produce, directly the class of error BL-225/BL-435 exist to prevent. This is not hypothetical:
`--check` runs unconditionally in the new pre-commit wiring (D6), so a transient graph-store hiccup
must fail the commit loudly, not pass it silently. `git commit --no-verify` is the pre-existing,
already-documented escape hatch for this class of infra flake (used elsewhere in this repo's hooks);
this packet does not add a new one and must not swallow the failure into a false green instead.

### D4 — retirement shape for `check-backlog-markers.mjs` and `check-bl-id-integrity.mjs`: same
message pattern, DIFFERENT default-invocation behavior, because one is unconditionally wired into
every commit and the other is not

Both scripts adopt `allocate-bl-id.mjs`'s established retirement pattern for **user-facing shape**:
`--help`/`-h` still print usage and exit 0 with zero git/file I/O (BL-446 non-regression, unchanged);
an unrecognized flag still exits 1 (a real usage error, unrelated to retirement). Where they diverge:

- **`check-backlog-markers.mjs`** is reachable today only by (a) direct manual invocation (a habit,
  or `README.md`'s checklist — updated in §3) and (b) `check-bl-id-integrity.mjs`'s internal
  delegation (`check-bl-id-integrity.mjs:194-200`, removed in this same change per below). Once (b)
  is removed, this script is **never invoked by any automated path**. Its default (zero-arg)
  invocation therefore follows `allocate-bl-id.mjs` exactly: print a retirement message pointing at
  `plan-status.mjs`/the graph, **exit 1**. This matches the dispatch brief's explicit instruction
  ("refuse with a pointer, do not silently pass") because nothing automated depends on it passing.

- **`check-bl-id-integrity.mjs`** is invoked **unconditionally, with no `if` guard, by every single
  commit** (`.husky/pre-commit:21`, confirmed no conditional wraps it, unlike the `plan-status.mjs
  --check` call three lines below which IS conditional). If this script's default invocation also
  hard-exits 1, **every commit in the shared checkout breaks the instant this packet lands**, for
  every one of the "five workflows" the dispatch brief itself names as sharing this checkout. That
  is exactly the "repo-wide outage" risk the brief warns about, self-inflicted. **Ruling: remove the
  unconditional `node tools/check-bl-id-integrity.mjs` line from `.husky/pre-commit` entirely** (§3,
  file 4) — its entire reason to exist (catch a markdown-vs-graph BL-id collision) is structurally
  impossible once nothing writes `BACKLOG.md`/`CHANGELOG.md` at all, which is ADR-0011 §4 Stage 3
  item 3's own stated reasoning, verbatim: *"once nothing writes `BACKLOG.md` for `BL-*` at all,
  id-collision between the two stores is structurally impossible rather than guarded-against."* Once
  removed from the hook, `check-bl-id-integrity.mjs` is — like `check-backlog-markers.mjs` — reachable
  only by manual invocation, and gets the identical treatment: zero-arg exits 1 with a retirement
  pointer. Safe now, because nothing automated depends on its exit code anymore.

**Losing alternative — make both scripts silently exit 0 on default invocation ("nothing to guard,
pass").** Loses for `check-backlog-markers.mjs` specifically per the brief's explicit instruction, and
loses in general on the same reasoning BL-446's own history establishes (`tools/check-backlog-markers.mjs`'s
own docstring, and `test-bl446-arg-validation.mjs`'s title): *"an unrecognized flag must never fall
through to running the full check silently"* — the sibling failure mode of *"a retired check must
never fall through to silently passing"* is the same principle, and a check that unconditionally
passes is indistinguishable from a check that was never wired up, which defeats its own future
diagnostic value (anyone reading its output later cannot tell "verified clean" from "never ran").

**Losing alternative — delete both files outright instead of retiring them as stubs.** Loses: history
(`git blame`/`git log -S`) and any stray direct invocation (an agent running `node
tools/check-backlog-markers.mjs` out of muscle memory, or a doc still naming it before every stray
reference is caught) gets a much worse failure — `Error: Cannot find module` — than an informative,
on-brand retirement message. `allocate-bl-id.mjs` was not deleted either; this stays consistent.

### D5 — `check-bl-id-integrity.mjs`'s delegation to `check-backlog-markers.mjs` (line 194-200) is
removed, not just left to fail

Once `check-backlog-markers.mjs`'s default invocation prints a retirement message and exits 1 (D4),
`check-bl-id-integrity.mjs`'s `try { execFileSync(...check-backlog-markers.mjs...) } catch { fail(...)
}` (`tools/check-bl-id-integrity.mjs:194-200`) would treat that exit code as a **real BL-359 rule-1
violation** and report a confusing `FAIL check-backlog-markers.mjs reported a violation` for a script
that is retired, not broken. Delete the delegation block entirely as part of the same edit that
retires `check-bl-id-integrity.mjs`'s own body (its checks 2-10 all read files or `.bl-id-counter.json`
that no longer exist — the whole body is dead code once markdown is gone, not just the delegation).

### D6 — `.husky/pre-commit`'s `plan-status.mjs --check` trigger becomes **unconditional**

Current condition (`.husky/pre-commit:34-37`):
```sh
if git diff --cached --name-only | grep -qxE 'BACKLOG.md|docs/reporting/memory/(PLAN|STATE).md'; then
  node tools/plan-status.mjs --check
fi
```
This assumed the data source (`BACKLOG.md`) was itself a tracked file, so staging it was a reliable
proxy for "the derived blocks might now be stale." **That assumption is false the moment the data
source moves to the graph**: an agent can `backlog_transition_status` an item to `RESOLVED` with
**zero local file changes**, then the next, entirely unrelated commit in this repo lands with
`PLAN.md`/`STATE.md` now stale relative to the graph — and under the old condition, that commit
would never trip the guard, because neither `PLAN.md` nor `STATE.md` was staged *in that commit*.
That is a silent-staleness regression this packet would otherwise introduce.

**Ruling:** run `node tools/plan-status.mjs --check` **unconditionally**, on every commit, dropping
the `git diff --cached` gate entirely. Cost: one `backlog list-items` CLI shellout (paginated,
`~417` items today) plus a string diff against two files, on every commit — cheap relative to the
`npx nx affected --target=lint` call that already runs unconditionally on the very next line
(`.husky/pre-commit:39`).

**Losing alternative — keep the file-staged condition, add nothing.** Loses per the staleness
scenario above — it is not merely weaker, it is now systematically blind to the most common way
staleness will actually occur post-cutover (a status transition via the tool, disconnected from any
commit).

**Losing alternative — add a periodic/scheduled re-check instead of gating every commit.** Loses for
the same reason ADR-0011 §"R3" already rejected periodic reconciliation over a hard gate: it accepts
a window where a stale document reads as authoritative, which is the exact condition this entire
tool was built to eliminate (`tools/plan-status.mjs:5-15`).

### D7 — `readBacklogStatuses` is renamed `readGraphStatuses`; internal names updated to match, exported surface unchanged

Rename for honesty (it no longer reads a file called `BACKLOG.md`). **Do not rename or change the
signature of `isOpen`, `classify`, `build`, `renderPlanBlock`, `renderStateBlock`, `stampPackets`,
`renderStamp`, `auditedRegions`, `auditProse`, `boldTokens`, `actionableLines`, `replaceBlock`, or
`STAMP_RE`.** Verified by reading `tools/test-bl435-unguarded-prose.mjs:87-99` and
`tools/test-bl464-duplicate-status-stamp.mjs` in full: **both existing regression tests construct
their own synthetic `model` object by hand and call `auditProse`/`stampPackets` directly — neither
test calls `readBacklogStatuses` or `build()` at all.** This means the D1 status-mapping rewrite and
the D2 data-source rewrite are **fully isolated** from both existing tests; they must still pass
unmodified (see Acceptance AC-plan-status-existing-tests-still-pass). This is the concrete evidence
for ADR-0011 §"R2"'s claim that this is "a narrow, load-bearing-but-contained edit."

### D8 — `tools/bl-id-counter.mjs` and `.bl-id-counter.json` are retired (deleted), and new `BL-*`
items are filed via `backlog_create_item` **without** `idOverride`, letting `computeNextHumanId`
auto-allocate

ADR-0011 §4 Stage 3 item 3 already rules this: *"Retire `tools/allocate-bl-id.mjs`, the R5 counter
artifact, and the R3 watermark guard — they exist only to bridge Stages 1–2; once nothing writes
`BACKLOG.md` for `BL-*` at all, id-collision between the two stores is structurally impossible rather
than guarded-against."* This packet **is** that "once nothing writes" moment.

Restated for this spec: `computeNextHumanId`'s risk (B4/BL-476) was specifically that it is
**graph-only** and blind to markdown-only history. §0's precondition check exists precisely to
confirm there is no more markdown-only history left uncaptured before this ruling is exercised. Once
`BACKLOG.md`/`CHANGELOG.md` are deleted in the same change, there is no longer a second write surface
for an id to exist on *without* the graph knowing — the category of bug B4 describes (an id minted
elsewhere that the graph's own max never saw) becomes structurally unreachable, not merely
mitigated, because there is no "elsewhere" left.

**Acceptance-grounding action, not just an argument:** the implementer files this packet's own
umbrella tracking item as the live proof — `backlog create-item` (no `idOverride`), family `BL`,
repo `sox-ecosystem`, and confirms the returned `humanId` is exactly `watermark_before + 1` relative
to `.bl-id-counter.json`'s last known state (`watermark: 478, next: 480, issued: [BL-479]` — so the
next real id must be `BL-480`, and must not collide with anything). See AC-D8.

**Losing alternative — keep `bl-id-counter.mjs` alive, rewritten to source its watermark from the
graph only.** Loses: a graph-only watermark computation is just `computeNextHumanId` again, wrapped
in an extra script with no remaining information advantage — the entire reason the counter existed
(seeing markdown history the graph could not) is gone, so keeping it is dead weight that itself needs
maintenance (its own tests, `tools/test-adr0011-bl-id-counter.mjs`, would need a parallel rewrite for
zero behavioral gain over calling `backlog_create_item` directly).

Update `CONTRIBUTING.md` §1.9 (§3 file 6 below) to drop the "reserve via `bl-id-counter.mjs`, pass
`idOverride`" procedure and replace it with a plain `backlog_create_item` call, no `idOverride`.

### D9 — citation commit-pinning: `<sha>:<path>:<lines>`, ADD-only, via the `backlog` CLI, sequenced
strictly after every other content change and strictly before `git rm`

**Form chosen: commit-pin (`<sha>:<path>[:<lines>]`), not inline the cited content.** Inlining 433
citations' worth of `CHANGELOG.md` excerpts (each 20-50+ lines) into the graph's `citation.context`
field would multiply the graph's stored content by tens of thousands of characters for information
git history already durably holds — and this repo already treats git history as the authoritative
long-term record for exactly this kind of material (`AGENTS.md`'s BL-465 commit-mine section, the
`git log --follow` requirement in this packet's own gate). Commit-pinning is O(1) storage per
citation (a 7-40 char sha prefix swapped into an existing string field) and directly answers "does
this citation still resolve" with a plain `git show <sha>:<path>`.

**Mechanism (ADD, never replace/remove) — a real tool-surface constraint, not a preference:**
`backlog add-citation` (CLI) / `backlog_add_citation` (MCP) only **appends**; nothing in either
surface removes or replaces an existing citation. Confirmed by reading the full CLI command table
(`backlog --help`) and this dispatch's provided tool list — there is no `remove-citation` or
`update-citation` verb, and `backlog update-item`'s `patch` object has no `citations` field. Editing
`~/.adhd/backlog/production`'s SQLite directly, or patching `@adhd/backlog`'s source, are both
**out of bounds** for the same reason ADR-0011 ruled them out of bounds for its own dispatch (external
repo, not authorized here either) — this spec does not authorize either. **Ruling: for every stale
citation, ADD a new citation carrying the pinned form; the stale, now-unresolvable original citation
is left in place, side-by-side.** This is a real, accepted residual — see Risk R5. It costs nothing
(an extra array entry) and loses no information (the pinned citation is strictly additive), so
leaving it is correct, not merely tolerated.

**`<sha>` selection: the commit immediately BEFORE the `git rm` commit — computed once, used for
every citation in this pass.** Procedure:
1. Land every other change in this spec (plan-status repoint, checker retirement, pre-commit edit,
   doc updates, bl-id-counter retirement) as one or more commits, with `BACKLOG.md`/`CHANGELOG.md`
   **still present and unmodified** by any of those commits.
2. `PIN_SHA=$(git rev-parse HEAD)` at that point — this is the last commit where
   `git show $PIN_SHA:CHANGELOG.md` / `:BACKLOG.md` return the exact content every existing
   citation's `lines` field was measured against (mod Risk R5's already-acknowledged drift).
3. Run the pinning script (new file, `tools/pin-changelog-citations.mjs`) with `--sha=$PIN_SHA`,
   `--dry-run` first, then for real. It must:
   - Enumerate every live `BL`-family, `sox-ecosystem`-repo item via paginated `backlog list-items`
     (same pagination discipline as D2 — do not assume a single page covers all 417+ items).
   - For each citation whose `file` field is exactly `CHANGELOG.md`, `BACKLOG.md`, or an absolute
     path ending in either (`/.../BACKLOG.md`, matching the 10 legacy-absolute-path citations found
     in §1.6), construct the new citation: `{ file: "${sha}:${basename}", lines: <same lines, if
     present>, context: <same context, if present> }`.
   - Call `backlog add-citation --repo sox-ecosystem --human-id <id> --citation '<json>'` per stale
     citation found (expect ~478 calls total; batch sequentially, no concurrency needed — SQLite
     writes are fast and this runs once).
   - Print a summary: items touched, citations added, any item where the CLI call itself failed
     (non-zero exit) — a partial-failure summary, not a silent partial run.
   - `--dry-run` prints the same summary without calling `add-citation`, for review before the real
     run.
4. `git rm BACKLOG.md CHANGELOG.md` as the **final** commit — see Risk R1 for why this ordering
   (content first, pin second, delete third) is the one sequencing that cannot destroy data.

**Losing alternative — pin at the *original migration* commit (2026-08-06) instead of the pre-deletion
HEAD.** Loses: `CHANGELOG.md` was edited 3 times after that point (§1.6) — pinning at the older sha
would resolve, but to content that is now provably stale relative to what an agent reading the
citation today would find at HEAD, which is a strictly worse outcome than pinning at the freshest
sha that still has the file.

### D10 — files out of bounds, named and why

| File / class | Why untouched |
|---|---|
| `libs/data/**/BACKLOG.md`, `libs/data/**/AGENTS.md` | Per-package backlogs, independent of the `BL-*` family and ADR-0011's scope; deleting/repointing the root files has zero bearing on them. |
| `docs/plan/runtime-productionization/BACKLOG.md` | A different, self-contained plan's own backlog doc — not the file `tools/plan-status.mjs`/the checkers ever read. |
| `libs/authoring/src/templates/**/index.ts` (scaffolding that writes a per-extension `CHANGELOG.md`) | Templates for *new extensions'* own changelogs — unrelated file, unrelated convention, confirmed by reading the grep hits (`_shared.ts`, `skill/index.ts`, etc. all scaffold a fresh empty file for a newly authored extension). |
| `scripts/*.test.ts` (`v2-e2e.test.ts`, `install.test.ts`, `validate-manifests.test.ts`, `bundle-collision.test.ts`, `install-multiscope.test.ts`) | Write throwaway `CHANGELOG.md` fixtures **inside a scratch extension directory** as part of manifest-validation test fixtures — confirmed by reading surrounding context (`path.join(extDir, 'CHANGELOG.md')`); unrelated to the root file. |
| `scripts/build-index.ts:154-171` (`CHECKSUM_IRRELEVANT_ROOT_FILES`) | A checksum-exclusion set that already treats `BACKLOG.md`/`CHANGELOG.md` as "never part of an extension payload." An entry naming a file that no longer exists is inert (the set is only ever tested for membership, never iterated to require existence) — leaving it is harmless; removing it is optional cleanup, implementer's discretion, not required for correctness. |
| `libs/memory-core/src/*.spec.ts`, `libs/memory-core/src/autolink.ts`, `libs/memory-core/src/write.ts` — inline comments citing `BACKLOG.md BL-NNN` | Prose comments recording historical bug provenance, not live tooling. Rewriting every historical code comment across the repo that happens to name `BACKLOG.md` is disproportionate and not required for correctness — the comment remains true as history ("this was filed in what was then BACKLOG.md"); it does not need to track the file's current existence. Do not touch these. |
| `.workflow/plans/**` | Archived planning documents predating this repo's current structure; historical narrative, same treatment as `STATE.md`'s own "History is not re-verified" convention (`docs/reporting/memory/STATE.md:15-17`). Do not touch. |
| `~/.claude/CLAUDE.md:45` (global disclosure protocol) | Out of scope per ADR-0011 §"What does NOT change" — global, cross-repo, owner-editable only. This packet's deletion of the root files makes that global instruction's default fallback ("store to the project's BACKLOG.md") describe a file that no longer exists for *this* repo specifically; that is a known, owner-acknowledged residual (ADR-0011 §5 already gives the owner the exact recommended replacement text) and is explicitly not this packet's job to fix. |
| `docs/reporting/memory/PLAN.md` prose below line ~40 (historical narrative: wave summaries, incident write-ups, `BACKLOG.md`-referencing design rationale dated in the past) | Per `PLAN.md:6-10`'s own stated convention ("Prose elsewhere in this file is design rationale... may describe a defect that has since been fixed... the ledger wins"), historical prose is deliberately not kept in sync with present tense. Only the **active/prescriptive** banner (line 6, "generated from `BACKLOG.md`") needs a one-line wording fix; leave the rest. |

---

## 3. The change, file by file

### 1. `tools/plan-status.mjs` — repoint the data source (D1, D2, D3, D6, D7)

- Rename `BACKLOG` const and `readBacklogStatuses` → `readGraphStatuses` (or keep a thin re-exported
  alias if that reduces test churn — implementer's call, but the primary name must reflect reality).
- Delete the `const BACKLOG = resolve(ROOT, 'BACKLOG.md');` file-path constant entirely; add
  `const BACKLOG_BIN = process.env.PLAN_STATUS_BACKLOG_BIN || 'backlog';`.
- Rewrite `readGraphStatuses()` per D2/D3: paginated `backlog list-items` calls via `execFileSync`,
  build the same `Map<number, string>` shape (`id -> rawStatusString`) `readBacklogStatuses` built,
  by reading each returned item's `humanId` (strip `BL-` prefix, `Number(...)`) and `status` field.
  **Do not read `title` for the status** — unlike the old markdown heading, the graph's `title` field
  on migrated items still carries leftover embedded prose like `— **Open (LOW, feature)...**` from
  the original import (confirmed live: `BL-215`'s title ends `"— **Open (LOW, feature) (2026-07-05)**"`)
  — that is cosmetic import residue, not the source of truth. The `status` field is authoritative.
- `isOpen()` keeps its exact signature; only the membership set changes per D1's table.
- Every other function (`readPackets`, `classify`, `build`, `renderPlanBlock`, `renderStateBlock`,
  `stampPackets`, `renderStamp`, `auditedRegions`, `actionableLines`, `boldTokens`, `auditProse`,
  `replaceBlock`, `main`) is **byte-for-byte unchanged** except for the one call site in `build()`
  that invokes `readGraphStatuses()` instead of `readBacklogStatuses()`.
- Update the file's own header docstring (lines 1-32) to describe the graph as the data source, not
  `BACKLOG.md` — the "WHY THIS EXISTS" narrative (lines 6-26) stays conceptually correct (derive, not
  hand-maintain) but its literal wording ("derive it... from BACKLOG.md's own status header") needs
  the noun swapped.
- `OUT_OF_SCOPE` (lines 89-100) is untouched — it is an id allowlist, source-independent.

### 2. `tools/check-backlog-markers.mjs` — retire (D4)

Full-file rewrite following `tools/allocate-bl-id.mjs`'s exact shape: keep the `USAGE` string (update
its content — no more `BACKLOG.md`, point at `plan-status.mjs`/the graph/`CONTRIBUTING.md` §1.9),
keep `--help`/`-h` handling identical (zero I/O, exit 0), keep unrecognized-flag handling identical
(exit 1). Replace the entire validation body (everything from `REPO_ROOT` resolution at line 86
onward) with: print a `RETIREMENT_MESSAGE` to stderr explaining the file it used to validate is gone
and pointing at the graph, and `process.exit(1)`.

### 3. `tools/check-bl-id-integrity.mjs` — retire (D4, D5)

Same shape as file 2. Delete the delegation to `check-backlog-markers.mjs` (D5) along with everything
else — the whole 10-check body (`BACKLOG`/`CHANGELOG` reads, `.bl-id-counter.json` read, all `git
diff --cached` calls) is dead once markdown is gone. Keep `--help`/unrecognized-flag handling
identical to today.

### 4. `.husky/pre-commit` — remove the unconditional `check-bl-id-integrity.mjs` call; make
`plan-status.mjs --check` unconditional (D4, D6)

```diff
 SOX_GIT_PARENT_CMD="$(ps -o args= -p $PPID 2>/dev/null)" node tools/check-amend-shared-index.mjs

-# BL-359 — reject BL-<n> id collisions before they reach BACKLOG.md/CHANGELOG.md.
-node tools/check-bl-id-integrity.mjs
-
-# Keep the memory-program plan honest: PLAN.md's packet ledger and STATE.md's progress summary are
-# DERIVED from BACKLOG.md's heading markers. Closing an item without regenerating them leaves two
-# documents that read as authoritative while being wrong — the exact failure this guard exists to
-# stop (PLAN.md once named 39 already-closed ids).
-#
-# BL-435 — this must also fire on PLAN.md/STATE.md themselves. The old condition was BACKLOG.md
-# only, on the reasoning that "a change elsewhere cannot invalidate the derived blocks". That is
-# true of the derived blocks and false of the audited hand-written sections the same tool now
-# checks: STATE.md's "What to do next" went stale by someone editing STATE.md, a commit that never
-# stages BACKLOG.md. Guarding only the BACKLOG.md trigger would leave the guard blind to precisely
-# the edit that introduces the defect.
-if git diff --cached --name-only |
-  grep -qxE 'BACKLOG.md|docs/reporting/memory/(PLAN|STATE).md'; then
-  node tools/plan-status.mjs --check
-fi
+# [ADR-0011 Stage 3] BL-id collision guards (check-bl-id-integrity.mjs / check-backlog-markers.mjs)
+# are retired — BACKLOG.md/CHANGELOG.md no longer exist, so the split-brain they guarded against
+# (a hand-added heading colliding with a tool-filed id) is now structurally impossible, not merely
+# checked-for. See docs/decisions/0011-backlog-tool-write-destination.md §4 Stage 3 item 3.
+#
+# Keep the memory-program plan honest: PLAN.md's packet ledger and STATE.md's progress summary are
+# DERIVED from the live backlog graph. Unlike the retired BACKLOG.md-staged trigger, this now runs
+# UNCONDITIONALLY — the graph can drift stale from a status transition that touches zero files in
+# this repo, so no file-staged condition can reliably catch it (BL-435's failure mode, generalized).
+node tools/plan-status.mjs --check

 npx nx affected --target=lint --base=HEAD~1 --head=HEAD
```

**After editing, re-run `node tools/install-git-hooks.mjs`** (per this file's own header comment,
lines 1-9: edits to `.husky/pre-commit` do not take effect until the installer re-copies it into
`.git/hooks/pre-commit`) — this is an acceptance step, not optional (AC-precommit-live).

### 5. `tools/allocate-bl-id.mjs` — DELETE

Already a fully retired, zero-I/O stub (verified by reading it in full — no BACKLOG.md/CHANGELOG.md
touch anywhere left). Per ADR-0011 §4 Stage 3 item 3, it is explicitly named for retirement at this
stage; keeping a stub around whose entire purpose was bridging a two-stage migration that has now
fully landed is dead weight. Delete the file. Its retirement message (which references
`bl-id-counter.mjs`, also being deleted per D8) would otherwise become self-contradictory anyway.

### 6. `tools/bl-id-counter.mjs`, `.bl-id-counter.json` — DELETE (D8)

Both. No replacement artifact — `backlog_create_item`/`backlog create-item` with no `idOverride` is
the entire replacement procedure (D8).

### 7. New file: `tools/pin-changelog-citations.mjs` (D9)

One-shot (but kept, not thrown away — reusable if a future migration needs the same treatment)
script implementing D9's mechanism. `--sha=<sha>` required, `--dry-run` flag, no default-mutate
behavior (must pass `--dry-run` OR an explicit `--apply` — pick one, document it in the script's own
`--help`, matching the rest of `tools/`'s convention of never mutating on a bare invocation with no
flags. `commit-mine.mjs`'s "always dry-run first" convention, `AGENTS.md:85`, is the house pattern to
follow).

### 8. Root `BACKLOG.md`, `CHANGELOG.md` — `git rm`, final commit (D9 step 4)

### 9. `CONTRIBUTING.md` §1.9 (lines 163-231) — rewrite

Replace the entire section. Required content (exact wording is the implementer's call, meaning is
not):
- New `BL-*` items: `backlog_create_item` (or `backlog create-item` CLI), family `BL`, repo
  `sox-ecosystem`, **no `idOverride`** (D8 — drop the counter-reservation step entirely; delete the
  bash block at lines 174-185 that shells to `tools/bl-id-counter.mjs`).
- Status transitions/claims/notes/citations: unchanged prose (`backlog_transition_status` /
  `backlog_claim_item` / `backlog_append_note` / `backlog_add_citation` — this part of the existing
  text, lines 200-202, is already correct and forward-looking; keep it, drop only its trailing clause
  "never a hand-edited `### BL-<n>` heading in `BACKLOG.md`" since that file no longer exists to
  contrast against).
- Delete the entire "Rule G1-G4 enforcement surface" description (lines 204-231) — describes
  `check-bl-id-integrity.mjs` checks that no longer exist post-retirement.
- Delete "There is no discovery-time exception" paragraph's `BACKLOG.md`-specific framing (lines
  226-231); keep its actual point (every new defect, regardless of when discovered, files through the
  tool) since that point is still true and still worth stating.

### 10. `docs/reporting/memory/README.md` — rewrite lines 8, 20, 40, 48-50, 55-59

- Line 8: `"defects go in the root BACKLOG.md — nowhere else"` → defects are filed through the backlog
  tool (family `BL`, repo `sox-ecosystem`) — nowhere else.
- Line 20 (the routing table's row 3, linking `../../../BACKLOG.md`): remove the row, or repoint it
  to a short pointer doc/section describing how to query the graph (`backlog_recall`/`backlog
  list-items` with the relevant filter) — implementer's call on shape, but the dead relative link
  must not survive.
- Line 40: `"generated from BACKLOG.md by tools/plan-status.mjs"` → `"generated from the backlog
  graph by tools/plan-status.mjs"`.
- Lines 48-50 ("File every defect in the root BACKLOG.md... Allocate the id programmatically as
  max(existing)+1"): rewrite to describe filing via the tool with no manual id allocation (D8 — the
  tool now handles this).
- Lines 55-59 (the pre-commit guard checklist): remove the `node tools/check-backlog-markers.mjs`
  line (retired — running it now prints a retirement message and exits 1, so listing it as a
  checklist step an agent should run is actively wrong); keep `node tools/plan-status.mjs --check`
  and `node tools/check-no-nul-bytes.mjs` (unaffected by this packet).

### 11. `AGENTS.md` — rewrite three regions

- **Line 11** (Routing section): `"defects in BACKLOG.md, nowhere else"` → defects filed through the
  backlog tool.
- **Lines 80-86** (commit-mine.mjs usage examples citing `BACKLOG.md` as the canonical hot-file
  example): `BACKLOG.md` is no longer a file that can be hot-contended in the shared index — replace
  the example target with `CHANGELOG.md`/`PLAN.md`/`STATE.md` (still real, still markdown, still
  contendable) or with a generic placeholder. The surrounding narrative prose (the BL-409/BL-457
  incident history) is historical record and stays untouched — only the still-imperative "how to use
  this tool today" example commands need a live target.
- **Lines 200-240** (the two `⛔ AGENT CONSTRAINT` sections "NEVER MARK A BACKLOG ITEM RESOLVED
  WITHOUT A RED→GREEN TEST" and "RESOLVED BACKLOG ITEMS MUST BE MOVED TO CHANGELOG AND REMOVED FROM
  BACKLOG"): both currently describe the hand-edit workflow verbatim (`### BL-<n>` headings,
  "Move to CHANGELOG," "Remove from BACKLOG," "Regenerate the counts from the remaining heading
  markers"). Rewrite the **procedural** sentences to describe the tool equivalent:
  - "Before writing `**RESOLVED**` on any `### BL-<n>` heading" → "Before calling
    `backlog_transition_status`/`backlog_resolve_item` with status `RESOLVED`/`DONE`/etc."
  - "Do not hand-maintain BACKLOG.md's status header — it is derived from heading markers" → delete
    (no header to maintain; the graph's status field is the header).
  - The three-step "Move to CHANGELOG / Remove from BACKLOG / Update the status table" lifecycle
    collapses to: transition status via the tool, attach citations via `backlog_add_citation`,
    nothing further — there is no second document to keep in sync.
  - **Keep, unchanged**: the BL-225 verified-outcome principle itself (§0's rule — never mark
    resolved without a red→green you watched fail then pass), the four named historical incidents
    (BL-88/BL-95/BL-115/BL-167), and the "~125 items already marked CLOSED have never been audited"
    corollary. These are the substantive rule, not the markdown-specific mechanics; do not weaken or
    remove them.

### 12. `docs/reporting/memory/PLAN.md`, `docs/reporting/memory/STATE.md` — one-line banner fixes only

- `PLAN.md:6`: `"generated from BACKLOG.md"` → `"generated from the backlog graph"`.
- `STATE.md:9`: `"· BACKLOG.md (all items)"` in the companion-docs line → repoint to a short
  pointer (or drop the clause) describing how to query the graph.
- The `<!-- PLAN-STATUS:BEGIN -->...END` blocks in both files are **regenerated automatically** by
  running `node tools/plan-status.mjs` once file 1's rewrite lands — do not hand-edit them; the
  generated-note line inside them (`"Generated by tools/plan-status.mjs from BACKLOG.md"`,
  `tools/plan-status.mjs:46`) is emitted by the tool itself, so fixing the noun there (file 1) fixes
  it here automatically on next regeneration.
- Everything else in both files (historical narrative, past incident write-ups, the "Wave summary"
  and "What to do next" audited sections' substantive content) is untouched per D10's table — only
  re-run `plan-status.mjs` to refresh the derived blocks and stamps.

### 13. Test files — rewrite or retire in step with the scripts they test

- **`tools/test-bl454-annotation-dedupe.mjs`** (tests `check-backlog-markers.mjs --fix`) — that
  behavior is retired (D4); **delete this test file**, or (preferred, cheaper and higher-signal)
  rewrite it into a **retirement contract test**: assert `check-backlog-markers.mjs --fix` (and
  bare/zero-arg invocation) now exits 1 with a message naming the retirement, on a scratch repo that
  no longer even has a `BACKLOG.md` fixture to build (proving the retired script doesn't try to read
  one). Implementer's call between delete-outright and rewrite-as-retirement-pin; either is
  acceptable, but **do not leave it red** (see AC-test-inventory).
- **`tools/test-adr0011-stage2-write-off.mjs`** (tests `check-bl-id-integrity.mjs`'s G1-G4 rules) —
  same treatment: delete or rewrite as a retirement-contract test.
- **`tools/test-bl416-shared-registry-lock.mjs`** (tests the shared `--git-common-dir`-based root
  resolution used by both retiring scripts) — same treatment.
- **`tools/test-adr0011-bl-id-counter.mjs`** (tests `bl-id-counter.mjs`) — delete outright; the
  script it tests is deleted (D8), there is nothing to write a retirement-contract test *for* (the
  file itself is gone, not stubbed).
- **`tools/test-bl446-arg-validation.mjs`** — **rewrite, do not delete.** This test currently covers
  all three of `allocate-bl-id.mjs`/`check-backlog-markers.mjs`/`check-bl-id-integrity.mjs`'s
  `--help`/unrecognized-flag/zero-arg contract. Two of those three scripts are being retired
  in-place (not deleted) and the third (`allocate-bl-id.mjs`) is being deleted (file 5). Rewrite:
  - Drop the `allocate-bl-id.mjs` case entirely (script deleted).
  - Update the `check-backlog-markers.mjs`/`check-bl-id-integrity.mjs` "zero-arg regression guard"
    assertions (current lines 150-163) to match their NEW zero-arg behavior: exit 1, stderr contains
    a retirement indicator (not `"OK"`/`"skipped"` as today).
  - **Also fix the currently-failing, pre-existing assertion this same file already contains** —
    verified live (`node tools/test-bl446-arg-validation.mjs` on this worktree's starting `main`,
    2026-08-07): `[FAIL] BL-446 allocate-bl-id.mjs (no args): still allocates — stdout matches
    /^BL-\d+$/`. `allocate-bl-id.mjs`'s zero-arg path has printed a retirement message and exited 1
    since ADR-0011 Stage 2 landed; this test's assertion was never updated to match and has been red
    on `main` since. This is now moot (the file itself is deleted in this packet, dropping the
    assertion with it), but **file it as its own discovered defect** — a fresh `backlog_create_item`
    (family `BL`, repo `sox-ecosystem`), citing `tools/test-bl446-arg-validation.mjs:144-149` and
    the live failing run above — before removing the assertion, so the regression is on record
    rather than silently disappearing along with the code it was (incorrectly) still checking. Per
    house "zero deflection": this is a real, currently-red assertion on `main`; name it, don't quietly
    absorb the fix into an unrelated diff.
- **`tools/test-bl435-unguarded-prose.mjs`, `tools/test-bl464-duplicate-status-stamp.mjs`** — **no
  code change required** (D7) — but both must be **re-run and confirmed still green** after file 1's
  edit, since they exercise the real `PLAN.md`/`STATE.md` files which file 1's regeneration touches.
- **New file: `tools/test-plan-status-graph-source.mjs`** — required new coverage for the one
  function with no existing test (`readGraphStatuses`, née `readBacklogStatuses` — see AC-plan-status-
  new-source-test for the exact assertions).

---

## 4. Acceptance criteria (each names a BL-id; each has a stated RED arm)

Before starting, the implementer files the umbrella tracking item per D8's own acceptance-grounding
step: `backlog create-item` (family `BL`, repo `sox-ecosystem`, no `idOverride`, title along the
lines of "ADR-0011 Stage 3: delete BACKLOG.md/CHANGELOG.md, repoint plan-status.mjs at the graph").
Call its resulting id **BL-STAGE3** below — substitute the real id everywhere (commit messages, code
comments, this checklist) once known.

- **AC-D1-status-mapping** (BL-STAGE3). Every value in D1's table round-trips through `isOpen()`
  correctly: a unit assertion (in the new test file, §3 file 13) feeds each of the 19 canonical
  status strings plus both lowercase aliases into a `Map` and asserts `isOpen()`'s boolean matches
  the table exactly (8 true, 11 false, both aliases match their canonical bucket).
  **RED arm:** run this assertion against the CURRENT `isOpen()` (pre-edit, still keyed to
  `['OPEN','REOPENED','BLOCKED']`) — `IN_PROGRESS`/`PARTIAL`/`OUTSTANDING`/`DEFERRED`/`MIXED`/
  `UNKNOWN` all currently read as closed (false), which is wrong per the ruled table; the assertion
  must fail on at least those six before the fix and pass on all 19+2 after.

- **AC-D2-pagination** (BL-STAGE3). A fake `backlog` executable (test fixture, `PLAN_STATUS_BACKLOG_BIN`
  override) that returns exactly `PAGE` items on page 1 and a smaller remainder on page 2 — assert
  `readGraphStatuses()`'s resulting Map contains items from BOTH pages.
  **RED arm:** point the same fixture at a naive single-call implementation (no pagination loop) —
  the page-2-only item is absent from the Map; assert its absence reproduces before the fix.

- **AC-D3-loud-failure** (BL-STAGE3). A fake `backlog` executable that exits non-zero / is missing
  entirely (`PLAN_STATUS_BACKLOG_BIN=/nonexistent`) — assert `plan-status.mjs --check` (spawned as a
  subprocess) **exits non-zero** and its stderr names the failing command, and assert it does **not**
  print the normal "OK" success line.
  **RED arm:** a version of `readGraphStatuses` that catches the `execFileSync` throw and returns an
  empty Map — under that version, `--check` prints a false "OK" (every id reads as absent-therefore-
  closed) and exits 0; assert that failure mode reproduces on the pre-fix catch-and-swallow variant.

- **AC-D4-retirement-help** (BL-STAGE3, also closes the BL-446 non-regression obligation named in the
  dispatch brief). For both `check-backlog-markers.mjs` and `check-bl-id-integrity.mjs`: `--help`/`-h`
  exit 0, stdout contains `"Usage"`, zero git/filesystem calls (verifiable the same way
  `test-bl446-arg-validation.mjs` already verifies it for the third script — no `BACKLOG.md` needs to
  exist in the scratch dir at all for `--help` to succeed, since it must never touch the filesystem).
  **RED arm:** the CURRENT `check-backlog-markers.mjs`/`check-bl-id-integrity.mjs`, run in a scratch
  dir with no `BACKLOG.md`/`CHANGELOG.md` present at all and default (zero) args — both throw an
  unhandled `ENOENT` from `readFileSync`/`execFileSync('git', ['rev-parse', ...])` chains rather than
  a clean, informative exit; assert that crash reproduces pre-fix.

- **AC-D4-retirement-default** (BL-STAGE3). Both scripts, invoked with zero args in a fresh scratch
  git repo with no `BACKLOG.md`/`CHANGELOG.md`: exit 1, stderr contains a retirement message naming
  `plan-status.mjs`/the graph as the replacement.
  **RED arm:** same as above — pre-fix, both throw ENOENT instead of a clean, on-brand message.

- **AC-D5-no-delegation** (BL-STAGE3). `check-bl-id-integrity.mjs`'s source no longer contains a call
  to `check-backlog-markers.mjs` (`grep -c check-backlog-markers tools/check-bl-id-integrity.mjs`
  returns 0, or only appears in a comment explaining the removal).
  **RED arm:** the current file (`tools/check-bl-id-integrity.mjs:194-200`) contains exactly one live
  `execFileSync` call to it; assert the grep is non-zero pre-fix.

- **AC-D6-precommit-unconditional** (BL-STAGE3). A commit touching only an unrelated file (not
  `PLAN.md`/`STATE.md`/`BACKLOG.md`) still triggers `plan-status.mjs --check` (verify by making
  `--check` fail on purpose — e.g. temporarily stamp a stale value into `STATE.md` between the
  `PLAN-STATUS` markers without regenerating — and confirming a real `git commit` of an unrelated
  file is blocked by the hook).
  **RED arm:** the CURRENT `.husky/pre-commit` (file-staged-gated) — same setup, but staging only the
  unrelated file — the hook passes despite the deliberately-stale `STATE.md` block, because the
  `grep -qxE` condition never matches; assert the commit succeeds (wrongly) pre-fix and is blocked
  (correctly) post-fix.

- **AC-D7-existing-tests-unchanged** (BL-STAGE3). `node tools/test-bl435-unguarded-prose.mjs` and
  `node tools/test-bl464-duplicate-status-stamp.mjs` both still exit 0 after file 1's rewrite, with
  **zero changes to either test file's source**.
  **RED arm:** N/A in the traditional sense (this is a non-regression pin, not a new-behavior red→
  green) — the RED arm is: run both tests against a DELIBERATELY BROKEN rewrite of `readGraphStatuses`
  that changes `isOpen`'s signature or removes an exported function — both tests must fail loudly
  (import error or assertion failure), proving they would have caught a signature-breaking mistake
  had one been made. Demonstrate this once during implementation (a throwaway broken variant), not
  as a permanent test.

- **AC-D8-auto-allocation-safe** (BL-STAGE3, this item's own filing IS the evidence). `backlog
  create-item` for `BL-STAGE3` itself, no `idOverride`, returns `humanId: "BL-480"` (the exact next
  value per `.bl-id-counter.json`'s last known state, `next: 480`) — not a collision with any id
  `<= 480` that already exists in the graph or existed in markdown history.
  **RED arm:** this is inherently a live, one-shot proof (not a repeatable red→green pair) — the
  "red" this guards against is the historical failure mode itself (BL-437's collision, `computeNextHumanId`
  minting an already-used id) — document the returned id and cross-check it by hand against
  `backlog get-item --repo sox-ecosystem --human-id BL-480` returning `E_NOT_FOUND`/empty **before**
  the create call, and returning the newly created item **after**.

- **AC-D9-citations-pinned** (BL-STAGE3, closes the citation-provenance requirement in the dispatch
  brief). After `tools/pin-changelog-citations.mjs --sha=$PIN_SHA` runs for real (not `--dry-run`):
  a fresh `backlog_export_json`/`backlog export-json` for `{repo:"sox-ecosystem", family:"BL"}` shows,
  for every item that previously had a `CHANGELOG.md`/`BACKLOG.md`-only citation, **at least one**
  citation whose `file` matches `^[0-9a-f]{7,40}:(CHANGELOG|BACKLOG)\.md$`. Spot-check at least 5
  (e.g. `BL-337`, `BL-150`, `BL-235`, `BL-001`... no — `BL-001` has no CHANGELOG citation, pick from
  the list in §1.6) by running `git show <pinned-sha>:CHANGELOG.md | sed -n '<lines>p'` and confirming
  non-empty, plausible output (matches the citation's `context`, if present).
  **RED arm:** run the same `git show <sha>:CHANGELOG.md` command **after** `git rm CHANGELOG.md`
  lands but **without** having run the pinning script first (i.e., against the stale
  `{file:"CHANGELOG.md", lines:"..."}` form) — `git show HEAD:CHANGELOG.md` at the deleted-file HEAD
  fails (`fatal: path 'CHANGELOG.md' does not exist in 'HEAD'`); demonstrate that failure once, then
  demonstrate the pinned form resolving cleanly at the same HEAD.

- **AC-D9-git-log-follow** (named explicitly in the dispatch gate). After the `git rm` commit:
  `git log --oneline -- BACKLOG.md | wc -l` and `git log --oneline -- CHANGELOG.md | wc -l` return
  **the same non-zero counts** as immediately before the `git rm` commit (history is retained, not
  truncated — a plain `git rm`, never `filter-branch`/`filter-repo`, guarantees this, but verify it
  rather than assume it). `git show <PIN_SHA>:BACKLOG.md | head -5` and `:CHANGELOG.md` both still
  print real content.

- **AC-precommit-live** (BL-STAGE3, named in the dispatch gate: "the pre-commit hook working end to
  end on a real test commit"). After `node tools/install-git-hooks.mjs` re-runs: make one real,
  disposable commit in the worktree (e.g. a trivial whitespace-only edit to a scratch file inside the
  worktree, reverted afterward or left as part of this packet's own housekeeping) and confirm
  `.git/hooks/pre-commit` actually fires — observe `check-amend-shared-index.mjs`'s and
  `plan-status.mjs --check`'s stderr output appear during the real `git commit` invocation, not just
  when the scripts are run standalone.
  **RED arm:** run the SAME commit attempt with `.git/hooks/pre-commit` reverted to its
  pre-`install-git-hooks.mjs`-rerun state (i.e., before this packet's `.husky/pre-commit` edits were
  installed) — confirm the OLD hook still calls the now-deleted `check-bl-id-integrity.mjs` and
  errors (module resolves fine since the file still physically exists at that point in the sequence,
  but calling it against a repo with no `BACKLOG.md` staged would `skip` harmlessly under the OLD
  logic — so actually demonstrate the more direct case: run the OLD hook script content by hand
  AFTER `BACKLOG.md` is deleted, and show `check-bl-id-integrity.mjs`'s `readFileSync(BACKLOG,...)`
  throws ENOENT unconditionally regardless of what's staged, since that read happens at module load
  before the staged-files check).

- **AC-test-inventory** (BL-STAGE3). `find tools -iname 'test-*.mjs' -exec node {} \; ` (or an
  equivalent loop) run over every file in `tools/test-*.mjs` after all edits — **zero non-zero exits**.
  This is the closest available proxy for "the whole `tools/` test surface is coherent post-change";
  there is no nx target wrapping these (confirmed: no `tools/project.json`, none referenced in
  `package.json` `scripts`, none in `nx.json` — they are plain `node`-invoked scripts, matching
  ADR-0011's own gate note that these "are plain node scripts, not nx targets").

---

## 5. Risks

- **R1 — sequencing that prevents data loss.** The single irreversible step is `git rm
  BACKLOG.md CHANGELOG.md`. Everything else in this packet (script edits, doc edits, citation
  pinning) is committed **first**, while both files are still present and byte-identical to what
  every existing citation's line numbers describe. `PIN_SHA` (D9) is captured from that state, and
  the pinning script runs and is verified (AC-D9-citations-pinned) **before** the deletion commit.
  If the pinning script's real (non-`--dry-run`) run fails partway (some `add-citation` calls
  succeed, some don't — the script's own summary output, §3 file 7, must make a partial run visible
  rather than silent), **do not proceed to `git rm`** until a re-run confirms 100% coverage — the
  script is idempotent-safe to re-run (ADD-only; a citation added twice is a harmless duplicate, not
  a corruption) so retrying costs nothing.
- **R2 — pre-commit hook regression blast radius.** Named explicitly in the dispatch brief as the
  highest-consequence risk. Mitigated by: (a) D4's asymmetric retirement treatment (only the
  already-conditional `plan-status.mjs --check` line changes trigger condition; the unconditional
  `check-bl-id-integrity.mjs` line is REMOVED, not left to fail unconditionally), (b)
  AC-precommit-live's requirement to prove the new hook end-to-end on a real commit, not just a
  script invocation in isolation, (c) re-running `tools/install-git-hooks.mjs` is itself named as a
  required step (§3 file 4), since `.husky/pre-commit` source edits do nothing until installed.
- **R3 — `nx build`/`nx test` destructive-artifact hazard (BL-235/BL-456).** Does not apply directly:
  every file this packet touches is either a `tools/*.mjs` plain script (outside the nx build graph,
  confirmed no `project.json`), a markdown doc, or the two files being deleted. **No `dist/` artifact
  is touched, so no `nx build` is required or permitted as a diagnostic step for this packet's own
  work.** The gate (§6) still runs the whole-repo `nx run-many` sweep because other agents' concurrent
  work may be affected by lint rules picking up the deleted files' absence (e.g. a stale glob), but
  that is the existing repo-wide gate, not a build triggered *by* this packet's changes.
- **R4 — the `backlog` CLI becomes a hard dependency of every commit (new, introduced by D6).**
  Before this packet, a `backlog`-store outage did not block commits (the guard read a repo-local
  file). After D6, it does, unconditionally. Mitigated by: D3's loud-failure requirement (a hung/
  down store produces a clear error, not a silent false-pass, so the failure is at least diagnosable
  immediately) and the pre-existing `git commit --no-verify` escape hatch (unchanged by this packet,
  already documented house-wide as the general hook-bypass mechanism, not something this packet
  introduces). This tradeoff (commit-time coupling to an external service) is inherent to ADR-0011's
  own decision to make the graph authoritative — it is not introduced by a flaw in this spec, but it
  is a real behavior change worth the owner/reviewer being aware of explicitly.
- **R5 — citation line-accuracy is preserved, not audited (named in D9/§1.6, restated as a risk).**
  Commit-pinning guarantees a citation **resolves** to real content at `PIN_SHA`; it does not
  guarantee that content is still the RIGHT content, for citations whose `lines` were recorded before
  one of the 3 post-migration `CHANGELOG.md` edits shifted line numbers. This is a pre-existing,
  independently-introduced data-quality gap (not created by this packet — it exists right now, before
  any deletion, simply invisible because the file is still there to eyeball). **File a follow-up
  `BL-*` item** (via the tool, no markdown) documenting this residual and naming which edits
  (`469d1ab1`, `c40b186b`, `e4b2140f`) are the suspect windows, rather than silently absorbing the
  risk into this packet's scope (which does not include a full 478-citation accuracy audit — that is
  a distinct, much larger effort).

---

## 6. The gate

Run, in this order, and report the actual output (not a paraphrase) for each:

1. `node tools/test-bl446-arg-validation.mjs` (rewritten per §3 file 13) — 0 failures.
2. Every remaining/rewritten `tools/test-*.mjs` touched by this packet, individually — 0 failures
   each (AC-test-inventory covers the full sweep).
3. `node tools/test-bl435-unguarded-prose.mjs` and `node tools/test-bl464-duplicate-status-stamp.mjs`
   — unchanged source, must still exit 0 (AC-D7).
4. `node tools/check-suite-tree-state.mjs --project memory-core` (or whichever project, if any, ends
   up hosting a `.spec.ts` for this work — this packet as scoped touches no `.spec.ts`, only
   `tools/*.mjs`, so this is likely N/A; state explicitly if so, do not silently skip the check by
   omission).
5. `node tools/plan-status.mjs --check` — must print the real "OK" line (`plan-status: OK — derived
   blocks match ... audited prose names only open work`, with wording updated per file 1's noun swap)
   sourced from the graph, with `BACKLOG.md` **already deleted** at the point this is run for the
   final gate pass (i.e., run it again after the `git rm` commit, not only before).
6. `git log --follow -- BACKLOG.md` and `git log --follow -- CHANGELOG.md` — both still resolve
   history (AC-D9-git-log-follow).
7. Make one real test commit and confirm `.git/hooks/pre-commit` fires end-to-end (AC-precommit-live).
8. **`npx nx run-many -t build,lint,test,typecheck`** — green. **No `--skip-nx-cache`.** This is a
   `dist/`-touching command class (BL-235) but nothing in this packet's own file set requires it —
   run it once, at the end, as the whole-repo gate the dispatch brief names, not repeatedly as a
   diagnostic loop.
9. **`node scripts/smoke-test.mjs`** — `summary.failed === 0`. Named explicitly in the dispatch gate;
   this packet does not touch any extension manifest, install engine, or service lifecycle code, but
   the gate is unconditional per this repo's own AGENTS.md rule for any branch, and costs nothing
   extra to confirm.
10. `git status` — confirm nothing outside this packet's intended file list is staged (no `git add -A`
    residue), then commit by explicit pathspec, per house rule, in the sequence R1 requires: (a)
    script/doc edits with both files still present, (b) citation pinning, verified, (c) `git rm
    BACKLOG.md CHANGELOG.md` as its own final commit.

---

## Summary of files touched

**Edited:** `tools/plan-status.mjs`, `tools/check-backlog-markers.mjs`, `tools/check-bl-id-integrity.mjs`,
`.husky/pre-commit`, `CONTRIBUTING.md`, `docs/reporting/memory/README.md`, `AGENTS.md`,
`docs/reporting/memory/PLAN.md`, `docs/reporting/memory/STATE.md`, `tools/test-bl446-arg-validation.mjs`.

**Deleted:** `BACKLOG.md`, `CHANGELOG.md`, `tools/allocate-bl-id.mjs`, `tools/bl-id-counter.mjs`,
`.bl-id-counter.json`, `tools/test-adr0011-bl-id-counter.mjs`, and (delete-or-rewrite-as-retirement-
pin, implementer's choice per §3 file 13) `tools/test-bl454-annotation-dedupe.mjs`,
`tools/test-adr0011-stage2-write-off.mjs`, `tools/test-bl416-shared-registry-lock.mjs`.

**New:** `tools/pin-changelog-citations.mjs`, `tools/test-plan-status-graph-source.mjs`, plus the
umbrella `BL-STAGE3` graph item and (per R5) one follow-up citation-accuracy `BL-*` item.

**Out of bounds:** everything in D10's table.
