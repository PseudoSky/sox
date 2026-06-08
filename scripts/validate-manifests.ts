#!/usr/bin/env node
/**
 * validate-manifests.ts — enforce identity/dedup/secret invariants
 *
 * P0 scope (id-format + type/dir checks):
 *   1. id must match ^[a-z][a-z0-9-]*$
 *   2. id must NOT end with its type name
 *   3. type must equal the singular of the parent directory
 *   4. version in extension.json must equal version in package.json
 *
 * P2 scope adds (Section 4.5):
 *   5. Unique id per registry (three uniqueness invariants)
 *   6. ≤1 entry per id in any single scope's install[]
 *   7. Shadow-copy detection: same id MUST NOT exist as two separately-versioned
 *      installables (e.g. both a registry/npm source and a file:// source)
 *      — this is exactly the live sox-active/sox-cto-system 5-agent failure mode
 *   8. Cross-scope dup: warn when same id appears in a committed install list
 *      and a local path (different sources)
 *   9. Secret-in-config regex: block committed extensions.json whose config
 *      values are literal API-key-shaped strings instead of ${ENV} refs
 *
 * Contract (Section 4.5): reads extension.json under extensions/ + scope
 *   configs; exits 0/1 + diagnostics. Side effects: none — read-only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** G-A: lifecycle block sub-types */
interface LifecycleHealth {
  type?: 'stdio-ping' | 'socket' | 'command' | undefined;
  endpoint?: string | undefined;
  interval_ms?: number | undefined;
  timeout_ms?: number | undefined;
}

interface LifecycleBlock {
  background?: boolean | undefined;
  singleton?: boolean | undefined;
  health?: LifecycleHealth | undefined;
  stop_timeout_ms?: number | undefined;
}

/** G-B: bundle member entry */
interface BundleMember {
  id: string;
  version: string;
}

interface ExtensionManifest {
  $schema: string;
  id: string;
  version: string;
  type: string;
  title: string;
  description: string;
  compatibility: { host: string };
  license: string;
  entrypoint?: string | undefined;
  author?: string | undefined;
  order?: number | undefined;
  /** G-D: optional runtime contract. Absent => 'node' (back-compat). */
  runtime?: 'node' | 'stdio-any' | undefined;
  /** G-A: optional lifecycle block for host-supervised long-running extensions. */
  lifecycle?: LifecycleBlock | undefined;
  requires?: {
    tool_calling?: boolean | undefined;
    structured_output?: boolean | undefined;
    min_context_tokens?: number | undefined;
  } | undefined;
  /** G-B: bundle members. Required iff type=='bundle'. Orthogonal to 'dependencies'. */
  members?: BundleMember[] | undefined;
  [key: string]: unknown;
}

interface PackageJson {
  name: string;
  version: string;
  [key: string]: unknown;
}

interface InstallEntry {
  id: string;
  version?: string | undefined;
  enabled?: boolean | undefined;
  source?: string | undefined;
}

interface ScopeConfig {
  install?: InstallEntry[] | undefined;
  config?: Record<string, Record<string, unknown>> | undefined;
  enabled?: Record<string, boolean> | undefined;
  [key: string]: unknown;
}

export interface Diagnostic {
  path: string;
  message: string;
  severity: 'error' | 'warn';
}

const DIR_TO_TYPE: Record<string, string> = {
  agents: 'agent',
  skills: 'skill',
  'mcp-servers': 'mcp-server',
  prompts: 'prompt',
  hooks: 'hook',
  commands: 'command',
  // G-B: bundles are install-time-only; they expand to members and are never host-loaded.
  bundles: 'bundle',
};

const VALID_TYPES = new Set(['agent', 'skill', 'mcp-server', 'prompt', 'hook', 'command', 'bundle']);
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Regex patterns for detecting literal API keys (secret-in-config lint).
 * These are NOT ${ENV} refs and would be security issues if committed.
 * Patterns cover common AI provider key formats.
 */
const SECRET_PATTERNS: RegExp[] = [
  /^sk-[A-Za-z0-9\-_]{20,}$/,            // OpenAI sk-... key
  /^sk-ant-[A-Za-z0-9\-_]{20,}$/,        // Anthropic sk-ant-... key
  /^AIza[A-Za-z0-9\-_]{35,}$/,           // Google API key
  /^AKIA[A-Z0-9]{16}$/,                  // AWS Access Key ID
  /^ghp_[A-Za-z0-9]{36,}$/,             // GitHub Personal Access Token
  /^Bearer\s+[A-Za-z0-9\-_\.]+$/,        // Generic Bearer token
  /^[A-Za-z0-9\-_]{32,}$/,              // Generic long opaque token (catch-all, flagged with warn)
];

