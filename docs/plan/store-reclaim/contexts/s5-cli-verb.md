# s5-cli-verb — memory CLI report verb

**Phase:** surface · **Deps:** s2 · **Tier:** easy · **Est:** ~120 R / ~250 W
**⚠️ SERIALIZE with s3, s4, s4_5.**

## Goal

Expose the reclaim as the repo's sanctioned one-shot operator verb (ADR-0013 D4): `memory fts-rebuild`
(already exists per `fts-rebuild-cli.bl-c5249cdd.spec.ts`) gains a `--dry-run` path printing the
`StoreReclaimReport`, and `memory backup`/retention reporting surfaces the expiry result.

## File ownership

- **mutates:** `extensions/bundles/sox-memory-bundle/members/memory-cli/src/index.ts` (the `fts-rebuild`
  verb — **exact line UNVERIFIED**, confirm on read; `cmdBackup` at ~`:503`/`:518`; `cmdCompact` at ~`:584`)
- **creates/extends:** `extensions/bundles/sox-memory-bundle/members/memory-cli/src/*.spec.ts`

## Acceptance criteria

1. `memory fts-rebuild --dry-run` prints a `StoreReclaimReport` and exits 0 **without** mutating the store
   (assert canonical file identity unchanged; `.rebuild-<ts>` cleaned).
2. `memory fts-rebuild` (no dry-run) performs the reclaim and reports `bytes_reclaimed`.
3. The existing `bl-c5249cdd` CLI spec still passes (alarm clears after a reclaim).
4. `npx nx test memory-cli` green in an isolated worktree.

## Commit points

- After the CLI spec passes: commit `index.ts` + spec by **explicit pathspec**.

## Notes

- **Confirm the `fts-rebuild` verb's exact defining line first** (anchor gap in `STATE.md`); update this
  context with the real `file:line` when you do.
- Reuse `memoryReclaimStoreIfNeeded` (S2); do not reimplement.
