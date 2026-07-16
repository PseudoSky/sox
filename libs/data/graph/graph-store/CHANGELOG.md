# @adhd/sox-graph-store

## 0.3.0

### Minor Changes

- `writeNode()`'s `kind` parameter is now actually reachable through the public API: `NodeMeta.kind`, `NodeRecord.kind`, and `NodeFilter.kind` are first-class (previously `kind` was hardcoded to `'episode'` on every write, so a caller could never write `kind:'generic'` even though that value already sat in the `node.kind` CHECK constraint's enum). `kind` defaults to `'episode'` and is validated against the fixed `DEFAULT_NODE_KINDS` enum (`episode`/`entity`/`claim`/`community`/`session`/`generic`) — an out-of-enum kind throws `ConstraintError`. The CHECK constraint itself is never extended per consumer; non-memory reuse (e.g. a component registry) writes `kind:'generic'` and carries its own sub-kind in `tags`/`metadata` (BL-295). `NodeFilter` also gained `projectPath`/`agentId` for filtering on those previously-unfilterable indexed columns.
