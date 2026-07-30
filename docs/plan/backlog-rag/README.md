# backlog-rag — RAG for project backlogs

> **Status:** Draft plan
> **Depends on:** `@adhd/environment` (npm), `@adhd/apigen-cli` + `@adhd/apigen-plugin-mcp` (npm), `@adhd/sox-graph-store` (workspace), `@adhd/sox-ingest` (workspace)
> **Keywords:** backlog, rag, graph-store, apigen, environment, cli, mcp

---

## 1. Problem

Project backlogs (`BACKLOG.md`) contain a wealth of structured knowledge — known bugs, planned features, fix sketches, triage context — but they are static markdown files. There is no way to:

- Search across backlog items semantically or by structured fields
- Filter by priority (`HIGH`/`MEDIUM`/`LOW`/`FEATURE`), status (`Open`/`Resolved`/`Blocked`), or module
- Query related items across multiple projects
- Let agents discover and reference backlog items during a session
- Track item lifecycle (status transitions over time)

---

## 2. Use cases

### UC-1: Scan a project backlog into searchable storage

**Actor:** Developer (CLI) or CI

**Trigger:** `backlog-rag scan [--file BACKLOG.md] [--scope project]`

**Precondition:** BACKLOG.md exists at the project root (or specified path)

**Postcondition:** Every `### BL-<n>` item in the file is stored in the graph-store database with parsed fields (ID, title, status, priority, description, fix sketch, related files)

**Flow:**
1. Read the file, compute sha256, compare to last-scanned manifest
2. If unchanged → skip (idempotent)
3. If changed → parse all `### BL-<n>` sections
4. For each item, check if it already exists in the store (by content_hash dedup)
5. Write new items, update changed items, skip identical ones
6. Write scan manifest (file sha256, timestamp, item count)
7. Report summary: `{ scanned: bool, added: N, updated: N, skipped: N, total: N }`

**Error cases:**
- File not found → error with path
- Parse error on a specific BL-xxx → warn, continue with remaining items
- Database write error → atomic rollback on the batch

---

### UC-2: Query backlog items by text and filters

**Actor:** Developer (CLI) or Agent (MCP tool)

**Trigger:** `backlog-rag query <search-text> [--priority HIGH] [--status open] [--tag memory-server] [--limit 20]`

**Precondition:** At least one scan has been performed

**Postcondition:** Returns ranked list of matching backlog items with relevance scores

**Flow:**
1. Apply FTS5 search on `content`, `name`, `summary` columns
2. Apply post-filter: priority (from metadata), status (from metadata), tags (from node.tags)
3. Sort by FTS rank (BM25), optionally re-rank by importance
4. Return `{ results: BlItem[], total: number, query: string }`

**Alternative flows:**
- No search text → return items sorted by importance DESC (priority scan)
- Filter by `--bl BL-231` → return exact match by metadata.bl_id
- Filter by `--project <path>` → scope to items from a specific project
- Output formats: `table` (default), `json`, `detail` (full item)

---

### UC-3: Get backlog statistics

**Actor:** Developer (CLI) or Agent (MCP tool)

**Trigger:** `backlog-rag stats [--priority HIGH]`

**Precondition:** At least one scan has been performed

**Postcondition:** Returns aggregate counts

**Flow:**
1. Count items by priority (HIGH/MEDIUM/LOW/FEATURE)
2. Count items by status (Open/Resolved/Blocked/Reopened)
3. If --priority specified, filter to that priority
4. Report recency: items updated in last 7d, 30d, 90d
5. Report top-5 tags (most commonly tagged modules/files)

---

### UC-4: View a single backlog item

**Actor:** Developer (CLI)

**Trigger:** `backlog-rag get BL-231`

**Precondition:** The item exists in the store

**Postcondition:** Displays the full item with all parsed fields

**Flow:**
1. Look up by metadata.bl_id
2. Render full markdown body + structured fields
3. Show status history if supersession chain exists
4. Show related items (same tags, same topic)

---

### UC-5: Agent queries backlog during session (MCP)

**Actor:** Agent (via host MCP client)

**Trigger:** Tool call `backlog_query` or `backlog_scan`

