# @adhd/sox-agent-shell-wrappers

Argv-policed `git` and `rm` wrappers that make a per-agent shell allowlist enforceable.
The agent-mcp shell server matches only `argv[0]`, so capability is expressed as separate
command **names**; an agent cannot escalate by passing a flag. Plain `git` and plain `rm`
belong in no agent allowlist. Spec: shell-policy-spec section 1.1 (losses L1-L6, control C1).

| command | capability |
|---|---|
| `sox-git-ro` | `status diff log show rev-parse rev-list reflog ls-files cat-file check-ignore for-each-ref merge-base merge-tree symbolic-ref`, `remote [-v]`, `branch --list/-a/--show-current`, `worktree list`, `config --get <key>`; `-C <path>` prefix (these only) |
| `sox-git-impl` | ro + `add <pathspec>`, `commit ... -- <pathspec>`, `restore <path>`, `mv`, `rm`, `fetch <remote>`, `switch` |
| `sox-git-merge` | impl + `merge --ff-only <ref>`, `worktree add\|remove\|prune` (path must resolve under `<main repo>/.worktrees/`), `branch -d` |
| `sox-rm` | removes files inside cwd; recursive only strictly under `<cwd>/tmp/` or `<cwd>/.worktrees/`; never `-f` |

`sox-git-ro|impl|merge` are one script (`bin/sox-git`); the mode is chosen **only** by
`basename(argv[1])`. Any other name (including a bare `sox-git`) is denied (`X-MODE`).
Install them as symlinks named exactly like the commands (pnpm/npm shell shims pass the script
name, not the command name, and would deny everything; that is the intended fail-closed behaviour).

## Denials

A denied form exits **2** and prints `sox-git: <rule-id> denied` (`sox-rm: <rule-id> denied`)
on stderr; nothing is passed to git. Permitted forms run `spawnSync('git', argv)` with an
argv array (never a shell string) and return git's exit code.

| id | meaning |
|---|---|
| L1 | `stash` (any) |
| L2 | `add -A/--all/-u`, `add .`/`*`/`:`-magic (whole-tree pathspec) |
| L3 | `reset` (any) |
| L4 | `push` (any) |
| L5 | `clean`, `checkout`, `branch -D` / `-d -f`, `tag -d` |
| L6 | `sox-rm`: any force flag, or recursion outside `<cwd>/tmp/` / `<cwd>/.worktrees/` |
| X-* | everything else refused: `-c`/`--config-env` (anywhere), unknown global options, `config` writes, `rebase`, unknown subcommands, subcommands above the wrapper's tier (`X-MODE`), `--amend`, `--no-verify`, `commit -a`, `commit` without `-- <pathspec>`, whole-tree `restore`/`rm`, `mv -f`, `--output`/`--ext-diff` on read-only commands, URL/`ext::` fetch remotes, `switch --force`, `merge` other than `--ff-only`, worktree paths outside `.worktrees/`, branch create/rename, `sox-rm` outside cwd |

The authoritative list is `RULE_IDS` in `src/policy.ts`. Every check is an allowlist: a form
that is not recognised is denied.

## Hardening notes

- `GIT_CONFIG_*`, `GIT_EXTERNAL_DIFF`, `GIT_EXEC_PATH`, `GIT_SSH*`, `GIT_ASKPASS`, `GIT_EDITOR`, `GIT_PAGER`,
  `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE*` are removed from the
  environment git sees; `GIT_EDITOR=true` and `GIT_TERMINAL_PROMPT=0` are set so a command can never hang on an editor or prompt.
- Long options are matched with git's abbreviation rules in mind (`--amen`, `--outp=`).
- Paths are resolved through symlinks before containment checks; a symlink leaf is unlinked, never followed.
- `commit` always requires `-- <pathspec>` because the wrapper cannot see what other agents staged in the shared index.

## Build and test

```
npx nx affected -t build,test,lint,typecheck --files=libs/agent-shell-wrappers/src/policy.ts
```

`bin/*` loads `dist/policy.js`, so the `test` target depends on `build`. The spec
(`src/policy.spec.ts`, ids `faa8064b SHELL-AC5: ...`) execs the real wrappers (via
`sox-git-ro|impl|merge|sox-rm` symlinks) against throwaway repos under the OS tmpdir.
