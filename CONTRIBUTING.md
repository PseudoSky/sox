# CONTRIBUTING.md — Live Ship Verification Playbook

> **Read this before reporting any change as complete.** Every agent — human, `implement`,
> `flash`, or `pro` — must follow this playbook after making code changes. This is not
> advisory. It is the minimum gate between "code written" and "change shipped."

---

## §1 Universal Pre-Ship Checklist (ALL changes)

Run these in order. Stop on first failure. Fix the failure before continuing.

### 1.1 Impact awareness (before editing)

| Tool | Purpose |
|------|---------|
| `gitnexus_impact({target: "symbol", direction: "upstream"})` | Blast radius — who calls this? |
| `gitnexus_context({name: "symbol"})` | Full callers + callees + execution flows |

If risk is HIGH or CRITICAL, report the blast radius to the orchestrator before editing.

### 1.2 Build gate

```
npx nx affected:lint --base=HEAD   # lint every changed project
npx nx affected:build --base=HEAD  # build every changed project + dependents
```

If any project fails to build, fix it. Do NOT skip.

### 1.3 Test gate

```
npx nx affected:test --base=HEAD   # test every changed project
```

If any test fails, fix it immediately. Never claim a failure is pre-existing. Run `git diff`
to trace the exact origin.

### 1.4 GitNexus verification

```
gitnexus_detect_changes()   # verify only expected symbols changed
```

If unexpected symbols appear in the change set, investigate. They may be side effects.

### 1.5 Cleanup — force removal of test artifacts

After live verification is complete, uninstall any test installs and remove all test artifacts
from host directories. Test artifacts left behind break the next session and confuse agent discovery.

#### ⛔ CRITICAL — never corrupt the live host config file

Host config files (`.mcp.json`, `opencode.json`, `.claude.json`) are read by the agent host
at session start. **Mid-session writes to these files will disconnect active MCP connections.**
Once disconnected, MCP tools are gone for the remainder of the session — only a full session
restart can reconnect them.

**Rules for config-merge testing:**

1. **Always `--dry-run` first.** Verify the output before writing.
2. **Back up the config file before any real install that touches it:**

   ```
   cp opencode.json opencode.json.bak
   ```

3. **After verification, restore the original:**

   ```
   cp opencode.json.bak opencode.json
   ```

4. **Never leave a modified config file behind.** The backup is your exit plan.
5. **If you lose MCP tools mid-session:** they will not return until next session start.
   The host does not hot-reload MCP connections.

**Cleanup commands by host:**

```
# opencode host — remove test-installed agents, skills, and tools
node bin/soxe uninstall <test-id> --host=opencode --scope=project 2>/dev/null
rm -rf .opencode/agents/<test-id>/ .opencode/skills/<test-id>/ .opencode/tools/<test-id>/

# claude host
node bin/soxe uninstall <test-id> --host=claude --scope=project 2>/dev/null
rm -rf .claude/agents/<test-id>/ .claude/skills/<test-id>/

# Restore host config files from backup if they were modified
cp opencode.json.bak opencode.json 2>/dev/null
cp .mcp.json.bak .mcp.json 2>/dev/null

# Remove backup files
rm -f opencode.json.bak .mcp.json.bak
```

**Check before reporting done:**

```
ls .opencode/agents/    # should contain ONLY .md agent definitions (pro, implement, flash)
ls .opencode/skills/    # should be empty or contain only committed skills
ls .opencode/tools/     # should be empty or contain only committed tools
cat opencode.json       # MCP section must match pre-test state; no orphaned test entries
cat .mcp.json           # same for claude host
```

Test artifacts left in these directories will be loaded by the host on next session start
and may cause errors or unexpected behavior. **Mid-session config file corruption kills active
MCP connections permanently for that session.** Forcing cleanup is mandatory — never leave
test artifacts or modified config files behind.

### 1.6 Commit hygiene

