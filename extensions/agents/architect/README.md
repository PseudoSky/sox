# architect

> Read-only architecture agent (deepseek-v4-pro). Takes a vague feature description, delegates research to the researcher agent, analyzes the codebase with gitnexus MCP, and produces a full implementation spec with exact file paths, interface and behavioral changes, independent segments with token estimates, execution strategies for weaker agents, test cases, and documentation updates. ALWAYS delegates research — never does its own.

## Overview

Declarative agent definition migrated into a born-conformant sox-ecosystem extension.

## Formatter

Source authored for the **opencode** agent formatter. The entrypoint
`architect.md` is named by the extension id (opencode identity = filename) and carries
`name: architect` in frontmatter when the source lacked it (Claude identity = frontmatter
`name`), so the same file is discoverable on both hosts.

## Source

Migrated from `/Users/nix/.config/opencode/agents/architect.md`.

## Usage

```bash
soxe install architect --host claude --scope user
soxe install architect --host opencode --scope user
```

## License

MIT
