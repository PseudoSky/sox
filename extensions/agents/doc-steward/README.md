# doc-steward

> >-

## Overview

Declarative agent definition migrated into a born-conformant sox-ecosystem extension.

## Formatter

Source authored for the **opencode** agent formatter. The entrypoint
`doc-steward.md` is named by the extension id (opencode identity = filename) and carries
`name: doc-steward` in frontmatter when the source lacked it (Claude identity = frontmatter
`name`), so the same file is discoverable on both hosts.

## Source

Migrated from `/Users/nix/.config/opencode/agents/doc-steward.md`.

## Usage

```bash
soxe install doc-steward --host claude --scope user
soxe install doc-steward --host opencode --scope user
```

## License

MIT
