/**
 * libs/manifest — single source of truth for the extension manifest schema
 * and validate() function.
 *
 * Contract flexes encoded here (ADR-0001 §Contract adjustments):
 *   [flex:entrypoint-optional]  entrypoint is optional; typed by runtime
 *   [flex:runtime-expanded]     runtime ∈ {node, shell, python, declarative, stdio-any}
 *   [flex:install-target]       optional install-target field for declarative extensions
 *
 * Pure lib (inv:manifest-source, manifest-lib.6) — no devkit, no framework imports.
 * Outputs CJS (tsconfig.lib.json: module=CommonJS) so Node require() works.
 */

/**
 * [flex:runtime-expanded]
 * Full runtime enum including the three new values from ADR-0001.
 * 'node' and 'stdio-any' existed in v1; 'shell', 'python', 'declarative' are new.
 */
export type ManifestRuntime = 'node' | 'shell' | 'python' | 'declarative' | 'stdio-any';

/** Health probe sub-type for lifecycle block */
export interface ManifestLifecycleHealth {
  type?: 'stdio-ping' | 'http-get' | 'socket' | 'command';
  endpoint?: string;
  interval_ms?: number;
  timeout_ms?: number;
}

/** Host-supervised lifecycle block (mcp-server / agent only) */
export interface ManifestLifecycle {
  background?: boolean;
  singleton?: boolean;
  stop_timeout_ms?: number;
  health?: ManifestLifecycleHealth;
}

/** Bundle member entry. ADR-0003: referenced by `id` only — identity is id + checksum. */
export interface ManifestMember {
  id: string;
}

/** Runtime dependency entry */
export interface ManifestDependency {
  id: string;
  version: string;
}

/** Provider capability requirements */
export interface ManifestRequires {
  tool_calling?: boolean;
  structured_output?: boolean;
  min_context_tokens?: number;
}

/** Filesystem permission declarations */
export interface ManifestFsPermissions {
  read?: string[];
  write?: string[];
}

/** Network permission declarations */
export interface ManifestNetworkPermissions {
  outbound?: string[];
}

/** Socket permission declarations */
export interface ManifestSocketPermissions {
  paths?: string[];
}

/** Resource/permission declaration block */
export interface ManifestPermissions {
  fs?: ManifestFsPermissions;
  network?: ManifestNetworkPermissions;
  socket?: ManifestSocketPermissions;
}

/** Tool descriptor for mcp-server self-description */
export interface ManifestTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

/** Invocation declaration for agent/command self-description */
export interface ManifestInvocation {
  protocol?: 'function-export' | 'stdio' | 'ipc' | 'http';
  handler?: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
}

/** Parameter declaration for prompt self-description */
export interface ManifestParameter {
  name: string;
  type?: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required?: boolean;
  description?: string;
}

/** Run interface descriptor for skill self-description */
export interface ManifestRunInterface {
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
}


/**
 * [shape:install-descriptor] Hybrid install descriptor (ADR resolved #2).
 * Engine fills per-host target defaults from libs/host-registry at install time.
 */
export interface ManifestInstall {
  /** Host-agnostic extension type. [inv:host-agnostic-type] */
  type?: 'agent' | 'skill' | 'mcp-server' | 'prompt' | 'hook' | 'command' | 'bundle' | 'service';
  /** Chosen host targets. Engine resolves target paths from libs/host-registry. */
  hosts?: Array<'claude' | 'codex' | 'opencode' | 'agent-mcp'>;
  /**
   * [def:profile] Install-layer presets over (capability + transport + host-target + config).
   * Keys are profile names (e.g. 'standalone', 'shared'). profiles ⊆ {serves∪transports}
   * invariant is enforced by validate().
   */
  profiles?: Record<string, unknown>;
  /**
   * [def:serves] Transports the mcp extension implements ('stdio' | 'sse' | 'http').
   * profiles ⊆ {serves∪transports} is enforced by validate(). [inv:never-managed]
   */
  serves?: Array<'stdio' | 'sse' | 'http'>;
  /**
   * [def:transport] Transports declared by a service extension.
   * Back-compat alias with serves; profiles ⊆ {serves∪transports} invariant
   * is enforced by validate(). Required (≥1) for type:service.
   * Vocabulary: stdio | http | sse | socket.
   */
  transports?: Array<'stdio' | 'http' | 'sse' | 'socket'>;
  /** [def:source-provenance] Origin path when --content @path / --from @dir used at init. */
  source?: string;
  /**
   * Per-host surface/key overrides. Managed (claude) and project-forbidden (codex) keys
   * are refused by validate(). [inv:never-managed]
   */
  overrides?: Record<string, unknown>;
}

/**
 * Extension manifest interface — the single authoritative type for all extension.json files.
 *
 * Contract flexes:
 *   - [flex:entrypoint-optional]  entrypoint is optional (required for behavioral types via logic, not schema)
 *   - [flex:runtime-expanded]     runtime ∈ {node, shell, python, declarative, stdio-any}
 *   - [flex:install-target]       install-target optional string for declarative placement
 */
export interface Manifest {
  $schema?: string;
  id: string;
  /** ADR-0003: removed as an authored identity field. Optional/deprecated display label. */
  version?: string;
  type: 'agent' | 'skill' | 'mcp-server' | 'prompt' | 'hook' | 'command' | 'bundle' | 'service';
  title: string;
  description: string;
  /** Compatibility block — accepts any shape (host or soxe key) for forward compatibility. */
  compatibility: Record<string, string>;
  license: string;

  /** [flex:entrypoint-optional] Optional — absent for bundle, prompt, declarative types. */
  entrypoint?: string;

  /** [flex:runtime-expanded] Defaults to 'node' when absent (back-compat). */
  runtime?: ManifestRuntime;

  /** [flex:install-target] Host-placement path for declarative extensions. */
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

  /** [shape:install-descriptor] Hybrid install descriptor; replaces single-string install-target. */
  install?: ManifestInstall;

  /** Runtime/environment config carried on the built extension. */
  config?: Record<string, unknown>;

  /** [def:source-provenance] Top-level provenance path (alias; prefer install.source). */
  source?: string;

  [key: string]: unknown;
}

