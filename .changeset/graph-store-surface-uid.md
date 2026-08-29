---
"@adhd/sox-graph-store": patch
---

Surface the stable node UUID as first-class identity. `NodeRecord` gains a
required `uid` field (the `node.uid` UUID column, previously generated but never
read back), and `GraphBackend` gains `getNodeByUid(uid)` to resolve a node by that
UUID. This makes the UUID the exportable, cross-store-stable identity a consumer
can expose — `id` (rowid) is per-store and changes across a rebuild/export, so it
is not a safe external reference. Additive: no existing write/read path changes.
