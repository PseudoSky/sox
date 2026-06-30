# Migration plan — ingesting an external repo's catalog into sox-ecosystem

This document tells an orchestrator (human or agent) **how to plan and run a bulk
migration** of an external repository's extension-like assets into sox-ecosystem as
born-conformant extensions. The primary target is:

    ~/dev/ai/claude-agents     (hooks, skills, agents, commands — many of each)

…but the same process applies to any source repo (e.g. the MCP server at
`/Users/nix/dev/node/adhd/packages/ai/agent-mcp`, the command at
`~/dev/ai/sox-protocol/packages/python`). Per-extension work is driven by the hand-off
prompts in [`prompts/`](./prompts/); this plan sequences them.

> Why a plan and not just "run the prompts": ingesting a whole repo has cross-cutting risk
> (build graph scaling, registry/bundle composition, regressions across many extensions,
> the unresolved `prompt` type). A pilot-then-batch sequence with reality-verified gates
> de-risks it. The single recurring failure to guard against is **a gate scoped narrower than
> the change** — every per-extension gate must exercise the real lifecycle, and every batch
> gate must re-run the whole suite + e2e.

---

## Operating principles (apply to every phase)

- **Ground truth over memory.** Derive every contract from this repo's `DOD.md`,
  `docs/guidelines/`, the manifest schema, and a working reference extension of the same
  type — never from assumption. (This is baked into each hand-off prompt.)
- **Reality-verify, don't trust tests.** "Done" for an extension = it actually
  `init → build → validate → install → start → runs → stops cleanly`, with captured output.
  A green unit test is not acceptance.
- **Born-conformant only.** Always scaffold via the generator (`node bin/soxe init <type> <id>`);
  never hand-roll layout. If the generator can't produce a conformant skeleton for a case,
  that's a generator gap to fix in sox-ecosystem first — not a thing to paper over per-extension.
- **Declare permissions (C6).** Every ingested extension declares the exact fs/network/socket it
  uses; undeclared access is denied at runtime. Under-declaring breaks the extension at run time.
- **No regression.** After every batch, `./node_modules/.bin/nx run-many -t build,lint,test`
  stays green and the lifecycle e2e (`./node_modules/.bin/nx run host-runtime:test-e2e`) passes.
- **One source of bookkeeping.** Track per-extension status in the catalog table (here or in a
  state file), not in prose scattered across commits.

---

## Phase 0 — Discovery / inventory (read-only; do NOT port yet)

Goal: know exactly what's in the source repo before committing to a plan.

1. Walk the source repo and inventory every candidate, grouped by the sox-ecosystem type it
   maps to. For `~/dev/ai/claude-agents`:
   - `tools/hooks/*` → `hook`
   - `categories/workflow/skills/*` → `skill`
   - `categories/00-active/agents/*` → `agent`
   - `tools/cli/*` (+ `~/dev/ai/sox-protocol/packages/python`) → `command`
2. For each candidate record: name, source path, rough size, runtime (node/shell/python/
   declarative-markdown), external deps, and the resources it touches (fs/network/socket) — the
   raw material for its future `permissions` block.
3. Flag **decision points** that need a human call before they can be planned, e.g.:
   - the `prompt` type use case is unresolved ("idk what this is") — resolve or exclude;
   - any candidate that doesn't cleanly map to one of the 7 types;
   - very large candidates that may need splitting.
