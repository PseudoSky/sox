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
  type?: 'stdio-ping' | 'socket' | 'command';
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

/** Bundle member entry */
export interface ManifestMember {
  id: string;
  version: string;
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
  version: string;
  type: 'agent' | 'skill' | 'mcp-server' | 'prompt' | 'hook' | 'command' | 'bundle';
  title: string;
  description: string;
  /** Compatibility block — accepts any shape (host or sox key) for forward compatibility. */
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

  [key: string]: unknown;
}

/** Result type for validate() */
export interface ValidateResult {
  ok: boolean;
  errors: string[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

const VALID_TYPES = new Set<string>([
  'agent', 'skill', 'mcp-server', 'prompt', 'hook', 'command', 'bundle',
]);

/**
 * [flex:runtime-expanded] Valid runtime values including the three new ones.
 * stdio-any carried forward from v1.
 */
const VALID_RUNTIMES = new Set<string>([
  'node', 'shell', 'python', 'declarative', 'stdio-any',
]);

const VALID_HOOK_EVENTS = new Set<string>([
  'PreToolUse', 'PostToolUse', 'SessionEnd', 'ScopePromotionProposed', 'Stop',
]);

const REQUIRED_FIELDS: ReadonlyArray<string> = [
  'id', 'version', 'type', 'title', 'description', 'compatibility', 'license',
];

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

  // ── Structural checks ─────────────────────────────────────────────────────

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['manifest must be a non-null object'] };
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

  // ── version ───────────────────────────────────────────────────────────────

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

  const lifecycle = raw['lifecycle'] as Record<string, unknown> | undefined;
  if (lifecycle !== undefined) {
    const typeStr = typeof type === 'string' ? type : '';
    if (typeStr !== 'mcp-server' && typeStr !== 'agent') {
      errors.push(
        `lifecycle block is only meaningful for type in {mcp-server, agent} (got "${typeStr}")`,
      );
    }
    // health.endpoint required when health.type in {socket, command}
    const health = lifecycle['health'] as Record<string, unknown> | undefined;
    if (health !== undefined) {
      const healthType = (health['type'] as string | undefined) ?? 'stdio-ping';
      if ((healthType === 'socket' || healthType === 'command') && health['endpoint'] === undefined) {
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
        if (typeof member['version'] !== 'string' || (member['version'] as string).length === 0) {
          errors.push(`bundle member "${String(mid)}" must declare a "version" semver range`);
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

  return { ok: errors.length === 0, errors };
}

// ─── Schema export ────────────────────────────────────────────────────────────

/**
 * The raw JSON schema for the manifest (v2 with contract flexes).
 *
 * Inlined here (not require('./schema.json')) so the dist output is self-contained
 * and works with both `require()` (CJS) and dynamic import (ESM) without needing
 * the JSON asset to be copied as a separate file.
 *
 * Source of truth: libs/manifest/src/schema.json
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
  required: ['id', 'version', 'type', 'title', 'description', 'compatibility', 'license'],
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
      description: 'semver.',
    },
    type: {
      type: 'string',
      enum: ['agent', 'skill', 'mcp-server', 'prompt', 'hook', 'command', 'bundle'],
      description: 'Extension type. Closed enum.',
    },
    title: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1 },
    compatibility: {
      type: 'object',
      description: 'Host compatibility requirements. Accepts any shape (host or sox key).',
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
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'version'],
        properties: {
          id: { type: 'string' },
          version: { type: 'string' },
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
            type: { enum: ['stdio-ping', 'socket', 'command'] },
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
  },
};