**Precondition:** backlog-rag MCP server is running (as a sox service)

**Postcondition:** Agent receives structured backlog data in context

**Flow:**
1. Agent calls `backlog_query({ query: "memory-server crash", filters: { tags: ["high"] } })`
2. MCP server dispatches to the same `api.ts` functions as the CLI
3. Returns ranked results
4. Agent uses results to inform implementation decisions

---

### UC-6: Cross-project backlog queries (multi-scan)

**Actor:** Developer with multiple projects

**Trigger:** `backlog-rag scan --file /path/to/project-a/BACKLOG.md` then `backlog-rag query critical --scope user`

**Precondition:** User has scanned multiple project backlogs into the user-scope store

**Postcondition:** Query returns items from all scanned projects, deduplicated

**Flow:**
1. Each `backlog-rag scan --file <path>` stores items with `project_path` = resolved project root
2. `backlog-rag query` filters nothing by default (all projects)
3. `--project <path>` scopes to a single project
4. Cross-project results are deduped by content_hash

---

### UC-7: Automated scan on BACKLOG.md change (CI)

**Actor:** CI pipeline or git hook

**Trigger:** Post-merge / post-commit hook

**Precondition:** Hook is installed

**Postcondition:** Backlog is re-scanned automatically when BACKLOG.md changes

**Flow:**
1. Hook detects BACKLOG.md was modified (via git diff or file watcher)
2. Runs `backlog-rag scan` with the changed file
3. Store is updated atomically

---

## 3. User flows

### Flow 1: First-time user — project setup

```
$ soxe install sox-backlog-bundle --scope=project
→ Installs backlog-rag-cli (command), backlog-rag (mcp-server), backlog-rag-usage (skill)
→ Service registered for project scope
→ Database initialized at ~/.backlog-rag/store.db (or project-relative)

$ backlog-rag scan
→ Scanning BACKLOG.md...
→ ✓ 47 items scanned (43 new, 4 updated, 0 skipped)
→   HIGH:   12
→   MEDIUM: 18
→   LOW:    12
→   FEATURE: 5

$ backlog-rag stats
→ By priority:
→   HIGH:    12 open  ·  0 resolved  ·  2 blocked
→   MEDIUM:  15 open  ·  2 resolved  ·  1 blocked
→   LOW:      8 open  ·  4 resolved  ·  0 blocked
→   FEATURE:  5 open  ·  0 resolved  ·  0 blocked
→ By recency:
→   Updated in 7d:   3
→   Updated in 30d: 15
→   Updated in 90d: 35
```

### Flow 2: Developer investigating a bug

```
$ backlog-rag query "memory-server" --priority HIGH

  3 results for "memory-server" (filtered: HIGH):

  1. BL-231 — both merge gates are green again  [HIGH] [OPEN]
     Both smoke-test.mjs and test-e2e-lifecycle.js pass.
     → scripts/smoke-test.mjs, libs/host-runtime/...

  2. BL-235 — nx build deletes dist/ before it knows the rebuild succeeds  [HIGH] [OPEN]
     Several build targets begin with rm -rf dist/.
     → tools/bundle-extension.cjs, apps/sox/...

  3. BL-248 — typecheck is not optional, and build does not imply it  [HIGH] [OPEN]
     esbuild strips types without checking them.
     → tools/bundle-extension.cjs, AGENTS.md

$ backlog-rag get BL-231

  BL-231 — both merge gates are green again
  Status:    OPEN (HIGH) · Updated 2026-07-09
  Source:    BACKLOG.md § Smoke test / e2e

  Both merge gates are green again (smoke-test.mjs: 13 passed / 0 failed;
  test-e2e-lifecycle.js: 108 passed / 0 failed). Keep them that way.

  Where:
    scripts/smoke-test.mjs
    libs/host-runtime/src/...

  Fix sketch:
    This was traced to the stale-dist bug in bundle-extension.cjs.
    After every rebuild, run npx nx run registry:sync-index.
```

### Flow 3: Agent discovering relevant backlog items

