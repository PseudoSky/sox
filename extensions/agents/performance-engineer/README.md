# performance-engineer

> Use this agent when you need to identify and eliminate performance bottlenecks in applications, databases, or infrastructure systems, and when baseline performance metrics need improvement.

## Overview

Declarative agent definition migrated into a born-conformant sox-ecosystem extension.

## Formatter

Source authored for the **claude** agent formatter. The entrypoint
`performance-engineer.md` is named by the extension id (opencode identity = filename) and carries
`name: performance-engineer` in frontmatter when the source lacked it (Claude identity = frontmatter
`name`), so the same file is discoverable on both hosts.

## Source

Migrated from `/Users/nix/.claude/agents/performance-engineer.md`.

## Usage

```bash
soxe install performance-engineer --host claude --scope user
soxe install performance-engineer --host opencode --scope user
```

## License

MIT
