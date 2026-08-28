# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in sox-ecosystem, please report it privately rather than
opening a public issue.

- **Email:** report via the repository's private security advisory (GitHub → Security → Report a
  vulnerability), or contact the maintainer directly.
- **Do not** open a public issue or PR disclosing the vulnerability before it is fixed.

## Scope

Security-relevant surfaces include (but are not limited to):

- The `memory-server` MCP server (tool input validation, SQLite store access).
- The `mcp-runtime` / `service-proxy` transports (stdio ↔ UDS, transport security).
- `tokenguard-core` (tokenization/detokenization) and `claim-verification` (NLI grounding).
- The `install-engine` (extension installation path, provider capability checks).

## Response

- We aim to acknowledge reports within 5 business days and provide a fix or mitigation within 30 days.
- Fixed vulnerabilities will be disclosed in the CHANGELOG and, where warranted, via a GitHub
  Security Advisory.
