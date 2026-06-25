---
"@adhd/sox-service-proxy": minor
"@adhd/sox-extension-memory-server": minor
---

Slice 1.6 — M3→M4 default flip: front-shim proxy is now the DEFAULT for `mcp-server`
services, and memory-server is flipped onto it with an auto-managed, singleton-guarded
UDS backend.

- `service-proxy`: new `ensureBackend` primitive — probe-then-spawn the backend detached,
  serialized by an O_EXCL spawn lock keyed on `[def:singleton-key]` (one backend per store,
  single-writer across many sessions' shims). `runFrontShim` gains an `ensure` hook (called
  on start + re-called on a dropped backend connection); `dialBackend` gains `onDisconnect`.
- `memory-server`: runs as a persistent UDS backend under `SOX_PROXY_BACKEND=1` (`runBackend`
  wrapping the existing `TOOLS`+`handleToolCall` with `serveBackend`); publishes
  `dist/schema.json` (generated postbuild) so the shim serves `initialize`/`tools/list`
  instantly during a backend restart. Direct-stdio `serve()` stays as the opt-out hatch.
- `cmdServe`: proxy default for `type: mcp-server`; explicit opt-out via `--no-proxy` /
  `lifecycle.serve_mode:"direct"` / `lifecycle.proxy:false` (CLI flag overrides manifest).
- Upgrade: a proxy-mode `mcp-server` upgrade rolling-restarts the BACKEND (verified-stop +
  re-ensure on new code) and reports `backend-restarted` — the shims re-dial, NO client
  reconnect. Migration: exactly ONE final reconnect to swap the direct server for the shim.
