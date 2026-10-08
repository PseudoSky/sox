# Reuse decision: gate runner (T62) and managed-block writer (T48)

Item 9024e9ac, T14.AC11. Recorded 2026-10-08 before T62 and T48 build anything.

Citations: [main@fca61c99, agent-manager, claude, dispatch-2026-10-08-a3f9 T14, 1: /Users/nix/dev/node/adhd/tools/gate/lane-gate.mjs:1-66, 2: /Users/nix/dev/node/adhd/tools/nx-plugins/test/executors/wiring/check-lane-reachability.mjs:1-70, 3: nx.json:19-30, 4: AGENTS.md:193, 5: AGENTS.md:466-508]

## Memory check (first)

Not run. This agent session has no `memory_*` tool (the memory-server tools are not in its grant) and the memory CLI (`extensions/bundles/sox-memory-bundle/members/memory-cli/dist/index.js --help`) has no recall verb: it lists init, status, list, registry, export, reembed, backup, compact, pipeline, fts-optimize, fts-rebuild. A holder with the `memory-usage` skill should run one recall for "gate runner / managed block reuse" and append the result here; nothing below depends on it, because every conclusion rests on the files read.

## Search check (second)

- Internal backlog: `adhd-backlog search "managed block markers AGENTS.md generated region" --limit 5` returned 5 of 3828 items, none about managed blocks or a gate runner (tool-grant dispatch debt, MCP registry composition, docs drift cluster, two dashboard items). No prior reuse decision exists there.
- Internal code: `rg 'gitnexus:start'` finds the only managed block in this repository, in `AGENTS.md:466-508`, delimited by `gitnexus:start` and `gitnexus:end`; no library in `libs/`, `tools/`, or `scripts/` writes marker-delimited blocks (`rg 'managed block|gitnexus:start' libs tools scripts` hits only unrelated MANAGED-process comments).
- Third party: web search for marker-based markdown generators found `markdown-magic`; its metrics below come from `npm view` and the npm downloads API on 2026-10-07.

## Comparison

| Candidate | What it is (read) | Fits | Does not fit |
|---|---|---|---|
| `tools/gate/lane-gate.mjs` (66 lines) | One canonical list, `GATE_TARGETS = ['test','e2e']` (line 39), consumed by every gate file; `gateFlags()` and `affectedArgv()` build `nx affected` arguments (lines 42-51). | The pattern: one list every gate file derives from, so a gate cannot drop out silently. T62 keeps that property by reading one command table. | The content. It is a list of two nx target names and builds `nx affected` argv, so it has build-tool knowledge; T62 must run in a directory with no `nx.json`. |
| `check-lane-reachability.mjs` (368 lines) | Rules 1-6 over nx project config, run before the lanes: a heavy lane must be reachable, `test` must not depend on `e2e`, every gate file invokes every `GATE_TARGETS` entry, a ratchet baseline for rule 6 (`lane-reachability.baseline.json`). Calls the nx plugin's own `createNodes`. | The ratchet baseline (a gap may only shrink) and rule 5 (a gate file must invoke every target) are exactly the reachability and ratchet behavior the generic `review gates` check needs. | Rules 1-4 and 6 read nx project graphs; the generic engine cannot import them. |
| Nx target orchestration (`nx run-many -t ...`, `targetDefaults.dependsOn`, `AGENTS.md:193`, `nx.json:19-30`) | The repository's own build, test, lint, typecheck graph with caching. | Strongest option for running gates inside an nx workspace: it already orders, caches, and parallelizes. | It cannot be the engine: it requires an nx workspace, and a cache hit is not execution evidence for reachability or flake measurement. |
| `markdown-magic` 4.11.0 (npm) | MIT, 289,735 bytes unpacked, 18 direct dependencies, modified 2026-06-29, 13,811 downloads in the week 2026-09-28 to 2026-10-04. Rewrites comment-delimited regions through transforms (code includes, remote fetch, templates). | Same idea: regions between comment markers are regenerated and the rest is untouched. | Its marker grammar is its own and differs across versions; the contract here fixes `workspace-standards:<target>:begin` and `:end`. 18 dependencies, remote includes, and a template engine for a writer that needs to replace one block by name; the skill must run with zero installs. |

## Decision

- **T62 (gate runner):** build it. It reuses (a) `lane-gate.mjs`'s single-list principle by reading one repository command table, (b) `check-lane-reachability.mjs`'s ratchet-baseline mechanism for its reachability check entry point, and (c) nx by composition: an nx repository's command table lists `npx nx run-many -t ...` as gate commands. It replaces nothing in the adhd repository; `lane-gate.mjs` and `check-lane-reachability.mjs` stay as that repository's nx-specific mechanisms and are bound as rows in its gate table. T62's README states these three reuses and that it replaces none of them (T62.AC5).
- **T48 (managed-block writer):** build a marker engine of a few dozen lines inside the apply tooling. Do not add `markdown-magic`. Follow the existing marker precedent (`AGENTS.md:466-508`), but with the fixed `workspace-standards:<target>:begin` and `:end` markers; the engine replaces the text between one pair, creates the pair if absent, and reports drift when the block differs from the rendering.
- **Revisit** if the contract grows beyond replace-one-named-block (for example includes from other files), at which point re-run this comparison.
