# OpenCode Host — Implementation Specs (Flash-Ready)

This file contains exact code-level implementation specs for the complex segments in SCOPE.md. Each section includes: the exact file, the exact insertion point, the exact code to write or modify, and the test assertions to verify correctness.

---

## Segment 1: Engine Change — `Surface.mcpConfig`

### 1a. Add `mcpConfig` to Surface type

**File:** `libs/host-registry/src/internal.ts`
**Insertion point:** After line 70 (closing `}` of `Surface` interface), insert the `McpConfig` type and the new field:

```ts
/** Per-host MCP config builder. When a host module sets this on its mcp-server
 *  surface, declarativeInstall() uses it instead of the hardcoded Claude-format
 *  auto-derivation (mcpServers.{id}, { type:'stdio', command, args }). */
export interface McpConfig {
  /** Returns the config key path for the MCP server entry.
   *  e.g. 'mcpServers.{id}' for Claude, 'mcp.{id}' for OpenCode. */
  keyPath(extId: string): string;

  /** Returns the config value for the given profile + CLI bin.
   *  - 'sse'/'http' profiles receive a remote URL.
   *  - 'stdio' profile receives a command array or command+args object. */
  value(profile: string, cliBin: string, extId: string): unknown;
}
```

Then add the field to `Surface` (between `format` and `paths`):

```ts
export interface Surface {
  capability: CapabilityId;
  format?: 'json' | 'toml';
  /** Optional per-host MCP config builder. */
  mcpConfig?: McpConfig;
  paths: Partial<Record<HostScope, string>>;
}
```

**Export `McpConfig`** from the barrel. Add `McpConfig` to the `export type { ... }` block in `libs/host-registry/src/index.ts`:

```ts
export type {
  HostScope,
  CapabilityId,
  Surface,
  SurfaceMap,
  ScopePathMap,
  HostModule,
  McpConfig,   // <-- ADD THIS LINE
} from './internal.js';
```

**Test:** TypeScript builds. No usages of `McpConfig` yet — defined but optional, zero behavioral change.

---

### 1b. Check `surface.mcpConfig` in `declarativeInstall()`

**File:** `libs/install-engine/src/install.ts`
**Insertion point:** Lines 1552-1575 (the `if (descriptor.type === 'mcp-server' && (resolvedKeyPath ...` block). Wrap the existing block:

```ts
let resolvedKeyPath = descriptor.configKeyPath;
let resolvedValue = descriptor.configValue;
if (descriptor.type === 'mcp-server' && (resolvedKeyPath === undefined || resolvedValue === undefined)) {
  // If the host provides an mcpConfig builder, use it.
  if (surface.mcpConfig) {
    const cliBin =
      process.env['SOX_CLI_BIN'] ??
      (process.argv[1] && process.argv[1].length > 0 ? process.argv[1] : undefined) ??
      'soxe';
    const profile = descriptor.profile ?? 'stdio';
    resolvedKeyPath = surface.mcpConfig.keyPath(descriptor.ext);
    resolvedValue = surface.mcpConfig.value(profile, cliBin, descriptor.ext);
  } else {
    // Default: Claude-format auto-derivation (preserved for backward compat).
    const profile = descriptor.profile ?? 'stdio';
    resolvedKeyPath = `mcpServers.${descriptor.ext}`;
    if (profile === 'sse' || profile === 'http') {
      resolvedValue = { type: profile, url: 'http://localhost:3000/' + profile };
    } else {
      const cliBin =
        process.env['SOX_CLI_BIN'] ??
        (process.argv[1] && process.argv[1].length > 0 ? process.argv[1] : undefined) ??
        'soxe';
      resolvedValue = { type: 'stdio', command: cliBin, args: ['serve', descriptor.ext] };
    }
  }
}
```