```
git diff --stat                # review every changed file
git add <explicit/path> ...    # NEVER git add -A / git add .
```

Commit message template:

```
<area>: <imperative-verb summary>

<one-paragraph why, what this enables, what was fixed>

Changes:
- <file> — <what changed>
- <file> — <what changed>

Verification:
- nx affected:lint  ✅
- nx affected:build ✅
- nx affected:test  ✅ (<N> passed, 0 failed)
```

**Never commit:** `.nx/`, `.DS_Store`, `dist/`, `*.js`/`*.d.ts` in `src/`, secrets, tokens, API keys.

### 1.7 Registry sync (if registry packages changed)

If you changed a package registered in `registry/index.json` (libs/platform/*, apps/*, extensions/*), run:

```
npx nx run registry:sync-index
```

Commit the regenerated `registry/index.json` alongside source changes.

### 1.8 Backlog

Write any discovered bugs, deferrals, or limitations to `BACKLOG.md` at discovery time.
Format: `- [ ] <area>: <description> (discovered <date> during <change>)`

---

## §2 Type-Based Live Verification

After the universal checklist passes, consult the table below to find the verification
playbook matching your change type. **You MUST follow the playbook exactly — no scripts,
no simulated results.** Use in-session tools (MCP tools, `node bin/soxe`, file reads)
for all verification.

### §2.1 Quick lookup

| You changed... | Go to |
|----------------|-------|
| An MCP server extension (memory-server, etc.) | §2.2 |
| A service extension (memory-daemon, tokenguard) | §2.3 |
| An agent extension | §2.4 |
| A skill extension | §2.5 |
| A command extension | §2.6 |
| A hook extension | §2.7 |
| A bundle extension | §2.8 |
| A data library (graph-store, vector-store, etc.) | §2.9 |
| A platform library (install-engine, host-registry, etc.) | §2.10 |
| The host-runtime (os-unit, supervisor, reaper, etc.) | §2.11 |
| The CLI (apps/sox) | §2.12 |
| The mcp-runtime (transport, serve) | §2.13 |
| The manifest schema | §2.14 |
| The host-registry (host modules) | §2.15 |

---

### §2.2 MCP server changes

**Context:** Changes to `extensions/bundles/sox-memory-bundle/members/memory-server/` or any
MCP server extension. These ship a bundled dist that backs in-session MCP tools.

#### §2.2.1 Before

Use in-session MCP tools (NOT `node -e`, NOT `curl`, NOT scripts) to capture baseline:

```
memory_ping
```

Log the `artifact`, `short`, `host_compat`, `embed_model`, and `embed_state` fields.

#### §2.2.2 Build + deploy

```
npx nx affected:build --base=HEAD   # must include memory-server rebuild
```

Confirm the memory-server bundle was rebuilt (look for `bundle-extension: OK — ...dist/index.js`).

#### §2.2.3 Upgrade installed instances

```
node bin/soxe upgrade --all
```

Verify the output shows the memory-server consumer as `STALE → re-installing` or `upgraded`.
If you see `CHECKSUM MISMATCH`, reinstall manually:

```
node bin/soxe install memory-server --host=<host> --profile=<profile> --scope=<scope>
```

#### §2.2.4 After — confirm reload

```
memory_ping
```

Compare `artifact` and `short` fields to the "before" values. One of three outcomes:

| Outcome | Meaning | Action |
|---------|---------|--------|
| Hash changed | Server reloaded with new code | ✅ Success |
| Hash unchanged, but behavior changed | Server cached; daemon not restarted | Run `soxe service status <ext>`; if loaded, `soxe service enable <ext>` to force reload |
| Hash unchanged, no behavior change expected | Non-code change (config, schema) | Verify via in-session tool call for the affected behavior |

#### §2.2.5 If behavior was changed

Test the new behavior using in-session MCP tools. For example, if you added a new `memory_*`
tool, call it directly. If you changed recall ranking, query with a known-good phrase and
verify results changed.

#### §2.2.6 Per-profile verification

| Profile | Verify |
|---------|--------|
| `stdio` | Check `opencode.json` (or `.mcp.json` for claude) has `type: "local"` entry |
| `sse` / `http` | Check config has `type: "remote"` with correct URL; if service is enabled, `soxe service status <ext>` shows loaded |

#### §2.2.7 Per-host verification

| Host | Config path | MCP format | Verify with |
|------|-------------|------------|-------------|
| `claude` | `.mcp.json` | `mcpServers.{id}: { type, command, args }` | `cat .mcp.json` |
| `opencode` | `opencode.json` | `mcp.{id}: { type: "local", command: [...] }` or `{ type: "remote", url: "..." }` | `cat opencode.json` |
| `codex` | `~/.codex/.mcp.json` | TBD | TBD |

#### §2.2.8 Log results

Write a confirmation list like this to the plan log:

```
[mcp-server verification]
1. memory_ping before: artifact=abc123, embed_state=real
2. nx affected:build: memory-server rebuilt (1932 KB)
3. soxe upgrade: memory-server STALE → upgraded (scope=user)
4. memory_ping after: artifact=def456 (CHANGED ✅)
5. behavior test: memory_recall("test query") returned N results ✅
6. host config: opencode.json mcp.memory-server = { type: "remote", url: "..." } ✅
```

---

### §2.3 Service extension changes

**Context:** Changes to services with `lifecycle.background` (memory-daemon, tokenguard).
These run as OS units (launchd/systemd) or in-process supervised daemons.

#### §2.3.1 Before

```
node bin/soxe service status <ext-id>
```

Log `loaded`, `live pids`, `entrypoint`, `unit file`.

#### §2.3.2 Build + deploy

```
npx nx affected:build --base=HEAD
node bin/soxe upgrade --all
```

#### §2.3.3 After — confirm restart

```
node bin/soxe service status <ext-id>
```

Verify:

- `loaded: yes`
- `live pids` list has a new pid (old pids should be reaped)
- `entrypoint` path is unchanged (or changed if you moved it)
- `content` hash changed if code changed

#### §2.3.4 If auto-restart didn't fire

```
node bin/soxe service enable <ext-id> --scope=<scope>
```

Then verify with `soxe service status`.

#### §2.3.5 Lifecycle tests

| Test | Command |
|------|---------|
| Enable | `node bin/soxe service enable <ext-id> --scope=user` |
| Status | `node bin/soxe service status <ext-id>` |
| Disable | `node bin/soxe service disable <ext-id> --scope=user` |
| Re-enable | `node bin/soxe service enable <ext-id> --scope=user` |
| Survivor reaped | `soxe service status` shows ≤1 live pid for the ext |

---

### §2.4 Agent extension changes

**Context:** Changes to `extensions/agents/*`. Agents are declarative — file-drop + config-merge.

#### §2.4.1 Build

```
npx nx build <agent-project>
```

#### §2.4.2 Per-host install verification

```
node bin/soxe install <agent-id> --host=<host> --scope=project --dry-run
node bin/soxe install <agent-id> --host=<host> --scope=project
```

| Host | Expected path | Verify |
|------|---------------|--------|
| `claude` | `.claude/agents/{id}/` | `ls .claude/agents/{id}/` |
| `opencode` | `.opencode/agents/{id}/` | `ls .opencode/agents/{id}/` |
| `codex` | `~/.codex/agents/{id}/` | `ls ~/.codex/agents/{id}/` |

#### §2.4.3 Content verification

```
head -20 .opencode/agents/{id}/*.md
```

Verify YAML frontmatter and prompt content are present and correct.

#### §2.4.4 Config verification (if agent has config-merge)

Check the host config file for the agent entry:

- opencode: `opencode.json` → `agent.{id}` key
- claude: `.claude.json` → `agent.{id}` key

#### §2.4.5 Uninstall round-trip

```
node bin/soxe uninstall <agent-id> --host=<host> --scope=project
ls .opencode/agents/    # {id} should be gone
```

#### §2.4.6 Cross-host

If the agent declares multiple hosts, verify each host independently.

---

### §2.5 Skill extension changes

**Context:** Changes to `extensions/skills/*`. Skills are file-drop only.

#### §2.5.1 Build

```
npx nx build <skill-project>
```

#### §2.5.2 Per-host install verification

```
node bin/soxe install <skill-id> --host=<host> --scope=project
```

| Host | Expected path | Verify |
|------|---------------|--------|
| `claude` | `.claude/skills/{id}/SKILL.md` | `ls .claude/skills/{id}/SKILL.md` |
| `opencode` | `.opencode/skills/{id}/SKILL.md` | `ls .opencode/skills/{id}/SKILL.md` |
| `codex` | `~/.codex/skills/{id}/SKILL.md` | `ls ~/.codex/skills/{id}/SKILL.md` |

#### §2.5.3 Content verification

```
head -10 .opencode/skills/{id}/SKILL.md
```

Verify frontmatter and description are present.

#### §2.5.4 Uninstall round-trip

```
node bin/soxe uninstall <skill-id> --host=<host> --scope=project
ls .opencode/skills/    # {id} should be gone
```

---

### §2.6 Command extension changes

**Context:** Changes to `extensions/commands/*`. Commands use file-drop + config-merge.

#### §2.6.1 Build

```
npx nx build <command-project>
```

#### §2.6.2 Per-host install verification

```
node bin/soxe install <command-id> --host=<host> --scope=project
```

| Host | File path | Config entry |
|------|-----------|--------------|
| `claude` | `.claude/commands/{id}.md` | `.claude.json` → `command.{id}` |
| `opencode` | `.opencode/tools/{id}/` | `opencode.json` → `command.{id}` |

#### §2.6.3 Verify config merge

For opencode: check `opencode.json` has `command.{id}` with `{ description, invoke }`.
For claude: check `.claude.json` has `command.{id}`.

---

### §2.7 Hook extension changes

**Context:** Changes to hook extensions (memory-flush, etc.). Hooks use array-merge.

#### §2.7.1 Build

```
npx nx build <hook-project>
```

#### §2.7.2 Verify array-merge

For opencode: check `opencode.json` → `plugin` array contains the hook entry.
For claude: check `.claude.json` → `hook` array.

---

### §2.8 Bundle extension changes

**Context:** Changes to `extensions/bundles/*`. Bundles expand into member extensions.

#### §2.8.1 Build all members

```
npx nx affected:build --base=HEAD   # should include all bundle members
```

#### §2.8.2 Install the bundle

```
node bin/soxe install <bundle-id> --host=<host> --scope=<scope>
```

#### §2.8.3 Verify every member

Apply the per-type playbook for EACH member extension type (mcp-server, service, skill, command, hook).
For example, `sox-memory-bundle` includes:

- `memory-server` → follow §2.2 (MCP server)
- `memory-daemon` → follow §2.3 (service)
- `memory-usage` → follow §2.5 (skill)
- `memory-cli` → follow §2.6 (command)
- `memory-flush` → follow §2.7 (hook)

#### §2.8.4 Upgrade round-trip

```
node bin/soxe upgrade --all
```

Verify all stale members were upgraded and any running daemons restarted.

---

### §2.9 Data library changes (graph-store, vector-store, embedding-provider, etc.)

**Context:** Changes to `libs/data/*`. These ship compiled dist consumed by memory-core
and memory-server. No direct install path — changes propagate through the build chain.

#### §2.9.1 Impact analysis

```
gitnexus_impact({target: "<exportedSymbol>", direction: "upstream"})
```

Data libraries are consumed by memory-core → memory-server. If any consumer is affected,
the full chain must be rebuilt and verified.

#### §2.9.2 Build propagation

```
npx nx affected:build --base=HEAD
```

Verify the output shows:

- The data library was rebuilt
- memory-core was rebuilt
- memory-server bundle was rebuilt

If Nx cache prevents rebuild, force it:

```
npx nx build memory-server --skip-nx-cache
```

#### §2.9.3 Verify the change shipped

1. Confirm the data library dist has the new export or behavior:

   ```
   node -e "const m = require('<package>/dist/index.js'); console.log(m.<newExport>)"
   ```

2. Run `soxe upgrade --all` to deploy to installed instances
3. Use in-session MCP tools to verify the change is live:
   - `memory_ping` — confirm artifact hash changed
   - `memory_recall` or another relevant tool — confirm new behavior

#### §2.9.4 Per-package specifics

| Package | Key behavior | Verify with |
|---------|-------------|-------------|
| `graph-store` | Node/edge CRUD, bitemporal | Write a test memory, recall it, check `t_valid`/`t_invalid` |
| `vector-store` | Space invariants, kNN | `memory_recall` with a known query; verify vec provenance |
| `embedding-provider` | Embed model, dims, ONNX | `memory_stats` → check `embed_state: "real"`, `embed_model` |
| `hybrid-search` | vec+BM25 fusion, ranking | `memory_recall` → check `provenance` array (vec, fts, temporal) |
| `analysis` | Clustering, near-dup | `memory_stats` → check `cluster_count`, `coverage`, `mean_intra_cluster_sim` |
| `ingest` | Content hash, extractive summary | `memory_write` → verify `content_hash` and `summary` in response |

---

### §2.10 Platform library changes (install-engine, manifest, host-registry, etc.)

**Context:** Changes to `libs/platform/*`. These ship compiled dist consumed by the CLI
or by other platform libs. The change affects how extensions are installed, validated,
or hosted.

#### §2.10.1 Impact analysis

```
gitnexus_impact({target: "<symbol>", direction: "upstream"})
```

Platform libs are highly interconnected. Trace all consumers before editing.

#### §2.10.2 Build all consumers

```
npx nx affected:build --base=HEAD
```

For install-engine changes, the CLI (`apps/sox`) must be rebuilt.
For manifest changes, extension validation must pass.

#### §2.10.3 Per-package verification

| Package | Verify with |
|---------|-------------|
| `install-engine` | `soxe install <ext> --dry-run` for each affected host/scope; then real install + uninstall round-trip |
| `manifest` | `nx test manifest` — validates extension.json files against schema |
| `host-registry` | `soxe install <ext> --host=<newhost> --dry-run` for each host; verify surface paths |
| `service-proxy` | Install an MCP server with stdio profile; verify in-session MCP tools work |
| `registry` | `npx nx run registry:sync-index`; verify `registry/index.json` updated |

---

### §2.11 Host-runtime changes (os-unit, supervisor, reaper, etc.)

**Context:** Changes to `libs/host-runtime/`. These affect the OS supervisor integration
(launchd/systemd), process lifecycle, and service management.

#### §2.11.1 Build

```
npx nx build host-runtime
npx nx build sox   # CLI must be rebuilt if it imports host-runtime
```

#### §2.11.2 Service lifecycle round-trip

```
node bin/soxe service enable <ext-id> --scope=user
node bin/soxe service status <ext-id>
node bin/soxe service disable <ext-id> --scope=user
```

Verify each command succeeds and the OS unit behaves correctly.

#### §2.11.3 Restart verification

1. Note current pid: `soxe service status <ext-id>`
2. Change config or reinstall to trigger restart
3. `soxe service status <ext-id>` — pid changed, unit loaded

#### §2.11.4 Survivor reaping

After disable, run `soxe service status <ext-id>`. Verify `loaded: no` and no stale pids.

---

### §2.12 CLI changes (apps/sox)

**Context:** Changes to `apps/sox/src/main.ts` or `bin/soxe`. The CLI is the user-facing
entry point for all soxe operations.

#### §2.12.1 Build

```
npx nx build sox
```

#### §2.12.2 Test affected commands

For each command affected, run `--dry-run` first, then the real command:

```
node bin/soxe <command> ... --dry-run
node bin/soxe <command> ...
```

#### §2.12.3 Verify output

- Does the command complete without error?
- Is the output format correct?
- Are ledger entries written correctly?
- Does `--help` show the new/changed flags?

#### §2.12.4 Per-command specifics

| Command | Verify |
|---------|--------|
| `install` | Dry-run shows correct paths; real install places files; ledger updated |
| `uninstall` | Removes files; ledger reversed; host config cleaned |
| `upgrade` | Detects stale consumers; reinstalls; auto-restarts daemons |
| `config set` | Writes to correct scope file; restarts affected daemons |
| `service enable` | Generates OS unit; loads it; status shows loaded |
| `service disable` | Unloads unit; reaps survivors; status shows not loaded |
| `service status` | Shows unit file, loaded state, pids, entrypoint |

---

### §2.13 MCP-runtime changes (transport, serve)

**Context:** Changes to `libs/mcp-runtime/`. These affect how MCP servers communicate
(stdio, SSE, HTTP) and how `soxe serve` works.

#### §2.13.1 Build

```
npx nx build mcp-runtime
```

#### §2.13.2 Transport mode verification

For each transport mode affected:

| Mode | Test |
|------|------|
| `stdio` | In-session MCP tools continue to work (existing connection via proxy) |
| `sse` | `soxe install memory-server --profile=sse` → config has correct remote URL |
| `http` | `soxe serve memory-server --transport=http --port=3099` → `curl http://localhost:3099/mcp` |

#### §2.13.3 Upgrade round-trip

```
npx nx build mcp-runtime
npx nx affected:build --base=HEAD
node bin/soxe upgrade --all
memory_ping   # verify hash changed, tools still work
```

---

### §2.14 Manifest schema changes

**Context:** Changes to `libs/manifest/src/index.ts` (types, validation, JSON schema).

#### §2.14.1 Build + validate

```
npx nx build manifest
npx nx test manifest
```

Manifest tests validate all `extension.json` files against the schema. Verify 100% pass rate.

#### §2.14.2 Extension round-trip

If you added a new host, type, or field:

```
node bin/soxe install <ext> --host=<newhost> --scope=project
```

Verify the manifest validates correctly at install time.

---

### §2.15 Host-registry changes (host modules)

**Context:** Adding a new host module or modifying existing host surface paths.

#### §2.15.1 Build

```
npx nx build host-registry
```

#### §2.15.2 Surface path verification

For every surface (agent, skill, command, mcp-server, service), verify the paths for each scope:

| Host | Scope | Surface | Expected path | Verify |
|------|-------|---------|---------------|--------|
| claude | project | agent | `.claude/agents/` | `soxe install <agent> --host=claude --scope=project --dry-run` |
| opencode | project | agent | `.opencode/agents/` | `soxe install <agent> --host=opencode --scope=project --dry-run` |
| opencode | user | skill | `~/.config/opencode/skills/` | `soxe install <skill> --host=opencode --scope=user --dry-run` |

#### §2.15.3 MCP format translation

For the mcp-server surface, verify the MCP config format matches the host spec:

```
node bin/soxe install memory-server --host=<host> --profile=stdio --scope=project --dry-run
```

Check the dry-run output or the config file for the correct format.

#### §2.15.4 Detection

Verify `detect()` returns true when the host's sentinel files exist:

- claude: `.claude/` or `CLAUDE.md` or `.mcp.json`
- opencode: `opencode.json` or `.opencode/`
- codex: `.codex/` or `codex.json`

---

## §3 Scope-Based Verification

Some changes interact with scope resolution. Verify the change in each relevant scope.

| Scope | Storage | Lifecycle | Verify |
|-------|---------|-----------|--------|
| `project` | `<projectRoot>/` | Tied to repo | Install to project scope, check project-root paths |
| `user` | `~/.config/<host>/` or `~/.<host>/` | Survives project changes | Install to user scope, check home-dir paths |
| `local` | `<projectRoot>/` (gitignored) | Project-local, not tracked | Install to local scope, verify files present but gitignored |
| `org` | `./.well-known/<host>/` | Read-only, remote | Verify org scope is NEVER written to (`[inv:never-managed]`) |

For user scope, test with `SOX_SANDBOX_ROOT` to verify sandbox isolation:

```
SOX_SANDBOX_ROOT=/tmp/sandbox node bin/soxe install <ext> --host=<host> --scope=user --dry-run
```

Verify paths reroot to `/tmp/sandbox/...` instead of `~/.config/...`.

---

## §4 Host-Based Verification Matrix

| Host | Config files | Discovery | MCP format |
|------|-------------|-----------|------------|
| `claude` | `.mcp.json`, `.claude.json`, `CLAUDE.md` | `.claude/` dirs, `.mcp.json` | `mcpServers.{id}: { type, command, args }` |
| `opencode` | `opencode.json` | `.opencode/` dirs, `opencode.json` | `mcp.{id}: { type: "local", command: [...] }` or `{ type: "remote", url }` |
| `codex` | `~/.codex/.mcp.json`, `~/.agents/` | `~/.codex/`, `~/.agents/` | `mcpServers.{id}: { type, command, args }` |

For any change touching multiple hosts, verify each host independently.

---

## §5 Integration With Agent System Prompts

### §5.1 How agents consume this document

Every agent (`pro`, `implement`, `flash`) must read `CONTRIBUTING.md` at the start of
their session. The system prompts mandate this. The playbook is their source of truth for
what "done" means.

### §5.2 Reporting format

After completing changes, agents write a verification section to their report:

```json
{
  "verification": {
    "universal": {
      "nx_affected_lint": "passed",
      "nx_affected_build": "passed",
      "nx_affected_test": "passed (N passed, 0 failed)",
      "gitnexus_detect_changes": "only expected symbols changed",
      "git_diff_stat": "M files, +X/-Y lines"
    },
    "type_specific": {
      "playbook_section": "§2.2",
      "before_state": { "memory_ping": { "artifact": "abc123" } },
      "after_state": { "memory_ping": { "artifact": "def456" } },
      "change_detected": true,
      "behavior_verified": "memory_recall returned expected results"
    }
  }
}
```

---

## §6 Emergency Exceptions

If verification is impossible (e.g., MCP server is down, daemon won't start, no
in-session tools available), you MUST:

1. Document the blocker in `BACKLOG.md`
2. Explain why verification was skipped in the report
3. List the exact command(s) that failed and their output
4. Get explicit approval from the orchestrator to proceed

Never skip verification silently. A skipped verification is an open risk.

---

## §7 Quick Reference Card

```
# Before any change
gitnexus_impact({target: "symbol", direction: "upstream"})

# After any change
npx nx affected:lint --base=HEAD
npx nx affected:build --base=HEAD
npx nx affected:test --base=HEAD
gitnexus_detect_changes()
git diff --stat

# If registry packages changed
npx nx run registry:sync-index

# If extensions changed
node bin/soxe upgrade --all

# Then follow the per-type playbook in §2

# ⛔ BEFORE any config-merge test install:
cp opencode.json opencode.json.bak    # back up host config
cp .mcp.json .mcp.json.bak            # back up claude config

# ⛔ AFTER verification:
cp opencode.json.bak opencode.json    # restore original
cp .mcp.json.bak .mcp.json            # restore original
node bin/soxe uninstall <test-id> --host=<h> --scope=<s>
rm -rf .opencode/agents/<test-id>/ .opencode/skills/<test-id>/
rm -f opencode.json.bak .mcp.json.bak  # remove backups
```
