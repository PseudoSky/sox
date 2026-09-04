# @adhd/sox-install-engine

The pure, CLI-free engine behind `soxe install` / `update` / `uninstall`:
scope-cascade config resolution, content-addressed integrity checking, registry
index building, ledger-driven install/update/uninstall with reversible
ownership tracking, provider capability checks, and the Claude Code
project/trust MCP-sync fixes. No `@nx/devkit` import and no `process.exit` —
every function here is a pure or side-effect-scoped operation a host (a CLI, a
server, a test) drives directly.

```bash
pnpm add @adhd/sox-install-engine
```

## Quick start

`install()` resolves a scope's `extensions.json` against a registry index,
fetches/verifies the artifact for anything newly requested, and writes an
atomic, content-addressed lockfile. `verifyIntegrity()` is the read-only
counterpart: is what's on disk still what the lockfile says it is?

```typescript
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { install, loadLockfile, verifyIntegrity, type Scope } from '@adhd/sox-install-engine';

function sha256File(p: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// A workspace containing one built extension plus a registry index pointing at it.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-demo-'));
const extDir = path.join(root, 'extensions', 'skills', 'hello');
fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
const artifactPath = path.join(extDir, 'dist', 'index.js');
fs.writeFileSync(artifactPath, 'module.exports = { run: () => "hi" };\n');
fs.writeFileSync(
  path.join(extDir, 'extension.json'),
  JSON.stringify({
    id: 'hello', type: 'skill', title: 'Hello', description: 'demo skill',
    compatibility: { host: '>=1.0.0' }, license: 'MIT', entrypoint: 'dist/index.js',
  }, null, 2),
);

const checksum = sha256File(artifactPath);
fs.mkdirSync(path.join(root, 'registry'), { recursive: true });
fs.writeFileSync(
  path.join(root, 'registry', 'index.json'),
  JSON.stringify([{
    id: 'hello', type: 'skill', title: 'Hello', description: 'demo skill',
    source: `file://${extDir}`, checksum, compatibility: { host: '>=1.0.0' },
  }]),
);

// A scope config declaring what's wanted, and where the lockfile lives.
const configPath = path.join(root, 'extensions.json');
const lockfilePath = path.join(root, 'extensions.lock');
fs.writeFileSync(configPath, JSON.stringify({ install: [{ id: 'hello', enabled: true }] }));

const scope: Scope = 'project';
await install({ scope, mode: 'default', configPath, lockfilePath, root });

const lockfile = loadLockfile(lockfilePath);
console.log(lockfile?.resolved['hello']?.checksum === checksum); // true

const status = await verifyIntegrity(scope, 'hello', { lockfilePath });
console.log(status.status); // 'current'

// Mutate the built artifact without re-installing -> integrity now reports 'stale'.
fs.writeFileSync(artifactPath, 'module.exports = { run: () => "changed" };\n');
console.log((await verifyIntegrity(scope, 'hello', { lockfilePath })).status); // 'stale'
```

## API reference

### Scope cascade (pure config merge)

```typescript
// Exported as CascadeScopeConfig (the bare `ScopeConfig` name is install()'s own,
// structurally identical, scope-config type — see "Install / lockfile" below).
function cascade(scopes: CascadeScopeConfig[]): ResolvedConfigMap;
function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown>;

interface CascadeScopeConfig {
  extends?: string;
  strict_capabilities?: boolean;
  providers?: Record<string, { base_url?: string; api_key?: string }>;
  install?: Array<{ id: string; version?: string; enabled?: boolean; source?: string }>;
  config?: Record<string, Record<string, unknown>>;
  enabled?: Record<string, boolean>;
  private?: boolean;
}

interface ResolvedConfigEntry {
  version: string | undefined;
  enabled: boolean;
  config: Record<string, unknown>;
  configOnly?: boolean; // true when only config/enabled blocks named this id, with no install: directive anywhere
}

