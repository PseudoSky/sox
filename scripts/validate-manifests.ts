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
 * P2 (framework-contract-completion) adds per-type self-description checks (optional-first):
 *  11. hook: events[] array with closed enum of valid host lifecycle event names (Gap F1/A1)
 *  12. agent/command: invocation protocol + handler interface declaration
 *  13. mcp-server: tools[] descriptors at rest in the manifest
 *  14. prompt: parameters[] + template_engine declaration
 *  15. skill: run_interface (input/output schema)
 *  16. dependencies: declared runtime deps enforced (id existence check — Gap F2)
 * All P2 checks are severity:'warn' in this phase (OPTIONAL-FIRST). P3 flips them to 'error'.
 *
 * P4 scope adds DX-conformance advisory rules (fail-open by default; fail-closed under --strict):
 *  10. description must be non-empty and invocation-guidance-shaped (starts with action verb)
 *  11. keywords must be present (non-empty array)
 *  12. author must be set (non-empty string)
 *  13. README.md must exist and contain non-placeholder content (>100 chars, no pure lorem)
 *
 * Contract (Section 4.5): reads extension.json under extensions/ + scope
 *   configs; exits 0/1 + diagnostics. Side effects: none — read-only.
 *
 * Enforcement posture (§5.2):
 *   default mode   — advisory rules emit severity:'warn', exit 0 (fail-open)
 *   --strict mode  — advisory rules emit severity:'error', exit non-zero (fail-closed)
 *   Wrong-type / missing-required fields always emit severity:'error' in both modes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Ajv } from 'ajv';
// [ref:manifest-single-source] — delegate structural validation to libs/manifest
import { validate as libsValidate } from '@sox/manifest';

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

/** P2: Runtime dependency entry (matches schema: {id, version} objects) */
interface DependencyEntry {
  id: string;
  version: string;
}

/**
 * P2: Valid host lifecycle event names — closed enum seeded from current hook usage.
 * audit-hook binds: PreToolUse
 * memory-flush binds: SessionEnd, ScopePromotionProposed
 */
const VALID_HOOK_EVENTS = new Set<string>([
  'PreToolUse',
  'PostToolUse',
  'SessionEnd',
  'ScopePromotionProposed',
  'Stop',
]);

/** P2: Tool descriptor shape for mcp-server self-description */
interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown> | undefined;
}

/** P2: Invocation declaration for agent/command self-description */
interface InvocationDeclaration {
  protocol?: 'function-export' | 'stdio' | 'ipc' | 'http' | undefined;
  handler?: string | undefined;
  input_schema?: Record<string, unknown> | undefined;
  output_schema?: Record<string, unknown> | undefined;
}

/** P2: Parameter declaration for prompt self-description */
interface ParameterDeclaration {
  name: string;
  type?: 'string' | 'number' | 'boolean' | 'array' | 'object' | undefined;
  required?: boolean | undefined;
  description?: string | undefined;
}

/** P2: Run interface descriptor for skill self-description */
interface RunInterface {
  input_schema?: Record<string, unknown> | undefined;
  output_schema?: Record<string, unknown> | undefined;
}

/** G-E: capability-declaration granularity — requires block shape */
interface RequiresBlock {
  tool_calling?: boolean | undefined;
  structured_output?: boolean | undefined;
  min_context_tokens?: number | undefined;
}

/**
 * PB: Resource/permission declaration blocks.
 * Ships the DECLARATION; enforcement (sandboxing) is wired by P4/P5.
 */
interface FsPermissions {
  read?: string[] | undefined;
  write?: string[] | undefined;
}

interface NetworkPermissions {
  outbound?: string[] | undefined;
}

interface SocketPermissions {
  paths?: string[] | undefined;
}

