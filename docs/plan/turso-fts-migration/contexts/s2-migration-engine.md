# s2 — Migration transform engine

## Goal

Extend the offline rebuild path so it can migrate v1 → v2 **and** reclaim leaked pages,
reusing the existing safety machinery.

## Work

1. Add a migration transform to `store-rebuild.ts`: after the source facts are captured
   and **before** `adapter.backupTo` (`:865`), for each index matching `isFtsIndex`:
   `DROP INDEX <idx>` then `CREATE INDEX <idx> ON <table> USING fts (<cols>)` (DDL from
   `fts-dialect.ts:252`; cols from `parseFtsColumns`).
2. Keep the existing offline-exclusive gate (`openOfflineExclusive`, `store-lease`),
   `stampRebuildMeta` (counter reset), `verifyReplacement` (sentinel round-trip via
   `fts_match`), and `swapIntoPlace` unchanged.
3. Gate the transform so it only fires when the store actually carries a v1 FTS index
   under a v2-aware driver — never on a healthy v2 store (avoid DROP+CREATE churn that
   would re-leak).
4. Add a **pre-migration image** capture while the store is still v1-format
   (`<db>.pre-migration-<ts>`, reflink) — the rollback image.

## Deliverable

`store-rebuild.ts` changes + the migration spec `fts-format-migration.bl-89849d2a.spec.ts`
(written, seen RED with the transform disabled, then GREEN).

## Constraints

Do not contradict the engine's "never drop" invariant silently — the DROP is a *format
migration*, documented as the exception, gated. No empty catches. No new WAL-checkpoint
mechanism (ADR-0012). Offline-exclusive: refuse under live peers/openers or a non-empty
`-wal`.