type ResolvedConfigMap = Record<string, ResolvedConfigEntry>;
```

`cascade` merges an ordered widest→narrowest list of scope configs (`[org, user,
project, local]`) into one flat resolved map. It is a pure function with three
fixed merge rules: primitives and **arrays are replaced entirely** by the
narrower scope (never concatenated), plain objects deep-merge key by key, and
`enabled: false` at a narrower scope always suppresses a wider `true`.

```typescript
import { cascade } from '@adhd/sox-install-engine';

const resolved = cascade([
  { install: [{ id: 'formatter', version: '1.0.0' }] },        // org
  { config: { formatter: { style: 'compact' } } },              // user
  { install: [{ id: 'formatter', enabled: false }] },           // project — suppresses org's install
]);
// resolved.formatter -> { version: '1.0.0', enabled: false, config: { style: 'compact' } }
```

### Install / lockfile

```typescript
type Scope = 'org' | 'user' | 'project' | 'local';
const SCOPES: Scope[];
type InstallMode = 'default' | 'frozen' | 'update';
const LOCKFILE_VERSION: 2;

function getScopePath(scope: Scope): { config: string; lockfile: string };
function loadConfig(configPath: string): ScopeConfig | null;
function loadLockfile(lockPath: string): Lockfile | null;
function normalizeLockfile(lock: Lockfile): Lockfile; // upgrades a legacy v1 (`id@version`-keyed) lockfile in memory
function resolveEnvRef(value: string): string;
function loadRegistryIndex(root: string): IndexEntry[];
function resolveFromRegistry(id: string, index: IndexEntry[]): IndexEntry | null;
function fetchArtifact(source: string, expectedChecksum?: string, opts?: { storeDir?: string }): Promise<{ bytes: Buffer; checksum: string; source: string }>;
function writeLockfileAtomic(lockPath: string, lockfile: Lockfile): void; // temp-file + rename; rejects a zero-entry lockfile
function findLocalExtension(root: string, id: string): string | null;
function loadExtensionManifest(root: string, id: string): ExtensionManifest | null;
function install(opts: InstallOptions): Promise<ResolvedSet>;

interface InstallOptions {
  scope: Scope;
  mode: InstallMode;
  configPath?: string;
  lockfilePath?: string;
  root?: string;
  overrideProvider?: string;
  registryIndex?: IndexEntry[]; // inject an already-resolved index (e.g. a bundled CLI with no repo checkout under root)
  onMissingConfig?: (extId: string, key: string, prompt: string, defaultVal: unknown) => Promise<string | undefined>;
}

interface Lockfile {
  lockfileVersion: 1 | 2;
  extends?: LockfileExtendsPin;
  resolved: Record<string, LockfileEntry>; // keyed by bare id (v2) — see normalizeLockfile for v1 back-compat
}

interface LockfileEntry {
  source: string;
  checksum: string;
  resolved_at: string;
  bundle_id?: string;
}

type ResolvedSet = Record<string, ResolvedEntry>;
interface ResolvedEntry {
  version: string;
  enabled: boolean;
  config: Record<string, unknown>;
  source: string;
  checksum: string;
}
```

Identity is content-addressed (`id` + `checksum` of the built artifact) — there
is no version-range resolution; `resolveFromRegistry` is a plain `id` lookup
over the one registry build. `mode: 'frozen'` verifies every resolved entry's
checksum against the existing lockfile and fails on drift instead of
re-resolving.

### Declarative install (descriptor-driven placement)

```typescript
function declarativeInstall(
  descriptor: InstallDescriptor,
  scope: 'project' | 'user' | 'local' | 'org',
  workspaceRoot: string,
  scopeRoot: string,
  opts?: { isProject?: boolean; ledger?: Ledger; dryRun?: boolean; force?: boolean },
): Promise<DeclarativeInstallResult[]>;
// `Ledger` (here and in LifecycleCtx/diff below) is an internal test-injection
// type, not part of this package's public export surface — omit `ledger` in
// normal use and the engine resolves its own from `scopeRoot`.

class DeclarativeDeniedError extends Error {
  readonly reason: string;
  readonly ext: string;
  readonly host: string;
  readonly scope: string;
}

