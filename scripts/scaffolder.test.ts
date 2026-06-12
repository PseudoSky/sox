/**
 * scaffolder.test.ts — P3 scaffolder tests
 *
 * Verifies that new-extension.ts emits type-specific doc stubs (README.md, SKILL.md,
 * CLAUDE.md), pre-fills P2 self-description fields in extension.json, and produces
 * output that passes validate-manifests.ts.
 *
 * All throwaway extensions are scaffolded into OS temp dirs and cleaned up in afterEach.
 * No extension is written under extensions/ — the 11-extension count is preserved.
 *
 * Constraints:
 *   - Never pipe a command whose exit code is being tested.
 *   - Use --out <dir> so output stays outside the repo extensions/ tree.
 *   - All scaffold + validate calls are synchronous (spawnSync).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { validateManifests } from './validate-manifests.js';

const ROOT = path.resolve(import.meta.dirname ?? process.cwd(), '..');
const NEW_EXT = path.join(ROOT, 'scripts', 'new-extension.ts');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sox-p3-'));
}

/**
 * Scaffold via `node scripts/new-extension.ts <type> <id> [flags]` using npx tsx.
 * Returns spawnSync result.
 */
function scaffold(
  type: string,
  id: string,
  out: string,
  extra: string[] = [],
): ReturnType<typeof spawnSync> {
  return spawnSync('npx', ['tsx', NEW_EXT, type, id, '--out', out, ...extra], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('P3 scaffolder — doc stubs', () => {
  let tmpDir: string;
  let extDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── skill type ─────────────────────────────────────────────────────────────

  it('skill: exits 0 and emits README + SKILL.md', () => {
    const result = scaffold('skill', 'probe-skill-docs', tmpDir, [
      '--description',
      'use this when probing the scaffolder',
      '--author',
      'Test Suite',
    ]);
    expect(result.status).toBe(0);

    extDir = path.join(tmpDir, 'probe-skill-docs');
    expect(fs.existsSync(path.join(extDir, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(extDir, 'SKILL.md'))).toBe(true);
  });

  it('skill: does NOT emit CLAUDE.md', () => {
    scaffold('skill', 'probe-skill-no-claude', tmpDir);
    extDir = path.join(tmpDir, 'probe-skill-no-claude');
    expect(fs.existsSync(path.join(extDir, 'CLAUDE.md'))).toBe(false);
  });

  it('skill: README.md has type-specific section headings', () => {
    scaffold('skill', 'probe-skill-readme', tmpDir, [
      '--description',
      'use this when probing',
    ]);
    extDir = path.join(tmpDir, 'probe-skill-readme');
    const readme = fs.readFileSync(path.join(extDir, 'README.md'), 'utf8');
    expect(readme).toContain('## When to use');
    expect(readme).toContain('## Inputs');
    expect(readme).toContain('## Outputs');
  });

  it('skill: SKILL.md has invocation contract sections', () => {
    scaffold('skill', 'probe-skill-skillmd', tmpDir, [
      '--description',
      'use this when probing',
    ]);
    extDir = path.join(tmpDir, 'probe-skill-skillmd');
    const skillMd = fs.readFileSync(path.join(extDir, 'SKILL.md'), 'utf8');
    expect(skillMd).toContain('## Invocation guidance');
    expect(skillMd).toContain('## Input contract');
    expect(skillMd).toContain('## Output contract');
  });

  // ── agent type ─────────────────────────────────────────────────────────────

  it('agent: emits README + CLAUDE.md, no SKILL.md', () => {
    scaffold('agent', 'probe-agent-docs', tmpDir, [
      '--description',
      'use this when probing agents',
    ]);
    extDir = path.join(tmpDir, 'probe-agent-docs');
    expect(fs.existsSync(path.join(extDir, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(extDir, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(extDir, 'SKILL.md'))).toBe(false);
  });

  it('agent: CLAUDE.md has agent-specific sections', () => {
    scaffold('agent', 'probe-agent-claude', tmpDir, [
      '--description',
      'use this when probing agents',
    ]);
    extDir = path.join(tmpDir, 'probe-agent-claude');
    const claudeMd = fs.readFileSync(path.join(extDir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('## When to delegate');
    expect(claudeMd).toContain('## Tools required');
  });

  // ── mcp-server type ────────────────────────────────────────────────────────

  it('mcp-server: emits README + CLAUDE.md, no SKILL.md', () => {
    scaffold('mcp-server', 'probe-mcp-docs', tmpDir, [
      '--description',
      'use this when probing mcp servers',
    ]);
    extDir = path.join(tmpDir, 'probe-mcp-docs');
    expect(fs.existsSync(path.join(extDir, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(extDir, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(extDir, 'SKILL.md'))).toBe(false);
  });

  it('mcp-server: CLAUDE.md has tool guidance sections', () => {
    scaffold('mcp-server', 'probe-mcp-claude', tmpDir, [
      '--description',
      'use this when probing mcp',
    ]);
    extDir = path.join(tmpDir, 'probe-mcp-claude');
    const claudeMd = fs.readFileSync(path.join(extDir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('## Available tools');
    expect(claudeMd).toContain('## When to call tools');
  });

  // ── hook type ──────────────────────────────────────────────────────────────

  it('hook: emits README only (no SKILL.md, no CLAUDE.md)', () => {
    scaffold('hook', 'probe-hook-docs', tmpDir, [
      '--description',
      'use this when probing hooks',
    ]);
    extDir = path.join(tmpDir, 'probe-hook-docs');
    expect(fs.existsSync(path.join(extDir, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(extDir, 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(extDir, 'CLAUDE.md'))).toBe(false);
  });

  it('hook: README.md has hook-specific sections', () => {
    scaffold('hook', 'probe-hook-readme', tmpDir, [
      '--description',
      'use this when probing',
    ]);
    extDir = path.join(tmpDir, 'probe-hook-readme');
    const readme = fs.readFileSync(path.join(extDir, 'README.md'), 'utf8');
    expect(readme).toContain('## Lifecycle event');
    expect(readme).toContain('## Execution order');
  });

  // ── command type ───────────────────────────────────────────────────────────

  it('command: emits README only', () => {
    scaffold('command', 'probe-cmd-docs', tmpDir, [
      '--description',
      'use this when probing commands',
    ]);
    extDir = path.join(tmpDir, 'probe-cmd-docs');
    expect(fs.existsSync(path.join(extDir, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(extDir, 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(extDir, 'CLAUDE.md'))).toBe(false);
  });

  // ── prompt type ────────────────────────────────────────────────────────────

  it('prompt: emits README only', () => {
    scaffold('prompt', 'probe-prompt-docs', tmpDir, [
      '--description',
      'use this when probing prompts',
    ]);
    extDir = path.join(tmpDir, 'probe-prompt-docs');
    expect(fs.existsSync(path.join(extDir, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(extDir, 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(extDir, 'CLAUDE.md'))).toBe(false);
  });

  // ── bundle type ────────────────────────────────────────────────────────────

  it('bundle: emits README only', () => {
    scaffold('bundle', 'probe-bundle-docs', tmpDir, [
      '--description',
      'use this when probing bundles',
    ]);
    extDir = path.join(tmpDir, 'probe-bundle-docs');
    expect(fs.existsSync(path.join(extDir, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(extDir, 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(extDir, 'CLAUDE.md'))).toBe(false);
  });
});

// ── P2 self-description field pre-fill ────────────────────────────────────────

describe('P3 scaffolder — P2 self-description fields', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('pre-fills description in extension.json', () => {
    scaffold('skill', 'probe-desc-field', tmpDir, [
      '--description',
      'use this when probing description fields',
    ]);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'probe-desc-field', 'extension.json'), 'utf8'),
    );
    expect(manifest.description).toBe('use this when probing description fields');
  });

  it('pre-fills author in extension.json', () => {
    scaffold('skill', 'probe-author-field', tmpDir, [
      '--description',
      'use this when probing author fields',
      '--author',
      'Jane Doe',
    ]);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'probe-author-field', 'extension.json'), 'utf8'),
    );
    expect(manifest.author).toBe('Jane Doe');
  });

  it('pre-fills keywords array in extension.json', () => {
    scaffold('skill', 'probe-keywords-field', tmpDir, [
      '--description',
      'use this when probing keyword fields',
      '--keywords',
      'probe,testing,scaffold',
    ]);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'probe-keywords-field', 'extension.json'), 'utf8'),
    );
    expect(Array.isArray(manifest.keywords)).toBe(true);
    expect(manifest.keywords).toContain('probe');
    expect(manifest.keywords).toContain('testing');
    expect(manifest.keywords).toContain('scaffold');
  });

  it('extension.json without --author omits author field', () => {
    scaffold('skill', 'probe-no-author', tmpDir, [
      '--description',
      'use this when probing no-author case',
    ]);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'probe-no-author', 'extension.json'), 'utf8'),
    );
    // author should be absent (not empty string) when not provided
    expect(manifest.author).toBeUndefined();
  });

  it('extension.json without --keywords omits keywords field', () => {
    scaffold('skill', 'probe-no-keywords', tmpDir, [
      '--description',
      'use this when probing no-keywords case',
    ]);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'probe-no-keywords', 'extension.json'), 'utf8'),
    );
    expect(manifest.keywords).toBeUndefined();
  });
});

// ── Validate-manifests integration ────────────────────────────────────────────

describe('P3 scaffolder — validate-manifests integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('scaffolded skill passes validateManifests (direct dir mode)', () => {
    scaffold('skill', 'probe-validate-skill', tmpDir, [
      '--description',
      'use this when probing validate',
      '--author',
      'QA',
      '--keywords',
      'probe,validate',
    ]);
    const extDir = path.join(tmpDir, 'probe-validate-skill');
    const result = validateManifests(extDir);
    expect(result.ok).toBe(true);
    const errors = result.errors.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('scaffolded agent passes validateManifests', () => {
    scaffold('agent', 'probe-validate-agent', tmpDir, [
      '--description',
      'use this when probing agent validate',
    ]);
    const extDir = path.join(tmpDir, 'probe-validate-agent');
    const result = validateManifests(extDir);
    expect(result.ok).toBe(true);
  });

  it('scaffolded mcp-server passes validateManifests', () => {
    scaffold('mcp-server', 'probe-validate-mcp', tmpDir, [
      '--description',
      'use this when probing mcp validate',
    ]);
    const extDir = path.join(tmpDir, 'probe-validate-mcp');
    // P0 entrypoint-reachability: create dist/index.js stub (simulates post-build state)
    fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), '// stub compiled output\n');
    const result = validateManifests(extDir);
    expect(result.ok).toBe(true);
  });

  it('scaffolded hook passes validateManifests', () => {
    scaffold('hook', 'probe-validate-hook', tmpDir, [
      '--description',
      'use this when probing hook validate',
    ]);
    const extDir = path.join(tmpDir, 'probe-validate-hook');
    const result = validateManifests(extDir);
    expect(result.ok).toBe(true);
  });

  it('the P3 acceptance check scenario: skill scaffold-probe exits 0 on validate', () => {
    // Mirrors the exact acceptance check from migration.md Phase 3
    scaffold('skill', 'scaffold-probe', tmpDir, [
      '--description',
      'use this when probing',
      '--author',
      'QA',
    ]);
    const extDir = path.join(tmpDir, 'scaffold-probe');

    // README + SKILL.md present
    expect(fs.existsSync(path.join(extDir, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(extDir, 'SKILL.md'))).toBe(true);

    // manifest carries P2 fields
    const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'extension.json'), 'utf8'));
    const hasDescriptionAndDiscovery = manifest.description && (manifest.keywords ?? manifest.author);
    expect(hasDescriptionAndDiscovery).toBeTruthy();

    // P0 entrypoint-reachability: create dist/index.js stub (simulates post-build state)
    fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), '// stub compiled output\n');

    // passes validate-manifests
    const result = validateManifests(extDir);
    expect(result.ok).toBe(true);
  });
});

