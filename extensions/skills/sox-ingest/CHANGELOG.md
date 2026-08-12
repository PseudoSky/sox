# Changelog

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
