# Context 04 — remote-first transport

**Execute:** read `../_shared/RULES.md` → `../_shared/CONTRACTS.md` →
`../_shared/PROTOCOL.md`, then this file, then ADR 0007 D4 and BACKLOG BL-146/148.
Worktree branch: `runtime-prod/04-transport-remote`. Log to `./progress.json`; finish
with `./REPORT.md`.

**Mission:** one writer process, N listeners — stdio + UDS + streamable HTTP bound
simultaneously, remote-first host configs that are URLs (not spawn commands), safe by
default. The owner's driver: remote clients survive backend restarts (the dev
live-reload loop), and host configs stop embedding npx/hardcoded paths.

**Depends on:** nothing for TR-1..TR-4. TR-5 (recommending remote as the default
profile) is your last item and should land after 03's ping-identity work exists in the
tree (rebase), since the acceptance test uses instance identity across restarts.

**Scope fence (may touch):** `libs/mcp-runtime/**`, `libs/install-engine/**` (host
config generation), `libs/host-registry/**` (claude/opencode mcpConfig),
`extensions/bundles/sox-memory-bundle/members/memory-server/**` (config_schema keys +
transport wiring). Nothing else.

## Items

| id | BL | Work | Acceptance | NC |
|---|---|---|---|---|
| TR-1 | 146 | Simultaneous multi-bind: the backend binds every transport in the `transports` config key (CONTRACTS §I) from ONE process — stdio (via shim as today), UDS proxy socket, streamable HTTP | one running backend answers a tool call on all three transports in one test run | yes |
| TR-2 | 146 | Bind/auth policy per CONTRACTS §I: `bind_address` default loopback; non-loopback (or `auth_token` set) → bearer required on every HTTP request; **refuse to start** when non-loopback is configured without a token | 401 on missing/wrong token; startup refusal test for tokenless `0.0.0.0`; loopback tokenless still works | yes — remove the startup guard → refusal test red |
| TR-3 | 148 | Ports from config truth: `http_port` (default 3000) read from the cascade by BOTH the listener and host-config generation; delete the literal `3000`s in install-engine/opencode host-registry; delete the `SOX_MCP_PORT ?? '0'` random-port default for installed services | install with `http_port=4111` → generated host-config URL says 4111 AND the listener binds 4111 (end-to-end test) | yes |
| TR-4 | 146 | Remote host-config generation: `soxe install <ext> --profile=http` writes `{type, url}` (no command/args) for claude + opencode, URL built from `bind_address`+`http_port`+path | generated config snapshot tests per host; BL-109-style install→uninstall round-trip still green | no |
| TR-5 | 146 | The owner's acceptance scenario, scripted: connect a REAL MCP client over HTTP via a URL-only config → kill and restart the backend → the client reconnects and completes a tool call **without any session reload**; then flip docs/profiles to recommend remote as default | the restart-survival test green ×3; docs updated | **yes — mandatory: run the same scenario over stdio and record that it CANNOT survive (red), proving the remote-first rationale** |

## Gate

TR-5 green ×3 with the stdio negative control recorded; unauthenticated non-loopback
bind impossible (TR-2 evidence); all mcp-runtime/install-engine/host-registry suites
green; a fresh install on each host (claude, opencode) produces a working URL config
with zero hardcoded paths.

## Subdispatch notes

Good candidates: config-snapshot test authoring per host; the HTTP auth middleware
tests; a verifier pass (own control: break token comparison → 401 test red). Keep TR-1's
multi-bind lifecycle (shutdown ordering across listeners: drain queue before closing)
and TR-5's scenario design yourself.
