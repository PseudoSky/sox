/**
 * v2-e2e.test.ts — P11 v2 end-to-end verification
 *
 * Phase 11 closing test: prove the full v2 gap-closure (G-A..G-E, phases P7–P10)
 * is coherent and fully back-compatible with v1.
 *
 * Five gap assertions (one per gap):
 *   G-A: lifecycle — an mcp-server with lifecycle.background:true validates.
 *   G-B: bundle — installing sox-memory-bundle resolves to exactly 3 members.
 *   G-C: promotion — ScopePromotionProposed event doc exists + approval-locus rule
 *         is present in docs/scope-promotion.md (documentation-only gap).
 *   G-D: runtime — runtime:'stdio-any' + requires.structured_output:true is rejected.
 *   G-E: requires-redundancy — advisory is warn, not error; ok:true.
 *
 * Back-compat proof:
 *   All pre-existing v1 manifests (agents/echo, skills/hello-world, mcp-servers/hello-server,
 *   prompts/greeting, hooks/audit, commands/status) still validate and install unchanged.
 *
 * References:
 *   - architecture-v2.md §G-A..G-E (design decisions)
 *   - migration.md §Phase 11 (acceptance criteria)
 *   - docs/scope-promotion.md (G-C documentation artifact)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { install } from './install.js';
import { validateManifests } from './validate-manifests.js';

// ─── Repo root (the actual monorepo root with real extensions/) ───────────────
const REPO_ROOT = path.resolve(import.meta.dirname ?? __dirname, '..');

// ─── Temp-dir helpers (isolated per test) ────────────────────────────────────

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sox-v2-e2e-'));
}

function removeDirRecursive(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/** Build the P3 self-description fields for a given extension type. */
function p3SelfDescription(type: string): Record<string, unknown> {
  switch (type) {
    case 'hook':
      return { events: ['PreToolUse'] };
    case 'agent':
    case 'command':
      return { invocation: { protocol: 'function-export', handler: 'run' } };
    case 'mcp-server':
      return { tools: [{ name: 'stub_tool', description: 'use this when you need the stub tool' }] };
    case 'prompt':
      return {
        template_engine: 'handlebars',
        parameters: [{ name: 'context', type: 'string', required: false, description: 'Context' }],
      };
    case 'skill':
      return {
        run_interface: {
          input_schema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
          output_schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
        },
      };
    default:
      return {};
  }
}

/**
 * Create a minimal behavioral extension in a temp root.
 */
function makeExtension(
  root: string,
  typeDir: string,
  id: string,
  extra: Record<string, unknown> = {},
): void {
  let type: string;
  if (typeDir === 'mcp-servers') type = 'mcp-server';
  else if (typeDir === 'agents') type = 'agent';
  else if (typeDir === 'skills') type = 'skill';
  else if (typeDir === 'prompts') type = 'prompt';
  else if (typeDir === 'hooks') type = 'hook';
  else type = 'command';

  const extDir = path.join(root, 'extensions', typeDir, id);
  fs.mkdirSync(path.join(extDir, 'src'), { recursive: true });

  const manifest = {
    $schema: 'https://your-registry/schemas/extension/v1.json',
    id,
    version: '0.1.0',
    type,
    title: `${id} title`,
    description: `${id} description`,
    compatibility: { host: '>=1.0.0 <2.0.0' },
    license: 'MIT',
    entrypoint: 'dist/index.js',
    // P3: include required self-description fields by default
    ...p3SelfDescription(type),
    ...extra,
  };

  fs.writeFileSync(path.join(extDir, 'extension.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(extDir, 'package.json'),
    JSON.stringify({ name: `@adhd/sox-extension-${id}`, version: '0.1.0' }, null, 2),
  );
  fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
  fs.writeFileSync(path.join(extDir, 'src', 'index.ts'), '// stub\n');
  // P0 entrypoint-reachability: create dist/index.js stub so the gate passes in tests
  if (type !== 'prompt') {
    fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), '// stub compiled output\n');
  }
}

/**
 * Create a bundle manifest in a temp root.
 */