**Test:**
1. Install memory-server with claude host → output is `mcpServers.memory-server: { type: 'stdio', command: 'soxe', args: ['serve', 'memory-server'] }` (unchanged)
2. Install memory-server with opencode host → output is `mcp.memory-server: { type: 'local', command: ['soxe', 'serve', 'memory-server'] }` (new format)
3. SSEServerTransport/Sse profile with opencode → output is `mcp.memory-server: { type: 'remote', url: 'http://localhost:{port}/mcp' }`

---

## Segment 2: OpenCode Host Module

### 2a. Full `opencode.ts`

**File:** `libs/host-registry/src/opencode.ts`
**Template:** Mirror `claude.ts` (279 lines). Use the same import pattern, same `getBase()` sandbox pattern, same `scopePaths()` switch.

```ts
import * as os from 'os';
import * as path from 'path';
import type { HostModule, HostScope, ScopePathMap, SurfaceMap, McpConfig } from './internal.js';
import { existsIn } from './internal.js';

// ─── Detection ──────────────────────────────────────────────────────────────

/** Detect OpenCode from the workspace root: opencode.json or .opencode/ dir. */
function detect(workspaceRoot: string): boolean {
  return (
    existsIn(workspaceRoot, 'opencode.json') ||
    existsIn(workspaceRoot, '.opencode')
  );
}

// ─── Scope root paths ──────────────────────────────────────────────────────

const HOME = os.homedir();

function getBase(): string {
  const sandbox = process.env['SOX_SANDBOX_ROOT'];
  return sandbox !== undefined && sandbox !== '' ? sandbox : HOME;
}

function scopePaths(scope: HostScope): ScopePathMap {
  switch (scope) {
    case 'project':
      return { project: '.opencode' };
    case 'user':
      return { user: path.join(getBase(), '.config', 'opencode') };
    case 'local':
      return { local: '.opencode' };
    case 'org':
      return {}; // .well-known/opencode — remote, read-only.
    default: {
      const _exhaustive: never = scope;
      return _exhaustive;
    }
  }
}

// ─── MCP config builder ────────────────────────────────────────────────────

/**
 * OpenCode MCP format:
 *   - Key path: mcp.{id} (NOT mcpServers.{id})
 *   - stdio profile: { type: "local", command: [cliBin, "serve", extId] }
 *   - sse/http profile: { type: "remote", url: "http://localhost:<port>/mcp" }
 */
const mcpConfig: McpConfig = {
  keyPath(extId: string): string {
    return `mcp.${extId}`;
  },
  value(profile: string, cliBin: string, extId: string): unknown {
    if (profile === 'sse' || profile === 'http') {
      // Port defaults to 3000; override via config_schema or env.
      // The install engine doesn't read config cascade here — the caller
      // (cmdInstall) can pass a resolved port as descriptor.configValue.
      // When no explicit port, use a default that the documentation covers.
      const port = 3000;
      return { type: 'remote', url: `http://localhost:${port}/mcp` };
    }
    // stdio (default): opencode's "local" type uses command as array.
    return { type: 'local', command: [cliBin, 'serve', extId] };
  },
};

// ─── Surfaces ──────────────────────────────────────────────────────────────

