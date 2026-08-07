---
"@adhd/sox-graph-store": major
---

Breaking: `EdgeRel` widened to accept arbitrary strings; the SQL `rel` CHECK constraint is gone
from fresh-store DDL.

`dist/index.d.ts`'s `EdgeRel` declaration (BL-448/PKT-74) changed from a closed 10-member union to
a branded-string widening:

```
-export type EdgeRel = 'MENTIONS' | 'SUPPORTS' | 'RELATES_TO' | 'DERIVED_FROM' | 'SUPERSEDES' | 'SAME_AS' | 'ASSIGNED_TO' | 'MEMBER_OF' | 'PART_OF' | 'DEPENDS_ON';
+export type EdgeRel = 'MENTIONS' | 'SUPPORTS' | 'RELATES_TO' | 'DERIVED_FROM' | 'SUPERSEDES' | 'SAME_AS' | 'ASSIGNED_TO' | 'MEMBER_OF' | 'PART_OF' | 'DEPENDS_ON' | (string & {});
```

The package's own in-tree JSDoc directly above this declaration states this is "source-breaking
in RETURN position, not additive: a consumer that exhaustively `switch`es on `EdgeRecord.rel` (or
otherwise narrows `EdgeRel` to `never` in a default arm) stops compiling once this widens, because
the `default` arm's type is no longer `never` — it is `string & {}`" and cites
`open-rel-check.bl448.spec.ts`'s `AC-Type` as having demonstrated the compile break, not merely
asserted it. A consumer exhaustively switching on `EdgeRecord.rel`'s ten known members with a
`default: assertNever(rel)` idiom will no longer compile against this release.

Additive, not independently bump-worthy (subsumed by the major above): `GraphBackendOpts` (new
optional interface, `typePolicy?: TypePolicy`), and both `constructor(adapter: StoreAdapter, opts?:
GraphBackendOpts)` and `createGraphBackend(adapter, opts?)` gaining an optional trailing parameter
— existing single-argument call sites still compile.

Not reflected in this bump, named for changelog completeness: the inline SQL
`CHECK ("rel" IN (...))` / `CHECK ("kind" IN (...))` constraints were dropped from
`INLINE_MIGRATION_DDL` (BL-439/BL-448's DDL-open work). Fresh stores no longer enforce the closed
vocabulary at the SQL layer — a `TypePolicy` (see `DEFAULT_TYPE_POLICY`'s new docstring) is the
sole remaining gate. This is a real behavioral change but is invisible to a `.d.ts` diff:
`INLINE_MIGRATION_DDL`'s declared type stays `string` before and after (only its literal value
changed), and the DDL is inline SQL text, not a TS type.
