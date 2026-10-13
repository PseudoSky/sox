/**
 * diff-content.spec.ts — content-level drift and the project-scope path contract.
 *
 *   - unifiedLineDiff: the line diff the `soxe diff` content view prints.
 *   - diff() with placementRoot: a project-scope ledger stores WORKSPACE-relative paths.
 *     Regression: resolving them against the data root reported an existing, drifted file
 *     as `missing` (backlog 5d94f88d).
 *   - desiredPlacedContent: the rendered bytes equal what declarativeInstall places, so a
 *     content diff compares against the real placement, not a guess.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Module from 'node:module';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diff, unifiedLineDiff } from './diff.js';

// Same host-registry patch as opencode-no-tools.f351a745.spec.ts: the install engine loads
// '@adhd/sox-host-registry' at call time, and the workspace link is not present in vitest.
declare const __dirname: string;
const hostRegistryPath = path.resolve(__dirname, '../../host-registry/dist/index.js');
const M = Module as unknown as {
  _resolveFilename: (request: string, parent: unknown, isMain: boolean, options?: unknown) => string;
};
const originalResolveFilename = M._resolveFilename;
M._resolveFilename = function patchedResolveFilename(request: string, parent: unknown, isMain: boolean, options?: unknown): string {
  if (request === '@adhd/sox-host-registry') return hostRegistryPath;
  return originalResolveFilename.call(this, request, parent, isMain, options);
};
afterAll(() => {
  M._resolveFilename = originalResolveFilename;
});

describe('unifiedLineDiff', () => {
  it('returns no lines for identical text', () => {
    expect(unifiedLineDiff('a\nb\n', 'a\nb\n')).toEqual([]);
  });
  it('marks a changed line as removed then added', () => {
    expect(unifiedLineDiff('a\nold\nc\n', 'a\nnew\nc\n')).toEqual(['-old', '+new']);
  });
  it('treats an empty current file as all additions', () => {
    expect(unifiedLineDiff('', 'x\ny\n')).toEqual(['+x', '+y']);
  });
  it('treats a missing desired file as all removals', () => {
    expect(unifiedLineDiff('x\ny\n', '')).toEqual(['-x', '-y']);
  });
});

describe('diff: project-scope placement resolution (backlog 5d94f88d)', () => {
  let ws: string;
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-content-'));
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('reports a drifted workspace-relative file as drifted, not missing', () => {
    const original = '# agent\nbody\n';
    const rel = path.join('.claude', 'agents', 'x.md');
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), 'EDITED\n');
    const scopeRoot = path.join(ws, '.adhd', 'sox-ecosystem');
    fs.mkdirSync(scopeRoot, { recursive: true });
    fs.writeFileSync(
      path.join(scopeRoot, 'ledger.json'),
      JSON.stringify({
        version: 1,
        entries: [{
          ext: 'x', host: 'claude', scope: 'project',
          actions: [{ cap: 'file-drop', file: rel, keyPath: '',
            appliedHash: 'sha256:' + crypto.createHash('sha256').update(original).digest('hex') }],
          installedAt: '2026-01-01T00:00:00.000Z',
        }],
      }),
    );
    const d = diff('x', 'claude', 'project', scopeRoot, { isProject: true, placementRoot: ws });
    expect(d.actions[0]!.kind).toBe('drifted');
    expect(d.clean).toBe(false);
  });
});

describe('desiredPlacedContent', () => {
  it('renders a claude agent entrypoint with frontmatter and its name', async () => {
    const { desiredPlacedContent } = await import('./install.js');
    const src = path.resolve(__dirname, '../../../extensions/agents/dispatcher');
    const content = desiredPlacedContent(src, 'dispatcher', 'agent', 'claude');
    expect(typeof content).toBe('string');
    expect(content!.startsWith('---\n')).toBe(true);
    expect(content!).toMatch(/name: dispatcher/);
  });
  it('desiredPlacedArtifact: an agent renders to a file and a skill to a directory whose SKILL.md is the content', async () => {
    const { desiredPlacedArtifact, desiredPlacedContent } = await import('./install.js');
    const agentSrc = path.resolve(__dirname, '../../../extensions/agents/dispatcher');
    const agent = desiredPlacedArtifact(agentSrc, 'dispatcher', 'agent', 'claude');
    expect(fs.statSync(agent!).isFile()).toBe(true);
    const skillSrc = path.resolve(__dirname, '../../../extensions/skills/research');
    const skill = desiredPlacedArtifact(skillSrc, 'research', 'skill', 'claude');
    expect(fs.statSync(skill!).isDirectory()).toBe(true);
    expect(desiredPlacedContent(skillSrc, 'research', 'skill', 'claude')).toBe(
      fs.readFileSync(path.join(skill!, 'SKILL.md'), 'utf8'),
    );
  });
  it('returns null for a type with no file renderer', async () => {
    const { desiredPlacedContent } = await import('./install.js');
    const src = path.resolve(__dirname, '../../../extensions/agents/dispatcher');
    expect(desiredPlacedContent(src, 'dispatcher', 'mcp-server', 'claude')).toBeNull();
  });
});