function buildSurfaces(): SurfaceMap {
  const base = getBase();
  const projectJson = (scope: 'project' | 'user'): string =>
    scope === 'project' ? 'opencode.json' : path.join(base, '.config', 'opencode', 'opencode.json');

  return {
    // ── file-drop surfaces ────────────────────────────────────────────────

    agent: {
      capability: 'file-drop',
      paths: {
        project: '.opencode/agents',
        user: path.join(base, '.config', 'opencode', 'agents'),
      },
    },

    skill: {
      capability: 'file-drop',
      paths: {
        project: '.opencode/skills',
        user: path.join(base, '.config', 'opencode', 'skills'),
      },
    },

    command: {
      capability: 'file-drop',
      paths: {
        project: '.opencode/tools',
        user: path.join(base, '.config', 'opencode', 'tools'),
        local: '.opencode/tools',
      },
    },

    // opencode supports .claude/skills/ as a fallback discovery path,
    // so skills placed there by the claude host are visible to opencode too.
    // No need for a separate surface — the claude skill surface covers it.

    // ── config-merge surfaces ─────────────────────────────────────────────

    'mcp-server': {
      capability: 'config-merge',
      format: 'json',
      mcpConfig,   // <-- THE KEY: overrides engine's default Claude format
      paths: {
        project: 'opencode.json',
        user: path.join(base, '.config', 'opencode', 'opencode.json'),
      },
    },

    // hook (plugin) → npm package name added to plugin array
    // The manifest must declare a plugin.packageName field for this to work.
    // For now: placeholder. opencode plugins need npm packaging — future work.
    // hook: {
    //   capability: 'array-merge',
    //   format: 'json',
    //   paths: {
    //     project: 'opencode.json',
    //     user: path.join(base, '.config', 'opencode', 'opencode.json'),
    //   },
    // },

    // ── run-service (service type) ────────────────────────────────────────

    service: {
      capability: 'run-service',
      paths: {
        project: '.sox',
        user: path.join(base, '.sox'),
      },
    },
  };
}

// ─── Export ────────────────────────────────────────────────────────────────

export const opencodeHost: HostModule = {
  host: 'opencode',
  detect,
  scopePaths,
  get surfaces(): SurfaceMap {
    return buildSurfaces();
  },
};
```

**Test file:** `libs/host-registry/src/opencode.spec.ts`

```ts
// Test 1: detect() returns true when opencode.json exists
// Test 2: detect() returns true when .opencode/ dir exists
// Test 3: detect() returns false for empty workspace
// Test 4: scopePaths('project') returns { project: '.opencode' }
// Test 5: scopePaths('user') returns { user: '$HOME/.config/opencode' }
// Test 6: scopePaths('org') returns {}
// Test 7: mcp-server surface has mcpConfig defined
// Test 8: mcpConfig.keyPath('memory-server') returns 'mcp.memory-server'
// Test 9: mcpConfig.value('stdio', 'soxe', 'memory-server') returns
//         { type: 'local', command: ['soxe', 'serve', 'memory-server'] }
// Test 10: mcpConfig.value('sse', 'soxe', 'memory-server') returns
//          { type: 'remote', url: 'http://localhost:3000/mcp' }
// Test 11: agent surface paths point to .opencode/agents
// Test 12: skill surface paths point to .opencode/skills
// Test 13: SOX_SANDBOX_ROOT reroots user paths
```

### 2b. Register in index

**File:** `libs/host-registry/src/index.ts`
**Insertion point:** After `import { codexHost } from './codex.js';` (line 47), add:

```ts
import { opencodeHost } from './opencode.js';
```

In `_registry` map (line 49), add the entry:

```ts
const _registry: Map<string, HostModule> = new Map([
  [claudeHost.host, claudeHost],
  [codexHost.host, codexHost],
  [opencodeHost.host, opencodeHost],
]);
```

---

## Segment 3: Manifest Schema Changes

**File:** `libs/manifest/src/index.ts`

### 3a. Union type (line ~112)

Find `hosts?: Array<'claude' | 'codex'>;` and change to:

```ts
hosts?: Array<'claude' | 'codex' | 'opencode'>;
```

### 3b. Runtime validator `knownHosts` (line ~686)

Find `const knownHosts = new Set(['claude', 'codex']);` and change to:

```ts
const knownHosts = new Set(['claude', 'codex', 'opencode']);
```

### 3c. JSON Schema enum (line ~997)

Find `"enum": ["claude", "codex"]` in the hosts schema and change to:

```json
"enum": ["claude", "codex", "opencode"]
```

**Test:** Build manifest package. Validate that `"hosts": ["opencode"]` passes schema validation. Validate that invalid host `"nonexistent"` still fails.

---

## Segment 4: Improvement E — Auto-Restart Daemons

### 4a. `restartOsUnit()` in os-unit.ts

**File:** `libs/host-runtime/src/os-unit.ts`
**Insertion point:** After `enableOsUnit()` (line ~560), add the restart function. It takes the existing `enableOsUnit` pattern and adds the restart loop guard.

```ts
export interface RestartOptions {
  unitDir?: string;
  exec?: OsExec;
  log?: (m: string) => void;
}

