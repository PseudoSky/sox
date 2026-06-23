/**
 * libs/authoring — pure scaffold core for sox extension scaffolding.
 *
 * Invariants:
 *   [inv:nx-free-core]     — zero nx-devkit or nx-packages imports (sox init runs without nx)
 *   [ref:nx-free-authoring-core] — anchor: scaffold function below
 *
 * Exports:
 *   scaffold(opts) → FileSet   — generate all files for a given type+id
 *   writeFileSet(fs, outDir)   — write a FileSet to disk (delegated to writer.ts)
 *   FileSet                    — type alias
 *   ScaffoldOpts               — input options type (with Appendix-A options)
 *   ActiveType                 — union of 6 active extension types
 */

import { agentTemplate } from './templates/agent/index.js';
import { bundleTemplate } from './templates/bundle/index.js';
import { commandTemplate } from './templates/command/index.js';
import { hookTemplate } from './templates/hook/index.js';
import { mcpServerTemplate } from './templates/mcp-server/index.js';
import { serviceTemplate } from './templates/service/index.js';
import { skillTemplate } from './templates/skill/index.js';

export { writeFileSet } from './writer.js';
// Re-export per-type template functions so consumers (apps/sox init fallback)
// can dispatch by name via the @adhd/sox-authoring scope — no ../dist reach-in (C7).
export {
  agentTemplate, bundleTemplate, commandTemplate, hookTemplate, mcpServerTemplate, serviceTemplate, skillTemplate
};

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A FileSet is a map from relative path to file content.
 * Paths are relative to the extension root (e.g. "src/index.ts", "extension.json").
 * Immutable output of scaffold().
 */
export type FileSet = Readonly<Record<string, string>>;

/**
 * The active extension types. 'prompt' is parked — no template in the active scaffold path.
 * [def:active-types] in _shared.md.
 */
export type ActiveType =
  | 'agent'
  | 'skill'
  | 'mcp-server'
  | 'hook'
  | 'command'
  | 'bundle'
  | 'service';

export const ACTIVE_TYPES: ReadonlyArray<ActiveType> = [
  'agent',
  'skill',
  'mcp-server',
  'hook',
  'command',
  'bundle',
  'service',
];

/**
 * Options passed to scaffold().
 *
 * Core fields (all required by the scaffold contract):
 *   type, id, title, description, author, keywords
 *
 * Appendix-A options (all optional; forwarded to templates and emitted in descriptors):
 *   content, source, hosts, scope, permissions, env,
 *   transports, profile, trust, surface, inject
 *
 * [generators.1] — all Appendix-A options are accepted here and forwarded to templates.
 * [inv:host-agnostic-type] — target paths are resolved from host-registry at install,
 *   not stored in the scaffold output.
 */
export interface ScaffoldOpts {
  /** One of the 6 active types. prompt is NOT accepted here (parked). */
  type: ActiveType;
  /** Extension id: must match ^[a-z][a-z0-9-]*$ and NOT end with the type name. */
  id: string;
  /** Human-readable title. Defaults to id when omitted. */
  title?: string;
  /** One-line description. Defaults to "<id> extension" when omitted. */
  description?: string;
  /** Author string or object — written to extension.json and package.json. */
  author?: string;
  /** Keywords array — written to extension.json. */
  keywords?: string[];

  // ── Appendix-A: content / provenance ──────────────────────────────────────
  /**
   * --content @path — body text read from a source path at init time.
   * Fills the artifact body when present.
   */
  content?: string;
  /**
   * [def:source-provenance] — origin path from --content @path / --from @dir.
   * Stamped into install.source on the manifest so update can re-pull. [generators.3]
   */
  source?: string;

  // ── Appendix-A: install descriptor ────────────────────────────────────────
  /** --host: chosen host targets (e.g. ['claude', 'codex']). [inv:host-agnostic-type] */
  hosts?: string[];
  /** --scope: install scope override (project | user | local). */
  scope?: string;
  /** --permissions: declared permission block overrides. */
  permissions?: Record<string, unknown>;
  /** --env: environment variable declarations. */
  env?: Record<string, string>;

