/**
 * libs/host-registry/src/skill-renderers.ts
 *
 * Host-agnostic skill header renderer — the skill half of the "author once,
 * install everywhere" contract (docs/spec/cross-platform-install-rendering.md).
 *
 * Agents render their header from extension.json through yamlStringify
 * (agent-renderers.ts), so quoting is safe and a malformed value cannot produce
 * invalid YAML. Skills previously had no renderer at all — the install engine
 * copied SKILL.md verbatim, so a hand-written frontmatter was the header the
 * host actually surfaced and it could silently diverge from (or, worse, be
 * unparseable against) the manifest description (bug aace3faa: the 1ceffdbf
 * colon-in-scalar drop made dispatch-plan invisible to every agent). This
 * module makes the manifest the single source of truth: the header is derived
 * from extension.json, and SKILL.md becomes prose-only.
 */

import { stripFrontmatter, yamlStringify } from './serialize.js';

/** Header keys a skill renderer may emit. `name` is always present. */
export const SKILL_ALLOWED_KEYS = [
  'name',
  'description',
  'license',
  'allowed-tools',
  'metadata',
] as const;

/** Header fields derived from a skill manifest. */
export interface SkillHeaderInput {
  id: string;
  description: string;
  license?: string;
  allowedTools?: string[];
  metadata?: Record<string, unknown>;
}

/** Loose manifest shape — id/description may be absent or of the wrong type. */
export interface SkillManifestLike {
  id?: unknown;
  description?: unknown;
  license?: unknown;
  allowedTools?: unknown;
  'allowed-tools'?: unknown;
  metadata?: unknown;
  source?: unknown;
  sourceVersion?: unknown;
}

/**
 * Coerce a skill manifest into header inputs, or null when id/description are
 * unusable (a skill with no renderable name/description is a passthrough, not
 * an error — the install engine copies the source verbatim in that case).
 *
 * Folds the manifest's `source`/`sourceVersion` provenance into `metadata` as
 * `{ source, 'source-version' }`, mirroring how those keys used to ride in the
 * SKILL.md frontmatter (harvested skills only).
 */
export function skillManifestToInput(manifest: SkillManifestLike): SkillHeaderInput | null {
  const id = manifest.id;
  const description = manifest.description;
  if (typeof id !== 'string' || id.trim() === '') return null;
  if (typeof description !== 'string' || description.trim() === '') return null;

  const license =
    typeof manifest.license === 'string' && manifest.license !== '' ? manifest.license : undefined;

  const rawAllowed = manifest.allowedTools ?? manifest['allowed-tools'];
  const allowedTools = Array.isArray(rawAllowed)
    ? rawAllowed.filter((t): t is string => typeof t === 'string')
    : undefined;

  const metadata: Record<string, unknown> = {};
  const meta = manifest.metadata;
  if (meta !== null && typeof meta === 'object' && !Array.isArray(meta)) {
    Object.assign(metadata, meta as Record<string, unknown>);
  }
  if (typeof manifest.source === 'string' && manifest.source !== '') {
    metadata['source'] = manifest.source;
  }
  if (typeof manifest.sourceVersion === 'string' && manifest.sourceVersion !== '') {
    metadata['source-version'] = manifest.sourceVersion;
  }

  return {
    id,
    description,
    ...(license !== undefined ? { license } : {}),
    ...(allowedTools !== undefined && allowedTools.length > 0 ? { allowedTools } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

/** Render the header map (name == id, then optional keys) — no fences. */
export function renderSkillHeader(input: SkillHeaderInput): Record<string, unknown> {
  const header: Record<string, unknown> = {
    name: input.id,
    description: input.description,
  };
  if (input.license !== undefined) header['license'] = input.license;
  if (input.allowedTools !== undefined && input.allowedTools.length > 0) {
    header['allowed-tools'] = input.allowedTools;
  }
  if (input.metadata !== undefined && Object.keys(input.metadata).length > 0) {
    header['metadata'] = input.metadata;
  }
  return header;
}

/**
 * Render a full SKILL.md: rendered header + prose body. The body is the source
 * prose with any leading frontmatter fence stripped — so a skill whose source
 * still carries a hand-written frontmatter yields exactly one (generated) header.
 * Returns null when the manifest has no usable id/description.
 */
export function renderSkillFile(
  manifest: SkillManifestLike,
  prose: string,
): { kind: 'file-body'; content: string } | null {
  const input = skillManifestToInput(manifest);
  if (input === null) return null;
  const header = yamlStringify(renderSkillHeader(input));
  const body = stripFrontmatter(prose);
  const content = `---\n${header}\n---\n${body}`;
  return { kind: 'file-body', content: content.endsWith('\n') ? content : content + '\n' };
}
