# @adhd/sox-manifest

The single source of truth for the `extension.json` manifest shape used across
the sox ecosystem: a `Manifest` TypeScript interface, a runtime `validate()`
function, a type predicate (`isManifest`), and the raw JSON Schema those two
are generated from. Every extension type — agent, skill, mcp-server, prompt,
hook, command, bundle, service — is described by the same `Manifest` shape;
`validate()` is what every installer, registry builder, and CLI in this
ecosystem calls to check one before trusting it.

```bash
pnpm add @adhd/sox-manifest
```

## Quick start

```typescript
import { validate, isManifest, type Manifest } from '@adhd/sox-manifest';

const manifest: Manifest = {
  id: 'note-taker',
  type: 'skill',
  title: 'Note Taker',
  description: 'Does one thing well',
  compatibility: { host: '>=1.0.0 <2.0.0' },
  license: 'MIT',
  entrypoint: 'dist/index.js',
};

const result = validate(manifest);
console.log(result.ok);       // true
console.log(result.errors);   // []
console.log(result.warnings); // []

console.log(isManifest(manifest)); // true — isManifest is validate() as a type predicate

const bad = { id: 'Bad_ID', type: 'skill', title: '', description: 'x' };
console.log(validate(bad).errors);
// [
//   'missing required field: "compatibility"',
//   'missing required field: "license"',
//   'id "Bad_ID" must match ^[a-z][a-z0-9-]*$',
//   'title must be a non-empty string',
// ]
```

## API reference

### `validate()` — the runtime conformance check

```typescript
function validate(raw: Record<string, unknown>): ValidateResult;

interface ValidateResult {
  ok: boolean;
  errors: string[];
  /** Non-fatal advisory notices. `ok` may still be `true` when warnings are present. */
  warnings: string[];
}
```

Checks a plain object (not a file path — read and `JSON.parse` the file
yourself first) against every structural and semantic rule in the manifest
contract: required fields, the `id` slug pattern (`^[a-z][a-z0-9-]*$`), `type`
against the known extension types, `runtime` against the known runtimes,
`install.hosts` against known hosts, the `profiles ⊆ serves ∪ transports`
invariant, and the managed/forbidden-key guards described below. Returns every
violation found — not just the first — in `errors`.

### `isManifest()` — type predicate

```typescript
function isManifest(value: unknown): value is Manifest;
```

A thin wrapper over `validate()` that narrows `value` to `Manifest` when it
returns `true`. Use `validate()` directly when you need to report *why*
something failed.

### The `Manifest` interface

```typescript
interface Manifest {
  $schema?: string;
  id: string;
  /** Deprecated display label — never an identity input; identity is id + checksum. */
  version?: string;
  type: 'agent' | 'skill' | 'mcp-server' | 'prompt' | 'hook' | 'command' | 'bundle' | 'service';
  title: string;
  description: string;
  compatibility: Record<string, string>;
  license: string;
  /** Optional — absent for bundle, prompt, declarative types. */
  entrypoint?: string;
  /** Defaults to 'node' when absent. */
  runtime?: ManifestRuntime;
  /** Host-placement path for declarative extensions. */
  'install-target'?: string;
  author?: string | { name: string; email?: string; url?: string };
  homepage?: string;
  repository?: string;
  keywords?: string[];
  tags?: string[];
  license_url?: string;
  private?: boolean;
  checksum?: string;
  order?: number;
  requires?: ManifestRequires;
  dependencies?: Array<ManifestDependency | string>;
  capabilities?: string[];
  members?: ManifestMember[];
  lifecycle?: ManifestLifecycle;
  events?: string[];
  invocation?: ManifestInvocation;
  tools?: ManifestTool[];
  parameters?: ManifestParameter[];
  template_engine?: 'handlebars' | 'jinja2' | 'mustache' | 'simple' | 'none';
  run_interface?: ManifestRunInterface;
  config_schema?: Record<string, unknown>;
  permissions?: ManifestPermissions;
  /** Hybrid install descriptor — replaces the older single-string install-target. */
  install?: ManifestInstall;
  /** Runtime/environment config carried on the built extension. */
  config?: Record<string, unknown>;
  /** Top-level provenance path (alias; prefer install.source). */
  source?: string;
  [key: string]: unknown;
}

type ManifestRuntime = 'node' | 'shell' | 'python' | 'declarative' | 'stdio-any';
```

### Supporting block types