interface PermissionsBlock {
  fs?: FsPermissions | undefined;
  network?: NetworkPermissions | undefined;
  socket?: SocketPermissions | undefined;
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
  requires?: RequiresBlock | undefined;
  /**
   * Runtime dependencies: extension ids + semver ranges this extension requires.
   * Each entry is {id, version}. Enforced at install time (Gap F2 — P2 wires existence check).
   */
  dependencies?: DependencyEntry[] | undefined;
  /** G-B: bundle members. Required iff type=='bundle'. Orthogonal to 'dependencies'. */
  members?: BundleMember[] | undefined;
  /**
   * P2 — HOOK self-description. Lifecycle events this hook binds to (closed enum).
   * OPTIONAL-FIRST in P2 (warn when absent). P3 flips to required.
   */
  events?: string[] | undefined;
  /**
   * P2 — AGENT/COMMAND self-description. Invocation protocol + handler interface.
   * OPTIONAL-FIRST in P2 (warn when absent). P3 flips to required.
   */
  invocation?: InvocationDeclaration | undefined;
  /**
   * P2 — MCP-SERVER self-description. Tool descriptors at rest in the manifest.
   * OPTIONAL-FIRST in P2 (warn when absent). P3 flips to required.
   */
  tools?: ToolDescriptor[] | undefined;
  /**
   * P2 — PROMPT self-description. Template parameter declarations.
   * OPTIONAL-FIRST in P2 (warn when absent). P3 flips to required.
   */
  parameters?: ParameterDeclaration[] | undefined;
  /**
   * P2 — PROMPT self-description. Template engine declaration.
   * OPTIONAL-FIRST in P2 (warn when absent). P3 flips to required.
   */
  template_engine?: string | undefined;
  /**
   * P2 — SKILL self-description. run() function input/output schema.
   * OPTIONAL-FIRST in P2 (warn when absent). P3 flips to required.
   */
  run_interface?: RunInterface | undefined;
  /**
   * PB: JSON Schema (draft-07 subset) for the scope-resolved config block.
   * The installer validates the resolved config against this schema before activation.
   * OPTIONAL — absent means the extension accepts any config object.
   * ENFORCEMENT NOTE for P4/P5: wire install-time validation of scope-resolved config.
   */
  config_schema?: Record<string, unknown> | undefined;
  /**
   * PB: Resource/permission declaration (fs/network/socket).
   * OPTIONAL — absent means no declared resource bounds (legacy behaviour preserved).
   * ENFORCEMENT NOTE for P4/P5: the host runtime must honour these bounds (Gap F5/A6).
   */
  permissions?: PermissionsBlock | undefined;
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

// Note: VALID_TYPES and ID_PATTERN checks are delegated to libs/manifest validate()
// ([ref:manifest-single-source]). Only VALID_HOOK_EVENTS is kept here for P3 enum validation
// (which is not part of libs/manifest's validate() surface — P3 is validate-manifests specific).

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
/**
 * G-E: Deep-equality check for two `requires` blocks.
 * Used to detect redundant capability declarations when an extension spawns another.
 */
function requiresDeepEqual(
  a: RequiresBlock | undefined,
  b: RequiresBlock | undefined,
): boolean {
  // Both absent — trivially equal (but also trivially non-informative; caller guards this)
  if (a === undefined && b === undefined) return true;
  // One absent, one present — not equal
  if (a === undefined || b === undefined) return false;
  return (
    (a.tool_calling ?? false) === (b.tool_calling ?? false) &&
    (a.structured_output ?? false) === (b.structured_output ?? false) &&
    (a.min_context_tokens ?? 0) === (b.min_context_tokens ?? 0)
  );
}

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

/**
 * PB (Check 9): Validate a scope-resolved config object against a manifest's
 * declared config_schema using AJV (reusing the existing AJV machinery — see
 * schemas/extension/v1.json). Returns validation errors, or an empty array if
 * the config is valid (or no schema is declared).
 *
 * ENFORCEMENT NOTE for P4/P5: this function is called at install time once the
 * host resolves the scope-cascade config for an extension. The host must pass
 * the resolved config here before activating the extension (closes Gap F3).
 * The declared permissions block (Gap F5/A6) is NOT enforced here — it is
 * declared so P4/P5 can wire runtime sandboxing.
 */
function validateConfigAgainstSchema(
  resolvedConfig: Record<string, unknown>,
  configSchema: Record<string, unknown>,
  extId: string,
  manifestPath: string,
): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const ajv = new Ajv({ allErrors: true, strict: false });
  let validate: ReturnType<typeof ajv.compile>;
  try {
    validate = ajv.compile(configSchema);
  } catch (e) {
    diags.push({
      path: manifestPath,
      message:
        `PB: extension "${extId}" declared an invalid config_schema (AJV compile error): ${String(e)}. ` +
        `Ensure config_schema is a valid JSON Schema (draft-07 subset).`,
      severity: 'error',
    });
    return diags;
  }

  const valid = validate(resolvedConfig);
  if (!valid && validate.errors) {
    for (const err of validate.errors) {
      diags.push({
        path: manifestPath,
        message:
          `PB: extension "${extId}" config violates its declared config_schema: ` +
          `[${err.instancePath || '/'}] ${err.message ?? 'unknown error'}. ` +
          `Fix the config or update the schema. (Gap F3 — install-time config validation)`,
        severity: 'error',
      });
    }
  }
  return diags;
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

