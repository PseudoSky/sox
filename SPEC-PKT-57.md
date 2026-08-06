# SPEC — PKT-57 (BL-438): record the four rulings as an ADR

**Worktree:** `/Users/nix/dev/ai/sox-ecosystem/.worktrees/pkt57-open-typing-adr`
**Branch:** `feat/pkt57-open-typing-adr`
**Gates:** PKT-59, PKT-58, PKT-74, PKT-60, PKT-61, PKT-62, PKT-63 (the nine-packet Wave J open-typing
group). No source code is touched by this packet.

## 1. Root cause

BL-438's own body states it precisely: the ruling on D1–D4 currently exists in exactly two places —
BL-438's table (`BACKLOG.md:2521-2528`, personally opened) and
`docs/reporting/memory/findings/open-node-typing-design.md` §0 (`open-node-typing-design.md:11-30`,
personally opened) — and neither is a decision record. `docs/decisions/` (personally listed via `ls`)
holds ADR-0001 through ADR-0009; there is no ADR for this ruling, so every downstream packet that
needs to act on D1–D4 has nothing to cite but a BACKLOG table row or a findings-doc section, both of
which are living documents subject to future edit, not an immutable authorization record. This is the
same gap ADR-0006 through ADR-0009 exist to close for their respective rulings — the convention is
established, this ruling is simply missing from it.

## 2. The change, file by file

### `docs/decisions/0010-open-node-and-edge-typing.md` — NEW FILE

The ADR. Numbered 0010 because 0009 (`backlog-source-of-truth.md`, personally listed) is the highest
existing number. Follows the house form observed in ADR-0006
(`docs/decisions/0006-public-bundles-private-and-di-for-live-objects.md:1-81`, personally opened):
`Status`/`Relates to` header block, `## Context`, `## Decision` (numbered sub-decisions), `##
Consequences`, `## Alternatives considered`.

Content already written to this file in this worktree at the time this spec is committed. Its
structure:

- **Context** — the schema-level closure of `kind`/`rel`, why the tag-based workaround is unindexable
  in principle (`json_each` over a TEXT blob), the BL-295 precedent (shipped and reverted 19 minutes
  later, no reason in the revert commit itself), the BL-313 incident that makes the underlying rebuild
  operation dangerous, and the owner directive that triggered the ruling.
- **Decision** — D1 through D4, each as its own subsection: the ruling in the owner's own stated
  words where available, the rejected alternative(s) with the specific reason each loses, and (where
  relevant) what changed about the alternative's role rather than its shape (D3 specifically: same
  mechanism, went from "optional last mile" to "sole delivery path for existing stores" because D1
  removed the `sub_kind` escape hatch).
- **Consequences** — the rebuild-loop trap D1+D4 create in `ensureCheckConstraints()` (BL-447, gated
  closed by PKT-73 before any DDL constant may be edited), the `EdgeRel` source-breaking-not-additive
  correction, the one-release-train consequence, and the "nothing changes until an operator runs D3's
  migration" invariant.
- **Architect recommendations mentioned in the source design doc, and explicitly NOT owner
  decisions** — a dedicated section naming the DI wiring shape, the `user_version` sentinel proposal,
  and release-train packet sequencing as recommendations, not rulings, so a reader of the ADR alone
  cannot mistake them for D1–D4.
- **Alternatives considered** — a closing cross-reference back into the per-decision alternatives
  above (D1: `sub_kind`; D3: automatic-on-open, explicitly noted as never having been a live option
  rather than a rejected one; D4: defer to a later pass). D2 is noted as carrying no alternative.

### `docs/reporting/memory/findings/open-node-typing-design.md` §0 — ONE EDIT, NOTHING ELSE

Two sentences inserted immediately under the `## 0.` heading, before the existing "An earlier revision
of this document..." paragraph, pointing to the new ADR and stating that §0 remains the fuller working
rationale. **No other line in this file changes.** This file is explicitly called out as already
correct and not to be rewritten — the task description states this twice, and BL-438's "done when"
criterion only requires §0 to carry a back-reference, not any restructuring.

**Out of bounds, and why:** every other section of `open-node-typing-design.md` (§1 BL-295 history,
§2 the SQLite-op constraint table, §3 the data→data|shared boundary discussion, §4 the decided design,
§5 BL-447, §6 the acceptance bar, §7 release/semver, §8 live-store safety rules) is untouched. These
are PKT-73/PKT-59/PKT-58/etc.'s working reference material; rewriting any of it here would both
violate the explicit "do not rewrite that doc" instruction and risk introducing drift between the
ADR's summary and the fuller document it summarizes.

### No other file changes

No source file under `libs/`, `extensions/`, or `apps/` is touched. No `dist/` artifact is rebuilt.
No `registry/index.json` regeneration is required — this packet ships no bundled extension.

## 3. Every decision, ruled

This spec makes no new design decisions of its own beyond execution mechanics — the four substantive
rulings (D1–D4) are BL-438's, already closed, and are the ADR's *content*, not open questions for the
implementer. The decisions genuinely local to this packet:

