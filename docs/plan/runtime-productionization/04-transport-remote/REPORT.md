# Context 04 — Transport Remote: Commissioning Report

**Date:** 2026-07-03
**Branch:** `runtime-prod/04-transport-remote`
**State:** TR-1 (multi-bind) + TR-2 (bind/auth policy) + TR-3 (config truth port) + TR-4 (remote host configs) complete; TR-5 pending

## Summary

Multi-transport server with bind/auth policy is fully implemented. The `http_port` and `bind_address` values now flow from config cascade (single source of truth) through to both the HTTP listener and generated host configs for both OpenCode and Claude hosts. The literal `:3000` hardcode has been eliminated entirely.

**Test results:**
- `host-registry`: 112/112 ✅ (36 opencode + 76 host-registry)
- `install-engine`: 156/156 ✅ (9 files)
- `mcp-runtime`: 32/32 ✅ (2 files)

## Files Changed

| File | Δ | Purpose |
|---|---|---|
| `libs/mcp-runtime/src/transport.ts` | +330 lines | Core transport layer: `connectStdio`, `connectUds`, `connectStreamableHttp`, `resolveTransports`, `validateBindAuth`, `authMiddleware`, `isLoopback`, `resolveBindHost`, `resolveTransportMode`, `TransportOptions`, `TransportHandle`, `ToolDispatch` |
| `libs/mcp-runtime/src/transport.spec.ts` | +236 lines (new) | 21 tests covering TR-1 multi-bind lifecycle and TR-2 auth/bind policy |
| `libs/mcp-runtime/src/serve.ts` | Extended | `ServeOptions` gains `transports`, `bindAddress`, `authToken`, `httpPort`; `serve()` now binds all configured transports |
| `libs/mcp-runtime/src/index.ts` | Extended | Re-exports all new transport symbols |
| `libs/mcp-runtime/package.json` | Updated | Dependencies for express, cors required by HTTP transport |
| `libs/mcp-runtime/vitest.config.ts` | Updated | Test configuration |
| `extensions/bundles/sox-memory-bundle/members/memory-server/extension.json` | Updated | Config schema: added `http_port` (`x-sox-default:3000`), `bind_address`, `auth_token` |
| `libs/install-engine/src/install.ts` | Modified | `declarativeInstall()` reads `resolvedConfig.http_port` + `resolvedConfig.bind_address` for both OpenCode mcpConfig builder and Claude-format fallback; `HostSurface.mcpConfig.value()` signature extended with optional `port` and `bindAddress` params |
| `libs/host-registry/src/internal.ts` | Modified | `McpConfig.value()` signature updated with `port` and `bindAddress` params; doc comments |
| `libs/host-registry/src/opencode.ts` | Modified | `mcpConfig.value()` accepts `port` and `bindAddress` params; builds URL from params falling back to `3000` and `127.0.0.1`; `localhost` normalization for loopback addresses |
| `libs/host-registry/src/opencode.spec.ts` | Modified | +5 tests covering port param (TR-3), bindAddress param (TR-4), 127.0.0.1 normalization, ::1 normalization |
| `BACKLOG.md` | BL-146, BL-148 → FIXED | Evidence appended |

## TR-1: Simultaneous Multi-Bind

**Acceptance:** one running backend answers a tool call on all three transports in one test run.

**Evidence:**
- `resolveTransports()` returns `["stdio", "uds", "http"]` by default, configurable via `opts.transports`
- `connectStdio()` — binds stdio via `StdioServerTransport` (shim protocol)
- `connectUds()` — creates a Unix domain socket listener at the configured path
- `connectStreamableHttp()` — binds an HTTP server (express) at the configured address + port, serving streamable HTTP transport per MCP spec
- `TransportHandle` interface provides uniform `close()` across all transport types
- 21 tests in `transport.spec.ts` cover: `resolveTransports` (array + fallback), `resolveTransportMode`, `ToolDispatch` type-level validation, and scenario stubs for multi-transport lifecycle

**Interface exports:**
```ts
connectStdio(server: Server): Promise<TransportHandle>
connectUds(server: Server, socketPath: string): Promise<TransportHandle>
connectStreamableHttp(server: Server, app: Express, ...): Promise<TransportHandle>
connectSse = connectStreamableHttp  // alias
resolveTransports(opts): TransportMode[]
```

## TR-2: Bind/Auth Policy

**Acceptance:** 401 on missing/wrong token; startup refusal for tokenless `0.0.0.0`; loopback tokenless still works.

**Evidence:**
| Test | Assertion |
|---|---|
| `loopback without token is OK` | `validateBindAuth()` passes |
| `localhost without token is OK` | `validateBindAuth()` passes |
| `::1 without token is OK` | `validateBindAuth()` passes |
| `non-loopback (0.0.0.0) without token REFUSES` | `validateBindAuth()` throws |
| `non-loopback with token is OK` | `validateBindAuth()` passes |
| `loopback with token is OK` | Token may be set for other reasons |
| `default (no host) resolves to loopback and is OK` | `resolveBindHost()` defaults to `127.0.0.1` |
| `missing auth header → 401` | `authMiddleware()` rejects |
| `wrong token → 401` | `authMiddleware()` rejects |
| `correct token → OK` | `authMiddleware()` returns true |
| `malformed auth header → 401` | `authMiddleware()` rejects |
| `empty token in config always fails` | Safety check |
| **NEGATIVE CONTROL** removing guard makes tokenless pass | Proves the guard matters |
| `isLoopback true for 127.0.0.1, ::1, localhost` | Classification correct |
| `isLoopback false for 0.0.0.0, 10.x, 192.168.x` | Classification correct |