  // ── Appendix-A: mcp-server specific ───────────────────────────────────────
  /** --transports: mcp transports (stdio | sse | http). [def:serves] */
  transports?: string[];
  /** --profile / --mode: install-layer preset name (e.g. standalone | shared). [def:profile] */
  profile?: string;
  /** --trust: mcp trust disposition (prompt | auto). [inv:never-managed] */
  trust?: string;

  // ── Appendix-A: command specific ──────────────────────────────────────────
  /** --surface: command surface override (e.g. claude-commands | codex-commands). */
  surface?: string;

  // ── Appendix-A: prompt specific ───────────────────────────────────────────
  /** --inject: prompt injection target (rules | claude-md). Prompt type only. */
  inject?: string;

  // ── Appendix-A: bundle specific ───────────────────────────────────────────
  /**
   * R9: --member flag(s) for bundle init. Each entry is "<type>:<member-id>".
   * Scaffolds member extensions in members/ subdirectory with visibility: "internal".
   */
  members?: Array<{ type: string; id: string }>;
}

// ─── ID validation ────────────────────────────────────────────────────────────

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Returns an error string if the id is invalid; null if valid.
 * Mirrors the contract in libs/manifest validate().
 */
export function validateId(id: string, type: ActiveType): string | null {
  if (!ID_PATTERN.test(id)) {
    return `id "${id}" must match ^[a-z][a-z0-9-]*$`;
  }
  if (id.endsWith(`-${type}`) || id === type) {
    return `id "${id}" must not end with the type name "${type}"`;
  }
  return null;
}

// ─── Template dispatch ────────────────────────────────────────────────────────

/** Internal resolved opts (title/description always present; Appendix-A fields passed through). */
export interface ResolvedOpts {
  type: ActiveType;
  id: string;
  title: string;
  description: string;
  author: string | undefined;
  keywords: string[] | undefined;
  // Appendix-A fields (all optional)
  content: string | undefined;
  source: string | undefined;
  hosts: string[] | undefined;
  scope: string | undefined;
  permissions: Record<string, unknown> | undefined;
  env: Record<string, string> | undefined;
  transports: string[] | undefined;
  profile: string | undefined;
  trust: string | undefined;
  surface: string | undefined;
  inject: string | undefined;
  members: Array<{ type: string; id: string }> | undefined;
}

function resolveOpts(opts: ScaffoldOpts): ResolvedOpts {
  return {
    type: opts.type,
    id: opts.id,
    title: opts.title ?? opts.id,
    description: opts.description ?? `${opts.id} extension`,
    author: opts.author,
    keywords: opts.keywords,
    // Appendix-A passthrough
    content: opts.content,
    source: opts.source,
    hosts: opts.hosts,
    scope: opts.scope,
    permissions: opts.permissions,
    env: opts.env,
    transports: opts.transports,
    profile: opts.profile,
    trust: opts.trust,
    surface: opts.surface,
    inject: opts.inject,
    members: opts.members,
  };
}

/**
 * scaffold(opts) → FileSet
 *
 * Generates a complete, born-conformant FileSet for the given extension type.
 * The returned FileSet validates against libs/manifest when the extension.json
 * is parsed.
 *
 * Appendix-A options (content, source, hosts, transports, profile, trust,
 * surface, inject, etc.) are forwarded to the type template and emitted in
 * the install descriptor. [generators.1] [generators.2] [generators.3]
 *
 * [ref:nx-free-authoring-core] — this function and all transitive imports
 * contain zero nx-devkit or nx-packages imports.
 *
 * @throws Error if type is not in ACTIVE_TYPES or id fails validation
 */
export function scaffold(opts: ScaffoldOpts): FileSet {
  const err = validateId(opts.id, opts.type);
  if (err !== null) {
    throw new Error(`scaffold: invalid id — ${err}`);
  }

  const resolved = resolveOpts(opts);

  switch (resolved.type) {
    case 'agent':
      return agentTemplate(resolved);
    case 'skill':
      return skillTemplate(resolved);
    case 'mcp-server':
      return mcpServerTemplate(resolved);
    case 'hook':
      return hookTemplate(resolved);
    case 'command':
      return commandTemplate(resolved);
    case 'bundle':
      return bundleTemplate(resolved);
    case 'service':
      return serviceTemplate(resolved);
  }
}

// writeFileSet is re-exported at the top of this file via the named re-export.
// No additional reference needed here.
