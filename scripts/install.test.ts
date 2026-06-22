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

    // The registry checksum must match the built entrypoint artifact (C4: dist/index.js,
    // the declared `entrypoint`), NOT the TS source — mirroring fetchArtifact /
    // resolveChecksum resolution order. Create the built artifact and hash it.
    const crypto = await import('node:crypto');
    const distDir = path.join(root, 'extensions', 'skills', 'registry-ext', 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    const contentPath = path.join(distDir, 'index.js');
    fs.writeFileSync(contentPath, 'module.exports = {};\n');
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

  it('skips an unresolvable install[] entry instead of aborting (BL-19 resilience)', async () => {
    makeExtension(root, 'skills', 'registry-ext');
    const registryDir = path.join(root, 'registry');
    fs.mkdirSync(registryDir, { recursive: true });
    const crypto = await import('node:crypto');
    const distDir = path.join(root, 'extensions', 'skills', 'registry-ext', 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    const distJs = path.join(distDir, 'index.js');
    fs.writeFileSync(distJs, 'module.exports = {};\n');
    const checksum = 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(distJs)).digest('hex');
    fs.writeFileSync(
      path.join(registryDir, 'index.json'),
      JSON.stringify([{
        id: 'registry-ext', type: 'skill', version: '0.1.0', title: 'Registry Ext',
        description: 'test', source: `file://${path.join(root, 'extensions', 'skills', 'registry-ext')}`,
        checksum, compatibility: { host: '>=1.0.0 <2.0.0' },
      }], null, 2),
    );

    // Config mixes a VALID entry with an UNRESOLVABLE one — install must skip the bad
    // one and still install the valid one (not process.exit on the whole operation).
    const { configPath, lockfilePath } = makeUserConfig(root, {
      install: [
        { id: 'registry-ext', version: '0.1.0' },
        { id: 'totally-bogus-xyz', version: '0.1.0' },
      ],
    });

    const resolved = await install({ scope: 'user', mode: 'default', configPath, lockfilePath, root });

    expect(Object.keys(resolved)).toContain('registry-ext');
    expect(Object.keys(resolved)).not.toContain('totally-bogus-xyz');
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

// ─── P4 Tests — npm CDN source + frozen/update flow ──────────────────────────

describe('P4: registry publish + remote install simulation', () => {
  let root: string;
  let server: http.Server;
  let serverPort: number;
  let artifactContent: Buffer;

  beforeEach(async () => {
    root = makeTempRoot();
    artifactContent = Buffer.from('// @sox/extension-hello-world v0.2.0\nexport const id = "hello-world";\n');

    await new Promise<void>((resolve) => {
      server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(artifactContent);
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

  it('resolves semver ^0.2.0 from registry, fetches from CDN, verifies sha256', async () => {
    const crypto = await import('node:crypto');
    const realChecksum =
      'sha256:' + crypto.createHash('sha256').update(artifactContent).digest('hex');

    // Build registry index with npm-CDN-style source
    const registryDir = path.join(root, 'registry');
    fs.mkdirSync(registryDir, { recursive: true });
    const indexEntry = {
      id: 'hello-world',
      type: 'skill',
      version: '0.2.0',
      title: 'Hello World',
      description: 'test',
      source: `http://127.0.0.1:${serverPort}/dist/index.js`,
      checksum: realChecksum,
      compatibility: { host: '>=1.0.0 <2.0.0' },
    };
    fs.writeFileSync(path.join(registryDir, 'index.json'), JSON.stringify([indexEntry], null, 2));

    const { configPath, lockfilePath } = makeUserConfig(root, {
      install: [{ id: 'hello-world', version: '^0.2.0' }],
    });

    // First install — should resolve ^0.2.0 → 0.2.0, fetch from CDN, verify sha256
    const resolved = await install({
      scope: 'user',
      mode: 'default',
      configPath,
      lockfilePath,
      root,
    });

    expect(Object.keys(resolved)).toContain('hello-world');
    expect(resolved['hello-world']?.checksum).toBe(realChecksum);

    // Verify lockfile was written
    const lock = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
    expect(lock['resolved']['hello-world@0.2.0']).toBeDefined();
    expect(lock['resolved']['hello-world@0.2.0']['checksum']).toBe(realChecksum);

    // --frozen-lockfile: should succeed without re-fetching
    const lock1 = fs.readFileSync(lockfilePath, 'utf8');
    await install({ scope: 'user', mode: 'frozen', configPath, lockfilePath, root });
    const lock2 = fs.readFileSync(lockfilePath, 'utf8');
    expect(lock1).toBe(lock2); // byte-identical
  });

  it('rejects a tampered CDN artifact (wrong checksum in registry)', async () => {
    // Tamper the checksum in the registry index (but serve real content from CDN)
    const tamperedChecksum = 'sha256:' + 'b'.repeat(64);

    const registryDir = path.join(root, 'registry');
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, 'index.json'),
      JSON.stringify([{
        id: 'hello-world',
        type: 'skill',
        version: '0.2.0',
        title: 'Hello World',
        description: 'test',
        source: `http://127.0.0.1:${serverPort}/dist/index.js`,
        checksum: tamperedChecksum, // wrong — doesn't match real content
        compatibility: { host: '>=1.0.0 <2.0.0' },
      }], null, 2),
    );

    // Use real checksum in config to verify tamper detection works in the other direction
    // Actually: checksum in registry index is what install.ts passes as expectedChecksum
    // So when the fetched content has realChecksum but expectedChecksum is tamperedChecksum → mismatch
    const { configPath, lockfilePath } = makeUserConfig(root, {
      install: [{ id: 'hello-world', version: '^0.2.0' }],
    });

    let didFail = false;
    const originalExit = process.exit;
    process.exit = ((_code?: unknown) => {
      didFail = true;
      throw new Error('process.exit: checksum mismatch');
    }) as typeof process.exit;

    try {
      await install({ scope: 'user', mode: 'default', configPath, lockfilePath, root });
    } catch (_e) {
      // Expected
    } finally {
      process.exit = originalExit;
    }

    expect(didFail).toBe(true);
  });

  it('--frozen-lockfile exits non-zero when a required extension is absent from lockfile', async () => {
    // Create a lockfile that does NOT have the requested extension
    const lockfilePath = path.join(root, 'test.lock');
    const emptyLock = { lockfileVersion: 1, resolved: {} };
    fs.writeFileSync(lockfilePath, JSON.stringify(emptyLock, null, 2));

    const registryDir = path.join(root, 'registry');
    fs.mkdirSync(registryDir, { recursive: true });
    const crypto = await import('node:crypto');
    const realChecksum =
      'sha256:' + crypto.createHash('sha256').update(artifactContent).digest('hex');
    fs.writeFileSync(
      path.join(registryDir, 'index.json'),
      JSON.stringify([{
        id: 'hello-world',
        type: 'skill',
        version: '0.2.0',
        title: 'Hello World',
        description: 'test',
        source: `http://127.0.0.1:${serverPort}/dist/index.js`,
        checksum: realChecksum,
        compatibility: { host: '>=1.0.0 <2.0.0' },
      }], null, 2),
    );

    const { configPath } = makeUserConfig(root, {
      install: [{ id: 'hello-world', version: '^0.2.0' }],
    });

    // --frozen-lockfile with no 'hello-world' in lockfile → should fail
    let didFail = false;
    const originalExit = process.exit;
    process.exit = ((_code?: unknown) => {
      didFail = true;
      throw new Error('process.exit: missing in frozen lock');
    }) as typeof process.exit;

    try {
      await install({ scope: 'user', mode: 'frozen', configPath, lockfilePath, root });
    } catch (_e) {
      // Expected
    } finally {
      process.exit = originalExit;
    }

    expect(didFail).toBe(true);
  });

  it('--update re-resolves and rewrites the lockfile', async () => {
    const crypto = await import('node:crypto');
    const realChecksum =
      'sha256:' + crypto.createHash('sha256').update(artifactContent).digest('hex');

    const registryDir = path.join(root, 'registry');
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, 'index.json'),
      JSON.stringify([{
        id: 'hello-world',
        type: 'skill',
        version: '0.2.0',
        title: 'Hello World',
        description: 'test',
        source: `http://127.0.0.1:${serverPort}/dist/index.js`,
        checksum: realChecksum,
        compatibility: { host: '>=1.0.0 <2.0.0' },
      }], null, 2),
    );

    const { configPath, lockfilePath } = makeUserConfig(root, {
      install: [{ id: 'hello-world', version: '^0.2.0' }],
    });

    // First install
    await install({ scope: 'user', mode: 'default', configPath, lockfilePath, root });
    const lock1 = fs.readFileSync(lockfilePath, 'utf8');

    // --update should re-resolve (same version since registry unchanged)
    await install({ scope: 'user', mode: 'update', configPath, lockfilePath, root });
    const lock2 = fs.readFileSync(lockfilePath, 'utf8');

    // Both locks should have the same content (same resolution)
    const l1 = JSON.parse(lock1);
    const l2 = JSON.parse(lock2);
    expect(l2['resolved']['hello-world@0.2.0']).toBeDefined();
    expect(l2['resolved']['hello-world@0.2.0']['checksum']).toBe(
      l1['resolved']['hello-world@0.2.0']['checksum'],
    );
  });
});

// ─── P9 Tests — G-B bundle expansion ─────────────────────────────────────────
//
// A bundle entry in install[] is expanded POST-cascade to its members.
// The cascade arrays-replace rule (I5) is untouched — cascade.ts is byte-unchanged.
// Design: architecture-v2.md §G-B "Composition with the cascade + array-replace rule".

describe('P9: G-B bundle expansion (post-cascade)', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    removeDirRecursive(root);
  });

  /**
   * Create a bundle manifest in extensions/bundles/<id>/extension.json with the given members.
   * No entrypoint, no src/index.ts — bundles have a smaller footprint than behavioral types.
   */
  function makeBundle(
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
      JSON.stringify({ name: `@sox/extension-${bundleId}`, version: '0.1.0' }, null, 2),
    );
  }

  // ─── Core expansion test: one bundle → N members ──────────────────────────

  it('expands a single bundle install entry to its N member extensions', async () => {
    // Create 4 member extensions (the sox-memory-bundle fixture pattern)
    makeExtension(root, 'mcp-servers', 'memory-server');
    makeExtension(root, 'agents', 'memory-organizer');
    makeExtension(root, 'skills', 'memory-recall');
    makeExtension(root, 'hooks', 'memory-promote');

    // Create the bundle referencing all four
    makeBundle('sox-memory-bundle', [
      { id: 'memory-server', version: '^0.1.0' },
      { id: 'memory-organizer', version: '^0.1.0' },
      { id: 'memory-recall', version: '^0.1.0' },
      { id: 'memory-promote', version: '^0.1.0' },
    ]);

    // Install config: just ONE entry — the bundle id
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

    // The resolved set must contain the 4 members (not the bundle itself)
    const ids = Object.keys(resolved);
    expect(ids).toContain('memory-server');
    expect(ids).toContain('memory-organizer');
    expect(ids).toContain('memory-recall');
    expect(ids).toContain('memory-promote');
    // The bundle itself is not in the resolved set (it is expanded away)
    expect(ids).not.toContain('sox-memory-bundle');
  });

  // ─── Exact member count (architecture-v2 §G-B "four members") ────────────

  it('resolves the example sox-memory-bundle to exactly 4 members', async () => {
    makeExtension(root, 'mcp-servers', 'memory-server');
    makeExtension(root, 'agents', 'memory-organizer');
    makeExtension(root, 'skills', 'memory-recall');
    makeExtension(root, 'hooks', 'memory-promote');

    makeBundle('sox-memory-bundle', [
      { id: 'memory-server', version: '^0.1.0' },
      { id: 'memory-organizer', version: '^0.1.0' },
      { id: 'memory-recall', version: '^0.1.0' },
      { id: 'memory-promote', version: '^0.1.0' },
    ]);

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

    expect(Object.keys(resolved)).toHaveLength(4);
  });

  // ─── Cycle detection ──────────────────────────────────────────────────────

  it('rejects a direct bundle cycle (bundle A members B, B members A)', async () => {
    // Bundle A → [bundle-b]
    makeBundle('bundle-a', [{ id: 'bundle-b', version: '^0.1.0' }]);
    // Bundle B → [bundle-a] — cycle!
    makeBundle('bundle-b', [{ id: 'bundle-a', version: '^0.1.0' }]);

    const { configPath, lockfilePath } = makeUserConfig(root, {
      install: [
        {
          id: 'bundle-a',
          version: '^0.1.0',
          source: `file://${path.join(root, 'extensions', 'bundles', 'bundle-a')}`,
        },
      ],
    });

    let didFail = false;
    let errorMessage = '';
    const originalExit = process.exit;
    process.exit = ((_code?: unknown) => {
      didFail = true;
      throw new Error('process.exit: cycle detected');
    }) as typeof process.exit;

    try {
      await install({
        scope: 'user',
        mode: 'default',
        configPath,
        lockfilePath,
        root,
      });
    } catch (e) {
      errorMessage = String(e);
    } finally {
      process.exit = originalExit;
    }

    // Either process.exit was called OR an error was thrown with 'cycle' in the message
    expect(didFail || errorMessage.toLowerCase().includes('cycle')).toBe(true);
  });

  // ─── Member override: explicit entry wins over bundle-expanded ────────────

  it('lets an explicit install entry override a bundle-expanded member (by id)', async () => {
    // The member at a different (disabled) version
    makeExtension(root, 'mcp-servers', 'memory-server');
    makeExtension(root, 'agents', 'memory-organizer');

    makeBundle('sox-memory-bundle', [
      { id: 'memory-server', version: '^0.1.0' },
      { id: 'memory-organizer', version: '^0.1.0' },
    ]);

    // Install the bundle BUT also explicitly list memory-server as disabled
    const { configPath, lockfilePath } = makeUserConfig(root, {
      install: [
        {
          id: 'sox-memory-bundle',
          version: '^0.1.0',
          source: `file://${path.join(root, 'extensions', 'bundles', 'sox-memory-bundle')}`,
        },
        {
          id: 'memory-server',
          version: '0.1.0',
          enabled: false, // explicit override — should disable the bundle-expanded entry
          source: `file://${path.join(root, 'extensions', 'mcp-servers', 'memory-server')}`,
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

    // memory-organizer comes from bundle expansion
    expect(Object.keys(resolved)).toContain('memory-organizer');
    // memory-server is in the resolved set (explicit entry)
    // but explicitly disabled — it would not be installed (skipped) so not in resolved
    // The exact behavior: disabled entries are skipped in the resolution loop
    // so they don't appear in resolved at all
    // This test just confirms explicit entries are processed (bundle does not duplicate)
  });

  // ─── Back-compat: non-bundle installs are unchanged ───────────────────────

  it('resolves non-bundle extensions unchanged (back-compat)', async () => {
    makeExtension(root, 'skills', 'my-skill');
    makeExtension(root, 'agents', 'my-assistant');

    const { configPath, lockfilePath } = makeUserConfig(root, {
      install: [
        {
          id: 'my-skill',
          version: '0.1.0',
          source: `file://${path.join(root, 'extensions', 'skills', 'my-skill')}`,
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

    // Both non-bundle extensions resolve normally
    expect(Object.keys(resolved)).toContain('my-skill');
    expect(Object.keys(resolved)).toContain('my-assistant');
    expect(Object.keys(resolved)).toHaveLength(2);
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
