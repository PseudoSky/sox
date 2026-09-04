# @adhd/sox-host-runtime

The process and extension host runtime underneath the `soxe` CLI ecosystem: it loads an `extensions.lock` file, spawns and supervises each extension's process, dispatches lifecycle events (`PreToolUse`, `PostToolUse`, `SessionEnd`, …) through an isolated hook bus, registers MCP servers and their tools, and owns every path soxe writes to disk (`~/.adhd/sox-ecosystem/…`, ADR-0004). It also carries the operational hardening that keeps a long-running host honest: crash-loop capping, verified process kill + orphan reaping, cross-scope singleton healing, and generators for real OS service units (launchd `.plist` / systemd `.service`).

This package has no store/adapter dependency and is not part of the `@adhd/sox-store-adapter` family — it manages OS processes and the filesystem, not a database.

```bash
pnpm add @adhd/sox-host-runtime
```

## Quick start

The hook loader + event bus is the core dispatch primitive — every lifecycle notification in a soxe host flows through it. A throwing hook never aborts the chain (`fireIsolated`), so one broken extension can't take down the others:

```typescript
import { HookLoader, HostEventBus } from '@adhd/sox-host-runtime';

const hookLoader = new HookLoader();
hookLoader.register(
  { id: 'audit-logger', event: 'SessionEnd', order: 1 },
  async (ctx) => {
    console.log(`[audit] session ended at ${ctx.timestamp}`);
  },
);

const bus = new HostEventBus(hookLoader);
bus.on('SessionEnd', async () => {
  console.log('cleanup reaction ran');
});

const results = await bus.emit('SessionEnd', { timestamp: new Date().toISOString() });
// emit() runs the HookLoader's registered hooks first, then the bus's own `on()`
// reactions — one result per participant, `undefined` on success or `{ id, error }`
// on a caught throw.
console.log(results); // [ undefined, undefined ]  (one for 'audit-logger', one for the reaction)
```

### Starting the extension runtime from a lockfile

