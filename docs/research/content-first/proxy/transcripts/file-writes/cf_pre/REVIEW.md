1: # Review Report — BUG-WORKSPACE-GEN-006
2: 
3: ```json
4: {
5:   "$schema": "review-report-v1",
6:   "reviewer": "review",
7:   "reviewed_at": "2026-08-03T19:30:00Z",
8:   "files_reviewed": [
9:     "packages/workspace/workspace-codegen-nx/src/generators/shared/generator.ts",
10:     "packages/workspace/workspace-codegen-nx/src/generators/base/generator.spec.ts",
11:     "packages/workspace/workspace-codegen-nx/src/generators/plugin/generator.spec.ts",
12:     "packages/workspace/workspace-codegen-nx/CHANGELOG.md",
13:     "ACCEPTANCE.md",
14:     "SPEC.md"
15:   ],
16:   "verification": {
17:     "build": "passed",
18:     "test": { "passed": 17, "failed": 0 },
19:     "gitnexus_impact_checked": false
20:   },
21:   "findings": [
22:     {
23:       "severity": "info",
24:       "category": "test-coverage",
25:       "file": "packages/workspace/workspace-codegen-nx/src/generators/plugin/generator.spec.ts",
26:       "line": 16,
27:       "description": "AC-7 teeth are structurally guaranteed (every negative assertion targets a string the pre-fix generator emitted) and statically proven (git show 6f4d2c38 confirms the old generator.ts:163 injected 'tools/vite-external-deps.mjs' and old base/generator.spec.ts:44 asserted it), but were not empirically demonstrated by reverting the patch and observing red. The AC explicitly allows 'demonstrated or structurally guaranteed', so this is accepted, not a defect.",
28:       "fix_sketch": "No change required. Optional hardening: run a one-off revert of patchViteConfig in a scratch clone to observe the suite go red."
29:     },
30:     {
31:       "severity": "info",
32:       "category": "design",
33:       "file": "ACCEPTANCE.md",
34:       "line": 90,
35:       "description": "AC-6 e2e was executed in the main worktree (scaffold → build/assets/verify-dist-load/test → cleanup) rather than an isolated scratch worktree under .worktrees/ or tmp/: the session sandbox blocked git worktree operations outside the workspace root. Evidence quality is equivalent (real nx targets, exit-code gated, fresh scaffold, dist contents inspected, full cleanup verified: 0 leftover files, tsconfig.base.json restored).",
36:       "fix_sketch": "No change required. Follow-up runs of this chain in a less restrictive sandbox should use the isolated worktree for AC-6."
37:     },
38:     {
39:       "severity": "info",
40:       "category": "design",
41:       "file": "packages/apigen/apigen-plugin-acme/src/lib/apigen-apigen-plugin-acme.spec.ts",
42:       "line": 1,
43:       "description": "Real scaffolds still emit the double-prefixed lib filename (apigen-apigen-plugin-acme.spec.ts / .ts) — pre-existing BUG-WORKSPACE-GEN-002 (BACKLOG.md:1118), surfaced again by the AC-6 scaffold. Not introduced or addressed by this change; cosmetic (lib file naming), does not affect build/test/verify gates.",
44:       "fix_sketch": "Track in BUG-WORKSPACE-GEN-002; out of scope for BUG-WORKSPACE-GEN-006."
45:     },
46:     {
47:       "severity": "info",
48:       "category": "style",
49:       "file": "packages/workspace/workspace-codegen-nx/src/generators/shared/generator.ts",
50:       "line": 181,
51:       "description": "Process note (not a code defect): the implementer used --skip-nx-cache once early in the session against the repo rule (AGENTS.md: never --skip-nx-cache). It was unnecessary (source changes invalidate the cache naturally), no publish occurred, and all subsequent runs used the normal cache. Disclosed by the implementer in the handoff.",
52:       "fix_sketch": "None. Recorded for process hygiene."
53:     }
54:   ],
55:   "summary": { "critical": 0, "high": 0, "medium": 0, "low": 0, "info": 4 },
56:   "backlog_entries": [
57:     "None new this session. Pre-existing deferrals re-confirmed: BL-1 (16 comment-only stale tools/vite-external-deps.mjs references in existing apigen vite.config.ts files), BL-2 (register BUG-WORKSPACE-GEN-006 close-out via the repo backlog CLI workflow — this chain does not call the CLI; BACKLOG.md is a generated projection)."
58:   ],
59:   "open_questions": [
60:     "None blocking. Product final review may decide whether BL-1 (comment-only stale references) should be fixed in a follow-up."

(Showing lines 1-60 of 82. Use offset=61 to continue.)