      // R9: also scan bundle members/ subdirectory so co-located member extensions
      // are validated and included in the knownIds set for member-existence checks.
      if (typeDir === 'bundles') {
        const membersPath = path.join(extPath, 'members');
        if (fs.existsSync(membersPath) && fs.statSync(membersPath).isDirectory()) {
          for (const memberId of fs.readdirSync(membersPath)) {
            const memberPath = path.join(membersPath, memberId);
            if (!fs.statSync(memberPath).isDirectory()) continue;
            const memberManifestPath = path.join(memberPath, 'extension.json');
            if (fs.existsSync(memberManifestPath)) {
              dirs.push(memberPath);
            }
          }
        }
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
  let rawManifest: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    rawManifest = JSON.parse(raw) as Record<string, unknown>;
    manifest = rawManifest as ExtensionManifest;
  } catch (e) {
    diags.push({
      path: manifestPath,
      message: `Failed to parse extension.json: ${String(e)}`,
      severity: 'error',
    });
    return diags;
  }

  // [ref:manifest-single-source] Delegate structural schema validation to libs/manifest.
  // Covers: id format, type enum, runtime enum, id-must-not-end-with-type,
  // runtime:stdio-any+provider constraint, lifecycle block rules, bundle member rules,
  // permissions structural, entrypoint string format.
  //
  // Note: libs/manifest treats `description: ''` as a structural error, but validate-manifests
  // handles empty description at the DX advisory layer (checkDxConformance, severity:'warn').
  // Filter that specific error here so the DX layer has sole authority over description quality.
  const libsResult = libsValidate(rawManifest);
  for (const msg of libsResult.errors) {
    if (msg === 'description must be a non-empty string') continue; // handled by DX layer
    diags.push({ path: manifestPath, message: msg, severity: 'error' });
  }

  const {
    id, type, config_schema,
    events, invocation, tools, parameters, template_engine, run_interface,
  } = manifest;

  // Check 4: type/dir match (validate-manifests specific — not in libs/manifest)
  // R9: member extensions are co-located at extensions/bundles/<bundle>/members/<id>/
  // Their parent dir is "members", not a type dir. Skip the type/dir match for them.
  const typeDir = path.basename(path.dirname(extDir));
  const isBundleMember = typeDir === 'members';
  if (!isBundleMember) {
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
  }