```
[Agent starts a session]
Agent: memory_recall { query: "build cache bug fixes", filters: { tags: ["backlog", "high"] } }
→ Returns BL-235 (nx build destructive), BL-248 (typecheck gap)

Agent: backlog_query { query: "extension bundle", filters: { priority: "HIGH" } }
→ Returns BL-231 (smoke test), BL-235 (build destructive)

Agent: Uses BL-235 and BL-248 to inform the implementation strategy:
  - "I must NOT run nx build as a diagnostic (BL-235 — it destroys the artifact)"
  - "I MUST run typecheck separately (BL-248 — build doesn't check types)"
```

### Flow 4: Cross-project portfolio view

```
$ backlog-rag scan --file ~/dev/project-a/BACKLOG.md
$ backlog-rag scan --file ~/dev/project-b/BACKLOG.md
$ backlog-rag scan --file ~/dev/project-c/BACKLOG.md
$ backlog-rag query "security" --priority HIGH

  5 results across 3 projects (filtered: HIGH):

  Project A: BL-401 — auth token rotation  [HIGH] [OPEN]
  Project A: BL-402 — input sanitization  [HIGH] [BLOCKED]
  Project B: BL-89  — secrets in env vars  [HIGH] [OPEN]
  Project B: BL-92  — SQL injection in search  [HIGH] [OPEN]
  Project C: BL-12  — CSRF protection missing [HIGH] [REOPENED]
```

### Flow 5: Resolving a backlog item (lifecycle)

```
# After fixing BL-235, the developer re-scans
$ backlog-rag scan
→ Scanning BACKLOG.md...
→ ✓ 47 items scanned (0 new, 1 updated, 46 skipped)
→ BL-235 status changed: OPEN → RESOLVED

# The old BL-235 episode is superseded via graph-store.supersede()
# Query still finds the old version via supersession chain
# backlog-rag get BL-235 shows status history:
$ backlog-rag get BL-235 --history
  BL-235 — nx build deletes dist/ before it knows the rebuild succeeds
  Status:  RESOLVED (was OPEN since 2026-07-08)
  History:
    2026-07-08  OPEN      filed
    2026-07-22  RESOLVED  fixed by PR #142 (pre-build artifact backup)
```

---

## 4. Architecture

### 4.1 Bundle layout

```
extensions/bundles/sox-backlog-bundle/
  extension.json                    # bundle: sox-backlog-bundle
  members/
    backlog-rag-cli/                 # command — the CLI client (PRIMARY)
      extension.json                 # type: command
      package.json                   # @adhd/sox-extension-backlog-rag-cli
      project.json                   # nx build|test|lint|typecheck
      tsconfig.json
      vitest.config.ts
      src/
        index.ts                     # runCli(argv) → CLI entry
        cmd-scan.ts                  # backlog-rag scan
        cmd-query.ts                 # backlog-rag query
        cmd-stats.ts                 # backlog-rag stats
        cmd-get.ts                   # backlog-rag get <bl-id>
        parser.ts                    # BACKLOG.md → ParsedBlItem[]
        store.ts                     # SqliteGraphBackend wrapper
        config.ts                    # @adhd/environment Environment<T>
        scan-manifest.ts             # sha256 tracking, delta detection

    backlog-rag/                     # mcp-server — generated by apigen
      extension.json                 # type: mcp-server, lifecycle: { background: true }
      package.json                   # @adhd/sox-extension-backlog-rag
      project.json                   # nx build → apigen generate --type mcp
      tsconfig.json
      src/
        api.ts                       # Pure TS functions (source of truth)
                                     #   scanBacklog(filePath): ScanResult
                                     #   queryBacklog(text, filters): QueryResult
                                     #   getBacklogStats(filters): StatsResult
                                     #   getBacklogItem(blId): BlItem
        config.ts                    # @adhd/environment spec (shared)
      generated/                     # apigen output (gitignored, built by nx build)
        mcp-server/
          index.js                   # MCP server entrypoint
          schema.json                # MCP tool schemas

    backlog-rag-usage/               # skill — agent guidance
      extension.json                 # type: skill, runtime: declarative
      SKILL.md                       # How to call backlog_query / backlog_scan
      references/
        query-examples.md            # Example memory_recall + backlog_query patterns
        tag-scheme.md                # Canonical tag vocabulary
```

