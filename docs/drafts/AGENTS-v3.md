# Tenant 0

Remember when implementing: The marginal cost of completeness is near zero with AI. Do the whole thing. Do it right. Do it with tests. Do it with documentation. Do it so well that I am is genuinely impressed — not politely satisfied, actually impressed. Never offer to ‘table this for later’ when the permanent solve is within reach. Never leave a dangling thread when tying it off takes five more minutes. Never present a workaround when the real fix exists. The standard isn’t ‘good enough’ — it’s ‘holy shit, that’s done.’ Search before building. Test before shipping. Ship the complete thing. When I asks for something, the answer is the finished product, not a plan to build it. Time is not an excuse. Fatigue is not an excuse. Complexity is not an excuse. Boil the ocean.

## Content Updating & Correction Protocol

- Maintain a single, current source of truth in all generated or edited documents.
- If a fact, claim, or data point is invalidated by new information during drafting or revision, immediately overwrite or delete the old information.
- CRITICAL: Never include meta-commentary about the change. Do not use phrases like "Correction to my prior statement," "As previously incorrectly stated," "Updating this to reflect," or "Note: this has changed."
- The final output must read as a cohesive, professional document without historical artifacts or edit notes.

## Editing CLAUDE.md

- Any change to a CLAUDE.md must start from the minimum prose that expresses the requirement, then be A/B tested (cheapest-tier model agent only) to confirm it produces the desired effect, iterating up to 3 times if it fails.

## Memory

- Utilize memory-mcp tools for agent memory
- If you encounter a problem check memory for solutions

## Bash

- Never use `git stash` or `git stash pop`
- Never use `git reset --hard` — it silently and irrecoverably destroys uncommitted work. To discard a specific file use `git restore <path>`; to move HEAD without touching the working tree use `git reset --soft`. If you believe a hard reset is genuinely required, stop and ask.
- git worktrees are always within in <project>/.worktrees/

## Code Search

**Code search is a strict hierarchy — never skip a level, and never fall back without an explicit reason.**

1. **`gx` (gitnexus CLI) first** — for any task that means understanding code: "how does X work", "what calls/uses Y", "trace the flow of Z", "where is W handled". Run `gx query "<concept>"`, `gx context <symbol>`, `gx impact <target>` (the `gx` wrapper auto-resolves the indexed repo for your cwd; fall back to `gitnexus <cmd> --repo <name-or-path>` if needed). gitnexus is local, indexed, and answers symbol/flow questions directly.
2. **The Grep tool (rg-backed, .gitignore-aware) or `rg`** — for content search gitnexus can't answer.
3. **Glob** — for locating files by name. **Read of a directory** — for listing.

**Bash `grep` and `find` are banned for code search inside the workspace.** If you believe bash `grep` or `find` is genuinely required, state in one line which of the three levels above failed and why, then use it — but a silent bash `grep`/`find` is a process violation. (The `grep`/`find` inside a `node`/`python` script you are running is fine — this rule targets your own shell commands.)

## Dry

Dont repeat yourself - if you're planning to author a new large script/package/project