`startRuntime` reads `extensions.lock`, activates every declared extension (spawning `type:service` entries under a supervised child process), and writes a `runtime.json` record you can query later. `stopRuntime` tears everything down cleanly (SIGTERM, then SIGKILL after the extension's declared grace period):

```typescript
import { startRuntime, stopRuntime, getRuntimeRecord } from '@adhd/sox-host-runtime';

const record = await startRuntime({
  scope: 'project',
  lockfilePath: './extensions.lock',
  configPath: './sox.config.json',
  runtimeFilePath: './.adhd/sox-ecosystem/run/runtime.json',
  root: process.cwd(),
});

console.log(record.entries.map((e) => `${e.id} → pid ${e.pid}`));

// later, from the same process or a fresh read of the file on disk:
const current = getRuntimeRecord('./.adhd/sox-ecosystem/run/runtime.json');

await stopRuntime({ scope: 'project', runtimeFilePath: './.adhd/sox-ecosystem/run/runtime.json' });
```

## API reference

### Hook loader & event bus

```typescript
class HookLoader {
  register(manifest: HookManifest, handler: HookHandler): void;
  hooksFor(event: string): ReadonlyArray<RegisteredHook>;
  fire(event: string, ctx: Omit<HookContext, 'event'>): Promise<void>;
  // A throwing hook does NOT abort the chain — caught and recorded, execution continues.
  fireIsolated(event: string, ctx: Omit<HookContext, 'event'>): Promise<Array<{ id: string; error: unknown } | undefined>>;
  orderedIdsFor(event: string): string[];
  clear(): void;
}
function compareHooks(a: RegisteredHook, b: RegisteredHook): number;

const LIFECYCLE_EVENTS: readonly ['PreToolUse', 'PostToolUse', 'SessionEnd', 'ScopePromotionProposed', 'Stop'];
function isLifecycleEvent(s: string): s is LifecycleEvent;

class HostEventBus {
  constructor(hookLoader: HookLoader);
  on(event: LifecycleEvent, handler: LifecycleHandler, id?: string): string;
  off(event: LifecycleEvent, id: string): boolean;
  emit(event: LifecycleEvent, partial: Omit<HookContext, 'event'>): Promise<BusEmitResult>;
  reactionsFor(event: LifecycleEvent): string[];
  clearReactions(): void;
}
function createEventBus(hookLoader: HookLoader): HostEventBus;
```

### Runtime lifecycle (`extensions.lock` → running processes)

```typescript
function loadFromLockfile(opts?: LoaderOptions): Promise<LoaderResult>;
// LoaderResult: { activated: ActivatedHandle[]; skipped: {key, reason}[]; errors: {key, error}[]; hookLoader; commandRegistry }

function startRuntime(opts: StartRuntimeOptions): Promise<RuntimeRecord>;
function stopRuntime(opts: StopRuntimeOptions): Promise<void>;
function stopExtension(runtimeFilePath: string, id: string): Promise<boolean>;
function reconcileRuntime(runtimeFilePath: string, configPath: string): Promise<string[]>;
function getRuntimeRecord(runtimeFilePath: string): RuntimeRecord | null;
function reapOrphansForExtension(id: string, opts?: { lockfilePath?: string; runtimeFilePath?: string; graceMs?: number; log?: (msg: string) => void }): Promise<ReapExtensionResult>;
function runtimeFilePathFromLockfile(lockfilePath: string): string;
function getRuntimeFilePath(scopeLockfilePath: string): string;
function getScopePaths(scope: string, root: string): { config: string; lockfile: string };
function resolveExtensionDir(source: string, root: string): string | null;
```

> `getRegistrar(runtimeFilePath)` is **deprecated**: it reads an in-process `Map`, so it only returns non-null in the exact process that called `startRuntime` — a separate CLI invocation always gets `null`. Use `record.execSocketPath` (present only in supervisor/lockfile-based start mode) and talk to the running supervisor over its Unix-domain exec socket instead.

### Process supervision

```typescript
class ProcessSupervisor {
  constructor(opts: SupervisorOptions); // { key, entrypointPath, args?, env?, lifecycle, permissions?, crashLoop?, ... }
  policy(): Policy;
  start(): Promise<void>;
  stop(): Promise<void>;   // SIGTERM the whole process group, then SIGKILL after stop_timeout_ms
  kill(): Promise<void>;
  restart(): Promise<void>;
  isHealthy(): boolean;
  isCrashLooped(): boolean; // sticky — true once the crash-loop cap has fired; needs an explicit start()/restart()
  pid(): number | null;
}
function expandTilde(p: string): string;
```

Permission enforcement (`opts.permissions`) is **opt-in**: a `SupervisorOptions` with no `permissions` block spawns byte-identically to a plain `child_process.spawn` (env + cwd untouched). Declaring a block switches that domain to deny-by-default:

```typescript
import { compilePolicy, compilePolicyFromEnv } from '@adhd/sox-host-runtime';

const policy = compilePolicy({ fs: { read: ['/tmp/**'] }, network: { outbound: ['api.example.com'] } });
policy.allowsFsRead('/tmp/data.json'); // true
policy.allowsFsRead('/etc/passwd');    // false — fs domain was declared, so it's deny-by-default
policy.allowsNetwork('other.example.com'); // false

// A spawned child reconstructs the same decisions from policy.toEnv() via:
const restored = compilePolicyFromEnv(process.env);
```

### Crash-loop capping

```typescript
const CRASH_LOOP_MAX_FAILURES = 5;
const CRASH_LOOP_WINDOW_MS = 60000;

class CrashLoopGuard {
  constructor(opts: CrashLoopGuardOptions);
  failuresInWindow(): number;
  // ...records an unexpected exit; once 5 exits land inside a rolling 60s window
  // the guard trips and ProcessSupervisor stops auto-restarting (isCrashLooped() → true).
}
function crashLoopMarkerDir(): string;
function crashLoopMarkerPath(markerDir: string, key: string): string;
function readCrashLoopMarker(markerPath: string): CrashLoopMarker | null;
function listCrashLoopMarkers(markerDir: string): CrashLoopMarker[];
function clearCrashLoopMarker(markerPath: string): void;
```

### Shutdown grace-margin discipline

```typescript
const SOX_SHUTDOWN_SAFETY_MARGIN_MS = 1000;
function resolveShutdownSafetyNetMs(stopTimeoutMs: number, marginMs?: number): number;
function resolveStopTimeoutMsFromEnv(env?: NodeJS.ProcessEnv, fallbackMs?: number): number;
```

Derives a service's own internal shutdown safety-net timeout from its resolved `stop_timeout_ms` grace, with a guaranteed 1000ms of headroom before the reaper's SIGKILL — the canonical fix for two services that had each hand-picked a safety-net literal that happened to race the reaper's escalation instead of beating it.

### MCP server registration

```typescript
class McpRegistrar {
  register(serverKey: string, proc: ChildProcess, timeoutMs?: number): Promise<McpRegistration>;
  registrations(): McpRegistration[];
  tools(serverKey: string): McpToolDescriptor[];
  call(serverKey: string, toolName: string, args: Record<string, unknown>, timeoutMs?: number): Promise<McpCallResult>;
  deregister(serverKey: string): void;
  allToolNames(): Array<{ serverKey: string; toolName: string }>;
}
class McpClient {
  constructor(proc: ChildProcess);
  call(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  close(): void;
}
```

### Data paths (ADR-0004 — the one resolver)

Every soxe data path — the install ledger, supervisor registry, per-scope config/lockfile/ledger, run directory, sockets, logs — is computed here. It reads `SOX_ECOSYSTEM_HOME` (default `~/.adhd/sox-ecosystem/`) at *call* time, so a test can override it after import:

```typescript
import { dataRoot, scopeConfigPaths, runDir, socketDir } from '@adhd/sox-host-runtime';

dataRoot('project', '/path/to/repo'); // '/path/to/repo/.adhd/sox-ecosystem'
scopeConfigPaths('user');             // { config: '...', lockfile: '...' }
runDir();                             // '$userDataRoot/run'
socketDir();                          // '$userDataRoot/run/supervisors'
```

```typescript
type DataScope = 'org' | 'user' | 'project' | 'local';
const DATA_SUBDIR: string;
function userDataRoot(): string;
function dataRoot(scope: DataScope, root?: string): string;
function scopeConfigPaths(scope: DataScope, root?: string): { config: string; lockfile: string };
function ledgerPathFor(scope: DataScope, root?: string): string;
function ownershipPathFor(scope: DataScope, root?: string): string;
function storeRootFor(scope: DataScope, root?: string): string;
function installRegistryPath(): string;
function supervisorsPath(): string;
function logDirFor(supervisorId: string): string;
```

### Env scrubbing for spawned children

```typescript
function scrubEnv(env: Record<string, string | undefined>): ScrubbedEnv;
function scrubEnvReported(env: Record<string, string | undefined>): { env: Record<string, string>; dropped: string[] };
function isDeniedEnvKey(key: string): boolean;
function formatDeniedEnvWarning(dropped: string[]): string;
const ENV_BASE_ALLOW: readonly string[];
const ENV_ALLOW_PREFIXES: readonly string[];
const ENV_DENY_PREFIXES: readonly string[];
```

Forwarded to a spawned child: base process keys (`PATH`, `HOME`, locale), everything prefixed `NODE_*`, and everything prefixed `SOX_*` **except** `SOX_PERM_*` (the compiled sandbox policy) and `SOX_CONFIG_*` (the resolved config cascade) — those two namespaces are host-authoritative and are never inherited from an ambient shell.

### Verified kill + orphan reaping

```typescript
function pidAlive(pid: number): boolean;
function killAndVerify(pid: number, opts?: KillOptions): Promise<KillOutcome>; // 'already-dead' | 'term' | 'kill' | 'undead'
function identityToken(source: string): string;
function findOrphansByIdentity(token: string, opts?: { ... }): OrphanMatch[];
function findOrphansByServiceId(serviceId: string, token: string, opts?: { ... }): OrphanMatch[];
function reapByIdentity(token: string, opts?: KillOptions & { ... }): Promise<ReapResult>;
function reapBySource(source: string, opts?: KillOptions & { ... }): Promise<ReapResult>;
function snapshotProcesses(): PsProcess[];
function gatherProcessSnapshot(supervisorRegistryEntries: Array<{ ... }>): ProcessSnapshotRow[];
```

Matching is by a precise entrypoint identity token resolved from the lockfile/runtime record — never a bare `node` argv match — so `soxe stop`/reap can find and kill a daemon by *what it is*, even after the supervisor is gone and the process is detached (`PPID 1`).

### OS service units (launchd / systemd)

```typescript
function detectOsSupervisor(platform?: NodeJS.Platform): 'launchd' | 'systemd';
function getOsUnitPlatform(kind?: OsSupervisor): OsUnitPlatform;
function deriveOsUnitSpec(opts: { ... }): OsUnitSpec;
function enableOsUnit(spec: OsUnitSpec, platform: OsUnitPlatform, opts?: EnableOptions): EnableResult;
function disableOsUnit(label: string, platform: OsUnitPlatform, opts?: DisableOptions): DisableResult;
function restartOsUnit(newSpec: OsUnitSpec, platform: OsUnitPlatform, lastKnownGoodPath: string | undefined, opts?: RestartOptions): Promise<RestartResult>;
function restartAndVerify(opts: RestartAndVerifyOptions): Promise<RestartAndVerifyResult>;
function updateOsUnit(spec: OsUnitSpec, platform: OsUnitPlatform, opts: UpdateOsUnitOptions): Promise<UpdateOsUnitResult>;
function reloadAndVerifyOsUnit(spec: OsUnitSpec, platform: OsUnitPlatform, opts?: ReloadAndVerifyOsUnitOptions): ReloadAndVerifyOsUnitResult;
function verifyUnitOnDisk(unitPath: string): UnitDiskVerification;
function classifyOsUnitOrphan(fileName: string, disk: UnitDiskVerification): 'heal' | 'alarm' | 'unattributable';
```

`LaunchdPlatform` and `SystemdPlatform` implement the common `OsUnitPlatform` interface, so a caller drives either supervisor through the same `enable`/`disable`/`restart` calls above.

### Cross-scope singleton healing & log management

```typescript
function resolveStoreResource(manifestPath: string, configEnv: Record<string, string>): StoreResource;
function singletonKey(id: string, resource: StoreResource): string | null;
function healSingletonDuplicates(opts: { ... }): Promise<HealResult>;
function findCrossScopeSharers(targetScope: string, targetResource: StoreResource, others: ScopeResource[]): string[];

class LogManager {
  constructor(opts: LogManagerOptions);
  // pipes a supervised child's stdout/stderr to a rotating, date-stamped log file
}
function findAllLogStreamsForExt(extId: string, supervisorId: string, scope: string): LogStreamDescriptor[];
function rotateOsUnitLogs(opts: RotateOsUnitLogsOptions): void;
```

### Global supervisor registry, start lock, and stale-state GC

```typescript
// registry.ts — the durable record of every supervisor process this machine has started
function getSupervisorsFilePath(): string;
function readSupervisorsFile(filePath?: string): SupervisorsFile;
function writeSupervisorsFile(file: SupervisorsFile, filePath?: string): void;
function registerSupervisor(entry: SupervisorRegistryEntry): void;
function deregisterSupervisor(supervisorId: string): void;
function listRegisteredSupervisors(): SupervisorRegistryEntry[];

// lock.ts — prevents two `soxe start` invocations for the same scope from racing
function computeSupervisorId(scope: string, root: string): string;
// Throws if a live holder still holds the lock past opts.timeoutMs.
function acquireStartLock(supervisorId: string, opts?: { timeoutMs?: number }): { release: () => void };

// gc.ts — probes for and clears stale registry entries whose process is gone
function probeSocket(socketPath: string, timeoutMs: number): Promise<boolean>;
function probeEntryLiveness(entry: SupervisorRegistryEntry, opts?: { socketTimeoutMs?: number }): Promise<'alive' | 'dead'>;
// Reads the registry with lazy GC applied — dead entries are removed as a side-effect
// and excluded from the returned list.
function readGlobalRegistry(opts?: { socketTimeoutMs?: number }): Promise<SupervisorRegistryEntry[]>;
```

### Audit log (soft policy enforcement for in-process extensions)

`agent`/`skill`/`hook`/`command` extensions run in-process rather than as a spawned child, so there's no OS process boundary to enforce a `Policy` at — `makeInprocHandle` gives them the same `Policy`-shaped `allows*()` checks with every decision recorded to an in-memory audit trail instead:

```typescript
function auditAccess(extensionId: string, type: ExtensionType, domain: AccessDomain, target: string, decision: AuditDecision): void;
function getAuditLog(): readonly AuditEntry[];
function clearAuditLog(): void;
function makeInprocHandle(extensionId: string, type: ExtensionType, policy: Policy): InprocPolicyHandle;

type ExtensionType = 'agent' | 'skill' | 'hook' | 'command';
type AccessDomain = 'fs' | 'socket' | 'network';
type AuditDecision = 'allow' | 'deny';
```

### Adapters (per extension type)

```typescript
function activateMcp(opts: McpAdapterOptions): Promise<McpAdapterHandle>;
function activateHook(opts: HookAdapterOptions): Promise<HookAdapterHandle>;
function activateAgent(opts: AgentAdapterOptions): Promise<AgentAdapterHandle>;
function activateSkill(opts: SkillAdapterOptions): Promise<SkillAdapterHandle>;
function activateCommand(opts: CommandAdapterOptions): Promise<CommandAdapterHandle>;
class CommandRegistry { /* backs activateCommand */ }
```

These are what `loadFromLockfile` calls internally per lockfile entry `type` (`mcp-server`, `hook`, `agent`, `skill`, `command`) — import them directly only if you're driving a single extension type outside the full loader.

## Invariants / gotchas

- **`getRegistrar()` only works in-process.** It reads an in-memory map populated by `startRuntime()` in the *same* process. A second CLI invocation always sees `null` — use the exec socket (`record.execSocketPath`) instead.
- **The non-permissions-enforced spawn path is byte-identical to a plain `child_process.spawn`.** Declaring `permissions` on `SupervisorOptions` is what switches a domain to deny-by-default; omitting it is fully backward compatible.
- **Crash-loop is sticky.** Once `isCrashLooped()` is true (5 unexpected exits in a 60s window, by default), the supervisor will not auto-restart again until an explicit `start()`/`restart()`.
- **`SOX_ECOSYSTEM_HOME` never reroutes host discovery paths** — it only moves soxe's own bookkeeping (install ledger, supervisors, runtime records, logs). Host *discovery* paths are controlled exclusively by `SOX_SANDBOX_ROOT` (in `@adhd/sox-host-registry`), not by this package.
- **`SOX_PERM_*` and `SOX_CONFIG_*` are never forwarded to a spawned child from the ambient shell**, even though every other `SOX_*` variable is — those two namespaces are host-authoritative (compiled sandbox policy, resolved config cascade) and letting a caller inject them would be a privilege escalation.
