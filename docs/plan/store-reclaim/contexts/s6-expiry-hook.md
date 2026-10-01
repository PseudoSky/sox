# s6-expiry-hook — reclaimer post-swap expiry hook

**Phase:** expiry · **Deps:** s1, s8 · **Tier:** medium · **Est:** ~120 R / ~250 W
**⚠️ SERIALIZE with s8** (shares `RetentionResult`).

## Goal

On a successful swap, invoke the expiry pass while still holding the retention lock, with the fresh
pre-swap hard link protected (DESIGN §8.5).

## File ownership

- **mutates:** `libs/data/store/store-adapter/src/store-reclaim.ts` (add `retention?: RetentionResult` to
  the report; call the injected expiry function), `libs/data/store/store-adapter/src/index.ts`
- **read_only:** `libs/memory-core/src/backup.ts` (`pruneBackupSets` from S8)

## Contract

`StoreReclaimOptions.expire?: (backupDir, policy, protectedRefs) => RetentionResult`. The reclaimer calls it
inside the §8.5 interlock (`~/.memory/backups/.retention.lock`) with `protectedRefs:[backupPath]`, after the
swap and before releasing the reclaim lock. `StoreReclaimReport.retention` carries the result.

## Acceptance criteria

1. On a successful swap, `report.retention` is populated and `protectedRefs` (the fresh backup) is **not**
   expired.
2. The expiry call happens while the retention lock is held; a concurrent scheduled pass skips.
3. `npx nx test store-adapter` green in an isolated worktree.

## Commit points

- After the spec passes: commit the two store-adapter files by **explicit pathspec**.

## Notes

- S6 owns only the **wiring**; S8 owns `pruneBackupSets` itself. Land S8 (or at least its exported type)
  first, or stub the type and reconcile — that is why they serialize.