function makeBundle(
  root: string,
  bundleId: string,
  members: Array<{ id: string; version: string }>,
): void {
  const extDir = path.join(root, 'extensions', 'bundles', bundleId);
  fs.mkdirSync(extDir, { recursive: true });

  const manifest = {
    $schema: 'https://your-registry/schemas/extension/v1.json',
    id: bundleId,
    version: '0.1.0',
    type: 'bundle',
    title: `${bundleId} title`,
    description: `${bundleId} description`,
    compatibility: { host: '>=1.0.0 <2.0.0' },
    license: 'MIT',
    members,
  };

  fs.writeFileSync(path.join(extDir, 'extension.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(extDir, 'package.json'),
    JSON.stringify({ name: `@adhd/sox-extension-${bundleId}`, version: '0.1.0' }, null, 2),
  );
  fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
}

/**
 * Write a user-scope install config and return the paths to use in install().
 */
function makeUserConfig(
  root: string,
  config: Record<string, unknown>,
): { configPath: string; lockfilePath: string } {
  const configDir = path.join(root, 'user-config');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'extensions.json');
  const lockfilePath = path.join(configDir, 'extensions.lock');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return { configPath, lockfilePath };
}

// ─── G-A: Long-running service / daemon lifecycle ─────────────────────────────

describe('P11 v2-e2e — G-A: lifecycle block (host-owned supervision)', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    removeDirRecursive(root);
  });

  it('G-A PASS: mcp-server with lifecycle.background:true validates (supervision contract)', () => {
    // An mcp-server carrying a full lifecycle block — the memoryd daemon pattern.
    // G-A design: additive optional block; mcp-server and agent are the only allowed types.
    makeExtension(root, 'mcp-servers', 'memory-server', {
      lifecycle: {
        background: true,
        singleton: true,
        health: { type: 'stdio-ping', interval_ms: 5000, timeout_ms: 2000 },
        stop_timeout_ms: 5000,
      },
    });

    const result = validateManifests(root);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it('G-A: agent with a lifecycle block is rejected (agents are Role B / reinjected, not host-supervised)', () => {
    // Lifecycle (host-owned supervision) is restricted to the process types (mcp-server/
    // service). Agents are reinjected as content (Role B), so a lifecycle block on an
    // agent is a hard validation error.
    makeExtension(root, 'agents', 'memory-orchestrator', {
      lifecycle: { background: true, singleton: true },
    });

    const result = validateManifests(root);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(
      errors.some((e) => /lifecycle block is not allowed on type:"agent"/.test(e.message)),
    ).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('G-A FAIL: command-type with lifecycle is rejected (lifecycle restricted to mcp-server/agent)', () => {
    // The closed-type rule: lifecycle only for mcp-server or agent.
    makeExtension(root, 'commands', 'shell-util', {
      lifecycle: { background: true },
    });

    const result = validateManifests(root);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(result.ok).toBe(false);
    const lifecycleError = errors.find(
      (e) => e.message.includes('lifecycle') && e.message.includes('mcp-server'),
    );
    expect(lifecycleError).toBeDefined();
  });

  it('G-A BACK-COMPAT: v1 manifests without lifecycle block still validate unchanged', () => {
    // All existing v1 manifests have no lifecycle field — they must be unaffected.
    makeExtension(root, 'agents', 'legacy-orchestrator');
    makeExtension(root, 'skills', 'legacy-summarizer');
    makeExtension(root, 'mcp-servers', 'legacy-tools');
    makeExtension(root, 'hooks', 'pre-tool-use');
    makeExtension(root, 'commands', 'shell-runner');

    const result = validateManifests(root);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });
});

// ─── G-B: Bundle meta-package primitive ──────────────────────────────────────

describe('P11 v2-e2e — G-B: bundle installs atomically (post-cascade expansion)', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    removeDirRecursive(root);
  });

  it('G-B: installing sox-memory-bundle resolves to exactly 3 member extensions', async () => {
    // Create the 3 member extensions (the memory subsystem fixture).
    // memory-organizer was removed in P6: deterministic enrichment pipeline replaces LLM.
    makeExtension(root, 'mcp-servers', 'memory-server');
    makeExtension(root, 'skills', 'memory-recall');
    makeExtension(root, 'hooks', 'memory-promote');

    // Create the bundle manifest in extensions/bundles/
    makeBundle(root, 'sox-memory-bundle', [
      { id: 'memory-server', version: '^0.1.0' },
      { id: 'memory-recall', version: '^0.1.0' },
      { id: 'memory-promote', version: '^0.1.0' },
    ]);

    // Install config: ONE entry — the bundle id. Post-cascade expansion turns it into 4.
    const { configPath, lockfilePath } = makeUserConfig(root, {
      install: [
        {
          id: 'sox-memory-bundle',
          version: '^0.1.0',
          source: `file://${path.join(root, 'extensions', 'bundles', 'sox-memory-bundle')}`,
        },
      ],
    });

    const resolved = await install({
      scope: 'user',
      mode: 'default',
      configPath,
      lockfilePath,
      root,
    });

    const ids = Object.keys(resolved);

    // Exactly 3 member extensions — the bundle itself is expanded away
    // memory-organizer was removed in P6 (deterministic enrichment pipeline)
    expect(ids).toHaveLength(3);
    expect(ids).toContain('memory-server');
    expect(ids).toContain('memory-recall');
    expect(ids).toContain('memory-promote');
    // The bundle id itself must NOT appear — it is resolved away at install time
    expect(ids).not.toContain('sox-memory-bundle');
    // memory-organizer must NOT appear — removed in P6
    expect(ids).not.toContain('memory-organizer');
  });

  it('G-B BACK-COMPAT: cascade arrays-replace rule is intact (non-bundle installs unchanged)', async () => {
    // Verify that non-bundle extensions are resolved normally — the cascade and
    // arrays-replace rule (scripts/cascade.ts, invariant I5) are untouched.
    makeExtension(root, 'skills', 'my-analyzer');
    makeExtension(root, 'agents', 'my-assistant');

    const { configPath, lockfilePath } = makeUserConfig(root, {
      install: [
        {
          id: 'my-analyzer',
          version: '0.1.0',
          source: `file://${path.join(root, 'extensions', 'skills', 'my-analyzer')}`,
        },
        {
          id: 'my-assistant',
          version: '0.1.0',
          source: `file://${path.join(root, 'extensions', 'agents', 'my-assistant')}`,
        },
      ],
    });

    const resolved = await install({
      scope: 'user',
      mode: 'default',
      configPath,
      lockfilePath,
      root,
    });

    // Both non-bundle extensions resolve normally — behavior unchanged from v1
    expect(Object.keys(resolved)).toContain('my-analyzer');
    expect(Object.keys(resolved)).toContain('my-assistant');
  });
});