### 4.2 Data model

Backlog items stored in graph-store via `SqliteGraphBackend`:

```typescript
// Per backlog item
const rowid = backend.writeNode(body, {
  kind: 'generic',                          // BL-295: non-memory use → kind: 'generic'
  name: `BL-${blId} — ${title}`,            // Searchable title
  summary: firstLine,                        // Extractive summary
  tags: [
    'backlog',                               // Namespace tag
    `bl-${blId}`,                            // Direct lookup
    priority.toLowerCase(),                  // 'high' | 'medium' | 'low' | 'feature'
    status.toLowerCase(),                     // 'open' | 'resolved' | 'blocked' | 'reopened'
    ...relatedFileSlugs,                     // 'memory-server', 'smoke-test', etc.
  ],
  importance: priorityToImportance(priority), // HIGH=9, MEDIUM=6, LOW=3, FEATURE=2
  projectPath: resolvedProjectPath,
  metadata: {
    bl_id: blId,                              // 'BL-231'
    priority,                                  // 'HIGH'
    status,                                    // 'OPEN'
    status_date,                               // '2026-07-09'
    related_files: [...filePaths],             // Full paths
    fix_sketch,                                // Truncated fix sketch
    triage_context,                            // Truncated triage context
    source_section,                            // Section heading
    source_file,                               // 'BACKLOG.md'
    source_file_sha256,                        // For delta detection
  },
});
```

### 4.3 Config schema (@adhd/environment)

```typescript
import { Environment } from '@adhd/environment-core-node';

const spec = {
  config: {
    'store.db_path': {
      type: 'string',
      default: '~/.backlog-rag/store.db',
      description: 'Path to the graph-store SQLite database.',
    },
    'store.namespace': {
      type: 'string',
      default: 'backlog',
      description: 'graph-store namespace for isolation.',
    },
    'scan.include_patterns': {
      type: 'array',
      items: { type: 'string' },
      default: ['BACKLOG.md'],
      description: 'Glob patterns for files to scan.',
    },
    'scan.exclude_patterns': {
      type: 'array',
      items: { type: 'string' },
      default: [],
      description: 'Glob patterns to exclude from scanning.',
    },
  },
};

const env = new Environment('backlog-rag', spec);
// env.config.store.db_path → resolved path
// env.config.scan.include_patterns → ['BACKLOG.md']
```

### 4.4 API surface (api.ts — apigen source)

```typescript
// api.ts — single source of truth for all transports

export interface ScanOptions {
  filePath?: string;          // default: 'BACKLOG.md'
  projectPath?: string;       // default: cwd
  dryRun?: boolean;
}

export interface ScanResult {
  scanned: boolean;
  added: number;
  updated: number;
  skipped: number;
  total: number;
  items: Array<{
    blId: string;
    title: string;
    status: string;
    action: 'added' | 'updated' | 'skipped';
  }>;
}

export interface QueryOptions {
  limit?: number;
  priority?: 'HIGH' | 'MEDIUM' | 'LOW' | 'FEATURE';
  status?: 'OPEN' | 'RESOLVED' | 'BLOCKED' | 'REOPENED';
  tag?: string | string[];
  project?: string;
  blId?: string;
  format?: 'table' | 'json' | 'detail';
}

export interface QueryResult {
  results: Array<{
    blId: string;
    title: string;
    priority: string;
    status: string;
    summary: string;
    score?: number;
    relatedFiles: string[];
    projectPath?: string;
  }>;
  total: number;
  query: string;
}

export interface StatsResult {
  byPriority: Record<string, { open: number; resolved: number; blocked: number; reopened: number }>;
  byRecency: { last7d: number; last30d: number; last90d: number };
  topTags: Array<{ tag: string; count: number }>;
  totalItems: number;
}

// === The functions that apigen compiles into transports ===

export async function scanBacklog(opts?: ScanOptions): Promise<ScanResult> { ... }
export async function queryBacklog(text: string, opts?: QueryOptions): Promise<QueryResult> { ... }
export async function getBacklogStats(opts?: { priority?: string }): Promise<StatsResult> { ... }
export async function getBacklogItem(blId: string): Promise<BlItem | null> { ... }
export async function reindexBacklog(): Promise<{ reindexed: number; errors: number }> { ... }
```

