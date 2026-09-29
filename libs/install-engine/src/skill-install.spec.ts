/**
 * libs/install-engine/src/skill-install.spec.ts — manifest-sourced skill headers
 * (bug aace3faa).
 *
 * Skills used to install by copying SKILL.md verbatim, so a hand-written YAML
 * frontmatter was the header the host actually surfaced — and a `description`
 * containing an unquoted "colon+space" (the 1ceffdbf drop) made the frontmatter
 * unparseable, silently hiding the skill. Now the install engine renders the
 * header from extension.json via host-registry's renderSkillFile and SKILL.md
 * is prose-only.
 *
 * Drives the REAL declarativeInstall (source-mode) against a sandboxed workspace
 * + scope root. install.ts lazily `require('@adhd/sox-host-registry')`; that bare
 * specifier only resolves after the post-tsc build (scripts/rewrite-paths.cjs),
 * so this spec redirects just that one specifier to the built sibling dist for
 * the duration of the run (same technique as reconcile-agent-mcp.spec.ts).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Module from 'node:module';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { declarativeInstall } from './install.js';

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

let workspace: string;
let scopeRoot: string;

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-skill-install-'));
  workspace = path.join(base, 'ws');
  // ADR-0004 §D2: scopeRoot is the DATA dir (.adhd/sox-ecosystem) for the scope,
  // exactly as apps/sox computes it — ledger AND ownership index live here.
  scopeRoot = path.join(workspace, '.adhd', 'sox-ecosystem');
  fs.mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(path.dirname(workspace), { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Write a fixture skill whose SOURCE SKILL.md still carries colon frontmatter. */
function writeSkill(id: string, manifestDescription: string, extra: string[] = []): string {
  const dir = path.join(workspace, 'extensions', 'skills', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'extension.json'),
    JSON.stringify({
      id,
      version: '0.1.0',
      type: 'skill',
      title: id,
      description: manifestDescription,
      entrypoint: 'SKILL.md',
      install: { type: 'skill', hosts: ['claude'] },
    }, null, 2),
    'utf8',
  );
  // The pre-fix source shape: an unquoted colon+space in a hand-written scalar.
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${id}\ndescription: backlog: product prioritizes\n---\n\n# ${id}\n\nbacklog: product prioritizes — the colon text survives in the body\n${extra.join('\n')}\n`,
    'utf8',
  );
  return dir;
}

function installedSkillMd(id: string): string {
  return path.join(workspace, '.claude', 'skills', id, 'SKILL.md');
}

