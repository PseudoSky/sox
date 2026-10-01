# s4 — CLI subcommand + offline wiring

## Goal

Expose the migration as an explicit operator CLI invocation (ADR-0013 D4 — never
env-gated), reusing the `fts-rebuild` pattern.

## Work

1. Add a `fts-migrate` verb (or extend `fts-rebuild` with a `--migrate-format` flag) in
   `extensions/bundles/sox-memory-bundle/members/memory-cli/src/index.ts`, alongside
   `cmdFtsRebuild` (`:701`, dispatch `:867`).
2. Flags: `[--db <path>] [--dry-run]`. Refusal → exit 2; failure → exit 1 (mirror
   existing).
3. Wire it to the s2 transform. `--dry-run` reports what would be dropped/created and the
   expected reclaim, writes nothing.
4. Extend `memory-cli/src/fts-rebuild-cli.bl-c5249cdd.spec.ts`.

## Constraints

ADR-0013 D1/D4: no env toggle. Help text updated. Offline-exclusive refusal path
mirrored (`RESTORE_CONTENT_REFUSALS` precedent `:760`).
