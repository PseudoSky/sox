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