- Query memory for authored internal solutions (ones that we've already built)
- If there are no internal solutions query for tool research related to the use case
- If there is no pre existing research, use a live search to discover up to date tools (dont rely on llm model recall as it is not up to date)
- If you perform the live search: log the evaluation to memory with tags on topic and language + describe the generalized use case in the content plus the final decision

## Package Management (JS/TS)

- Default every JS/TS project to pnpm, never npm/yarn. The machine-wide pnpm store is pinned at `~/Library/pnpm/store` (`pnpm config get store-dir`) so every new project shares disk with every existing one automatically — that's the entire point, don't undermine it by installing with npm/yarn out of habit.
- New project: `pnpm init` / `pnpm add`, not `npm install` / `yarn add`.
- Find an existing npm/yarn project mid-task: don't leave it as-is and don't silently convert it either. Use `~/dev/ai/scratch/pnpm-migrate` (`scratch-pnpm-migrate discover|plan|migrate`) — it refuses to touch a dirty git tree, skips workspace/monorepo roots by default, and preserves resolved versions via `pnpm import` rather than a fresh re-resolve. Same rule as the git-safety section above: never migrate a project with uncommitted changes without asking first.
- `unlocked` projects (node_modules present, no lockfile at all) aren't real `pnpm import` candidates — flag them, don't fresh-`pnpm install` them unasked, since that re-resolves every version.

## Disclosure

- **Backlog** File every deferral and bug at the time of discovery (do not ask the user if you should) with the backlog MCP tools — `backlog_create_item`, scoped to the repo you are in. **Never hand-edit BACKLOG.md or CHANGELOG.md**: the graph is the source of truth and those files are a deprecated projection. Verify each write landed with `backlog_get_item` — a create call reporting success is not proof it wrote. If a repo's items are not in the graph yet, run `backlog_migration_status` and import them first; `sox-ecosystem` is already migrated and verified, every other repo still needs that check. Working from a plan in `docs/plan/<plan>`: set the item's `plan` field instead of appending IDs to a second file.
- **Cite what you read** Annotate every claim in the body as `<claim>[<citation number>]` and end the item with: `Citations: [<active git context>, <agent name>, <claude|deepseek|codex|etc>, <active plan or task>, <citation number>: <file path>:<line numbers — omit for whole file>, <repeat citation>]`
- **No citation, no claim** If you did not open the file, you may not assert it — grep hits are not reading. An item with no `Citations:` block is not fileable.
- **Dedupe before filing** Before adding an item, search the graph (`backlog_list_items` with `grep`, `backlog_spotlight`) for an existing entry with the same root cause. Search by symbol name, file path, and error string — never by title alone, the same bug is routinely filed under a different name. If you find a match, **update that item** with your new citations and evidence instead of filing a duplicate. If yours is genuinely distinct but related, file it and cross-link the related item. When in doubt, treat it as a duplicate and enrich the existing entry.
- **Completed items are resolved in the graph** Never delete a finished item and never leave it struck through or checked off in place. When work completes, `backlog_resolve_item` (or `backlog_transition_status`) with a citation recording what changed, why, and the commit reference. An item is only "complete" once you have verified the fix — not when you believe you wrote it.
- **Commit immediately, never lose another agent's work** Commit each BACKLOG/CHANGELOG edit the moment you make it; never batch them for later, since a concurrent agent's commit will bury an uncommitted edit. Stage only the explicit paths you touched — `git add <path>`. **Never `git add -A`, `git add .`, or `git commit -a`**: they sweep another agent's in-flight work into your commit. Never revert, overwrite, or discard changes you did not author. If a file moved under you, re-read it and merge your entry into the *current* content rather than writing back your stale copy; on conflict, integrate both entries and drop neither. (`git stash` and `git reset --hard` are banned above precisely because they destroy this work.)
- **Never burry bugs & deferrals** during a response, never put newly discovered bugs in the middle of a message
- **Always reiterate at closing** Always complete your message with the complete list of unacknowleged bugs / deferrals
- **Keep a running log** for all encountered bug store them to memory until the user gives specific direction

## 🛑 Accountability

- **Zero Deflection:** Never claim a bug, error, or test failure is "pre-existing," "legacy," or "out of scope."
- **Full Ownership:** Treat every code failure as a direct regression caused by your recent changes.
- **Banned Phrases:** Do not use phrases like "this appears to be an existing issue," "inherited bug," or "unrelated to my changes."
- **Mandatory Verification:** Before diagnosing an error, you must run `git diff` and the relevant test suite to trace the exact origin of the failure.
- **Fix It First:** If a test fails after an edit, your sole priority is to fix it immediately, regardless of when the bug was introduced.

## Dispatch

- **No Blind Delegation:** Never call `Agent()` or dispatch subagents with an empty or omitted `tools` parameter.

- **Exact Tool Provisioning:** Every subagent must be explicitly given the specific tools required for its task.
- **Functional Matching:**
  - *File Ops:* Must include `ViewFile`, `WriteFile`, or `EditFile`.
  - *Research:* Must include `WebSearch` or `FetchURL`.
  - *Execution:* Must include `Bash` or test scripts.
- **Scope Isolation:** Subagents must abort and return to the supervisor if a task requires an undeclared tool.
- **Loop Prevention:** If a tool error occurs, stop dispatching subagents and ask the user for intervention.

## 🔍 Diagnostics

- **Specific Ask** If you are talking directly to the user and they ask you to use a specific tool but you do not see that it is available, stop and confirm with the user before using another tool they may have meant
- **No Guessing:** If an error occurs, do not guess the cause. Look at actual logs, stack traces, or compiler outputs first.
- **Isolate Changes:** Keep fixes surgical and minimal. Do not rewrite large chunks of unrelated code to fix a single bug.
- **Check Side Effects:** After writing a fix, explicitly check if your changes broke imports, type definitions, or environment variables.
- **Drop the Polite Excuses:** Do not apologize or explain *why* a bug might have been there before. Just state the root cause and provide the code to fix it.
