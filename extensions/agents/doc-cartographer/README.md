# doc-cartographer

> FACTS subagent for the documentation trio. Given a scope (a directory with a manifest), it classifies the scope type, recalls the best-in-class doc frameworks from memory, drives GitNexus to discover the REAL features (tagged shipped/roadmap/deprecated with runnable receipts), assesses the existing doc surface for junk/redundancy/gaps, records public distribution + freshness, surfaces missing verification tools, and logs three health metrics per run. Writes only to <scope>/docs/marketing/.catalog/. Never writes prose docs, never guesses. Dispatched by doc-steward.

## Overview

Declarative agent definition migrated into a born-conformant sox-ecosystem extension.

## Formatter

Source authored for the **opencode** agent formatter. The entrypoint
`doc-cartographer.md` is named by the extension id (opencode identity = filename) and carries
`name: doc-cartographer` in frontmatter when the source lacked it (Claude identity = frontmatter
`name`), so the same file is discoverable on both hosts.

## Source

Migrated from `/Users/nix/.config/opencode/agents/doc-cartographer.md`.

## Usage

```bash
soxe install doc-cartographer --host claude --scope user
soxe install doc-cartographer --host opencode --scope user
```

## License

MIT
