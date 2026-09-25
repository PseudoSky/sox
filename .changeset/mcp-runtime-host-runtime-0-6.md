---
'@adhd/sox-mcp-runtime': patch
---

Accepts `@adhd/sox-host-runtime` 0.6. mcp-runtime declares host-runtime as a
`workspace:^` runtime dependency, and `^0.5.0` does not admit the 0.6.0 minor,
so this release moves the published range to `^0.6.0`. There is no source
change. mcp-runtime imports only `Policy` and `compilePolicyFromEnv` from
host-runtime, and neither changed in 0.6.0.
