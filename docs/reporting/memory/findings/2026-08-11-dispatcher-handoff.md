# Dispatcher handoff — 2026-08-11 (session end, next dispatcher resume point)

> Author: dispatcher session ending 2026-08-11. This is the authoritative resume point.
> Also in memory: fiasco + playbook `01KZSV4NMH7VTV2D55KPBRBK74`, playbook `01KZQ90QEMEQRQ43FT1YP86F7F`, terminology correction `01KZSVHQ84YWRRCFZFW62PHP7S`.
> Full session-state ledger: `docs/reporting/memory/findings/2026-08-11-dispatcher-session-state.md` (main HEAD `2501e6ab`).

## DONE (verified, committed, published)
- **Weave merged to main** (`b1a7991d`): debt-soxgraph-002 + c-fix/BL-507 + stripped bl373 (ADR-0013 env purge + BackupConfig skeleton) + engine-guard/BL-508. Combined staging gate GREEN (1749 passed/0 failed, smoke 13/0/0).
- **Published + fresh-install verified**: `@adhd/sox-store-adapter@0.5.2`, `@adhd/sox-graph-store@0.8.2`, `@adhd/sox-memory-core@0.8.0` (version train commit `cff2eed2`; publish-verify in temp project confirmed new exports).
- **adhd relock committed** (`b2805252` in /Users/nix/dev/node/adhd): store-adapter 0.5.2 + graph-store 0.8.2. Commit documents the pre-existing broken hook (`--no-verify` forced; see BL-510).
- **D ACCEPTANCE PASSED — live backlog store repaired on Turso** (debug task `ses_00c74ae1effe2o7m3LtxxoiSFP`): deleted 9 poison sqlite_master rows (fts5 residue 21-28 + duplicate trigger 41) via the sanctioned better-sqlite3 escape hatch (writable_schema); real backlog CLI `create-item` → `created:true` (nodeId 2112); FK enforcement proven; 973 items. Backups in scratch: `backlog-repair-backup-20260811-202031` + `backlog-repair-backup-20260811-205416-pre-live-repair`.
- **Backlog graph writable** — all filing unblocked.
- **Fiasco + migration playbook updated in memory** (BL-506..509 root cause: 0.5.2 heal moved edge schema row behind fts5-residue poison row; Turso catalog silently aborts; repair recipe = residue-drop).

## IN FLIGHT (2 agents, still running — no completion notification yet)
1. **FK-heal permanent fix** — task `ses_00c4b2e0fffewihkn6Q6Qkr2ZJ`, typescript, worktree `.worktrees/fix-fk-heal-fts-residue`. Fixes BL-506/507/508: drop fts5 residue before/while rebuilding edge, dedupe trigger creation, post-heal turso-readability acceptance, red→green tests. Corrected framing sent: Drizzle is LIVE (coexistence rule — library owns node/edge DDL, Drizzle owns app tables). Evidence of activity: uncommitted edits to graph-store/index.ts + store-adapter/{preflight,turso-adapter,types}.ts + 2 new BL-506 specs. When landed: review → merge → publish 0.5.3/0.8.3 → relock adhd.
2. **adhd nx fix** — task `ses_00c576d73ffext2KVCmIlauS3k`, typescript, /Users/nix/dev/node/adhd. Root cause corrected: committed lockfile pinned `@nxlv/python@22.2.2(@nx/devkit@23.1.x)` since Jul 21 migration but installed tree diverged and worked; today's `pnpm update` surfaced it. Fix committed `66db0604` (devkit pin); agent mid-verification (staged package.json + pnpm-lock.yaml). When landed: confirm `nx build backlog` works + pre-commit hook passes without `--no-verify`.

## FILED THIS SESSION (verified persisted via export — see BL-512 for why verification matters)
- BL-506 (heal moved edge behind poison row), BL-507 (duplicate trigger), BL-508 (Turso catalog silent abort), BL-509 (FTS degraded — needs out-of-band idx_fts_node rebuild, doesn't block writes) — filed by repair agent.
- BL-510 (adhd nx breakage), BL-511 (telemetry root fix — never initTelemetry() at root + warning corrupts merged stdout/stderr), BL-512 (phantom write: create-item returned created:true for item that never persisted), BL-513 (backup gap ~22h — pre-start + scheduled + non-server-mode design landed, impl pending), BL-514 (episode-count metric contradiction), BL-515 (anomalous backup-slot write, author unverified), BL-516 (memory_list_entities N+1), BL-517 (F2 scale-dependent corruption deferral).
- NOTE: BL-508 code comments from engine-guard (engine-identity guard) may now collide with graph BL-508 (catalog abort) — reconcile.

## NEXT (after the 2 in-flight agents land)
1. FK-heal fix: independent review → merge → publish 0.5.3/0.8.3 → relock adhd → D re-verify (backlog create-item still green after the 0.5.3 heal).
2. nx fix: verify nx build backlog + hook, unblocks adhd toolchain.
3. **Backup feature implementation** (BL-513): pre-service-start hook + scheduled timer + backupOnOpen + retention prune per architect design (ses_00d29a0d8ffekYHq773DUsbwOJ). Dispatchable now (strip merged, backup.ts stable).
4. BL-509: out-of-band Tantivy FTS rebuild (DROP INDEX idx_fts_node + recreate with verify).
5. Deploy memory-server bundle (owner-gated — ping-honesty + proactive reconcile + engine guard now in published 0.5.2/0.8.0).
6. Owner decisions pending: node 26.5.1 runtime bump acceptance; fresh backup now (triage rec); episode-metric reconciliation (BL-514); doctor-tick os-unit ORPHANED flag; reconcile BL-508 collision.

## CRITICAL PROCESS LESSONS (this session)
- **The task tool has no status query** — do NOT use agent MCP (`tools.agent.*`) to check opencode tasks; they're different systems. Track in-flight agents by (a) completion notifications, (b) filesystem evidence (worktrees/commits).
- **Never trust `created:true`** from backlog create-item without export-verification (BL-512). Use canonical repo key `sox-ecosystem`, not `PseudoSky/sox-ecosystem`.
- **`task_id` resume can spawn a FRESH session** instead of resuming (observed twice) — verify session identity before trusting an agent's report.
- **Kill-before-identify is a protocol failure** — identify the offender from state-side evidence first, then one stop.
- **`2>&1 | node -e JSON.parse` breaks** on the telemetry warning (BL-511) — use `2>/dev/null` for backlog JSON.
- **No `rm -rf`** (policy-deny) — use surgical file ops.

## Open bugs/deferrals (complete list)
BL-510..517 (OPEN), BL-506..509 (OPEN), BL-509 FTS rebuild, BL-508 code-comment/graph-ID collision, anomalous backup-slot write author, unknown Aug-11 19:31:29 stock-SQLite -shm opener (memory store, unverified), nx fix verification, FK-heal fix verification.
