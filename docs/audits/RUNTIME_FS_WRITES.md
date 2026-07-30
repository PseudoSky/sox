# Runtime Filesystem Writes — External Audit

Every file/dir this codebase writes **outside** the repository root
(`/Users/nix/dev/ai/sox-ecosystem`). Counts are per-developer-machine,
per-project-scope — actual numbers vary with installs and usage.

---

## Table of Contents

1. [ADR-0004 Data Root](#1-adr-0004-data-root-adhdsox-ecosystem)
2. [Host Placements — Claude](#2-host-placements--claude)
3. [Host Placements — OpenCode](#3-host-placements--opencode)
4. [Host Placements — Codex](#4-host-placements--codex)
5. [Memory Store](#5-memory-store)
6. [OS Service Units](#6-os-service-units)
7. [TokenGuard](#7-tokenguard)
8. [MCP Runtime Sockets](#8-mcp-runtime-sockets)
9. [Service-Proxy Backend Locks & Backend Stderr](#9-service-proxy-backend-locks--backend-stderr)
10. [Schema Cache](#10-schema-cache)
11. [Legacy Paths (pre-ADR-0004)](#11-legacy-paths-pre-adr-0004)
12. [Per-Project Scope Paths](#12-per-project-scope-paths)
13. [Test Artifacts](#13-test-artifacts)
14. [Centralization Blast Radius (excluding host placements)](#14-centralization-blast-radius-excluding-host-placements)
15. [Existing Sandbox / Testing Harnesses](#15-existing-sandbox--testing-harnesses)
16. [Path Classification — Scoping Model](#16-path-classification--scoping-model)
17. [Two-Package Design — Migration Architecture](#17-two-package-design--migration-architecture)
18. [Adoption Survey Reconciliation](#18-adoption-survey-reconciliation)
19. [Required `@adhd/environment` Gap Tasks](#19-required-adhdenvironment-gap-tasks)

---

## 1. ADR-0004 Data Root (`~/.adhd/sox-ecosystem/`)

Configurable via `$SOX_ECOSYSTEM_HOME`. Default: `~/.adhd/sox-ecosystem/`.

### 1a. Scope Config / Lockfile

**Template:** `<dataRoot>/<file>` where `dataRoot = dataRoot(scope)` from `libs/host-runtime/src/data-paths.ts`.

| File | Scope | Package | Function | Dir exists | Pattern | Real files | Path determined by |
|------|-------|---------|----------|------------|---------|------------|-------------------|
| `extensions.json` | user/project | `apps/sox/src/main.ts` | `cmdInstall` (line 1497) | `fsMod3.mkdirSync(cfgDir, {recursive:true})` | `1` per scope | `~/.adhd/sox-ecosystem/extensions.json` | `libs/host-runtime/src/data-paths.ts:109` · `libs/install-engine/src/data-paths.ts:92` — `scopeConfigPaths()` returns `path.join(dataRoot(scope, root), 'extensions.json')` |
| `extensions.lock` | user/project | `libs/install-engine/src/install.ts` | `writeLockfileAtomic` (line 462) | `fs.mkdirSync(lockDir, {recursive:true})` (line 471) | `1` per scope | `~/.adhd/sox-ecosystem/extensions.lock` | `libs/host-runtime/src/data-paths.ts:110` · `libs/install-engine/src/data-paths.ts:93` — `scopeConfigPaths()` returns `path.join(dataRoot(scope, root), 'extensions.lock')` |
| `extensions.local.json` | local | `libs/install-engine/src/data-paths.ts` | `scopeConfigPaths` (line 80) | (caller provides) | `1` per local scope | `<project>/.adhd/sox-ecosystem/extensions.local.json` | `libs/install-engine/src/data-paths.ts:80` · `libs/host-runtime/src/data-paths.ts:98` — `scopeConfigPaths('local')` returns `path.join(dataRoot('local', root), 'extensions.local.json')` |
| `extensions.local.lock` | local | `libs/install-engine/src/data-paths.ts` | `scopeConfigPaths` (line 81) | (caller provides) | `1` per local scope | `<project>/.adhd/sox-ecosystem/extensions.local.lock` | `libs/install-engine/src/data-paths.ts:81` · `libs/host-runtime/src/data-paths.ts:99` — `scopeConfigPaths('local')` returns `path.join(dataRoot('local', root), 'extensions.local.lock')` |
| `org.extensions.json` | org | `libs/install-engine/src/data-paths.ts` | `scopeConfigPaths` (line 86) | (caller provides) | `1` per org | `~/.adhd/sox-ecosystem/org.extensions.json` | `libs/install-engine/src/data-paths.ts:86` · `libs/host-runtime/src/data-paths.ts:103` — `scopeConfigPaths('org')` returns `path.join(dataRoot('org', root), 'org.extensions.json')` |
| `org.extensions.lock` | org | `libs/install-engine/src/data-paths.ts` | `scopeConfigPaths` (line 87) | (caller provides) | `1` per org | `~/.adhd/sox-ecosystem/org.extensions.lock` | `libs/install-engine/src/data-paths.ts:87` · `libs/host-runtime/src/data-paths.ts:104` — `scopeConfigPaths('org')` returns `path.join(dataRoot('org', root), 'org.extensions.lock')` |

### 1b. Provenance Ledger

**Template:** `<dataRoot>/ledger.json`

| Package | Function | Dir exists | Real files | Path determined by |
|---------|----------|------------|------------|-------------------|
| `libs/install-engine/src/ledger.ts` | via `fileDrop`, `materialize` etc. | (caller provides) | `~/.adhd/sox-ecosystem/ledger.json`, `<project>/.adhd/sox-ecosystem/ledger.json` | `libs/host-runtime/src/data-paths.ts:116` · `libs/install-engine/src/data-paths.ts:99` — `ledgerPathFor(scope, root)` returns `path.join(dataRoot(scope, root), 'ledger.json')` |

Files matching: `1` per scope per machine.

### 1c. Ownership Index

**Template:** `<dataRoot>/ownership.json`

| Package | Function | Dir exists | Real files | Path determined by |
|---------|----------|------------|------------|-------------------|
| `libs/install-engine/src/ownership.ts` | `writeOwnershipAtomic` (line 79) | `fs.mkdirSync(dir, {recursive:true})` (line 81) | `~/.adhd/sox-ecosystem/ownership.json`, `<project>/.adhd/sox-ecosystem/ownership.json` | `libs/host-runtime/src/data-paths.ts:121` · `libs/install-engine/src/data-paths.ts:104` — `ownershipPathFor(scope, root)` returns `path.join(dataRoot(scope, root), 'ownership.json')` |

Files matching: `1` per scope.

### 1d. Materialized Extension Store

**Template:** `<dataRoot>/ext/<extId>@<version>/` and `<dataRoot>/ext/<extId>@latest` (symlink)

| Package | Function | Dir exists | Pattern | Real files | Path determined by |
|---------|----------|------------|---------|------------|-------------------|
| `libs/install-engine/src/capabilities/materialize.ts` | `apply` (line 126) | `fs.mkdirSync(dest, {recursive:true})` (line 102) | `1` dir per `extId@version`, `1` symlink per `extId` | `~/.adhd/sox-ecosystem/ext/memory-server@1.1.0/`, `~/.adhd/sox-ecosystem/ext/memory-server@latest` | `libs/install-engine/src/capabilities/materialize.ts:75-81` — `storePath(storeRoot, extRef)` = `path.join(storeRoot, extRef)`, `latestLinkPath(storeRoot, extId)` = `path.join(storeRoot, extId + '@latest')`. `storeRoot` = `storeRootFor('user')` = `dataRoot('user') + '/ext'` per `libs/install-engine/src/data-paths.ts:109` · `libs/host-runtime/src/data-paths.ts:126` |

Files matching: N dirs = number of installed extensions × number of distinct versions. Example: `memory-server@1.1.0`, `tokenguard@0.2.0`.

### 1e. Global Install Registry

**Template:** `<userDataRoot>/install-registry.json`

| Package | Function | Dir exists | Real files | Path determined by |
|---------|----------|------------|------------|-------------------|
| `libs/install-engine/src/install-registry.ts` | `writeInstallRegistryAtomic` (line 67) | `fs.mkdirSync(dir, {recursive:true})` (line 72) | `~/.adhd/sox-ecosystem/install-registry.json` | `libs/host-runtime/src/data-paths.ts:133` · `libs/install-engine/src/data-paths.ts:113` — `installRegistryPath()` returns `path.join(userDataRoot(), 'install-registry.json')` |

Files matching: exactly `1`.

### 1f. Global Supervisor Registry

**Template:** `<userDataRoot>/supervisors.json`

| Package | Function | Dir exists | Real files | Path determined by |
|---------|----------|------------|------------|-------------------|
| `libs/host-runtime/src/registry.ts` | `writeSupervisorsFile` (line 87) | `fs.mkdirSync(dir, {recursive:true})` (line 90) | `~/.adhd/sox-ecosystem/supervisors.json` | `libs/host-runtime/src/data-paths.ts:138` — `supervisorsPath()` returns `path.join(userDataRoot(), 'supervisors.json')` |

Files matching: exactly `1`.

### 1g. Runtime Dir — Locks, Runtime Records, Sockets, Logs

**Template:** `<userDataRoot>/run/`

#### Lock files

| Template | Package | Function | Dir exists | Pattern | Real files | Path determined by |
|----------|---------|----------|------------|---------|------------|-------------------|
| `<runDir>/locks/<supervisorId>.lock` | `libs/host-runtime/src/lock.ts` | `acquireStartLock` (line 50) | `fs.mkdirSync(lockDir, {recursive:true})` (line 56) | `1` per live `start` | `~/.adhd/sox-ecosystem/run/locks/a1b2c3d4e5f6.lock` (pid content) | `libs/host-runtime/src/lock.ts:55-57` — `lockDir = path.join(runDir(), 'locks')`, `lockPath = path.join(lockDir, \`\${supervisorId}.lock\`)`. `runDir()` at `libs/host-runtime/src/data-paths.ts:146` |

#### Runtime records

| Template | Package | Function | Dir exists | Pattern | Real files | Path determined by |
|----------|---------|----------|------------|---------|------------|-------------------|
| `<lockfileDir>/runtime.json` | `libs/host-runtime/src/runtime.ts` | `writeRuntimeRecord` (line 740) | `fs.mkdirSync(dir, {recursive:true})` (line 742) | `1` per scope | `~/.adhd/sox-ecosystem/run/runtime.json` | `libs/host-runtime/src/runtime.ts:803-805` — `runtimeFilePathFromLockfile(lockfilePath)` = `path.join(path.dirname(lockfilePath), 'runtime.json')`. The lockfile dir is `<dataRoot>/run/` for user scope |

#### Audit log

| Template | Package | Function | Dir exists | Pattern | Real files | Path determined by |
|----------|---------|----------|------------|---------|------------|-------------------|
| `<runDir>/sox-audit.jsonl` | `apps/sox/src/main.ts` | CLI entry (line 170) | `mkdirSync(runDir, {recursive:true})` (line 160) | `1` | `~/.adhd/sox-ecosystem/run/sox-audit.jsonl` | `apps/sox/src/main.ts:158-160` — `rootDir = dataRoot(auditScope)`, `runDir = join(rootDir, 'run')`, then `appendFileSync(join(runDir, 'sox-audit.jsonl'), ...)`. `dataRoot()` at `libs/host-runtime/src/data-paths.ts:57` |

#### Crash-loop markers

| Template | Package | Function | Dir exists | Pattern | Real files | Path determined by |
|----------|---------|----------|------------|---------|------------|-------------------|
| `<runDir>/crash-loop/<key>.json` | `libs/host-runtime/src/crash-loop.ts` | `CrashLoopGuard._writeMarker` (line 240) | `fs.mkdirSync(this._markerDir, {recursive:true})` (line 242) | `≤1` per service key | `~/.adhd/sox-ecosystem/run/crash-loop/memory-daemon_1_0_0.json` | `libs/host-runtime/src/crash-loop.ts:69-76` — `crashLoopMarkerDir()` = `path.join(runDir(), 'crash-loop')`, `crashLoopMarkerPath(markerDir, key)` = `path.join(markerDir, \`\${safe}.json\`)` where `safe = key.replace(/[^a-zA-Z0-9._@-]/g, '_')` |

#### Log files

| Template | Package | Function | Dir exists | Pattern | Real files | Path determined by |
|----------|---------|----------|------------|---------|------------|-------------------|
| `<userDataRoot>/run/logs/<supervisorId>/` | `libs/host-runtime/src/data-paths.ts` | `logDirFor` (line 150) | `ensureDir` in `os-unit.ts:734` | `1` dir per supervisor | `~/.adhd/sox-ecosystem/run/logs/a1b2c3d4e5f6/` | `libs/host-runtime/src/data-paths.ts:150-151` — `logDirFor(supervisorId)` = `path.join(runDir(), 'logs', supervisorId)` |
| `<logDir>/<extId>-<YYYY-MM-DD>.log` | `libs/host-runtime/src/log-manager.ts` | `LogManager._openStream` (line 187) | `fs.mkdirSync(this.opts.logDir, {recursive:true})` (line 188) | `≤7` per extId per dir | `~/.adhd/sox-ecosystem/run/logs/a1b2c3d4e5f6/memory-server-2026-07-21.log` | `libs/host-runtime/src/log-manager.ts:189` — `path.join(this.opts.logDir, \`\${this.opts.extId}-\${date}.log\`)` |
| `<logDir>/run-history.json` | `libs/host-runtime/src/log-manager.ts` | `_writeHistory` (line 179) | `fs.mkdirSync(path.dirname(p), {recursive:true})` (line 181) | `1` per logDir | `~/.adhd/sox-ecosystem/run/logs/a1b2c3d4e5f6/run-history.json` | `libs/host-runtime/src/log-manager.ts:163-164` — `_historyPath()` = `path.join(this.opts.logDir, 'run-history.json')` |

#### Exec sockets

| Template | Package | Function | Dir exists | Pattern | Real files | Path determined by |
|----------|---------|----------|------------|---------|------------|-------------------|
| `<socketDir>/proxy-<safeKey>-<hash12>.sock` | `libs/service-proxy/src/socket-path.ts` | `backendSocketPath` (line 32) | (caller provides via `socketDir()`) | `1` per singleton key | `~/.adhd/sox-ecosystem/run/supervisors/proxy-memory-server-abc123def456.sock` | `libs/service-proxy/src/socket-path.ts:32-44` — `socketDir` caller provides via `libs/host-runtime/src/data-paths.ts:156` `socketDir()` = `path.join(runDir(), 'supervisors')`. `backendSocketPath` joins `socketDir` with `proxy-\${safeKey}-\${digest}.sock` |

Files matching: `1` per running backend service.

---

## 2. Host Placements — Claude

Configurable via `$SOX_SANDBOX_ROOT` (sandbox/test isolation). Every path is written by the
**file-drop** capability (`libs/install-engine/src/capabilities/file-drop.ts`), which copies
`srcPath → destPath` (idempotent via `sha256` hash comparison). The **config-merge** capability
writes `settings.json` / `.claude.json` keys.

### 2a. User Scope (`~/.claude/`)

Surfaces from `libs/host-registry/src/claude.ts` — `buildSurfaces()` (line 210).

| Surface | Template | Function (capability) | Dir exists | Pattern | Real files | Path determined by |
|---------|----------|-----------------------|------------|---------|------------|-------------------|
| agent | `~/.claude/agents/<id>.md` | `file-drop.apply` → `copyRecursive` (file-drop.ts:79) | `fs.mkdirSync(dest, {recursive})` if dir | `N` installed agents | `~/.claude/agents/code-reviewer.md` | `libs/host-registry/src/claude.ts:215-220` — `buildSurfaces().agent.paths.user` = `path.join(getBase(), '.claude', 'agents')` |
| skill | `~/.claude/skills/<id>/` | file-drop | same | `N` installed skills | `~/.claude/skills/gitnexus/SKILL.md` | `libs/host-registry/src/claude.ts:223-228` — `buildSurfaces().skill.paths.user` = `path.join(getBase(), '.claude', 'skills')` |
| command | `~/.claude/commands/<id>` | file-drop | same | `N` installed commands | `~/.claude/commands/soxe` | `libs/host-registry/src/claude.ts:231-239` — `buildSurfaces().command.paths.user` = `path.join(getBase(), '.claude', 'commands')` |
| rules | `~/.claude/rules/<id>.md` | file-drop | same | `N` installed rules | `~/.claude/rules/security-review.md` | `libs/host-registry/src/claude.ts:243-248` — `buildSurfaces().rules.paths.user` = `path.join(getBase(), '.claude', 'rules')` |
| claude-md | `~/.claude.md` | file-drop | same | `1` | `~/.claude.md` | `libs/host-registry/src/claude.ts:252-257` — `buildSurfaces()['claude-md'].paths.user` = `path.join(getBase(), 'CLAUDE.md')` |
| hook-script | `~/.claude/hooks/<id>/` | file-drop | same | `N` installed hooks | `~/.claude/hooks/post-tool-use/` | `libs/host-registry/src/claude.ts:263-268` — `buildSurfaces()['hook-script'].paths.user` = `path.join(getBase(), '.claude', 'hooks')` |
| plugins | `~/.claude/plugins/` | file-drop | same | `N` installed plugins | `~/.claude/plugins/my-plugin/` | `libs/host-registry/src/claude.ts:285-289` — `buildSurfaces().plugin.paths.user` = `path.join(getBase(), '.claude', 'plugins')` |

### 2b. User Scope — Config-Merge Files

| Surface | File | Package | Function (capability) | Dir exists | Pattern | Real files | Path determined by |
|---------|------|---------|-----------------------|------------|---------|------------|-------------------|
| settings | `~/.claude/settings.json` | `libs/install-engine/src/capabilities/config-merge.ts` | `apply` | (dir exists or mkdir) | `1` | `~/.claude/settings.json` | `libs/host-registry/src/claude.ts:294-302` — `buildSurfaces().settings.paths.user` = `path.join(getBase(), '.claude', 'settings.json')` |
| mcp-server | `~/.claude.json` | config-merge | `apply` | (dir exists) | `1` | `~/.claude.json` | `libs/host-registry/src/claude.ts:307-314` — `buildSurfaces()['mcp-server'].paths.user` = `path.join(getBase(), '.claude.json')` |
| mcp-trust | `~/.claude.json` → `projects["<root>"].enabledMcpjsonServers` | `libs/install-engine/src/mcp-trust-sync.ts` | `apply` (line 76) | (dir exists) | `1` file, `N` entries | `~/.claude.json` | `libs/host-registry/src/claude.ts:345-350` — `buildSurfaces()['mcp-trust'].paths.user` = `path.join(getBase(), '.claude.json')` |
| permissions | `~/.claude/settings.json` | config-merge | `apply` | (dir exists) | `1` | `~/.claude/settings.json` | `libs/host-registry/src/claude.ts:332-339` — `buildSurfaces().permissions.paths.user` = `path.join(getBase(), '.claude', 'settings.json')` |

### 2c. Project Scope (`.claude/`)

| Template | Surface | Real files | Path determined by |
|----------|---------|------------|-------------------|
| `<project>/.claude/agents/` | agent | `repo/.claude/agents/my-agent.md` | `libs/host-registry/src/claude.ts:217-220` — `buildSurfaces().agent.paths.project` = `'.claude/agents'` |
| `<project>/.claude/skills/` | skill | `repo/.claude/skills/my-skill/SKILL.md` | `libs/host-registry/src/claude.ts:225-228` — `buildSurfaces().skill.paths.project` = `'.claude/skills'` |
| `<project>/.claude/commands/` | command | `repo/.claude/commands/soxe` | `libs/host-registry/src/claude.ts:233-239` — `buildSurfaces().command.paths.project` = `'.claude/commands'` |
| `<project>/.claude/rules/` | rules | `repo/.claude/rules/my-rule.md` | `libs/host-registry/src/claude.ts:245-248` — `buildSurfaces().rules.paths.project` = `'.claude/rules'` |
| `<project>/CLAUDE.md` | claude-md | `repo/CLAUDE.md` | `libs/host-registry/src/claude.ts:254-257` — `buildSurfaces()['claude-md'].paths.project` = `'CLAUDE.md'` |
| `<project>/.claude/settings.json` | settings | `repo/.claude/settings.json` | `libs/host-registry/src/claude.ts:298-301` — `buildSurfaces().settings.paths.project` = `'.claude/settings.json'` |
| `<project>/.claude/settings.local.json` | settings (local) | `repo/.claude/settings.local.json` | `libs/host-registry/src/claude.ts:279-280` — `buildSurfaces().settings.paths.local` = `'.claude/settings.local.json'` |
| `<project>/.mcp.json` | mcp-server | `repo/.mcp.json` | `libs/host-registry/src/claude.ts:311-314` — `buildSurfaces()['mcp-server'].paths.project` = `'.mcp.json'` |
| `<project>/.sox/` | service | `repo/.sox/services/`, `repo/.sox/registry.json` | `libs/host-registry/src/claude.ts:322-327` — `buildSurfaces().service.paths.project` = `'.sox'`. Per-service manifests at `<scopeRoot>/services/<id>.json` from `libs/install-engine/src/capabilities/run-service.ts:72-73` |

---

## 3. Host Placements — OpenCode

Configurable via `$SOX_SANDBOX_ROOT`. Surfaces from `libs/host-registry/src/opencode.ts`.

### 3a. User Scope (`~/.config/opencode/`)

| Surface | Template | Pattern | Real files | Path determined by |
|---------|----------|---------|------------|-------------------|
| agent | `~/.config/opencode/agents/<id>` | `N` installed agents | `~/.config/opencode/agents/planner.md` | `libs/host-registry/src/opencode.ts:72-75` — `scopePaths('user').user` = `path.join(getBase(), '.config', 'opencode')`. `buildSurfaces().agent.paths` = same base + `'/agents'` |
| skill | `~/.config/opencode/skills/<id>/` | `N` installed skills | `~/.config/opencode/skills/memory-usage/SKILL.md` | `libs/host-registry/src/opencode.ts:72-75` — base + `'/skills'` |
| tool | `~/.config/opencode/tools/<id>` | `N` installed tools | `~/.config/opencode/tools/my-tool` | `libs/host-registry/src/opencode.ts:72-75` — base + `'/tools'` |
| opencode config | `~/.config/opencode/opencode.json` | `1` | `~/.config/opencode/opencode.json` | `libs/host-registry/src/opencode.ts:72-75` — base + `'/opencode.json'` |

### 3b. Project Scope (`.opencode/`)

| Template | Surface | Real files | Path determined by |
|----------|---------|------------|-------------------|
| `<project>/.opencode/agents/` | agent | `repo/.opencode/agents/` | `libs/host-registry/src/opencode.ts:56-57` — `scopePaths('project').project` = `'.opencode'`. Surface appends `'/agents'` |
| `<project>/.opencode/skills/` | skill | `repo/.opencode/skills/` | `libs/host-registry/src/opencode.ts:56-57` — base + `'/skills'` |
| `<project>/.opencode/tools/` | tool | `repo/.opencode/tools/` | `libs/host-registry/src/opencode.ts:56-57` — base + `'/tools'` |
| `<project>/opencode.json` | opencode config | `repo/opencode.json` | `libs/host-registry/src/opencode.ts:56-57` — base + `'/opencode.json'` |

---

## 4. Host Placements — Codex

Configurable via `$CODEX_HOME` (defaults to `~/.codex/`) and `$SOX_SANDBOX_ROOT`.
Surfaces from `libs/host-registry/src/codex.ts`.

### 4a. User Scope (`~/.codex/`)

| Surface | Template | Pattern | Real files | Path determined by |
|---------|----------|---------|------------|-------------------|
| AGENTS.md | `~/.codex/AGENTS.md` | `1` | `~/.codex/AGENTS.md` | `libs/host-registry/src/codex.ts:217-221` — `buildSurfaces()['AGENTS.md'].paths.user` = `path.join(getCodexBase(), 'AGENTS.md')` |
| skill | `~/.codex/skills/<id>/` | `N` installed skills | `~/.codex/skills/my-skill/SKILL.md` | `libs/host-registry/src/codex.ts:238-242` — `buildSurfaces().skill.paths.user` = `path.join(getCodexBase(), 'skills')` |
| config | `~/.codex/config.toml` | `1` | `~/.codex/config.toml` | `libs/host-registry/src/codex.ts:248-256` — `buildSurfaces().config.paths.user` = `path.join(getCodexBase(), 'config.toml')` |

### 4b. Project Scope (`.codex/`)

| Template | Surface | Real files | Path determined by |
|----------|---------|------------|-------------------|
| `<project>/.codex/skills/` | skill | `repo/.codex/skills/` | `libs/host-registry/src/codex.ts:123-128` — `scopePaths('project').project` = `'.codex'`. Surface appends `'/skills'` |
| `<project>/.codex/config.toml` | config | `repo/.codex/config.toml` | `libs/host-registry/src/codex.ts:123-128` — base + `'/config.toml'` |

---

## 5. Memory Store

Permission-guarded to `~/.memory/**` (see `libs/memory-core/src/backup.ts:70`).

### 5a. Default Store & Registry

| Template | Package | Function | Dir exists | Pattern | Real files | Path determined by |
|----------|---------|----------|------------|---------|------------|-------------------|
| `~/.memory/memory.db` | `libs/memory-core/src/db.ts` | `openDb` (line 190) | `fs.mkdirSync(dir, {recursive:true})` (line 197) | `1` default | `~/.memory/memory.db` | `libs/memory-core/src/reembed.ts:118` — `defaultMemoryDbPath()` = `path.join(os.homedir(), '.memory', 'memory.db')`. Also the default when `db_path` omitted by caller |
| `~/.memory/memory.db-wal` | SQLite | SQLite WAL | (auto by sqlite) | `1` | `~/.memory/memory.db-wal` | Auto-created by SQLite alongside the `.db` file |
| `~/.memory/memory.db-shm` | SQLite | SQLite SHM | (auto by sqlite) | `1` | `~/.memory/memory.db-shm` | Auto-created by SQLite alongside the `.db` file |
| `~/.memory/registry.json` | `libs/memory-core/src/store-registry.ts` | `readStoreRegistry` (line 58) | `fs.mkdirSync(dir, {recursive:true})` (via write) | `1` | `~/.memory/registry.json` | `libs/memory-core/src/store-registry.ts:48-49` — `getRegistryPath()` = `path.join(os.homedir(), '.memory', 'registry.json')` |
| `~/.memory/registry.json` | `libs/memory-core/src/recall.ts` | `writeRegistry` (line 1017) | `fs.mkdirSync(path.dirname(REGISTRY_PATH), {recursive:true})` (line 1021) | `1` | `~/.memory/registry.json` | `libs/memory-core/src/recall.ts:1007` — `REGISTRY_PATH` = `path.join(process.env['HOME'] ?? '/tmp', '.memory', 'registry.json')` |

### 5b. Named Stores

| Template | Function | Dir exists | Pattern | Real files | Path determined by |
|----------|----------|------------|---------|------------|-------------------|
| `~/.memory/<name>.db` | `openDb` (db.ts:190) | `fs.mkdirSync(dir, {recursive:true})` (db.ts:197) | `N` named stores | `~/.memory/user.db`, `~/.memory/project.db` | Caller-provided `db_path` or store-registry name resolved via `libs/memory-core/src/db.ts:170-173` — `expandDbPath()` resolves `~` to `os.homedir()`. Named stores read from `~/.memory/registry.json` |

### 5c. Backup Files

| Template | Package | Function | Dir exists | Pattern | Real files | Path determined by |
|----------|---------|----------|------------|---------|------------|-------------------|
| `~/.memory/<name>.bak-reembed-<ts>` | `libs/memory-core/src/reembed.ts` | `reembedStore` (line 291) | (backup dir ensured) | `≤1` per reembed run | `~/.memory/memory.db.bak-reembed-20260721T120000Z` | `libs/memory-core/src/reembed.ts:282-291` — `backupPath = \`\${dbPath}.bak-reembed-\${ts}\``. The source `dbPath` is the store being reembedded (default `~/.memory/memory.db`) |
| `~/.memory/<dest>` | `libs/memory-core/src/backup.ts` | `backupStore` (line 154) | `fs.mkdirSync(path.dirname(resolvedDst), {recursive:true})` (line 154) | per explicit call | `~/.memory/backup-2026-07-21.db` | Caller-provided `destPath`. Guarded by `libs/memory-core/src/backup.ts:70-71` — `memoryAllowlistRoot()` = `path.join(os.homedir(), '.memory')`, checked by `isPathInMemoryAllowlist()` at line 78 |

### 5d. Export Directory

| Template | Package | Function | Dir exists | Pattern | Real files | Path determined by |
|----------|---------|----------|------------|---------|------------|-------------------|
| `<exportDir>/topics/<topic>/<uid>.md` | `libs/memory-core/src/export.ts` | `exportStore` (line 325) | `fs.mkdirSync(topicsRoot, {recursive:true})` (line 325), per-topic mkdir (line 327) | `N` episodes exported | `<exportDir>/topics/workflow/abc123.md` | `libs/memory-core/src/export.ts:302` — `topicsRoot = path.join(dir, 'topics')`. `dir` is caller-provided export dir. `destPath = path.join(topicsRoot, slug, \`\${ep.uid}.md\`)` at line 340 |
| `<exportDir>/topics/<topic>/INDEX.md` | `libs/memory-core/src/export.ts` | `exportStore` (line 325) | same | `1` per topic | `<exportDir>/topics/workflow/INDEX.md` | `libs/memory-core/src/export.ts:376-387` — `INDEX.md` written at `path.join(topicPath, 'INDEX.md')` |

Files matching: `N` episodes exported + `Ntopics` INDEX files.

### 5e. Writer Lock Files

| Template | Package | Function | Pattern | Real files | Path determined by |
|----------|---------|----------|---------|------------|-------------------|
| `<dbPath>.writer.lock` | `libs/memory-core/src/lease.ts` | `LockManager` (line 197) | `1` per open db | `~/.memory/memory.db.writer.lock` | `libs/memory-core/src/lease.ts:197` — `\`\${dbPath}.writer.lock\`` where `dbPath` is the store being opened |

---

## 6. OS Service Units

Generated by `libs/host-runtime/src/os-unit.ts`.

### 6a. macOS — launchd LaunchAgent

| Template | Function | Dir exists | Pattern | Real files | Path determined by |
|----------|----------|------------|---------|------------|-------------------|
| `~/Library/LaunchAgents/com.sox.<scope>.<id>.plist` | `enableOsUnit` (line 720) | `ensureDir(path.dirname(unitPath))` (line 699) | `1` per enabled service | `~/Library/LaunchAgents/com.sox.user.memory-server.plist` | `libs/host-runtime/src/os-unit.ts:393-398` — `LaunchdPlatform.defaultUnitDir()` = `path.join(os.homedir(), 'Library', 'LaunchAgents')`. `unitFileName(label)` = `\`\${label}.plist\`` where `label = \`com.sox.\${scope}.\${id}\`` |

Write mechanism: `writeFileAtomic` (os-unit.ts:702) — `writeFileSync(.tmp)` → `renameSync`.

### 6b. Linux — systemd User Unit

| Template | Function | Dir exists | Pattern | Real files | Path determined by |
|----------|----------|------------|---------|------------|-------------------|
| `~/.config/systemd/user/sox-<scope>-<id>.service` | `enableOsUnit` (line 720) | `ensureDir(path.dirname(unitPath))` (line 699) | `1` per enabled service | `~/.config/systemd/user/sox-user-memory-server.service` | `libs/host-runtime/src/os-unit.ts:540-548` — `SystemdPlatform.defaultUnitDir()` = `path.join(xdgBase, 'systemd', 'user')` where `xdgBase = $XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config')`. `unitFileName(label)` = `sox-\${tail}.service` where `tail = label.replace(/^com\.sox\./, '').replace(/\./g, '-')` |
| `~/.config/systemd/user/sox-<scope>-<id>.socket` | `enableOsUnit` → `renderSocketUnit` (line 610) | same | `≤1` per service (when has socket) | `~/.config/systemd/user/sox-user-tokenguard.socket` | `libs/host-runtime/src/os-unit.ts:610-627` — renders a `.socket` unit at the same base dir with `ListenStream=\${spec.socketPath}` |

Configurable via `$XDG_CONFIG_HOME` (defaults to `~/.config`).

### 6c. Service Logs (OS-unit stdout/stderr paths)

Derived from `logDirFor(supervisorId)`:

| Template | Real files | Path determined by |
|----------|------------|-------------------|
| `<logDir>/<label>.stdout.log` | `~/.adhd/sox-ecosystem/run/logs/a1b2c3d4e5f6/com.sox.user.memory-server.stdout.log` | `libs/host-runtime/src/os-unit.ts:441-457` — `spec.stdoutPath` / `spec.stderrPath` set by the caller of `enableOsUnit`. Typically `path.join(logDirFor(supervisorId), \`\${label}.stdout.log\`)` |
| `<logDir>/<label>.stderr.log` | `~/.adhd/sox-ecosystem/run/logs/a1b2c3d4e5f6/com.sox.user.memory-server.stderr.log` | same pattern — `\${label}.stderr.log` |

---

## 7. TokenGuard

Configurable via `SOX_CONFIG_MAP_PATH`, `SOX_CONFIG_CAPTURE_DIR`, `SOX_CONFIG_PORT`.
Defaults from `extensions/services/tokenguard/src/config.ts:81-83`.

| Template | Package | Function | Dir exists | Pattern | Real files | Path determined by |
|----------|---------|----------|------------|---------|------------|-------------------|
| `~/.tokenguard/token-mapping.json` | `extensions/services/tokenguard/src/mapstore.ts` | `appendEntry` (line 71), `atomicWrite` (line 34) | `fs.mkdirSync(path.dirname(mapPath), {recursive:true})` (line 79) | `1` | `~/.tokenguard/token-mapping.json` | `extensions/services/tokenguard/src/config.ts:81-86` — `defaultMapPath = \`\${home}/.tokenguard/token-mapping.json\``, overridable via `SOX_CONFIG_MAP_PATH` |
| `~/.tokenguard/token-mapping.json` | `libs/tokenguard-core/src/mapper.ts` | `Mapper._persist` (line 214) | (mapstore ensures) | `1` | `~/.tokenguard/token-mapping.json` | `this.persistPath` set in `Mapper` constructor from the `persistPath` parameter (same path as above) |
| `~/.tokenguard/token-mapping.json` | `extensions/services/tokenguard/src/index.ts` | periodic interval persist (line 269) | (mapstore ensures) | `1` | `~/.tokenguard/token-mapping.json` | `extensions/services/tokenguard/src/index.ts:272` — `config.mapPath` (same default from config.ts) |
| `~/.tokenguard/audit.jsonl` | `extensions/services/tokenguard/src/proxy.ts` | `appendAuditEntry` (line 50) | (captureDir ensured) | `1` | `~/.tokenguard/audit.jsonl` | `extensions/services/tokenguard/src/index.ts:256` — `auditPath = path.join(config.captureDir, 'audit.jsonl')`. `captureDir` from `extensions/services/tokenguard/src/config.ts:82-83` defaults to `~/\.tokenguard` |
| `<captureDir>/port.txt` | `extensions/services/tokenguard/src/proxy.ts` | startProxy (line 191) | `fs.mkdirSync(storePath, {recursive:true})` (line 191) | `1` | `~/.tokenguard/port.txt` | `extensions/services/tokenguard/src/proxy.ts:190-192` — `path.join(storePath, 'port.txt')`. `storePath = config.captureDir` |
| `~/.tokenguard/token-mapping.json` | `extensions/services/tokenguard/src/mapstore.ts` | `appendEntry` (line 93) | `fs.mkdirSync(path.dirname(mapPath), {recursive:true})` (line 79) | `1` | `~/.tokenguard/token-mapping.json` | Same as above — `mapPath` parameter for the CLI seed append |

---

## 8. MCP Runtime Sockets

| Template | Package | Function | Dir exists | Pattern | Real files | Path determined by |
|----------|---------|----------|------------|---------|------------|-------------------|
| `<home>/.sox/sockets/<name>.sock` | `libs/mcp-runtime/src/serve.ts` | `resolveDefaultUdsPath` (line 269) | (caller ensures) | `1` per named server | `~/.sox/sockets/memory-server.sock` | `libs/mcp-runtime/src/serve.ts:269-271` — `resolveDefaultUdsPath(name)` = `\`\${home}/.sox/sockets/\${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.sock\`` where `home = process.env['HOME'] ?? '/tmp'` |

Configurable via `--socket-path` or `$SOX_CONFIG_SOCK_PATH`.

---

## 9. Service-Proxy Backend Locks & Backend Stderr

### 9a. Spawn Locks

| Template | Package | Function | Dir exists | Pattern | Real files | Path determined by |
|----------|---------|----------|------------|---------|------------|-------------------|
| `<lockDir>/proxy-backend-<hash8>.lock` | `libs/service-proxy/src/ensure-backend.ts` | `ensureBackend` (line 288) | `fs.mkdirSync(lockDir, {recursive:true, mode:0o700})` (line 301) | `1` per singleton key | `~/.adhd/sox-ecosystem/run/supervisors/proxy-backend-a1b2c3d4.lock` | `libs/service-proxy/src/ensure-backend.ts:293` — `lockDir = opts.lockDir ?? path.dirname(opts.socketPath)`. `lockName(key)` at line 204-213 computes `proxy-backend-\${fnv1a(key).toString(16)}.lock`. The socket path default: `libs/host-runtime/src/data-paths.ts:156` `socketDir()` = `path.join(runDir(), 'supervisors')` |

`lockDir` defaults to `path.dirname(socketPath)`, which is `socketDir()` = `<userDataRoot>/run/supervisors/`.

### 9b. Backend Stderr Logs

| Template | Package | Function | Dir exists | Pattern | Real files | Path determined by |
|----------|---------|----------|------------|---------|------------|-------------------|
| `<logDir>/<extId>-backend-<YYYY-MM-DD>.log` | `apps/sox/src/main.ts` | `updateProxyModeUpgrade` (line 2334), `cmdServe` (line 8214) | (logDir ensured by `logDirFor`) | `≤7` per extId | `~/.adhd/sox-ecosystem/run/logs/proxy-backend-memory-server/memory-server-backend-2026-07-21.log` | `apps/sox/src/main.ts:2334-2336` — `backendLogDirRB = logDirFor(\`proxy-backend-\${extId}\`)`, `backendLogPathRB = pathMRB.join(backendLogDirRB, \`\${extId}-backend-\${backendLogDateRB}.log\`)`. `logDirFor()` at `libs/host-runtime/src/data-paths.ts:150-151` |

---

## 10. Schema Cache

| Template | Package | Function | Dir exists | Pattern | Real files | Path determined by |
|----------|---------|----------|------------|---------|------------|-------------------|
| `<serverDistDir>/schema.json` | `extensions/bundles/sox-memory-bundle/members/memory-server/src/backend.ts` | `publishSchema` (line 63) | `fs.mkdirSync(path.dirname(schemaPath), {recursive:true})` (line 65) | `1` per bundle version | `<dist>/schema.json` | `schemaPath` is caller-provided, injected as env `SOX_PROXY_BACKEND_SCHEMA` (`apps/sox/src/main.ts:2327`) — typically `path.join(extDir, 'dist', 'schema.json')` |

---

## 11. Legacy Paths (pre-ADR-0004)

Detected and migrated by `soxe migrate-home` in `apps/sox/src/main.ts`. These paths
were hard-coded before `data-paths.ts` and `ownership.json` existed.

| Path | Package | Original writer function | Status | Path determined by |
|------|---------|--------------------------|--------|-------------------|
| `~/.sox/install-registry.json` | `apps/sox/src/main.ts` | `cmdList`, `cmdInstall` (lines 3432, 3501) | Migrated to `<userDataRoot>/install-registry.json` | Hard-coded `~/.sox/install-registry.json` pre-ADR-0004 |
| `~/.sox/supervisors.json` | `apps/sox/src/main.ts` | `registerSupervisor` (lines 3501, 6390) | Migrated to `<userDataRoot>/supervisors.json` | Hard-coded `~/.sox/supervisors.json` pre-ADR-0004 |
| `~/.config/extensions/extensions.json` | `apps/sox/src/main.ts` | `cmdInstall` (lines 5914, 5999) | Migrated to `<dataRoot>/extensions.json` | Hard-coded `~/.config/extensions/extensions.json` pre-ADR-0004 |
| `~/.config/extensions/extensions.lock` | `apps/sox/src/main.ts` | `cmdInstall` (lines 5914, 5999) | Migrated to `<dataRoot>/extensions.lock` | Hard-coded `~/.config/extensions/extensions.lock` pre-ADR-0004 |

---

## 12. Per-Project Scope Paths

These paths are relative to the project root and live **inside** checkouts.
Listed for completeness — they are NOT external to the project, but are managed
by soxe automation.

| Path | Contents | Written by | Path determined by |
|------|----------|------------|-------------------|
| `.adhd/sox-ecosystem/extensions.json` | Project scope config | `apps/sox/src/main.ts:1497` | `libs/host-runtime/src/data-paths.ts:109` · `libs/install-engine/src/data-paths.ts:92` — `scopeConfigPaths('project', root).config` |
| `.adhd/sox-ecosystem/extensions.lock` | Project scope lock | `libs/install-engine/src/install.ts:462` | `libs/host-runtime/src/data-paths.ts:110` · `libs/install-engine/src/data-paths.ts:93` — `scopeConfigPaths('project', root).lockfile` |
| `.adhd/sox-ecosystem/ledger.json` | Project provenance | `libs/install-engine/src/ledger.ts` | `libs/host-runtime/src/data-paths.ts:116` · `libs/install-engine/src/data-paths.ts:99` — `ledgerPathFor('project', root)` |
| `.adhd/sox-ecosystem/ownership.json` | Project ownership | `libs/install-engine/src/ownership.ts:79` | `libs/host-runtime/src/data-paths.ts:121` · `libs/install-engine/src/data-paths.ts:104` — `ownershipPathFor('project', root)` |
| `.adhd/sox-ecosystem/ext/` | Project materialized store | `libs/install-engine/src/capabilities/materialize.ts:126` | `libs/host-runtime/src/data-paths.ts:126` · `libs/install-engine/src/data-paths.ts:109` — `storeRootFor('project', root)` = `dataRoot('project', root) + '/ext'` |
| `.adhd/sox-ecosystem/services/<id>.json` | Service manifest | `libs/install-engine/src/capabilities/run-service.ts:89` | `libs/install-engine/src/capabilities/run-service.ts:72-73` — `manifestPath(scopeRoot, serviceId)` = `path.join(scopeRoot, 'services', \`\${serviceId}.json\`)` |
| `.adhd/sox-ecosystem/registry.json` | Service registry | `libs/install-engine/src/capabilities/run-service.ts:110` | `libs/install-engine/src/capabilities/run-service.ts:110` — `registryPath = path.join(scopeRoot, 'registry.json')` |
| `.claude/agents/` | Claude agents | `libs/install-engine/src/capabilities/file-drop.ts:108` | `libs/host-registry/src/claude.ts:217-220` — `buildSurfaces().agent.paths.project` = `'.claude/agents'` |
| `.claude/skills/` | Claude skills | file-drop | `libs/host-registry/src/claude.ts:225-228` — `buildSurfaces().skill.paths.project` |
| `.claude/commands/` | Claude commands | file-drop | `libs/host-registry/src/claude.ts:233-239` — `buildSurfaces().command.paths.project` |
| `.claude/rules/` | Claude rules | file-drop | `libs/host-registry/src/claude.ts:245-248` — `buildSurfaces().rules.paths.project` |
| `.claude/settings.json` | Claude settings | config-merge | `libs/host-registry/src/claude.ts:298-301` — `buildSurfaces().settings.paths.project` |
| `.claude/settings.local.json` | Claude local settings | config-merge | `libs/host-registry/src/claude.ts:279-280` — `buildSurfaces().settings.paths.local` |
| `.mcp.json` | MCP server config | config-merge | `libs/host-registry/src/claude.ts:311-314` — `buildSurfaces()['mcp-server'].paths.project` |
| `CLAUDE.md` | Claude MD | file-drop | `libs/host-registry/src/claude.ts:254-257` — `buildSurfaces()['claude-md'].paths.project` |
| `.codex/skills/` | Codex skills | file-drop | `libs/host-registry/src/codex.ts:123-128` + surface appends `'/skills'` |
| `.codex/config.toml` | Codex config | config-merge | `libs/host-registry/src/codex.ts:123-128` + surface appends `'/config.toml'` |
| `.opencode/agents/` | OpenCode agents | file-drop | `libs/host-registry/src/opencode.ts:56-57` — `scopePaths('project').project` = `'.opencode'` + `'/agents'` |
| `.opencode/skills/` | OpenCode skills | file-drop | same base + `'/skills'` |
| `.opencode/tools/` | OpenCode tools | file-drop | same base + `'/tools'` |
| `opencode.json` | OpenCode config | config-merge | same base + `'/opencode.json'` |

---

## 13. Test Artifacts

| Template | Written by | Dir exists | Cleanup | Path determined by |
|----------|------------|------------|---------|-------------------|
| `<os.tmpdir()>/sox-*/` | All `.spec.ts` files | `fs.mkdtempSync(...)` | Best-effort in `afterAll`/`afterEach` | Each spec's `mkdtempSync` call — e.g. `fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl50-'))` |
| `~/.memory/sox-e2e-<pid>.db` | `tools/test-e2e-lifecycle.js:48` | `fs.mkdirSync(.../.memory/, ...)` (line 407) | Manual or `rm -rf` | `tools/test-e2e-lifecycle.js:47-48` — `path.join(os.homedir(), '.memory', \`sox-e2e-\${process.pid}.db\`)` |
| `~/.claude/agents/sox-e2e-agent-*.md` | `tools/test-e2e-lifecycle.js:1303` | `fs.mkdirSync` (line 1317) | Cleaned up in `process.on('exit')` (line 1297) | `tools/test-e2e-lifecycle.js:1320-1322` — `path.join(os.homedir(), '.claude', 'agents', \`sox-e2e-agent-\${id}.md\`)` |

---

## Summary: Top-Level External Directories

| Directory | Configurable? | Entries | Uniqueness Key |
|-----------|--------------|---------|----------------|
| `~/.adhd/sox-ecosystem/` | `$SOX_ECOSYSTEM_HOME` | ~20 files/dirs | Per scope |
| `~/.memory/` | `$db_path` (within allowlist) | ~6 files/dirs + N named stores | Per named store |
| `~/.claude/` | `$SOX_SANDBOX_ROOT` | ~10 dirs + 3 config files | Per host+scope |
| `~/.config/opencode/` | `$SOX_SANDBOX_ROOT` | ~3 dirs + 1 config file | Per host+scope |
| `~/.codex/` | `$CODEX_HOME`, `$SOX_SANDBOX_ROOT` | ~1 dir + 1 config file | Per host+scope |
| `~/Library/LaunchAgents/` | `$SOX_OS_UNIT_DIR` | ~N plists | Per enabled service |
| `~/.config/systemd/user/` | `$XDG_CONFIG_HOME` | ~N .service + .socket | Per enabled service |
| `~/.tokenguard/` | `SOX_CONFIG_*` | ~3 files | Per tokenguard instance |
| `~/.sox/` | LEGACY | ~3 files + sockets dir | (migrated away) |
| `<os.tmpdir()>/sox-*/` | FIXED | ~50+ test dirs | Per test invocation |

---

## 14. Centralization Blast Radius (excluding host placements)

Analysis of the impact of consolidating all external write path templates into a
single common configuration library. Host placements (Claude, OpenCode, Codex)
are excluded — they are governed by a separate subsystem
(`libs/host-registry/src/`) with its own 12 surface types and sandbox isolation.

Counts are per unique file path (cross-category duplicates subtracted).

### 14a. Files requiring logic changes (must alter path construction)

The **17 definition files** whose path-building logic moves into the new library:

| # | File | Symbols |
|---|------|---------|
| A1 | `libs/host-runtime/src/data-paths.ts` | All 15 ADR-0004 resolvers |
| A2 | `libs/install-engine/src/data-paths.ts` | Parity copy of all 15 |
| B1 | `libs/memory-core/src/db.ts` | `expandDbPath` |
| B2 | `libs/memory-core/src/reembed.ts` | `defaultMemoryDbPath` |
| B3 | `libs/memory-core/src/store-registry.ts` | `getRegistryPath` |
| B4 | `libs/memory-core/src/recall.ts` | `REGISTRY_PATH`, `writeRegistry` |
| B5 | `libs/memory-core/src/backup.ts` | `memoryAllowlistRoot`, `backupStore` |
| B6 | `libs/memory-core/src/export.ts` | `exportStore` topics path |
| C1 | `extensions/services/tokenguard/src/config.ts` | `defaultMapPath`, `defaultCaptureDir` |
| C2 | `extensions/services/tokenguard/src/mapstore.ts` | `atomicWrite` path |
| C3 | `extensions/services/tokenguard/src/proxy.ts` | `port.txt`, `auditPath` |
| C4 | `libs/tokenguard-core/src/mapper.ts` | `_persist` path |
| D1 | `libs/mcp-runtime/src/serve.ts` | `resolveDefaultUdsPath` |
| D2 | `libs/service-proxy/src/socket-path.ts` | `backendSocketPath` |
| D3 | `libs/service-proxy/src/ensure-backend.ts` | `lockName` (lock path) |
| E1 | `memory-server/src/backend.ts` | `publishSchema` path |
| F1 | `apps/sox/src/main.ts` | `migrate-home` hardcoded old paths |

### 14b. Files requiring import-path updates only

These call path resolvers from the definition files but do not construct paths
themselves. A new library only changes their import statements.

**Re-export files (4):**

| # | File | New import target |
|---|------|-------------------|
| R1 | `libs/host-runtime/src/index.ts` | `@adhd/sox-common-paths` (replaces `./data-paths.js`) |
| R2 | `libs/install-engine/src/index.ts` | `@adhd/sox-common-paths` (replaces `./data-paths.js`) |
| R3 | `libs/memory-core/src/index.ts` | `@adhd/sox-common-paths` (replaces internal) |
| R4 | `libs/service-proxy/src/index.ts` | `@adhd/sox-common-paths` (replaces `./socket-path.js`) |

**Production callers (38):**

| # | File | Symbols used |
|---|------|--------------|
| P1 | `libs/host-runtime/src/crash-loop.ts` | `runDir` |
| P2 | `libs/host-runtime/src/lock.ts` | `runDir` |
| P3 | `libs/host-runtime/src/registry.ts` | `supervisorsPath` |
| P4 | `libs/host-runtime/src/runtime.ts` | `logDirFor`, `scopeConfigPaths`, `socketDir` |
| P5 | `libs/host-runtime/src/log-manager.ts` | `logDirFor` (lazy `require`) |
| P6 | `libs/install-engine/src/ownership.ts` | `ownershipPathFor` |
| P7 | `libs/install-engine/src/ledger.ts` | `ledgerPathFor` |
| P8 | `libs/install-engine/src/install-registry.ts` | `installRegistryPath` |
| P9 | `libs/install-engine/src/install.ts` | `scopeConfigPaths`, `storeRootFor` |
| P10 | `libs/install-engine/src/mcp-project-sync.ts` | `dataRoot`, `ownershipPathFor` |
| P11 | `libs/install-engine/src/mcp-trust-sync.ts` | `ownershipPathFor` |
| P12 | `libs/install-engine/src/capabilities/materialize.ts` | `storeRootFor` |
| P13 | `apps/sox/src/main.ts` | All resolvers (static + lazy) |
| P14 | `libs/memory-core/src/backup.ts` | `expandDbPath` |
| P15 | `libs/memory-core/src/store-registry.ts` | `expandDbPath` |
| P16 | `libs/memory-core/src/reembed.ts` | `expandDbPath` |
| P17 | `libs/memory-core/src/db.ts` | `closeDbWithLease` |
| P18 | `libs/memory-core/src/lease.ts` | Writer lock derivation |
| P19 | `memory-cli/src/index.ts` | `writeRegistry`, `backupStore`, `exportMarkdown` |
| P20 | `memory-flush/src/index.ts` | `exportMarkdown` |
| P21 | `memory-server/src/backend.ts` | `closeAllDbs` |
| P22 | `extensions/services/tokenguard/src/cli.ts` | `appendEntry`, `readEntries` |
| P23 | `extensions/services/tokenguard/src/index.ts` | Mapper, `auditPath` |
| P24 | `libs/tokenguard-core/src/mapper.ts` | `_persist` |
| P25 | `libs/tokenguard-core/src/index.ts` | Re-exports `Mapper` |
| P26 | `libs/tokenguard-core/src/sse.ts` | `Mapper` type import |
| P27 | `libs/tokenguard-core/src/detectors.ts` | `Mapper` type import |
| P28 | `libs/tokenguard-core/src/tokenize.ts` | `Mapper` type import |
| P29 | `libs/host-runtime/src/supervisor.ts` | `port.txt` polling |
| P30 | `libs/host-runtime/src/loader.ts` | `LogManager` + `port.txt` |
| P31 | `libs/service-proxy/src/backend.ts` | `probeSocketLive` |
| P32 | `libs/service-proxy/src/shim.ts` | `ensureBackend` reference |
| P33 | `apps/sox/src/main.ts` | `ensureBackend`, `backendSocketPath`, `publishSchema` |
| P34 | `libs/mcp-runtime/src/serve.ts` | `resolveDefaultUdsPath` |
| P35 | `libs/service-proxy/src/socket-path.ts` | `backendSocketPath` |
| P36 | `libs/service-proxy/src/ensure-backend.ts` | `lockName`, `tryAcquireLock` |
| P37 | `libs/host-runtime/src/gc.ts` | `supervisorsPath`, socket unlink |
| P38 | `libs/host-runtime/src/reaper.ts` | `logDir`, socket path |

### 14c. Test files (28)

All test files that import path definition symbols. Most only need import-path
updates; a few construct inline paths that need semantic revision:

| # | File | Nature of change |
|---|------|------------------|
| T1 | `libs/host-runtime/src/data-paths.spec.ts` | import + assertions |
| T2 | `libs/install-engine/src/data-paths.parity.spec.ts` | **Eliminate this test** (no parity to guard) |
| T3 | `libs/install-engine/src/project-root.spec.ts` | import |
| T4 | `libs/memory-core/src/db.spec.ts` | import |
| T5 | `libs/memory-core/src/store-registry.spec.ts` | import |
| T6 | `libs/memory-core/src/backup.spec.ts` | import |
| T7 | `libs/memory-core/src/export.spec.ts` | import |
| T8 | `libs/memory-core/src/lease.spec.ts` | import |
| T9 | `libs/memory-core/src/chaos/kill9-recovery.chaos.spec.ts` | import |
| T10 | `libs/service-proxy/src/socket-path.spec.ts` | import |
| T11 | `libs/service-proxy/src/ensure-backend.spec.ts` | import |
| T12 | `libs/host-runtime/src/reconcile.spec.ts` | import + inline socket path |
| T13 | `memory-server/src/backend.spec.ts` | import |
| T14 | `memory-cli/src/index.spec.ts` | import |
| T15 | `memory-flush/src/index.spec.ts` | import |
| T16 | `memory-server/src/enrichment-health.spec.ts` | import |
| T17 | `memory-server/src/memory-recall-listing.spec.ts` | import |
| T18 | `memory-server/src/permission-guard.spec.ts` | import |
| T19 | `memory-server/src/memory-link-tool.spec.ts` | import |
| T20 | `memory-server/src/embed-health-surface.spec.ts` | import |
| T21 | `memory-server/src/async-embed.spec.ts` | import |
| T22 | `memory-server/src/memory-tools.spec.ts` | import |
| T23 | `memory-server/recall-sqlite.test.ts` | import |
| T24 | `tools/baseline-capture/src/capture-enrichment-baseline.spec.ts` | import |
| T25 | `apps/sox/src/bl36-bl178-bl57.spec.ts` | import + inline paths |
| T26 | `apps/sox/src/status-rendering.spec.ts` | **Inline `run/logs/` path** |
| T27 | `apps/sox/src/doctor-reconcile.spec.ts` | **Inline `run/logs/` path** |
| T28 | `extensions/services/tokenguard/test/smoke.spec.ts` | import |

### 14d. Tool / script files (7)

| # | File | Change |
|---|------|--------|
| S1 | `tools/probe-adr0004-placement.mjs` | import |
| S2 | `tools/probe-adr0004-reversibility.mjs` | import |
| S3 | `tools/probe-adr0004-migrate-home.mjs` | import |
| S4 | `tools/baseline-capture/src/capture-write-perf-baseline.ts` | import |
| S5 | `tools/baseline-capture/src/capture-enrichment-baseline.ts` | import |
| S6 | `tools/test-e2e-lifecycle.js` | inline paths + imports |
| S7 | `scripts/smoke-test.mjs` | import |

### 14e. Documentation files (6)

| # | File | References |
|---|------|------------|
| D1 | `docs/spec/service-lifecycle.md` | `run/logs/` paths |
| D2 | `docs/audits/RUNTIME_FS_WRITES.md` | (this document) |
| D3 | `docs/decisions/0004-data-root-placement-and-ownership-index.md` | Legacy path references |
| D4 | `docs/mcp-global-availability.md` | Socket path references |
| D5 | `README.md` | Install paths |
| D6 | `USAGE.md` | Install paths |

### 14f. Summary

| Layer | Count | Nature |
|-------|-------|--------|
| Definition files | 17 | Path logic **moves** to common lib |
| Re-export files | 4 | Import **redirects** |
| Production callers | 38 | Import **rewrites** |
| Parity guard (T2) | 1 test | **Eliminated** — no parity to guard |
| Other tests | 27 | Import **rewrites** or assertion **updates** |
| Tool/script files | 7 | Import **rewrites** |
| Documentation | 6 | Reference **updates** |
| **Total unique files** | **~72** | |

**Risk (GitNexus): HIGH** — `LogManager` alone shows 23 impacted symbols,
2 execution flows (`main`, `dispatchToAdapter`), and 6 direct callers.

---

## 15. Existing Sandbox / Testing Harnesses

Four environment variables and several existing test harnesses can simulate
all of these external writes within a temp directory, enabling safe testing
of centralization changes without touching real home directories or services.

### 15a. Env var sandboxing mechanisms

Each env var covers a different slice of the audit's external write surface:

| Env var | Coverage (audit §) | Mechanism |
|---------|-------------------|-----------|
| `SOX_ECOSYSTEM_HOME` | **§1** ADR-0004 data root (configs, locks, ledger, ownership, materialized store, install-registry, supervisors, runtime dir, locks, logs, sockets, crash-loop markers, audit) + **§12** per-project scope | `libs/host-runtime/src/data-paths.ts:42-46` — `userDataRoot()` checks this before falling back to `~/.adhd/sox-ecosystem/` |
| `HOME` | **§5** Memory store (`~/.memory/*`), **§7** TokenGuard defaults (`~/.tokenguard/*`), **§8** legacy MCP sockets (`~/.sox/sockets/*`), **§11** legacy paths (`~/.sox/*`, `~/.config/extensions/*`) | All path resolvers in `libs/memory-core/src/`, `extensions/services/tokenguard/src/config.ts`, `libs/mcp-runtime/src/serve.ts` use `os.homedir()` or `process.env.HOME` |
| `SOX_CONFIG_MAP_PATH` | **§7** TokenGuard token-mapping.json override | `extensions/services/tokenguard/src/config.ts:85-87` — overrides default `~/.tokenguard/token-mapping.json` |
| `SOX_CONFIG_CAPTURE_DIR` | **§7** TokenGuard audit.jsonl + port.txt override | `extensions/services/tokenguard/src/config.ts:89-91` — overrides default `~/.tokenguard` |
| `SOX_SANDBOX_ROOT` | **§2-4** Host placements (excluded from §14 blast radius but available when needed) | `libs/host-registry/src/` — reroots all user-scope placement paths |
| `SOX_RUNTIME_FILE` | **§1g** runtime.json path override | `libs/host-runtime/src/runtime.ts:808` — `getRuntimeFilePath()` checks this |

### 15b. Combined sandbox recipe

Setting all relevant env vars to the same temp dir redirects every external
write path (except host placements) under a single throwaway root:

```js
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-centralization-'));
process.env.SOX_ECOSYSTEM_HOME = sandbox;  // §1 ADR-0004 data root
process.env.HOME = sandbox;                 // §5 memory, §7 tokenguard, §8, §11
process.env.SOX_RUNTIME_FILE =             // §1g runtime.json (optional)
  path.join(sandbox, 'runtime.json');
```

After this, every path from **§1, §5, §7, §8, §10, §11, §12** resolves under
`sandbox/`. No real home directories are touched.

### 15c. Existing test harnesses that use these mechanisms

| Harness | File | Sandbox strategy | What it exercises |
|---------|------|------------------|-------------------|
| **e2e lifecycle** | `tools/test-e2e-lifecycle.js` | Sets `SOX_SANDBOX_ROOT`, `SOX_ECOSYSTEM_HOME`, `HOME` to temp dirs; restores on exit | Full install/start/stop/uninstall across all scopes; host placements; service lifecycle; memory recall; tokenguard proxy |
| **Hermetic data-root** | `scripts/test-env-setup.ts` | Sets `SOX_ECOSYSTEM_HOME` + `HOME` | "Hermetic data-root sandbox for root test suites" |
| **ADR-0004 probes** | `tools/probe-adr0004-placement.mjs` | Sets `HOME` to temp, unsets `SOX_SANDBOX_ROOT` | Verifies host placement paths resolve correctly |
| **ADR-0004 reversibility** | `tools/probe-adr0004-reversibility.mjs` | Child process with `HOME` = temp | Verifies uninstall removes every placed file |
| **ADR-0004 migrate-home** | `tools/probe-adr0004-migrate-home.mjs` | Child process with `HOME` = temp | Verifies legacy-to-ADR-0004 migration |
| **MCP trust sync** | `tools/probe-mcp-trust-sync.mjs` | Sets `HOME` = temp, unsets `SOX_SANDBOX_ROOT` | Verifies MCP trust entries in `~/.claude.json` |
| **Unit tests** | Various `*.spec.ts` | Each creates a `mkdtempSync` + overrides `HOME`/`SOX_ECOSYSTEM_HOME` | Per-function path resolution tests |

### 15d. What's missing

No single harness today wires ALL env vars together in a single temp dir while
also exercising every §1-§13 path type. The closest is `tools/test-e2e-lifecycle.js`,
which sets all three root env vars but is focused on lifecycle orchestration
(install/serve/stop/uninstall) rather than exhaustive path enumeration.

A dedicated centralization test would be:

```js
const sandbox = fs.mkdtempSync('/tmp/sox-ctest-');
process.env.SOX_ECOSYSTEM_HOME = sandbox;
process.env.HOME = sandbox;

// Then exercise every path resolver:
import { logDirFor, userDataRoot, ... } from '@adhd/sox-host-runtime';
import { openDb } from '@adhd/sox-memory-core';
import { appendEntry } from 'extensions/services/tokenguard/src/mapstore';
// ... assert every path starts with sandbox
```

---

## 16. Path Classification — Scoping Model

Every external write path classified along two dimensions:

**Package-scoped vs System-scoped**: Does the path contain an extension/package
identifier that differentiates it, or is it a singleton shared by all?

**Scoped path vs Scoped configuration variable**: Is the differentiation
achieved by the path template itself (e.g. `/<extId>/`), or by an env-var
override that changes the base for all paths?

### 16a. Classification table

| Audit § | Template | Config variable | Package-scoped | System-scoped | Scoped path | Scoped config var |
|---------|----------|---------------|----------------|---------------|-------------|-------------------|
| **ADR-0004 data root** | | | | | | |
| 1a | `<dataRoot>/extensions.json` | `SOX_ECOSYSTEM_HOME` | — | ✓ (1 per scope) | — | ✓ |
| 1a | `<dataRoot>/extensions.lock` | `SOX_ECOSYSTEM_HOME` | — | ✓ (1 per scope) | — | ✓ |
| 1a | `<dataRoot>/extensions.local.json` | `SOX_ECOSYSTEM_HOME` | — | ✓ (1 per scope) | — | ✓ |
| 1b | `<dataRoot>/ledger.json` | `SOX_ECOSYSTEM_HOME` | — | ✓ (1 per scope) | — | ✓ |
| 1c | `<dataRoot>/ownership.json` | `SOX_ECOSYSTEM_HOME` | — | ✓ (1 per scope) | — | ✓ |
| 1d | `<dataRoot>/ext/<extId>@<version>/` | `SOX_ECOSYSTEM_HOME` | ✓ | — | ✓ | — |
| 1e | `<userDataRoot>/install-registry.json` | `SOX_ECOSYSTEM_HOME` | — | ✓ (global) | — | ✓ |
| 1f | `<userDataRoot>/supervisors.json` | `SOX_ECOSYSTEM_HOME` | — | ✓ (global) | — | ✓ |
| 1g | `<runDir>/locks/<supervisorId>.lock` | `SOX_ECOSYSTEM_HOME` | ✓ | — | ✓ | — |
| 1g | `<lockfileDir>/runtime.json` | `SOX_ECOSYSTEM_HOME`, `SOX_RUNTIME_FILE` | ✓ | — | ✓ | ✓ |
| 1g | `<runDir>/sox-audit.jsonl` | `SOX_ECOSYSTEM_HOME` | — | ✓ (global) | — | ✓ |
| 1g | `<runDir>/crash-loop/<key>.json` | `SOX_ECOSYSTEM_HOME` | ✓ | — | ✓ | — |
| 1g | `<logDir>/<extId>-<date>.log` | `SOX_ECOSYSTEM_HOME` | ✓ | — | ✓ | — |
| 1g | `<logDir>/run-history.json` | `SOX_ECOSYSTEM_HOME` | ✓ | — | ✓ | — |
| 1g | `<socketDir>/proxy-<safeKey>.sock` | `SOX_ECOSYSTEM_HOME` | ✓ | — | ✓ | — |
| **Host placements** | | | | | | |
| 2-4 | `~/.claude/*`, `~/.codex/*`, `~/.config/opencode/*` | `SOX_SANDBOX_ROOT` | ✓ (by surface type + extId) | — | ✓ | ✓ |
| **Memory store** | | | | | | |
| 5a | `~/.memory/memory.db` | `$HOME` | — | ✓ (default store) | — | ✓ |
| 5a | `~/.memory/registry.json` | `$HOME` | — | ✓ (global) | — | ✓ |
| 5b | `~/.memory/<name>.db` | `$HOME` | ✓ | — | ✓ | — |
| 5c | `<dbPath>.bak-reembed-<ts>` | `$HOME` | ✓ | — | ✓ | — |
| 5d | `<dir>/topics/<topic>/<uid>.md` | — (caller-provided) | — | — (per export) | ✓ | — |
| 5e | `<dbPath>.writer.lock` | `$HOME` | ✓ | — | ✓ | — |
| **OS service units** | | | | | | |
| 6a | `~/Library/LaunchAgents/com.sox.<scope>.<id>.plist` | `SOX_OS_UNIT_DIR` | ✓ | — | ✓ | ✓ |
| 6b | `~/.config/systemd/user/sox-<scope>-<id>.service` | `$XDG_CONFIG_HOME` | ✓ | — | ✓ | ✓ |
| 6b | `~/.config/systemd/user/sox-<scope>-<id>.socket` | `$XDG_CONFIG_HOME` | ✓ | — | ✓ | ✓ |
| 6c | `<logDir>/<label>.stdout.log` | `SOX_ECOSYSTEM_HOME` | ✓ | — | ✓ | — |
| **TokenGuard** | | | | | | |
| 7 | `~/.tokenguard/token-mapping.json` | `SOX_CONFIG_MAP_PATH`, `$HOME` | — | ✓ (1 per instance) | — | ✓ |
| 7 | `~/.tokenguard/audit.jsonl` | `SOX_CONFIG_CAPTURE_DIR`, `$HOME` | — | ✓ (1 per instance) | — | ✓ |
| 7 | `<captureDir>/port.txt` | `SOX_CONFIG_CAPTURE_DIR` | — | ✓ (1 per instance) | — | ✓ |
| **MCP sockets** | | | | | | |
| 8 | `<home>/.sox/sockets/<name>.sock` | `$HOME`, `SOX_CONFIG_SOCK_PATH` | ✓ | — | ✓ | ✓ |
| **Service-proxy** | | | | | | |
| 9a | `<lockDir>/proxy-backend-<hash8>.lock` | `SOX_ECOSYSTEM_HOME` | ✓ | — | ✓ | — |
| 9b | `<logDir>/<extId>-backend-<date>.log` | `SOX_ECOSYSTEM_HOME` | ✓ | — | ✓ | — |
| **Schema cache** | | | | | | |
| 10 | `<serverDistDir>/schema.json` | `SOX_PROXY_BACKEND_SCHEMA` | ✓ | — | ✓ | ✓ |

### 16b. Summary by category

| Classification | Count | Files matching |
|----------------|-------|----------------|
| **Package-scoped + Scoped path** | **16** | materialized store, locks, runtime records, crash-loop markers, logs, run-history, exec sockets, memory named stores, backups, writer locks, OS units, OS unit logs, proxy locks, backend logs, schema cache, MCP sockets |
| **Package-scoped + Scoped config var** | **2** | runtime.json (`SOX_RUNTIME_FILE`), MCP sockets (`SOX_CONFIG_SOCK_PATH`) |
| **System-scoped + Scoped config var** | **15** | extensions config/lock/ledger/ownership, install-registry, supervisors, audit log, memory default db, memory registry, tokenguard files (3), host placements base, OS unit base dirs |

### 16c. Key insight

**16 of 33** distinct path templates are package-scoped through the path
itself — the package/extension identifier is a path segment. Only **2** use
a configuration variable for package-level scoping. The remaining **15** are
system-global singletons that vary only by scope (user/project/local) via a
configuration variable root.

This means a centralized path library primarily needs to support a **path
template DSL** where callers supply the package/extension identifier as a
parameter, rather than a set of per-package configuration variables. The
configuration variable pattern (`SOX_ECOSYSTEM_HOME`, `$HOME`) is reserved
for the top-level data root — everything beneath it is deterministic from
the template and the caller's context.

---

## 17. Two-Package Design — Migration Architecture

Proposed architecture for centralizing all external write paths (excluding host
placements §2-4 per prior scope) into two new packages: a configuration
management library and a logging apparatus.

### 17a. Package boundaries

```
┌──────────────────────────────────────────────────────────────────┐
│  @adhd/sox-config — Generalized Configuration Management        │
│                                                                  │
│  Owns EVERY path template. Each resolver returns a path under   │
│  .adhd/<namespace>/<package>/<resource>/[<segments>].           │
│                                                                  │
│  src/                                                            │
│    index.ts        — re-exports all resolvers                    │
│    root.ts         — userDataRoot, dataRoot, memoryRoot,         │
│                      serviceDataRoot                            │
│    scope.ts        — scopeConfigPaths, ledgerPathFor,            │
│                      ownershipPathFor                            │
│    store.ts        — storeRootFor, installRegistryPath            │
│    runtime.ts      — lockDirFor, runtimeFilePath,                │
│                      crashLoopMarkerPath, auditLogPath           │
│    log.ts          — logDirFor (consumed by @adhd/sox-log)      │
│    socket.ts       — socketDirFor, backendSocketPath             │
│    memory.ts       — memoryDbPath, memoryRegistryPath,          │
│                      backupPathFor, exportDirFor                 │
│    os-unit.ts      — osUnitDir, unitFilePath                     │
│    service.ts      — serviceDataRoot, serviceLogDir              │
│    cache.ts        — schemaCachePath                             │
└──────────────────────────────────────────────────────────────────┘
```

```
┌──────────────────────────────────────────────────────────────────┐
│  @adhd/sox-log — Logging Apparatus                             │
│                                                                  │
│  Owns every log-writing mechanism. All path resolution delegates │
│  to @adhd/sox-config.                                            │
│                                                                  │
│  src/                                                            │
│    index.ts           — re-exports all components                │
│    log-manager.ts     — LogManager (WriteStream + rotation +     │
│                          run-history tracking)                   │
│    jsonl-audit.ts     — JsonlAudit (generic append-only JSONL    │
│                          sink for audit logs)                    │
│    stream-discovery.ts— LogStreamDiscovery (findAllLogStreams-   │
│                          ForExt, findMostRecentLogFile)          │
│    rotating-file.ts   — RotatingFileLog (standalone size-rotated │
│                          file for OS-unit stdout/stderr, back-   │
│                          end stderr, doctor-reconcile, serve)    │
└──────────────────────────────────────────────────────────────────┘
```

### 17b. Resolver → Audit § mapping

Every path template from §§1-13 (excluding host placements) maps to one resolver:

| Resolver | Package param | Resource | Audit § | Current → New path pattern |
|----------|--------------|----------|---------|---------------------------|
| `scopeConfigPaths(scope)` | `host-runtime` | `config` | 1a | `extensions.json` → `.adhd/sox-ecosystem/host-runtime/config/extensions.json` |
| `ledgerPathFor(scope)` | `install-engine` | `data` | 1b | `ledger.json` → same pattern |
| `ownershipPathFor(scope)` | `install-engine` | `data` | 1c | `ownership.json` → same pattern |
| `storeRootFor(scope, extRef)` | `stores` | `data` | 1d | `ext/<id>@<v>/` → `.adhd/sox-ecosystem/stores/<id>@<v>/` |
| `installRegistryPath()` | `install-engine` | `data` | 1e | `install-registry.json` → `.adhd/sox-ecosystem/install-engine/data/install-registry.json` |
| `supervisorsPath()` | `host-runtime` | `data` | 1f | `supervisors.json` → same pattern |
| `lockDirFor(supervisorId)` | `host-runtime` | `locks` | 1g | `run/locks/<id>.lock` → `.adhd/sox-ecosystem/host-runtime/locks/<id>.lock` |
| `runtimeFilePathFor(scope)` | `host-runtime` | `data` | 1g | `run/runtime.json` → same pattern |
| `auditLogPath()` | `cli` | `data` | 1g | `run/sox-audit.jsonl` → `.adhd/sox-ecosystem/cli/data/sox-audit.jsonl` |
| `crashLoopMarkerPath(key)` | `host-runtime` | `data` | 1g | `run/crash-loop/<key>.json` → `.adhd/sox-ecosystem/host-runtime/data/crash-loop/<key>.json` |
| `logDirFor(pkg, ...segments)` | per-caller | `logs` | 1g, 6c, 9b | `run/logs/<svId>/` → `.adhd/sox-ecosystem/<pkg>/logs/<segments>/` |
| `socketDirFor(pkg)` | per-caller | `sockets` | 1g, 8, 9a | `run/supervisors/` → `.adhd/sox-ecosystem/<pkg>/sockets/` |
| `memoryDbPath(name)` | `memory-core` | `stores` | 5a–b | `~/.memory/<name>.db` → `.adhd/sox-ecosystem/memory-core/stores/<name>.db` |
| `memoryRegistryPath()` | `memory-core` | `data` | 5a | `~/.memory/registry.json` → `.adhd/sox-ecosystem/memory-core/data/registry.json` |
| `backupPathFor(name, ts)` | `memory-core` | `backups` | 5c | `<dbPath>.bak-reembed-<ts>` → `.adhd/sox-ecosystem/memory-core/backups/<name>-<ts>.db` |
| `exportDirFor(dir)` | `memory-core` | `exports` | 5d | `<dir>/topics/<t>/<uid>.md` → `.adhd/sox-ecosystem/memory-core/exports/<t>/<uid>.md` |
| `writerLockPathFor(db)` | `memory-core` | `locks` | 5e | `<dbPath>.writer.lock` → `.adhd/sox-ecosystem/memory-core/locks/<name>.writer.lock` |
| `osUnitDir(platform)` | `host-runtime` | `os-units` | 6a–b | `~/Library/LaunchAgents/` → stays (OS supervisor requirement); config lib provides `unitFilePath(label)` for the filename |
| `serviceDataRoot(svcId)` | per-service | `data` | 7 | `~/.tokenguard/` → `.adhd/sox-ecosystem/<svcId>/data/` |
| `serviceLogDir(svcId)` | per-service | `logs` | 7 | `~/.tokenguard/audit.jsonl` → `.adhd/sox-ecosystem/<svcId>/logs/audit.jsonl` |
| `schemaCachePath(extId)` | per-ext | `cache` | 10 | `<dist>/schema.json` → `.adhd/sox-ecosystem/<extId>/cache/schema.json` |

### 17c. Gaps eliminated by the migration

| Old gap (§14) | How the unified structure covers it |
|---------------|--------------------------------------|
| §5 memory store uses `$HOME` not `SOX_ECOSYSTEM_HOME` | Config lib adds `memoryRoot()` — defaults to `dataRoot/memory-core/`, overridable via `$SOX_MEMORY_HOME`. Memory is no longer a separate root; it's a package under the same hierarchy |
| §7 tokenguard audit uses `appendFileSync` not `LogManager` | Logging lib's `JsonlAudit` is a first-class sink. Tokenguard replaces `fs.appendFileSync` with `log.jsonl("audit", entry)` |
| §7 tokenguard paths use their own env vars | Service data dirs use config lib's `serviceDataRoot("tokenguard")`, overridable via `$SOX_DATA_DIR_TOKENGUARD` |
| §10 schema cache is caller-provided | Config lib's `schemaCachePath("memory-server")` defaults to `<dataRoot>/memory-server/cache/schema.json`, overridable via `$SOX_CACHE_DIR_MEMORY_SERVER` |
| Log stream discovery hardcodes 5 stream types | Logging lib's `LogStreamDiscovery` owns the convention — adding a stream type is a one-place change, not grep across `main.ts` |
| Parity copy of `logDirFor` (A2 in §14a) | Eliminated — one resolver in the config lib, zero duplicates |

### 17d. Blast radius reduction

| Layer | Current (§14) | With two-package design | Delta |
|-------|---------------|------------------------|-------|
| Definition files | 17 | ~2 (new package source) | −15 |
| Re-export files | 4 | ~4 (adapter stubs in existing pkgs) | ±0 |
| Production callers | 38 | 38 (import rewrites only) | ±0 |
| Parity guard test | 1 | 0 (eliminated) | −1 |
| Other tests | 27 | 27 (import rewrites) | ±0 |
| Tool/script files | 7 | 7 (import rewrites) | ±0 |
| Documentation | 6 | 6 (reference updates) | ±0 |
| **New package code** | — | **2 new packages, ~14 source files** | +14 |

Net: **−1 file** (the parity guard test disappears). The 17 scattered definition
files collapse into ~14 organized source files across two packages. No production
caller, test, or documentation file is added — only their import paths change.

---

## 18. Adoption Survey Reconciliation

The per-package adoption survey at `docs/environment/adoption-survey/sox-ecosystem/*.md`
(adhd repo) analyzed 20 sox-ecosystem packages for `@adhd/environment` adoption readiness.
This section reconciles §17's proposed `@adhd/sox-config` + `@adhd/sox-log` design against
the survey's per-package findings and identifies gaps, conflicts, and risks.

### 18a. Adoption Survey → §17 Package Mapping

For each sox-ecosystem package the survey analysed, the table below shows whether §17's
design absorbs the package's path/logic, conflicts with the survey's recommendation, or
leaves it unchanged:

| Survey package | Survey rec | §17 resolver (from §17b) | §17 package param | Alignment | Notes |
|---|---|---|---|---|---|
| `sox-host-runtime` | adopt-after-gap (G1,G2,G8) | `scopeConfigPaths`, `lockDirFor`, `logDirFor`, `supervisorsPath`, `runtimeFilePathFor`, `crashLoopMarkerPath`, `osUnitDir` | `host-runtime` | Absorbs — LogManager absorption confirmed | Survey calls this "the strongest single case" for env paths. §17's `@adhd/sox-log` absorbs LogManager, §17's `@adhd/sox-config` absorbs data-paths. Strong alignment. |
| `sox-install-engine` | adopt-after-gap (G1,G2) | `scopeConfigPaths`, `ledgerPathFor`, `ownershipPathFor`, `storeRootFor`, `installRegistryPath` | `install-engine` | Absorbs — parity copy eliminated | §17 eliminates the parity copy of data-paths.ts between host-runtime and install-engine (listed as explicit win in §17c). Survey flags existing `console`-only logging; §17's `JsonlAudit` or `RotatingFileLog` can absorb. Strong alignment. |
| `sox-cli` | adopt-after-gap (G1,G3) | `auditLogPath`, `schemaCachePath`, `backendLogDirFor` | `cli` | Absorbs | CLI's hand-rolled audit log path, backend log path, and scope resolution all move into §17's two packages. Survey notes G1 (`SOX_HOME` legacy) and G3 (non-Node gap) — neither addressed by §17 but neither blocks it. |
| `sox-memory-core` | adopt-after-gap (G2,G5) | `memoryDbPath`, `memoryRegistryPath`, `backupPathFor`, `exportDirFor`, `writerLockPathFor` | `memory-core` | **Conflicts by path schema** | §17 resolves to `.adhd/sox-ecosystem/memory-core/stores/<name>.db`. Survey maps to `.adhd/sox-memory-core/default/data/<name>.db`. Same file, different path template. See §18c Risk 1. |
| `sox-mcp-runtime` | adopt-after-gap (G1,G2) | `socketDirFor` | per-caller (not self) | **Partial mismatch** | §17's `socketDirFor` returns per-package socket dirs. Survey's `sox-mcp-runtime` expects `~/.adhd/sox-mcp-runtime/default/run/`. MCP sockets currently live at `~/.sox/sockets/`. Both paths differ from survey target and from each other. §17's resolver name `socketDirFor` abstracts the caller's identity, so the path can be configured. Migration path: align §17's socket dir with survey's `dirs.sockets: kind='run'`. |
| `sox-service-proxy` | skip | `backendSocketPath`, `lockName` (in `ensure-backend.ts`) | per-caller | Absorbs — correctly scoped | Survey skips this (parameter-driven leaf library). §17 correctly locates path resolution in the caller/coordinator (sox-cli, host-runtime), not in service-proxy itself. |
| `sox-host-registry` | skip (G1) | Excluded per §14 scope | — | Leaves unchanged | Both docs agree host placements (§2-4) are out of scope for centralization. Survey's G1 flag (`SOX_SANDBOX_ROOT`, `CODEX_HOME`) is pre-existing and not addressed by §17. |
| `sox-embedding-provider` | adopt (G1,G5) | **No resolver exists** | — | **Gap — missing resolver** | §17's resolver table has no entry for model cache. Survey maps to `kind: 'cache'` at `.adhd/sox-embedding-provider/default/cache/models/`. §17 must add `modelCachePath(providerId)` or general `cachePath(pkg, subpath)`. |
| `sox-tokenguard-core` | skip | `_persist` path (caller-provided) | caller | Leaves unchanged | Survey skips (leaf library). §17 correctly delegates to caller (sox-extension-tokenguard). |
| `sox-extension-tokenguard` | adopt (G1,G2) | `serviceDataRoot`, `serviceLogDir` | `tokenguard` | **Path-schema naming difference** | §17 uses `tokenguard` as package param. Survey uses `sox-extension-tokenguard`. §17's path: `.adhd/sox-ecosystem/tokenguard/data/`. Survey's: `.adhd/sox-extension-tokenguard/default/data/`. Align on full npm package name. |
| `sox-extension-memory-server` | skip | `schemaCachePath` | `memory-server` | Absorbs selectively | Survey skips entire package but says schemaPath is "caller-supplied, not config-discoverable." §17's `schemaCachePath` would make it config-discoverable — an improvement the survey didn't model. No conflict. |
| `sox-extension-memory-cli` | adopt-after-gap (G1) | `memoryDbPath`, `memoryRegistryPath`, `exportDirFor` | `memory-core` | **Same path-schema conflict as memory-core** | Survey maps scope/.memory/ DBs to `.adhd/sox-extension-memory-cli/default/data/`. §17 delegates to `memory-core` resolvers. Both need to point to the same physical file for shared stores. |
| `sox-extension-memory-flush` | skip | None — caller-provided payload path | — | Leaves unchanged | Survey skips (stateless handler). §17 does not model it. Both correct. |
| `sox-task-queue` | adopt-after-gap | None — caller-provided `dbPath` | — | Opportunity — no conflict | Survey says "adopt-after-gap" but has zero gaps. §17 has no dedicated resolver. The `data` dir under §17's structure would provide a natural `taskQueueDbPath` resolver. |
| `sox-blob-store` | adopt | None — caller-provided `basePath` | — | Opportunity — no conflict | Survey has zero gaps, recommends adopt. §17 has no dedicated resolver. Blob store's `basePath` would map naturally to a `blobStoreRoot(pkg)` resolver. |
| `sox-graph-store` | skip | None — pure library | — | Leaves unchanged | Survey skips. §17 not applicable. |
| `sox-vector-store` | skip | None — caller-provided path | — | Leaves unchanged | Survey skips. §17 not applicable. |
| `sox-registry` | skip | None — caller-provided root | — | Leaves unchanged | Survey skips (utility library). §17's path resolvers are used by callers of sox-registry, not by sox-registry itself. |
| `sox-authoring` | skip | None — caller-provided `outDir` | — | Leaves unchanged | Survey skips (scaffolder, no runtime config). §17 not applicable. |
| `sox-baseline-capture` | skip (G2) | None — dev tool | — | Leaves unchanged | Survey skips (private dev tool). §17 not applicable. |

### 18b. Per-Package Findings — Existing Config/Log Patterns

For packages where the survey identifies an existing config or log abstraction that §17
should absorb rather than replace:

**1. `sox-host-runtime` — Custom `LogManager` (must absorb)**
- **Existing pattern:** `LogManager` class with WriteStream + daily rotation + run-history tracking. Custom error handling via `console.warn` in gc.ts. File size cap at 50 MB, max 7 files per extId prefix.
- **§17 action:** `@adhd/sox-log/log-manager.ts` IS the absorption of this class. The rotation policy (50 MB cap, 7-file max, daily date-stamped filenames) becomes the default in the new package. The `run-history.json` tracking stays as a `LogManager` feature. The `gc.ts` `process.stderr.write()` calls graduate to structured logging via `RotatingFileLog`.
- **Gap:** The survey flags LogManager's error handling as "adhoc" with silent catch blocks. §17's `@adhd/sox-log` should upgrade error handling to emit structured errors (logged via `JsonlAudit`) rather than swallowing them.

**2. `sox-host-runtime` — `data-paths.ts` (must absorb)**
- **Existing pattern:** 15 ADR-0004 path resolvers with parity copy in `sox-install-engine`. Hardcoded scope logic (user/project/local/org).
- **§17 action:** `@adhd/sox-config` IS the absorption. Every resolver from `data-paths.ts` gets a home in the appropriate `@adhd/sox-config` module (root.ts, scope.ts, runtime.ts, etc.). The parity copy is eliminated (§17c lists this as explicit win).

**3. `sox-extension-tokenguard` — Custom audit log pattern (absorb)**
- **Existing pattern:** `appendFileSync` to `audit.jsonl` with structured JSON-per-line (ts, event, path, leak_count). Written atomically in proxy.ts:48-53. Plus `atomicWrite` for token-mapping.json via tmp-rename.
- **§17 action:** `@adhd/sox-log/jsonl-audit.ts` replaces the `appendFileSync` pattern with a first-class `JsonlAudit` sink. §17c lists this as explicit win. The survey's audit log is already structured JSON — the only delta is path resolution moving to `@adhd/sox-config/serviceLogDir("tokenguard")`.
- **Caveat:** The `appendFileSync` approach is synchronous and best-effort. `JsonlAudit` should support both sync (`appendFileSync` equivalent) and async (WriteStream) modes so the safety-critical tokenguard proxy path can remain synchronous.

**4. `sox-embedding-provider` — XDG cache path cascade (absorb)**
- **Existing pattern:** Cascade: `config.cacheDir` → `SOX_EMBED_CACHE_DIR` → `XDG_CACHE_HOME/sox/models` → `~/.cache/sox/models`. Model binaries at `<cacheDir>/<modelId>/main/model.onnx`.
- **§17 action:** Add `modelCachePath(pkg, modelId)` resolver to `@adhd/sox-config/cache.ts`. The resolver should respect `XDG_CACHE_HOME` as a secondary fallback (after the main config cascade) for backward compatibility with existing ONNX model caches.
- **Survey aligns:** Survey's file-location table maps to `~/.adhd/sox-embedding-provider/default/cache/models/`. §17 should match this pattern with the same `<project-id>/<namespace>/<kind>/` schema.

**5. `sox-memory-core` — Memory allowlist (bridge, don't break)**
- **Existing pattern:** `~/.memory/**` allowlist enforced in backup.ts, guarding VACUUM INTO destinations. Permission-guarded at `isPathInMemoryAllowlist()`.
- **§17 action:** `@adhd/sox-config/memory.ts` provides `memoryDbPath`, `backupPathFor`, etc. The allowlist check moves from `memory-core/backup.ts` to the config library's permission guard layer. The survey notes this allowlist must move "to the memory-server permission guard" — §17 should instead absorb it into `@adhd/sox-config`'s resolver layer so ALL packages (not just memory-server) benefit.
- **Bridge path:** During migration, `memoryDbPath()` must accept an explicit allowlist override (defaulting to the existing `~/.memory/**` pattern) so existing stores at the old path remain accessible. Breaking this silently would corrupt the live memory store.

**6. `sox-cli` — Audit log + backend log pattern (absorb)**
- **Existing pattern:** `sox-audit.jsonl` via `appendFileSync` (main.ts:154-173). Backend logs via manual daily-rotated path composition (main.ts:2334-2336). Both are scattered inline in the CLI entrypoint.
- **§17 action:** `@adhd/sox-log/jsonl-audit.ts` absorbs the audit log. `@adhd/sox-log/rotating-file.ts` absorbs the backend log. Path resolution moves to `@adhd/sox-config/` resolvers. The survey flags error handling as "adhoc" — the audit try/catch swallows errors silently — §17's `JsonlAudit` should expose an `onError` callback or emit to stderr as fallback.

**7. `sox-task-queue` — Console-only logging (upgrade, not absorb)**
- **Existing pattern:** `console.warn`/`console.error` only. No file persistence.
- **§17 action:** Not an existing abstraction to absorb — it's a missing one. §17's `@adhd/sox-log` should provide a `ConsoleTee` wrapper that routes console output to both stdout and `env.paths.logs/<instance>.log`. This gives sox-task-queue (and all other console-only loggers) persistent logs without changing their logging code. The survey recommends this exact pattern.

**8. `sox-blob-store` — Console-only logging (upgrade, same pattern)**
- **Existing pattern:** `console.info/warn/error/debug` only. No file persistence.
- **§17 action:** Same `ConsoleTee` wrapper from §18b#7. No absorption needed — upgrade path is identical to sox-task-queue.

### 18c. Integration Risks

**Risk 1 — Path schema divergence (CRITICAL):** §17's resolver table (§17b) uses the template `.adhd/sox-ecosystem/<package>/<resource>/<file>` where `<package>` is a short name like `host-runtime`, `install-engine`, `memory-core`, `tokenguard`. The survey's corrected file-location tables use `.adhd/<project-id>/<namespace>/<kind>/<file>` where `<project-id>` is the npm package name (e.g., `sox-host-runtime`, `sox-memory-core`, `sox-extension-tokenguard`).

Every path diverges:
- §17: `~/.adhd/sox-ecosystem/memory-core/stores/memory.db`
- Survey: `~/.adhd/sox-memory-core/default/data/memory.db`
- §17: `~/.adhd/sox-ecosystem/host-runtime/config/supervisors.json`
- Survey: `~/.adhd/sox-host-runtime/default/state/supervisors.json`
- §17: `~/.adhd/sox-ecosystem/tokenguard/data/token-mapping.json`
- Survey: `~/.adhd/sox-extension-tokenguard/default/data/token-mapping.json`

**Impact:** If §17's `@adhd/sox-config` ships with the `sox-ecosystem` namespace, every file written to the new paths will be at a DIFFERENT location than what `@adhd/environment` expects when a sox-ecosystem package later adopts it (survey Steps 3-4). This forces a double migration: first to `@adhd/sox-config` paths, then to `@adhd/environment` paths.

**Mitigation:** §17 should adopt the survey's path standard from the start. The `@adhd/sox-config` resolvers should use `.adhd/<project-id>/<namespace>/<kind>/<file>` where:
- `project-id` = the npm package identifier (e.g., `sox-host-runtime`, `sox-memory-core`)
- For shared files (install-registry, supervisors), pick ONE consumer as the authority (e.g., `sox-host-runtime`) and expose the resolver by function name, not by package. All other consumers import the same resolver.
- `kind` = one of the 7 standard kinds from `@adhd/environment` (`config|locks|data|state|run|logs|cache|backups`)
- `namespace` = `default` for standalone packages, or a cluster identifier for shared-config clusters (§2c of SYNTHESIS.md)

**Risk 2 — Shared config cluster hazard (HIGH):** The survey identifies 5 shared-config clusters (§2c of SYNTHESIS) where packages must resolve to the SAME path for shared stores. §17's per-package resolver model implicitly supports this (resolvers like `installRegistryPath()` return the same path for all callers), **but**:
- The resolver table (§17b) does not document which resolvers produce shared vs per-package paths.
- If a future contributor adds a new resolver that accidentally duplicates a shared path under a different package parameter, two packages will write to DIFFERENT files while expecting to share data.

**Mitigation:** §17b's resolver table needs a `sharing` column: `singleton` for paths shared across packages, `per-package` for package-specific paths. And each shared resolver must have a designated "authority" package documented as the canonical owner.

**Risk 3 — Bootstrap ordering between `@adhd/sox-config` and `@adhd/sox-log` (MEDIUM):** §17a shows `@adhd/sox-log` importing path resolvers from `@adhd/sox-config`. This is a clean one-way dependency. However, if `LogManager` needs to log configuration loading errors that occur during `@adhd/sox-config` initialization, there is a bootstrap cycle:
1. To know where log files go, you need `@adhd/sox-config` (logDirFor).
2. To report config loading errors, you need `@adhd/sox-log`.
3. But #2 requires #1 to know where to write.

**Mitigation:** `@adhd/sox-log`'s `RotatingFileLog` and `JsonlAudit` must accept a fallback parameter (direct path string or `{ tee: true }` to emit to stderr during bootstrap). Once `@adhd/sox-config` is initialized, components switch to resolved paths. Document this as a deliberate bootstrap pattern in both packages' README.

**Risk 4 — Env var naming collision with `@adhd/environment` (LOW):** §17's `@adhd/sox-config` proposes reading `SOX_*` env vars (`SOX_ECOSYSTEM_HOME`, etc.). The survey flags that `@adhd/environment`'s prefix model may not accept `SOX_*`. However, the env prefix in `@adhd/environment` is **configurable** — it can be set to `SOX_` (or any other value) rather than requiring a hard-coded prefix like `ADHD_`. This defuses the collision: both `@adhd/environment` and `@adhd/sox-config` can read from the same `SOX_*` vars.

**Mitigation:** Configure `@adhd/environment`'s prefix to `SOX_` during sox-ecosystem adoption. `@adhd/sox-config` reads directly from `@adhd/environment`'s resolved config (snapshot or API) — never independently from `process.env`. A single config cascade feeds both packages, eliminating the inconsistency window.

**Risk 5 — Migration sequencing — double migration (LOW):** §14f counts 72 files. If `@adhd/sox-config` were a temporary abstraction replaced by `@adhd/environment` later, each file would migrate twice. However, `@adhd/sox-config` **persists** — it is the sox-ecosystem-specific consumer of `@adhd/environment`. When `@adhd/environment` ships, `@adhd/sox-config`'s resolvers delegate to it under the hood (`env.paths.<kind>/<file>`). The 72 caller files never change again — they only ever import from `@adhd/sox-config`. No double migration.

**Mitigation:** Design `@adhd/sox-config` with an internal adapter seam from day one. The public API stays stable; the backend swaps from direct path construction to `@adhd/environment` delegation in a single internal commit. The 72 caller files are unaffected.

**Risk 6 — OS unit files remain out of scope (LOW, confirmed):** Both §17 (excludes host placements §2-4) and the survey (G2 — "OS-mandated directory, cannot be relocated") agree that OS unit files at `~/Library/LaunchAgents/` and `~/.config/systemd/user/` stay as-is. No conflict, but §17 should reference the survey's G2 finding as confirmation of this design boundary.

### 18d. Revised Two-Package Design

The survey's per-package findings and §18c risk analysis require **three revisions** to §17's proposed design:

**Revision 1 — Path template alignment (applies to all §17b resolvers)**

The sox-ecosystem harness is itself a **bundle**, analogous to the memory bundle
(§17a). All packages that ship as part of the sox-ecosystem monorepo write under
`.adhd/sox-ecosystem/<package>/<resource>/<file>`. Bundles deployed independently
(e.g., the memory bundle) write under their own top-level directory
(e.g., `.adhd/memory/<package>/<resource>/<file>`). Standalone extensions (e.g.,
tokenguard) write under `.adhd/<extension-id>/<resource>/<file>`.

The revised template:

```
.adhd/<bundle-or-extension-id>/<package>/<kind>/<file>
```

Where:
- `<bundle-or-extension-id>` = `sox-ecosystem` for monorepo packages, `memory` for memory-bundle packages, or the extension id for standalone extensions
- `<package>` = npm package name segment (e.g., `host-runtime`, `memory-core`, `install-engine`)
- `<kind>` = `config` | `locks` | `data` | `state` | `run` | `logs` | `cache` | `backups`
- `<file>` = the filename

Singleton paths shared across packages (e.g., `supervisors.json`) live under
`<bundle-or-extension-id>/shared/<kind>/<file>` with the resolver's documentation
naming the authority package.

**Old (§17b) → Revised (bundle-namespaced):**

| Resolver | Old path | New path (bundle-namespaced) |
|----------|----------|------------------------------|
| `scopeConfigPaths(scope)` | `.adhd/sox-ecosystem/host-runtime/config/extensions.json` | `.adhd/sox-ecosystem/host-runtime/config/extensions.json` |
| `ledgerPathFor(scope)` | `.adhd/sox-ecosystem/install-engine/data/ledger.json` | `.adhd/sox-ecosystem/install-engine/state/ledger.json` |
| `ownershipPathFor(scope)` | `.adhd/sox-ecosystem/install-engine/data/ownership.json` | `.adhd/sox-ecosystem/install-engine/state/ownership.json` |
| `storeRootFor(scope, extRef)` | `.adhd/sox-ecosystem/stores/<id>@<v>/` | `.adhd/sox-ecosystem/stores/data/<id>@<v>/` |
| `installRegistryPath()` | `.adhd/sox-ecosystem/install-engine/data/install-registry.json` | `.adhd/sox-ecosystem/shared/state/install-registry.json` |
| `supervisorsPath()` | `.adhd/sox-ecosystem/host-runtime/data/supervisors.json` | `.adhd/sox-ecosystem/shared/state/supervisors.json` |
| `lockDirFor(supervisorId)` | `.adhd/sox-ecosystem/host-runtime/locks/<id>.lock` | `.adhd/sox-ecosystem/host-runtime/locks/<id>.lock` |
| `auditLogPath()` | `.adhd/sox-ecosystem/cli/data/sox-audit.jsonl` | `.adhd/sox-ecosystem/cli/logs/audit.jsonl` |
| `memoryDbPath(name)` | `.adhd/sox-ecosystem/memory-core/stores/<name>.db` | `.adhd/sox-ecosystem/memory-core/data/<name>.db` |
| `serviceDataRoot(svcId)` | `.adhd/sox-ecosystem/<svcId>/data/` | `.adhd/sox-ecosystem/<pkg>/data/` |

Note: the `shared/` segment for singleton paths replaces the flat mix of
per-package and shared paths that currently share a single `run/` directory.
This eliminates the ambiguity flagged in Risk 2 — a `shared/` path is
explicitly not owned by any single package.

**Revision 2 — Add missing resolver: `modelCachePath()` (applies to §17b)**

§17b's resolver table covers schema cache (`schemaCachePath`) but not the embedding model
cache used by `sox-embedding-provider`. Add to `@adhd/sox-config/cache.ts`:

```
modelCachePath(providerId, modelId) → <.adhd/sox-embedding-provider/default/cache/models/<modelId>/>
```

Overridable via `$SOX_EMBED_CACHE_DIR` (existing env var) for backward compatibility.
Respects `$XDG_CACHE_HOME` as secondary fallback per survey finding §18b#4.

**Revision 3 — Add `sharing` metadata to resolver table (applies to §17b)**

Each resolver must document whether its path is a singleton (shared across packages) or
per-package. Add column to the §17b resolver table:

| Resolver | Sharing | Note |
|----------|---------|------|
| `scopeConfigPaths(scope)` | per-scope | Each scope has its own config |
| `ledgerPathFor(scope)` | per-scope | One per scope |
| `ownershipPathFor(scope)` | per-scope | One per scope |
| `storeRootFor(scope, extRef)` | per-scope | Per materialized extension |
| `installRegistryPath()` | **SINGLETON** | Shared by sox-cli and sox-install-engine |
| `supervisorsPath()` | **SINGLETON** | Shared by sox-cli and sox-host-runtime |
| `lockDirFor(supervisorId)` | per-supervisor | One per running supervisor |
| `auditLogPath()` | per-instance | One per CLI process |
| `memoryDbPath(name)` | per-store | One per store name |
| `memoryRegistryPath()` | **SINGLETON** | Shared by sox-memory-core, sox-extension-memory-cli |
| `serviceDataRoot(svcId)` | per-service | One per service extension |
| `serviceLogDir(svcId)` | per-service | One per service extension |
| `schemaCachePath(extId)` | per-extension | One per extension |
| `modelCachePath(providerId, modelId)` | per-model | One per model per provider |

**No other revisions required.** The two-package boundary (§17a), the module structure within
each package, and the blast radius reduction (§17d) all remain valid after applying these
three revisions.

**Implementation order (revised per Risk 5 resolution):**

`@adhd/sox-config` is a **persistent adapter**, not a temporary stepping-stone.
It never goes away — it owns the stable public API for all 72 callers. When
`@adhd/environment` ships later, the swap happens inside `@adhd/sox-config`
(internal adapter seam) without touching those 72 files. This means the phases
can proceed independently:

1. **Phase 1 — `@adhd/sox-config` (standalone):** Build the config management
   library as a direct path resolver. All resolvers construct paths from
   `SOX_ECOSYSTEM_HOME` (env var / `os.homedir()`) + the bundle-namespaced
   templates from Revision 1. Include `sharing` metadata per Revision 3.
   Ships immediately — no dependency on `@adhd/environment`.

2. **Phase 2 — `@adhd/sox-log`:** Build logging package on the resolved paths
   from `@adhd/sox-config`. Include `ConsoleTee` wrapper for console-only
   loggers (§18b#7/#8). Ships after or concurrently with Phase 1.

3. **Phase 3 — Migration of 72 files:** Import rewrites from the current
   scattered definitions to `@adhd/sox-config` and `@adhd/sox-log`. Pure import
   changes per §17d. No logic changes.

4. **Phase 4 — `@adhd/environment` backend swap (required, non-breaking):**
   The Phase 1 stand-alone `@adhd/sox-config` directly constructs paths from
   `process.env` — it duplicates resolution logic that `@adhd/environment` is
   designed to own. The survey identifies specific gaps (`@adhd/environment`
   F1+F2 per survey §7 Step 2) that must be implemented to eliminate this
   duplication:

   - **F1 — Env prefix configuration:** `@adhd/environment` must accept a
     configurable env prefix (set to `SOX_` for sox-ecosystem adoption) so
     existing `SOX_ECOSYSTEM_HOME`, `SOX_MEMORY_HOME`, etc. resolve through
     the single cascade.
   - **F2 — Path resolution model:** `@adhd/environment` must support the
     bundle-namespaced path template from Revision 1
     (`.adhd/<bundle>/<package>/<kind>/<file>`) as a first-class resolution
     pattern.

   Once F1+F2 ship, `@adhd/sox-config` swaps its internal backend to delegate
   to `env.paths.<kind>/<file>` — behind the same stable public API. The 72
   caller files are **untouched**; they still import from `@adhd/sox-config`
   with the same function signatures.

   **Dependency ordering:** Phase 4 does not block Phases 1-3. Phases 1-3
   ship the immediate path consolidation. Phase 4 eliminates the resolution
   duplication whenever `@adhd/environment` F1+F2 completes.

---

## 19. Required `@adhd/environment` Gap Tasks

Gap specifications are maintained in two files in the adhd repo:

| File | Path | Purpose |
|------|------|---------|
| **GAP_SPECS.md** | `docs/environment/adoption-survey/GAP_SPECS.md` | Specified gaps ready for implementation |
| **GAPS_TO_ARCHITECT.md** | `docs/environment/adoption-survey/GAPS_TO_ARCHITECT.md` | Items needing further design |

### Current gap status

| Gap | Title | Priority | §18d dependency | Status |
|-----|-------|----------|-----------------|--------|
| G-1 | Non-`ADHD_*` Env Var Allowlist (F1) | HIGH | Phase 4 | **SPECIFIED** |
| G-2 | Write Paths Outside Scope Root (F2) | HIGH | Phase 4 | **SPECIFIED** |
| G-3 | Dynamic / Extension Config (F3) | MED | Phase 4 | **SEE GAPS_TO_ARCHITECT** |
| G-4 | Extended Directory Kinds (F4) | MED | Phase 1 | **SPECIFIED** |
| G-5 | Language-Neutral Spec Artifact (F5) | MED | Phase 4 | **SPECIFIED** |
| G-6 | Multi-File Merged Config Sources (F7) | LOW | Post-Phase-4 | **SPECIFIED** |
| G-7 | Extended Value Types (F6) | — | — | **CLOSED** — no real gap |
| G-8 | Host-Convention Roots | — | — | **COLLAPSED INTO G-1** |
| G-9 | Memory Allowlist Bridge | — | — | **MOVED TO GAPS_TO_ARCHITECT** |

Each specified gap in `GAP_SPECS.md` includes source citations, description,
concrete TypeScript interfaces, API shapes, config schema, env var patterns,
dependency mapping, and status. Items in `GAPS_TO_ARCHITECT.md` document the
open questions that must be resolved before specification.