export interface RestartResult {
  action: 'restarted' | 'unchanged' | 'failed' | 'reverted_to_lkg';
  label: string;
  unitPath: string;
  contentHash: string;
  loaded: boolean;
  /** Reason for the restart (config key change, upgrade, etc.). Used in log message. */
  reason?: string;
}

/**
 * Restart an OS unit: unload the current unit, regenerate with new content,
 * load the new unit. Implements the restart loop guard: if the unit crashes
 * ≥3 times within 60s after restart, revert to the last-known-good spec.
 *
 * Callers must provide the NEW OsUnitSpec (reflecting the config change or
 * artifact upgrade) and the path to the last-known-good unit file (from the
 * ownership index's os-unit entry).
 */
export async function restartOsUnit(
  newSpec: OsUnitSpec,
  lastKnownGoodPath: string | undefined,
  opts: RestartOptions = {},
): Promise<RestartResult> {
  const log = opts.log ?? (() => {});
  const unitDir = opts.unitDir ?? defaultUnitDir();
  const exec = opts.exec ?? defaultExec;
  const platform = resolvePlatform(unitDir, exec, log);

  const unitPath = path.join(unitDir, platform.unitFileName(newSpec.label));

  // 1. Unload the current unit first ([inv:unload-then-reap]).
  const wasLoaded = platform.isLoaded(newSpec.label, exec);
  if (wasLoaded) {
    const ur = platform.unload(unitPath, newSpec.label, exec);
    log(`os-unit ${newSpec.label}: unloaded (code ${ur.code})`);
    // Brief yield so the OS supervisor finishes teardown.
    await new Promise((r) => setTimeout(r, 500));
  }

  // 2. If an OS-supervised dead process is still around, reap it.
  const { reapByIdentity, identityToken } = require('./reaper.js');
  const token = identityToken(newSpec.entrypoint);
  if (token) {
    await reapByIdentity(token, { log: (m: string) => log(`reaper: ${m}`) });
  }

  // 3. Render + write the new unit.
  const rendered = platform.render(newSpec);
  const contentHash = unitContentHash(rendered);
  writeFileAtomic(unitPath, rendered);
  log(`os-unit ${newSpec.label}: written (content-hash ${contentHash})`);

  // 4. Load the new unit.
  const lr = platform.load(unitPath, newSpec.label, exec);
  if (lr.code !== 0) {
    log(`os-unit ${newSpec.label}: load FAILED (code ${lr.code})`);
    // If load fails AND we have an LKG, revert.
    if (lastKnownGoodPath && fs.existsSync(lastKnownGoodPath)) {
      log(`os-unit ${newSpec.label}: reverting to last-known-good`);
      writeFileAtomic(unitPath, fs.readFileSync(lastKnownGoodPath, 'utf8'));
      const r2 = platform.load(unitPath, newSpec.label, exec);
      return {
        action: 'reverted_to_lkg',
        label: newSpec.label,
        unitPath,
        contentHash,
        loaded: r2.code === 0,
        reason: opts.reason,
      };
    }
    return { action: 'failed', label: newSpec.label, unitPath, contentHash, loaded: false };
  }

  log(`os-unit ${newSpec.label}: loaded`);

  // 5. Restart loop guard: monitor for 60s. If the unit crashes ≥3 times,
  //    revert to LKG.
  if (newSpec.keepAlive && lastKnownGoodPath && fs.existsSync(lastKnownGoodPath)) {
    const guard = new RestartLoopGuard(newSpec.label, platform, exec, 3, 60_000, log);
    const guardResult = await guard.monitor();
    if (guardResult === 'loop') {
      log(`os-unit ${newSpec.label}: CRASH LOOP DETECTED — reverting to LKG`);
      platform.unload(unitPath, newSpec.label, exec);
      writeFileAtomic(unitPath, fs.readFileSync(lastKnownGoodPath, 'utf8'));
      platform.load(unitPath, newSpec.label, exec);
      return {
        action: 'reverted_to_lkg',
        label: newSpec.label,
        unitPath,
        contentHash,
        loaded: true,
        reason: `restart-loop-guard: ${opts.reason ?? 'unknown'}`,
      };
    }
  }

  return {
    action: 'restarted',
    label: newSpec.label,
    unitPath,
    contentHash,
    loaded: true,
    reason: opts.reason,
  };
}

