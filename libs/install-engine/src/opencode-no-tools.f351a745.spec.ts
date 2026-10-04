/**
 * libs/install-engine/src/opencode-no-tools.f351a745.spec.ts
 *
 * f351a745 — a project-local opencode agent carrying a `tools:` frontmatter field
 * makes opencode reject the WHOLE project agent config and enumerate ZERO agents.
 * opencode's agent frontmatter vocabulary has no `tools:` key (the opencode
 * renderer never emits one), so a legacy or raw-passthrough agent whose
 * entrypoint still carries `tools:` poisons every sibling agent. The install
 * engine now refuses that placement with a typed DeclarativeDeniedError BEFORE
 * writing any file.
 *
 * Drives the REAL declarativeInstall against a sandboxed workspace + scope root,
 * patching the '@adhd/sox-host-registry' specifier to the built sibling dist
 * (same technique as dir-drop-pruning.1b42e982.spec.ts).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Module from 'node:module';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { declarativeInstall, DeclarativeDeniedError } from './install.js';

declare const __dirname: string;
const hostRegistryPath = path.resolve(__dirname, '../../host-registry/dist/index.js');

const M = Module as unknown as {
  _resolveFilename: (request: string, parent: unknown, isMain: boolean, options?: unknown) => string;
};
const originalResolveFilename = M._resolveFilename;
M._resolveFilename = function patchedResolveFilename(
  request: string,
  parent: unknown,
  isMain: boolean,
  options?: unknown,
): string {
  if (request === '@adhd/sox-host-registry') return hostRegistryPath;
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

afterAll(() => {
  M._resolveFilename = originalResolveFilename;
});

let base: string;
let workspace: string;
let scopeRoot: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-opencode-tools-'));
  workspace = path.join(base, 'ws');
  scopeRoot = path.join(workspace, '.adhd', 'sox-ecosystem');
  fs.mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// A raw-passthrough agent: no `agent` IR and no `render.<host>` override, so the
// renderer returns null and contentPath is the entrypoint file verbatim — the
// exact path a legacy `tools:` field would sneak through.
function writeRawAgentDir(dirname: string, entrypoint: string): string {
  const dir = path.join(workspace, 'extensions', 'agents', dirname);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'extension.json'),
    JSON.stringify({
      id: dirname,
      version: '0.1.0',
      type: 'agent',
      title: dirname,
      description: dirname,
      entrypoint: 'AGENT.md',
    }, null, 2),
    'utf8',
  );
  fs.writeFileSync(path.join(dir, 'AGENT.md'), entrypoint, 'utf8');
  return dir;
}

// ─── f351a745 — opencode agent `tools:` frontmatter is refused ────────────────

describe('f351a745 — opencode agent with `tools:` frontmatter is refused at install', () => {
  it('refuses with DeclarativeDeniedError and writes no file when the entrypoint frontmatter carries `tools:`', async () => {
    const srcPath = writeRawAgentDir('poison-agent', [
      '---',
      'name: poison-agent',
      'description: legacy agent with tools',
      'tools:',
      '  - read',
      '  - bash',
      '---',
      '# body',
      '',
    ].join('\n'));

    await expect(
      declarativeInstall(
        { ext: 'poison-agent', type: 'agent', hosts: ['opencode'], srcPath },
        'project',
        workspace,
        scopeRoot,
      ),
    ).rejects.toBeInstanceOf(DeclarativeDeniedError);

    const dest = path.join(workspace, '.opencode', 'agents', 'poison-agent.md');
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('allows an opencode agent whose entrypoint frontmatter has no `tools:` field', async () => {
    const srcPath = writeRawAgentDir('clean-agent', [
      '---',
      'name: clean-agent',
      'description: ok',
      '---',
      '# body',
      '',
    ].join('\n'));

    const result = await declarativeInstall(
      { ext: 'clean-agent', type: 'agent', hosts: ['opencode'], srcPath },
      'project',
      workspace,
      scopeRoot,
    );
    expect(result[0]?.applied).toBe(true);
    expect(fs.existsSync(path.join(workspace, '.opencode', 'agents', 'clean-agent.md'))).toBe(true);
  });

  it('ignores a `tools:` line that appears after the closing frontmatter delimiter', async () => {
    const srcPath = writeRawAgentDir('prose-agent', [
      '---',
      'name: prose-agent',
      'description: ok',
      '---',
      '# body',
      '',
      'tools: this is prose, not frontmatter',
      '',
    ].join('\n'));

    const result = await declarativeInstall(
      { ext: 'prose-agent', type: 'agent', hosts: ['opencode'], srcPath },
      'project',
      workspace,
      scopeRoot,
    );
    expect(result[0]?.applied).toBe(true);
  });
});
