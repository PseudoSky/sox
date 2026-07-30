---
name: "@tursodatabase/database — Turso Database (Rust rewrite) for JavaScript"
topic: "tool-catalog"
tags: ["agent:approved", "database", "turso", "sqlite", "rust", "typescript"]
summary: "Turso Database npm package (v0.7.1). SQLite-compatible Rust rewrite. Local file open fails on macOS with 'statfs shared WAL coordination path: entity not found' error. Known macOS/APFS compatibility issues. Latest version as of 2026-07-27 is 0.7.1."
importance: 7
---

name: @tursodatabase/database
description: Turso Database npm package for JavaScript/TypeScript — an in-process SQL database rewritten from scratch in Rust, SQLite-compatible
features:
  - SQLite compatible (SQL dialect, file format, C API)
  - In-process embedded database — no network overhead
  - Cross-platform: Linux (x86_64, arm64), macOS, Windows
  - TypeScript support with full type definitions
  - Async I/O with io_uring on Linux
  - MVCC (BEGIN CONCURRENT) for improved write throughput
  - Multi-process WAL coordination via .tshm sidecar (experimental)
issues:
  - macOS local file open fails with "statfs shared WAL coordination path: entity not found" error
  - The error occurs when opening a local file via connect("file:<path>") — statfs() is called on the .tshm shared WAL coordination sidecar path before it exists
  - APFS cannot reliably back lseek(SEEK_DATA) for sparse file detection (confirmed in issue #7841)
  - Multi-process WAL (experimental_multiprocess_wal) fails on macOS with WAL file lock errors (issue #7340, #7346)
  - Marked as BETA — "may still contain bugs and unexpected behavior"
workarounds:
  - Ensure the parent directory of the database file exists before opening
  - Set LIMBO_DISABLE_FILE_LOCK env var to skip file locking (from common.rs: ENV_DISABLE_FILE_LOCK = "LIMBO_DISABLE_FILE_LOCK")
  - Use in-memory database (:memory:) which doesn't trigger the file system path check
  - Use @libsql/client (C-based libSQL fork) as an alternative for local file mode on macOS
  - Use remote url mode (libsql://) instead of local file mode
quality_signals:
  weekly_downloads: 36145
  last_update: 2026-07-22 (v0.7.1)
  license: MIT
  github_url: https://github.com/tursodatabase/turso
  docs_url: https://docs.turso.tech
data_quality: verified
metrics_source:
  weekly_downloads: "https://api.npmjs.org/downloads/point/last-week/@tursodatabase/database"
  version: "npm view @tursodatabase/database version"
  license: "npm view @tursodatabase/database license"
  repository: "npm view @tursodatabase/database repository"