interface InstallDescriptor {
  ext: string;
  type: string;
  hosts: string[];
  bundleId?: string;
  srcPath?: string;               // file-drop source
  configKeyPath?: string;          // config-merge target key path
  configValue?: unknown;
  configValues?: string[];         // array-merge values
  configEntries?: Record<string, unknown>[]; // object-array-merge entries
  configIdentityField?: string;
  configIdentityValue?: string;
  transport?: 'stdio' | 'sse' | 'http';
  profile?: string;
  resolvedConfig?: Record<string, unknown>;
}

interface DeclarativeInstallResult {
  host: string;
  scope: string;
  capability: string;
  target: string;
  applied: boolean;
  denied?: boolean;
  denialReason?: string;
  hints?: string[];
  dryRun?: boolean; // true = plan only, nothing written
}
```

`declarativeInstall` resolves the host-specific discovery path from the
manifest's `install` block, runs a policy check (a `stdio` mcp-server can never
be declared directly in `.mcp.json` — it is denied with
`DeclarativeDeniedError`), applies the capability, and records the result in
the scope's ledger so it can be reversed later.

### Integrity (the "is this current?" primitive)

```typescript
type IntegrityStatus = 'current' | 'stale' | 'not-installed' | 'unresolvable';

interface IntegrityResult {
  id: string;
  status: IntegrityStatus;
  current: boolean;       // status === 'current'
  expected: string | null; // checksum recorded in the lockfile
  actual: string | null;   // freshly-computed sha256 of the artifact on disk
  source: string | null;
  error?: string;
}

function verifyIntegrity(scope: Scope, id: string, opts?: { lockfilePath?: string }): Promise<IntegrityResult>;
```

Pure read-only check: hash the artifact at the lockfile's recorded `source` and
compare it to the recorded `checksum`. No version comparison anywhere — this is
the single primitive `install(mode: 'frozen')`, `update`, and an `upgrade --all`
CLI all call rather than re-implementing the comparison themselves.

### Registry index building

```typescript
// buildIndex's own entry type is exported as BuildIndexEntry (the bare `IndexEntry`
// name belongs to install()'s registry-index type — see "Install / lockfile" above;
// the two shapes are structurally close but declared separately).
function buildIndex(opts: { root: string }): BuildIndexEntry[];
function checksumUrl(url: string): Promise<string>;

interface BuildIndexEntry {
  id: string;
  type: string;
  version?: string; // display-only, never an identity input
  title: string;
  description: string;
  source: string;
  checksum: string;
  compatibility: { host: string };
  requires?: { tool_calling?: boolean; structured_output?: boolean; min_context_tokens?: number };
  members?: Array<{ id: string }>;
}
```

Walks a workspace's extension manifests and produces the registry index
`resolveFromRegistry`/`loadRegistryIndex` consume — the `checksum` for each
entry is the sha256 of its built entrypoint, computed at index-build time.

### Provider capability checks

```typescript
function checkProviderCapabilities(model: string, requires: RequiresBlock): CapabilityResult;
function loadCapabilityTable(): Record<string, ModelCapabilityEntry>;

interface RequiresBlock {
  tool_calling?: boolean;
  structured_output?: boolean;
  min_context_tokens?: number;
}

interface CapabilityResult {
  ok: boolean;
  warnings: string[];
}

interface ModelCapabilityEntry {
  supports_function_calling?: boolean;
  supports_tool_choice?: boolean;
  supports_response_schema?: boolean;
  max_input_tokens?: number;
  max_tokens?: number;
  tool_calling?: boolean;
  function_calling?: boolean;
  structured_output?: boolean;
}
```

A pure lookup against a vendored model-capability table: given a model name and
an extension's `requires` block, reports whether the model can actually run
it — e.g. installing a tool-calling agent against a model with no function
calling support produces a warning here rather than a confusing runtime
failure.

```typescript
import { checkProviderCapabilities } from '@adhd/sox-install-engine';

