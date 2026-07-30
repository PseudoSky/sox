---
name: "SOX Store Adapter — @tursodatabase/database usage and macOS impact"
topic: "tool-catalog"
tags: ["use-case:reference", "sox", "store-adapter", "turso-adapter", "sqlite-adapter"]
summary: "SOX's store-adapter defaults to @tursodatabase/database (Turso Rust rewrite). On macOS, local file mode fails with statfs error. The factory at libs/data/store/store-adapter/src/factory.ts defaults STORE_ADAPTER to 'turso'. A switch to 'sqlite' (better-sqlite3) or upgrade to fix version is needed for macOS local development."
importance: 7
---

name: "SOX Store Adapter — Turso Database Usage and macOS Impact"
description: How the SOX store adapter uses @tursodatabase/database and the impact of the macOS statfs bug

current_implementation:
  - libs/data/store/store-adapter/src/factory.ts: defaults STORE_ADAPTER to 'turso' (line 19)
  - libs/data/store/store-adapter/src/turso-adapter.ts: wraps @tursodatabase/database
  - Local mode: connects via connect("file:<dbPath>") (line 92, 125)
  - Remote mode: uses url (libsql://) with authToken (line 121)
  - Experimental features: multiprocessWal can be passed (line 104-106)
  - The adapter also has a SqliteAdapter implementation using better-sqlite3

impact:
  - On macOS, creating a TursoAdapter with dbPath (local mode) will throw:
    "failed to open database file:<path>: I/O error (statfs shared WAL coordination path): entity not found"
  - This prevents local development and testing on macOS without either:
    a) Using remote libsql:// URL mode (requires Turso Cloud account)
    b) Switching to sqlite adapter (STORE_ADAPTER=sqlite)
    c) Setting LIMBO_DISABLE_FILE_LOCK=1
  - Production deployment on Linux is NOT affected — this is macOS-specific

migration_options:
  1. STORE_ADAPTER=sqlite: Switch factory default or env var to use better-sqlite3 instead
     - PRO: Works reliably on macOS, shared-nothing local file
     - CON: Loses Turso-specific features (MVCC, sync, encryption)
     - CON: Different API surface (synchronous vs async)

  2. Use remote libsql:// mode on macOS:
     - PRO: No filesystem issue (network connection)
     - CON: Requires Turso Cloud or local sqld server
     - CON: Requires internet connection

  3. Set LIMBO_DISABLE_FILE_LOCK=1:
     - PRO: Simple env var workaround
     - CON: Disables all file locking — unsafe for multi-process access
     - CON: Not officially documented

  4. Pre-create the database directory:
     - PRO: Addresses the ENOENT root cause
     - CON: Doesn't help if statfs fails for other reasons (APFS edge cases)

  5. Wait for Turso to fix the issue in a future version:
     - PRO: No code changes needed
     - CON: Timeline unknown — v0.7.1 latest, no fix pending

data_quality: verified
type: production-implementation
references:
  - factory.ts: https://github.com/nix/sox-ecosystem/blob/main/libs/data/store/store-adapter/src/factory.ts
  - turso-adapter.ts: https://github.com/nix/sox-ecosystem/blob/main/libs/data/store/store-adapter/src/turso-adapter.ts
