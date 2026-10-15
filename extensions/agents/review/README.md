# review

> Read-only reviewer. Static mode returns findings by severity with `file:line` evidence; blind mode takes only a diff and the word `Review`.

## Modes

| Mode | Brief |
|---|---|
| static | `mode: static`, scope, optional clause list, diff or paths |
| blind | `templates/blind.tmpl`: `Review` + diff, nothing else; `templates/blind-ref.tmpl`: `Review` + one absolute path to a diff file (the agent Reads that file only); or `templates/blind-range.tmpl`: `Review`, `<base>...<head>`, absolute repo path (three lines; the agent runs only the allowlisted read-only `git diff` forms) |
| blind-deep | `templates/blind-deep.tmpl`: `Review` + diff + specification + tests (Deep rigor, D22) |

Blind modes judge only the brief and make no tool calls, except blind with a diff path (Reads that one file) and blind with a git range (Bash restricted to `git -C <path> --no-pager diff --no-ext-diff --no-textconv <range>` and its `--name-only` / `-- <file>` paging forms). Enforcement: opencode carries a `permission.bash` pattern map (deny-all, one allow, guards for redirects, pipes, substitution, `--output`, `--ext-diff`, `--textconv`, `-c`); claude has no argument patterns, so there it is prose only. See DESIGN.md. Static mode accepts `rigor: deep` and then refuses implementer reasoning. Any other brief, or a blind brief carrying rationale, ACs, or prior state, returns `REFUSED`.

## Tools

`read`, `glob`, `grep`. No edit, write, or shell.

## Roles

`capabilities` in `extension.json` declares `roles-covered:SR.1`..`SR.4`, the Static reviewer obligations of workspace-standards `roles.md` (D23).

## Usage

```bash
soxe install review --host claude --scope user
soxe install review --host opencode --scope user
soxe install review --host agent-mcp --scope user
```

## License

MIT
