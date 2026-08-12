# performance

> Senior performance engineer (deepseek-v4-flash). Identifies and eliminates bottlenecks in applications, databases, and infrastructure via profiling, load testing, and measured optimization. Delegates broad discovery to `researcher`, uses GitNexus-first blast-radius analysis before touching hot-path code, and requires before/after measurement. Differentiate from `refactor`: this agent optimizes for speed/throughput with numbers; `refactor` optimizes for structure/maintainability.

## Overview

Declarative agent definition migrated into a born-conformant sox-ecosystem extension.

## Formatter

Source authored for the **opencode** agent formatter. The entrypoint
`performance.md` is named by the extension id (opencode identity = filename) and carries
`name: performance` in frontmatter when the source lacked it (Claude identity = frontmatter
`name`), so the same file is discoverable on both hosts.

## Source

Migrated from `/Users/nix/.config/opencode/agents/performance.md`.

## Usage

```bash
soxe install performance --host claude --scope user
soxe install performance --host opencode --scope user
```

## License

MIT
