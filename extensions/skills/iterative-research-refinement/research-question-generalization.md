# Research Question Generalization Process

A structured process for taking specific observations and generalizing them
into broader research questions that cover more ground.

## Phase 0 — Collect Observations
Gather the specific evidence. Each observation should be a single, concrete fact:
- "memory-core overrides module:CommonJS in tsconfig.lib.json:4"
- "sox-ingest's TLA can't be emitted as CJS by esbuild"
- "blob-store uses await import('better-sqlite3') inside open()"

For each observation, record:
- The specific file/line
- What it does
- Why it's notable (what tension or tradeoff does it reveal?)

## Phase 1 — Strip Project-Specific Details
Remove names, versions, paths, and project-specific context.
Replace concrete with generic:

| Concrete | Generic |
|----------|---------|
| memory-core's tsconfig.lib.json | a package's build config |
| sox-ingest | a package with async-native constraints |
| blob-store | a package with native/heavy dependencies |
| @adhd/sox-memory-core | a CJS consumer |
| tree-sitter-wasms | a heavy transitive dependency |

The result should be a set of statements that could apply to any project.

## Phase 2 — Identify the Tension
For each generalized observation, ask: "What design decision does this reveal?"

- One package opted in to CJS by overriding the repo-wide module format → **tension: per-package format decision vs repo-wide standard**
- A package with TLA became ESM-only and broke CJS consumers → **tension: async-native code vs synchronous compatibility**
- A package loads a native dependency dynamically at call site → **tension: static import vs dynamic import for heavy dependencies**

## Phase 3 — Frame as a Research Question
Turn each tension into a question about the PATTERN, not about the specific project.

Use these stems:
- "What is the convention for ..."
- "Should every package ... or is it acceptable to ..."
- "What are the conditions under which ..."
- "How do established projects handle ..."
- "What is the decision framework for ..."

Example:
- Tension: "per-package format decision vs repo-wide standard"
- Question: "Should the build emit both CJS and ESM for native packages, or a single format with a declared floor?"

## Phase 4 — Coverage Check
Does the research question cover the full scope of the tension?

- Are there edge cases the question misses?
- Does the question apply to only one project, or to any project facing the same tension?
- Can the question be researched using external sources, or does it require internal knowledge?

If the question is too narrow (only applies to one project), broaden it.
If the question is too broad (can't be researched meaningfully), narrow it.

## Phase 5 — Domain Categorization
Group similar RQs into domains. Each domain should cover a coherent area:

| Domain | Example RQs |
|--------|------------|
| PKG (packaging) | CJS/ESM dual? Heavy dep granularity? Phantom dep detection? |
| BUILD (build tooling) | Single vs dual format? TLA invariant? Post-build verification? |
| PERF (performance) | Lazy vs eager init? Resource loading granularity? Cold-start budgets? |

This enables searching for patterns across related questions together.
