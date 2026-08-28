# Memory Server — Operations Playbook

How to deploy, restart, verify, and back up the running memory server. This is
the canonical procedure; the `soxe service` lifecycle is the ONLY supported path.

## The one rule

The memory server is a **launchd-managed, proxy-mode `mcp-server`** (unit
`com.sox.user.memory-server`, HTTP transport at `http://localhost:3099/mcp`).
Every deploy/restart/backup goes through `soxe service` — and the backup goes
through the memory-core `backupStore`/`autoBackup` (the same Turso engine).

**Never** `kill <pid>` + relaunch `soxe serve`; **never** run the standard
`sqlite3` CLI against the live `~/.memory/memory.db` (cross-engine WAL risk).

## Deploy / upgrade (code or bundle change → running server)

```bash
# 1. Rebuild the extension bundle (bundles the library dist into dist/index.js).
npx nx build memory-server

# 2. Deploy the on-disk bundle to the RUNNING process.
#    BL-372 [inv:deploy-verified]: kickstarts the unit WITHOUT rewriting the unit
#    file, reaps any survivor by identity (forces the proxy-mode backend to
#    respawn on the NEW bundle), and exits NON-ZERO if the pid did not rotate.
soxe service restart memory-server
```

A green `restart` exit code with a `pid(s) rotated` line is the evidence of a
deploy — a bare `launchctl kickstart` success is NOT.

## Verify

```bash
soxe service status memory-server     # loaded:yes, owner:os-unit, live pid
soxe service list                     # all sox-owned OS units
```

Then `memory_ping` (or a direct `tools/call memory_ping`) and check:

- `artifact` sha256 **changed** from the previous deploy (proof the new bundle is
  running, not the old one).
- `ok:true`, `status:"ok"`, `store_ok:true`, `store.integrity.overall:"ok"`.

## Backup (do this before anything risky)

```bash
# Canonical: VACUUM INTO + integrity_check, idempotent (skips if unchanged).
# Dest lands in the backup dir as memory-<ISO-ts>.db.
node --import tsx --input-type=module -e \
  "import('@adhd/sox-memory-core').then(m => m.autoBackup().then(r => console.log(JSON.stringify(r))))"
```

For a **forced** backup (bypass idempotency — use when the user wants an explicit
fresh copy regardless of the marker):

```bash
node --import tsx --input-type=module -e '
import { backupStore, isBackupStoreError } from "@adhd/sox-memory-core";
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const dest = `/Users/nix/.memory/backups/memory-${ts}-manual.db`;
backupStore("/Users/nix/.memory/memory.db", dest, { log: console.error })
  .then(r => console.log(JSON.stringify({ dest, ok: !isBackupStoreError(r) })));
'
```

`backupStore` runs `VACUUM INTO` read-only against the source, then verifies the
copy with the integrity probe set (`pragma_integrity_check`, adapter_meta_unique,
btree_index_populated, fts_index_live, json_column_valid, json_empty_array_null)
and **deletes the copy on any failure**. It never touches the live process.

## Anti-patterns (what NOT to do)

| ❌ Don't | Why | ✅ Do |
|---|---|---|
| `kill <pid>` + `nohup soxe serve … &` | bypasses launchd, leaves orphaned serve proxies that respawn a backend, wrong lifecycle | `soxe service restart memory-server` |
| `sqlite3 ~/.memory/memory.db …` | standard SQLite vs Turso `-tshm` cross-engine WAL coordination can corrupt the store | `backupStore`/`autoBackup` (Turso engine) |
| `cp memory.db` while the server is live | inconsistent unless the WAL is checkpointed | `VACUUM INTO` (via `backupStore`) |
| `launchctl bootout …` to stop | exits 0 while the backend survives (verified-stop violation) | `soxe service disable` (reaps survivors) |

## Transport profiles (context)

| Profile | Launch | Lifecycle |
|---|---|---|
| `stdio` | `soxe serve memory-server` | per-session (dies with the session) |
| `sse` | `soxe service enable memory-server` | persistent launchd |
| `http` (the deployed one) | `soxe service enable memory-server` | persistent launchd, `http://localhost:3099/mcp` |

## Canonical verbs (recap)

- `soxe service enable <ext>` — generate + load the OS unit (reboot persistence).
- `soxe service restart <ext>` — **pure code deploy** (BL-372, verified rotation).
- `soxe service update <ext>` — config / node-path drift reconciliation.
- `soxe service status <ext>` — verify.
- `soxe service disable <ext>` — unload + remove + reap survivors.
- `soxe service list` — all sox-owned units.

## References

- `docs/spec/service-lifecycle.md` §9.4a/§9.5 — the `[inv:deploy-verified]` and
  zero-downtime proxy-mode backend semantics.
- `docs/reporting/memory/findings/2026-08-11-memory-server-recovery-confusions.md`
  — the failure modes this playbook exists to prevent.