### 4.5 Dependency graph

```
backlog-rag-cli (command)        backlog-rag (mcp-server)     backlog-rag-usage (skill)
       │                                │                              │
       ├── api.ts (same source)         ├── api.ts (same source)       └── (declarative markdown)
       │                                │
       ├── @adhd/sox-graph-store        ├── @adhd/apigen-core
       ├── @adhd/sox-ingest/core        ├── @adhd/apigen-plugin-mcp
       ├── @adhd/environment            ├── @adhd/environment
       └── better-sqlite3               └── @adhd/sox-graph-store
```

---

## 5. Files to create

### Bundle

| File | Purpose |
|---|---|
| `extensions/bundles/sox-backlog-bundle/extension.json` | Bundle manifest, type: bundle, members: backlog-rag-cli, backlog-rag, backlog-rag-usage |

### CLI command (backlog-rag-cli) — ~15 files

| File | Purpose |
|---|---|
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag-cli/extension.json` | Command manifest |
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag-cli/package.json` | npm package |
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag-cli/project.json` | nx targets |
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag-cli/tsconfig.json` | TypeScript config |
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag-cli/vitest.config.ts` | Test config |
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag-cli/src/index.ts` | runCli CLI entry point |
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag-cli/src/api.ts` | Shared function definitions |
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag-cli/src/cmd-scan.ts` | Scan command implementation |
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag-cli/src/cmd-query.ts` | Query command implementation |
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag-cli/src/cmd-stats.ts` | Stats command implementation |
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag-cli/src/cmd-get.ts` | Get-single-item command |
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag-cli/src/parser.ts` | BACKLOG.md markdown parser |
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag-cli/src/store.ts` | SqliteGraphBackend wrapper |
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag-cli/src/config.ts` | Environment spec + init |
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag-cli/src/scan-manifest.ts` | Delta detection |

### MCP server (backlog-rag) — ~8 files

| File | Purpose |
|---|---|
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag/extension.json` | MCP server manifest |
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag/package.json` | npm package |
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag/project.json` | nx targets (build → apigen generate) |
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag/tsconfig.json` | TypeScript config |
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag/src/api.ts` | Shared function definitions (same as CLI) |
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag/src/config.ts` | Environment spec (shared) |
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag/src/parser.ts` | Parser (shared or re-exported) |
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag/src/store.ts` | Store wrapper (shared or re-exported) |

### Skill (backlog-rag-usage) — ~3 files

| File | Purpose |
|---|---|
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag-usage/extension.json` | Skill manifest |
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag-usage/SKILL.md` | Agent guidance |
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag-usage/references/tag-scheme.md` | Tag vocabulary |

### Tests — ~6 files

| File | Purpose |
|---|---|
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag-cli/src/parser.spec.ts` | Parser: section split, field extraction, fixture-based |
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag-cli/src/store.spec.ts` | Store: write, query, dedup, supersession |
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag-cli/src/cmd-scan.spec.ts` | Scan: delta detection, idempotent re-scan |
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag-cli/src/cmd-query.spec.ts` | Query: FTS, filters, cross-project |
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag-cli/src/cmd-stats.spec.ts` | Stats: counts, recency |
| `extensions/bundles/sox-backlog-bundle/members/backlog-rag/src/api.spec.ts` | API surface: functions execute correctly |

### Documentation — ~1 file

| File | Purpose |
|---|---|
| `extensions/bundles/sox-backlog-bundle/docs/USER_FLOWS.md` | Full user flow documentation |

---

## 6. Implementation sequence

### Phase 1: Core library (the parser + store)

1. **`parser.ts`** — BACKLOG.md format parser
   - Split on `### BL-<n>` headings
   - Extract ID, title, status marker, priority, date
   - Extract body sections (`What's wrong`, `Where`, `Fix sketch`, `Triage context`)
   - Extract file paths from backtick references
   - Test against 3 fixtures: full BACKLOG.md sample, edge cases, malformed entries

