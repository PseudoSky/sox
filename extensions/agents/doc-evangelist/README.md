# doc-evangelist

> GTM / project-evangelism layer of the documentation trio. Consumes the cartographer's verified capability inventory, researches distribution channels + competitors via search CLIs, and produces compelling, channel-tuned launch content — distribution STRATEGY, positioning, README hero copy (for the steward to integrate), competitor comparison, launch posts, and social threads. Maintains persistent competitor + future-feature catalogs so it never re-crawls or blurs shipped vs future. Sells the future honestly (a dedicated future catalog is the source of truth). Writes only to docs/marketing/ (never the real README directly).

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