const result = checkProviderCapabilities('gpt-4o-mini', { tool_calling: true, min_context_tokens: 128000 });
if (!result.ok) console.warn(result.warnings.join('\n'));
```

### Update / uninstall lifecycle

```typescript
function uninstall(ctx: LifecycleCtx): Promise<void>;
function update(ctx: UpdateCtx): Promise<UpdateResult>;

class ReverseAbortError extends Error {
  readonly capability: string;
  readonly file: string;
  readonly reason: string;
}

// Exported as LifecycleHostScope (the bare `HostScope` name is not exported here).
type LifecycleHostScope = 'project' | 'user' | 'local' | 'org';

interface LifecycleCtx {
  ext: string;
  host: string;
  scope: LifecycleHostScope;
  scopeRoot: string;
  isProject?: boolean;
  ledger?: Ledger;
}

interface UpdateCtx extends LifecycleCtx {
  workspaceRoot: string;
  newSrcPath?: string;
  newPayload?: { keyPath: string; value: unknown };
}

interface UpdateResult {
  kind: 'none' | 'updated' | 'added';
  actions: string[];
}
```

`uninstall` reverses every ledger-recorded action for `(ext, host, scope)` —
deleting file-drops, removing config-merge keys, removing array-merge
values — touching only sox-owned entries and leaving foreign content byte-clean.
A capability that cannot cleanly reverse throws `ReverseAbortError` rather than
leaving a partial, silently-broken uninstall.

### Ownership index

```typescript
class OwnershipIndex {
  static loadFromFile(filePath: string, opts?: { strict?: boolean }): OwnershipIndex;
  static load(scope: DataScope, root?: string, opts?: { strict?: boolean }): OwnershipIndex;
  get path(): string;
  get(extId: string, scope: string): OwnershipRecord | undefined;
  all(): OwnershipRecord[];
  record(opts: { extId: string; scope: string; host?: string; bundleId?: string; artifactChecksum?: string; entries: OwnedEntry[] }): void;
  static dedupeEntries(entries: OwnedEntry[]): OwnedEntry[];
  compact(): void;
  addEntries(extId: string, scope: string, entries: OwnedEntry[], meta?: { host?: string; bundleId?: string; artifactChecksum?: string }): void;
  remove(extId: string, scope: string): void;
  save(): void;
  static upsertOsUnitEntry(filePath: string, opts: { extId: string; scope: string; label: string; unitPath: string; supervisor: 'launchd' | 'systemd'; appliedHash: string }): void;
  static removeOsUnitEntry(filePath: string, opts: { extId: string; scope: string; label: string }): boolean;
}

function readOwnership(filePath: string, opts?: { strict?: boolean }): OwnershipFile;
function writeOwnershipAtomic(filePath: string, data: OwnershipFile): void;
function supersededEntries(oldEntries: OwnedEntry[], newEntries: OwnedEntry[]): OwnedEntry[];

class OwnershipCorruptError extends Error { readonly filePath: string; }
class OwnershipConflictError extends Error { readonly filePath: string; }

interface OwnershipRecord {
  extId: string;
  scope: string;
  host?: string;
  bundleId?: string;
  artifactChecksum?: string;
  installedAt: string;
  updatedAt: string;
  entries: OwnedEntry[];
}

interface OwnershipFile {
  version: 1;
  owned: OwnershipRecord[];
}

// OwnedEntry: a discriminated union on `kind` — one variant per reversible action:
type OwnedEntry =
  | { kind: 'file-drop'; path: string }
  | { kind: 'materialize'; path: string }
  | { kind: 'config-key'; file: string; keyPath: string; appliedHash?: string }
  | { kind: 'array-values'; file: string; keyPath: string; values: string[] }
  | { kind: 'object-array-values'; file: string; keyPath: string; entries: Array<Record<string, unknown>>; identityField: string; identityValue: string }
  | { kind: 'lockfile-key'; file: string; keyPath: string }
  | { kind: 'registry-record'; extId: string; scope: string; root: string }
  | { kind: 'os-unit'; label: string; unitPath: string; supervisor: 'launchd' | 'systemd'; appliedHash: string };