```typescript
interface ManifestRequires {
  tool_calling?: boolean;
  structured_output?: boolean;
  min_context_tokens?: number;
}

interface ManifestDependency {
  id: string;
  version: string;
}

interface ManifestMember {
  id: string; // bundle members are referenced by id only — identity is id + checksum
}

interface ManifestLifecycle {
  background?: boolean;
  singleton?: boolean;
  stop_timeout_ms?: number;
  health?: ManifestLifecycleHealth;
}

interface ManifestLifecycleHealth {
  type?: 'stdio-ping' | 'http-get' | 'socket' | 'command';
  endpoint?: string;
  interval_ms?: number;
  timeout_ms?: number;
}

interface ManifestInvocation {
  protocol?: 'function-export' | 'stdio' | 'ipc' | 'http';
  handler?: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
}

interface ManifestTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

interface ManifestParameter {
  name: string;
  type?: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required?: boolean;
  description?: string;
}

interface ManifestRunInterface {
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
}

interface ManifestPermissions {
  fs?: ManifestFsPermissions;
  network?: ManifestNetworkPermissions;
  socket?: ManifestSocketPermissions;
}
interface ManifestFsPermissions { read?: string[]; write?: string[]; }
interface ManifestNetworkPermissions { outbound?: string[]; }
interface ManifestSocketPermissions { paths?: string[]; }

interface ManifestInstall {
  type?: 'agent' | 'skill' | 'mcp-server' | 'prompt' | 'hook' | 'command' | 'bundle' | 'service';
  hosts?: Array<'claude' | 'codex' | 'opencode'>;
  /** Presets keyed by transport name — each key must also appear in `serves`/`transports`. */
  profiles?: Record<string, unknown>;
  /** Transports the mcp extension implements. `profiles ⊆ serves ∪ transports` is enforced by validate(). */
  serves?: Array<'stdio' | 'sse' | 'http'>;
  /** Transports declared by a service extension (superset of `serves`). */
  transports?: Array<'stdio' | 'http' | 'sse' | 'socket'>;
  /** Origin path when --content @path / --from @dir was used at init. */
  source?: string;
  /** Per-host key overrides — validate() expects host keys at the top level,
   * e.g. `{ claude: {...}, codex: {...} }`; managed (claude) and
   * project-forbidden (codex) keys nested under those are refused. */
  overrides?: Record<string, unknown>;
}
```

### Constants

```typescript
const VALID_TYPES: Set<string>;       // agent, skill, mcp-server, prompt, hook, command, bundle, service
const VALID_RUNTIMES: Set<string>;    // node, shell, python, declarative, stdio-any
const VALID_HOOK_EVENTS: Set<string>; // PreToolUse, PostToolUse, SessionEnd, ScopePromotionProposed, Stop
const KNOWN_HOSTS: Set<string>;       // claude, codex, opencode
```

```typescript
import { VALID_TYPES } from '@adhd/sox-manifest';

if (!VALID_TYPES.has(manifest.type)) throw new Error(`unknown extension type: ${manifest.type}`);
```

### `ManifestSchema` — the raw JSON Schema

```typescript
const ManifestSchema: Record<string, unknown>;
```

The same contract as `Manifest`/`validate()`, expressed as a draft-07-flavored
JSON Schema — inlined directly into the built module (not a sibling
`schema.json` asset) so it is available under both `require()` and dynamic
`import()` with nothing extra to load. Use it wherever you need the schema as
data rather than as a TypeScript type — e.g. handing it to a generic
JSON-Schema validator, or embedding it in a published registry index.

```typescript
import { ManifestSchema } from '@adhd/sox-manifest';

console.log(ManifestSchema['required']); // ['id', 'type', 'title', 'description', 'compatibility', 'license']
```

## Invariants / gotchas

- **`entrypoint` is optional, not required.** A `bundle`, `prompt`, or
  `declarative`-runtime extension legitimately has none; `validate()` never
  flags its absence.
- **`version` is deprecated and never validated as identity.** Identity is
  `id` + content `checksum`. If `version` is present it must still
  be a syntactically valid semver string, but a manifest with no `version` at
  all is fully valid.
- **`id` must match `^[a-z][a-z0-9-]*$`.** Uppercase, underscores, and a
  leading digit are all rejected.
- **`id` must not end with (or equal) its own `type` name.** A `type: 'skill'`
  manifest with `id: 'note-skill'` (or `id: 'skill'`) fails validation — every
  type except `bundle` enforces this. Pick a name that describes what the
  extension does, not what kind of extension it is.
- **`profiles ⊆ serves ∪ transports`.** Every *key* of `install.profiles` must
  itself be one of the values declared in `install.serves` or
  `install.transports` (e.g. `install: { serves: ['stdio'], profiles: { stdio: {...} } }`)
  — `validate()` rejects a profile key that names an undeclared transport.
- **`type: 'service'` requires at least one transport — but only when an
  `install` block is present.** `install: { transports: [...] }` (or
  `serves`) must be non-empty for a service; a manifest that omits `install`
  entirely is not checked against this rule.
- **Managed/forbidden override keys are rejected, not silently dropped —
  when nested under the right host key.** `install.overrides.claude` can
  never contain `managed`, and `install.overrides.codex` can never contain
  `model_providers`, `notify`, `profile`, or `otel` — `validate()` reports
  these as errors so a manifest author finds out at authoring time, not at
  install time. The check only inspects `overrides.claude`/`overrides.codex`;
  a flat `overrides.managed` (not nested under `claude`) is not caught.
- **`compatibility` accepts any string-keyed shape.** It is intentionally
  unconstrained beyond "an object of strings" so both host-keyed and
  soxe-keyed compatibility blocks validate.
- **`Manifest` has an index signature (`[key: string]: unknown`).** Extra,
  forward-compatible fields on a manifest object are never a TypeScript error;
  `validate()` only checks the fields it knows about.
