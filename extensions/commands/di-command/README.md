# di-command

> di-command extension

## Overview

<!-- Describe what slash command this extension implements and what it does. -->

## When to use

<!-- Describe the conditions under which a user invokes this command.
     Example: "Use /di-command when you need to run X quickly from the chat interface." -->

## Invocation

```
/di-command [args...]
```

## Arguments

| Argument | Description |
| -------- | ----------- |
| `args`   | Positional arguments passed to the command |

## Constraints

- Deterministic: no LLM calls inside the command handler.
- Exits non-zero on failure; stdout is the result.

## Usage

```bash
sox install di-command
```

## License

MIT