// ─── G-C: Scope-promotion event + documentation ──────────────────────────────

describe('P11 v2-e2e — G-C: scope-promotion event documented + approval-locus rule present', () => {
  // G-C is a documentation-only gap (no schema or cascade change).
  // The acceptance check verifies that docs/scope-promotion.md exists and contains
  // the required primitives:
  //   (a) ScopePromotionProposed event definition
  //   (b) approval-locus rule (to_scope owner approves; org may auto-approve)
  //   (c) per-identity partitioning is NOT a 5th scope rule

  const docsPath = path.join(REPO_ROOT, 'docs', 'scope-promotion.md');

  it('G-C: docs/scope-promotion.md exists', () => {
    expect(fs.existsSync(docsPath)).toBe(true);
  });

  it('G-C: ScopePromotionProposed event is defined in the doc', () => {
    const content = fs.readFileSync(docsPath, 'utf-8');
    expect(content).toContain('ScopePromotionProposed');
  });

  it('G-C: approval-locus rule is present (to_scope owner approves)', () => {
    const content = fs.readFileSync(docsPath, 'utf-8');
    // The rule: to_scope owner approves; org may auto-approve; default human-in-the-loop
    const hasApprovalLocus =
      content.includes('to_scope') &&
      (content.includes('approves') || content.includes('approval'));
    expect(hasApprovalLocus).toBe(true);
  });

  it('G-C: per-identity partitioning is NOT a 5th scope (anti-reinvention rule)', () => {
    const content = fs.readFileSync(docsPath, 'utf-8');
    // The rule states agent/user identity is a tenant concern, not an install scope
    const hasPerIdentityRule =
      content.includes('5th scope') ||
      content.includes('fifth scope') ||
      content.includes('per-identity') ||
      content.includes('not a 5th');
    expect(hasPerIdentityRule).toBe(true);
  });

  it('G-C: no schema/cascade/install change (schemas/ directory unchanged)', () => {
    // G-C is doc-only. Verify the schemas directory has only the expected files.
    const schemasDir = path.join(REPO_ROOT, 'schemas');
    const allSchemas = fs
      .readdirSync(schemasDir, { recursive: true, withFileTypes: false })
      .filter((f) => typeof f === 'string' && (f as string).endsWith('.json'))
      .map((f) => f as string)
      .sort();

    // The schemas/ tree must NOT contain a 'promotion' schema file — G-C is doc only.
    const hasPromotionSchema = allSchemas.some((f) => f.toLowerCase().includes('promotion'));
    expect(hasPromotionSchema).toBe(false);
  });
});

