# review

> Read-only reviewer. Static mode returns findings by severity with `file:line` evidence; blind mode takes only a diff and the word `Review`.

## Modes

| Mode | Brief |
|---|---|
| static | `mode: static`, scope, optional clause list, diff or paths |
| blind | `templates/blind.tmpl`: `Review` + diff, nothing else; or `templates/blind-ref.tmpl`: `Review` + one absolute path to a diff file (the agent Reads that file only) |
| blind-deep | `templates/blind-deep.tmpl`: `Review` + diff + specification + tests (Deep rigor, D22) |

Blind modes judge only the brief and make no tool calls, except blind with a diff path, which Reads that one file. A git range is refused (no shell): write the diff to a file and pass its path. Static mode accepts `rigor: deep` and then refuses implementer reasoning. Any other brief, or a blind brief carrying rationale, ACs, or prior state, returns `REFUSED`.

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
