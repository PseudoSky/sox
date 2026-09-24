# doc-reviewer

> Assessment gate for the documentation trio. After the steward rewrites a scope's doc surface, this agent decides PASS/FAIL on three teeth-having lenses: (1) closed-loop metric — the re-run cartographer catalog must show metric #1 (eliminated reader searches) and undocumented/junk DROP vs the pre-rewrite baseline, with zero capabilities.json contradictions; (2) rubric/template conformance — every doc matches its deterministic skeleton recalled from memory and every README claim resolves to a shipped receipt; (3) fresh-agent consumer test — dispatches doc-consumer to complete canonical tasks using ONLY the docs. Writes a scored verdict to .catalog/review.md. Never edits the docs it judges.

## Overview

Declarative agent definition migrated into a born-conformant sox-ecosystem extension.

## Formatter

Source authored for the **opencode** agent formatter. The entrypoint
`doc-reviewer.md` is named by the extension id (opencode identity = filename) and carries
`name: doc-reviewer` in frontmatter when the source lacked it (Claude identity = frontmatter
`name`), so the same file is discoverable on both hosts.

## Source

Migrated from `/Users/nix/.config/opencode/agents/doc-reviewer.md`.

## Usage

```bash
soxe install doc-reviewer --host claude --scope user
soxe install doc-reviewer --host opencode --scope user
```

## License

MIT