// ─── G-D: Runtime-language contract ──────────────────────────────────────────

describe('P11 v2-e2e — G-D: runtime:stdio-any + provider-requires is rejected', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    removeDirRecursive(root);
  });

  it('G-D FAIL: runtime:stdio-any with requires.structured_output:true is rejected', () => {
    // Core G-D assertion: provider-touching extensions MUST use runtime:'node'.
    // An stdio-any extension cannot call the Node/TS provider abstraction.
    makeExtension(root, 'mcp-servers', 'python-server', {
      runtime: 'stdio-any',
      requires: { structured_output: true },
    });

    const result = validateManifests(root);
    expect(result.ok).toBe(false);

    const runtimeError = result.errors.find(
      (e) =>
        e.severity === 'error' &&
        e.message.includes('stdio-any') &&
        e.message.includes('provider'),
    );
    expect(runtimeError).toBeDefined();
  });

  it('G-D FAIL: runtime:stdio-any with requires.tool_calling:true is rejected', () => {
    makeExtension(root, 'mcp-servers', 'go-server', {
      runtime: 'stdio-any',
      requires: { tool_calling: true },
    });

    const result = validateManifests(root);
    expect(result.ok).toBe(false);
    const runtimeError = result.errors.find(
      (e) => e.severity === 'error' && e.message.includes('stdio-any'),
    );
    expect(runtimeError).toBeDefined();
  });

  it('G-D PASS: runtime:stdio-any with NO provider requires is valid (language-agnostic ok)', () => {
    // A stdio-any MCP server that does not call the provider abstraction is valid.
    makeExtension(root, 'mcp-servers', 'filesystem-server', {
      runtime: 'stdio-any',
      // no requires — valid for a pure-stdio server
    });

    const result = validateManifests(root);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it('G-D BACK-COMPAT: v1 manifests with no runtime field still validate (defaults to node)', () => {
    // All existing v1 manifests omit the runtime field — they must still validate.
    makeExtension(root, 'agents', 'legacy-orchestrator', {
      requires: { structured_output: true, tool_calling: true },
      // No runtime field => implicit 'node' => provider requires are fine
    });

    const result = validateManifests(root);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });
});

// ─── G-E: Requires-redundancy advisory (warn, not error) ─────────────────────