/**
 * Restart loop guard: polls service liveness for `durationMs`. If the service
 * is observed down ≥`crashThreshold` times within the window, reports 'loop'.
 */
class RestartLoopGuard {
  private readonly label: string;
  private readonly platform: OsUnitPlatform;
  private readonly exec: OsExec;
  private readonly threshold: number;
  private readonly durationMs: number;
  private readonly log: (m: string) => void;
  private deaths = 0;

  constructor(
    label: string,
    platform: OsUnitPlatform,
    exec: OsExec,
    threshold: number,
    durationMs: number,
    log: (m: string) => void,
  ) {
    this.label = label;
    this.platform = platform;
    this.exec = exec;
    this.threshold = threshold;
    this.durationMs = durationMs;
    this.log = log;
  }

  /** Monitor for `durationMs`. Returns 'loop' if threshold exceeded, 'ok' otherwise. */
  async monitor(): Promise<'loop' | 'ok'> {
    const pollInterval = 500;
    const polls = Math.floor(this.durationMs / pollInterval);
    for (let i = 0; i < polls; i++) {
      await new Promise((r) => setTimeout(r, pollInterval));
      const live = this.platform.isLoaded(this.label, this.exec);
      if (!live) {
        this.deaths++;
        this.log(`restart-guard ${this.label}: down (${this.deaths}/${this.threshold})`);
        if (this.deaths >= this.threshold) return 'loop';
      }
    }
    return 'ok';
  }
}
```

**Export** `restartOsUnit` and `RestartResult` from `os-unit.ts`'s existing exports, and from `libs/host-runtime/src/index.ts`.

**Test:**
1. `restartOsUnit` with valid spec → returns `action: 'restarted'`, unit loaded
2. `restartOsUnit` when unit not loaded → unload is no-op, new unit loaded
3. `restartOsUnit` with broken spec (load fails) + LKG exists → reverts, returns `action: 'reverted_to_lkg'`
4. Restart loop guard: mock `isLoaded` to toggle false 3 times → returns `action: 'reverted_to_lkg'`
5. Restart loop guard: 2 deaths → returns `action: 'restarted'` (under threshold)
6. `--no-restart` path → `restartOsUnit` is NEVER called

### 4b. Wire into `cmdConfigSet`

**File:** `apps/sox/src/main.ts`
**Insertion point:** Inside the config-set handler, after writing config to the scope file. The exact lines vary by scope — find the `fs.writeFileSync(configPath, ...)` or equivalent save call. After it:

```ts
// After config is written to the scope file AND saved...

