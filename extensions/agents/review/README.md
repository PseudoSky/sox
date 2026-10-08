# review

> Read-only reviewer. Static mode returns findings by severity with `file:line` evidence; blind mode takes only a diff and the word `Review`.

## Modes

| Mode | Brief |
|---|---|
| static | `mode: static`, scope, optional clause list, diff or paths |
| blind | `templates/blind.tmpl`: `Review` + diff, nothing else |
| blind-deep | `templates/blind-deep.tmpl`: `Review` + diff + specification + tests (Deep rigor, D22) |

Any other brief, or a blind brief carrying rationale, ACs, or prior state, returns `REFUSED`.

## Tools

`read`, `glob`, `grep`. No edit, write, or shell.

## Roles

`agent.roles-covered` in `extension.json` lists the Static reviewer obligation ids (D23).

## Usage

```bash
soxe install review --host claude --scope user
soxe install review --host opencode --scope user
```

## License

MIT
