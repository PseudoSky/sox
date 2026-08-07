---
"@adhd/sox-vector-store": major
---

Breaking: `LanceDbVectorBackend` and `openLanceDbVectorStore` now require a `StoreAdapter`, not a
raw `better-sqlite3` handle.

BL-389 ("route `LanceDbVectorBackend` through `StoreAdapter`, not a raw sqlite handle") renamed a
required constructor-config property in `dist/lancedb.d.ts`:

```
-import type Database from 'better-sqlite3';
+import type { StoreAdapter } from '@adhd/sox-store-adapter';
...
     constructor(config: LanceDbVectorBackendConfig & {
-        db: Database.Database;
+        adapter: StoreAdapter;
     });
```

`dist/index.d.ts`'s `openLanceDbVectorStore` factory carries the identical rename in its config
parameter:

```
 export declare function openLanceDbVectorStore(config: LanceDbVectorBackendConfig & {
-    db: import('better-sqlite3').Database;
+    adapter: StoreAdapter;
 }): LanceDbVectorBackend & VectorBackend;
```

Both `db` and `adapter` are required (neither carries `?`). Code compiled against the published
`0.3.3` shape — `new LanceDbVectorBackend({ lancedbPath, db: myDb })` or
`openLanceDbVectorStore({ lancedbPath, db: myDb })` — fails to compile against this release on two
independent counts: `db` is now an excess/unknown property, and `adapter` is a missing required
property.

**Migration:** pass `adapter: StoreAdapter` instead of a raw `better-sqlite3` handle — construct
the adapter the same way `@adhd/sox-store-adapter`'s own consumers already do, then pass that
adapter into `LanceDbVectorBackend`'s constructor or `openLanceDbVectorStore`'s config in place of
the old `db` field.
