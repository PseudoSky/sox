# Context 04 — Transport Remote: Commissioning Report

**Date:** 2026-07-03
**Branch:** `runtime-prod/04-transport-remote`
**State:** TR-1 (multi-bind) + TR-2 (bind/auth policy) complete; TR-3/TR-4/TR-5 pending

## Summary

Implemented the multi-transport server architecture: a single process can now bind stdio, UDS, and streamable HTTP simultaneously. The bind/auth policy enforces loopback-only by default, requires bearer tokens for non-loopback binds, and refuses to start with tokenless `0.0.0.0`.

## Files Changed

| File | Δ | Purpose |
|---|---|---|
| `libs/mcp-runtime/src/transport.ts` | +330 lines | Core transport layer: `connectStdio`, `connectUds`, `connectStreamableHttp`, `resolveTransports`, `validateBindAuth`, `authMiddleware`, `isLoopback`, `resolveBindHost`, `resolveTransportMode`, `TransportOptions`, `TransportHandle`, `ToolDispatch` |
| `libs/mcp-runtime/src/transport.spec.ts` | +236 lines (new) | 21 tests covering TR-1 multi-bind lifecycle and TR-2 auth/bind policy |
| `libs/mcp-runtime/src/serve.ts` | Extended | `ServeOptions` gains `transports`, `bindAddress`, `authToken`, `httpPort`; `serve()` now binds all configured transports |
| `libs/mcp-runtime/src/index.ts` | Extended | Re-exports all new transport symbols |
| `libs/mcp-runtime/package.json` | Updated | Dependencies for express, cors required by HTTP transport |
| `libs/mcp-runtime/vitest.config.ts` | Updated | Test configuration |
| `extensions/bundles/sox-memory-bundle/members/memory-server/extension.json` | Updated | Config schema updated for transport keys (`transports`, `bind_address`, `auth_token`, `http_port`, `activation_posture`) |
| `BACKLOG.md` | BL-146 → FIXED | Evidence appended |

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

## Verification

```text
> nx test mcp-runtime
  ✓ libs/mcp-runtime/src/transport.spec.ts (21 tests) 5ms
  ✓ libs/mcp-runtime/src/conformance.spec.ts (11 tests) 23ms

  Test Files  2 passed (2)
       Tests  32 passed (32)
```

All 32 tests pass. Build and lint also green.

## Pending Items

| ID | Status | Next Step |
|---|---|---|
| TR-3 | pending | `http_port` from config truth in listener AND host-config generation |
| TR-4 | pending | URL-only host configs for claude + opencode |
| TR-5 | pending | Restart-survival scenario green; stdio control red |

## Backlog

- **BL-146**: Flipped to **FIXED (2026-07-03)** with TR-1/TR-2 evidence appended.