/**
 * Determine if a string value looks like a literal secret (not an ${ENV} ref).
 * Returns true if the value matches a known API-key pattern.
 */
function looksLikeSecret(value: string): boolean {
  // ${ENV_VAR} refs are allowed
  if (/^\$\{[A-Z0-9_]+\}$/.test(value)) return false;
  // 'ollama' sentinel is allowed
  if (value === 'ollama') return false;
  // Empty strings and short strings are fine
  if (value.length < 16) return false;

  // Check against specific known key patterns first (high confidence)
  const highConfidencePatterns = SECRET_PATTERNS.slice(0, -1);
  for (const pattern of highConfidencePatterns) {
    if (pattern.test(value)) return true;
  }

  // Check the catch-all (only if value looks like a random token)
  // We require it to not contain spaces and be clearly non-human-readable
  const catchAll = SECRET_PATTERNS[SECRET_PATTERNS.length - 1]!;
  if (catchAll.test(value) && !/\s/.test(value) && !/[a-z]{4}[A-Z]/.test(value)) {
    // Heuristic: if it's all base64-like chars and long, it's suspicious
    if (/^[A-Za-z0-9+/=\-_]{40,}$/.test(value)) return true;
  }

  return false;
}

/**
 * Recursively scan a config object for literal secret values.
 * Returns array of [fieldPath, value] pairs that look like secrets.
 */
function findSecretsInConfig(
  obj: Record<string, unknown>,
  prefix = '',
): Array<{ fieldPath: string; value: string }> {
  const found: Array<{ fieldPath: string; value: string }> = [];
  for (const [key, value] of Object.entries(obj)) {
    const fieldPath = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string' && looksLikeSecret(value)) {
      found.push({ fieldPath, value: value.slice(0, 8) + '...(redacted)' });
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      found.push(...findSecretsInConfig(value as Record<string, unknown>, fieldPath));
    }
  }
  return found;
}

function findExtensionDirs(root: string): string[] {
  const extensionsRoot = path.join(root, 'extensions');
  if (!fs.existsSync(extensionsRoot)) return [];

  const dirs: string[] = [];
  for (const typeDir of fs.readdirSync(extensionsRoot)) {
    const typePath = path.join(extensionsRoot, typeDir);
    if (!fs.statSync(typePath).isDirectory()) continue;
    if (!Object.keys(DIR_TO_TYPE).includes(typeDir)) continue;

    for (const extId of fs.readdirSync(typePath)) {
      const extPath = path.join(typePath, extId);
      if (!fs.statSync(extPath).isDirectory()) continue;
      const manifestPath = path.join(extPath, 'extension.json');
      if (fs.existsSync(manifestPath)) {
        dirs.push(extPath);
      }
    }
  }
  return dirs;
}