// ── Restart affected daemons (Improvement E) ──
const noRestart = args.includes('--no-restart');
if (!noRestart) {
  // Load the ownership index so we know which OS units are registered.
  const { OwnershipIndex } = require('@adhd/sox-install-engine') as typeof import('@adhd/sox-install-engine');
  const { restartOsUnit, osUnitLabel, deriveOsUnitSpec } =
    require('@adhd/sox-host-runtime') as typeof import('@adhd/sox-host-runtime');
  const { dataRoot } = require('@adhd/sox-install-engine') as typeof import('@adhd/sox-install-engine');

  // Config set works per-extension, per-key. The affected extension is `extId`.
  // Query the ownership index for this extension in EVERY scope (config can
  // cascade across scopes even if we only wrote to one — the OS unit reads
  // the cascade at boot, so we must check all scopes).
  const scopes: DataScope[] = ['user', 'project', 'local'];
  let restarted = 0;

  for (const s of scopes) {
    const idx = OwnershipIndex.load(s);
    const record = idx.get(extId, s);
    if (!record) continue;

    // Find os-unit entries in this record.
    const osUnitEntry = record.entries.find((e: any) => e.kind === 'os-unit');
    if (!osUnitEntry) continue;

    // Read the LKG unit file for the revert guard.
    const lkgExists = fs.existsSync(osUnitEntry.unitPath);
    const lkgPath = lkgExists ? osUnitEntry.unitPath : undefined;

    // Derive the new spec with the updated config.
    const scopeRoot = dataRoot(s, root);
    // Re-build the config env from the cascade (includes the just-written value).
    const configEnv = buildExtConfigEnv(extId, root);
    const manifest = resolveServeManifest(extId, s, root);
    if (!manifest) continue;

    const newSpec = deriveOsUnitSpec({
      id: extId,
      scope: s,
      lifecycle: manifest.lifecycle,
      entrypoint: manifest.entrypoint,
      nodePath: resolveOsUnitContextNode(manifest, { allowVolatileNode: false }),
      configEnv,
      storeDir: path.join(scopeRoot, 'ext', extId),
      artifactHash: record.artifactChecksum,
    });

    const label = osUnitLabel(s, extId);
    const result = await restartOsUnit(newSpec, lkgPath, {
      reason: `config change: ${key}=${value} (scope=${scope})`,
      log,
    });

    if (result.action === 'restarted') restarted++;
    log(`${extId}: ${result.action} (scope=${s}, ${result.reason ?? ''})`);
  }

  if (restarted > 0) {
    process.stdout.write(`restarted ${restarted} daemon(s) affected by config change\n`);
  }
}
```

**Test:**
1. `soxe config set memory-server port 3099` → daemon restarted on new port
2. `soxe config set memory-server port 3099 --no-restart` → config saved, daemon unchanged
3. `soxe config set --dry-run memory-server port 3099` → reports what WOULD restart, doesn't touch anything
4. Config set for non-daemon extension (skill) → no restart, no error
5. Config set for extension with no OS unit → config saved, logged "not running"

### 4c. Wire into `declarativeInstall()`

**File:** `libs/install-engine/src/install.ts`
**Insertion point:** After the main `for (const hostName of descriptor.hosts)` loop completes and before the function returns, add a post-install restart block:

```ts
// ── Restart affected daemons after install/upgrade (Improvement E) ──
// Only when an artifact was actually placed (not a config-only install).
// Check ownership index for this extension — if it has an os-unit entry,
// reload it so the daemon picks up the new code.

