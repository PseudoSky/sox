# doc-consumer

> >-

## Overview

Declarative agent definition migrated into a born-conformant sox-ecosystem extension.

## Formatter

Source authored for the **opencode** agent formatter. The entrypoint
`doc-consumer.md` is named by the extension id (opencode identity = filename) and carries
`name: doc-consumer` in frontmatter when the source lacked it (Claude identity = frontmatter
`name`), so the same file is discoverable on both hosts.

## Source

Migrated from `/Users/nix/.config/opencode/agents/doc-consumer.md`.

## Usage

```bash
soxe install doc-consumer --host claude --scope user
soxe install doc-consumer --host opencode --scope user
```

## License

MIT