function validateSingleManifest(extDir: string): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const manifestPath = path.join(extDir, 'extension.json');
  const packagePath = path.join(extDir, 'package.json');

  let manifest: ExtensionManifest;
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    manifest = JSON.parse(raw) as ExtensionManifest;
  } catch (e) {
    diags.push({
      path: manifestPath,
      message: `Failed to parse extension.json: ${String(e)}`,
      severity: 'error',
    });
    return diags;
  }

  const { id, type, version, runtime, requires, lifecycle, members } = manifest;

  // Check 1: id format
  if (!ID_PATTERN.test(id)) {
    diags.push({
      path: manifestPath,
      message: `id "${id}" must match ^[a-z][a-z0-9-]*$ (got "${id}")`,
      severity: 'error',
    });
  }

  // Check 2: id must not end with type name (e.g. 'my-skill-skill' is redundant).
  // Exception: 'bundle' — naming a bundle with a '-bundle' suffix is intentional and
  // natural (e.g. 'sox-memory-bundle'). The rule is about tautological redundancy
  // (type 'skill' id 'my-analyzer-skill'), not descriptive suffixes for install-time-only types.
  if (type !== 'bundle' && (id.endsWith(`-${type}`) || id === type)) {
    diags.push({
      path: manifestPath,
      message: `id "${id}" must not end with its type name "${type}"`,
      severity: 'error',
    });
  }

  // Check 3: type must be valid
  if (!VALID_TYPES.has(type)) {
    diags.push({
      path: manifestPath,
      message: `type "${type}" is not in the closed enum [${Array.from(VALID_TYPES).join(', ')}]`,
      severity: 'error',
    });
  }

  // Check 4: type/dir match
  const typeDir = path.basename(path.dirname(extDir));
  const expectedType = DIR_TO_TYPE[typeDir];
  if (expectedType === undefined) {
    diags.push({
      path: manifestPath,
      message: `Unknown type directory "${typeDir}" — must be one of: ${Object.keys(DIR_TO_TYPE).join(', ')}`,
      severity: 'error',
    });
  } else if (type !== expectedType) {
    diags.push({
      path: manifestPath,
      message: `type "${type}" does not match parent directory "${typeDir}" (expected "${expectedType}")`,
      severity: 'error',
    });
  }

  // Check 5: version sync
  if (fs.existsSync(packagePath)) {
    let pkg: PackageJson;
    try {
      pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as PackageJson;
      if (pkg.version !== version) {
        diags.push({
          path: manifestPath,
          message: `version mismatch: extension.json="${version}" vs package.json="${pkg.version}"`,
          severity: 'error',
        });
      }
    } catch (e) {
      diags.push({
        path: packagePath,
        message: `Failed to parse package.json: ${String(e)}`,
        severity: 'error',
      });
    }
  } else {
    diags.push({ path: packagePath, message: 'package.json not found', severity: 'error' });
  }

  // Check 6 (G-D): runtime:'stdio-any' cannot declare provider capabilities.
  // Provider calls require the Node/TS provider abstraction; set runtime:'node' or drop the requires.
  if (runtime === 'stdio-any') {
    const providerFlags: string[] = [];
    if (requires?.structured_output === true) providerFlags.push('structured_output:true');
    if (requires?.tool_calling === true) providerFlags.push('tool_calling:true');
    if (providerFlags.length > 0) {
      diags.push({
        path: manifestPath,
        message:
          `runtime:'stdio-any' cannot declare provider capabilities (${providerFlags.join(', ')}) — ` +
          `provider calls require the Node/TS provider abstraction; set runtime:'node' or drop the requires.`,
        severity: 'error',
      });
    }
  }

  // Check 7 (G-A): lifecycle block — host-owned supervision for background extensions.
  // Rule 1: lifecycle is only valid for type in {mcp-server, agent}.
  // Rule 2: health.type in {socket, command} requires health.endpoint.
  // Absent lifecycle => v1 request/response behavior (no daemon) — fully back-compat.
  if (lifecycle !== undefined) {
    const lifecycleAllowedTypes = new Set(['mcp-server', 'agent']);
    if (!lifecycleAllowedTypes.has(type)) {
      diags.push({
        path: manifestPath,
        message:
          `lifecycle block is only meaningful for type in {mcp-server, agent} (got "${type}"). ` +
          `The lifecycle block formalizes host-owned supervision of long-running processes; ` +
          `types like command/hook/skill/prompt are request-response and must not declare lifecycle.`,
        severity: 'error',
      });
    }

    // Rule 2: health.endpoint is required when health.type is 'socket' or 'command'
    const health = lifecycle.health;
    if (health !== undefined) {
      const healthType = health.type ?? 'stdio-ping';
      if ((healthType === 'socket' || healthType === 'command') && health.endpoint === undefined) {
        diags.push({
          path: manifestPath,
          message:
            `lifecycle.health.endpoint is required when lifecycle.health.type is "${healthType}". ` +
            `Provide a socket path (for type:"socket") or command string (for type:"command").`,
          severity: 'error',
        });
      }
    }
  }

  // Check 8 (G-B): bundle-specific invariants.
  // A bundle is install-time-only: it expands to members at install time and is NEVER host-loaded.
  // It must have members, must NOT have an entrypoint, and members must be well-formed.
  if (type === 'bundle') {
    // Rule 1: bundle must have a non-empty members array
    if (!Array.isArray(members) || members.length === 0) {
      diags.push({
        path: manifestPath,
        message:
          `bundle "${id}" must declare a non-empty "members" array. ` +
          `A bundle is a named, independently-versioned set of extensions that the installer expands.`,
        severity: 'error',
      });
    }

    // Rule 2: bundle must NOT have an entrypoint (it has no runtime)
    if (manifest['entrypoint'] !== undefined) {
      diags.push({
        path: manifestPath,
        message:
          `bundle "${id}" must not declare "entrypoint" — a bundle has no runtime and is expanded ` +
          `away at install time before the host loader runs. Remove "entrypoint".`,
        severity: 'error',
      });
    }

    // Rule 3: validate each member entry
    if (Array.isArray(members) && members.length > 0) {
      const memberIds = new Set<string>();
      for (const member of members) {
        if (typeof member.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(member.id)) {
          diags.push({
            path: manifestPath,
            message:
              `bundle "${id}" has a member with invalid id "${String(member.id)}" — ` +
              `member ids must match ^[a-z][a-z0-9-]*$.`,
            severity: 'error',
          });
        } else if (member.id === id) {
          // Rule 4: no self-reference
          diags.push({
            path: manifestPath,
            message:
              `bundle "${id}" lists itself as a member — self-reference is not allowed. ` +
              `Remove the self-referencing member entry.`,
            severity: 'error',
          });
        } else if (memberIds.has(member.id)) {
          // Rule 5: no duplicate member ids
          diags.push({
            path: manifestPath,
            message:
              `bundle "${id}" has duplicate member id "${member.id}". ` +
              `Each member id must appear at most once in a bundle's members array.`,
            severity: 'error',
          });
        } else {
          memberIds.add(member.id);
        }

        if (typeof member.version !== 'string' || member.version.length === 0) {
          diags.push({
            path: manifestPath,
            message:
              `bundle "${id}" member "${String(member.id)}" must declare a "version" semver range (e.g. "^0.1.0").`,
            severity: 'error',
          });
        }
      }
    }
  }

  return diags;
}