1. **ADR number: 0010.** Ruled by inspection — `ls docs/decisions/` shows 0001..0009 exist; 0010 is
   next. No alternative considered; this is deterministic, not a judgement call.
2. **Where the back-reference goes in §0.** Ruled: immediately under the `## 0.` heading, above the
   existing first paragraph, as its own short paragraph beginning "**Citable record:**". Rejected
   alternative: appending it as a footnote at the end of §0, below the decision table. Loses because a
   reader skimming top-to-bottom (the section's own stated audience — "every downstream packet cites
   this") should see the ADR pointer before reading the table it summarizes, not after.
3. **Whether to also add ADR cross-references into BL-438, BL-447, or BL-448's BACKLOG bodies.**
   Ruled: **no, out of scope for this packet.** BL-438's own "done when" criterion is "every packet in
   the group names the section authorising it" — that is each downstream packet's job when it lands
   (PKT-58 etc. cite the ADR as part of their own acceptance), not a retrofit onto BACKLOG.md entries
   that already exist and are independently subject to the BL-225/backlog-marker discipline. Adding it
   here would touch a shared, contended file (`BACKLOG.md`) for a benefit (a citation that will be
   added anyway, by each consuming packet) that does not require this packet to claim it.
4. **Whether the "architect recommendations, not owner decisions" section is required or optional.**
   Ruled: **required**, per the packet's own second prohibition ("Record ONLY D1–D4 as owner
   decisions... If you believe a fifth decision is genuinely required, say so... as an open
   question"). The design doc's §0.1 (unsafe-consequences flagging), the DI wiring shape, and the
   `user_version` sentinel are all architect-level content that appears adjacent to D1–D4 in the
   source document; omitting a section that explicitly disclaims them risks exactly the mislabelling
   incident (`b263c22`) this ADR exists to prevent, by omission rather than commission.

**No fifth decision is required.** D1–D4 as ruled are complete and self-consistent; nothing in
BL-438, the design doc, or this packet's own acceptance criteria surfaces a fork the owner has not
already closed.

## 4. Acceptance criteria, each naming a BL-id, each with its red arm

BL-438 states explicitly: *"No red→green test applies — this item is a decision record, and it is
the one item in this group exempt from the BL-225 test bar."* Accordingly these are **document
assertions**, verified by direct inspection (grep/read), not unit tests. The "red arm" for each is
"this fact is not yet true of the tree," verified before the edit and re-verified after.

1. **BL-438 — the ADR file exists at the correct path and number.**
   - Assertion: `docs/decisions/0010-open-node-and-edge-typing.md` exists.
   - Red arm (verified before writing): `ls docs/decisions/` lists only 0001–0009; no 0010 file.
   - Green arm: the file exists, and `ls docs/decisions/` now lists 0001–0010 with no gap or
     collision.

2. **BL-438 — all four rulings are recorded as owner decisions, each with rejected alternatives and
   the reason they lose.**
   - Assertion: the ADR's `## Decision` section contains four subsections (D1, D2, D3, D4), each
     stating the ruling, and each stating either a rejected alternative + losing reason (D1, D3, D4)
     or an explicit note that none exists (D2).
   - Red arm: before this packet, no document states D1–D4 as a ruling with rejected alternatives in
     one place — BACKLOG.md's table states the ruling but not the losing reasoning in prose form, and
     the design doc's §0 states rationale but is not framed as a decision record.
   - Green arm: `grep -n "^### D[1-4]" docs/decisions/0010-open-node-and-edge-typing.md` returns
     exactly four matches, and each subsection's text (verified by read) names a rejected alternative
     or explicitly states none applies.

3. **BL-438 — nothing else in the ADR is attributed to the owner; every architect recommendation is
   explicitly labelled as such.**
   - Assertion: `grep -in "owner" docs/decisions/0010-open-node-and-edge-typing.md` — every match
     that asserts a ruling occurs only within the D1–D4 subsections or the header's "Status: Accepted"
     line (which records the ADR's own acceptance, not a new ruling). The `## Architect
     recommendations...` section header itself contains the string "NOT owner decisions."
   - Red arm: not applicable as a before/after — this is a compositional check on the new file itself,
     verified by reading the whole file once written and confirming no sentence outside the D1–D4
     subsections uses "owner ruled" / "owner decided" / "the owner:" phrasing.
   - Green arm: verified by direct read (see §6 below — the implementer/reviewer must re-read the full
     file top to bottom and confirm this, not just grep for the word "owner").

4. **BL-438 — `open-node-typing-design.md` §0 carries a back-reference to the ADR, and no other line
   in that file changed.**
   - Assertion: `git diff main -- docs/reporting/memory/findings/open-node-typing-design.md` shows
     exactly one hunk, adding a short paragraph under the `## 0.` heading and above the existing first
     paragraph, with zero deletions and zero changes anywhere else in the file.
   - Red arm (verified before the edit): `grep -n "0010\|ADR-0010" docs/reporting/memory/findings/open-node-typing-design.md`
     returns nothing.
   - Green arm: the grep above returns the new back-reference line, and `git diff --stat main -- docs/reporting/memory/findings/open-node-typing-design.md`
     shows `1 file changed, N insertions(+), 0 deletions(-)` — the `0` deletions is the load-bearing
     part of this assertion.

5. **BL-438 — every packet in the group can cite the ADR instead of a recollection.**
   - Assertion: the ADR's header block names all nine group packets (`Drives:` line) so a reader
     arriving from any of them can confirm they are in the right document, and each D1–D4 subsection
     is independently anchorable (`### D1` etc.) so a packet can cite e.g. "ADR-0010 §D3" rather than
     "the ADR" as a whole.
   - Red arm: before this packet, no such citable anchor exists anywhere in the repo.
   - Green arm: `grep -n "^### D" docs/decisions/0010-open-node-and-edge-typing.md` returns four
     anchorable headings, and `grep -n "PKT-5[89]\|PKT-6[0-3]\|PKT-74" docs/decisions/0010-open-node-and-edge-typing.md`
     confirms the header names the group.

## 5. Risks

- **No data risk.** This packet touches only two markdown files under `docs/`, plus this spec file.
  No `dist/` artifact, no SQLite store, no `~/.memory/*` path is involved.
- **The one real risk is scope creep into `open-node-typing-design.md`.** The task is explicit that
  the doc is already correct and must not be rewritten beyond the single §0 back-reference. The
  acceptance criterion #4 above (`0 deletions`, `1 hunk`) is the guard against this — if the diff shows
  more than one hunk or any deletion in that file, the packet has overrun its boundary and must be
  corrected before commit, not shipped with a note.
- **Mislabelling risk (the incident this ADR exists to prevent).** Writing an architect recommendation
  into the `## Decision` section, or into prose that reads as "the owner decided X" for anything
  outside D1–D4, reproduces the exact failure this packet is chartered to prevent (`b263c22`). The
  dedicated "Architect recommendations... NOT owner decisions" section and acceptance criterion #3
  are the structural guard; the implementer/reviewer must read the full ADR text once complete and
  confirm no sentence outside the four `### D` subsections claims ownership attribution.
- **Since PKT-57 gates seven other packets, an error here propagates.** Any wrong citation (a
  mis-transcribed rejected alternative, a ruling stated more strongly than BL-438's table supports)
  becomes the authorization every downstream packet inherits without re-deriving it. The reviewer
  stage of this pipeline should diff the ADR's D1–D4 text against BL-438's table
  (`BACKLOG.md:2521-2528`) and the design doc's §0 table (`open-node-typing-design.md:18-23`)
  line-by-line before approving.

## 6. The gate — exactly what the implementer/reviewer must run

This packet ships no code, so there is no `nx build`/`nx test`/`nx lint`/`nx typecheck` target that
exercises it — there is no project whose source changed. The gate is document verification, run in
this worktree:

1. `git diff main --stat` — confirm exactly the expected files changed: the new ADR, the one-hunk
   edit to `open-node-typing-design.md`, and this spec file (plus, once written, an implementer report
   if one is produced).
2. `git diff main -- docs/reporting/memory/findings/open-node-typing-design.md` — confirm the diff is
   exactly the back-reference paragraph, `0` deletions, no other hunks. This is acceptance criterion
   #4 and is the single most important check in this gate.
3. Full read of `docs/decisions/0010-open-node-and-edge-typing.md` top to bottom — confirm structurally
   against acceptance criteria #2 and #3 (four `### D` subsections each with ruling + rejected
   alternative or explicit "none"; no attribution of anything outside those four subsections to the
   owner).
4. `grep -n "^### D[1-4]" docs/decisions/0010-open-node-and-edge-typing.md` and
   `grep -n "0010\|ADR-0010" docs/reporting/memory/findings/open-node-typing-design.md` — mechanical
   confirmation of acceptance criteria #2 and #4's anchors.
5. `ls docs/decisions/` — confirm 0001 through 0010 present, no gap, no duplicate number.
6. Since this is a docs-only change with no project impact, `node tools/check-backlog-markers.mjs` is
   still worth running before commit (house rule) even though this packet does not itself touch
   `BACKLOG.md` — it is a cheap check and the shared file is contended by concurrent agents in other
   worktrees.

No `npx nx test`/`build`/`lint`/`typecheck` target applies — there is no project whose source this
packet modifies. Do not invent one to satisfy a checklist; running a build here would be pointless
risk under the BL-235 destructive-build rule for zero verification value.

## 7. Commit

Single commit, explicit pathspec, conventional-commit format, lowercase subject, scope `memory-core`
(this belongs to the memory subsystem's Wave J program, not a generic `docs` bucket — match the
scope convention used by sibling BL-4xx commits already in `git log`):

```
git commit \
  docs/decisions/0010-open-node-and-edge-typing.md \
  docs/reporting/memory/findings/open-node-typing-design.md \
  SPEC-PKT-57.md \
  -m "docs(memory-core): record BL-438's four open-typing rulings as ADR-0010"
```

Do not touch `BACKLOG.md` or `PLAN.md` in this commit unless the closing agent (post-review) is also
performing the BL-438 close-out (move to CHANGELOG, remove from BACKLOG per the house lifecycle rule)
— that is a separate, later step once the ADR is confirmed correct, not part of this packet's initial
implementation commit.