  // Check 5: ADR-0003 RETIRED the extension.json↔package.json version sync check.
  // `version` is no longer an authored field in extension.json (identity is
  // id + content checksum), so there is no second number to disagree with — the
  // entire BL-30 dual-write failure class is structurally impossible. We still
  // confirm package.json exists (it carries the derived display version + build
  // metadata) and parses, but we DO NOT compare versions.
  if (fs.existsSync(packagePath)) {
    try {
      JSON.parse(fs.readFileSync(packagePath, 'utf8'));
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

  // Checks 6 (G-D runtime:stdio-any), 7 (G-A lifecycle), and 10 (PB permissions)
  // are delegated to libsValidate() above ([ref:manifest-single-source]).

  // Check 9 (PB): config_schema structural validation.
  // If the manifest declares a config_schema, it must be a non-null object (a JSON Schema fragment).
  // Scope-resolved config validation against the declared schema is performed by the installer at
  // install time (validateConfigAgainstSchema); here we only check the schema declaration itself.
  // ENFORCEMENT NOTE for P4/P5: wire validateConfigAgainstSchema at install time (closes Gap F3).
  if (config_schema !== undefined) {
    if (typeof config_schema !== 'object' || config_schema === null || Array.isArray(config_schema)) {
      diags.push({
        path: manifestPath,
        message:
          `PB: extension "${id}" config_schema must be a JSON Schema object (got ${Array.isArray(config_schema) ? 'array' : typeof config_schema}). ` +
          `Provide a valid JSON Schema fragment (e.g. { "type": "object", "properties": { ... } }).`,
        severity: 'error',
      });
    } else {
      // Verify AJV can compile it — catches structural JSON Schema errors early
      const ajv = new Ajv({ allErrors: true, strict: false });
      try {
        ajv.compile(config_schema as Record<string, unknown>);
      } catch (e) {
        diags.push({
          path: manifestPath,
          message:
            `PB: extension "${id}" config_schema is not a valid JSON Schema (AJV compile error): ${String(e)}. ` +
            `Ensure config_schema is a valid JSON Schema (draft-07 subset).`,
          severity: 'error',
        });
      }
    }
  }

  // Check 10 (PB permissions) and Check 8 (G-B bundle structural) are delegated
  // to libsValidate() above ([ref:manifest-single-source]).

  // P3: Per-type self-description checks — REQUIRED (error). Flipped from P2 warn-only after
  // all 11 manifests were retrofitted. A manifest of a given type MUST declare its contract.

  // Check P3-hook: events[] array with closed-enum validation
  if (type === 'hook') {
    if (events === undefined || !Array.isArray(events) || events.length === 0) {
      diags.push({
        path: manifestPath,
        message:
          `P3: hook "${id}" has no "events" field. Declare which lifecycle events this hook binds ` +
          `(e.g. "events": ["PreToolUse"]). Valid events: ${Array.from(VALID_HOOK_EVENTS).join(', ')}.`,
        severity: 'error',
      });
    } else {
      // Validate each event against the closed enum
      for (const evt of events) {
        if (!VALID_HOOK_EVENTS.has(evt as string)) {
          diags.push({
            path: manifestPath,
            message:
              `P3: hook "${id}" declares unknown event "${String(evt)}". ` +
              `Valid host lifecycle events are: ${Array.from(VALID_HOOK_EVENTS).join(', ')}. ` +
              `(Add the event to the registry if it is a new host event)`,
            severity: 'error',
          });
        }
      }
    }
  }

  // Check P3-agent/command: invocation protocol + handler interface
  if (type === 'agent' || type === 'command') {
    if (invocation === undefined) {
      diags.push({
        path: manifestPath,
        message:
          `P3: ${type} "${id}" has no "invocation" field. Declare the invocation protocol and ` +
          `handler name (e.g. "invocation": {"protocol": "function-export", "handler": "run"}).`,
        severity: 'error',
      });
    } else if (typeof invocation !== 'object' || invocation === null || Array.isArray(invocation)) {
      diags.push({
        path: manifestPath,
        message:
          `P3: ${type} "${id}" has an "invocation" field that is not an object ` +
          `(got ${Array.isArray(invocation) ? 'array' : typeof invocation}). ` +
          `Expected: {"protocol": "function-export"|"stdio"|"ipc"|"http", "handler": "<exportName>"}`,
        severity: 'error',
      });
    }
  }

  // Check P3-mcp: tools[] descriptors at rest
  if (type === 'mcp-server') {
    if (tools === undefined || !Array.isArray(tools) || tools.length === 0) {
      diags.push({
        path: manifestPath,
        message:
          `P3: mcp-server "${id}" has no "tools" field. Declare the tools this server exposes ` +
          `(e.g. "tools": [{"name": "memory_write", "description": "use this when …"}]). ` +
          `Enables static capability discovery without spawning the server.`,
        severity: 'error',
      });
    } else {
      // Validate each tool descriptor has required name + description
      for (const tool of tools) {
        if (typeof (tool as ToolDescriptor).name !== 'string' || (tool as ToolDescriptor).name.length === 0) {
          diags.push({
            path: manifestPath,
            message:
              `P3: mcp-server "${id}" has a tool descriptor missing a "name" field. ` +
              `Each tool must have at minimum: {"name": "<string>", "description": "<string>"}.`,
            severity: 'error',
          });
        }
        if (typeof (tool as ToolDescriptor).description !== 'string' || (tool as ToolDescriptor).description.length === 0) {
          diags.push({
            path: manifestPath,
            message:
              `P3: mcp-server "${id}" has a tool descriptor missing a "description" field. ` +
              `Each tool must have at minimum: {"name": "<string>", "description": "<string>"}.`,
            severity: 'error',
          });
        }
      }
    }
  }

  // Check P3-prompt: parameters[] + template_engine
  if (type === 'prompt') {
    if (parameters === undefined || !Array.isArray(parameters) || parameters.length === 0) {
      diags.push({
        path: manifestPath,
        message:
          `P3: prompt "${id}" has no "parameters" field. Declare the template parameters ` +
          `(e.g. "parameters": [{"name": "context", "type": "string", "required": true, "description": "…"}]). ` +
          `Enables hosts to validate parameter completeness before rendering.`,
        severity: 'error',
      });
    } else {
      // Validate each parameter has a name
      for (const param of parameters) {
        if (typeof (param as ParameterDeclaration).name !== 'string' || (param as ParameterDeclaration).name.length === 0) {
          diags.push({
            path: manifestPath,
            message:
              `P3: prompt "${id}" has a parameter declaration missing a "name" field. ` +
              `Each parameter must have at minimum: {"name": "<string>"}.`,
            severity: 'error',
          });
        }
      }
    }
    if (template_engine === undefined) {
      diags.push({
        path: manifestPath,
        message:
          `P3: prompt "${id}" has no "template_engine" field. Declare the substitution engine ` +
          `(one of: "handlebars", "jinja2", "mustache", "simple", "none"). ` +
          `Enables hosts to render the template without guessing the syntax.`,
        severity: 'error',
      });
    }
  }

  // Check P3-skill: run_interface (input/output schema)
  if (type === 'skill') {
    if (run_interface === undefined) {
      diags.push({
        path: manifestPath,
        message:
          `P3: skill "${id}" has no "run_interface" field. Declare the run() input/output schema ` +
          `(e.g. "run_interface": {"input_schema": {…}, "output_schema": {…}}). ` +
          `Enables orchestrators to validate skill invocation at rest.`,
        severity: 'error',
      });
    } else if (typeof run_interface !== 'object' || run_interface === null || Array.isArray(run_interface)) {
      diags.push({
        path: manifestPath,
        message:
          `P3: skill "${id}" "run_interface" must be an object ` +
          `(got ${Array.isArray(run_interface) ? 'array' : typeof run_interface}).`,
        severity: 'error',
      });
    }
  }

  // P0 entrypoint-reachability gate.
  // For every non-bundle manifest that declares an `entrypoint`, assert the resolved
  // built path exists on disk. This is the framework-owned build contract: `pnpm -r build`
  // must have run before validation so that each package's compiler output is present.
  // The string-format check is delegated to libsValidate() ([ref:manifest-single-source]).
  // Severity: error — a declared entrypoint that does not exist post-build means the
  // extension cannot be loaded by the host runtime.
  const entrypointRaw = manifest['entrypoint'];
  if (type !== 'bundle' && typeof entrypointRaw === 'string' && entrypointRaw.trim() !== '') {
    const resolvedEntrypoint = path.resolve(extDir, entrypointRaw);
    if (!fs.existsSync(resolvedEntrypoint)) {
      diags.push({
        path: manifestPath,
        message:
          `entrypoint "${entrypointRaw}" resolves to "${resolvedEntrypoint}" which does not exist. ` +
          `Run "pnpm -r build" to compile extension packages before validating. ` +
          `(P0 entrypoint-reachability gate)`,
        severity: 'error',
      });
    }
  }

  return diags;
}

/**
 * G-E (P10): Advisory check — warn when extension X declares `requires` identical to
 * a dependency D's `requires`. This is redundant but safe: both may independently
 * install and must carry their own truth. The warn is NEVER an error (CI-non-blocking).
 *
 * Detection: for any extension X with dependencies:[D] where X.requires deep-equals
 * D.requires, emit the warn. (~25 LOC per architecture-v2.md §G-E.)
 *
 * Rule: extension A spawning extension B may both declare provider requires. Redundancy
 * is acceptable and is the safe default; keep it if the extension is installable standalone.
 */
function checkRequiresRedundancy(
  manifests: Array<{ dir: string; manifest: ExtensionManifest }>,
): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const idToManifest = new Map<string, ExtensionManifest>();
  for (const { manifest } of manifests) {
    idToManifest.set(manifest.id, manifest);
  }

  for (const { dir, manifest } of manifests) {
    const { id, requires, dependencies } = manifest;
    // Only check when X has a non-trivial requires block and at least one dependency
    if (!Array.isArray(dependencies) || dependencies.length === 0) continue;
    if (requires === undefined) continue;
    // Skip if requires is entirely empty / all-false — not informative to warn
    const hasAnyRequires =
      requires.tool_calling === true ||
      requires.structured_output === true ||
      (requires.min_context_tokens !== undefined && requires.min_context_tokens > 0);
    if (!hasAnyRequires) continue;

    for (const depEntry of dependencies) {
      // Support both {id, version} object (current schema) and legacy string form
      const depId = typeof depEntry === 'string' ? depEntry : (depEntry as DependencyEntry).id;
      const dep = idToManifest.get(depId);
      if (dep === undefined) continue; // dep not in registry — skip
      if (!requiresDeepEqual(requires, dep.requires)) continue;

      // Emit the advisory (warn, never error — architecture-v2.md §G-E)
      const manifestPath = `${dir}/extension.json`;
      diags.push({
        path: manifestPath,
        message:
          `extension "${id}" declares requires identical to its dependency "${depId}"; ` +
          `this is redundant but safe. Keep it if "${id}" is installable standalone; ` +
          `otherwise it may be dropped. (G-E advisory)`,
        severity: 'warn',
      });
    }
  }

  return diags;
}

/**
 * P2 Gap F2: Wire dependencies enforcement — every id declared in an extension's
 * dependencies[] must resolve to an extension that exists in the registry.
 * A declared dependency that does not exist is a silent runtime failure today.
 * This cross-extension check gates it at validation time.
 *
 * Severity: warn in P2 (OPTIONAL-FIRST). P3 may flip to error once all manifests are retrofitted.
 */
function checkDependencyExistence(
  manifests: Array<{ dir: string; manifest: ExtensionManifest }>,
): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const knownIds = new Set<string>(manifests.map(({ manifest }) => manifest.id));

