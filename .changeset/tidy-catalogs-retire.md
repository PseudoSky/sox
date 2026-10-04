---
"@adhd/sox-install-engine": patch
---

Retire an agent-mcp catalog row by the name it was created with, not the extension id (6a10f744).

A row is named from the rendered agent IR `name` (`override.name ?? ir.name`), which can differ
from the manifest id — e.g. ext `memory-org` creates row `org-agent`. Apply now records that row
name in the ledger action and `reverse` deletes by it; `findLocalExtension` also matches the IR
name so `soxe reconcile-agent-mcp` can heal such a row instead of reporting
`skipped: no-local-manifest`.
