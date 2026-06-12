# Status Command

> Use this when you want a quick snapshot of the runtime environment without making any LLM calls.

## Overview

`status-command` is a slash command that reports three facts about the current runtime: the Node.js version, the working directory (`cwd`), and the operating system platform. It delegates to the shell (`echo` + `node --version` + `pwd` + `uname -s`) and returns the result as a single text line — deterministically, with no external dependencies beyond `node:child_process`.

It serves as the canonical reference implementation of the `command` extension type: a slash-invoked, zero-LLM, predictable shell operation.

## When to use

- When you want to confirm which Node.js version and platform a host is running on without leaving the chat interface.
- When writing integration tests that need a real slash command installed but do not depend on its output content.
- When you want a scaffold to copy-paste for a new deterministic command extension.

Do NOT use this command to gather sensitive environment data in production — it exposes the working directory path.

## Invocation

```
/status [args...]
```

Any positional `args` are appended to the output line for tracing purposes.

## Output format

```
status-command: node=v24.11.1 cwd=/home/user/project platform=Darwin args=
```

## Arguments

| Argument | Description                                     |
| -------- | ----------------------------------------------- |
| `args`   | Optional positional arguments echoed in output  |

## Constraints

- Deterministic: no LLM calls. Output is fully determined by the runtime environment.
- Times out after 5 seconds; returns `exitCode: 1` on failure.

## Usage

```bash
sox install status
```

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## License

MIT