4. Output: a catalog table (extend `README.md`'s) with one row per candidate and a
   `maps-to-type` + `decision-needed?` column. **Do not write extension code in this phase.**

Gate: the inventory is complete and every candidate is either mapped to a type or marked
`decision-needed`.

---

## Phase 1 — Pilot: one extension per type, end-to-end

Goal: prove the ingestion path works for **each type** before scaling, and surface generator/
contract gaps cheaply.

1. Pick the **smallest, simplest** candidate of each type present in the source
   (e.g. `swarm-cost` for `hook`).
2. For each pilot, run its hand-off prompt (`prompts/<id>.md`) — scaffold born-conformant,
   port, declare permissions, reality-verify the full lifecycle.
3. If a type's pilot reveals a generator or contract gap (the scaffold isn't conformant, the
   guideline is wrong, a runtime isn't supported), **STOP and fix sox-ecosystem first** — the
   whole value proposition is zero manual conformance. Record the fix; re-run the pilot.

Gate: one extension of **every in-scope type** passes the full reality-verified lifecycle, and
`nx run-many -t build,lint,test` + the e2e stay green. Now the path is proven per type.

---

## Phase 2 — Batch ingestion (per type, in waves)

Goal: ingest the remaining candidates in safe, reviewable batches.

1. Process one type at a time, in waves of N (small enough to review; e.g. 3–5 per wave).
2. Each candidate gets its own hand-off prompt (clone the skeleton in `README.md`'s
   conventions; the pilot's prompt is the template). Run them; one extension = one conformant
   result + captured lifecycle evidence.
3. Keep the build graph healthy as it grows: confirm `nx affected` stays fast and the project
   graph is correct after each wave (DoD B3).
4. **Batch gate (mandatory after every wave):** rebuild the registry index (the `build-index`
   step — changing extension sources invalidates checksums), then
   `./node_modules/.bin/nx run-many -t build,lint,test` and
   `./node_modules/.bin/nx run host-runtime:test-e2e` must all be green. A red batch blocks the
   next wave until fixed.
5. Update the catalog status per extension (`pending` → `done`) as you go.

Gate: all in-scope candidates of all types are ingested, each reality-verified, with the full
suite + e2e green.

---

## Phase 3 — Bundles & composition (optional, if the source had groupings)

Goal: re-create any logical groupings from the source as `bundle`-type extensions.

1. Where the source repo grouped assets that belong together (e.g. a memory subsystem =
   server + organizer + hook + cli), compose a `bundle` extension that installs them as one
   unit (mirror the existing `sox-memory-bundle` shape).
2. Reality-verify the bundle: `install` the bundle resolves + installs all members; `start`
   runs them; `uninstall` removes them.

Gate: each bundle installs/starts/uninstalls its members cleanly.

---

## Phase 4 — Done / acceptance

- Every in-scope candidate from the source repo exists as a born-conformant extension that
  passes `init → build → validate → install → run → stop`, reality-verified.
- Permissions declared and enforced for each; none hits a runtime denial in normal use.
- `nx run-many -t build,lint,test` green; lifecycle e2e green; build graph still fast at the new
  scale (DoD B3/B4 — adding extensions never red-bars the tree).
- The catalog table shows every row `done` (or explicitly `excluded`/`deferred` with a reason).
- Decision points (esp. the `prompt` type) resolved or formally deferred.
- Founder accepts.

---

## Using the workflow plan-state-machine (recommended if available)

If the orchestrating agent has the `plan-state-machine` skill, render the above as a formal
plan-state-machine directory (one immutable-slug state per phase / per type-wave, a DAG with
`depends_on`, red→green guards, audit hold-points after the pilot and after each batch, and a
`gap-check`-verified publish gate). The pilot phase becomes the foundation audit; each batch
gate becomes an enforcement-style audit; Phase 4 is the final reality audit. This gives you
resumable hand-off across sessions and the same writer≠reviewer discipline used elsewhere in
this repo.

If the skill is NOT available, run the phases manually with the gates above — the gates are the
load-bearing part, not the format.

---

## Per-extension work-order template (drop into each `prompts/<id>.md`)

Use the skeleton documented in [`README.md`](./README.md) ("Conventions for a new prompt").
The pilot prompt [`prompts/swarm-cost.md`](./prompts/swarm-cost.md) is the canonical example —
copy it, swap the source path / type / id, and adjust the reference-extension pointer to one of
the same type.

**Ingestion primitive (post-P5):** once the generator's content option lands, each ingestion is a
single scaffold step that pulls the source content directly:

```bash
soxe init agent <id>   --shape declarative --host claude --content @<source.md>
soxe init skill <id>   --from @<source-dir>                       # SKILL.md + supporting files
soxe init prompt <id>  --inject rules --paths "src/**" --content @<source.md>
soxe init bundle <id>  --from-plugin @<plugin-dir>                # whole plugin → member extensions
```

This collapses "scaffold → hand-copy the body" into one command and stamps `source:` provenance so
updates can re-pull from origin. Until P5, scaffold then paste.