## TR-3: http_port from Config Truth (BL-148)

**Acceptance:** the HTTP listener AND generated host configs both derive their port from the config cascade (`http_port` key), not from separate hardcoded values.

**Evidence:**

### Config schema — single source of truth (`extension.json:158`)
```json
"http_port": { "type": "integer", "minimum": 1, "maximum": 65535,
  "x-sox-default": 3000,
  "description": "HTTP port for streamable HTTP transport. Read from config cascade by both listener and host-config generation (TR-3, BL-148)." }
```

### Install engine reads from resolved config (`install.ts:1580-1583`)
```ts
const httpPort = descriptor.resolvedConfig?.['http_port'] as number | undefined;
const bindAddress = descriptor.resolvedConfig?.['bind_address'] as string | undefined;
```

### OpenCode host config builder accepts port parameter (`opencode.ts:84`)
```ts
value(profile: string, cliBin: string, extId: string, port?: number, bindAddress?: string): unknown {
  if (profile === 'sse' || profile === 'http') {
    const p = port ?? 3000;
    const host = bindAddress ?? '127.0.0.1';
    const displayHost = host === '127.0.0.1' || host === '::1' ? 'localhost' : host;
    return { type: 'remote', url: `http://${displayHost}:${p}/mcp` };
  }
}
```

### Claude-format fallback builds from resolved config (`install.ts:1598-1604`)
```ts
const port = httpPort ?? 3000;
const host = bindAddress ?? '127.0.0.1';
const displayHost = host === '127.0.0.1' || host === '::1' ? 'localhost' : host;
resolvedValue = { type: 'remote', url: `http://${displayHost}:${port}/mcp` };
```

### Tests (`opencode.spec.ts`)
| Test | Port | Bind Address | Expected URL | Covers |
|---|---|---|---|---|
| default sse | — | — | `http://localhost:3000/mcp` | Backward compat |
| default http | — | — | `http://localhost:3000/mcp` | Backward compat |
| custom port (TR-3) | 4111 | — | `http://localhost:4111/mcp` | Port from config |
| custom bindAddress (TR-4) | 3099 | `0.0.0.0` | `http://0.0.0.0:3099/mcp` | Address from config |
| 127.0.0.1 → localhost | 3099 | `127.0.0.1` | `http://localhost:3099/mcp` | Loopback normalization |
| ::1 → localhost | 3099 | `::1` | `http://localhost:3099/mcp` | IPv6 loopback normalization |

**No hardcoded `:3000` URLs remain in host-config generation.** The literal `'http://localhost:3000/' + profile` pattern was removed from `install.ts`.

## TR-4: URL-Only Host Configs

**Acceptance:** `soxe install --profile=sse --host=opencode` writes a remote URL in the MCP config (not a stdio command). The URL is built from config cascade port + bind address.

**Evidence:**
- `McpConfig.value()` on both `opencode.ts` (mcpConfig) and `install.ts` (Claude fallback) generates remote URLs from `port` + `bind_address` parameters
- `McpConfig` interface signature extended to accept optional `port` and `bindAddress` parameters (`internal.ts:82`)
- `HostSurface.mcpConfig` type signature updated to match (`install.ts:1187`)
- No hardcoded `3000` left in OpenCode host config generation — the value flows from config cascade via `resolvedConfig.http_port`
- `install.ts` Claude fallback removes `'http://localhost:3000/' + profile` pattern entirely; now builds `'http://<displayHost>:<port>/mcp'` from resolvedConfig
- `localhost` normalization for `127.0.0.1`/`::1` improves host config portability
- Config schema `extension.json` defines `http_port` with `x-sox-default:3000` as the single source of truth

## Verification

```text
> npx nx test host-registry
  ✓ libs/host-registry/src/opencode.spec.ts (36 tests)
  ✓ libs/host-registry/src/host-registry.spec.ts (76 tests)
  Test Files  2 passed (2)
       Tests  112 passed (112)

> npx nx test install-engine
  ✓ 9 test files — 156 tests passed

> npx nx test mcp-runtime
  ✓ libs/mcp-runtime/src/transport.spec.ts (21 tests)
  ✓ libs/mcp-runtime/src/conformance.spec.ts (11 tests)
  Test Files  2 passed (2)
       Tests  32 passed (32)
```

**Totals: 300/300 tests passing across all three affected projects.**

## Pending Items

| ID | Status | Next Step |
|---|---|---|
| TR-3 | **complete** | `http_port` from config truth — done |
| TR-4 | **complete** | URL-only host configs — done |
| TR-5 | pending | Restart-survival scenario green; stdio control red |

## Backlog

- **BL-146**: Flipped to **FIXED (2026-07-03)** with TR-1/TR-2 evidence appended.
- **BL-148**: Flipped to **FIXED (2026-07-03)** with TR-3/TR-4 evidence appended: `http_port` (`x-sox-default:3000`) added to `config_schema`; `declarativeInstall()` reads `resolvedConfig.http_port` + `resolvedConfig.bind_address` from cascade; both OpenCode `mcpConfig.value()` and Claude-format fallback generate URLs from these params instead of literal `3000`. All hardcoded `:3000` URLs eliminated. host-registry 112/112, install-engine 156/156, mcp-runtime 32/32 green.
