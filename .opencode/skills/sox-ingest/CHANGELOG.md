# Changelog

## 0.3.0

- New **§batch — Batch-migrate agents**: `scripts/migrate-agents.mjs` takes any list of agent
  paths/globs and turns them into born-conformant `extensions/agents/<id>/` extensions.
  Formatter-aware naming: detects opencode (`mode:`/`permission:`, filename identity) vs Claude
  (`name:`/`tools:`, frontmatter identity) from the source frontmatter, names the entrypoint
  `<id>.md`, and injects `name: <id>` when the source lacks it so the SAME file is discoverable
  on both hosts. Skips existing dirs (unless `--force`); `--registry` rebuilds the index.
  Invoked as a skill script via bash — NOT a host custom tool (BL-568: a malformed
  `.opencode/tools/` schema rejects the whole provider tool list and breaks every session).
- BL-566 note: migrated agents install as a single top-level `<id>.md` (install-engine fix),
  never a directory opencode's agents/*.md scan would miss.

## 0.2.0

- Step 5 rewritten as **Install & replace in place**: uninstall any existing install of the
  same id at the target host BEFORE installing, because install is additive and leaves stale
  orphans behind; verify byte-parity with the extension dir and zero leftover files. Documents
  that `soxe install --dry-run` IS honored on the declarative host path (plan-only — prints
  would-place targets, writes nothing; implemented in the install-engine dry-run fix).
- New **Step 5.5 — Exercise the install (per-host load test)**: prove each target host actually
  discovers and loads the installed artifact in a FRESH process (`opencode run` / `claude -p`
  one-turn probes asserting the reported version matches the extension entrypoint). File
  placement alone is not proof the host can use the skill.
- Step 4 and §registry document the BL-390 dirty-tree reality (`build-index` refuses on a dirty
  tree; `--allow-dirty` escape hatch; `nx run registry:sync-index` does not forward flags).
- Step 7 rewritten as **preserve-then-clean**: superseded files are archived to a committed
  location + scratch backup before removal; live install dirs are cleaned via uninstall +
  fresh install, never ad-hoc `rm`.

## 0.1.0

- Initial release. Declarative skill extension encoding the full ingestion flow:
  initialize → generalize+author → validate → publish → install → enable → remove-old,
  delegating per-type and per-operation specifics to `references/`.