/**
 * P2: Check three uniqueness invariants across all extension manifests.
 *   1. Unique id per registry (no two extensions with the same id)
 *   2. ≤1 entry per id in any single scope's install[]
 *   3. No shadow copies: same id MUST NOT exist as two separately-versioned
 *      installables from different sources.
 */
function checkUniquenessInvariants(
  manifests: Array<{ dir: string; manifest: ExtensionManifest }>,
): Diagnostic[] {
  const diags: Diagnostic[] = [];

  // Invariant 1: unique id per registry
  const idToDir = new Map<string, string>();
  for (const { dir, manifest } of manifests) {
    const existing = idToDir.get(manifest.id);
    if (existing !== undefined) {
      diags.push({
        path: dir,
        message:
          `Duplicate extension id "${manifest.id}": appears in both "${existing}" and "${dir}". ` +
          `Each id must be globally unique in the registry. (Section 4.5 invariant 1)`,
        severity: 'error',
      });
    } else {
      idToDir.set(manifest.id, dir);
    }
  }

  return diags;
}

/**
 * P2: Load and check all committed scope configs for:
 *   - ≤1 entry per id in any single scope's install[]
 *   - Shadow-copy detection: same id from two different sources
 *   - Secret-in-config regex (literal API keys in committed files)
 *
 * "Committed" configs: project scope (.extensions/extensions.json)
 * NOT user/local (those are not committed and may have secrets legitimately)
 */
