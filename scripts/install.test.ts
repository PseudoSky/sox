/**
 * install.test.ts — P1/P2/P3/P4 integration tests for the install client
 *
 * P1 tests: single-scope resolution, lockfile writing, --frozen-lockfile
 * P2 tests: extends hash-mismatch fail-closed, --update re-resolves
 * P3 tests: capability check warning/hard-block
 * P4 tests: semver range resolution, checksum tamper detection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { install, semverSatisfies, fetchArtifact } from './install.js';
import type { InstallOptions } from './install.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-install-test-'));
  return dir;
}

function makeExtension(
  root: string,
  typeDir: string,
  id: string,
  version = '0.1.0',
  requires?: Record<string, unknown>,
): void {
  const extDir = path.join(root, 'extensions', typeDir, id);
  fs.mkdirSync(path.join(extDir, 'src'), { recursive: true });

  let type = id; // placeholder
  if (typeDir === 'skills') type = 'skill';
  else if (typeDir === 'agents') type = 'agent';
  else if (typeDir === 'prompts') type = 'prompt';
  else if (typeDir === 'hooks') type = 'hook';
  else if (typeDir === 'commands') type = 'command';
  else if (typeDir === 'mcp-servers') type = 'mcp-server';

  const manifest: Record<string, unknown> = {
    $schema: 'https://your-registry/schemas/extension/v1.json',
    id,
    version,
    type,
    title: `${id} title`,
    description: `${id} description`,
    compatibility: { host: '>=1.0.0 <2.0.0' },
    license: 'MIT',
    entrypoint: 'dist/index.js',
  };
  if (requires !== undefined) {
    manifest['requires'] = requires;
  }

  fs.writeFileSync(path.join(extDir, 'extension.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(extDir, 'package.json'),
    JSON.stringify({ name: `@sox/extension-${id}`, version }, null, 2),
  );
  fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
  fs.writeFileSync(path.join(extDir, 'src', 'index.ts'), `// ${id} stub\nexport const id = '${id}';\n`);
}

function makeUserConfig(root: string, config: Record<string, unknown>): {
  configPath: string;
  lockfilePath: string;
} {
  const configDir = path.join(root, 'user-config');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'extensions.json');
  const lockfilePath = path.join(configDir, 'extensions.lock');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return { configPath, lockfilePath };
}

function removeDirRecursive(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ─── P1 Tests — single scope, local file ─────────────────────────────────────

describe('P1: single-scope local install', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    removeDirRecursive(root);
  });

  it('resolves a local file:// extension and writes a lockfile', async () => {
    makeExtension(root, 'skills', 'my-skill');

    const { configPath, lockfilePath } = makeUserConfig(root, {
      install: [
        {
          id: 'my-skill',
          version: '0.1.0',
          enabled: true,
          source: `file://${path.join(root, 'extensions', 'skills', 'my-skill')}`,
        },
      ],
    });

    const opts: InstallOptions = {
      scope: 'user',
      mode: 'default',
      configPath,
      lockfilePath,
      root,
    };

    const resolved = await install(opts);

    // Extension should be in the resolved set
    expect(Object.keys(resolved)).toContain('my-skill');
    expect(resolved['my-skill']?.enabled).toBe(true);

    // Lockfile should exist
    expect(fs.existsSync(lockfilePath)).toBe(true);
    const lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
    expect(lockfile['lockfileVersion']).toBe(1);
    expect(lockfile['resolved']).toBeDefined();

    // Lockfile should have the resolved entry
    const resolvedKeys = Object.keys(lockfile['resolved']);
    expect(resolvedKeys.some((k: string) => k.startsWith('my-skill@'))).toBe(true);
  });

  it('--frozen-lockfile exits without re-resolving when lockfile exists', async () => {
    makeExtension(root, 'skills', 'my-skill');

    const { configPath, lockfilePath } = makeUserConfig(root, {
      install: [
        {
          id: 'my-skill',
          version: '0.1.0',
          enabled: true,
          source: `file://${path.join(root, 'extensions', 'skills', 'my-skill')}`,
        },
      ],
    });

    // First install to create lockfile
    await install({ scope: 'user', mode: 'default', configPath, lockfilePath, root });

    const lock1 = fs.readFileSync(lockfilePath, 'utf8');

    // Second install with --frozen-lockfile
    await install({ scope: 'user', mode: 'frozen', configPath, lockfilePath, root });

    const lock2 = fs.readFileSync(lockfilePath, 'utf8');

    // Lockfile must be byte-identical
    expect(lock1).toBe(lock2);
  });

  it('resolves extension from registry/index.json when no source is given', async () => {
    makeExtension(root, 'skills', 'registry-ext');

    // Build registry index
    const registryDir = path.join(root, 'registry');
    fs.mkdirSync(registryDir, { recursive: true });
    const indexEntry = {
      id: 'registry-ext',
      type: 'skill',
      version: '0.1.0',
      title: 'Registry Ext',
      description: 'test',
      source: `file://${path.join(root, 'extensions', 'skills', 'registry-ext')}`,
      checksum: 'sha256:' + '0'.repeat(64), // will be recomputed
      compatibility: { host: '>=1.0.0 <2.0.0' },
    };

    // Compute actual checksum from the content file
    const crypto = await import('node:crypto');
    const contentPath = path.join(root, 'extensions', 'skills', 'registry-ext', 'src', 'index.ts');
    const bytes = fs.readFileSync(contentPath);
    const realChecksum = 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
    indexEntry.checksum = realChecksum;

    fs.writeFileSync(path.join(registryDir, 'index.json'), JSON.stringify([indexEntry], null, 2));

    const { configPath, lockfilePath } = makeUserConfig(root, {
      install: [{ id: 'registry-ext', version: '0.1.0' }],
    });

    const resolved = await install({
      scope: 'user',
      mode: 'default',
      configPath,
      lockfilePath,
      root,
    });

    expect(Object.keys(resolved)).toContain('registry-ext');
    expect(fs.existsSync(lockfilePath)).toBe(true);
  });
});

// ─── P2 Tests — extends hash pin ─────────────────────────────────────────────

describe('P2: extends hash-mismatch fail-closed (Gap 4)', () => {
  let root: string;
  let server: http.Server;
  let serverPort: number;
  let orgBaselineContent: string;

  beforeEach(async () => {
    root = makeTempRoot();
    orgBaselineContent = JSON.stringify({
      install: [{ id: 'org-ext', version: '1.0.0', enabled: true }],
    });

    // Start a minimal HTTP server to serve the org baseline
    await new Promise<void>((resolve) => {
      server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(orgBaselineContent);
      });
      server.listen(0, '127.0.0.1', () => {
        serverPort = (server.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removeDirRecursive(root);
  });

  it('records extends pin on first install', async () => {
    makeExtension(root, 'skills', 'org-ext', '1.0.0');

    const { configPath, lockfilePath } = makeUserConfig(root, {
      extends: `http://127.0.0.1:${serverPort}/base.json`,
      install: [],
    });

    await install({ scope: 'user', mode: 'default', configPath, lockfilePath, root });

    const lock = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
    expect(lock['extends']).toBeDefined();
    expect(lock['extends']['url']).toBe(`http://127.0.0.1:${serverPort}/base.json`);
    expect(lock['extends']['sha256']).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('fails closed when extends hash changes without --update', async () => {
    makeExtension(root, 'skills', 'org-ext', '1.0.0');

    const { configPath, lockfilePath } = makeUserConfig(root, {
      extends: `http://127.0.0.1:${serverPort}/base.json`,
      install: [],
    });

    // First install — pins the hash
    await install({ scope: 'user', mode: 'default', configPath, lockfilePath, root });

    // Modify the org baseline (simulate a change)
    orgBaselineContent = JSON.stringify({
      install: [{ id: 'org-ext', version: '2.0.0', enabled: true }], // changed!
    });

    // Second install without --update should fail
    let didFail = false;
    const originalExit = process.exit;
    // Temporarily intercept process.exit
    const exitSpy = (code?: number | string | null | undefined) => {
      didFail = true;
      throw new Error(`process.exit(${String(code)}) called`);
    };
    process.exit = exitSpy as typeof process.exit;

    try {
      await install({ scope: 'user', mode: 'default', configPath, lockfilePath, root });
    } catch (_e) {
      // Expected — the fail-closed behavior throws via process.exit intercept
    } finally {
      process.exit = originalExit;
    }

    expect(didFail).toBe(true);
  });

  it('succeeds with --update when extends hash changes', async () => {
    makeExtension(root, 'skills', 'org-ext', '1.0.0');

    const { configPath, lockfilePath } = makeUserConfig(root, {
      extends: `http://127.0.0.1:${serverPort}/base.json`,
      install: [],
    });

    // First install
    await install({ scope: 'user', mode: 'default', configPath, lockfilePath, root });

    const lock1 = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));

    // Modify the org baseline
    orgBaselineContent = JSON.stringify({
      install: [{ id: 'org-ext', version: '2.0.0', enabled: true }],
    });

    // Install with --update should succeed and rewrite the pin
    await install({ scope: 'user', mode: 'update', configPath, lockfilePath, root });

    const lock2 = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
    // The sha256 should have changed
    expect(lock2['extends']['sha256']).not.toBe(lock1['extends']['sha256']);
  });
});

// ─── P3 Tests — capability check ─────────────────────────────────────────────

describe('P3: provider capability check (Gap 5)', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
    // Create the assets directory with model capabilities
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    // We test through the provider-capabilities module via the install client
    // which uses the real assets/model_capabilities.json from the repo root
  });

  afterEach(() => {
    removeDirRecursive(root);
  });

  it('emits warning (not hard error) for tool-calling extension on non-tool-capable model by default', async () => {
    // Extension requires tool calling
    makeExtension(root, 'agents', 'tool-agent', '0.1.0', { tool_calling: true });

    const { configPath, lockfilePath } = makeUserConfig(root, {
      install: [
        {
          id: 'tool-agent',
          version: '0.1.0',
          enabled: true,
          source: `file://${path.join(root, 'extensions', 'agents', 'tool-agent')}`,
        },
      ],
      config: {
        'tool-agent': { provider: 'ollama/llama3' },
      },
    });

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(' '));
    };

    try {
      // Without strict_capabilities — should warn and exit 0
      await install({
        scope: 'user',
        mode: 'default',
        configPath,
        lockfilePath,
        root,
        overrideProvider: 'ollama/llama3',
      });
    } finally {
      console.warn = originalWarn;
    }

    // Should have emitted a capability warning
    const capWarning = warnings.find(
      (w) => w.includes('CAPABILITY MISMATCH') || w.includes('tool_calling') || w.includes('tool calling'),
    );
    expect(capWarning).toBeDefined();
  });

  it('hard-blocks when strict_capabilities:true and tool-calling model mismatch', async () => {
    makeExtension(root, 'agents', 'tool-agent', '0.1.0', { tool_calling: true });

    const { configPath, lockfilePath } = makeUserConfig(root, {
      strict_capabilities: true,
      install: [
        {
          id: 'tool-agent',
          version: '0.1.0',
          enabled: true,
          source: `file://${path.join(root, 'extensions', 'agents', 'tool-agent')}`,
        },
      ],
    });

    let didExit = false;
    const originalExit = process.exit;
    process.exit = ((_code?: unknown) => {
      didExit = true;
      throw new Error('process.exit called');
    }) as typeof process.exit;

    try {
      await install({
        scope: 'user',
        mode: 'default',
        configPath,
        lockfilePath,
        root,
        overrideProvider: 'ollama/llama3',
      });
    } catch (_e) {
      // Expected
    } finally {
      process.exit = originalExit;
    }

    expect(didExit).toBe(true);
  });
});

// ─── P4 Tests — checksum tamper detection ────────────────────────────────────

describe('P4: checksum verification', () => {
  it('rejects a tampered artifact (wrong checksum)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-tamper-'));

    try {
      // Create a real file
      const contentPath = path.join(tmpDir, 'index.ts');
      fs.writeFileSync(contentPath, '// real content\n');
      const source = `file://${contentPath}`;

      // Tampered checksum (not matching the real content)
      const badChecksum = 'sha256:' + 'a'.repeat(64);

      await expect(
        fetchArtifact(source, badChecksum),
      ).rejects.toThrow('CHECKSUM MISMATCH');
    } finally {
      removeDirRecursive(tmpDir);
    }
  });

  it('accepts an artifact with the correct checksum', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-checksum-'));

    try {
      const crypto = await import('node:crypto');
      const content = '// real content\n';
      const contentPath = path.join(tmpDir, 'index.ts');
      fs.writeFileSync(contentPath, content);
      const source = `file://${contentPath}`;

      const realChecksum =
        'sha256:' +
        crypto
          .createHash('sha256')
          .update(Buffer.from(content))
          .digest('hex');

      const result = await fetchArtifact(source, realChecksum);
      expect(result.checksum).toBe(realChecksum);
    } finally {
      removeDirRecursive(tmpDir);
    }
  });
});

// ─── semverSatisfies unit tests ───────────────────────────────────────────────

describe('semverSatisfies', () => {
  it('matches exact version', () => {
    expect(semverSatisfies('1.2.3', '1.2.3')).toBe(true);
    expect(semverSatisfies('1.2.3', '1.2.4')).toBe(false);
  });

  it('handles workspace:*', () => {
    expect(semverSatisfies('0.1.0', 'workspace:*')).toBe(true);
    expect(semverSatisfies('99.99.99', 'workspace:*')).toBe(true);
  });

  it('handles ^ range (same major, >= minor.patch)', () => {
    expect(semverSatisfies('1.2.3', '^1.0.0')).toBe(true);
    expect(semverSatisfies('1.2.3', '^1.2.0')).toBe(true);
    expect(semverSatisfies('1.2.3', '^1.2.3')).toBe(true);
    expect(semverSatisfies('1.2.2', '^1.2.3')).toBe(false);
    expect(semverSatisfies('2.0.0', '^1.0.0')).toBe(false);
    expect(semverSatisfies('0.9.9', '^1.0.0')).toBe(false);
  });

  it('handles >= < range', () => {
    expect(semverSatisfies('1.5.0', '>=1.0.0 <2.0.0')).toBe(true);
    expect(semverSatisfies('2.0.0', '>=1.0.0 <2.0.0')).toBe(false);
    expect(semverSatisfies('0.9.9', '>=1.0.0 <2.0.0')).toBe(false);
    expect(semverSatisfies('1.0.0', '>=1.0.0 <2.0.0')).toBe(true);
  });
});
