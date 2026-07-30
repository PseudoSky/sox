---
name: "Turso Database statfs() macOS Bug — Root Cause and Workarounds"
topic: "tool-catalog"
tags: ["pattern:recommended", "bug-analysis", "macos", "turso", "filesystem"]
summary: "The statfs shared WAL coordination path error occurs because Turso's Rust rewrite calls statfs() to validate the filesystem type for shared WAL coordination before the .tshm sidecar path exists. On macOS APFS this fails if the directory doesn't exist. Workaround: pre-create the directory, disable file locking, or use @libsql/client."
importance: 7
---

name: "Turso Database macOS statfs Bug — Root Cause and Workarounds"
description: Analysis of the "statfs shared WAL coordination path: entity not found" error on macOS when using @tursodatabase/database with local file mode.

root_cause:
  - Turso's Rust rewrite uses statfs() to verify the filesystem type when opening a database file (to reject unsupported filesystems like NFS, CIFS for shared WAL coordination)
  - The statfs() call is made on the directory path where the .tshm (Turso Shared Memory) sidecar file would be created
  - If the database file's parent directory doesn't exist, or the path computation produces a non-existent prefix, statfs() returns ENOENT ("entity not found")
  - This code path is triggered even in single-process mode — not just when experimental_multiprocess_wal is enabled
  - The .tshm sidecar is the "shared WAL coordination" mechanism documented in the multi-process access docs

code_context:
  - core/io/unix.rs: UnixIO::open_file() calls lock_file() which acquires file locks
  - core/storage/shared_wal_coordination.rs: 4152-line file implementing the shared WAL coordination protocol
  - core/io/common.rs defines ENV_DISABLE_FILE_LOCK = "LIMBO_DISABLE_FILE_LOCK" — a skip-file-locking escape hatch
  - core/io/unix.rs: unix_shared_wal_map() uses libc::mmap, unix_shared_wal_lock_byte() uses libc::fcntl with F_SETLK/F_SETLKW
  - The supports_shared_wal_coordination() method in UnixIO returns true

known_workarounds:
  1. Set LIMBO_DISABLE_FILE_LOCK=1 environment variable to skip file locking entirely
  2. Pre-create the parent directory for the database file before connecting
  3. Use :memory: in-memory database instead of file path
  4. Use @libsql/client (C-based libSQL fork) as alternative for local macOS development
  5. Use remote libsql:// URL instead of local file
  6. Downgrade to v0.4.4 (the last version before the Rust rewrite) — but this is the old @libsql/client API so requires different code

fix_status:
  - No published fix as of v0.7.1 (latest, 2026-07-22)
  - v0.8.0-pre.1 is available as pre-release but CHANGELOG doesn't mention statfs fix
  - Issue #7841 ("Partial sync silently unavailable on macOS") is the closest tracked issue
  - Issue #7340 and #7346 report related multi-process WAL locking failures on macOS
  - The turso team is aware of macOS APFS compatibility issues generally

references:
  - Issue #7841: https://github.com/tursodatabase/turso/issues/7841
  - Issue #7340: https://github.com/tursodatabase/turso/issues/7340
  - Issue #7346: https://github.com/tursodatabase/turso/issues/7346
  - Multi-Process Access docs: https://docs.turso.tech/sql-reference/multiprocess-access
  - Source: core/io/unix.rs: https://github.com/tursodatabase/turso/blob/main/core/io/unix.rs
  - Source: core/io/common.rs: https://github.com/tursodatabase/turso/blob/main/core/io/common.rs
data_quality: verified
type: bug-analysis