async function maybeRestartAfterInstall(
  extId: string,
  scope: string,
  scopeRoot: string,
  newChecksum: string | undefined,
  opts: InstallOptions | undefined,
): Promise<void> {
  const noRestart = opts?.noRestart === true;
  if (noRestart) return;

  // Lazy-load ownership + os-unit modules.
  const { OwnershipIndex } = await import('./ownership.js');
  const { restartOsUnit, deriveOsUnitSpec } =
    // os-unit lives in host-runtime which is higher in the dep graph.
    // install-engine must NOT import host-runtime directly.
    // Instead, callers (cmdInstall) provide the restart hook.
    {} as any; // See note below.
}
```

**IMPORTANT:** The install engine (`libs/install-engine`) must NOT import from `libs/host-runtime` (would create a circular or upward dependency). Instead, the restart trigger is handled at the CLI layer in `apps/sox/src/main.ts` inside `cmdInstall()`, AFTER `declarativeInstall()` returns. The CLI has access to both install-engine AND host-runtime.

**Place this code in `apps/sox/src/main.ts` `cmdInstall()` after `declarativeInstall()` returns:**

```ts
// After declarativeInstall() returns successfully...
// ── Restart daemons if artifact changed (Improvement E) ──
if (!noRestartFlag) {
  const { OwnershipIndex } = require('@adhd/sox-install-engine') as typeof import('@adhd/sox-install-engine');
  const { restartOsUnit, osUnitLabel, deriveOsUnitSpec } =
    require('@adhd/sox-host-runtime') as typeof import('@adhd/sox-host-runtime');
  const { dataRoot } = require('@adhd/sox-install-engine') as typeof import('@adhd/sox-install-engine');

  const idx = OwnershipIndex.load(scope as DataScope);
  const record = idx.get(id, scope as string);
  if (record) {
    const osUnitEntry = record.entries.find((e: any) => e.kind === 'os-unit');
    if (osUnitEntry) {
      const newChecksum = /* artifact checksum from resolve step */;
      if (newChecksum !== record.artifactChecksum) {
        // Entrypoint changed — reload the unit.
        const lkgPath = fs.existsSync(osUnitEntry.unitPath) ? osUnitEntry.unitPath : undefined;
        const configEnv = buildExtConfigEnv(id, root);
        const manifest = resolveServeManifest(id, scope, root);
        if (manifest) {
          const newSpec = deriveOsUnitSpec({
            id, scope, lifecycle: manifest.lifecycle,
            entrypoint: manifest.entrypoint,
            nodePath: resolveOsUnitContextNode(manifest, { allowVolatileNode: false }),
            configEnv,
            storeDir: path.join(dataRoot(scope, root), 'ext', id),
            artifactHash: newChecksum,
          });
          const result = await restartOsUnit(newSpec, lkgPath, {
            reason: `upgrade (${record.artifactChecksum?.slice(0,7) ?? 'none'} → ${newChecksum.slice(0,7)})`,
          });
          log(`post-install: ${id} ${result.action} ${result.reason ?? ''}`);
        }
      } else {
        log(`post-install: ${id} entrypoint unchanged — no restart needed`);
      }
    }
  }
}
```

**Test:**
1. Install upgrade with code change → daemon restarted, log shows old→new checksum
2. Install upgrade with NO code change (host config only) → daemon NOT restarted
3. Install upgrade with `--no-restart` → daemon unchanged
4. Install extension with no OS unit → no restart triggered
5. Uninstall → does NOT remove OS unit, logs guidance to run `soxe service disable`

---

## Segment 5: Improvement B — Service-Running Detection

**File:** `libs/install-engine/src/install.ts`
**Insertion point:** After the `config-merge` handler writes the config value (line ~1600 area, after `ledger.save()`), add a post-install hint. The hint is host-specific — each host module can provide one.

### 5a. Add optional `postInstallHint` to Surface

**File:** `libs/host-registry/src/internal.ts`

```ts
export interface Surface {
  capability: CapabilityId;
  format?: 'json' | 'toml';
  mcpConfig?: McpConfig;
  /** Optional post-install hint. Returned verbatim by declarativeInstall()
   *  to the caller so the CLI can display host-specific guidance. */
  postInstallHint?: string;
  paths: Partial<Record<HostScope, string>>;
}
```

### 5b. Return hints from `declarativeInstall()`

**File:** `libs/install-engine/src/install.ts`

Add a `hints: string[]` field to the return type (or to each `Result` entry). After each surface capability is applied, if `surface.postInstallHint` is set, push it:

```ts
if (surface.postInstallHint) {
  hints.push(surface.postInstallHint);
}
```

### 5c. Set hints on opencode surfaces

**File:** `libs/host-registry/src/opencode.ts`

On the `mcp-server` surface, add:

```ts
'mcp-server': {
  capability: 'config-merge',
  format: 'json',
  mcpConfig,
  postInstallHint:
    'MCP server installed to opencode. Run `soxe service enable {ext}` to keep it running across sessions (remote profile), or opencode will spawn it per-session (local profile).',
  paths: { ... },
},
```

**Test:**
1. `soxe install memory-server --host=opencode --profile=sse` → CLI output includes the hint
2. `soxe install memory-server --host=opencode --profile=stdio` → hint still displayed (user can choose to enable service later)
3. `soxe install memory-server --host=claude` → no opencode-specific hint (existing behavior)

---

## Segment 6: Improvement A — HTTP Transport Upgrade

### 6a. Upgrade SSE → StreamableHTTP

**File:** `libs/mcp-runtime/src/transport.ts`

Find the import of `SSEServerTransport` and replace with `StreamableHTTPServerTransport`:

```ts
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
```

Find the `connectSse` function. Rename it to `connectStreamableHttp` (keep `connectSse` as a deprecated alias that just calls `connectStreamableHttp`). The implementation:

```ts
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

