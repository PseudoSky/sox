# doc-steward

> One-shot, background-trustable owner of a project's documentation surface. Dispatches doc-cartographer for ground-truth facts, recalls best-in-class doc frameworks from memory, then makes the public docs (README, CHANGELOG, docs/, community-health files) correct + usable + exciting and the LLM-guiding docs (AGENTS.md, llms.txt) strictly factual — consolidating to the right home, removing wrong/irrelevant content, and organizing entry points consumer-first. Scope-aware and recursive across monorepos. Every add/rewrite/move/delete is logged recoverably. Runs autonomously; when it finishes, the documentation is trustworthy.

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