```

The complete, machine-local record of every filesystem location and config key
an install owns, keyed by `(extId, scope)`. `save()` is optimistic-concurrency
guarded: it re-stats the file before renaming and throws
`OwnershipConflictError` if another process wrote it out from under you,
rather than silently clobbering that write. A structurally invalid file under
`strict: true` throws `OwnershipCorruptError` instead of being read back as
empty.

### Claude Code project MCP sync

```typescript
function resolveUserMcpConfigPath(host: string): string | undefined;
function resolveProjectMcpConfigPath(host: string, projectRoot: string): string | undefined;
function readGlobalServerEntry(host: string, extId: string): unknown;
function knownProjectRoots(): string[];

function registerUserMcpServer(opts: {
  extId: string;
  serverEntry: unknown;
  host?: string;
  scopeRoot?: string;
  workspaceRoot?: string;
}): Promise<'registered' | 'no-surface'>;

function syncUserMcpToProjects(opts: SyncMcpOptions): Promise<ProjectSyncResult[]>;
function reverseUserMcpFromProjects(opts: { extId: string; host?: string }): Promise<string[]>;

interface SyncMcpOptions {
  extId: string;
  host?: string;          // default "claude"
  serverEntry?: unknown;  // defaults to the current global registration if omitted
  dryRun?: boolean;
  onlyRoot?: string;
}

interface ProjectSyncResult {
  projectRoot: string;
  mcpJsonPath: string;
  action: 'merged' | 'up-to-date' | 'would-merge' | 'skipped';
  reason?: string;
}
```

Fixes a real Claude Code gap: a project's `.mcp.json` *overrides* rather than
inherits user-scope MCP servers, so a globally-registered server is invisible
in any project with its own `.mcp.json`. `syncUserMcpToProjects` propagates a
user-scope server's entry into every project sox knows about (from the install
registry — never a filesystem scan), fully tracked in the ownership index so
`reverseUserMcpFromProjects` can remove exactly what was added, leaving every
other server byte-clean.

### Claude Code trust sync

```typescript
function syncMcpTrustToProjects(opts: SyncTrustOptions): Promise<TrustSyncResult[]>;
function reverseMcpTrustFromProjects(opts: { extId: string; host?: string }): Promise<string[]>;

interface SyncTrustOptions {
  extId: string;
  host?: string;   // default "claude"; no-op for any other host
  dryRun?: boolean;
  roots?: string[]; // defaults to every known project root
}

interface TrustSyncResult {
  projectRoot: string;
  claudeJsonPath: string;
  action: 'trusted' | 'up-to-date' | 'would-trust' | 'skipped';
  reason?: string;
}
```

Claude Code gates every `.mcp.json` remote MCP server behind a per-project
trust list (`~/.claude.json` → `projects["<root>"].enabledMcpjsonServers`),
normally approved through an interactive prompt. A headless install has no one
to answer that prompt, so a correctly-installed server silently serves zero
tools. `syncMcpTrustToProjects` appends exactly the one extension id just
installed to that list for the relevant project roots — never a blanket
trust-everything flag — and `reverseMcpTrustFromProjects` removes only what it
added.

### Data-root path resolver

```typescript
type DataScope = 'org' | 'user' | 'project' | 'local';

function userDataRoot(): string;                                    // $SOX_ECOSYSTEM_HOME or ~/.adhd/sox-ecosystem/
function dataRoot(scope: DataScope, root?: string): string;
function scopeConfigPaths(scope: DataScope, root?: string): { config: string; lockfile: string };
function ledgerPathFor(scope: DataScope, root?: string): string;
function ownershipPathFor(scope: DataScope, root?: string): string;
function storeRootFor(scope: DataScope, root?: string): string;     // <dataRoot>/ext/
function installRegistryPath(): string;                              // $userDataRoot/install-registry.json
```

### Drift diff (ledger vs. disk)

```typescript
type DiffKind = 'up-to-date' | 'drifted' | 'missing' | 'will-change';