describe('skill install — header rendered from the manifest, SKILL.md prose-only', () => {
  it('installs with a generated header and the colon text surviving in the body', async () => {
    const srcPath = writeSkill('colon-skill', 'Use this when the manifest description wins');
    const results = await declarativeInstall(
      { ext: 'colon-skill', type: 'skill', hosts: ['claude'], srcPath },
      'project',
      workspace,
      scopeRoot,
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.applied).toBe(true);

    const content = fs.readFileSync(installedSkillMd('colon-skill'), 'utf8');
    // Header is generated from the manifest, name == id.
    expect(content.startsWith('---\nname: colon-skill\ndescription: Use this when the manifest description wins\n---\n')).toBe(true);
    // The colon text survives in the body (prose), not as a broken scalar.
    expect(content).toContain('backlog: product prioritizes — the colon text survives in the body');
    // Exactly one header fence pair; the source frontmatter name is not duplicated.
    expect(content.match(/^---$/gm)).toHaveLength(2);
  });

  it('is idempotent (no rewrite) and re-renders when the manifest description changes', async () => {
    const srcPath = writeSkill('colon-skill', 'Use this when the manifest description wins');
    const first = await declarativeInstall(
      { ext: 'colon-skill', type: 'skill', hosts: ['claude'], srcPath },
      'project',
      workspace,
      scopeRoot,
    );
    expect(first[0]?.applied).toBe(true);

    const second = await declarativeInstall(
      { ext: 'colon-skill', type: 'skill', hosts: ['claude'], srcPath },
      'project',
      workspace,
      scopeRoot,
    );
    expect(second[0]?.applied).toBe(false);
    expect(fs.readFileSync(installedSkillMd('colon-skill'), 'utf8')).toContain(
      'description: Use this when the manifest description wins',
    );

    // Change the manifest description — the header must follow.
    fs.writeFileSync(
      path.join(srcPath, 'extension.json'),
      JSON.stringify({
        id: 'colon-skill',
        version: '0.1.0',
        type: 'skill',
        title: 'colon-skill',
        description: 'A different manifest description now',
        entrypoint: 'SKILL.md',
        install: { type: 'skill', hosts: ['claude'] },
      }, null, 2),
      'utf8',
    );
    const third = await declarativeInstall(
      { ext: 'colon-skill', type: 'skill', hosts: ['claude'], srcPath },
      'project',
      workspace,
      scopeRoot,
    );
    expect(third[0]?.applied).toBe(true);
    expect(fs.readFileSync(installedSkillMd('colon-skill'), 'utf8')).toContain(
      'description: A different manifest description now',
    );
  });

  it('copies the whole skill dir (references/, assets/) alongside the rendered SKILL.md', async () => {
    const srcPath = writeSkill('colon-skill', 'Use this when the manifest description wins');
    fs.mkdirSync(path.join(srcPath, 'references'), { recursive: true });
    fs.writeFileSync(path.join(srcPath, 'references', 'guide.md'), '# guide\n', 'utf8');
    await declarativeInstall(
      { ext: 'colon-skill', type: 'skill', hosts: ['claude'], srcPath },
      'project',
      workspace,
      scopeRoot,
    );
    expect(fs.readFileSync(path.join(workspace, '.claude', 'skills', 'colon-skill', 'references', 'guide.md'), 'utf8')).toBe('# guide\n');
  });

  it('a file removed from the source is not a silent no-op on re-install — e1e98fe0', async () => {
    const srcPath = writeSkill('colon-skill', 'Use this when the manifest description wins');
    fs.mkdirSync(path.join(srcPath, 'references'), { recursive: true });
    const gone = path.join(srcPath, 'references', 'gone.md');
    fs.writeFileSync(gone, '# gone\n', 'utf8');
    const first = await declarativeInstall(
      { ext: 'colon-skill', type: 'skill', hosts: ['claude'], srcPath },
      'project',
      workspace,
      scopeRoot,
    );
    expect(first[0]?.applied).toBe(true);

    // SKILL.md is byte-identical, so the rendered-content cache key does not change.
    // Without pruning the staged tree the source hash would stay at its previous value
    // and the install would report applied=false over stale content.
    fs.rmSync(gone);
    const second = await declarativeInstall(
      { ext: 'colon-skill', type: 'skill', hosts: ['claude'], srcPath },
      'project',
      workspace,
      scopeRoot,
    );
    expect(second[0]?.applied).toBe(true);
    // Destination-side pruning is a separate, pre-existing defect (1b42e982).
  });

  it('refuses an ext that escapes the staging root instead of writing outside it — cf915fee', async () => {
    const srcPath = writeSkill('colon-skill', 'Use this when the manifest description wins');
    const probes = () =>
      fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('sox-escape-probe'));
    const before = probes(); // scoped to what THIS run creates — a prior run must not decide it
    await expect(
      declarativeInstall(
        { ext: '../sox-escape-probe', type: 'skill', hosts: ['claude'], srcPath },
        'project',
        workspace,
        scopeRoot,
      ),
    ).rejects.toThrow();
    // os.tmpdir() is writable, so only the containment guard — not a permission error —
    // can explain the absence of a NEWLY escaped staging directory.
    expect(probes()).toEqual(before);
  });
});

describe('sweep — every real skill renders and its id == dirname', () => {
  const renderSkillFile = (require(hostRegistryPath) as {
    renderSkillFile: (m: unknown, p: string) => { kind: string; content?: string } | null;
  }).renderSkillFile;

  const skillsRoot = path.resolve(__dirname, '../../../extensions/skills');
  const memoryUsageRoot = path.resolve(
    __dirname,
    '../../../extensions/bundles/sox-memory-bundle/members/memory-usage',
  );

  it('every extensions/skills/* and memory-usage member renders with name == dirname', () => {
    const violations: string[] = [];
    const skillDirs = [
      ...fs.readdirSync(skillsRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(skillsRoot, e.name)),
      memoryUsageRoot,
    ];

    for (const dir of skillDirs) {
      const manifestPath = path.join(dir, 'extension.json');
      const skillMdPath = path.join(dir, 'SKILL.md');
      if (!fs.existsSync(manifestPath) || !fs.existsSync(skillMdPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { id?: string };
      const prose = fs.readFileSync(skillMdPath, 'utf8');
      const dirname = path.basename(dir);
      // Source SKILL.md must be prose-only (no leading fence).
      if (/^\s*---\s*$/.test(prose.split('\n')[0] ?? '')) {
        violations.push(`${dir}: source SKILL.md still carries frontmatter`);
      }
      const rendered = renderSkillFile(manifest, prose);
      if (rendered === null) {
        violations.push(`${dir}: manifest has no usable id/description`);
        continue;
      }
      const content = rendered.content ?? '';
      if (!content.startsWith(`---\nname: ${dirname}\n`)) {
        violations.push(`${dir}: rendered name is not the directory basename (id=${manifest.id})`);
      }
    }
    expect(violations).toEqual([]);
  });
});
