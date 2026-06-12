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
 *   ScaffoldOpts               — input options type
 *   ActiveType                 — union of 6 active extension types
 */

import { agentTemplate } from './templates/agent/index.js';
import { skillTemplate } from './templates/skill/index.js';
import { mcpServerTemplate } from './templates/mcp-server/index.js';
import { hookTemplate } from './templates/hook/index.js';
import { commandTemplate } from './templates/command/index.js';
import { bundleTemplate } from './templates/bundle/index.js';

export { writeFileSet } from './writer.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A FileSet is a map from relative path to file content.
 * Paths are relative to the extension root (e.g. "src/index.ts", "extension.json").
 * Immutable output of scaffold().
 */
export type FileSet = Readonly<Record<string, string>>;

/**
 * The 6 active extension types. 'prompt' is parked — no template, no generator.
 * [def:active-types] in _shared.md.
 */
export type ActiveType =
  | 'agent'
  | 'skill'
  | 'mcp-server'
  | 'hook'
  | 'command'
  | 'bundle';

export const ACTIVE_TYPES: ReadonlyArray<ActiveType> = [
  'agent',
  'skill',
  'mcp-server',
  'hook',
  'command',
  'bundle',
];

/** Options passed to scaffold(). All fields required; no interactive fallback in core. */
export interface ScaffoldOpts {
  /** One of the 6 active types. prompt is NOT accepted here. */
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

/** Internal resolved opts (title/description are always strings). */
export interface ResolvedOpts {
  type: ActiveType;
  id: string;
  title: string;
  description: string;
  author: string | undefined;
  keywords: string[] | undefined;
}

function resolveOpts(opts: ScaffoldOpts): ResolvedOpts {
  return {
    type: opts.type,
    id: opts.id,
    title: opts.title ?? opts.id,
    description: opts.description ?? `${opts.id} extension`,
    author: opts.author,
    keywords: opts.keywords,
  };
}

/**
 * scaffold(opts) → FileSet
 *
 * Generates a complete, born-conformant FileSet for the given extension type.
 * The returned FileSet validates against libs/manifest when the extension.json
 * is parsed.
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
  }
}

// writeFileSet is re-exported at the top of this file via the named re-export.
// No additional reference needed here.
