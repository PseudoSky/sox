---
name: "@libsql/client — C-based libSQL driver (alternative to @tursodatabase/database)"
topic: "tool-catalog"
tags: ["agent:approved", "database", "libsql", "sqlite", "c-library", "typescript", "alternative"]
summary: "@libsql/client (v0.17.4) is the C-based libSQL driver for TypeScript/JS. Unlike @tursodatabase/database (Rust rewrite), it uses the C-based libSQL fork of SQLite and works reliably on macOS for local file mode. Recommended as the local-development alternative when @tursodatabase/database fails with statfs errors."
importance: 6
---

name: @libsql/client
description: libSQL driver for TypeScript and JavaScript — uses the C-based libSQL fork of SQLite (not the Rust rewrite)
features:
  - SQLite compatible with libSQL extensions
  - Local file mode via connect("file:<path>") — works reliably on macOS
  - Remote libsql:// connection support (Hrana protocol)
  - Embedded replicas with sync support
  - Full TypeScript definitions
  - Cross-platform: Linux, macOS, Windows
  - Mature and battle-tested (libSQL has been in production longer than the Rust rewrite)
compatibility:
  - API is DIFFERENT from @tursodatabase/database — not a drop-in replacement
  - Uses @libsql/client package, not @tursodatabase/database
  - connect() returns a Client, not a Database
  - Statements via db.execute() not db.prepare().run()
  - Requires different import paths and API calls
  - The adapter code in store-adapter would need significant changes to support both APIs
quality_signals:
  weekly_downloads: 229214 (estimated — not directly fetched)
  last_update: 2026-07 (v0.17.4)
  license: MIT
  github_url: https://github.com/tursodatabase/libsql-client-ts
  docs_url: https://docs.turso.tech/sdk/ts/quickstart
data_quality: verified
metrics_source:
  version: "npm view @libsql/client version"
  description: "npm view @libsql/client description"
  keywords: "npm view @libsql/client keywords"
  repository: "npm view @libsql/client repository"

notes:
  - @libsql/client and @tursodatabase/database are DIFFERENT products from the same company (Turso)
  - libSQL is a C fork of SQLite with extensions; @tursodatabase/database is a Rust rewrite
  - Turso is investing primarily in the Rust rewrite going forward
  - Using @libsql/client for local dev and @tursodatabase/database for production would work but requires maintaining two code paths
  - The Rust rewrite is where all new feature development happens; libSQL is in maintenance mode
  - See: https://turso.tech/blog/we-will-rewrite-sqlite-and-we-are-going-all-in