// ── bin/sox init alias ─────────────────────────────────────────────────────────

describe('bin/sox init alias', () => {
  const SOX = path.join(ROOT, 'bin', 'sox');

  function sox(args: string[]): { status: number; stdout: string; stderr: string } {
    const result = spawnSync('node', [SOX, ...args], { cwd: ROOT, encoding: 'utf8' });
    return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  it('sox init --help exits 0', () => {
    const r = sox(['init', '--help']);
    expect(r.status).toBe(0);
  });

  it('sox new --help exits 0', () => {
    const r = sox(['new', '--help']);
    expect(r.status).toBe(0);
  });

  it('sox init --help mentions types and flags', () => {
    const r = sox(['init', '--help']);
    expect(r.stdout).toContain('skill');
    expect(r.stdout).toContain('--description');
    expect(r.stdout).toContain('--author');
    expect(r.stdout).toContain('--keywords');
    expect(r.stdout).toContain('--out');
  });

  it('sox --help lists init verb', () => {
    const r = sox(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('init');
  });
});

// ── Scaffolder validation — invalid inputs ─────────────────────────────────────

describe('P3 scaffolder — input validation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('exits non-zero on invalid type', () => {
    const result = scaffold('bogus-type', 'probe-bad-type', tmpDir);
    expect(result.status).not.toBe(0);
  });

  it('exits non-zero on id that ends with type name', () => {
    const result = scaffold('skill', 'my-probe-skill', tmpDir, [
      '--description',
      'use this when probing',
    ]);
    // id 'my-probe-skill' ends with '-skill' which is forbidden
    expect(result.status).not.toBe(0);
  });

  it('exits non-zero when extension dir already exists', () => {
    scaffold('skill', 'probe-exists', tmpDir, ['--description', 'use this when probing']);
    // Scaffold again into the same out dir — should fail
    const result = scaffold('skill', 'probe-exists', tmpDir, [
      '--description',
      'use this when probing again',
    ]);
    expect(result.status).not.toBe(0);
  });
});
