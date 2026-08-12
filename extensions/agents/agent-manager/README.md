# agent-manager

> agent-manager agent

## Overview

Declarative agent definition migrated into a born-conformant sox-ecosystem extension.

## Formatter

Source authored for the **opencode** agent formatter. The entrypoint
`agent-manager.md` is named by the extension id (opencode identity = filename) and carries
`name: agent-manager` in frontmatter when the source lacked it (Claude identity = frontmatter
`name`), so the same file is discoverable on both hosts.

## Source

Migrated from `/Users/nix/.config/opencode/agents/agent-manager.md`.

## Usage

```bash
soxe install agent-manager --host claude --scope user
soxe install agent-manager --host opencode --scope user
```

## License

MIT
