# product

> Senior product manager (deepseek-v4-flash). Owns product strategy, roadmap, feature prioritization, and new-feature research (competitive analysis, market trends, user need discovery). Delegates broad discovery to `researcher` (never freelances a web search) and uses GitNexus-first codebase awareness. Differentiate from `backend`/`typescript`: this agent decides WHAT and WHY; it does not implement.

## Overview

Declarative agent definition migrated into a born-conformant sox-ecosystem extension.

## Formatter

Source authored for the **opencode** agent formatter. The entrypoint
`product.md` is named by the extension id (opencode identity = filename) and carries
`name: product` in frontmatter when the source lacked it (Claude identity = frontmatter
`name`), so the same file is discoverable on both hosts.

## Source

Migrated from `/Users/nix/.config/opencode/agents/product.md`.

## Usage

```bash
soxe install product --host claude --scope user
soxe install product --host opencode --scope user
```

## License

MIT
