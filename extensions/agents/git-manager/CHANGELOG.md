# Changelog

## 0.3.1

- **Every `ask` entry removed; the blanket `git *` allow now governs them (owner-directed:
  "remove all ask permissions from git manager").** 0.3.0 left `git checkout*`, `git rebase*`
  and a trailing `git restore *` as `ask`, so `git restore` — placed *after* the blanket allow —
  was the live prompt under last-match-wins. All three are deleted; `git *: allow` is now their
  effective last match, so `checkout`, `rebase` and `restore` run without a prompt.
- **The destructive deny block is unchanged and still last.** `git push --force *`,
  `git push *--force*`, `git push *--no-verify*`, `git branch -D*`, `git reset --hard*`,
  `git clean -f*`, `git stash*` — verbatim, identical order, still the final seven rules, so they
  win over the blanket allow. `git restore` was never in that block and stays absent from it:
  it is now auto-allowed, including a whole-tree `git restore .`.
- **The non-git catch-all `"*": "ask"` and the non-bash permissions are untouched.** The
  directive scoped to git verbs; arbitrary non-git bash still prompts.
- Map went 50 → 47 entries; the three removed are the only `ask`-valued git rules.

## 0.3.0

- **Blanket `git *` allow (owner-directed).** The opencode `permission.bash` map gains
  `"git *": "allow"`, placed immediately before the deny block: every git command runs without
  a prompt. 0.2.0's narrow per-verb allowlist stays in the map unchanged but is now redundant —
  `git *` subsumes it; it is kept only to hold the diff to one inserted line.
- **The destructive denies are unchanged, and still last.** `git push --force *`,
  `git push *--force*`, `git push *--no-verify*`, `git branch -D*`, `git reset --hard*`,
  `git clean -f*`, `git stash*` — the engine is last-match-wins, so ordering them after the
  blanket allow is what keeps a force-push, a hard reset, or a stash refused.
- **Consequence of the ordering: `checkout`, `rebase` and `restore` now `allow`.** A blanket
  allow placed ahead of the deny block outranks 0.2.0's trailing `ask` entries under
  last-match-wins, so those three verbs no longer prompt. The `ask` entries remain in the map
  (inert) for a minimal diff; stated here so the change is not implicit.

## 0.2.0

- **Every `git -C <path>` call and every repo guard tool prompted.** 0.1.1's run-permission
  allowlist matched only `git <verb>` with the verb immediately after `git`, so the agent's
  standing idiom for inspecting another worktree fell through to the `"*": "ask"` catch-all.
  Reproduced in a fresh `opencode run --agent git-manager` against a scratch repo:
  `git status --porcelain` ran, then `git -C . status --porcelain` →
  `permission requested: bash (git -C . status --porcelain); auto-rejecting`; and
  `node tools/commit-mine.mjs --dry-run` — the repo's mandated commit guard — likewise.
  The allowlist now covers the `-C` form of every read-only verb, the repo's `node tools/*.mjs`
  guards, and — the narrowest scope that clears the prompts — the mutation verbs this agent
  solely owns (`fetch`, `worktree add/remove/prune/repair`, `commit`, `merge`, `push`, `switch`,
  `branch -d`). `checkout`, `rebase` and `restore` stay `ask`; the deny family (`--force` /
  `--no-verify` push, `branch -D`, `reset --hard`, `clean -f`, `stash`) is unchanged and still
  ordered last, so it wins over the new allows.
- **The `cd` idiom, which the allowlist cannot match.** Keys match the command string, so
  `cd <path> && git …` was never covered. One failure-mode bullet names the fix (the bash tool's
  `workdir` parameter, or `git -C` for read-only work); `git-manager.md` 177 → 179 lines.
- **Claude Code gets no per-command rule from this file — a host limitation, recorded here on
  purpose.** Claude's subagent frontmatter has no allow-rule field (documented set: `tools`,
  `disallowedTools`, `permissionMode`, …); a `disallowedTools` specifier drops the *whole* tool,
  and per-command Bash rules live in `settings.json` `permissions`, which governs the entire
  session — the wrong home for one agent's surface, and a downgrade for every other agent. So the
  claude render deliberately carries no permission block; its `tools` list already includes
  `Bash`, and prompt suppression there is the harness's own (`Bash(git:*)` + `defaultMode: auto`
  are already configured on this machine). Nothing shipped here is inert: opencode reads this
  map, claude is governed by settings.

## 0.1.1

- **The equivalence test is now single-file and content-based.** 0.1.0 said `<project>/docs/GIT-POLICY.md`
  "unless the project already has an equivalent (a contributing doc, a release-flow doc, a
  `.github/` policy)" and told the agent to "adopt and correct **it**". A real run read the union
  of `CONTRIBUTING.md` + `AGENTS.md` as that equivalent, declared it "in sync", and **deferred**
  the missing required sections to a human — refusing to create a doc because of the "rather than
  creating a second one" clause. Reproduced on a two-partial-doc fixture: 0/6 required sections
  after the run, deferral emitted. The policy now exists **only** when one committed document
  already contains every required section; anything else (no candidate, a partial candidate, or
  coverage split across several documents) means the project has no policy and
  `docs/GIT-POLICY.md` is created as the single authoritative doc, citing existing docs instead
  of restating them.
- **"Incomplete" is now a sync trigger, and establishment is never a deferral.** The old sync
  rule fired only on *absent* or *drift* (a false rule, or an omitted repo convention). Missing
  required sections are neither — so the gap was invisible to it. The trigger now includes
  **incomplete**, and the contract states that "there is no policy doc here" and "the doc lacks
  section X" are outcomes the agent fixes inside the operation, not blockers it reports.
  `## Refused / Deferred` says so explicitly.
- Two failure modes named: **kind-equivalence** and **deferred establishment**.
- A/B (fresh subagent, two fixture shapes × contract v0.1.0 vs v0.1.1): two-partial-doc fixture
  went 0 → 6 required sections and a deferral → none. Runtime cost rose (tool_calls 2.43x, cost
  1.77x) because the variant performs the policy authoring the baseline omitted; attribution
  shows 96% of the wall-clock delta in model-wait, not tool execution. Surfaced, not hidden.

## 0.1.0

- Initial release: sole owner of a project's git operations and of a per-project git policy
  document; worktree lifecycle with the three-part safe-to-remove predicate; hard refusals for
  irreversible operations; separation of duties (merger ≠ implementer).
