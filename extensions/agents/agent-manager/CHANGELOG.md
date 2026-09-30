# Changelog

## 0.2.0

- **`"*": "ask"` → `"*": "allow"` — the catch-all was the bug, and 0.1.10 grew the
  allow-list without fixing it.** An agent's bash map is evaluated LAST and its own `"*"`
  decides every segment it does not name; `ask` there means every unnamed segment prompts,
  and since a bash call is ONE atomic unit (split on `;`/`&&`/`|`), a single unlisted
  segment (`echo`, `tail`, `rg`) asks the WHOLE call. Non-interactively an `ask`
  auto-rejects, so 0.1.10's 123-rule list still failed on any batch containing one new
  command. With `"*": "allow"` first and the guardrails already ordered last, the map
  runs the measured working set and the guardrails still win the last match. Verified on
  real traffic with a temp probe agent: 6/6 allow-batches ran, 2/2 deny-samples blocked.
- **§14 — permission-audit playbook.** New section: load the `opencode-permission-audit`
  skill, run its scanner, read SECTION 7's verdict + drop-in map, apply, re-verify with the
  temp-probe harness; the two governing dynamics (a call is one atomic unit; `"*": "ask"`
  first is a defect) plus the leaked-ruleset diagnostic. §9's permission bullet now points
  here instead of half-restating the rule.
- **`dependencies: ["opencode-permission-audit"]`** — the scanning tool + cheatsheet ship as a
  skill (an agent install places ONLY its entrypoint, so an agent cannot carry the script).

## 0.1.10

- **The bash allow-list grows 11 → 123 rules, derived from the real transcript, not from guessing.**
  Measured across 7 days of opencode sessions (677 permission asks mined from
  `~/.local/share/opencode/log/opencode.log`, joined to the session store for agent attribution):
  this agent's `"*": "ask"` catch-all produced **333 of all 492 bash asks (68%)**, and every one was
  a trivially-safe read-only segment — `head`, `rg`, `echo`, `tail`, `printf`, `sed`, `wc`, `diff`,
  `sort`, `tr`, `sqlite3`, `node`, `git show`. Those families are now `allow`.
- **An `ask` is a functional failure, not just friction.** In any non-interactive context
  (`opencode run`, a dispatched subagent) opencode prints `permission requested: bash (…); auto-rejecting`
  and the call **fails** — which is why the failure report attributes ~31.8M recovery tokens to
  `permission/consent`. The allowed set is therefore the measured working set, not a courtesy list.
- Git verbs are split by intent: read-only plumbing (`show`, `rev-parse`, `ls-files`, `cat-file`,
  `merge-base`, …) plus the AGENTS.md-mandated `git add *` / `git commit*` / `git push*` are `allow`;
  `git checkout*` / `git rebase*` / `sed -i*` stay `ask`; the repo-banned verbs (`git stash*`,
  `git add -A*` / `--all*` / `.`, `git reset --hard*`, `git push *--force*` / `*--no-verify*`,
  `git clean *-f*`, `rm -rf *`) stay `deny` and are ordered **last**, so they win the last-match.
- §9 correction: opencode `permission` does **not** override `opencode.json`. Measured live — the maps
  **merge with the agent's rules last**, so an agent rule beats a config rule, and an agent that
  declares no `permission.bash` map inherits the config wholesale and defaults unmatched segments to
  `allow`.

## 0.1.9

- **Ground audits in failure evidence, not vibes.** §2 gains a tool reference: before changing a
  prompt, tool grant, or permission rule, run `agent-failure-report --days 14 --agents-dir <dir>`
  for per-agent tool failures (with recovery-token cost), permission denials by deny-family,
  doc/config contradictions, and prompt signals, read from the opencode transcript store.
- `agent-failure-report*` added to the bash allow-list so the audit runs without a permission prompt.
- Tool source: `~/dev/ai/sox-ecosystem/tools/agent-failure-report.mjs`, symlinked onto PATH.

## 0.1.8

- **§8: budget prose in tokens, not lines or words** — a line cap is defeated by a long line,
  a word cap by long words. State the budget in tokens and measure it.

## 0.1.7

- **§8 gains the governing minimum-prose rule.** The section warned against soft
  adjectives while itself only saying "concise, not verbose" — and the failure it names
  happened: a 5-line fix landed as 18 lines of prose. Now: write the absolute minimum that
  enforces the behaviour; net growth is a defect; never restate a rule (one home per rule);
  over two sentences → restructure, don't elaborate; WHY only where it changes behaviour.
- `agent-manager.md` 165 → 171 lines (+6: one new rule, nothing removed). Tested by a fresh
  subagent given the rule and a 4-line section to extend: it edited an existing line rather
  than adding one — before=4 after=4, net zero.

## 0.1.6

- **Adds a §3 renderer fact: always write `render.opencode.mode: "all"` for every opencode agent.**
  `all` makes an agent BOTH selectable as a primary and dispatchable as a subagent; omitting it ships
  a half-available agent. The rule carries its measured discriminator: `opencode run --agent <id>`
  refuses a subagent-only id with "is a subagent, not a primary agent. Falling back to default agent"
  (measured 2026-09-28 — `doc-cartographer`, subagent-only, fell back; `git-manager`, `all`, ran).
