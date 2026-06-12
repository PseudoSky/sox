# Hello Server — LLM Guidance

## Purpose

Use this when you need a minimal MCP server reference to verify stdio JSON-RPC wiring — exposes one stub tool (`example_tool`) over a stdio transport that always returns `"stub response"`.

## When to call tools from this server

Call tools from `hello-server` when:
- You are testing that the MCP client/host correctly discovers tools via `tools/list` and invokes them via `tools/call`.
- You need any MCP server present to satisfy a test fixture, but do not care about the tool's output.

Do NOT call `example_tool` in production flows — it always returns the same hard-coded string regardless of the `query` input.

## Available tools

### `example_tool`

**Description:** A stub tool for hello-server — accepts a query and returns a fixed stub response.

**Input:**
```json
{ "query": "<any string>" }
```

**Output:** Plain text — always `"stub response"`.

**When to use:** Only in tests or scaffold verification where a real MCP tool response is needed but content does not matter.

**When NOT to use:** Any scenario where the tool's output influences downstream logic.

## Error handling

Unsupported methods return:
```json
{ "error": { "code": -32601, "message": "Method not found" } }
```

Malformed JSON input causes the server to respond with `{ "error": "<parse error message>" }`.

## Transport

stdio — one JSON-RPC request per line, one JSON response per line.

Supported methods: `tools/list`, `tools/call`. All others return method-not-found.

## Server id

`hello-server`
