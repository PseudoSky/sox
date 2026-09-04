# @adhd/sox-host-registry

The pluggable per-host registry for the `soxe` ecosystem: three self-contained host modules (**Claude Code**, **Codex**, **OpenCode**), each declaring how to detect that host in a workspace, where its per-scope config/agent/skill files live on disk, and how to render a host-agnostic agent definition into that host's native format. This is the *only* package in the ecosystem allowed to contain literal host-discovery paths (`.claude/`, `.codex/`, `.opencode/`, `~/.claude/`, `~/.codex/`, `~/.config/opencode/`) — everything else resolves a target through it instead of hard-coding a path.

```bash
pnpm add @adhd/sox-host-registry
```

## Quick start

```typescript
import { detectHosts, getHost, listHosts } from '@adhd/sox-host-registry';

listHosts(); // ['claude', 'codex', 'opencode']

// Which host(s) are set up in this workspace?
const detected = detectHosts(process.cwd()); // e.g. ['claude']

const claude = getHost('claude');
claude.scopePaths('project'); // { project: '.claude' } — relative to the workspace root
claude.scopePaths('user');    // { user: '/Users/you/.claude' } — home-expanded, absolute
claude.surfaces.agent;        // { capability: 'file-drop', paths: { project: '.claude/agents', user: '/Users/you/.claude/agents' } }
claude.surfaces['mcp-server'].capability; // 'config-merge'
```

### Rendering one agent definition for every host

`agentRenderers` is the "author once, install everywhere" half of the package: write a single host-agnostic `AgentIr`, and get back the exact frontmatter/config value each host expects — Claude tool names get capitalized and MCP servers become `mcp__<server>__*` wildcards, OpenCode gets YAML frontmatter with `mode`/`permission`, Codex gets a TOML `[agents.<name>]` value.

```typescript
import { agentRenderers } from '@adhd/sox-host-registry';
import type { AgentIr } from '@adhd/sox-host-registry';

const researcher: AgentIr = {
  name: 'researcher',
  description: 'Discovery researcher for third-party tools, patterns, and use cases before you build.',
  model: 'sonnet',
  temperature: 0.4,
  mode: 'all',
  tools: [
    'read',
    'bash',
    { logical: 'search', server: 'search' },
  ],
  permission: {
    read: 'allow',
    bash: { '*': 'allow', 'rm -rf *': 'deny' },
  },
};

const prose = '# researcher\n\nYou are a research agent.\n';

const forClaude = agentRenderers.claude.render(researcher, prose);
// { kind: 'file-body', content: '---\nname: researcher\n...tools: Read, Bash, mcp__search__*\n---\n# researcher\n...' }

const forCodex = agentRenderers.codex.render(researcher, prose);
// { kind: 'config-value', value: { description: '...', model: 'sonnet', prompt: '# researcher\n...' } }
// The install engine's config-merge capability serializes this object to TOML
// at keyPath `agents.researcher` — codex has no file-drop surface for agents.
```

## API reference

### Registry lookup

```typescript
function getHost(name: string): HostModule;       // throws on an unknown host name
function listHosts(): string[];                    // ['claude', 'codex', 'opencode']
function detectHosts(workspaceRoot: string): string[]; // hosts whose detect() is true here
function resolveWorkspaceRoot(workspaceRoot?: string): string; // workspaceRoot ?? process.cwd()

const claudeHost: HostModule;
const codexHost: HostModule;
const opencodeHost: HostModule;
```

### `HostModule` — the shape every host implements

```typescript
type HostScope = 'project' | 'user' | 'local' | 'org';

interface HostModule {
  readonly host: string;
  detect(workspaceRoot: string): boolean;
  scopePaths(scope: HostScope): Partial<Record<HostScope, string>>;
  readonly surfaces: SurfaceMap; // extension type -> Surface
  readonly render?: HostRenderer; // present on claude/opencode/codex
}

type CapabilityId =
  | 'file-drop'       // write a file/dir at a discovery path
  | 'config-merge'    // merge a key into a shared JSON or TOML config file
  | 'array-merge'     // append to arrays (permissions/env) with deny-wins semantics
  | 'object-array-merge'
  | 'bin-link'        // executable on PATH
  | 'run-service'     // soxe spawns + supervises
  | 'materialize';    // place built code at a stable store path

interface Surface {
  capability: CapabilityId;
  format?: 'json' | 'toml';
  mcpConfig?: McpConfig;
  postInstallHint?: string;
  paths: Partial<Record<HostScope, string>>;
}
type SurfaceMap = Record<string, Surface>;
```

### Agent rendering

```typescript
interface AgentIr {
  name?: string;
  description?: string;
  model?: string;
  temperature?: number;
  mode?: string;
  tools?: AgentToolRef[]; // string, or { logical: string; server: string }
  permission?: Record<string, string | Record<string, string>>;
}
interface AgentOverride {
  name?: string; description?: string; model?: string; temperature?: number; mode?: string;
  tools?: string[];
  permission?: Record<string, string | Record<string, string>>;
  version?: string;
  toolMap?: Record<string, string>; // logical server name -> concrete registration key
  fallbackPath?: string;
}
type RenderedArtifact =
  | { kind: 'file-body'; content: string }
  | { kind: 'config-value'; value: unknown };

interface HostRenderer {
  renderHeader(ir: AgentIr, overrides?: AgentOverride): Record<string, unknown>;
  renderToolNames(ir: AgentIr, overrides?: AgentOverride): string | null;
  render(ir: AgentIr, prose: string, overrides?: AgentOverride): RenderedArtifact;
}

const agentRenderers: { claude: HostRenderer; opencode: HostRenderer; codex: HostRenderer };
function stripFrontmatter(content: string): string;
function yamlScalar(value: unknown): string;
function yamlStringify(obj: Record<string, unknown>): string;
```

### Helpers

```typescript
function expandHome(p: string): string;              // leading ~ -> effective home dir
function existsIn(workspaceRoot: string, rel: string): boolean; // for detect() implementations
```

## Invariants / gotchas

- **This is the only package allowed to hard-code a host discovery path.** If you find `.claude/`, `.codex/`, or `.opencode/` written literally anywhere else in a consumer, that's a bug to route through `getHost(...).scopePaths(...)` instead.
- **Claude's `managed` (org/enterprise policy) tier is never emitted.** `scopePaths()` and `surfaces` for `claudeHost` never produce a path under that tier — soxe never writes it.
- **`expandHome` reroutes under `SOX_SANDBOX_ROOT` when that env var is set** (test/sandbox isolation only), read at call time, not at import time. This is a *different* switch from `SOX_ECOSYSTEM_HOME` in `@adhd/sox-host-runtime` — the data root never reroutes a host placement path, and the sandbox root never moves soxe's own bookkeeping.
- **Claude MCP entries require an explicit `type`** (`"http"` or `"sse"`; `"stdio"` for local) — a `url` entry with no recognized `type` is silently treated as broken and skipped by Claude Code itself.
- **User-scope Claude MCP config lives in `~/.claude.json`, not `settings.json`.**
