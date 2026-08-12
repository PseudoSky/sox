# debug

> debug agent

## Overview

Declarative agent definition migrated into a born-conformant sox-ecosystem extension.

## Formatter

Source authored for the **opencode** agent formatter. The entrypoint
`debug.md` is named by the extension id (opencode identity = filename) and carries
`name: debug` in frontmatter when the source lacked it (Claude identity = frontmatter
`name`), so the same file is discoverable on both hosts.

## Source

Migrated from `/Users/nix/.config/opencode/agents/debug.md`.

## Usage

```bash
soxe install debug --host claude --scope user
soxe install debug --host opencode --scope user
```

## License

MIT
