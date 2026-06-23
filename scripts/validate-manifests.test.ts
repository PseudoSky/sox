/**
 * validate-manifests.test.ts — P2 acceptance tests for dedup + secret lint
 *
 * Acceptance criteria (Section 4.5):
 *   - duplicate-ID fixture → non-zero exit (error)
 *   - shadow-copy fixture (live sox-active/sox-cto-system failure mode) → error
 *   - literal-secret fixture → error
 *   - valid manifests → passes
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateConfigAgainstSchema, validateManifests, type ValidateOptions } from './validate-manifests.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-test-'));
  return dir;
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

function makeExtension(
  root: string,
  typeDir: string,
  id: string,
  version = '0.1.0',
  overrideType?: string,
): void {
  const extDir = path.join(root, 'extensions', typeDir, id);
  fs.mkdirSync(extDir, { recursive: true });

  const extType = overrideType ?? typeDir.replace(/s$/, '').replace('mcp-servers', 'mcp-server');
  // Handle special plurals
  let type = extType;
  if (typeDir === 'mcp-servers') type = 'mcp-server';
  else if (typeDir === 'agents') type = 'agent';
  else if (typeDir === 'skills') type = 'skill';
  else if (typeDir === 'prompts') type = 'prompt';
  else if (typeDir === 'hooks') type = 'hook';
  else if (typeDir === 'commands') type = 'command';
  if (overrideType !== undefined) type = overrideType;

  const manifest = {
    $schema: 'https://your-registry/schemas/extension/v1.json',
    id,
    version,
    type,
    title: `${id} title`,
    description: `${id} description`,
    compatibility: { host: '>=1.0.0 <2.0.0' },
    license: 'MIT',
    entrypoint: type === 'prompt' ? undefined : 'dist/index.js',
    // P3: include required self-description fields for each type
    ...p3SelfDescription(type),
  };
  fs.writeFileSync(path.join(extDir, 'extension.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(extDir, 'package.json'),
    JSON.stringify({ name: `@adhd/sox-extension-${id}`, version }, null, 2),
  );
  fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
  if (type === 'prompt') {
    fs.writeFileSync(path.join(extDir, 'prompt.md'), '# Prompt\n');
  } else {
    fs.mkdirSync(path.join(extDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'src', 'index.ts'), '// stub\n');
    // P0 entrypoint-reachability: create the compiled entrypoint so the gate passes in tests
    fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), '// stub compiled output\n');
  }
}

function removeDirRecursive(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('validate-manifests — P2 dedup + secret lint', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTempRepo();
  });

  afterEach(() => {
    removeDirRecursive(tmpRoot);
  });

  // ─── Valid case ────────────────────────────────────────────────────────────

  it('passes for valid extensions with unique ids', () => {
    makeExtension(tmpRoot, 'skills', 'my-analyzer');
    makeExtension(tmpRoot, 'agents', 'my-assistant');
    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  // ─── Duplicate ID invariant 1 ──────────────────────────────────────────────

  it('errors on duplicate extension id in registry (invariant 1)', () => {
    makeExtension(tmpRoot, 'skills', 'duplicate-name');
    makeExtension(tmpRoot, 'agents', 'duplicate-name'); // same id, different typeDir
    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
    const dupError = errors.find((e) => e.message.includes('Duplicate extension id'));
    expect(dupError).toBeDefined();
    expect(result.ok).toBe(false);
  });

  // ─── Shadow copy (sox-active/sox-cto-system failure mode) ─────────────────

  it('errors on shadow copy: same id from two differently-sourced entries (invariant 3)', () => {
    // Fixture modeling the live sox-active/sox-cto-system bug:
    // cto-agent appears in BOTH a registry entry AND a file:// source in a scope config
    makeExtension(tmpRoot, 'agents', 'cto-agent');

    // Create a project scope config that tries to install cto-agent from file:// (a shadow copy)
    const dotExtDir = path.join(tmpRoot, '.extensions');
    fs.mkdirSync(dotExtDir, { recursive: true });
    const projectConfig = {
      install: [
        { id: 'cto-agent', version: '^2.0.0', source: 'registry' },
        // A different scope config trying to install same id from file:// would be the real case
        // We simulate it by having the id also installed from file://
        { id: 'cto-agent', version: '1.0.0', source: 'file:///some/other/path/cto-agent' },
      ],
    };
    fs.writeFileSync(
      path.join(dotExtDir, 'extensions.json'),
      JSON.stringify(projectConfig, null, 2),
    );

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(result.ok).toBe(false);

    // Should error on either duplicate install entry OR shadow copy
    const hasShadowError = errors.some(
      (e) =>
        e.message.includes('Shadow copy') ||
        e.message.includes('Duplicate id') ||
        e.message.includes('duplicate'),
    );
    expect(hasShadowError).toBe(true);
  });

  // ─── Secret-in-config invariant ───────────────────────────────────────────

  it('errors when committed config contains a literal OpenAI API key', () => {
    makeExtension(tmpRoot, 'agents', 'my-agent');

    const dotExtDir = path.join(tmpRoot, '.extensions');
    fs.mkdirSync(dotExtDir, { recursive: true });

    // Committed project config with a literal API key (should be ${OPENAI_API_KEY})
    const projectConfig = {
      install: [{ id: 'my-agent', version: '0.1.0' }],
      config: {
        'my-agent': {
          provider: 'openai/gpt-4o',
          api_key: 'sk-abcdefghijklmnopqrstuvwxyz123456789012345', // literal secret!
        },
      },
    };
    fs.writeFileSync(
      path.join(dotExtDir, 'extensions.json'),
      JSON.stringify(projectConfig, null, 2),
    );

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(result.ok).toBe(false);

    const hasSecretError = errors.some(
      (e) => e.message.includes('secret') || e.message.includes('literal'),
    );
    expect(hasSecretError).toBe(true);
  });

  it('errors when committed config contains a literal Anthropic API key', () => {
    makeExtension(tmpRoot, 'agents', 'claude-agent');

    const dotExtDir = path.join(tmpRoot, '.extensions');
    fs.mkdirSync(dotExtDir, { recursive: true });

    const projectConfig = {
      install: [{ id: 'claude-agent', version: '0.1.0' }],
      config: {
        'claude-agent': {
          api_key: 'sk-ant-api03-verylongsecretkeyvaluegoeshere12345678901234567890',
        },
      },
    };
    fs.writeFileSync(
      path.join(dotExtDir, 'extensions.json'),
      JSON.stringify(projectConfig, null, 2),
    );

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(result.ok).toBe(false);
    expect(errors.some((e) => e.message.includes('secret'))).toBe(true);
  });

  it('allows ${ENV} references in committed config (valid pattern)', () => {
    // Note: id must NOT end with its type name (e.g. 'my-assistant' not 'my-agent')
    makeExtension(tmpRoot, 'agents', 'my-assistant');

    const dotExtDir = path.join(tmpRoot, '.extensions');
    fs.mkdirSync(dotExtDir, { recursive: true });

    const projectConfig = {
      install: [{ id: 'my-assistant', version: '0.1.0' }],
      config: {
        'my-assistant': {
          provider: 'openai/gpt-4o',
          api_key: '${OPENAI_API_KEY}', // env ref — allowed
          max_tokens: 4096,
        },
      },
    };
    fs.writeFileSync(
      path.join(dotExtDir, 'extensions.json'),
      JSON.stringify(projectConfig, null, 2),
    );

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('allows ollama sentinel in committed config', () => {
    makeExtension(tmpRoot, 'agents', 'local-llm');

    const dotExtDir = path.join(tmpRoot, '.extensions');
    fs.mkdirSync(dotExtDir, { recursive: true });

    const projectConfig = {
      install: [{ id: 'local-llm', version: '0.1.0' }],
      config: {
        'local-llm': {
          api_key: 'ollama',
          base_url: 'http://localhost:11434/v1',
        },
      },
    };
    fs.writeFileSync(
      path.join(dotExtDir, 'extensions.json'),
      JSON.stringify(projectConfig, null, 2),
    );

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  // ─── id-format checks (from P0, still required) ────────────────────────────

  it('errors on invalid id format', () => {
    makeExtension(tmpRoot, 'skills', 'valid-id');
    // Manually create a bad manifest
    const extDir = path.join(tmpRoot, 'extensions', 'skills', 'bad_id');
    fs.mkdirSync(path.join(extDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'bad_id', // underscore not allowed
        version: '0.1.0',
        type: 'skill',
        title: 'Bad ID',
        description: 'test',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js',
      }),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-extension-bad-id', version: '0.1.0' }),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
    fs.writeFileSync(path.join(extDir, 'src', 'index.ts'), '// stub\n');

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(result.ok).toBe(false);
    expect(errors.some((e) => e.message.includes('bad_id'))).toBe(true);
  });
});

// ─── P7 — G-D runtime-language contract ──────────────────────────────────────
// Tests for the optional `runtime` field (architecture-v2.md §G-D).
// Rule: runtime:'stdio-any' MUST NOT declare requires.structured_output:true
//       or requires.tool_calling:true (those require the Node/TS provider layer).
//       Absent `runtime` defaults to 'node' — all v1 manifests remain valid.

describe('validate-manifests — P7 G-D runtime-language contract', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTempRepo();
  });

  afterEach(() => {
    removeDirRecursive(tmpRoot);
  });

  /** Helper: write a manifest with arbitrary extra fields (P3 self-description included by default) */
  function makeExtensionWithFields(
    root: string,
    typeDir: string,
    id: string,
    extra: Record<string, unknown>,
  ): void {
    const extDir = path.join(root, 'extensions', typeDir, id);
    fs.mkdirSync(path.join(extDir, 'src'), { recursive: true });

    let type: string;
    if (typeDir === 'mcp-servers') type = 'mcp-server';
    else if (typeDir === 'agents') type = 'agent';
    else if (typeDir === 'skills') type = 'skill';
    else if (typeDir === 'prompts') type = 'prompt';
    else if (typeDir === 'hooks') type = 'hook';
    else type = 'command';

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
    fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), '// stub compiled output\n');
  }

  // FAIL case: stdio-any with structured_output:true must be rejected
  it('errors when runtime:stdio-any declares requires.structured_output:true', () => {
    makeExtensionWithFields(tmpRoot, 'mcp-servers', 'my-server', {
      runtime: 'stdio-any',
      requires: { structured_output: true },
    });

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(result.ok).toBe(false);
    const runtimeError = errors.find(
      (e) => e.message.includes('stdio-any') && e.message.includes('provider'),
    );
    expect(runtimeError).toBeDefined();
  });

  // FAIL case: stdio-any with tool_calling:true must be rejected
  it('errors when runtime:stdio-any declares requires.tool_calling:true', () => {
    makeExtensionWithFields(tmpRoot, 'mcp-servers', 'my-tool-server', {
      runtime: 'stdio-any',
      requires: { tool_calling: true },
    });

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(result.ok).toBe(false);
    const runtimeError = errors.find(
      (e) => e.message.includes('stdio-any') && e.message.includes('provider'),
    );
    expect(runtimeError).toBeDefined();
  });

  // PASS case: stdio-any with no provider requires is valid
  it('passes when runtime:stdio-any declares no provider requires', () => {
    makeExtensionWithFields(tmpRoot, 'mcp-servers', 'stdio-server', {
      runtime: 'stdio-any',
      // no requires block — valid for a language-agnostic stdio server
    });

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  // PASS case: stdio-any with requires that explicitly set false is valid
  it('passes when runtime:stdio-any declares requires with all false values', () => {
    makeExtensionWithFields(tmpRoot, 'mcp-servers', 'stdio-safe-server', {
      runtime: 'stdio-any',
      requires: { tool_calling: false, structured_output: false },
    });

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  // PASS case: runtime:'node' with provider requires is valid
  it('passes when runtime:node declares requires.structured_output:true', () => {
    // Note: id must not end with its type name — use a name that does not end with '-agent'
    makeExtensionWithFields(tmpRoot, 'agents', 'node-runtime-assistant', {
      runtime: 'node',
      requires: { structured_output: true, tool_calling: true },
    });

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  // BACK-COMPAT: manifests with no `runtime` field still validate (defaults to 'node')
  it('passes for v1 manifests with no runtime field (back-compat default:node)', () => {
    // makeExtension creates manifests without a runtime field (mimics all existing v1 manifests)
    // ids must not end with their type name
    makeExtension(tmpRoot, 'agents', 'legacy-assistant');
    makeExtension(tmpRoot, 'skills', 'legacy-analyzer');
    makeExtension(tmpRoot, 'mcp-servers', 'legacy-tools');

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  // BACK-COMPAT: existing extension dirs without runtime still validate
  it('passes for a v1 manifest with requires but no runtime field (implicit node)', () => {
    // No runtime field — implicitly 'node', so provider requires are fine
    // id must not end with type name 'agent'
    makeExtensionWithFields(tmpRoot, 'agents', 'v1-assistant', {
      requires: { structured_output: true, tool_calling: true },
    });

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });
});

// ─── P8 — G-A service lifecycle block ────────────────────────────────────────
// Tests for the optional `lifecycle{}` block (architecture-v2.md §G-A).
//
// Host supervisor sub-contract (documented here; no supervisor is built in this repo
// — the loader is a host contract, spec-only):
//   - start:     if lifecycle.background:true the host keeps the process alive across calls
//               (supervised); else lazy per-call spawn (v1 behavior for absent lifecycle).
//   - singleton: host holds a per-scope-key file lock (id+scope); extension no longer
//               self-manages OS advisory locks (formalizes the memoryd.lock workaround).
//   - stop:      SIGTERM → wait stop_timeout_ms → SIGKILL. Fired on host shutdown,
//               extension disable (cascade enabled:false), or version change.
//   - health:    host probes per health.type every interval_ms; on timeout_ms miss ×
//               restart policy the host restarts (exponential backoff). Advisory to host.
//   - back-compat: manifests without `lifecycle` keep exact v1 request/response semantics.
//
// Validation rules (what this repo enforces):
//   Rule 1: lifecycle present => type in {mcp-server, agent} (FAIL for command/hook/skill/prompt)
//   Rule 2: health.type in {socket, command} => health.endpoint required
//   Rule 3: lifecycle absent => no restriction, v1 back-compat guaranteed

describe('validate-manifests — P8 G-A service lifecycle block', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTempRepo();
  });

  afterEach(() => {
    removeDirRecursive(tmpRoot);
  });

  /** Helper: write a manifest with arbitrary extra fields (P3 self-description included by default) */
  function makeExtensionWithFields(
    root: string,
    typeDir: string,
    id: string,
    extra: Record<string, unknown>,
  ): void {
    const extDir = path.join(root, 'extensions', typeDir, id);
    fs.mkdirSync(path.join(extDir, 'src'), { recursive: true });

    let type: string;
    if (typeDir === 'mcp-servers') type = 'mcp-server';
    else if (typeDir === 'agents') type = 'agent';
    else if (typeDir === 'skills') type = 'skill';
    else if (typeDir === 'prompts') type = 'prompt';
    else if (typeDir === 'hooks') type = 'hook';
    else type = 'command';

    const manifest = {
      $schema: 'https://your-registry/schemas/extension/v1.json',
      id,
      version: '0.1.0',
      type,
      title: `${id} title`,
      description: `${id} description`,
      compatibility: { host: '>=1.0.0 <2.0.0' },
      license: 'MIT',
      entrypoint: type === 'prompt' ? undefined : 'dist/index.js',
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

  // ─── PASS: mcp-server with lifecycle is valid ─────────────────────────────

  it('passes when an mcp-server declares lifecycle.background:true (singleton daemon)', () => {
    makeExtensionWithFields(tmpRoot, 'mcp-servers', 'memory-server', {
      lifecycle: {
        background: true,
        singleton: true,
        health: { type: 'stdio-ping', interval_ms: 5000, timeout_ms: 2000 },
        stop_timeout_ms: 5000,
      },
    });

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  // FAIL: agent with lifecycle is rejected — agents are Role B (reinjected), not Role A (supervised)
  // Validator rule [dod.6]: lifecycle is only allowed on mcp-server and service types.
  it('errors when an agent declares lifecycle with health.type:stdio-ping (Role B restriction)', () => {
    makeExtensionWithFields(tmpRoot, 'agents', 'memory-orchestrator', {
      lifecycle: {
        background: true,
        singleton: true,
        health: { type: 'stdio-ping' },
      },
    });

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(result.ok).toBe(false);
    const lifecycleError = errors.find((e) => e.message.includes('lifecycle'));
    expect(lifecycleError).toBeDefined();
  });

  // PASS: mcp-server with socket health and endpoint is valid
  it('passes when mcp-server declares health.type:socket with endpoint', () => {
    makeExtensionWithFields(tmpRoot, 'mcp-servers', 'socket-server', {
      lifecycle: {
        background: true,
        health: { type: 'socket', endpoint: '/tmp/server.sock', interval_ms: 3000 },
      },
    });

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  // PASS: mcp-server with command health and endpoint is valid
  it('passes when mcp-server declares health.type:command with endpoint', () => {
    makeExtensionWithFields(tmpRoot, 'mcp-servers', 'cmd-health-server', {
      lifecycle: {
        background: true,
        health: { type: 'command', endpoint: 'curl -f http://localhost:8080/health' },
      },
    });

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  // ─── FAIL: lifecycle on a command-type manifest must be rejected ───────────

  it('errors when a command-type manifest declares lifecycle (Rule 1)', () => {
    makeExtensionWithFields(tmpRoot, 'commands', 'my-util', {
      lifecycle: { background: true },
    });

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(result.ok).toBe(false);
    const lifecycleError = errors.find(
      (e) => e.message.includes('lifecycle') && e.message.includes('mcp-server'),
    );
    expect(lifecycleError).toBeDefined();
  });

  // FAIL: lifecycle on hook
  it('errors when a hook-type manifest declares lifecycle (Rule 1)', () => {
    makeExtensionWithFields(tmpRoot, 'hooks', 'my-hook', {
      lifecycle: { background: false },
    });

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(result.ok).toBe(false);
    const lifecycleError = errors.find((e) => e.message.includes('lifecycle'));
    expect(lifecycleError).toBeDefined();
  });

  // FAIL: lifecycle on skill
  it('errors when a skill-type manifest declares lifecycle (Rule 1)', () => {
    makeExtensionWithFields(tmpRoot, 'skills', 'my-skill', {
      lifecycle: { singleton: true },
    });

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(result.ok).toBe(false);
    expect(errors.some((e) => e.message.includes('lifecycle'))).toBe(true);
  });

  // ─── FAIL: health.type:socket without endpoint must fail ─────────────────

  it('errors when health.type:socket is declared without endpoint (Rule 2)', () => {
    makeExtensionWithFields(tmpRoot, 'mcp-servers', 'no-endpoint-server', {
      lifecycle: {
        background: true,
        health: { type: 'socket' }, // missing endpoint!
      },
    });

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(result.ok).toBe(false);
    const endpointError = errors.find(
      (e) => e.message.includes('endpoint') && e.message.includes('socket'),
    );
    expect(endpointError).toBeDefined();
  });

  // FAIL: health.type:command without endpoint must fail
  it('errors when health.type:command is declared without endpoint (Rule 2)', () => {
    makeExtensionWithFields(tmpRoot, 'mcp-servers', 'no-cmd-endpoint-server', {
      lifecycle: {
        background: true,
        health: { type: 'command' }, // missing endpoint!
      },
    });

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(result.ok).toBe(false);
    const endpointError = errors.find(
      (e) => e.message.includes('endpoint') && e.message.includes('command'),
    );
    expect(endpointError).toBeDefined();
  });

  // ─── BACK-COMPAT: v1 manifests without lifecycle still validate ───────────

  it('passes for all v1 manifests without lifecycle (back-compat Rule 3)', () => {
    // All five v1 extension types without lifecycle — should all pass.
    // ids must not end with their type name (validateSingleManifest Check 2).
    makeExtension(tmpRoot, 'agents', 'legacy-orchestrator');  // not ending with '-agent'
    makeExtension(tmpRoot, 'skills', 'legacy-summarizer');    // not ending with '-skill'
    makeExtension(tmpRoot, 'mcp-servers', 'legacy-tools');    // not ending with '-mcp-server'
    makeExtension(tmpRoot, 'hooks', 'pre-tool-use');          // not ending with '-hook'
    makeExtension(tmpRoot, 'commands', 'shell-runner');       // not ending with '-command'

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  // BACK-COMPAT: lifecycle absent => no restriction for any type
  it('passes for a v1 command manifest with no lifecycle field (no restriction)', () => {
    makeExtensionWithFields(tmpRoot, 'commands', 'shell-util', {
      // no lifecycle field — v1 back-compat
    });

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  // PASS: health.type:stdio-ping (default) without endpoint is valid
  it('passes when health.type:stdio-ping is declared without endpoint (endpoint not needed)', () => {
    makeExtensionWithFields(tmpRoot, 'mcp-servers', 'ping-server', {
      lifecycle: {
        background: true,
        health: { type: 'stdio-ping', interval_ms: 2000 },
      },
    });

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });
});

// ─── P9 — G-B bundle type validation ─────────────────────────────────────────
// Tests for the 'bundle' extension type (architecture-v2.md §G-B).
//
// A bundle is install-time-only: it expands to its members in install.ts
// AFTER cascade resolution. The cascade arrays-replace rule (I5) is unchanged.
//
// Validation rules:
//   Rule 1: bundle MUST have a non-empty members array
//   Rule 2: bundle MUST NOT have an entrypoint (no runtime — expanded away at install)
//   Rule 3: each member id must match ^[a-z][a-z0-9-]*$
//   Rule 4: no self-reference (member.id === bundle.id)
//   Rule 5: no duplicate member ids within the same bundle
//   Back-compat: all v1 (non-bundle) manifests validate unchanged

describe('validate-manifests — P9 G-B bundle type', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTempRepo();
  });

  afterEach(() => {
    removeDirRecursive(tmpRoot);
  });

  /** Write a well-formed bundle manifest to bundles/<id>/extension.json */
  function makeBundle(
    root: string,
    id: string,
    members: Array<{ id: string; version: string }>,
    extra: Record<string, unknown> = {},
  ): void {
    const extDir = path.join(root, 'extensions', 'bundles', id);
    fs.mkdirSync(extDir, { recursive: true });

    const manifest = {
      $schema: 'https://your-registry/schemas/extension/v1.json',
      id,
      version: '0.1.0',
      type: 'bundle',
      title: `${id} title`,
      description: `${id} description`,
      compatibility: { host: '>=1.0.0 <2.0.0' },
      license: 'MIT',
      members,
      ...extra,
    };
    fs.writeFileSync(path.join(extDir, 'extension.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: `@adhd/sox-extension-${id}`, version: '0.1.0' }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
  }

  // ─── PASS: valid bundle with correct members ───────────────────────────────

  it('passes for a valid bundle with non-empty members and no entrypoint', () => {
    // PC Check 8 (member-existence): the validator now requires each bundle member id
    // to exist as an extension in the registry. Create the member extensions so this
    // "valid bundle" test continues to assert zero errors.
    makeExtension(tmpRoot, 'mcp-servers', 'memory-server');
    makeExtension(tmpRoot, 'agents', 'memory-organizer');
    makeExtension(tmpRoot, 'skills', 'memory-recall');
    makeExtension(tmpRoot, 'skills', 'memory-promote');

    makeBundle(tmpRoot, 'sox-memory-bundle', [
      { id: 'memory-server', version: '^0.1.0' },
      { id: 'memory-organizer', version: '^0.1.0' },
      { id: 'memory-recall', version: '^0.1.0' },
      { id: 'memory-promote', version: '^0.1.0' },
    ]);

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  // PASS: example bundle from extensions/bundles/sox-memory-bundle validates
  it('passes for the real sox-memory-bundle example fixture', () => {
    // The actual fixture lives at extensions/bundles/sox-memory-bundle/
    // We point validateManifests at the repo root which contains it.
    // This test ensures the example bundle is well-formed.
    const repoRoot = path.resolve(__dirname, '..');
    const bundleDir = path.join(repoRoot, 'extensions', 'bundles', 'sox-memory-bundle');
    // Only run if the fixture exists (it should after P9)
    if (!fs.existsSync(bundleDir)) return;

    const result = validateManifests(repoRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    // Filter out errors from the real repo extensions (only check bundle-related ones)
    const bundleErrors = errors.filter((e) => e.path.includes('sox-memory-bundle'));
    expect(bundleErrors).toHaveLength(0);
  });

  // ─── FAIL: bundle with no members must be rejected (Rule 1) ──────────────

  it('errors when a bundle declares an empty members array (Rule 1)', () => {
    makeBundle(tmpRoot, 'empty-bundle', []);

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(result.ok).toBe(false);
    const membersError = errors.find(
      (e) => e.message.includes('members') && e.message.includes('non-empty'),
    );
    expect(membersError).toBeDefined();
  });

  it('errors when a bundle has no members field at all (Rule 1)', () => {
    const extDir = path.join(tmpRoot, 'extensions', 'bundles', 'no-members-bundle');
    fs.mkdirSync(extDir, { recursive: true });
    const manifest = {
      $schema: 'https://your-registry/schemas/extension/v1.json',
      id: 'no-members-bundle',
      version: '0.1.0',
      type: 'bundle',
      title: 'No Members',
      description: 'no members field',
      compatibility: { host: '>=1.0.0 <2.0.0' },
      license: 'MIT',
      // no 'members' field
    };
    fs.writeFileSync(path.join(extDir, 'extension.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-extension-no-members-bundle', version: '0.1.0' }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(result.ok).toBe(false);
    const membersError = errors.find((e) => e.message.includes('members'));
    expect(membersError).toBeDefined();
  });

  // ─── FAIL: bundle with entrypoint must be rejected (Rule 2) ──────────────

  it('errors when a bundle declares an entrypoint (Rule 2 — bundles have no runtime)', () => {
    makeBundle(
      tmpRoot,
      'bundle-with-entry',
      [{ id: 'some-member', version: '^0.1.0' }],
      { entrypoint: 'dist/index.js' },
    );

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(result.ok).toBe(false);
    const entrypointError = errors.find(
      (e) => e.message.includes('entrypoint') && e.message.includes('bundle'),
    );
    expect(entrypointError).toBeDefined();
  });

  // ─── FAIL: self-reference member (Rule 4) ─────────────────────────────────

  it('errors when a bundle lists itself as a member (Rule 4 — self-reference)', () => {
    makeBundle(tmpRoot, 'self-ref-bundle', [
      { id: 'self-ref-bundle', version: '^0.1.0' }, // self!
      { id: 'other-member', version: '^0.1.0' },
    ]);

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(result.ok).toBe(false);
    const selfRefError = errors.find(
      (e) => e.message.includes('self-reference') || e.message.includes('itself'),
    );
    expect(selfRefError).toBeDefined();
  });

  // ─── FAIL: duplicate member ids (Rule 5) ─────────────────────────────────

  it('errors when a bundle has duplicate member ids (Rule 5)', () => {
    makeBundle(tmpRoot, 'dup-members-bundle', [
      { id: 'member-a', version: '^0.1.0' },
      { id: 'member-a', version: '^0.2.0' }, // duplicate!
      { id: 'member-b', version: '^0.1.0' },
    ]);

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(result.ok).toBe(false);
    const dupError = errors.find(
      (e) => e.message.includes('duplicate') && e.message.includes('member'),
    );
    expect(dupError).toBeDefined();
  });

  // ─── PC Check 8: member-existence validation ─────────────────────────────

  it('PC: errors when a bundle declares a member that does not exist in the registry', () => {
    // The bundle references 'ghost-extension' which has no extension.json in extensions/
    makeBundle(tmpRoot, 'bundle-with-ghost', [
      { id: 'ghost-extension', version: '^0.1.0' },
    ]);

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(result.ok).toBe(false);
    const memberError = errors.find(
      (e) =>
        e.message.includes('ghost-extension') &&
        e.message.includes('does not exist') &&
        e.message.includes('member-existence'),
    );
    expect(memberError).toBeDefined();
  });

  it('PC: passes when all bundle members exist in the registry', () => {
    makeExtension(tmpRoot, 'agents', 'real-agent');
    makeExtension(tmpRoot, 'skills', 'real-skill');
    makeBundle(tmpRoot, 'well-formed-bundle', [
      { id: 'real-agent', version: '^0.1.0' },
      { id: 'real-skill', version: '^0.1.0' },
    ]);

    const result = validateManifests(tmpRoot);
    const memberErrors = result.errors.filter(
      (d) => d.severity === 'error' && d.message.includes('member-existence'),
    );
    expect(memberErrors).toHaveLength(0);
  });

  // ─── BACK-COMPAT: v1 (non-bundle) manifests still validate unchanged ──────

  it('passes for all v1 extension types alongside a bundle (back-compat)', () => {
    // All v1 types validate unchanged — adding bundle type does not break them
    makeExtension(tmpRoot, 'agents', 'my-orchestrator');
    makeExtension(tmpRoot, 'skills', 'my-analyzer');
    makeExtension(tmpRoot, 'mcp-servers', 'my-tools');
    makeBundle(tmpRoot, 'my-bundle', [
      { id: 'my-orchestrator', version: '^0.1.0' },
      { id: 'my-analyzer', version: '^0.1.0' },
    ]);

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });
});

// ─── P10 — G-E requires-granularity advisory ─────────────────────────────────
// Tests for the redundant-requires advisory (architecture-v2.md §G-E).
//
// Rule: when extension X has dependencies:[D] and X.requires deep-equals D.requires,
// emit a `warn`-severity advisory. This is NEVER an error — CI stays green.
// A bundle does NOT aggregate requires (bundles have no runtime — G-B).
//
// Acceptance (from migration.md §Phase 10):
//   (a) Advisory is emitted as severity `warn` (never `error`)
//   (b) validateManifests still reports ok:true when the only issue is redundant requires
//   (c) No schema, cascade.ts, or install.ts change is involved
//   (d) Back-compat: v1 manifests with no dependencies / no requires emit no advisory

describe('validate-manifests — P10 G-E requires-granularity advisory', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTempRepo();
  });

  afterEach(() => {
    removeDirRecursive(tmpRoot);
  });

  /** Write a manifest with full control over all fields including dependencies */
  function makeExtensionFull(
    root: string,
    typeDir: string,
    id: string,
    extra: Record<string, unknown>,
  ): void {
    const extDir = path.join(root, 'extensions', typeDir, id);
    fs.mkdirSync(path.join(extDir, 'src'), { recursive: true });

    let type: string;
    if (typeDir === 'mcp-servers') type = 'mcp-server';
    else if (typeDir === 'agents') type = 'agent';
    else if (typeDir === 'skills') type = 'skill';
    else if (typeDir === 'prompts') type = 'prompt';
    else if (typeDir === 'hooks') type = 'hook';
    else type = 'command';

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
    fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), '// stub compiled output\n');
  }

  // ─── CORE ACCEPTANCE: advisory is warn, not error; ok remains true ────────

  it('emits a WARN (not error) when spawner requires deep-equals its dependency requires', () => {
    // Simulates memory-organizer (spawner) and memory-server (spawned dep) both
    // declaring identical requires — the exact scenario from architecture-v2.md §G-E.
    const sharedRequires = { structured_output: true, tool_calling: true };

    // The dependency (e.g. memory-server) declares requires
    makeExtensionFull(tmpRoot, 'mcp-servers', 'memory-server', {
      requires: sharedRequires,
    });

    // The spawner (e.g. memory-organizer) declares the identical requires
    makeExtensionFull(tmpRoot, 'agents', 'memory-organizer', {
      requires: sharedRequires,
      dependencies: ['memory-server'],
    });

    const result = validateManifests(tmpRoot);

    // CRITICAL: ok must be true — the advisory MUST NOT block CI
    expect(result.ok).toBe(true);

    // The advisory must be present and severity must be 'warn'
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

  // ─── advisory message contains the expected guidance ─────────────────────

  it('advisory message recommends keeping requires if extension is installable standalone', () => {
    const sharedRequires = { structured_output: true };

    makeExtensionFull(tmpRoot, 'mcp-servers', 'dep-server', {
      requires: sharedRequires,
    });
    makeExtensionFull(tmpRoot, 'agents', 'spawner-assistant', {
      requires: sharedRequires,
      dependencies: ['dep-server'],
    });

    const result = validateManifests(tmpRoot);
    const advisory = result.errors.find(
      (d) => d.severity === 'warn' && d.message.includes('G-E advisory'),
    );
    expect(advisory).toBeDefined();
    // Message must reference the 'standalone' guidance per architecture-v2.md §G-E
    expect(advisory?.message).toContain('standalone');
    expect(advisory?.message).toContain('redundant but safe');
  });

  // ─── NO advisory when requires differ ────────────────────────────────────

  it('does NOT emit advisory when spawner requires differs from dependency requires', () => {
    // Server declares structured_output; spawner declares tool_calling — different
    makeExtensionFull(tmpRoot, 'mcp-servers', 'data-server', {
      requires: { structured_output: true, tool_calling: false },
    });
    makeExtensionFull(tmpRoot, 'agents', 'data-organizer', {
      requires: { structured_output: false, tool_calling: true },
      dependencies: ['data-server'],
    });

    const result = validateManifests(tmpRoot);
    expect(result.ok).toBe(true);

    const advisory = result.errors.find(
      (d) => d.severity === 'warn' && d.message.includes('G-E advisory'),
    );
    expect(advisory).toBeUndefined();
  });

  // ─── NO advisory when extension has no dependencies ───────────────────────

  it('does NOT emit advisory when extension has no dependencies field', () => {
    makeExtensionFull(tmpRoot, 'mcp-servers', 'standalone-server', {
      requires: { structured_output: true, tool_calling: true },
      // no dependencies field
    });

    const result = validateManifests(tmpRoot);
    expect(result.ok).toBe(true);
    const advisory = result.errors.find(
      (d) => d.severity === 'warn' && d.message.includes('G-E advisory'),
    );
    expect(advisory).toBeUndefined();
  });

  // ─── NO advisory when extension has no requires ───────────────────────────

  it('does NOT emit advisory when extension has no requires block', () => {
    makeExtensionFull(tmpRoot, 'mcp-servers', 'provider-free-server', {
      // no requires block
    });
    makeExtensionFull(tmpRoot, 'agents', 'provider-free-organizer', {
      // no requires block either
      dependencies: ['provider-free-server'],
    });

    const result = validateManifests(tmpRoot);
    expect(result.ok).toBe(true);
    const advisory = result.errors.find(
      (d) => d.severity === 'warn' && d.message.includes('G-E advisory'),
    );
    expect(advisory).toBeUndefined();
  });

  // ─── NO advisory when dependency is not in the local registry ─────────────

  it('does NOT emit advisory when the dependency id is not in the local registry', () => {
    // Spawner depends on an extension that is not registered locally (external dep)
    makeExtensionFull(tmpRoot, 'agents', 'external-caller', {
      requires: { structured_output: true },
      dependencies: ['external-service-not-in-registry'],
    });

    const result = validateManifests(tmpRoot);
    expect(result.ok).toBe(true);
    // No advisory — dep not resolvable locally
    const advisory = result.errors.find(
      (d) => d.severity === 'warn' && d.message.includes('G-E advisory'),
    );
    expect(advisory).toBeUndefined();
  });

  // ─── BACK-COMPAT: v1 manifests (no dependencies) emit no advisory ─────────

  it('passes all v1 manifests (no dependencies field) without any G-E advisory', () => {
    // All existing v1 manifests: no dependencies field → no advisory → ok:true unchanged
    makeExtension(tmpRoot, 'agents', 'v1-orchestrator');
    makeExtension(tmpRoot, 'skills', 'v1-summarizer');
    makeExtension(tmpRoot, 'mcp-servers', 'v1-tools');
    makeExtension(tmpRoot, 'hooks', 'v1-pre-tool');
    makeExtension(tmpRoot, 'commands', 'v1-shell-runner');

    const result = validateManifests(tmpRoot);
    expect(result.ok).toBe(true);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    const advisories = result.errors.filter(
      (d) => d.severity === 'warn' && d.message.includes('G-E advisory'),
    );
    expect(advisories).toHaveLength(0);
  });

  // ─── min_context_tokens is included in deep-equality comparison ──────────

  it('emits advisory when min_context_tokens also matches between spawner and dep', () => {
    const sharedRequires = { structured_output: true, min_context_tokens: 32000 };

    makeExtensionFull(tmpRoot, 'mcp-servers', 'big-context-server', {
      requires: sharedRequires,
    });
    makeExtensionFull(tmpRoot, 'agents', 'big-context-orchestrator', {
      requires: sharedRequires,
      dependencies: ['big-context-server'],
    });

    const result = validateManifests(tmpRoot);
    expect(result.ok).toBe(true);
    const advisory = result.errors.find(
      (d) => d.severity === 'warn' && d.message.includes('G-E advisory'),
    );
    expect(advisory).toBeDefined();
  });

  it('does NOT emit advisory when min_context_tokens differs (not deep-equal)', () => {
    makeExtensionFull(tmpRoot, 'mcp-servers', 'ctx-server', {
      requires: { structured_output: true, min_context_tokens: 16000 },
    });
    makeExtensionFull(tmpRoot, 'agents', 'ctx-organizer', {
      requires: { structured_output: true, min_context_tokens: 32000 }, // differs
      dependencies: ['ctx-server'],
    });

    const result = validateManifests(tmpRoot);
    expect(result.ok).toBe(true);
    const advisory = result.errors.find(
      (d) => d.severity === 'warn' && d.message.includes('G-E advisory'),
    );
    expect(advisory).toBeUndefined();
  });
});

// ─── P2 — Manifest self-description contract (OPTIONAL-FIRST) ────────────────
// Verifies that the new P2 self-description fields (`keywords`, `author`,
// `homepage`, `repository`, `tags`) are OPTIONAL — existing manifests without
// them continue to validate, and manifests that include them also validate.
//
// Hard constraint: none of these fields may ever be in `required` in this phase.
// The validator is read-only with respect to these fields in P2 (no lint rules
// are added for them; enforcement is deferred to P5/P6 strict mode).

describe('validate-manifests — P2 self-description contract (OPTIONAL-FIRST)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTempRepo();
  });

  afterEach(() => {
    removeDirRecursive(tmpRoot);
  });

  /** Write a manifest that includes all P2 self-description fields */
  function makeExtensionWithSelfDescription(
    root: string,
    typeDir: string,
    id: string,
    selfDescription: Record<string, unknown>,
  ): void {
    const extDir = path.join(root, 'extensions', typeDir, id);
    fs.mkdirSync(path.join(extDir, 'src'), { recursive: true });

    let type: string;
    if (typeDir === 'mcp-servers') type = 'mcp-server';
    else if (typeDir === 'agents') type = 'agent';
    else if (typeDir === 'skills') type = 'skill';
    else if (typeDir === 'prompts') type = 'prompt';
    else if (typeDir === 'hooks') type = 'hook';
    else if (typeDir === 'commands') type = 'command';
    else type = 'bundle';

    const manifest = {
      $schema: 'https://your-registry/schemas/extension/v1.json',
      id,
      version: '0.1.0',
      type,
      title: `${id} title`,
      description: `Use this when you need ${id} functionality`,
      compatibility: { host: '>=1.0.0 <2.0.0' },
      license: 'MIT',
      entrypoint: type === 'prompt' || type === 'bundle' ? undefined : 'dist/index.js',
      // P3: include required self-description fields by default so these fixtures don't
      // trigger P3 errors (the explicit selfDescription spread may override them)
      ...p3SelfDescription(type),
      ...selfDescription,
    };
    fs.writeFileSync(path.join(extDir, 'extension.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: `@adhd/sox-extension-${id}`, version: '0.1.0' }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
    fs.writeFileSync(path.join(extDir, 'src', 'index.ts'), '// stub\n');
    // P0 entrypoint-reachability: create dist/index.js stub so the gate passes in tests
    if (type !== 'prompt' && type !== 'bundle') {
      fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), '// stub compiled output\n');
    }
  }

  // ─── P3 acceptance: all 11 retrofitted real manifests validate with zero errors ──

  it('passes for the real repo extensions with all P3 self-description fields present (P3 acceptance)', () => {
    // Point at the actual repo root — all 11 manifests have been retrofitted by P3.
    // Must validate with zero errors and zero P3 self-description diagnostics.
    const repoRoot = path.resolve(__dirname, '..');
    const result = validateManifests(repoRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
    // No P3 self-description diagnostics
    const p3Diags = result.errors.filter((d) => d.message.startsWith('P3:'));
    expect(p3Diags).toHaveLength(0);
  });

  // ─── PASS: manifests with keywords array validate ─────────────────────────

  it('passes when manifest declares keywords as a string array', () => {
    makeExtensionWithSelfDescription(tmpRoot, 'skills', 'catalog-indexer', {
      keywords: ['memory', 'indexing', 'search'],
    });
    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  // ─── PASS: manifests with author as string validate ───────────────────────

  it('passes when manifest declares author as a plain string', () => {
    makeExtensionWithSelfDescription(tmpRoot, 'agents', 'catalog-orchestrator', {
      author: 'Jane Dev <jane@example.com>',
    });
    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  // ─── PASS: manifests with author as structured object validate ────────────

  it('passes when manifest declares author as an object with name/email/url', () => {
    makeExtensionWithSelfDescription(tmpRoot, 'agents', 'structured-author-assistant', {
      author: {
        name: 'Jane Dev',
        email: 'jane@example.com',
        url: 'https://example.com',
      },
    });
    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  // ─── PASS: manifests with homepage uri validate ───────────────────────────

  it('passes when manifest declares homepage as a URI string', () => {
    makeExtensionWithSelfDescription(tmpRoot, 'skills', 'documented-analyzer', {
      homepage: 'https://docs.example.com/analyzed',
    });
    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  // ─── PASS: manifests with repository uri validate ─────────────────────────

  it('passes when manifest declares repository as a URI string', () => {
    makeExtensionWithSelfDescription(tmpRoot, 'mcp-servers', 'open-source-tools', {
      repository: 'https://github.com/example/open-source-tools',
    });
    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  // ─── PASS: manifests with tags array validate ─────────────────────────────

  it('passes when manifest declares tags as a string array', () => {
    makeExtensionWithSelfDescription(tmpRoot, 'hooks', 'pre-tool-use', {
      tags: ['productivity', 'coding'],
    });
    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  // ─── PASS: manifest with ALL P2 fields populated validates ────────────────

  it('passes when manifest declares all P2 self-description fields at once', () => {
    makeExtensionWithSelfDescription(tmpRoot, 'agents', 'fully-described-assistant', {
      keywords: ['memory', 'recall', 'long-term'],
      tags: ['productivity'],
      author: {
        name: 'Sox Dev',
        email: 'dev@adhd-ecosystem.dev',
      },
      homepage: 'https://sox-ecosystem.dev/extensions/fully-described-assistant',
      repository: 'https://github.com/sox-ecosystem/fully-described-assistant',
    });
    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  // ─── PASS: P3 fields present = no errors (P4 advisory warnings are expected) ───

  it('emits no error when all P3 self-description fields are present (P4 advisory warnings may exist)', () => {
    // Control: standard manifest with P3 self-description fields (included by makeExtension)
    makeExtension(tmpRoot, 'skills', 'bare-minimum');
    const result = validateManifests(tmpRoot);
    // ok is still true: P3 fields are present; P4 advisory rules produce warnings (not errors) in default mode
    expect(result.ok).toBe(true);
    // No P3 self-description errors
    const p3HardErrors = result.errors.filter(
      (d) => d.severity === 'error' && d.message.startsWith('P3:'),
    );
    expect(p3HardErrors).toHaveLength(0);
  });

  // ─── PASS: P2 fields coexist with existing optional fields ───────────────

  it('passes when P2 fields are combined with existing optional fields (tags, runtime, requires)', () => {
    makeExtensionWithSelfDescription(tmpRoot, 'agents', 'fully-featured-assistant', {
      keywords: ['ai', 'orchestration'],
      tags: ['enterprise'],
      author: 'Team Sox',
      homepage: 'https://example.com',
      repository: 'https://github.com/example/fully-featured-assistant',
      runtime: 'node',
      requires: { tool_calling: true, structured_output: true },
    });
    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });
});

// ─── P4 — DX-conformance advisory rules (fail-open / --strict) ───────────────
//
// Enforcement posture (§5.2):
//   default mode   — advisory checks emit severity:'warn', ok=true, exit 0 (fail-open)
//   strict mode    — advisory checks emit severity:'error', ok=false, exit non-zero
//
// The 11 existing extensions fail advisory rules (no README, empty author, no keywords,
// non-guidance descriptions). They MUST pass default mode and MUST fail strict mode.
// A freshly scaffolded conformant extension MUST pass even strict mode.

describe('validate-manifests — P4 DX-conformance advisory rules', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTempRepo();
  });

  afterEach(() => {
    removeDirRecursive(tmpRoot);
  });

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** Create an extension that is NON-conformant (missing all advisory fields). */
  function makeNonConformantExtension(root: string, typeDir: string, id: string): void {
    const extDir = path.join(root, 'extensions', typeDir, id);
    fs.mkdirSync(path.join(extDir, 'src'), { recursive: true });

    let type: string;
    if (typeDir === 'mcp-servers') type = 'mcp-server';
    else if (typeDir === 'agents') type = 'agent';
    else if (typeDir === 'skills') type = 'skill';
    else if (typeDir === 'prompts') type = 'prompt';
    else if (typeDir === 'hooks') type = 'hook';
    else if (typeDir === 'commands') type = 'command';
    else type = 'bundle';

    // Manifest mirrors DX-non-conformant extensions:
    //   - description is non-empty but NOT invocation-guidance-shaped
    //   - author is empty string (present but blank)
    //   - keywords is absent
    //   - no README.md
    // P3: self-description fields ARE included (P3 is required; DX non-conformance is separate)
    const manifest = {
      $schema: 'https://your-registry/schemas/extension/v1.json',
      id,
      version: '0.1.0',
      type,
      title: `${id} title`,
      description: `A stub ${type} that does something interesting`,
      compatibility: { host: '>=1.0.0 <2.0.0' },
      license: 'MIT',
      author: '',
      entrypoint: type === 'prompt' ? undefined : 'dist/index.js',
      // P3: required self-description fields included so only DX issues trigger
      ...p3SelfDescription(type),
    };
    fs.writeFileSync(path.join(extDir, 'extension.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: `@adhd/sox-${id}`, version: '0.1.0' }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
    if (type !== 'prompt') {
      fs.writeFileSync(path.join(extDir, 'src', 'index.ts'), '// stub\n');
    }
    // NOTE: intentionally NO README.md — this is the non-conformant state
    // P0 entrypoint-reachability: create dist/index.js stub so the gate passes in tests
    if (type !== 'prompt') {
      fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), '// stub compiled output\n');
    }
  }

  /**
   * Create a fully conformant extension (passes all advisory rules):
   *   - invocation-guidance description
   *   - non-empty keywords array
   *   - non-empty author
   *   - substantive README.md (>100 chars, no lorem ipsum)
   */
  function makeConformantExtension(root: string, typeDir: string, id: string): void {
    const extDir = path.join(root, 'extensions', typeDir, id);
    fs.mkdirSync(path.join(extDir, 'src'), { recursive: true });

    let type: string;
    if (typeDir === 'mcp-servers') type = 'mcp-server';
    else if (typeDir === 'agents') type = 'agent';
    else if (typeDir === 'skills') type = 'skill';
    else if (typeDir === 'prompts') type = 'prompt';
    else if (typeDir === 'hooks') type = 'hook';
    else if (typeDir === 'commands') type = 'command';
    else type = 'bundle';

    const manifest = {
      $schema: 'https://your-registry/schemas/extension/v1.json',
      id,
      version: '0.1.0',
      type,
      title: `${id} title`,
      description: `use this when you need a ${type} for testing DX conformance`,
      keywords: ['testing', 'conformance', type],
      author: 'Test Suite',
      compatibility: { host: '>=1.0.0 <2.0.0' },
      license: 'MIT',
      entrypoint: type === 'prompt' ? undefined : 'dist/index.js',
      // P3: include required self-description fields so conformant extensions pass P3 too
      ...p3SelfDescription(type),
    };
    fs.writeFileSync(path.join(extDir, 'extension.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: `@adhd/sox-${id}`, version: '0.1.0' }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
    if (type !== 'prompt') {
      fs.writeFileSync(path.join(extDir, 'src', 'index.ts'), '// stub\n');
      // P0 entrypoint-reachability: create dist/index.js stub so the gate passes in tests
      fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), '// stub compiled output\n');
    }
    // Substantive README: >100 chars, no lorem ipsum
    fs.writeFileSync(
      path.join(extDir, 'README.md'),
      `# ${id}\n\n` +
      `> use this when you need a ${type} for testing DX conformance\n\n` +
      `## Overview\n\nThis ${type} is used for testing the DX-conformance advisory rules.\n\n` +
      `## When to use\n\nUse this ${type} when you need to verify that advisory conformance checks work.\n\n` +
      `## Inputs\n\nNone required.\n\n## Outputs\n\nConformance check result.\n`,
    );
  }

  // ─── Default mode: fail-open ───────────────────────────────────────────────

  it('default mode: exits ok=true even when advisory issues are present (fail-open)', () => {
    makeNonConformantExtension(tmpRoot, 'skills', 'non-conformant-one');
    const result = validateManifests(tmpRoot);
    // ok must be true: advisory warnings do not fail default mode
    expect(result.ok).toBe(true);
    // but warnings must be present
    const warnings = result.errors.filter((d) => d.severity === 'warn');
    expect(warnings.length).toBeGreaterThan(0);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('default mode: emits DX warnings for empty author field', () => {
    makeNonConformantExtension(tmpRoot, 'skills', 'no-author-ext');
    const result = validateManifests(tmpRoot);
    const warnings = result.errors.filter((d) => d.severity === 'warn');
    const authorWarn = warnings.find((w) => w.message.includes('author'));
    expect(authorWarn).toBeDefined();
    expect(result.ok).toBe(true);
  });

  it('default mode: emits DX warnings for missing keywords', () => {
    makeNonConformantExtension(tmpRoot, 'skills', 'no-keywords-ext');
    const result = validateManifests(tmpRoot);
    const warnings = result.errors.filter((d) => d.severity === 'warn');
    const kwWarn = warnings.find((w) => w.message.includes('keywords'));
    expect(kwWarn).toBeDefined();
    expect(result.ok).toBe(true);
  });

  it('default mode: emits DX warnings for missing README', () => {
    makeNonConformantExtension(tmpRoot, 'skills', 'no-readme-ext');
    const result = validateManifests(tmpRoot);
    const warnings = result.errors.filter((d) => d.severity === 'warn');
    const readmeWarn = warnings.find((w) => w.message.includes('README'));
    expect(readmeWarn).toBeDefined();
    expect(result.ok).toBe(true);
  });

  it('default mode: emits DX warnings for non-guidance-shaped description', () => {
    makeNonConformantExtension(tmpRoot, 'skills', 'bad-desc-ext');
    const result = validateManifests(tmpRoot);
    const warnings = result.errors.filter((d) => d.severity === 'warn');
    const descWarn = warnings.find((w) => w.message.includes('description'));
    expect(descWarn).toBeDefined();
    expect(result.ok).toBe(true);
  });

  it('default mode: emits DX warnings for empty description', () => {
    const extDir = path.join(tmpRoot, 'extensions', 'skills', 'empty-desc');
    fs.mkdirSync(path.join(extDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'empty-desc',
        version: '0.1.0',
        type: 'skill',
        title: 'Empty Desc',
        description: '',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js',
        // P3: required for skill type — present so only DX warning (empty description) triggers
        run_interface: {
          input_schema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
          output_schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
        },
      }),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-empty-desc', version: '0.1.0' }),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
    fs.writeFileSync(path.join(extDir, 'src', 'index.ts'), '// stub\n');
    // P0 entrypoint-reachability: create dist/index.js stub so the gate passes in tests
    fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), '// stub compiled output\n');

    const result = validateManifests(tmpRoot);
    const warnings = result.errors.filter((d) => d.severity === 'warn');
    const descWarn = warnings.find((w) => w.message.includes('description is empty'));
    expect(descWarn).toBeDefined();
    expect(result.ok).toBe(true);
  });

  // ─── Default mode: README placeholder check ───────────────────────────────

  it('default mode: warns when README.md exists but is a lorem ipsum placeholder', () => {
    makeNonConformantExtension(tmpRoot, 'skills', 'lorem-readme');
    const extDir = path.join(tmpRoot, 'extensions', 'skills', 'lorem-readme');
    fs.writeFileSync(path.join(extDir, 'README.md'), 'Lorem ipsum dolor sit amet consectetur adipiscing elit');
    const result = validateManifests(tmpRoot);
    const warnings = result.errors.filter((d) => d.severity === 'warn');
    const readmeWarn = warnings.find((w) => w.message.includes('README') && w.message.includes('placeholder'));
    expect(readmeWarn).toBeDefined();
    expect(result.ok).toBe(true);
  });

  it('default mode: warns when README.md exists but is too short (<100 chars)', () => {
    makeNonConformantExtension(tmpRoot, 'skills', 'short-readme');
    const extDir = path.join(tmpRoot, 'extensions', 'skills', 'short-readme');
    fs.writeFileSync(path.join(extDir, 'README.md'), '# Short README\n\nToo brief.');
    const result = validateManifests(tmpRoot);
    const warnings = result.errors.filter((d) => d.severity === 'warn');
    const readmeWarn = warnings.find((w) => w.message.includes('README') && w.message.includes('placeholder'));
    expect(readmeWarn).toBeDefined();
    expect(result.ok).toBe(true);
  });

  // ─── Strict mode: fail-closed ─────────────────────────────────────────────

  it('strict mode: exits ok=false when any advisory issue is present', () => {
    makeNonConformantExtension(tmpRoot, 'skills', 'strict-test-ext');
    const result = validateManifests(tmpRoot, { strict: true });
    // In strict mode advisory issues become errors → ok must be false
    expect(result.ok).toBe(false);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
    // P4 DX-conformance advisory issues are promoted to errors in strict mode.
    // P3 self-description errors (missing events/invocation/tools/etc.) are ALWAYS errors
    // (required, not advisory) — they do not change between default and strict modes.
    // The invariant is that P4 advisory issues appear as errors in strict mode, not warns.
    const p4Warnings = result.errors.filter(
      (d) => d.severity === 'warn' && d.message.includes('P4 advisory'),
    );
    expect(p4Warnings).toHaveLength(0); // P4 warns promoted to errors in strict mode
  });

  it('strict mode: DX advisory issues are emitted as severity:error (not warn)', () => {
    makeNonConformantExtension(tmpRoot, 'skills', 'strict-errors-ext');
    const result = validateManifests(tmpRoot, { strict: true });
    const errors = result.errors.filter((d) => d.severity === 'error');
    // Expect errors for: description shape, keywords, author, README
    const hasAuthorError = errors.some((e) => e.message.includes('author'));
    const hasKeywordsError = errors.some((e) => e.message.includes('keywords'));
    const hasReadmeError = errors.some((e) => e.message.includes('README'));
    const hasDescError = errors.some((e) => e.message.includes('description'));
    expect(hasAuthorError).toBe(true);
    expect(hasKeywordsError).toBe(true);
    expect(hasReadmeError).toBe(true);
    expect(hasDescError).toBe(true);
  });

  it('strict mode: exits ok=false for multiple non-conformant extensions', () => {
    makeNonConformantExtension(tmpRoot, 'skills', 'strict-multi-one');
    makeNonConformantExtension(tmpRoot, 'agents', 'strict-multi-two');
    const result = validateManifests(tmpRoot, { strict: true });
    expect(result.ok).toBe(false);
    const errors = result.errors.filter((d) => d.severity === 'error');
    // At least 4 rules × 2 extensions = 8+ errors
    expect(errors.length).toBeGreaterThanOrEqual(8);
  });

  // ─── Strict mode: conformant extension passes ─────────────────────────────

  it('strict mode: ok=true for a fully conformant extension', () => {
    makeConformantExtension(tmpRoot, 'skills', 'conformant-ext');
    const result = validateManifests(tmpRoot, { strict: true });
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it('strict mode: ok=true for multiple fully conformant extensions', () => {
    makeConformantExtension(tmpRoot, 'skills', 'conformant-two');
    makeConformantExtension(tmpRoot, 'agents', 'conformant-three');
    const result = validateManifests(tmpRoot, { strict: true });
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  // ─── The 11 existing extensions: both default and strict pass (P5 retrofitted) ─
  //
  // This test runs against the ACTUAL repo extensions/ tree — no fixtures needed.
  // P5 retrofitted all 11 with description, keywords, author, and README so that
  // --strict now passes (prerequisite for the P6 fail-closed flip).
  //
  // P3 NOTE: All 11 manifests have been retrofitted with their type-specific self-description
  // fields (P3 complete). The P3 checks are now severity:'error' (required). All 11 manifests
  // must pass with zero errors and zero P3 self-description diagnostics.

  it('live repo: default mode exits ok=true on the 11 retrofitted extensions', () => {
    const ROOT = path.resolve(import.meta.dirname ?? process.cwd(), '..');
    const result = validateManifests(ROOT);
    // ok must be true: all 11 manifests are retrofitted, no P3 self-description errors.
    expect(result.ok).toBe(true);
    // P3: all retrofitted — zero errors expected.
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    // P3: no P3 self-description diagnostics (all fields present).
    const p3Diags = result.errors.filter(
      (d) => d.message.startsWith('P3:'),
    );
    expect(p3Diags).toHaveLength(0);
  });

  it('live repo: strict mode exits ok=true on the 11 retrofitted extensions (P5)', () => {
    const ROOT = path.resolve(import.meta.dirname ?? process.cwd(), '..');
    const result = validateManifests(ROOT, { strict: true });
    // P5: all 11 DX-conformance rules are satisfied — strict mode exits 0.
    // P3: all manifests retrofitted — no self-description errors.
    expect(result.ok).toBe(true);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  // ─── Single-dir mode (validateSingleExtensionDir path) ────────────────────

  it('single-dir default mode: ok=true with warnings for non-conformant extension', () => {
    const extDir = path.join(tmpRoot, 'my-ext');
    fs.mkdirSync(path.join(extDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'my-ext',
        version: '0.1.0',
        type: 'skill',
        title: 'My Extension',
        description: 'A non-guidance description that will warn',
        author: '',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js',
      }),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-my-ext', version: '0.1.0' }),
    );
    fs.writeFileSync(path.join(extDir, 'src', 'index.ts'), '// stub\n');
    // P0 entrypoint-reachability: create dist/index.js stub so the gate passes in tests
    fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), '// stub compiled output\n');

    // Pass the extension dir directly (single-dir mode)
    const result = validateManifests(extDir);
    expect(result.ok).toBe(true);
    const warnings = result.errors.filter((d) => d.severity === 'warn');
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('single-dir strict mode: ok=false for non-conformant extension', () => {
    const extDir = path.join(tmpRoot, 'my-strict-ext');
    fs.mkdirSync(path.join(extDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'my-strict-ext',
        version: '0.1.0',
        type: 'skill',
        title: 'My Strict Extension',
        description: 'Non-guidance description',
        author: '',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js',
      }),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-my-strict-ext', version: '0.1.0' }),
    );
    fs.writeFileSync(path.join(extDir, 'src', 'index.ts'), '// stub\n');

    const result = validateManifests(extDir, { strict: true });
    expect(result.ok).toBe(false);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('single-dir strict mode: ok=true for fully conformant extension', () => {
    const extDir = path.join(tmpRoot, 'my-good-ext');
    fs.mkdirSync(path.join(extDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'my-good-ext',
        version: '0.1.0',
        type: 'skill',
        title: 'My Good Extension',
        description: 'use this when you need to verify DX conformance in single-dir mode',
        keywords: ['testing', 'conformance'],
        author: 'Test Author',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js',
      }),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-my-good-ext', version: '0.1.0' }),
    );
    fs.writeFileSync(path.join(extDir, 'src', 'index.ts'), '// stub\n');
    // P0 entrypoint-reachability: create dist/index.js stub so the gate passes in tests
    fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), '// stub compiled output\n');
    fs.writeFileSync(
      path.join(extDir, 'README.md'),
      `# my-good-ext\n\n` +
      `> use this when you need to verify DX conformance in single-dir mode\n\n` +
      `## Overview\n\nA test extension for verifying DX conformance rules.\n\n` +
      `## When to use\n\nUse this extension when running P4 conformance tests.\n\n` +
      `## Inputs\n\nNone.\n\n## Outputs\n\nConformance pass/fail result.\n`,
    );

    const result = validateManifests(extDir, { strict: true });
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  // ─── Guidance-shaped description acceptance ───────────────────────────────

  it('accepts description starting with "use this when"', () => {
    const extDir = path.join(tmpRoot, 'extensions', 'skills', 'use-this-probe');
    fs.mkdirSync(path.join(extDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'use-this-probe',
        version: '0.1.0',
        type: 'skill',
        title: 'Use This Probe',
        description: 'use this when you need to probe the description rule',
        keywords: ['probe'],
        author: 'Test Suite',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js',
      }),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-use-this-probe', version: '0.1.0' }),
    );
    fs.writeFileSync(path.join(extDir, 'src', 'index.ts'), '// stub\n');
    fs.writeFileSync(
      path.join(extDir, 'README.md'),
      `# use-this-probe\n\nuse this when you need to probe the description rule.\n\n` +
      `## Overview\nProbe extension for testing description guidance shape.\n\n` +
      `## When to use\nWhen testing the guidance shape rule.\n\n` +
      `## Inputs\nNone.\n\n## Outputs\nNothing.\n`,
    );

    const result = validateManifests(tmpRoot, { strict: true });
    const dxDescErrors = result.errors.filter(
      (e) => e.severity === 'error' && e.message.includes('description') && e.path.includes('use-this-probe'),
    );
    expect(dxDescErrors).toHaveLength(0);
  });

  it('accepts description starting with an action verb (e.g. "fetches")', () => {
    const extDir = path.join(tmpRoot, 'extensions', 'skills', 'fetch-data');
    fs.mkdirSync(path.join(extDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'fetch-data',
        version: '0.1.0',
        type: 'skill',
        title: 'Fetch Data',
        description: 'fetches data from a remote source and returns it structured',
        keywords: ['fetch', 'data'],
        author: 'Test Suite',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js',
      }),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-fetch-data', version: '0.1.0' }),
    );
    fs.writeFileSync(path.join(extDir, 'src', 'index.ts'), '// stub\n');
    fs.writeFileSync(
      path.join(extDir, 'README.md'),
      `# fetch-data\n\nfetches data from a remote source.\n\n` +
      `## Overview\nA skill that fetches remote data.\n\n` +
      `## When to use\nWhen you need to retrieve remote data.\n\n` +
      `## Inputs\nURL parameter.\n\n## Outputs\nStructured data object.\n`,
    );

    const result = validateManifests(tmpRoot, { strict: true });
    const dxDescErrors = result.errors.filter(
      (e) => e.severity === 'error' && e.message.includes('description') && e.path.includes('fetch-data'),
    );
    expect(dxDescErrors).toHaveLength(0);
  });

  // ─── Hard errors still fail in default mode ───────────────────────────────
  //
  // Advisory rules must not accidentally shadow hard errors.
  // A manifest with both a hard error (bad id format) and advisory issues must still
  // exit ok=false in default mode.

  it('default mode: hard errors still cause ok=false even with advisory warnings present', () => {
    // Create an extension with invalid id format (hard error) AND advisory issues
    const extDir = path.join(tmpRoot, 'extensions', 'skills', 'bad_id_format');
    fs.mkdirSync(path.join(extDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'bad_id_format', // underscore — hard error
        version: '0.1.0',
        type: 'skill',
        title: 'Bad ID',
        description: '', // also advisory issue
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js',
      }),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-bad-id', version: '0.1.0' }),
    );
    fs.writeFileSync(path.join(extDir, 'src', 'index.ts'), '// stub\n');

    const result = validateManifests(tmpRoot);
    // Hard error (bad_id_format) must still cause ok=false
    expect(result.ok).toBe(false);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors.some((e) => e.message.includes('bad_id_format'))).toBe(true);
  });

  // ─── ValidateOptions type is exported and usable ──────────────────────────

  it('ValidateOptions type: { strict: true } accepted without type errors', () => {
    const opts: ValidateOptions = { strict: true };
    makeConformantExtension(tmpRoot, 'skills', 'opts-type-check');
    const result = validateManifests(tmpRoot, opts);
    // Type-level test: if ValidateOptions import compiles, this line runs
    expect(typeof result.ok).toBe('boolean');
  });
});

// ─── PB — Per-extension config schema + resource/permission declaration ─────────
//
// Phase B acceptance tests (closes Gap F3 — config never validated; Gap A6 — no permission decl).
//
// Acceptance criteria:
//   1. validateConfigAgainstSchema: a config that VIOLATES the declared schema FAILS (errors returned)
//   2. validateConfigAgainstSchema: a config that satisfies the declared schema passes (no errors)
//   3. validateManifests: a manifest with a valid config_schema object declaration passes
//   4. validateManifests: a manifest with config_schema as a non-object (array) errors
//   5. validateManifests: a manifest with a valid permissions block passes
//   6. validateManifests: a manifest with malformed permissions.fs.read (non-array) errors
//   7. Back-compat: manifests without config_schema / permissions fields still validate (optional-first)
//   8. Live repo: all 11 retrofitted manifests pass with PB fields present
//
// ENFORCEMENT NOTE for P4/P5: validateConfigAgainstSchema must be wired in scripts/install.ts
// after scope-cascade resolution for each extension that declares a config_schema (Gap F3).
// The permissions block (Gaps F5/A6) is declared here; runtime sandboxing is P4/P5 responsibility.

describe('validate-manifests — PB config schema + resource/permission declaration', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTempRepo();
  });

  afterEach(() => {
    removeDirRecursive(tmpRoot);
  });

  // ─── 1. CORE ACCEPTANCE: config violating declared schema FAILS (Gap F3) ─────
  //
  // An extension declares config_schema requiring db_path to be a string.
  // A config that supplies a number for db_path must produce validation errors.
  // This proves the declaration is enforced, not advisory.

  it('validateConfigAgainstSchema: config violating declared schema produces errors (Gap F3)', () => {
    const configSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['db_path'],
      properties: {
        db_path: { type: 'string' },
        token_budget: { type: 'integer', minimum: 256 },
      },
    };

    // VIOLATION: db_path is a number (not a string) AND token_budget is below minimum
    const violatingConfig = { db_path: 42, token_budget: 100 };

    const diags = validateConfigAgainstSchema(
      violatingConfig,
      configSchema,
      'memory-server',
      '/fake/path/extension.json',
    );

    expect(diags.length).toBeGreaterThan(0);
    const configErrors = diags.filter((d) => d.severity === 'error');
    expect(configErrors.length).toBeGreaterThan(0);
    // Must reference Gap F3 in the message (Gap closure signal)
    expect(configErrors[0]!.message).toContain('Gap F3');
    // Must identify the violating field or constraint
    const mentionsViolation = configErrors.some(
      (d) => d.message.includes('db_path') || d.message.includes('string') || d.message.includes('must'),
    );
    expect(mentionsViolation).toBe(true);
  });

  it('validateConfigAgainstSchema: config missing required field FAILS', () => {
    const configSchema = {
      type: 'object',
      required: ['db_path'],
      properties: {
        db_path: { type: 'string' },
      },
    };

    // VIOLATION: required field db_path is absent
    const violatingConfig: Record<string, unknown> = {};

    const diags = validateConfigAgainstSchema(
      violatingConfig,
      configSchema,
      'memory-server',
      '/fake/path/extension.json',
    );

    expect(diags.length).toBeGreaterThan(0);
    const errors = diags.filter((d) => d.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toContain('Gap F3');
  });

  // ─── 2. Config satisfying schema passes ──────────────────────────────────────

  it('validateConfigAgainstSchema: valid config produces no errors', () => {
    const configSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['db_path'],
      properties: {
        db_path: { type: 'string' },
        token_budget: { type: 'integer', minimum: 256 },
      },
    };

    const validConfig = { db_path: '/home/user/.memory/memory.db', token_budget: 4000 };

    const diags = validateConfigAgainstSchema(
      validConfig,
      configSchema,
      'memory-server',
      '/fake/path/extension.json',
    );

    expect(diags).toHaveLength(0);
  });

  it('validateConfigAgainstSchema: empty config passes when schema has no required fields', () => {
    const configSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {},
    };

    const diags = validateConfigAgainstSchema(
      {},
      configSchema,
      'echo',
      '/fake/path/extension.json',
    );
    expect(diags).toHaveLength(0);
  });

  // ─── 3. config_schema structural declaration: valid object passes ─────────────

  it('validateManifests: manifest with a valid config_schema object passes', () => {
    const extDir = path.join(tmpRoot, 'extensions', 'skills', 'schema-declared');
    fs.mkdirSync(path.join(extDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'schema-declared',
        version: '0.1.0',
        type: 'skill',
        title: 'Schema Declared',
        description: 'use this when you need a skill that declares a config schema',
        keywords: ['test'],
        author: 'Test Suite',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js',
        // P3: required for skill type
        run_interface: {
          input_schema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
          output_schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
        },
        config_schema: {
          type: 'object',
          required: ['api_key'],
          properties: { api_key: { type: 'string' } },
        },
      }),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-schema-declared', version: '0.1.0' }),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
    fs.writeFileSync(path.join(extDir, 'src', 'index.ts'), '// stub\n');
    // P0 entrypoint-reachability: create dist/index.js stub so the gate passes in tests
    fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), '// stub compiled output\n');

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  // ─── 4. config_schema structural validation: non-object (array) errors ────────

  it('validateManifests: manifest with config_schema as array produces error', () => {
    const extDir = path.join(tmpRoot, 'extensions', 'skills', 'bad-schema');
    fs.mkdirSync(path.join(extDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'bad-schema',
        version: '0.1.0',
        type: 'skill',
        title: 'Bad Schema',
        description: 'use this when testing bad config_schema',
        keywords: ['test'],
        author: 'Test Suite',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js',
        config_schema: ['not', 'an', 'object'],
      }),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-bad-schema', version: '0.1.0' }),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
    fs.writeFileSync(path.join(extDir, 'src', 'index.ts'), '// stub\n');

    const result = validateManifests(tmpRoot);
    expect(result.ok).toBe(false);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(
      errors.some((e) => e.message.includes('config_schema') && e.message.includes('JSON Schema object')),
    ).toBe(true);
  });

  // ─── 5. permissions block: valid declaration passes ───────────────────────────

  it('validateManifests: manifest with valid permissions block passes', () => {
    const extDir = path.join(tmpRoot, 'extensions', 'mcp-servers', 'perms-declared');
    fs.mkdirSync(path.join(extDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'perms-declared',
        version: '0.1.0',
        type: 'mcp-server',
        title: 'Perms Declared',
        description: 'use this when testing permission declarations',
        keywords: ['test'],
        author: 'Test Suite',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js',
        // P3: required for mcp-server type
        tools: [{ name: 'perms_tool', description: 'use this when you need perms_tool' }],
        permissions: {
          fs: { read: ['~/.memory/**'], write: ['~/.memory/**'] },
          network: { outbound: ['api.openai.com'] },
          socket: { paths: ['~/.memory/memoryd.sock'] },
        },
      }),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-perms-declared', version: '0.1.0' }),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
    fs.writeFileSync(path.join(extDir, 'src', 'index.ts'), '// stub\n');
    // P0 entrypoint-reachability: create dist/index.js stub so the gate passes in tests
    fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), '// stub compiled output\n');

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  // ─── 6. permissions structural validation: non-array fs.read errors ───────────

  it('validateManifests: manifest with permissions.fs.read as non-array produces error', () => {
    const extDir = path.join(tmpRoot, 'extensions', 'mcp-servers', 'bad-perms');
    fs.mkdirSync(path.join(extDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'bad-perms',
        version: '0.1.0',
        type: 'mcp-server',
        title: 'Bad Perms',
        description: 'use this when testing invalid permissions declarations',
        keywords: ['test'],
        author: 'Test Suite',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js',
        permissions: {
          fs: { read: '~/.memory/**' },
        },
      }),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-bad-perms', version: '0.1.0' }),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
    fs.writeFileSync(path.join(extDir, 'src', 'index.ts'), '// stub\n');

    const result = validateManifests(tmpRoot);
    expect(result.ok).toBe(false);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(
      errors.some((e) => e.message.includes('permissions.fs.read') && e.message.includes('string array')),
    ).toBe(true);
  });

  // ─── 7. Back-compat: manifests without config_schema / permissions pass ───────

  it('back-compat: manifests without config_schema or permissions still validate (optional-first)', () => {
    makeExtension(tmpRoot, 'skills', 'no-schema-no-perms');
    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  // ─── 8. Live repo: all 11 retrofitted manifests validate ─────────────────────

  it('live repo: all 11 retrofitted manifests pass with PB config_schema + permissions fields', () => {
    const repoRoot = path.resolve(import.meta.dirname ?? process.cwd(), '..');
    const result = validateManifests(repoRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });
});

// ─── P0 — Entrypoint-reachability gate ───────────────────────────────────────
//
// Phase 0 acceptance tests: the validator must FAIL any manifest whose declared
// `entrypoint` does not resolve to an existing built file, and must PASS manifests
// whose `entrypoint` resolves to an existing file.
//
// Gate: for every non-bundle manifest with an `entrypoint` field, the resolved path
// (path.resolve(extDir, entrypoint)) must exist on disk. Missing → error. Present → no error.
//
// Applies in both collection mode (validateManifests(root)) and single-dir mode
// (validateManifests(extDir) when extDir contains extension.json).

describe('validate-manifests — P0 entrypoint-reachability gate', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTempRepo();
  });

  afterEach(() => {
    removeDirRecursive(tmpRoot);
  });

  // ─── PASS: entrypoint file exists → no error ─────────────────────────────

  it('passes when entrypoint resolves to an existing dist/index.js (collection mode)', () => {
    const extDir = path.join(tmpRoot, 'extensions', 'skills', 'p0-gate-probe');
    fs.mkdirSync(path.join(extDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'p0-gate-probe',
        version: '0.1.0',
        type: 'skill',
        title: 'P0 Gate Probe',
        description: 'use this when testing P0 entrypoint reachability',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js',
        // P3: required for skill type
        run_interface: {
          input_schema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
          output_schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
        },
      }),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-p0-gate-probe', version: '0.1.0' }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
    fs.writeFileSync(path.join(extDir, 'src', 'index.ts'), '// stub\n');
    // Compiled entrypoint is present — gate must pass
    fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), 'export {};\n');

    const result = validateManifests(tmpRoot);
    const entrypointErrors = result.errors.filter(
      (e) => e.severity === 'error' && e.message.includes('entrypoint') && e.path.includes('p0-gate-probe'),
    );
    expect(entrypointErrors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  // ─── FAIL: entrypoint file missing → error ────────────────────────────────

  it('errors when entrypoint is declared but the resolved file does not exist (collection mode)', () => {
    const extDir = path.join(tmpRoot, 'extensions', 'skills', 'p0-gate-missing');
    fs.mkdirSync(path.join(extDir, 'src'), { recursive: true });
    // Intentionally do NOT create dist/index.js — simulates pre-build state
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'p0-gate-missing',
        version: '0.1.0',
        type: 'skill',
        title: 'P0 Gate Missing',
        description: 'use this when testing P0 gate with missing entrypoint',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js', // declared but NOT present on disk
      }),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-p0-gate-missing', version: '0.1.0' }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
    fs.writeFileSync(path.join(extDir, 'src', 'index.ts'), '// stub\n');

    const result = validateManifests(tmpRoot);
    expect(result.ok).toBe(false);
    const entrypointError = result.errors.find(
      (e) =>
        e.severity === 'error' &&
        e.message.includes('entrypoint') &&
        e.message.includes('dist/index.js') &&
        e.message.includes('does not exist'),
    );
    expect(entrypointError).toBeDefined();
    // Error message must reference P0 (engineering contract)
    expect(entrypointError!.message).toContain('P0');
  });

  // ─── PASS: prompt type (no entrypoint) is not subject to the gate ─────────

  it('passes for prompt type which has no entrypoint (gate does not apply)', () => {
    const extDir = path.join(tmpRoot, 'extensions', 'prompts', 'my-prompt');
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'my-prompt',
        version: '0.1.0',
        type: 'prompt',
        title: 'My Prompt',
        description: 'use this when testing prompt type without entrypoint',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        // No entrypoint — prompt type has no runtime
      }),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-my-prompt', version: '0.1.0' }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
    fs.writeFileSync(path.join(extDir, 'prompt.md'), '# Prompt\n');

    const result = validateManifests(tmpRoot);
    const entrypointErrors = result.errors.filter(
      (e) => e.severity === 'error' && e.message.toLowerCase().includes('entrypoint'),
    );
    expect(entrypointErrors).toHaveLength(0);
  });

  // ─── PASS: single-dir mode — entrypoint present ───────────────────────────

  it('passes in single-dir mode when entrypoint resolves to an existing file', () => {
    const extDir = path.join(tmpRoot, 'p0-single-probe');
    fs.mkdirSync(path.join(extDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'p0-single-probe',
        version: '0.1.0',
        type: 'skill',
        title: 'P0 Single Probe',
        description: 'use this when testing single-dir mode entrypoint reachability',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js',
      }),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-p0-single-probe', version: '0.1.0' }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'src', 'index.ts'), '// stub\n');
    fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), 'export {};\n');

    // single-dir mode: pass the extension dir directly
    const result = validateManifests(extDir);
    const entrypointErrors = result.errors.filter(
      (e) => e.severity === 'error' && e.message.toLowerCase().includes('entrypoint'),
    );
    expect(entrypointErrors).toHaveLength(0);
  });

  // ─── FAIL: single-dir mode — entrypoint missing ───────────────────────────

  it('errors in single-dir mode when entrypoint file is missing', () => {
    const extDir = path.join(tmpRoot, 'p0-missing-probe');
    fs.mkdirSync(path.join(extDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'p0-missing-probe',
        version: '0.1.0',
        type: 'skill',
        title: 'P0 Missing Probe',
        description: 'use this when testing single-dir mode missing entrypoint',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js', // declared but NOT present on disk
      }),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-p0-missing-probe', version: '0.1.0' }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'src', 'index.ts'), '// stub\n');
    // Intentionally do NOT create dist/index.js

    const result = validateManifests(extDir);
    expect(result.ok).toBe(false);
    const entrypointError = result.errors.find(
      (e) =>
        e.severity === 'error' &&
        e.message.includes('entrypoint') &&
        e.message.includes('does not exist'),
    );
    expect(entrypointError).toBeDefined();
    expect(entrypointError!.message).toContain('P0');
  });

  // ─── PASS: live repo — all 9 process-type extensions built and reachable ───

  it('live repo: all 9 process-type extension entrypoints are reachable post-build', () => {
    // After pnpm -r build, every process-type extension must have dist/index.js.
    // This test runs against the real repo (not a temp fixture) and will fail
    // if pnpm -r build has not been run first — that is intentional: the gate
    // enforces the build contract in CI.
    const repoRoot = path.resolve(import.meta.dirname ?? process.cwd(), '..');
    const result = validateManifests(repoRoot);
    const entrypointErrors = result.errors.filter(
      (e) => e.severity === 'error' && e.message.includes('P0 entrypoint-reachability gate'),
    );
    expect(entrypointErrors).toHaveLength(0);
    expect(result.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P3 (framework-contract-completion): Per-type self-description — enforced (error)
//
// P3 flipped all P2 self-description checks from warn to error after all 11 manifests
// were retrofitted. Acceptance criteria (P3 acceptance check):
//   - All 11 retrofitted manifests validate with zero errors.
//   - A manifest missing its type-specific self-description field now FAILS (error).
//   - Fields, when present and well-formed, pass without diagnostics.
//   - Unknown hook-events enum values produce severity:'error'.
//   - dependencies enforcement (Gap F2): unknown dep id → severity:'warn' (unchanged).
// ─────────────────────────────────────────────────────────────────────────────

describe('validate-manifests — P3 per-type self-description (enforced)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTempRepo();
  });

  afterEach(() => {
    removeDirRecursive(tmpRoot);
  });

  // ─── Hook: events field ──────────────────────────────────────────────────

  it('hook: errors (not warns) when events field is absent', () => {
    // id must NOT end with its type name ('hook'), so use 'audit-logger' not 'my-hook'
    // Write manifest WITHOUT events field to test enforcement
    const extDir = path.join(tmpRoot, 'extensions', 'hooks', 'audit-logger');
    fs.mkdirSync(extDir, { recursive: true });
    fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), '// compiled\n');
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'audit-logger',
        version: '0.1.0',
        type: 'hook',
        title: 'Audit Logger',
        description: 'use this when testing hook events field',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js',
        // intentionally NO events field — testing P3 enforcement
      }),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-audit-logger', version: '0.1.0' }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
    const result = validateManifests(tmpRoot);
    // exit non-zero: missing events is now a hard error (P3 enforced)
    expect(result.ok).toBe(false);
    // an error must be present about the missing events field
    const eventsError = result.errors.find(
      (d) => d.severity === 'error' && d.message.includes('"events"') && d.message.includes('P3'),
    );
    expect(eventsError).toBeDefined();
  });

  it('hook: no diagnostics when events field is present and valid', () => {
    // id must NOT end with its type name ('hook')
    const extDir = path.join(tmpRoot, 'extensions', 'hooks', 'audit-logger');
    fs.mkdirSync(extDir, { recursive: true });
    fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), '// compiled\n');
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'audit-logger',
        version: '0.1.0',
        type: 'hook',
        title: 'Audit Logger',
        description: 'use this when testing hook events field',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js',
        events: ['PreToolUse'],
      }),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-audit-logger', version: '0.1.0' }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
    const result = validateManifests(tmpRoot);
    // No P3 events error when field is present and valid
    const p3EventsError = result.errors.find(
      (d) => d.severity === 'error' && d.message.includes('"events"') && d.message.includes('P3'),
    );
    expect(p3EventsError).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it('hook: errors (not warns) when events contains an unknown event name', () => {
    // id must NOT end with its type name ('hook')
    const extDir = path.join(tmpRoot, 'extensions', 'hooks', 'audit-logger');
    fs.mkdirSync(extDir, { recursive: true });
    fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), '// compiled\n');
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'audit-logger',
        version: '0.1.0',
        type: 'hook',
        title: 'Audit Logger',
        description: 'use this when testing unknown events',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js',
        events: ['PreToolUse', 'UnknownEvent'],
      }),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-audit-logger', version: '0.1.0' }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
    const result = validateManifests(tmpRoot);
    // Must exit non-zero (ok=false) — unknown events are now an error (P3 enforced)
    expect(result.ok).toBe(false);
    // An error about the unknown event
    const unknownEvtError = result.errors.find(
      (d) => d.severity === 'error' && d.message.includes('UnknownEvent'),
    );
    expect(unknownEvtError).toBeDefined();
    // Must be an error, not a warn (P3 enforced)
    expect(unknownEvtError!.severity).toBe('error');
  });

  it('hook: closed enum covers all events that current hooks actually declare', () => {
    // audit-hook declares: PreToolUse
    // memory-flush declares: SessionEnd, ScopePromotionProposed
    // All three must be in the closed enum (seeded from current usage, per plan).
    const requiredEvents = ['PreToolUse', 'SessionEnd', 'ScopePromotionProposed', 'Stop', 'PostToolUse'];
    for (const evt of requiredEvents) {
      // ids must NOT end with the type name 'hook'
      const evtSlug = evt.toLowerCase().replace(/[^a-z0-9]/g, '-');
      const extDir = path.join(tmpRoot, 'extensions', 'hooks', `on-${evtSlug}`);
      fs.mkdirSync(extDir, { recursive: true });
      fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), '// compiled\n');
      fs.writeFileSync(
        path.join(extDir, 'extension.json'),
        JSON.stringify({
          $schema: 'https://your-registry/schemas/extension/v1.json',
          id: `on-${evtSlug}`,
          version: '0.1.0',
          type: 'hook',
          title: `${evt} Hook`,
          description: `use this when testing ${evt}`,
          compatibility: { host: '>=1.0.0 <2.0.0' },
          license: 'MIT',
          entrypoint: 'dist/index.js',
          events: [evt],
        }),
      );
      fs.writeFileSync(
        path.join(extDir, 'package.json'),
        JSON.stringify({ name: `@adhd/sox-on-${evtSlug}`, version: '0.1.0' }, null, 2),
      );
      fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
    }
    const result = validateManifests(tmpRoot);
    // No unknown-event warnings for any of the seeded events
    const unknownEvtWarns = result.errors.filter(
      (d) => d.severity === 'warn' && d.message.includes('unknown event'),
    );
    expect(unknownEvtWarns).toHaveLength(0);
  });

  // ─── Agent: invocation field ─────────────────────────────────────────────

  it('agent: errors (not warns) when invocation field is absent', () => {
    // Write manifest WITHOUT invocation field to test enforcement
    const extDir = path.join(tmpRoot, 'extensions', 'agents', 'my-assistant');
    fs.mkdirSync(extDir, { recursive: true });
    fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), '// compiled\n');
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'my-assistant',
        version: '0.1.0',
        type: 'agent',
        title: 'My Assistant',
        description: 'use this when you need an assistant',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js',
        // intentionally NO invocation field — testing P3 enforcement
      }),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-my-assistant', version: '0.1.0' }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
    const result = validateManifests(tmpRoot);
    // exit non-zero: missing invocation is now a hard error (P3 enforced)
    expect(result.ok).toBe(false);
    const invocationError = result.errors.find(
      (d) => d.severity === 'error' && d.message.includes('"invocation"') && d.message.includes('P3'),
    );
    expect(invocationError).toBeDefined();
  });

  it('agent: no P3 invocation error when invocation field is present', () => {
    const extDir = path.join(tmpRoot, 'extensions', 'agents', 'my-assistant');
    fs.mkdirSync(extDir, { recursive: true });
    fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), '// compiled\n');
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'my-assistant',
        version: '0.1.0',
        type: 'agent',
        title: 'My Assistant',
        description: 'use this when you need an assistant',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js',
        invocation: { protocol: 'function-export', handler: 'run' },
      }),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-my-assistant', version: '0.1.0' }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
    const result = validateManifests(tmpRoot);
    const p3InvocationError = result.errors.find(
      (d) => d.severity === 'error' && d.message.includes('"invocation"') && d.message.includes('P3'),
    );
    expect(p3InvocationError).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  // ─── Command: invocation field ───────────────────────────────────────────

  it('command: errors (not warns) when invocation field is absent', () => {
    // Write manifest WITHOUT invocation field to test enforcement
    const extDir = path.join(tmpRoot, 'extensions', 'commands', 'my-cmd');
    fs.mkdirSync(extDir, { recursive: true });
    fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), '// compiled\n');
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'my-cmd',
        version: '0.1.0',
        type: 'command',
        title: 'My Cmd',
        description: 'use this when you need a command',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js',
        // intentionally NO invocation field — testing P3 enforcement
      }),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-my-cmd', version: '0.1.0' }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
    const result = validateManifests(tmpRoot);
    // exit non-zero: missing invocation is now a hard error (P3 enforced)
    expect(result.ok).toBe(false);
    const invocationError = result.errors.find(
      (d) => d.severity === 'error' && d.message.includes('"invocation"') && d.message.includes('P3'),
    );
    expect(invocationError).toBeDefined();
  });

  // ─── MCP-server: tools field ─────────────────────────────────────────────

  it('mcp-server: errors (not warns) when tools field is absent', () => {
    // Write manifest WITHOUT tools field to test enforcement
    const extDir = path.join(tmpRoot, 'extensions', 'mcp-servers', 'my-mcp');
    fs.mkdirSync(extDir, { recursive: true });
    fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), '// compiled\n');
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'my-mcp',
        version: '0.1.0',
        type: 'mcp-server',
        title: 'My MCP',
        description: 'use this when you need MCP tools',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js',
        // intentionally NO tools field — testing P3 enforcement
      }),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-my-mcp', version: '0.1.0' }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
    const result = validateManifests(tmpRoot);
    // exit non-zero: missing tools is now a hard error (P3 enforced)
    expect(result.ok).toBe(false);
    const toolsError = result.errors.find(
      (d) => d.severity === 'error' && d.message.includes('"tools"') && d.message.includes('P3'),
    );
    expect(toolsError).toBeDefined();
  });

  it('mcp-server: no P3 tools error when tools field is present with valid descriptors', () => {
    const extDir = path.join(tmpRoot, 'extensions', 'mcp-servers', 'my-mcp');
    fs.mkdirSync(extDir, { recursive: true });
    fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), '// compiled\n');
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'my-mcp',
        version: '0.1.0',
        type: 'mcp-server',
        title: 'My MCP',
        description: 'use this when you need MCP tools',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js',
        tools: [
          { name: 'my_tool', description: 'use this when you need my_tool' },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-my-mcp', version: '0.1.0' }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
    const result = validateManifests(tmpRoot);
    const p3ToolsError = result.errors.find(
      (d) => d.severity === 'error' && d.message.includes('"tools"') && d.message.includes('P3'),
    );
    expect(p3ToolsError).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  // ─── Prompt: parameters + template_engine ────────────────────────────────

  it('prompt: errors (not warns) when parameters field is absent', () => {
    // id must NOT end with its type name ('prompt'), so use 'greeting' not 'my-prompt'
    // Write manifest WITHOUT parameters/template_engine to test enforcement
    const extDir = path.join(tmpRoot, 'extensions', 'prompts', 'greeting');
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'greeting',
        version: '0.1.0',
        type: 'prompt',
        title: 'Greeting',
        description: 'use this when testing prompt self-description',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        // intentionally NO parameters or template_engine — testing P3 enforcement
      }),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-greeting', version: '0.1.0' }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
    fs.writeFileSync(path.join(extDir, 'prompt.md'), '# Prompt\n');
    const result = validateManifests(tmpRoot);
    // exit non-zero: missing parameters/template_engine is now a hard error (P3 enforced)
    expect(result.ok).toBe(false);
    const paramsError = result.errors.find(
      (d) => d.severity === 'error' && d.message.includes('"parameters"') && d.message.includes('P3'),
    );
    expect(paramsError).toBeDefined();
    const engineError = result.errors.find(
      (d) => d.severity === 'error' && d.message.includes('"template_engine"') && d.message.includes('P3'),
    );
    expect(engineError).toBeDefined();
  });

  it('prompt: no P3 parameter/engine errors when both fields are present', () => {
    // id must NOT end with its type name ('prompt')
    const extDir = path.join(tmpRoot, 'extensions', 'prompts', 'greeting');
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'greeting',
        version: '0.1.0',
        type: 'prompt',
        title: 'Greeting',
        description: 'use this when testing prompt self-description',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        parameters: [{ name: 'context', type: 'string', required: true, description: 'User context' }],
        template_engine: 'handlebars',
      }),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-greeting', version: '0.1.0' }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
    fs.writeFileSync(path.join(extDir, 'prompt.md'), '# Prompt\n');
    const result = validateManifests(tmpRoot);
    const p3ParamsError = result.errors.find(
      (d) => d.severity === 'error' && d.message.includes('"parameters"') && d.message.includes('P3'),
    );
    expect(p3ParamsError).toBeUndefined();
    const p3EngineError = result.errors.find(
      (d) => d.severity === 'error' && d.message.includes('"template_engine"') && d.message.includes('P3'),
    );
    expect(p3EngineError).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  // ─── Skill: run_interface ────────────────────────────────────────────────

  it('skill: errors (not warns) when run_interface field is absent', () => {
    // Write manifest WITHOUT run_interface to test enforcement
    const extDir = path.join(tmpRoot, 'extensions', 'skills', 'my-analyzer');
    fs.mkdirSync(extDir, { recursive: true });
    fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), '// compiled\n');
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'my-analyzer',
        version: '0.1.0',
        type: 'skill',
        title: 'My Analyzer',
        description: 'use this when you need analysis',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js',
        // intentionally NO run_interface — testing P3 enforcement
      }),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-my-analyzer', version: '0.1.0' }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
    const result = validateManifests(tmpRoot);
    // exit non-zero: missing run_interface is now a hard error (P3 enforced)
    expect(result.ok).toBe(false);
    const runIfaceError = result.errors.find(
      (d) => d.severity === 'error' && d.message.includes('"run_interface"') && d.message.includes('P3'),
    );
    expect(runIfaceError).toBeDefined();
  });

  it('skill: no P3 run_interface error when field is present', () => {
    const extDir = path.join(tmpRoot, 'extensions', 'skills', 'my-analyzer');
    fs.mkdirSync(extDir, { recursive: true });
    fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), '// compiled\n');
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'my-analyzer',
        version: '0.1.0',
        type: 'skill',
        title: 'My Analyzer',
        description: 'use this when you need analysis',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js',
        run_interface: {
          input_schema: { type: 'object', properties: { text: { type: 'string' } } },
          output_schema: { type: 'object', properties: { result: { type: 'string' } } },
        },
      }),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-my-analyzer', version: '0.1.0' }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
    const result = validateManifests(tmpRoot);
    const p3RunIfaceError = result.errors.find(
      (d) => d.severity === 'error' && d.message.includes('"run_interface"') && d.message.includes('P3'),
    );
    expect(p3RunIfaceError).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  // ─── Dependencies enforcement (Gap F2) ───────────────────────────────────

  it('P2 Gap F2: warns (not errors) when a declared dependency id is not in the registry', () => {
    const extDir = path.join(tmpRoot, 'extensions', 'agents', 'my-assistant');
    fs.mkdirSync(extDir, { recursive: true });
    fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), '// compiled\n');
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'my-assistant',
        version: '0.1.0',
        type: 'agent',
        title: 'My Assistant',
        description: 'use this when you need help',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js',
        // P3: invocation is now required for agent type
        invocation: { protocol: 'function-export', handler: 'run' },
        // depends on an id that does not exist in the registry
        dependencies: [{ id: 'nonexistent-server', version: '^0.1.0' }],
      }),
    );
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-my-assistant', version: '0.1.0' }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
    const result = validateManifests(tmpRoot);
    // Dep-existence is still warn-only (F2 posture unchanged); only the P3 self-description fields are errors.
    // A warn about the missing dependency id must be present
    const depWarn = result.errors.find(
      (d) => d.severity === 'warn' && d.message.includes('nonexistent-server') && d.message.includes('F2'),
    );
    expect(depWarn).toBeDefined();
    expect(depWarn!.severity).toBe('warn'); // F2 dep-existence stays warn
  });

  it('P2 Gap F2: no dep-existence warning when dependency ids resolve to known extensions', () => {
    // Create two extensions where one depends on the other
    const serverDir = path.join(tmpRoot, 'extensions', 'mcp-servers', 'my-backend');
    fs.mkdirSync(serverDir, { recursive: true });
    fs.mkdirSync(path.join(serverDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(serverDir, 'dist', 'index.js'), '// compiled\n');
    fs.writeFileSync(
      path.join(serverDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'my-backend',
        version: '0.1.0',
        type: 'mcp-server',
        title: 'My Backend',
        description: 'use this when you need a backend',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js',
        // P3: tools is now required for mcp-server type
        tools: [{ name: 'backend_tool', description: 'use this when you need a backend tool' }],
      }),
    );
    fs.writeFileSync(
      path.join(serverDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-my-backend', version: '0.1.0' }, null, 2),
    );
    fs.writeFileSync(path.join(serverDir, 'CHANGELOG.md'), '');

    const agentDir = path.join(tmpRoot, 'extensions', 'agents', 'my-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(path.join(agentDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'dist', 'index.js'), '// compiled\n');
    fs.writeFileSync(
      path.join(agentDir, 'extension.json'),
      JSON.stringify({
        $schema: 'https://your-registry/schemas/extension/v1.json',
        id: 'my-agent',
        version: '0.1.0',
        type: 'agent',
        title: 'My Agent',
        description: 'use this when you need an agent',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js',
        // P3: invocation is now required for agent type
        invocation: { protocol: 'function-export', handler: 'run' },
        dependencies: [{ id: 'my-backend', version: '^0.1.0' }],
      }),
    );
    fs.writeFileSync(
      path.join(agentDir, 'package.json'),
      JSON.stringify({ name: '@adhd/sox-my-agent', version: '0.1.0' }, null, 2),
    );
    fs.writeFileSync(path.join(agentDir, 'CHANGELOG.md'), '');

    const result = validateManifests(tmpRoot);
    // No dep-existence warning when the dep is in the registry
    const depWarn = result.errors.find(
      (d) => d.severity === 'warn' && d.message.includes('F2') && d.message.includes('my-backend'),
    );
    expect(depWarn).toBeUndefined();
  });

  // ─── All 11 manifests validate with zero errors (P3 acceptance check) ────

  it('live repo: all 11 retrofitted manifests validate with zero errors — P3 ENFORCED posture', () => {
    // This is the key P3 acceptance check: all 11 manifests have been retrofitted with
    // their type-specific self-description fields. They must validate with exit 0 (ok=true)
    // and zero P3 self-description errors.
    const ROOT = path.resolve(import.meta.dirname ?? process.cwd(), '..');
    const result = validateManifests(ROOT);
    // MUST exit 0 — all 11 manifests are retrofitted
    expect(result.ok).toBe(true);
    // MUST have no errors — P3 fields are all present
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    // No P3 self-description diagnostics (all fields present)
    const p3Diags = result.errors.filter(
      (d) => d.message.startsWith('P3:'),
    );
    expect(p3Diags).toHaveLength(0);
  });
});
