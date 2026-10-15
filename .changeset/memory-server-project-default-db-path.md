---
"@adhd/sox-extension-memory-server": minor
---

The project-scope default for `config.memory-server.db_path` changes from `~/.memory/memory-dev.db` to `~/.memory/memory.db`. `soxe install --scope project` now seeds the same store as user scope, so the separate dev store is no longer created by default. This is a behaviour change for new project-scope installs (hence `minor`); a `db_path` already set in any config scope is never overwritten, so existing installs keep their configured store until it is edited. The fail-closed rule is unchanged: the server still never infers a store path, and with no configured `db_path` every store tool returns `E_STORE_NOT_CONFIGURED`. Fixes e2302e94. To keep a separate dev store for project installs, set `config.memory-server.db_path` explicitly.
