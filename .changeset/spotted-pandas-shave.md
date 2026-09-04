---
'@adhd/sox-embedding-provider': minor
'@adhd/sox-store-adapter': minor
'@adhd/sox-host-registry': minor
'@adhd/sox-host-runtime': minor
'@adhd/sox-install-engine': minor
'@adhd/sox-manifest': minor
'@adhd/sox-memory-core': minor
'@adhd/sox-telemetry': minor
'@adhd/sox-service-proxy': minor
---

Public API surface changed since the last publish.

Each of these packages has `dist/*.d.ts` differing from the version currently on
npm, with no changeset recording it — the drift the `check-changeset-surface` gate
exists to catch. This changeset records it and ships the accumulated surface.

The READMEs shipped alongside are rewritten and verified: every documented symbol
is checked against that package's own built declarations, and every example is one
that was executed against the built artifact.

`@adhd/sox-memory-core` also corrects three source comments that asserted ADR-0007's
single-writer architecture as current fact. ADR-0012 supersedes it — the default
Turso backend runs `multiprocess-wal`, where multiple processes hold concurrent
write connections to one store file, serialized through a `-tshm` coordinator, with
no opt-out. Because those comments are emitted into the shipped `.d.ts`, the false
claim was visible in consumers' editor tooltips.
