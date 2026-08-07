---
"@adhd/sox-authoring": patch
---

Documentation/branding cleanup only — no consumer-observable type change.

`dist/index.d.ts`, `dist/templates/service/index.d.ts`, and `dist/writer.d.ts` differ from the
published `0.2.0` tarball, but every hunk is either a `sox` → `soxe` rebrand in a comment/docstring,
or a stale doc count fixed from "6 active types" to "7 active types". The exported type itself is
byte-identical to what's published: `` export type ActiveType = 'agent' | 'skill' | 'mcp-server' |
'hook' | 'command' | 'bundle' | 'service'; `` (`dist/index.d.ts:34`). Filed as patch rather than
skipped because this is comment/doc-only churn with zero surface delta — nothing for a consumer to
adapt to.