function checkScopeConfigs(
  root: string,
  manifests: Array<{ dir: string; manifest: ExtensionManifest }>,
): Diagnostic[] {
  const diags: Diagnostic[] = [];

  // Committed config files to check (project scope only — user/local are gitignored)
  const committedConfigPaths = [
    path.join(root, '.extensions', 'extensions.json'),
    // Also check any test fixtures under scripts/
    ...findTestFixtures(root),
  ];

  for (const configPath of committedConfigPaths) {
    if (!fs.existsSync(configPath)) continue;

    let config: ScopeConfig;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ScopeConfig;
    } catch (_e) {
      continue; // Non-JSON files (e.g. fixtures with comments) are skipped
    }

    // Check: ≤1 entry per id in install[]
    if (config.install !== undefined) {
      const seenIds = new Map<string, number>();
      for (const entry of config.install) {
        const count = seenIds.get(entry.id) ?? 0;
        seenIds.set(entry.id, count + 1);
      }
      for (const [id, count] of seenIds) {
        if (count > 1) {
          diags.push({
            path: configPath,
            message:
              `Duplicate id "${id}" appears ${count} times in install[] of the same scope. ` +
              `Each id may appear at most once per scope. (Section 4.5 invariant 2)`,
            severity: 'error',
          });
        }
      }
    }

    // Check: secret-in-config regex
    if (config.config !== undefined) {
      for (const [extId, extConfig] of Object.entries(config.config)) {
        const secrets = findSecretsInConfig(extConfig);
        for (const { fieldPath, value } of secrets) {
          diags.push({
            path: configPath,
            message:
              `Potential literal secret at config["${extId}"].${fieldPath}: "${value}". ` +
              `Use \${ENV_VAR} references instead of literal secrets in committed configs. ` +
              `(Section 4.5 secret-in-config check)`,
            severity: 'error',
          });
        }
      }
    }
  }

  // Check shadow copies: same id from two different sources across all scope configs
  const idToSources = new Map<string, Set<string>>();
  const registryIds = new Set(manifests.map((m) => m.manifest.id));

  // Check all install[] entries across committed configs
  for (const configPath of committedConfigPaths) {
    if (!fs.existsSync(configPath)) continue;
    let config: ScopeConfig;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ScopeConfig;
    } catch (_e) {
      continue;
    }

    if (config.install !== undefined) {
      for (const entry of config.install) {
        if (!idToSources.has(entry.id)) {
          idToSources.set(entry.id, new Set());
        }
        const source = entry.source ?? (registryIds.has(entry.id) ? 'registry' : 'unknown');
        idToSources.get(entry.id)!.add(source);
      }
    }
  }

  // A shadow copy is when the SAME id has entries from two distinct source TYPES
  // (e.g. one from 'registry' and one from 'file://') in different configs
  for (const [id, sources] of idToSources) {
    if (sources.size > 1) {
      const sourceList = Array.from(sources).join(', ');
      diags.push({
        path: root,
        message:
          `Shadow copy detected for extension "${id}": appears with multiple sources [${sourceList}]. ` +
          `An extension id MUST NOT exist as two separately-versioned installables. ` +
          `This is the sox-active/sox-cto-system 5-agent failure mode — designate one source as canonical. ` +
          `(Section 4.5 invariant 3 — shadow copy)`,
        severity: 'error',
      });
    }
  }

  return diags;
}

/**
 * Find test fixture files that look like extensions.json for validation.
 * We validate these specially (fixture paths ending in .fixtures.json etc.)
 */
function findTestFixtures(root: string): string[] {
  const fixturesDir = path.join(root, 'scripts', '__fixtures__');
  if (!fs.existsSync(fixturesDir)) return [];
  const files: string[] = [];
  for (const f of fs.readdirSync(fixturesDir)) {
    if (f.endsWith('.json') && f.includes('scope')) {
      files.push(path.join(fixturesDir, f));
    }
  }
  return files;
}

export function validateManifests(root: string): { ok: boolean; errors: Diagnostic[] } {
  const extDirs = findExtensionDirs(root);
  const allErrors: Diagnostic[] = [];

  if (extDirs.length === 0) {
    console.log('No extensions found — nothing to validate.');
    return { ok: true, errors: [] };
  }

  // Collect all manifests
  const manifests: Array<{ dir: string; manifest: ExtensionManifest }> = [];

  for (const extDir of extDirs) {
    const diags = validateSingleManifest(extDir);
    allErrors.push(...diags);

    // If basic manifest parsing succeeded, collect it for cross-checks
    const manifestPath = path.join(extDir, 'extension.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ExtensionManifest;
      manifests.push({ dir: extDir, manifest });
    } catch (_e) {
      // Already reported above
    }
  }

  // P2: Cross-extension uniqueness checks
  const uniquenessErrors = checkUniquenessInvariants(manifests);
  allErrors.push(...uniquenessErrors);

  // P2: Scope config checks (dedup + secret-in-config)
  const scopeErrors = checkScopeConfigs(root, manifests);
  allErrors.push(...scopeErrors);

  const errors = allErrors.filter((d) => d.severity === 'error');

  return { ok: errors.length === 0, errors: allErrors };
}

// CLI entry point — only runs when invoked directly, not when imported
if (!process.env['VITEST']) {
  const root = process.argv[2] ?? process.cwd();
  const result = validateManifests(root);

  const errors = result.errors.filter((d) => d.severity === 'error');
  const warnings = result.errors.filter((d) => d.severity === 'warn');

  if (warnings.length > 0) {
    for (const w of warnings) {
      console.warn(`  [WARN]  ${w.path}: ${w.message}`);
    }
  }

  if (errors.length > 0) {
    console.error('validate-manifests: FAILED');
    for (const err of errors) {
      console.error(`  [ERROR] ${err.path}: ${err.message}`);
    }
    process.exit(1);
  } else {
    const extCount = findExtensionDirs(root).length;
    console.log(
      `validate-manifests: OK (${extCount} extension(s) validated` +
        (warnings.length > 0 ? `, ${warnings.length} warning(s)` : '') +
        `)`,
    );
    process.exit(0);
  }
}
