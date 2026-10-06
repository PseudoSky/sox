---
"@adhd/sox-graph-store": patch
---

Add a bounded, page-keyed edge read: `getEdges({ srcs, dsts, rels })` (also on the tx-scoped `tx.getEdges`), plus the exported `IEdgeQuery` type and `EDGE_READ_CHUNK` / `EDGE_READ_MAX_RELS` constants (89cc3a30).

`getEdges({ rel })` scans every live edge of the relation (no `rel`-leading index). The new batch forms read only the
edges incident to a page of node ids via `ix_edge_src_live` / `ix_edge_dst_live`, ordered `(src|dst, rel, rowid)`, chunked so no statement
binds more than 500 variables in total (ids, `rels` and filters; `rels` is capped at 64 distinct values). `srcs` + `dsts` is linear (one axis chunked), ordered `(src, rel, rowid)`; NaN / non-finite / non-integer / negative ids throw `ConstraintError`. Existing single-key forms are byte-for-byte unchanged. No schema change.

Shipped as a patch under the PUBLISHING.md "Patch-for-additive-API exception (owner-accepted)": the change is purely additive (new optional query keys, one new exported type and two new constants; no existing call site or exported type changes), and a minor bump on this 0.x package would break every `workspace:^` dependent range and cascade a republish.
