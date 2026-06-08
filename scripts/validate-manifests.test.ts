/**
 * validate-manifests.test.ts — P2 acceptance tests for dedup + secret lint
 *
 * Acceptance criteria (Section 4.5):
 *   - duplicate-ID fixture → non-zero exit (error)
 *   - shadow-copy fixture (live sox-active/sox-cto-system failure mode) → error
 *   - literal-secret fixture → error
 *   - valid manifests → passes
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { validateManifests } from './validate-manifests.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-test-'));
  return dir;
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
  };
  fs.writeFileSync(path.join(extDir, 'extension.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(extDir, 'package.json'),
    JSON.stringify({ name: `@sox/extension-${id}`, version }, null, 2),
  );
  fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
  if (type === 'prompt') {
    fs.writeFileSync(path.join(extDir, 'prompt.md'), '# Prompt\n');
  } else {
    fs.mkdirSync(path.join(extDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'src', 'index.ts'), '// stub\n');
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
      JSON.stringify({ name: '@sox/extension-bad-id', version: '0.1.0' }),
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

  /** Helper: write a manifest with arbitrary extra fields */
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
      ...extra,
    };
    fs.writeFileSync(path.join(extDir, 'extension.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: `@sox/extension-${id}`, version: '0.1.0' }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
    fs.writeFileSync(path.join(extDir, 'src', 'index.ts'), '// stub\n');
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

  /** Helper: write a manifest with arbitrary extra fields */
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
      ...extra,
    };
    fs.writeFileSync(path.join(extDir, 'extension.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: `@sox/extension-${id}`, version: '0.1.0' }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
    fs.writeFileSync(path.join(extDir, 'src', 'index.ts'), '// stub\n');
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

  // PASS: agent with lifecycle is valid
  it('passes when an agent declares lifecycle with health.type:stdio-ping', () => {
    makeExtensionWithFields(tmpRoot, 'agents', 'memory-orchestrator', {
      lifecycle: {
        background: true,
        singleton: true,
        health: { type: 'stdio-ping' },
      },
    });

    const result = validateManifests(tmpRoot);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.ok).toBe(true);
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
      JSON.stringify({ name: `@sox/extension-${id}`, version: '0.1.0' }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
  }

  // ─── PASS: valid bundle with correct members ───────────────────────────────

  it('passes for a valid bundle with non-empty members and no entrypoint', () => {
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
      JSON.stringify({ name: '@sox/extension-no-members-bundle', version: '0.1.0' }, null, 2),
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
      ...extra,
    };
    fs.writeFileSync(path.join(extDir, 'extension.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: `@sox/extension-${id}`, version: '0.1.0' }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
    fs.writeFileSync(path.join(extDir, 'src', 'index.ts'), '// stub\n');
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