- **Adds §6 step 7: commit before you report.** An uncommitted agent change is not finished — the
  deployed file then exists in no revision, and the next install, worktree, or concurrent agent
  strands it as unrecoverable drift. Commit the extension source and its `CHANGELOG.md` by pathspec
  the moment §4's checks pass; same for every other artifact this agent ships.
- Removes the stray `bl0c35probe` agent from the user-scope opencode agent dir — a 60-byte hand-made
  probe, never an extension and absent from every registry.
- `version`, `render.claude.version`, and `package.json` bumped in lockstep to 0.1.6.

## 0.1.5

- **Adds §12, delegation discipline: a brief carries only what belongs to the caller.** Fixes the
  42b0dc25 defect — agent-manager injected executor-owned knowledge (repo layout, artifact type,
  release/install procedure, item→file mapping, pre-solved write scope) into dispatch briefs, which
  MASKS the routed executor's real gaps: a run looks correct when the injected knowledge, not the
  executor, supplied the discipline. The routed executor now derives the change discipline and the
  verification standard from the spec it owns. The section also pins the read-the-artifact rule —
  a search hit is not a reading; a rendered result is not the artifact.
- Adds **§13, backlog traffic routes through `backlog-operator`** (f338366f): no agent-manager-owned
  process writes the backlog graph directly. §2's "file debt via the backlog tool" now names
  `backlog-operator` as the route.
- Adds the red→green guard `tools/test-42b0dc25-brief-no-executor-knowledge.mjs`, registered Tier-1
  in `tools/guards-manifest.mjs`. Its negative control is the authentic pre-fix brief text as
  dispatched (session part `prt_0deddf315001ZebaxYwpdvPxXY`), which the predicate rejects; run red
  against the pre-fix spec (`git show HEAD:…`), green against this one.
- `version` and `render.claude.version` bumped in lockstep to 0.1.5; `package.json` realigned from a
  stale 0.1.3. (Deploy is out of scope for this change — not installed.)

## 0.1.4

- **`mode: primary` → `mode: all`.** agent-manager was not `task`-dispatchable, which blocked the
  blind agent-manager review of a change set — a review that must be performed by a *dispatched*
  agent-manager. With `all` it stays usable as a primary agent and can also be spawned as a subagent
  via `task`. Set in both `agent.mode` and `render.opencode.mode`; `render.claude.version` bumped in
  lockstep to `v0.1.4`.
- Installed to opencode + claude (user scope) and verified: a **fresh** `opencode agent list`
  reports `agent-manager (all)`; the claude header renders `version: v0.1.4`; deployed body matches
  the authored source (identical ignoring one blank line). The manifest declares no `dependencies`,
  so the dependency check is vacuous.

## 0.1.3

- **Adds the two knowledge areas whose absence broke the dispatcher 1.4.3 deploy** — the extension
  **IR shape** (§3) and the **install internals** (§4): prose-only entrypoint + generated header,
  the opencode model-tier pitfall (`opus`/`sonnet`/`haiku` do not resolve; only
  `render.opencode.model` pins a host id), `render.claude.version` tracking the extension version,
  and the trap that `soxe install` places ONLY the entrypoint and never installs the manifest's
  declared `dependencies` — the dispatcher shipped with 5 of its 6 playbook skills missing while
  the CLI reported success. §4 now ends with four mandatory post-install checks, one of which is
  the dependency set.
- Adds **§5, verification gates per extension type**: `validate-manifests` is the structural gate
  for all types; `smoke-test.mjs` discovers only `service`/`mcp-server` extensions and is therefore
  irrelevant to an agent/skill change; a RESOLVED bug needs a red→green guard registered in
  `tools/guards-manifest.mjs`, with the authentic pre-fix shape as its negative control.
- Corrects a stale fact in §1: `iterative-research-refinement` is **v9 on both hosts**; the body
  claimed "v8, and the claude copy is a stale v5".
- Sections renumbered 1–11 (the three new sections inserted after Role); internal `§` references
  updated to match.

## 0.1.2

- Converted to the cross-platform `agent`/`render.<host>` IR pattern (matching `dispatcher` and `researcher`): `agent-manager.md` is prose-only (frontmatter stripped), and the per-host header is generated by `libs/host-registry/src/agent-renderers.ts` at install time from `extension.json`.
- Logical model tier: `haiku` (deepseek/deepseek-flash in opencode render, mapped to haiku tier in IR).

## 0.1.1

- Pin the opencode model to the live provider id `deepseek/deepseek-flash` (the retired V4
  Flash id no longer resolves on the `deepseek` provider, so the pinned agent failed at dispatch
  time with "Model not found").

## 0.1.0

- Initial release.
- Migrated the `agent-manager` agent definition from `/Users/nix/.config/opencode/agents/agent-manager.md` into a born-conformant
  declarative agent extension.