2. **`store.ts`** — SqliteGraphBackend wrapper
   - `initStore(dbPath, namespace)` → creates/open graph-store DB
   - `writeItem(item, projectPath)` → writeNode with dedup
   - `updateItem(rowid, item)` → supersede or touch
   - `queryItems(text, filters)` → searchNodes + queryNodes
   - `getStats(filters)` → countNodes by metadata fields
   - `getItem(blId)` → queryNodes by metadata.bl_id

3. **`config.ts`** — Environment spec
   - Define Environment spec with all config keys
   - Resolve paths (expand ~, resolve relative to cwd/scope)

### Phase 2: CLI client

4. **`index.ts` + cmds** — Command dispatcher
   - `scan` → parse + store with delta detection
   - `query` → search + filter + render
   - `stats` → aggregate + display
   - `get` → lookup + full detail display

5. **`scan-manifest.ts`** — Delta tracking
   - Write manifest after each scan
   - On re-scan: compare sha256, skip if unchanged

### Phase 3: MCP service (apigen-generated)

6. **`api.ts`** — Pure function definitions
   - Same logic as CLI commands, but as exported functions
   - `scanBacklog`, `queryBacklog`, `getBacklogStats`, `getBacklogItem`

7. **project.json build target** — apigen integration
   - `npx @adhd/apigen-cli generate --source src/api.ts --type mcp --out-dir generated/mcp-server`
   - Copy extension.json and built artifacts to dist/

### Phase 4: Skill + docs

8. **`SKILL.md`** — Agent guidance
9. **`USER_FLOWS.md`** — Complete flow documentation

### Phase 5: Integration

10. Register in `registry/index.json` via `npx nx run registry:sync-index`
11. Add `@adhd/sox-graph-store` + `@adhd/sox-ingest` to `tools/bundle-extension.cjs` `SOX_ALIASES`
12. Run smoke test
13. Commit

---

## 7. Integration checklist

### Build system changes

| Change | File | What |
|---|---|---|
| Add `@adhd/sox-graph-store` to SOX_ALIASES | `tools/bundle-extension.cjs` | Line ~50 new entry |
| Add `@adhd/sox-ingest` to SOX_ALIASES | `tools/bundle-extension.cjs` | Line ~50 new entry |
| External better-sqlite3 in cli build | `project.json` backlog-rag-cli build target | Already handled by bundle script |

### Scope handling

| Scope | Database path | Config cascade | Use case |
|---|---|---|---|
| `project` | `<project>/.backlog-rag/store.db` | Project `.adhd/` dir | Single-project backlog |
| `user` | `~/.backlog-rag/store.db` | User `~/.adhd/` dir | Cross-project portfolio |
| `org` | `~/.config/.backlog-rag/store.db` | Shared org config | Team-level backlog |
| `local` | `<cwd>/.backlog-rag/store.db` | Local `.adhd/` + .local overrides | Dev sandbox |

The `@adhd/environment` cascade (`defaults → system → global → project → local → env vars`) is scope-aware: the config layer that writes can differ by scope. The sox install system passes the scope at install time, which maps to the environment's root resolution.

---

## 8. Open questions

| # | Question | Impact |
|---|---|---|
| 1 | **@adhd/environment path compatibility**: The Environment class uses `.adhd/` as its config root. Sox uses `.sox/` and `.memory/`. Does Environment accept a custom root path, or must it map to `.adhd/`? | If Environment can't use sox paths, we need a path adapter. |
| 2 | **apigen --type cli-output quality**: The CLI plugin is generate-only and uses Commander. Is the generated CLI good enough to publish, or should the CLI be hand-written (calling the same api.ts functions directly)? | Hand-written CLI is more maintainable and testable. apigen CLI can supplement it. |
| 3 | **Shared vs separate DB**: Do the CLI and MCP service share the same graph-store database, or each maintain their own? | Shared is simpler (single source of truth). Separate means the CLI must flush to the service's DB. |
| 4 | **apigen build integration**: How does apigen get invoked in the nx build target? As a `npx` command, or imported as a library? | Affects build reliability (npx may resolve stale versions; library import is predictable). |