  for (const { dir, manifest } of manifests) {
    const { id, dependencies } = manifest;
    if (!Array.isArray(dependencies) || dependencies.length === 0) continue;

    const manifestPath = `${dir}/extension.json`;
    for (const dep of dependencies) {
      // Handle both legacy string[] (if any) and correct {id, version} form
      const depId = typeof dep === 'string' ? dep : (dep as DependencyEntry).id;
      if (typeof depId !== 'string' || depId.length === 0) continue;

      if (!knownIds.has(depId)) {
        diags.push({
          path: manifestPath,
          message:
            `P2 (Gap F2): extension "${id}" declares dependency "${depId}" which does not exist in ` +
            `the registry (no extension.json found with id "${depId}" under extensions/). ` +
            `Add the dependency extension to the monorepo or remove the stale dependency entry. ` +
            `(P2 dependencies enforcement — was declared but never consumed before P2)`,
          severity: 'warn',
        });
      }
    }
  }

  return diags;
}

/**
 * PC Check 8 (member-existence): every id declared in a bundle's members[] must resolve
 * to an extension that exists in the registry (has its own extension.json in extensions/).
 * A bundle referencing a non-existent member id is a silent install-time failure today
 * (expandBundles silently skips it). This cross-extension check gates it at validation time.
 *
 * Scope: bundle-specific, additive to existing Check 8 per-manifest rules. No all-11 change.
 */
