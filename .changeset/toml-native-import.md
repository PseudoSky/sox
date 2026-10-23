---
'@adhd/sox-install-engine': patch
---

The TOML config merge (codex `config.toml`) loads `@decimalturn/toml-patch` with a native `import()`. The lib now builds with `module: Node16`, so the ESM-only package loads on every supported Node instead of failing the CommonJS build. `parseToml`, `stringifyToml`, and the config read/write helpers are now async.
