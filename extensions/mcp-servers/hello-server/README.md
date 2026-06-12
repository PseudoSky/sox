# Hello Server

> Use this when you need a minimal MCP server reference to verify stdio JSON-RPC wiring or template a new tool.

## Overview

`hello-server` is the canonical reference MCP server in the sox-ecosystem. It speaks the Model Context Protocol over stdio (one JSON-RPC request per line, one JSON response per line) and exposes a single stub tool — `example_tool` — that accepts a `query` string and returns the hard-coded text `"stub response"`.

Its sole purpose is to prove the mcp-server extension type wires correctly: the host can discover the tool via `tools/list`, call it via `tools/call`, and receive a well-formed MCP response. Nothing beyond that.

## When to use

- When you need a real MCP server installed to smoke-test host-side MCP client code.
- When you want a copy-paste scaffold for a new MCP server with the stdio transport already wired.
- When writing integration tests that need an MCP server present but do not depend on real tool behaviour.

Do NOT use this server in production — `example_tool` always returns a stub string regardless of input.

## Tools

| Tool name      | Description                   | Required inputs  | Returns                     |
| -------------- | ----------------------------- | ---------------- | --------------------------- |
| `example_tool` | Stub tool demonstrating wiring | `query` (string) | `"stub response"` (text)   |

## Transport

stdio — one JSON-RPC request per line, one JSON response per line. Implements `tools/list` and `tools/call`. Unsupported methods return `{error: {code: -32601, message: "Method not found"}}`.

## Usage

```bash
sox install hello-server
```

## Development

```bash
pnpm install
pnpm build
# Start the server:
node dist/index.js
# In another shell, send a tools/list request:
echo '{"method":"tools/list","id":1}' | node dist/index.js
```

## License

MIT