function checkBundleMemberExistence(
  manifests: Array<{ dir: string; manifest: ExtensionManifest }>,
): Diagnostic[] {
  const diags: Diagnostic[] = [];

  // Build set of all known extension ids (non-bundle extensions are valid member targets;
  // bundles-of-bundles are also allowed as long as the bundle id itself exists)
  const knownIds = new Set<string>(manifests.map(({ manifest }) => manifest.id));

  for (const { dir, manifest } of manifests) {
    if (manifest.type !== 'bundle') continue;
    const { id, members } = manifest;
    if (!Array.isArray(members) || members.length === 0) continue; // already caught by per-manifest Check 8

    const manifestPath = `${dir}/extension.json`;
    for (const member of members) {
      if (typeof member.id !== 'string' || member.id.length === 0) continue; // invalid id already caught
      if (!knownIds.has(member.id)) {
        diags.push({
          path: manifestPath,
          message:
            `bundle "${id}" declares member "${member.id}" which does not exist in the registry ` +
            `(no extension.json found with id "${member.id}" under extensions/). ` +
            `Add the member extension to the monorepo or remove the stale member entry. ` +
            `(PC Check 8 — member-existence)`,
          severity: 'error',
        });
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

/**
 * P4: Options controlling validate behaviour.
 *   strict — promote advisory warnings to errors (fail-closed). Default: false (fail-open).
 */
export interface ValidateOptions {
  strict?: boolean;
}

/**
 * P4: Advisory DX-conformance rules (§5.2/§5.3).
 *
 * Four checks per extension directory:
 *   (a) description is non-empty and invocation-guidance-shaped (starts with a recognised
 *       action verb or "use this when" — the model the scaffolder enforces).
 *   (b) keywords field is present and has at least one element.
 *   (c) author field is set (non-empty string).
 *   (d) README.md exists and contains meaningful content (>100 chars, not a lorem stub).
 *
 * In default mode (strict=false) severity is 'warn' → process exits 0 (fail-open).
 * In strict mode  (strict=true)  severity is 'error' → process exits non-zero (fail-closed).
 *
 * Wrong-type / missing-required fields use 'error' unconditionally — this function
 * only handles the advisory conformance layer.
 */
function checkDxConformance(
  extDir: string,
  manifest: ExtensionManifest,
  opts: ValidateOptions = {},
): Diagnostic[] {
  const severity: 'warn' | 'error' = opts.strict === true ? 'error' : 'warn';
  const diags: Diagnostic[] = [];
  const manifestPath = path.join(extDir, 'extension.json');

  // Rule (a): description — non-empty and invocation-guidance-shaped.
  // The scaffolder template begins with "use this when …"; accept any sentence that
  // starts with a recognised action verb or the "use this when" prefix so that
  // well-written free-form descriptions are not rejected.
  const description = typeof manifest.description === 'string' ? manifest.description.trim() : '';
  if (description.length === 0) {
    diags.push({
      path: manifestPath,
      message:
        `DX: description is empty. Provide an invocation-guidance sentence ` +
        `(e.g. "use this when you need to …"). (P4 advisory — fix before P6 strict flip)`,
      severity,
    });
  } else {
    // Check for invocation-guidance shape: starts with an action verb or "use this"
    const GUIDANCE_RE =
      /^(use this|use when|invoke|call|run|trigger|apply|add|remove|update|create|delete|fetch|search|generate|summarize|analyse|analyze|process|convert|format|export|import|check|monitor|log|notify|send|receive|start|stop|restart|enable|disable|configure|validate|scan|deploy|build|test|lint|fix|report|list|show|get|set|reset)/i;
    if (!GUIDANCE_RE.test(description)) {
      diags.push({
        path: manifestPath,
        message:
          `DX: description "${description.slice(0, 60)}${description.length > 60 ? '…' : ''}" ` +
          `does not appear to be invocation-guidance-shaped. ` +
          `Prefer "use this when …" or start with an action verb ` +
          `(e.g. "use this when you need X" / "fetches Y from Z"). ` +
          `(P4 advisory — fix before P6 strict flip)`,
        severity,
      });
    }
  }

  // Rule (b): keywords — must be a non-empty array.
  const keywords = manifest['keywords'] as unknown;
  if (!Array.isArray(keywords) || (keywords as unknown[]).length === 0) {
    diags.push({
      path: manifestPath,
      message:
        `DX: keywords field is missing or empty. ` +
        `Add a non-empty array (e.g. ["memory","search"]). ` +
        `(P4 advisory — fix before P6 strict flip)`,
      severity,
    });
  }

  // Rule (c): author — must be a non-empty string.
  const author = typeof manifest.author === 'string' ? manifest.author.trim() : '';
  if (author.length === 0) {
    diags.push({
      path: manifestPath,
      message:
        `DX: author field is missing or empty. ` +
        `Set author to a name or team (e.g. "ACME Corp" or "jane@example.com"). ` +
        `(P4 advisory — fix before P6 strict flip)`,
      severity,
    });
  }

  // Rule (d): README.md — must exist and contain non-placeholder content.
  const readmePath = path.join(extDir, 'README.md');
  if (!fs.existsSync(readmePath)) {
    diags.push({
      path: readmePath,
      message:
        `DX: README.md is missing. ` +
        `Create a README with at least an overview, when-to-use, inputs, and outputs. ` +
        `(P4 advisory — fix before P6 strict flip)`,
      severity,
    });
  } else {
    const readmeContent = fs.readFileSync(readmePath, 'utf8').trim();
    // Reject empty files and files that are pure lorem-ipsum placeholders
    const LOREM_RE = /lorem\s+ipsum/i;
    if (readmeContent.length < 100 || LOREM_RE.test(readmeContent)) {
      diags.push({
        path: readmePath,
        message:
          `DX: README.md appears to be a placeholder (length ${readmeContent.length} chars` +
          (LOREM_RE.test(readmeContent) ? ', contains "lorem ipsum"' : ', too short') +
          `). Replace it with a meaningful overview, when-to-use, inputs, and outputs section. ` +
          `(P4 advisory — fix before P6 strict flip)`,
        severity,
      });
    }
  }

  return diags;
}

/**
 * Validate a single extension directory directly (not via the extensions/<typeDir>/<id> layout).
 * Used by tests and the scaffolder acceptance check where the ext dir is the root arg.
 * Skips Check 4 (type/dir match) since there is no conventional parent type directory.
 * Structural schema validation is delegated to libs/manifest ([ref:manifest-single-source]).
 */
function validateSingleExtensionDir(
  extDir: string,
  opts: ValidateOptions = {},
): { ok: boolean; errors: Diagnostic[] } {
  const allErrors: Diagnostic[] = [];
  const manifestPath = path.join(extDir, 'extension.json');

  let manifest: ExtensionManifest;
  let rawManifest: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    rawManifest = JSON.parse(raw) as Record<string, unknown>;
    manifest = rawManifest as ExtensionManifest;
  } catch (e) {
    allErrors.push({
      path: manifestPath,
      message: `Failed to parse extension.json: ${String(e)}`,
      severity: 'error',
    });
    return { ok: false, errors: allErrors };
  }

  // [ref:manifest-single-source] Delegate structural schema validation to libs/manifest.
  // Covers: id format, type enum, runtime enum, id-must-not-end-with-type,
  // runtime:stdio-any+provider constraint, lifecycle block rules, bundle member rules,
  // permissions structural, entrypoint string format.
  //
  // Note: libs/manifest treats `description: ''` as a structural error, but validate-manifests
  // handles empty description at the DX advisory layer (checkDxConformance, severity:'warn').
  // Filter that specific error here so the DX layer has sole authority over description quality.
  const libsResult = libsValidate(rawManifest);
  for (const msg of libsResult.errors) {
    if (msg === 'description must be a non-empty string') continue; // handled by DX layer
    allErrors.push({ path: manifestPath, message: msg, severity: 'error' });
  }

  const { type } = manifest;

  // Skip Check 4 (type/dir match) — no conventional layout in single-dir mode.

  // Check 5: ADR-0003 RETIRED the extension.json↔package.json version sync check
  // (no authored version to disagree with). Confirm package.json exists + parses only.
  const packagePath = path.join(extDir, 'package.json');
  if (fs.existsSync(packagePath)) {
    try {
      JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    } catch (e) {
      allErrors.push({
        path: packagePath,
        message: `Failed to parse package.json: ${String(e)}`,
        severity: 'error',
      });
    }
  } else {
    allErrors.push({ path: packagePath, message: 'package.json not found', severity: 'error' });
  }

  // P4: DX-conformance advisory checks (fail-open by default; errors under --strict)
  const dxDiags = checkDxConformance(extDir, manifest, opts);
  allErrors.push(...dxDiags);

  // P0 entrypoint-reachability gate (single-dir mode).
  // The string-format check is delegated to libsValidate() ([ref:manifest-single-source]).
  // Only the disk-existence check is unique to validate-manifests.
  const entrypointRaw = manifest['entrypoint'];
  if (type !== 'bundle' && typeof entrypointRaw === 'string' && entrypointRaw.trim() !== '') {
    const resolvedEntrypoint = path.resolve(extDir, entrypointRaw);
    if (!fs.existsSync(resolvedEntrypoint)) {
      allErrors.push({
        path: manifestPath,
        message:
          `entrypoint "${entrypointRaw}" resolves to "${resolvedEntrypoint}" which does not exist. ` +
          `Run "pnpm -r build" to compile extension packages before validating. ` +
          `(P0 entrypoint-reachability gate)`,
        severity: 'error',
      });
    }
  }

  const errors = allErrors.filter((d) => d.severity === 'error');
  return { ok: errors.length === 0, errors: allErrors };
}

/**
 * PB: Public export for install-time config validation.
 * Called by the installer after scope-cascade resolution, before extension activation.
 * ENFORCEMENT NOTE for P4/P5: wire this call in scripts/install.ts after cascade resolution
 * (closes Gap F3). The resolved config for extension <id> is validated against the
 * config_schema declared in its manifest. A violating config must fail installation.
 */
export { validateConfigAgainstSchema };

export function validateManifests(
  root: string,
  opts: ValidateOptions = {},
): { ok: boolean; errors: Diagnostic[] } {
  // P3: If root is directly an extension dir (contains extension.json), validate it in single-dir mode.
  // This supports: `validate-manifests.ts <path-to-ext-dir>` for scaffolded/throwaway extensions.
  if (fs.existsSync(path.join(root, 'extension.json'))) {
    return validateSingleExtensionDir(root, opts);
  }

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

    // If basic manifest parsing succeeded, collect it for cross-checks and DX lint
    const manifestPath = path.join(extDir, 'extension.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ExtensionManifest;
      manifests.push({ dir: extDir, manifest });

      // P4: DX-conformance advisory checks (per-extension; fail-open by default)
      const dxDiags = checkDxConformance(extDir, manifest, opts);
      allErrors.push(...dxDiags);
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

  // PC Check 8: Bundle member-existence — every declared member id must resolve to a known extension
  const memberExistenceErrors = checkBundleMemberExistence(manifests);
  allErrors.push(...memberExistenceErrors);

  // P2 Gap F2: Dependencies enforcement — every declared dependency id must exist in the registry
  const dependencyExistenceWarns = checkDependencyExistence(manifests);
  allErrors.push(...dependencyExistenceWarns);

  // P10 G-E: Advisory — redundant requires (warn, never error; CI-non-blocking)
  const requiresAdvisories = checkRequiresRedundancy(manifests);
  allErrors.push(...requiresAdvisories);

  const errors = allErrors.filter((d) => d.severity === 'error');

  return { ok: errors.length === 0, errors: allErrors };
}

// CLI entry point — only runs when invoked directly, not when imported
// Guard: only run as CLI when this is the main script, not when imported as a module.
const _isValidateMainScript =
  !process.env['VITEST'] &&
  (process.argv[1]?.includes('validate-manifests') ?? false);

if (_isValidateMainScript) {
  // P4: Parse --strict flag from argv.
  // argv layout: node tsx validate-manifests.ts [--strict] [<path>]
  const cliArgs = process.argv.slice(2);
  const strict = cliArgs.includes('--strict');
  const root = cliArgs.find((a) => !a.startsWith('-')) ?? process.cwd();

  const result = validateManifests(root, { strict });

  const errors = result.errors.filter((d) => d.severity === 'error');
  const warnings = result.errors.filter((d) => d.severity === 'warn');

  if (strict) {
    // In strict mode: advisory rules were promoted to errors; show mode banner
    console.warn(`validate-manifests: strict mode — advisory rules are errors`);
  }

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
    // Single-dir mode: root contains extension.json directly — count is 1.
    const isSingleDir = fs.existsSync(path.join(root, 'extension.json'));
    const extCount = isSingleDir ? 1 : findExtensionDirs(root).length;
    console.log(
      `validate-manifests: OK (${extCount} extension(s) validated` +
        (warnings.length > 0 ? `, ${warnings.length} warning(s)` : '') +
        `)`,
    );
    process.exit(0);
  }
}