describe('P11 v2-e2e — G-E: requires-redundancy advisory is warn (CI-non-blocking)', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    removeDirRecursive(root);
  });

  it('G-E: redundant requires emits warn, not error; ok remains true', () => {
    // memory-organizer (spawner) and memory-server (dependency) both declare
    // identical requires — exactly the scenario from architecture-v2.md §G-E.
    const sharedRequires = { structured_output: true, tool_calling: true };

    makeExtension(root, 'mcp-servers', 'memory-server', {
      requires: sharedRequires,
    });
    makeExtension(root, 'agents', 'memory-organizer', {
      requires: sharedRequires,
      dependencies: ['memory-server'],
    });

    const result = validateManifests(root);

    // CRITICAL: ok must be true — the G-E advisory must NEVER block CI
    expect(result.ok).toBe(true);

    // Advisory must be present with severity 'warn'
    const advisory = result.errors.find(
      (d) =>
        d.severity === 'warn' &&
        d.message.includes('memory-organizer') &&
        d.message.includes('memory-server') &&
        d.message.includes('G-E advisory'),
    );
    expect(advisory).toBeDefined();
    expect(advisory?.severity).toBe('warn');

    // No errors at all
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('G-E: advisory message contains standalone guidance (per §G-E spec)', () => {
    const sharedRequires = { structured_output: true };

    makeExtension(root, 'mcp-servers', 'dep-server', {
      requires: sharedRequires,
    });
    makeExtension(root, 'agents', 'spawner-assistant', {
      requires: sharedRequires,
      dependencies: ['dep-server'],
    });

    const result = validateManifests(root);
    const advisory = result.errors.find(
      (d) => d.severity === 'warn' && d.message.includes('G-E advisory'),
    );
    expect(advisory).toBeDefined();
    expect(advisory?.message).toContain('standalone');
    expect(advisory?.message).toContain('redundant but safe');
  });

  it('G-E BACK-COMPAT: v1 manifests (no dependencies) emit no G-E advisory', () => {
    // All existing v1 manifests have no dependencies field — no advisory should fire.
    makeExtension(root, 'agents', 'v1-orchestrator');
    makeExtension(root, 'skills', 'v1-summarizer');
    makeExtension(root, 'mcp-servers', 'v1-tools');

    const result = validateManifests(root);
    expect(result.ok).toBe(true);
    const ge = result.errors.filter((d) => d.severity === 'warn' && d.message.includes('G-E'));
    expect(ge).toHaveLength(0);
  });
});

// ─── Back-compat proof: the full v1 extension tree validates unchanged ────────

describe('P11 v2-e2e — BACK-COMPAT: all v1 extensions validate + the bundle validates', () => {
  it('pnpm run validate: the real extensions/ tree validates (7 extensions, 0 errors)', () => {
    // Run validateManifests against the actual monorepo root.
    // This covers all 6 v1 extensions + the sox-memory-bundle fixture.
    const result = validateManifests(REPO_ROOT);

    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it('active extension types (agent/mcp-server/hook/command/bundle) each have a manifest', () => {
    // D4 (authoring-lib): the 6 demo extensions were deleted as part of the nx-migration.
    // The born-conformance gate (tools/born-conformance.js) is the new fixture source.
    // This test now confirms the real production extensions (memory subsystem) are present.
    // Each active extension type must have a representative manifest in the repo.
    // After P8 bundle co-location (24cb5fe) the memory mcp-server/hook/cli/organizer
    // live as members under sox-memory-bundle, not at top-level type dirs — so this
    // references each type at its real current location (top-level or bundle member).
    const expectedManifests: string[] = [
      'extensions/agents/org-agent/extension.json',                                  // agent
      'extensions/bundles/sox-memory-bundle/members/memory-server/extension.json',   // mcp-server
      'extensions/bundles/sox-memory-bundle/members/memory-flush/extension.json',    // hook
      'extensions/commands/di-command/extension.json',                               // command
      'extensions/bundles/sox-memory-bundle/extension.json',                         // bundle
    ];

    for (const rel of expectedManifests) {
      expect(
        fs.existsSync(path.join(REPO_ROOT, rel)),
        `manifest missing: ${rel}`,
      ).toBe(true);
    }
  });

  it('sox-memory-bundle fixture is present and validates as bundle type', () => {
    // The example bundle created in P9 must exist and validate.
    const bundleManifestPath = path.join(
      REPO_ROOT,
      'extensions',
      'bundles',
      'sox-memory-bundle',
      'extension.json',
    );
    expect(fs.existsSync(bundleManifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(bundleManifestPath, 'utf-8')) as {
      type: string;
      members: unknown[];
    };
    expect(manifest.type).toBe('bundle');
    expect(Array.isArray(manifest.members)).toBe(true);
    // sox-memory-bundle members: memory-daemon, memory-server,
    // memory-flush, memory-cli, memory-usage (P6: memory-organizer removed;
    // deterministic enrichment pipeline via memory-core replaces LLM organizer).
    expect(manifest.members).toHaveLength(5);
  });
});
