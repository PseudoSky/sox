/**
 * libs/install-engine/src/agent-file-drop.bl566.spec.ts
 *
 * BL-566 regression — declarative AGENT extensions must install as a single
 * top-level `<id>.md` file, never as a directory `<id>/`, because opencode's
 * agent scan only discovers top-level `agents/*.md` files.
 *
 * RED (pre-fix): `soxe install <agent> --host opencode` placed
 * `agents/<id>/` (whole extension dir) — `opencode run --agent <id>` returned
 * "agent not found" (verified live 2026-08-12 during dispatcher migration).
 * GREEN (post-fix): the install places `agents/<id>.md` (the entrypoint file)
 * and NO directory.
 *
 * Harness mirrors apps/sox/src/install-dryrun.spec.ts: drives the REAL built
 * CLI as a subprocess against a sandboxed workspace + data home so no real
 * home dir is touched. Requires the built CLI at dist/apps/sox/main.js.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI_MAIN = path.resolve(__dirname, '../../../dist/apps/sox/main.js');

let workspace: string;
let dataHome: string;

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI_MAIN, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SOX_ECOSYSTEM_HOME: dataHome,
    },
    cwd: workspace,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function makeAgentExtension(root: string, id: string): string {
  const extDir = path.join(root, 'extensions', 'agents', id);
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(
    path.join(extDir, 'extension.json'),
    JSON.stringify({
      $schema: 'https://your-registry/schemas/extension/v2.json',
      id,
      version: '0.1.0',
      type: 'agent',
      title: `${id} title`,
      description: `${id} description`,
      compatibility: { host: '>=1.0.0 <2.0.0' },
      license: 'MIT',
      runtime: 'declarative',
      entrypoint: `${id}.md`,
      install: { type: 'agent', hosts: ['opencode'] },
    }, null, 2),
  );
  fs.writeFileSync(
    path.join(extDir, 'package.json'),
    JSON.stringify({ name: `@adhd/sox-extension-${id}`, version: '0.1.0', private: true }),
  );
  // The entrypoint file that must land at <agents>/<id>.md
  fs.writeFileSync(
    path.join(extDir, `${id}.md`),
    `---\nname: ${id}\ndescription: ${id} test agent\n---\n\n# ${id}\n`,
  );
  // A non-entrypoint file that must NOT land at the top level (it belongs to
  // the extension dir, not the host agents dir).
  fs.writeFileSync(path.join(extDir, 'README.md'), `# ${id} readme\n`);
  return extDir;
}

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl566-'));
  workspace = path.join(base, 'workspace');
  dataHome = path.join(base, 'data');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(dataHome, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(path.dirname(workspace), { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('BL-566 — agent install file-drop lands as a single top-level <id>.md', () => {
  it('dry-run reports the file target, not a directory', () => {
    makeAgentExtension(workspace, 'bl566probe');
    const r = runCli(['install', 'bl566probe', '--host', 'opencode', '--scope', 'project', '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('would place');
    // The planned target must be the file, not a directory path.
    expect(r.stdout).toContain('.opencode/agents/bl566probe.md');
    expect(r.stdout).not.toContain('.opencode/agents/bl566probe/');
  });

  it('real install places <id>.md (entrypoint) and creates NO <id>/ directory', () => {
    makeAgentExtension(workspace, 'bl566probe');
    const r = runCli(['install', 'bl566probe', '--host', 'opencode', '--scope', 'project']);
    expect(r.code).toBe(0);
    const agentsDir = path.join(workspace, '.opencode', 'agents');
    // The agent is discoverable: a top-level <id>.md exists.
    expect(fs.existsSync(path.join(agentsDir, 'bl566probe.md'))).toBe(true);
    // No directory form exists (the bug: agents/<id>/).
    expect(fs.existsSync(path.join(agentsDir, 'bl566probe'))).toBe(false);
    // The dropped file is the entrypoint content, not a directory copy.
    const content = fs.readFileSync(path.join(agentsDir, 'bl566probe.md'), 'utf8');
    expect(content).toContain('# bl566probe');
    // Non-entrypoint extension files must NOT leak to the agents dir.
    expect(fs.existsSync(path.join(agentsDir, 'bl566probe', 'README.md'))).toBe(false);
    expect(fs.existsSync(path.join(agentsDir, 'README.md'))).toBe(false);
  });

  it('idempotent: a second install does not rewrite when content is unchanged', () => {
    const extDir = makeAgentExtension(workspace, 'bl566probe');
    const r1 = runCli(['install', 'bl566probe', '--host', 'opencode', '--scope', 'project']);
    expect(r1.code).toBe(0);
    const dropped = path.join(workspace, '.opencode', 'agents', 'bl566probe.md');
    const mtime1 = fs.statSync(dropped).mtimeMs;
    // Wait 5ms so a real rewrite would change mtime, then re-install.
    const t0 = Date.now();
    while (Date.now() - t0 < 5) { /* busy wait */ }
    const r2 = runCli(['install', 'bl566probe', '--host', 'opencode', '--scope', 'project']);
    expect(r2.code).toBe(0);
    const mtime2 = fs.statSync(dropped).mtimeMs;
    // Content hash matches → applied=false → file untouched.
    expect(mtime2).toBe(mtime1);
    // Sanity: the extension still exists (we didn't delete it mid-test).
    expect(fs.existsSync(path.join(extDir, 'extension.json'))).toBe(true);
  });
});

describe('BL-569 — install refuses to clobber an unowned destination file', () => {
  it('refuses when the destination exists but is not owned by the extension', () => {
    makeAgentExtension(workspace, 'bl569probe');
    // Plant an unowned pre-existing file at the exact destination an install would
    // write (a hand-authored / legacy host agent — the researcher.md incident).
    const agentsDir = path.join(workspace, '.opencode', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'bl569probe.md'), '# legacy hand-authored agent\n');
    const r = runCli(['install', 'bl569probe', '--host', 'opencode', '--scope', 'project']);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('refusing to overwrite unowned file');
    // The legacy file is untouched.
    expect(fs.readFileSync(path.join(agentsDir, 'bl569probe.md'), 'utf8')).toBe('# legacy hand-authored agent\n');
  });

  it('--force overwrites the unowned destination deliberately', () => {
    makeAgentExtension(workspace, 'bl569probe');
    const agentsDir = path.join(workspace, '.opencode', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'bl569probe.md'), '# legacy hand-authored agent\n');
    const r = runCli(['install', 'bl569probe', '--host', 'opencode', '--scope', 'project', '--force']);
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(agentsDir, 'bl569probe.md'), 'utf8')).toContain('# bl569probe');
  });
});