export async function connectStreamableHttp(
  server: Server,
  opts: TransportOptions = {},
): Promise<TransportHandle> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(transport);

  const httpServer = createServer((req, res) => {
    void transport.handleRequest(req, res);
  });

  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 0;

  return new Promise((resolve, reject) => {
    httpServer.on('error', reject);
    httpServer.listen(port, host, () => {
      const addr = httpServer.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to bind HTTP server'));
        return;
      }
      resolve({
        mode: 'http' as const,
        port: addr.port,
        close: async () => {
          await transport.close();
          httpServer.close();
        },
      });
    });
  });
}

// Backward compat alias.
export const connectSse = connectStreamableHttp;
```

Update `TransportMode`:
```ts
export type TransportMode = 'stdio' | 'sse' | 'http';
```

Update `serves` in `index.ts`:
```ts
export const serves = ['stdio', 'sse', 'http'] as const;
```

**Test:**
1. `serve(tools, { transport: { mode: 'http', port: 3099 } })` → HTTP server bound on port 3099
2. GET /mcp → SSE stream opened (StreamableHTTP handles this)
3. POST /mcp with JSON-RPC → response returned
4. `soxe serve memory-server --transport=http --port=3099` → server starts, curl-able
5. Existing sse mode still works (backward compat alias)
6. Default stdio mode unchanged

---

## Verification: Cross-Cutting Tests

Run after all segments are complete:

```bash
# Build all affected packages
nx build @adhd/sox-host-registry
nx build @adhd/sox-install-engine
nx build @adhd/sox-mcp-runtime
nx build @adhd/sox-manifest
nx build apps-sox

# Unit tests
nx test @adhd/sox-host-registry       # opencode.spec.ts, claude unchanged
nx test @adhd/sox-install-engine      # install engine: config-merge with mcpConfig
nx test @adhd/sox-mcp-runtime         # HTTP transport path
nx test @adhd/sox-manifest            # opencode in hosts enum

# Integration: install to opencode
soxe install test-agent --host=opencode --scope=project --dry-run
soxe install sox-ingest --host=opencode --scope=project --dry-run
soxe install memory-server --host=opencode --profile=stdio --scope=project --dry-run
soxe install memory-server --host=opencode --profile=sse --scope=project --dry-run

# Verify opencode.json format is correct
cat opencode.json  # should have mcp.memory-server with { type:'local'|'remote' }

# Cross-host: install to both hosts
soxe install memory-org --host=claude --host=opencode --scope=project --dry-run

# Uninstall round-trip
soxe install memory-server --host=opencode --scope=project
soxe uninstall memory-server --host=opencode --scope=project
# verify opencode.json no longer has mcp.memory-server

# Service pairing: restart on config change
soxe service enable memory-server --scope=user
soxe config set memory-server port 3099 --scope=user  # → daemon restarts
soxe service status memory-server  # → loaded, running on 3099

# Restart loop guard
# (hard to test without a real crash scenario; use unit test above)
```
