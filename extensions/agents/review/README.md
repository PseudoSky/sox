# review

> Read-only reviewer. Static mode returns findings by severity with `file:line` evidence; blind mode takes only a diff and the word `Review`.

## Modes

| Mode | Brief |
|---|---|
| static | `mode: static`, scope, optional clause list, diff or paths |
| blind | `templates/blind.tmpl`: `Review` + diff, nothing else |
| blind-deep | `templates/blind-deep.tmpl`: `Review` + diff + specification + tests (Deep rigor, D22) |

Blind modes make no tool calls and judge only the brief. Static mode accepts `rigor: deep` and then refuses implementer reasoning. Any other brief, or a blind brief carrying rationale, ACs, or prior state, returns `REFUSED`.

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
