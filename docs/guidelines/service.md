# service — Per-type Authoring Contract

> **Extension type:** `service`
> **Role:** Role A (process) — long-running, sox-supervised background extension.

---

## Overview

A `service` extension is a supervised, continuously-running background process that exposes one or more transports. It is the foundation for HTTP proxies, socket servers, and any extension that must be addressable by network or IPC at a stable endpoint.

Unlike `mcp-server` (which is protocol-bound to the MCP stdio wire format), a `service` is transport-agnostic — it declares what transports it listens on and the runtime routes accordingly.

---

## When to use `service` vs `mcp-server`

| Criterion | `mcp-server` | `service` |
|-----------|-------------|-----------|
| Wire protocol | MCP JSON-RPC over stdio | Any (HTTP REST, SSE, socket, stdio) |
| Transport vocabulary | `stdio`, `sse`, `http` | `stdio`, `http`, `sse`, `socket` |
| Health probe | stdio-ping | http-get (default) or stdio-ping |
| Use case | Tool/resource provider for LLM clients | Proxy, daemon, API gateway, long-running worker |
| Future fold-in | mcp-server → service[transport=stdio] (deferred) | First-class primitive |

**Choose `service` when:**

- Your extension is not a MCP tool server (no `ListTools`/`CallTool` handlers).
- You need an HTTP or socket transport.
- You are building a proxy, interceptor, or gateway that other extensions or the host call.
- You want a richer health-check model (`http-get` vs stdio-ping).

**Choose `mcp-server` when:**

- You are implementing the MCP protocol and want LLM clients to discover your tools automatically.
- Your transport is `stdio` only.

---

## Transports

The `transports` array in `install` declares how the service is reached. Vocabulary:

| Value | Description |
|-------|-------------|
| `http` | HTTP/1.1 REST — service binds a port; supervisor probes `/_<id>/health` |
| `stdio` | JSON-RPC over stdin/stdout — supervisor uses stdio-ping health probe |
| `sse` | Server-sent events over HTTP — service binds a port |
| `socket` | Unix domain socket — service creates a socket file |

Rules:

- **At least one transport is required** for `type:service`. validate() rejects a service with no transports.
- Transport values are constrained to the vocabulary above. validate() rejects unknown values.
- `profiles` keys must be a subset of `transports` (or `serves` if also declared). validate() enforces `profiles ⊆ {transports∪serves}`.
- `serves` is accepted as a back-compat alias for `transports` when values overlap with the mcp vocabulary (`stdio|sse|http`). Prefer `transports` for new service extensions.

---

## Lifecycle

The `lifecycle` block controls supervision:

```jsonc
{
  "lifecycle": {
    "background": true,
    "singleton": true,        // one process per install
    "stop_timeout_ms": 5000,  // SIGTERM → wait → SIGKILL
    "health": {
      "type": "http-get",     // or "stdio-ping" for stdio transport
      "endpoint": "http://127.0.0.1:${PORT}/_myservice/health",
      "interval_ms": 30000,
      "timeout_ms": 5000
    }
  }
}
```

### Health probes

| `health.type` | When to use | `endpoint` required? |
|---------------|-------------|----------------------|
| `http-get` | HTTP or SSE transport | Yes — full URL including port |
| `stdio-ping` | stdio transport | No |
| `socket` | Unix socket ping | Yes — socket path |
| `command` | Custom probe command | Yes — command string |

For `http-get`: endpoint must be a full URL. The port is typically passed via `SOX_CONFIG_PORT` (or a fixed default). Use the template pattern `http://127.0.0.1:${PORT:-8080}/_<id>/health`.

---

## Configuration

Configuration flows through `config_schema` (`x-sox-prompt`/`x-sox-default`) → `soxe install` prompt → `SOX_CONFIG_*` env vars at spawn time. Do not read config files directly.

Example:

```jsonc
{
  "config_schema": {
    "type": "object",
    "additionalProperties": false,
    "required": [],
    "properties": {
      "port": {
        "type": "string",
        "x-sox-prompt": "Port for myservice to listen on:",
        "x-sox-default": "8080"
      }
    }
  }
}
```

At runtime: `const port = process.env['SOX_CONFIG_PORT'] ?? '8080';`

---

## Supervision model

- `soxe start --id=<service-id>` spawns the service and registers it with the supervisor.
- The supervisor emits SIGTERM on `soxe stop`, waits `stop_timeout_ms`, then SIGKILL.
- The service must handle SIGTERM cleanly (drain in-flight requests, close the port, exit 0).
- `soxe list` and `soxe details` show the running state, pid, and scope.

### Signal contract

```ts
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { server.close(() => process.exit(0)); });
```

---

## Operator warning — concurrent start is a deferred non-goal

> **WARNING:** Starting the same service twice simultaneously (two concurrent `soxe start --id=<service-id>`) is **not** protected by the current runtime and may result in port conflicts, split supervisor state, or duplicate processes.
>
> Concurrent-start safety is scoped to the `runtime-productionization` plan. Until that plan lands, operators must ensure only one `soxe start` of a given service runs at a time. The `singleton: true` lifecycle flag is advisory at the manifest level; the supervisor does not yet enforce it as a hard lock against concurrent starts.

---

## Permissions

Declare all resource access in `permissions`. The runtime enforces declared permissions at the resource sink.

```jsonc
{
  "permissions": {
    "network": { "outbound": ["https://api.example.com"] },
    "fs": { "read": ["${HOME}/.config/myservice"] },
    "socket": { "paths": ["/tmp/myservice.sock"] }
  }
}
```

---

## Scaffolding

```bash
soxe init service my-proxy
# With explicit transport:
soxe init service my-proxy --transport=http
# Multi-transport:
soxe init service my-proxy --transports=http,sse
```

The scaffold emits:

- `extension.json` — born-conformant manifest with `type:service`, `transports`, lifecycle, `config_schema`
- `package.json`, `tsconfig.json`
- `src/index.ts` — HTTP server stub (or stdio stub for `--transport=stdio`)
- `dist/index.js` — pre-compiled stub so `soxe validate` passes entrypoint-reachability immediately
- `CHANGELOG.md`, `README.md`

After scaffolding, `soxe validate` passes without any manual edits.

---

## Install descriptor shape

```jsonc
{
  "install": {
    "type": "service",
    "transports": ["http"],
    "serves": ["http"],
    "profiles": {
      "http": { "transport": "http" }
    },
    "hosts": ["claude"]
  }
}
```

`hosts` is optional; the engine resolves target paths from `libs/host-registry` at install time. No literal `~/.claude/` paths in the manifest. [ref:host-keyed-target]
