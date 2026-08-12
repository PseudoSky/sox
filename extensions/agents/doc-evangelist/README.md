# doc-evangelist

> >-

## Overview

Declarative agent definition migrated into a born-conformant sox-ecosystem extension.

## Formatter

Source authored for the **opencode** agent formatter. The entrypoint
`doc-evangelist.md` is named by the extension id (opencode identity = filename) and carries
`name: doc-evangelist` in frontmatter when the source lacked it (Claude identity = frontmatter
`name`), so the same file is discoverable on both hosts.

## Source

Migrated from `/Users/nix/.config/opencode/agents/doc-evangelist.md`.

## Usage

```bash
soxe install doc-evangelist --host claude --scope user
soxe install doc-evangelist --host opencode --scope user
```

## License

MIT