function diff(ext: string, host: string, scope: string, scopeRoot: string, opts?: { ledger?: Ledger; isProject?: boolean }): ExtensionDiff;
function diffAll(scopeRoot: string, opts?: { ledger?: Ledger; isProject?: boolean }): ExtensionDiff[];

interface ActionDiff {
  // one of the seven ledger capability identifiers (LedgerAction is internal, not exported)
  cap: 'config-merge' | 'array-merge' | 'object-array-merge' | 'materialize' | 'file-drop' | 'bin-link' | 'run-service';
  file: string;
  keyPath: string;
  kind: DiffKind;
  currentHash?: string;
  appliedHash?: string;
}

interface ExtensionDiff {
  ext: string;
  host: string;
  scope: string;
  actions: ActionDiff[];
  clean: boolean; // true iff every action is up-to-date
}
```

Compares what the ledger says was placed against what is actually on disk for
each action. An externally-edited file that the ledger placed reports
`'drifted'` rather than silently being treated as fine — verification tops out
at "present and matching the recorded hash"; it never asserts the host
actually *ran* the content.

### Global install registry

```typescript
function resolveInstallRegistryPath(): string;
function readInstallRegistry(registryPath: string): InstallRegistry;
function writeInstallRegistryAtomic(registryPath: string, registry: InstallRegistry): void;
function upsertInstallRecord(opts: UpsertInstallRecordOpts): void;
function removeInstallRecord(extId: string, scope: string, root: string): void;

interface InstallRecord {
  extId: string;
  version: string;
  scope: 'user' | 'project' | 'local';
  root: string;
  installedAt: string;
  updatedAt: string;
  source: string;
}

interface InstallRegistry {
  version: 1;
  installs: InstallRecord[];
}

interface UpsertInstallRecordOpts {
  extId: string;
  version: string;
  scope: string;
  root: string;
  source: string;
}
```

The single machine-wide record of every `soxe install` across every project —
natural key `(extId, scope, root)`. This is what `knownProjectRoots()` (above)
reads to find every project sox should propagate a user-scope MCP server into,
without ever scanning the filesystem. All writes here are best-effort; callers
wrap them in `try/catch` so a registry write failure never fails the install
itself.

### CLI argument parsing

```typescript
function parseArgs(argv: string[]): Record<string, string>;
```

Handles both `--flag value` and `--flag=value` forms for every flag, plus bare
boolean flags (`--flag` → `'true'`), the `-s value` short alias for `--scope`,
and positional arguments (stored as `_`, `_2`, `_3`, ...).

```typescript
import { parseArgs } from '@adhd/sox-install-engine';

parseArgs(['hello', '--scope=project', '--dry-run']);
// { _: 'hello', scope: 'project', 'dry-run': 'true' }
parseArgs(['-s', 'user']);
// { scope: 'user' }
```

## Invariants / gotchas

- **Identity is content-addressed, not version-addressed.** `id` + the sha256
  checksum of the built artifact is the only identity; there is no
  version-range resolution anywhere in `install`/`verifyIntegrity`.
- **Arrays replace entirely on cascade — never concatenate.** A narrower
  scope's `install:`/array config value completely replaces a wider scope's,
  by design (per the cascade contract).
- **`ownership.json` saves are conflict-detected, not last-write-wins.**
  `OwnershipIndex.save()` throws `OwnershipConflictError` rather than
  silently overwriting a concurrent writer's update.
- **Reversal that can't be done cleanly aborts.** `uninstall`/`update` throw
  `ReverseAbortError` instead of leaving a partially-reversed, inconsistent
  install on disk.
- **MCP trust-sync is scoped to one named extension, never a blanket flag.**
  `syncMcpTrustToProjects` only ever appends the specific `extId` just
  installed — it is not an `enableAllProjectMcpServers`-style bypass.
- **No filesystem scanning for "known projects."** `knownProjectRoots()` and
  every default-target resolution in the MCP sync functions read the install
  registry — they never crawl disk for `.mcp.json` files.