/** Result type for validate() */
export interface ValidateResult {
  ok: boolean;
  errors: string[];
  /** Non-fatal advisory notices. ok may still be true when warnings are present. */
  warnings: string[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

const VALID_TYPES = new Set<string>([
  'agent', 'skill', 'mcp-server', 'prompt', 'hook', 'command', 'bundle', 'service',
]);
export { VALID_TYPES };

/**
 * [flex:runtime-expanded] Valid runtime values including the three new ones.
 * stdio-any carried forward from v1.
 */
const VALID_RUNTIMES = new Set<string>([
  'node', 'shell', 'python', 'declarative', 'stdio-any',
]);
export { VALID_RUNTIMES };

const VALID_HOOK_EVENTS = new Set<string>([
  'PreToolUse', 'PostToolUse', 'SessionEnd', 'ScopePromotionProposed', 'Stop',
]);
export { VALID_HOOK_EVENTS };

/** Known host identifiers for install.hosts validation. */
export const KNOWN_HOSTS = new Set<string>(['claude', 'codex', 'opencode', 'agent-mcp']);

// ADR-0003: `version` is NO LONGER a required (or even meaningful) identity input.
// Identity is `id` + content `checksum`. `version`, if present, is a deprecated,
// display-only label and is validated for format only (below) — never required.
const REQUIRED_FIELDS: ReadonlyArray<string> = [
  'id', 'type', 'title', 'description', 'compatibility', 'license',
];

/**
 * [def:serves] Valid transport values for mcp install descriptors.
 * profiles ⊆ {serves∪transports} is enforced by validate(). [inv:never-managed]
 */
const VALID_SERVES = new Set<string>(['stdio', 'sse', 'http']);

/**
 * [def:transport] Valid transport values for service install descriptors.
 * Superset of VALID_SERVES; adds 'socket'.
 */
const VALID_TRANSPORTS = new Set<string>(['stdio', 'http', 'sse', 'socket']);

/**
 * [inv:never-managed] Claude managed-tier host keys soxe must never write.
 * Spec §4. validate() rejects install.overrides targeting these. [def:managed-tier]
 */
const CLAUDE_MANAGED_KEYS = new Set<string>([
  'managed', // Claude enterprise/org managed tier — soxe never writes this
]);

/**
 * [inv:never-managed] Codex project-forbidden keys soxe must never write at project scope.
 * Spec §4b. validate() rejects install.overrides targeting these. [def:project-forbidden-keys]
 */
const CODEX_PROJECT_FORBIDDEN_KEYS = new Set<string>([
  'model_providers', 'notify', 'profile', 'otel',
]);

// ─── Type guard ───────────────────────────────────────────────────────────────

/**
 * Type predicate: checks if a value is a valid Manifest.
 * Does not perform full semantic validation — use validate() for that.
 */
export function isManifest(value: unknown): value is Manifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const result = validate(value as Record<string, unknown>);
  return result.ok;
}

// ─── Validator ────────────────────────────────────────────────────────────────


// ─── render.agent-mcp validation (docs/spec/agent-mcp-renderer-fidelity.md §3/§4) ──

/** The closed set of `render.agent-mcp` keys (an unknown key is a typo, never silently ignored). */
const AGENT_MCP_RENDER_KEYS = new Set([
  'name', 'description', 'model', 'temperature', 'mode', 'tools', 'permission', 'version',
  'toolMap', 'fallbackPath', 'steps', 'provider', 'mcpServers', 'permissions',
  'nativeTooling', 'toolAdvertisement', 'sanitization', 'nativeWebTools', 'acceptLoss',
]);

/** The closed set of `agent` IR keys (an unknown key is a typo, never silently ignored). */
const AGENT_IR_KEYS = new Set([
  'name', 'description', 'model', 'mode', 'temperature', 'steps', 'tools', 'permission',
]);

/** The closed set of keys a symbolic `agent.tools` entry accepts. */
const AGENT_IR_TOOL_REF_KEYS = new Set(['logical', 'server']);

/** Keys each provider variant accepts (mirrors the server's strict provider union). */
const AGENT_MCP_PROVIDER_KEYS: Record<string, readonly string[]> = {
  anthropic: ['type', 'model', 'env', 'temperature', 'maxTokens', 'timeoutMs', 'retryConfig', 'models', 'billingScope', 'tripwire'],
  openai: ['type', 'model', 'env', 'baseURL', 'temperature', 'maxTokens', 'timeoutMs', 'retryConfig', 'models', 'billingScope', 'tripwire'],
  claudecli: ['type', 'model', 'claudePath', 'timeoutMs', 'allowedBuiltinTools', 'systemPromptIsAgentSpec', 'models', 'billingScope', 'tripwire'],
};

const AGENT_MCP_ENV_POINTER = /^ADHD_AGENT_[A-Z0-9_]+$/;
const AGENT_MCP_SECRET_KEY = /secret|token|key|password/i;
const AGENT_MCP_ENV_REF = /\$\{[A-Za-z_][A-Za-z0-9_]*\}|^\$[A-Za-z_][A-Za-z0-9_]*$/;
const ABSOLUTE_HOME_PATH = /^(\/Users\/|\/home\/|[A-Za-z]:[\\/])/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isAbsoluteHint(v: string): boolean {
  return v.startsWith('/') || v.startsWith('~') || /^[A-Za-z]:[\\/]/.test(v);
}

/**
 * Validate the `render.agent-mcp` block: closed key set, provider shape (env
 * pointers only, per-type keys), native-tooling root hints (no absolute fs
 * roots), and mcpServers hygiene (no literal secrets, no welded absolute home
 * paths or catalog DB paths, no stdio entry that launches agent-mcp itself).
 */
function validateAgentMcpRender(block: Record<string, unknown>, errors: string[], warnings: string[]): void {
  void warnings;
  const at = 'render.agent-mcp';
  for (const key of Object.keys(block)) {
    if (!AGENT_MCP_RENDER_KEYS.has(key)) {
      errors.push(`${at}.${key} is not a recognised key (allowed: ${Array.from(AGENT_MCP_RENDER_KEYS).join(', ')})`);
    }
  }

  const provider = block['provider'];
  if (provider !== undefined && provider !== null) {
    if (!isPlainObject(provider) || typeof provider['type'] !== 'string') {
      errors.push(`${at}.provider must be an object with a string "type" (or null for a deliberately unbound row)`);
    } else {
      const type = provider['type'];
      const allowed = AGENT_MCP_PROVIDER_KEYS[type];
      if (allowed === undefined) {
        errors.push(`${at}.provider.type "${type}" must be one of: ${Object.keys(AGENT_MCP_PROVIDER_KEYS).join(', ')}`);
      } else {
        for (const k of Object.keys(provider)) {
          if (!allowed.includes(k)) {
            const hint = k === 'retryWindowMs' ? ' — retryWindowMs belongs inside provider.retryConfig' : '';
            errors.push(`${at}.provider.${k} is not valid for provider type "${type}"${hint}`);
          }
        }
        if (type === 'claudecli' && provider['env'] !== undefined) {
          errors.push(`${at}.provider.env is not valid for type "claudecli" (no credential pointers are emitted)`);
        }
        if (type === 'claudecli' && provider['temperature'] !== undefined) {
          errors.push(`${at}.provider.temperature is not valid for type "claudecli"`);
        }
      }
      const t = provider['temperature'];
      if (t !== undefined && (typeof t !== 'number' || t < 0 || t > 1)) {
        errors.push(`${at}.provider.temperature must be a number in [0, 1]`);
      }
      const env = provider['env'];
      if (env !== undefined) {
        if (!isPlainObject(env)) {
          errors.push(`${at}.provider.env must be an object of env-var NAME pointers`);
        } else {
          for (const [f, v] of Object.entries(env)) {
            if (typeof v !== 'string' || !AGENT_MCP_ENV_POINTER.test(v)) {
              errors.push(`${at}.provider.env.${f} must be an ADHD_AGENT_-prefixed env-var NAME pointer (${String(AGENT_MCP_ENV_POINTER)}) — a literal credential is never emitted`);
            }
          }
        }
      }
    }
  }

  const enums: Array<[string, readonly string[]]> = [
    ['toolAdvertisement', ['names', 'full']],
    ['sanitization', ['none', 'prefix', 'wrap']],
  ];
  for (const [k, allowed] of enums) {
    const v = block[k];
    if (v !== undefined && (typeof v !== 'string' || !allowed.includes(v))) {
      errors.push(`${at}.${k} must be one of: ${allowed.join(' | ')}`);
    }
  }
  for (const k of ['nativeWebTools', 'acceptLoss'] as const) {
    if (block[k] !== undefined && typeof block[k] !== 'boolean') errors.push(`${at}.${k} must be a boolean`);
  }

  const toolMap = block['toolMap'];
  if (toolMap !== undefined) {
    if (!isPlainObject(toolMap) || Object.values(toolMap).some((v) => typeof v !== 'string')) {
      errors.push(`${at}.toolMap must map logical capability names to server-key strings`);
    }
  }

  const nt = block['nativeTooling'];
  if (nt !== undefined) {
    if (!isPlainObject(nt)) {
      errors.push(`${at}.nativeTooling must be an object`);
    } else {
      for (const [member, val] of Object.entries(nt)) {
        if (!['fs', 'shell', 'dispatch', 'hitl'].includes(member)) {
          errors.push(`${at}.nativeTooling.${member} is not a native member (fs | shell | dispatch | hitl)`);
          continue;
        }
        if (member === 'hitl') {
          if (typeof val !== 'boolean') errors.push(`${at}.nativeTooling.hitl must be a boolean`);
          continue;
        }
        if (typeof val === 'boolean' || !isPlainObject(val)) {
          if (typeof val !== 'boolean') errors.push(`${at}.nativeTooling.${member} must be a boolean or an object`);
          continue;
        }
        const roots = [val['root'], ...(Array.isArray(val['roots']) ? (val['roots'] as unknown[]) : [])];
        for (const r of roots) {
          if (typeof r === 'string' && isAbsoluteHint(r)) {
            errors.push(`${at}.nativeTooling.${member} root "${r}" must be a portable hint (cwd-relative subpath or alias), not an absolute path`);
          }
        }
        const patterns = val['allowPatterns'];
        if (Array.isArray(patterns) && patterns.some((p) => typeof p === 'string' && p.includes(','))) {
          errors.push(`${at}.nativeTooling.${member}.allowPatterns entries must not contain a comma (they are CSV-joined)`);
        }
      }
    }
  }

  const servers = block['mcpServers'];
  if (servers !== undefined) {
    if (!isPlainObject(servers)) {
      errors.push(`${at}.mcpServers must be an object`);
    } else {
      for (const [key, cfg] of Object.entries(servers)) {
        if (!isPlainObject(cfg)) {
          errors.push(`${at}.mcpServers.${key} must be an object`);
          continue;
        }
        const parts = [cfg['command'], cfg['cwd'], ...(Array.isArray(cfg['args']) ? (cfg['args'] as unknown[]) : [])];
        if (cfg['transport'] === 'stdio' && parts.some((p) => typeof p === 'string' && /(^|[/@\s])agent-mcp(\b|$)/.test(p))) {
          errors.push(`${at}.mcpServers.${key} launches agent-mcp itself — drop it; the renderer carries dispatch via nativeTooling.dispatch`);
        }
        for (const p of parts) {
          if (typeof p === 'string' && ABSOLUTE_HOME_PATH.test(p)) {
            errors.push(`${at}.mcpServers.${key} carries an absolute host path "${p}" — use "~/" or "\${HOME}" (expanded at render time)`);
          }
        }
        for (const block2 of ['env', 'headers'] as const) {
          const m = cfg[block2];
          if (m === undefined) continue;
          if (!isPlainObject(m)) {
            errors.push(`${at}.mcpServers.${key}.${block2} must be an object`);
            continue;
          }
          for (const [k, v] of Object.entries(m)) {
            if (k === 'ADHD_AGENT_DATABASE_PATH' || k === 'ADHD_AGENT_REGISTRY_DB_PATH') {
              errors.push(`${at}.mcpServers.${key}.${block2}.${k} welds a catalog DB path into the row`);
            }
            if (AGENT_MCP_SECRET_KEY.test(k) && (typeof v !== 'string' || !AGENT_MCP_ENV_REF.test(v))) {
              errors.push(`${at}.mcpServers.${key}.${block2}.${k} looks like a credential with a literal value — use an env reference ("\${NAME}")`);
            }
            if (typeof v === 'string' && ABSOLUTE_HOME_PATH.test(v)) {
              errors.push(`${at}.mcpServers.${key}.${block2}.${k} carries an absolute host path "${v}"`);
            }
          }
        }
      }
    }
  }
}

/**
 * Validate a manifest object against the libs/manifest contract.
 *
 * This is the single source of truth for manifest conformance
 * ([inv:manifest-source], [ref:manifest-single-source]).
 *
 * Encodes the three contract flexes from ADR-0001:
 *   [flex:entrypoint-optional]  entrypoint not required in schema required[]
 *   [flex:runtime-expanded]     runtime accepts node|shell|python|declarative|stdio-any
 *   [flex:install-target]       install-target accepted as optional field
 *
 * @param raw - The manifest object to validate (plain JS object, not a file path)
 * @returns { ok: boolean, errors: string[] }
 */
export function validate(raw: Record<string, unknown>): ValidateResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ── Structural checks ─────────────────────────────────────────────────────

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['manifest must be a non-null object'], warnings: [] };
  }

  // Required fields presence
  for (const field of REQUIRED_FIELDS) {
    if (raw[field] === undefined || raw[field] === null) {
      errors.push(`missing required field: "${field}"`);
    }
  }

  // ── id ────────────────────────────────────────────────────────────────────

  const id = raw['id'];
  if (typeof id === 'string') {
    if (!ID_PATTERN.test(id)) {
      errors.push(`id "${id}" must match ^[a-z][a-z0-9-]*$`);
    }
  } else if (id !== undefined) {
    errors.push(`id must be a string`);
  }

  // ── version (ADR-0003: deprecated, optional, display-only) ─────────────────
  // Not a required field and not an identity input. If present it must still be a
  // well-formed semver string (so a derived display label stays sane), but its
  // absence is fully valid — identity is `id` + content `checksum`.

  const version = raw['version'];
  if (typeof version === 'string') {
    const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;
    if (!semverPattern.test(version)) {
      errors.push(`version "${version}" must be a valid semver string`);
    }
  } else if (version !== undefined) {
    errors.push(`version must be a string`);
  }

  // ── type ──────────────────────────────────────────────────────────────────

  const type = raw['type'];
  if (typeof type === 'string') {
    if (!VALID_TYPES.has(type)) {
      errors.push(`type "${type}" must be one of: ${Array.from(VALID_TYPES).join(', ')}`);
    }
  } else if (type !== undefined) {
    errors.push(`type must be a string`);
  }

  // ── title ────────────────────────────────────────────────────────────────

  const title = raw['title'];
  if (title !== undefined && (typeof title !== 'string' || title.length === 0)) {
    errors.push(`title must be a non-empty string`);
  }

  // ── description ──────────────────────────────────────────────────────────

  const description = raw['description'];
  if (description !== undefined && (typeof description !== 'string' || description.length === 0)) {
    errors.push(`description must be a non-empty string`);
  }

  // ── compatibility ────────────────────────────────────────────────────────

  const compatibility = raw['compatibility'];
  if (compatibility !== undefined) {
    if (typeof compatibility !== 'object' || compatibility === null || Array.isArray(compatibility)) {
      errors.push(`compatibility must be an object`);
    }
  }

  // ── license ──────────────────────────────────────────────────────────────

  const license = raw['license'];
  if (license !== undefined && typeof license !== 'string') {
    errors.push(`license must be a string`);
  }

  // ── [flex:entrypoint-optional] entrypoint ────────────────────────────────
  // entrypoint is NOT in required[]. Omitting it is valid for bundles, prompts,
  // and declarative types. Behavioral types (node/shell/python) that omit it
  // are not flagged here — callers that need reachability checks (e.g.
  // scripts/validate-manifests.ts) do so at their layer.

  const entrypoint = raw['entrypoint'];
  if (entrypoint !== undefined) {
    if (typeof entrypoint !== 'string' || entrypoint.trim() === '') {
      errors.push(`entrypoint must be a non-empty string when present`);
    }
  }

  // ── [flex:runtime-expanded] runtime ──────────────────────────────────────
  // Expands from {node, stdio-any} to {node, shell, python, declarative, stdio-any}.
  // Absent => 'node' (back-compat with all v1 extensions).

  const runtime = raw['runtime'];
  if (runtime !== undefined) {
    if (typeof runtime !== 'string') {
      errors.push(`runtime must be a string`);
    } else if (!VALID_RUNTIMES.has(runtime)) {
      errors.push(
        `runtime "${runtime}" must be one of: ${Array.from(VALID_RUNTIMES).join(', ')}`,
      );
    }
  }

  // ── [flex:install-target] install-target ─────────────────────────────────
  // Optional field for declarative extensions. Accepted (no error) when present.

  const installTarget = raw['install-target'];
  if (installTarget !== undefined && typeof installTarget !== 'string') {
    errors.push(`install-target must be a string when present`);
  }

  // ── id must not end with type name (bundles excepted) ────────────────────

  if (typeof id === 'string' && typeof type === 'string' && VALID_TYPES.has(type)) {
    if (type !== 'bundle' && (id.endsWith(`-${type}`) || id === type)) {
      errors.push(`id "${id}" must not end with its type name "${type}"`);
    }
  }

  // ── runtime:'stdio-any' provider capability constraint ───────────────────

  if (typeof runtime === 'string' && runtime === 'stdio-any') {
    const requires = raw['requires'] as Record<string, unknown> | undefined;
    if (requires !== undefined) {
      const flags: string[] = [];
      if (requires['structured_output'] === true) flags.push('structured_output:true');
      if (requires['tool_calling'] === true) flags.push('tool_calling:true');
      if (flags.length > 0) {
        errors.push(
          `runtime:'stdio-any' cannot declare provider capabilities (${flags.join(', ')}) — ` +
          `provider calls require the Node/TS provider abstraction; set runtime:'node' or drop the requires.`,
        );
      }
    }
  }

  // ── lifecycle: only mcp-server / agent ───────────────────────────────────

  // [mcp-as-service]: mcp-server IS service[transport=stdio] for routing purposes.
  // The type name "mcp-server" is a back-compat alias; it is always valid.
  // validate() accepts lifecycle and transports on both mcp-server and service.
  const lifecycle = raw['lifecycle'] as Record<string, unknown> | undefined;
  if (lifecycle !== undefined) {
    const typeStr = typeof type === 'string' ? type : '';
    // [dod.6] agent extensions must NOT carry a lifecycle block.
    // Agents are Role B (file-drop reinjection); they have no sox-supervised process.
    // The schema previously accepted this silently; validate() now rejects it.
    if (typeStr === 'agent') {
      errors.push(
        `lifecycle block is not allowed on type:"agent" — agents are reinjected (Role B), ` +
        `not supervised (Role A). Remove the lifecycle block. [dod.6]`,
      );
    } else if (typeStr !== 'mcp-server' && typeStr !== 'service') {
      errors.push(
        `lifecycle block is only meaningful for type in {mcp-server, service} (got "${typeStr}")`,
      );
    }
    // health.endpoint required when health.type in {socket, command, http-get}
    const health = lifecycle['health'] as Record<string, unknown> | undefined;
    if (health !== undefined) {
      const healthType = (health['type'] as string | undefined) ?? 'stdio-ping';
      if ((healthType === 'socket' || healthType === 'command' || healthType === 'http-get') && health['endpoint'] === undefined) {
        errors.push(
          `lifecycle.health.endpoint is required when lifecycle.health.type is "${healthType}"`,
        );
      }
    }
  }

  // ── bundle-specific rules ─────────────────────────────────────────────────

  const typeStr = typeof type === 'string' ? type : '';
  const runtimeValue = typeof runtime === 'string' ? runtime : undefined;
  if (typeStr === 'bundle') {
    const members = raw['members'];
    // [flex:install-target] declarative bundles use install-target for placement;
    // they do not need a members array. Non-declarative bundles require members.
    const isDeclarative = runtimeValue === 'declarative';
    if (!isDeclarative && (!Array.isArray(members) || (members as unknown[]).length === 0)) {
      errors.push(`bundle "${String(id)}" must declare a non-empty "members" array`);
    }
    if (entrypoint !== undefined) {
      errors.push(`bundle "${String(id)}" must not declare "entrypoint" — bundles have no runtime`);
    }
    if (Array.isArray(members)) {
      const memberIds = new Set<string>();
      for (const member of members as Array<Record<string, unknown>>) {
        const mid = member['id'];
        if (typeof mid !== 'string' || !/^[a-z][a-z0-9-]*$/.test(mid)) {
          errors.push(`bundle member has invalid id "${String(mid)}"`);
        } else if (mid === String(id)) {
          errors.push(`bundle "${String(id)}" lists itself as a member — self-reference not allowed`);
        } else if (memberIds.has(mid)) {
          errors.push(`bundle "${String(id)}" has duplicate member id "${mid}"`);
        } else {
          memberIds.add(mid);
        }
        // ADR-0003: members are referenced by `id` only. No `version` / `^x.y.z`
        // spec — identity is id + content checksum, and there is one build per id.
        if ('version' in member) {
          warnings.push(
            `bundle member "${String(mid)}" declares a "version" — ignored (ADR-0003: ` +
            `members are referenced by id only). Remove it from the manifest.`,
          );
        }
      }
    }
  }

  // ── hook events ──────────────────────────────────────────────────────────

  if (typeStr === 'hook') {
    const events = raw['events'];
    if (Array.isArray(events)) {
      for (const evt of events as unknown[]) {
        if (typeof evt === 'string' && !VALID_HOOK_EVENTS.has(evt)) {
          errors.push(
            `hook declares unknown event "${evt}". Valid: ${Array.from(VALID_HOOK_EVENTS).join(', ')}`,
          );
        }
      }
    }
  }

  // ── permissions structural check ─────────────────────────────────────────

  const permissions = raw['permissions'];
  if (permissions !== undefined) {
    if (typeof permissions !== 'object' || permissions === null || Array.isArray(permissions)) {
      errors.push(`permissions must be an object`);
    } else {
      const perms = permissions as Record<string, unknown>;
      const fs = perms['fs'];
      if (fs !== undefined) {
        const fsBlock = fs as Record<string, unknown>;
        for (const key of ['read', 'write'] as const) {
          const val = fsBlock[key];
          if (val !== undefined && (!Array.isArray(val) || (val as unknown[]).some((v) => typeof v !== 'string'))) {
            errors.push(`permissions.fs.${key} must be a string array`);
          }
        }
      }
      const network = perms['network'];
      if (network !== undefined) {
        const netBlock = network as Record<string, unknown>;
        const outbound = netBlock['outbound'];
        if (outbound !== undefined && (!Array.isArray(outbound) || (outbound as unknown[]).some((v) => typeof v !== 'string'))) {
          errors.push(`permissions.network.outbound must be a string array`);
        }
      }
      const socket = perms['socket'];
      if (socket !== undefined) {
        const sockBlock = socket as Record<string, unknown>;
        const paths = sockBlock['paths'];
        if (paths !== undefined && (!Array.isArray(paths) || (paths as unknown[]).some((v) => typeof v !== 'string'))) {
          errors.push(`permissions.socket.paths must be a string array`);
        }
      }
    }
  }

  // ── [shape:install-descriptor] install block ─────────────────────────────
  // Validates the hybrid install descriptor if present.
  // Back-compat: single-string install-target is accepted (handled above).
  // New descriptor fields: type, hosts, profiles, serves, source, overrides.

  const install = raw['install'] as Record<string, unknown> | undefined;
  if (install !== undefined) {
    if (typeof install !== 'object' || install === null || Array.isArray(install)) {
      errors.push(`install must be an object when present`);
    } else {
      // ── serves: valid transport values only ────────────────────────────
      const serves = install['serves'];
      const servesSet = new Set<string>();
      if (serves !== undefined) {
        if (!Array.isArray(serves)) {
          errors.push(`install.serves must be an array`);
        } else {
          for (const s of serves as unknown[]) {
            if (typeof s !== 'string' || !VALID_SERVES.has(s)) {
              errors.push(
                `install.serves entry "${String(s)}" must be one of: ${Array.from(VALID_SERVES).join(', ')}`,
              );
            } else {
              servesSet.add(s);
            }
          }
        }
      }

      // ── transports: valid vocabulary (service type) ────────────────────
      const transports = install['transports'];
      const transportsSet = new Set<string>();
      if (transports !== undefined) {
        if (!Array.isArray(transports)) {
          errors.push(`install.transports must be an array`);
        } else {
          for (const t of transports as unknown[]) {
            if (typeof t !== 'string' || !VALID_TRANSPORTS.has(t)) {
              errors.push(
                `install.transports entry "${String(t)}" must be one of: ${Array.from(VALID_TRANSPORTS).join(', ')}`,
              );
            } else {
              transportsSet.add(t);
            }
          }
        }
      }

      // ── type:service requires ≥1 transport ────────────────────────────
      if (typeStr === 'service' && transportsSet.size === 0 && servesSet.size === 0) {
        errors.push(
          `type:"service" must declare at least one transport in install.transports (or install.serves)`,
        );
      }

      // ── profiles ⊆ {serves∪transports} ───────────────────────────────
      // [schema-delta.3] Every profile name must correspond to a known transport.
      // A profile not in serves or transports is incoherent — the transport it installs for isn't declared.
      const combinedSet = new Set([...servesSet, ...transportsSet]);
      const profiles = install['profiles'];
      if (profiles !== undefined) {
        if (typeof profiles !== 'object' || profiles === null || Array.isArray(profiles)) {
          errors.push(`install.profiles must be an object`);
        } else if (combinedSet.size > 0) {
          for (const profileName of Object.keys(profiles as Record<string, unknown>)) {
            if (!combinedSet.has(profileName)) {
              errors.push(
                `install.profiles key "${profileName}" is not in install.serves/transports ` +
                `[${Array.from(combinedSet).join(', ')}] — profiles ⊆ {serves∪transports} invariant violated`,
              );
            }
          }
        }
      }

      // ── [inv:never-managed] overrides key checks ───────────────────────
      // [schema-delta.4] Refuse managed (claude) and project-forbidden (codex) keys.
      const overrides = install['overrides'];
      if (overrides !== undefined) {
        if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
          errors.push(`install.overrides must be an object`);
        } else {
          const overridesMap = overrides as Record<string, unknown>;
          // Check claude host overrides for managed-tier keys
          const claudeOverrides = overridesMap['claude'];
          if (claudeOverrides !== null && typeof claudeOverrides === 'object' && !Array.isArray(claudeOverrides)) {
            for (const key of Object.keys(claudeOverrides as Record<string, unknown>)) {
              if (CLAUDE_MANAGED_KEYS.has(key)) {
                errors.push(
                  `install.overrides.claude["${key}"] targets a managed-tier key — ` +
                  `soxe never writes the Claude managed tier. [inv:never-managed] [def:managed-tier]`,
                );
              }
            }
          }
          // Check codex host overrides for project-forbidden keys
          const codexOverrides = overridesMap['codex'];
          if (codexOverrides !== null && typeof codexOverrides === 'object' && !Array.isArray(codexOverrides)) {
            for (const key of Object.keys(codexOverrides as Record<string, unknown>)) {
              if (CODEX_PROJECT_FORBIDDEN_KEYS.has(key)) {
                errors.push(
                  `install.overrides.codex["${key}"] is a project-forbidden key — ` +
                  `soxe must not set this at project scope. [inv:never-managed] [def:project-forbidden-keys]`,
                );
              }
            }
          }
        }
      }

      // ── source: string when present ────────────────────────────────────
      const installSource = install['source'];
      if (installSource !== undefined && typeof installSource !== 'string') {
        errors.push(`install.source must be a string when present`);
      }

      // ── hosts: known values ────────────────────────────────────────────
      const hosts = install['hosts'];
      if (hosts !== undefined) {
        if (!Array.isArray(hosts)) {
          errors.push(`install.hosts must be an array`);
        } else {
          for (const h of hosts as unknown[]) {
            if (typeof h !== 'string' || !KNOWN_HOSTS.has(h)) {
              errors.push(
                `install.hosts entry "${String(h)}" must be one of: ${Array.from(KNOWN_HOSTS).join(', ')}`,
              );
            }
          }
        }
      }
    }
  }

  // ── agent IR (cross-platform rendering) ──────────────────────────────────
  // [def:agent-ir] Host-agnostic agent block rendered into a per-host header at
  // install time. Optional; absent => raw passthrough (legacy baked-in header).
  const agent = raw['agent'];
  if (agent !== undefined) {
    if (typeof agent !== 'object' || agent === null || Array.isArray(agent)) {
      errors.push(`agent must be an object`);
    } else {
      const a = agent as Record<string, unknown>;
      // Fail closed on unknown keys. The JSON schema declares additionalProperties:false
      // but is never executed, so this is the enforcement (6fd94192). A host-agnostic
      // concern such as roles-covered belongs in `capabilities`, not in the agent IR.
      for (const k of Object.keys(a)) {
        if (!AGENT_IR_KEYS.has(k)) {
          errors.push(`agent.${k} is not a recognized agent key (allowed: ${[...AGENT_IR_KEYS].join(', ')})`);
        }
      }
      if (a['steps'] !== undefined && (typeof a['steps'] !== 'number' || !Number.isFinite(a['steps']))) {
        errors.push(`agent.steps must be a number when present`);
      }
      for (const k of ['name', 'description', 'model', 'mode']) {
        const v = a[k];
        if (v !== undefined && typeof v !== 'string') {
          errors.push(`agent.${k} must be a string when present`);
        }
      }
      if (a['temperature'] !== undefined && typeof a['temperature'] !== 'number') {
        errors.push(`agent.temperature must be a number when present`);
      }
      const tools = a['tools'];
      if (tools !== undefined) {
        if (!Array.isArray(tools)) {
          errors.push(`agent.tools must be an array`);
        } else {
          for (const t of tools as unknown[]) {
            if (typeof t === 'string') continue;
            if (typeof t === 'object' && t !== null && !Array.isArray(t)) {
              const o = t as Record<string, unknown>;
              for (const k of Object.keys(o)) {
                if (!AGENT_IR_TOOL_REF_KEYS.has(k)) {
                  errors.push(`agent.tools[].${k} is not a recognized symbolic tool key (allowed: logical, server)`);
                }
              }
              if (typeof o['logical'] !== 'string' || typeof o['server'] !== 'string') {
                errors.push(`agent.tools symbolic entries require string "logical" and "server"`);
              }
            } else {
              errors.push(`agent.tools entries must be strings or { logical, server } objects`);
            }
          }
        }
      }
      const permission = a['permission'];
      if (permission !== undefined) {
        if (typeof permission !== 'object' || permission === null || Array.isArray(permission)) {
          errors.push(`agent.permission must be an object`);
        } else {
          for (const [k, v] of Object.entries(permission as Record<string, unknown>)) {
            if (typeof v === 'string') continue; // scalar action
            if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
              for (const [pat, act] of Object.entries(v as Record<string, unknown>)) {
                if (typeof act !== 'string') {
                  errors.push(`agent.permission.${k}["${pat}"] must be a string action`);
                }
              }
            } else {
              errors.push(`agent.permission.${k} must be a string action or a pattern→action object`);
            }
          }
        }
      }
    }
  }

  // ── render overrides (per-host typed config) ─────────────────────────────
  // [def:agent-render-overrides] Keys are host names; values are per-host header
  // overrides merged over the IR at install time.
  const render = raw['render'];
  if (render !== undefined) {
    if (typeof render !== 'object' || render === null || Array.isArray(render)) {
      errors.push(`render must be an object`);
    } else {
      for (const [hostKey, hostVal] of Object.entries(render as Record<string, unknown>)) {
        if (!KNOWN_HOSTS.has(hostKey)) {
          errors.push(`render key "${hostKey}" must be one of: ${Array.from(KNOWN_HOSTS).join(', ')}`);
        }
        if (typeof hostVal !== 'object' || hostVal === null || Array.isArray(hostVal)) {
          errors.push(`render.${hostKey} must be an object`);
        } else if (hostKey === 'agent-mcp') {
          validateAgentMcpRender(hostVal as Record<string, unknown>, errors, warnings);
        }
      }
    }
  }

  // ── agent host-render completeness (bug eb1ab168) ──────────────────────────
  // An `agent` that lists a host in install.hosts MUST declare a render.<host>
  // object. Without this rule a host with no render of its own silently inherits
  // another host's model at render time — the agent-mcp rows all inherited
  // Claude's default, making every sox agent non-dispatchable on openai surfaces.
  // A host must not inherit another host's model: declare render.<host> or drop
  // the host from install.hosts. Scoped to type:"agent" (skills, etc. have no
  // host-rendered agent header).
  if (
    typeStr === 'agent' &&
    install !== undefined &&
    typeof install === 'object' &&
    !Array.isArray(install)
  ) {
    const agentHosts = (install as Record<string, unknown>)['hosts'];
    if (Array.isArray(agentHosts)) {
      const renderMap =
        render !== undefined && typeof render === 'object' && !Array.isArray(render)
          ? (render as Record<string, unknown>)
          : undefined;
      for (const h of agentHosts as unknown[]) {
        if (typeof h !== 'string') continue; // install.hosts value check already reported it
        const hostRender = renderMap?.[h];
        if (hostRender === undefined || hostRender === null || typeof hostRender !== 'object' || Array.isArray(hostRender)) {
          errors.push(
            `agent lists host "${h}" in install.hosts but declares no render.${h} object — ` +
              `a host must not inherit another host's model. Add render.${h} or remove "${h}" from install.hosts.`,
          );
        }
      }
    }
  }

  // ── config_schema meta-validation ────────────────────────────────────────
  // config_schema is optional but strongly recommended for process types.
  // We validate the shape (must be an object) and emit advisory warnings for
  // common pitfalls. Warnings never set ok=false — they survive --strict in
  // cmdValidate but are printed separately.

  const configSchema = raw['config_schema'];
  if (configSchema !== undefined) {
    if (typeof configSchema !== 'object' || configSchema === null || Array.isArray(configSchema)) {
      errors.push(`config_schema must be a JSON Schema object when present`);
    } else {
      const cs = configSchema as Record<string, unknown>;
      if (cs['type'] !== undefined && cs['type'] !== 'object') {
        errors.push(`config_schema.type must be "object" (got "${String(cs['type'])}")`);
      }
      if (cs['additionalProperties'] === undefined || cs['additionalProperties'] === true) {
        warnings.push(
          `config_schema does not set additionalProperties: false — typos in config keys will not be detected. ` +
          `Set "additionalProperties": false to enable unknown-key warnings from "soxe config check".`,
        );
      }
      // Validate required array entries are strings
      const required = cs['required'];
      if (required !== undefined) {
        if (!Array.isArray(required)) {
          errors.push(`config_schema.required must be an array`);
        } else if ((required as unknown[]).some((r) => typeof r !== 'string')) {
          errors.push(`config_schema.required entries must all be strings`);
        }
      }
      // Validate properties map if present
      const props = cs['properties'];
      if (props !== undefined) {
        if (typeof props !== 'object' || props === null || Array.isArray(props)) {
          errors.push(`config_schema.properties must be an object`);
        }
      }
    }
  } else {
    // Warn for process types that benefit from config_schema but haven't declared one
    const processTypes = new Set(['mcp-server', 'agent', 'service']);
    if (processTypes.has(typeStr)) {
      warnings.push(
        `type:"${typeStr}" has no config_schema — consider declaring one so "soxe install" can ` +
        `prompt for required configuration and "soxe config check" can validate it.`,
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ─── Schema export ────────────────────────────────────────────────────────────

/**
 * The raw JSON schema for the manifest (v2 with contract flexes).
 *
 * Inlined here (not require('./schema.json')) so the dist output is self-contained
 * and works with both `require()` (CJS) and dynamic import (ESM) without needing
 * the JSON asset to be copied as a separate file.
 *
 * This inline copy is AUTHORITATIVE at runtime; `libs/manifest/src/schema.json`
 * is regenerated from it (`npx tsx -e "…JSON.stringify(ManifestSchema)…"`) and the
 * two are kept identical by `schema-parity.spec.ts` (BL-623). Editing one without
 * the other fails the parity test.
 */
export const ManifestSchema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://your-registry/schemas/extension/v2.json',
  title: 'Extension manifest v2 (libs/manifest — single source of truth)',
  description:
    'Adds three contract flexes over v1: entrypoint optional/typed, runtime expanded to ' +
    '{node,shell,python,declarative,stdio-any}, install-target for declarative host-placement.',
  type: 'object',
  additionalProperties: true,
  required: ['id', 'type', 'title', 'description', 'compatibility', 'license'],
  properties: {
    $schema: { type: 'string' },
    id: {
      type: 'string',
      pattern: '^[a-z][a-z0-9-]*$',
      description: 'Stable slug; primary registry key; immutable once published.',
    },
    version: {
      type: 'string',
      pattern:
        '^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z-.]+)?(?:\\+[0-9A-Za-z-.]+)?$',
      deprecated: true,
      description:
        'DEPRECATED (ADR-0003): not an identity input. Identity is id + content checksum. ' +
        'Optional, display-only label; if present must be valid semver. Will be removed.',
    },
    type: {
      type: 'string',
      enum: ['agent', 'skill', 'mcp-server', 'prompt', 'hook', 'command', 'bundle', 'service'],
      description: 'Extension type. Closed enum.',
    },
    title: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1 },
    compatibility: {
      type: 'object',
      description: 'Host compatibility requirements. Accepts any shape (host or soxe key).',
      additionalProperties: true,
    },
    license: { type: 'string' },
    // [flex:entrypoint-optional]
    entrypoint: {
      type: 'string',
      description:
        '[flex:entrypoint-optional] Optional. Absent for bundle, prompt, and declarative types.',
    },
    // [flex:runtime-expanded]
    runtime: {
      type: 'string',
      enum: ['node', 'shell', 'python', 'declarative', 'stdio-any'],
      description:
        "[flex:runtime-expanded] 'node'|'shell'|'python'|'declarative'|'stdio-any'. Absent => 'node'.",
    },
    // [flex:install-target]
    'install-target': {
      type: 'string',
      description:
        '[flex:install-target] Optional host-placement path for declarative extensions.',
    },
    keywords: { type: 'array', items: { type: 'string' } },
    author: {
      oneOf: [
        { type: 'string' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: { type: 'string' },
            email: { type: 'string' },
            url: { type: 'string' },
          },
        },
      ],
    },
    homepage: { type: 'string' },
    repository: { type: 'string' },
    private: { type: 'boolean' },
    checksum: { type: 'string' },
    order: { type: 'integer' },
    tags: { type: 'array', items: { type: 'string' } },
    requires: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tool_calling: { type: 'boolean' },
        structured_output: { type: 'boolean' },
        min_context_tokens: { type: 'integer', minimum: 1 },
      },
    },
    dependencies: {
      type: 'array',
      items: {
        oneOf: [
          { type: 'string' },
          {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'version'],
            properties: {
              id: { type: 'string' },
              version: { type: 'string' },
            },
          },
        ],
      },
    },
    capabilities: { type: 'array', items: { type: 'string' } },
    members: {
      type: 'array',
      // ADR-0003: members are referenced by `id` only (identity = id + checksum).
      // `version` is no longer required; it is accepted-but-ignored during migration
      // (additionalProperties:true) and should be removed from manifests.
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
    },
    lifecycle: {
      type: 'object',
      additionalProperties: false,
      properties: {
        background: { type: 'boolean' },
        singleton: { type: 'boolean' },
        stop_timeout_ms: { type: 'integer', minimum: 0 },
        health: {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: { enum: ['stdio-ping', 'http-get', 'socket', 'command'] },
            endpoint: { type: 'string' },
            interval_ms: { type: 'integer', minimum: 250 },
            timeout_ms: { type: 'integer', minimum: 100 },
          },
        },
      },
    },
    events: { type: 'array', items: { type: 'string' }, minItems: 1 },
    invocation: {
      type: 'object',
      additionalProperties: false,
      properties: {
        protocol: { type: 'string', enum: ['function-export', 'stdio', 'ipc', 'http'] },
        handler: { type: 'string' },
        input_schema: { type: 'object', additionalProperties: true },
        output_schema: { type: 'object', additionalProperties: true },
        description: { type: 'string' },
      },
    },
    tools: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          inputSchema: { type: 'object', additionalProperties: true },
        },
      },
    },
    parameters: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: ['string', 'number', 'boolean', 'array', 'object'] },
          required: { type: 'boolean' },
          description: { type: 'string' },
        },
      },
    },
    template_engine: {
      type: 'string',
      enum: ['handlebars', 'jinja2', 'mustache', 'simple', 'none'],
    },
    run_interface: {
      type: 'object',
      additionalProperties: false,
      properties: {
        input_schema: { type: 'object', additionalProperties: true },
        output_schema: { type: 'object', additionalProperties: true },
      },
    },
    config_schema: { type: 'object', additionalProperties: true },
    permissions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fs: {
          type: 'object',
          additionalProperties: false,
          properties: {
            read: { type: 'array', items: { type: 'string' } },
            write: { type: 'array', items: { type: 'string' } },
          },
        },
        network: {
          type: 'object',
          additionalProperties: false,
          properties: {
            outbound: { type: 'array', items: { type: 'string' } },
          },
        },
        socket: {
          type: 'object',
          additionalProperties: false,
          properties: {
            paths: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    // [shape:install-descriptor] hybrid install descriptor fields
    install: {
      type: 'object',
      description:
        '[shape:install-descriptor] Hybrid install descriptor. Engine fills per-host defaults from libs/host-registry.',
      additionalProperties: true,
      properties: {
        type: {
          type: 'string',
          enum: ['agent', 'skill', 'mcp-server', 'prompt', 'hook', 'command', 'bundle', 'service'],
        },
        hosts: { type: 'array', items: { type: 'string', enum: ['claude', 'codex', 'opencode', 'agent-mcp'] } },
        profiles: { type: 'object', additionalProperties: true },
        serves: { type: 'array', items: { type: 'string', enum: ['stdio', 'sse', 'http'] } },
        transports: { type: 'array', items: { type: 'string', enum: ['stdio', 'http', 'sse', 'socket'] } },
        source: { type: 'string' },
        overrides: { type: 'object', additionalProperties: true },
      },
    },
    // ── Cross-platform agent rendering (docs/spec/cross-platform-install-rendering.md) ──
    // `agent` is the host-agnostic IR; `render.<host>` are typed per-host overrides
    // merged over the IR at install time. The prose body lives in `entrypoint`.
    agent: {
      type: 'object',
      additionalProperties: false,
      description:
        '[def:agent-ir] Host-agnostic agent IR. Rendered into a per-host header at install time by libs/host-registry.',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        model: { type: 'string' },
        temperature: { type: 'number' },
        mode: { type: 'string' },
        steps: { type: 'number' },
        tools: {
          type: 'array',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                additionalProperties: false,
                required: ['logical', 'server'],
                properties: {
                  logical: { type: 'string' },
                  server: { type: 'string' },
                },
              },
            ],
          },
        },
        permission: {
          type: 'object',
          additionalProperties: true,
          description:
            'opencode agent-frontmatter permission map: action | (pattern -> action). Shape-checked by validate().',
        },
      },
    },
    render: {
      type: 'object',
      additionalProperties: false,
      description:
        '[def:agent-render-overrides] Per-host typed overrides merged over the agent IR at install time.',
      properties: {
        claude: { type: 'object', additionalProperties: true },
        opencode: { type: 'object', additionalProperties: true },
        codex: { type: 'object', additionalProperties: true },
        'agent-mcp': { type: 'object', additionalProperties: true },
      },
    },
    config: { type: 'object', additionalProperties: true },
    source: { type: 'string', description: '[def:source-provenance] Top-level provenance path.' },
  },
};
