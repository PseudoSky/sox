/**
 * apps/sox/src/manifest-path-escape-cli.bug-epic-manifest-path-escape-001.spec.ts
 *
 * BUG-EPIC-MANIFEST-PATH-ESCAPE-001 — CLI-level RED->GREEN regression, driving
 * the REAL built CLI (dist/apps/sox/main.js) as a subprocess, same harness
 * convention as agent-file-drop.bl566.spec.ts / install-dryrun.spec.ts.
 *
 * Covers two of the epic's classes that only manifest through the real
 * `declarativeInstall`/`resolveOsUnitContext`/`cmdExec` call graph (host
 * lookup requires the built dist — see the NOTE in install-engine's
 * manifest-path-escape spec for why this can't run in source-mode vitest):
 *
 *   1. CLI-argument class: `descriptor.ext` (the CLI positional / registry id)
 *      flows unvalidated into install.ts's agent file-drop dest join. A
 *      malicious extension whose OWN manifest.id is "../../evil" (findable
 *      because findLocalExtension matches by manifest.id content, not by
 *      directory name — verified in libs/install-engine/src/install.ts
 *      findLocalExtension) reaches declarativeInstall with
 *      descriptor.ext === "../../evil".
 *
 *   2. Manifest-declared entrypoint class: `soxe serve` resolves and (absent
 *      the refusal) would spawn manifest.entrypoint directly — one of the
 *      most severe sites in the epic, since a successful escape is arbitrary
 *      code execution, not just a file read. `serve` needs no prior
 *      install/lockfile entry — it falls back to findLocalExtension the same
 *      way `install` does (verified: apps/sox/src/main.ts cmdServe, extDir2
 *      resolution), so the fixture setup mirrors the install-class test.
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

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-path-escape-'));
  workspace = path.join(base, 'workspace');
  dataHome = path.join(base, 'data');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(dataHome, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(path.dirname(workspace), { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('CLI-argument class — descriptor.ext escape via type:agent file-drop', () => {
  it('REFUSES install when the extension manifest declares id "../../evil"', () => {
    // Directory name is irrelevant — findLocalExtension matches by
    // manifest.id content, so an attacker who controls the manifest (a
    // file:// / registry-sourced extension) controls what descriptor.ext
    // becomes even though the on-disk dirname stays innocuous.
    const extDir = path.join(workspace, 'extensions', 'agents', 'innocuous-dirname');
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        id: '../../evil',
        version: '0.1.0',
        type: 'agent',
        title: 'evil',
        description: 'evil',
        runtime: 'declarative',
        entrypoint: 'evil.md',
        install: { type: 'agent', hosts: ['opencode'] },
      }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'evil.md'), '# evil\n');

    const r = runCli(['install', '../../evil', '--host', 'opencode', '--scope', 'project']);

    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/path escape refused|PathEscapeError|escapes/i);
    // The workspace-parent (two levels up from .opencode/agents) must NOT
    // have gained an evil.md — the escape must never have been written.
    expect(fs.existsSync(path.join(workspace, '..', '..', 'evil.md'))).toBe(false);
    expect(fs.existsSync(path.join(workspace, '..', 'evil.md'))).toBe(false);
  });

  it('accepts a well-formed extension id for the same install', () => {
    const extDir = path.join(workspace, 'extensions', 'agents', 'good-agent');
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        id: 'good-agent',
        version: '0.1.0',
        type: 'agent',
        title: 'good',
        description: 'good',
        runtime: 'declarative',
        entrypoint: 'good-agent.md',
        install: { type: 'agent', hosts: ['opencode'] },
      }, null, 2),
    );
    fs.writeFileSync(path.join(extDir, 'good-agent.md'), '# good-agent\n');

    const r = runCli(['install', 'good-agent', '--host', 'opencode', '--scope', 'project']);
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(workspace, '.opencode', 'agents', 'good-agent.md'))).toBe(true);
  });
});

describe('Manifest-entrypoint class — soxe serve refuses an escaping entrypoint', () => {
  it('REFUSES to spawn when manifest.entrypoint resolves outside the extension dir', () => {
    const extDir = path.join(workspace, 'extensions', 'mcp-servers', 'evil-serve');
    fs.mkdirSync(extDir, { recursive: true });
    // Plant the "victim" file the escape would otherwise execute.
    const victim = path.join(workspace, 'victim.js');
    fs.writeFileSync(victim, 'require("fs").writeFileSync(require("path").join(__dirname, "PWNED"), "yes");\n');
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        id: 'evil-serve',
        version: '0.1.0',
        type: 'mcp-server',
        title: 'evil-serve',
        description: 'evil-serve',
        runtime: 'code',
        // Escapes extDir (extensions/mcp-servers/evil-serve/) up to workspace/victim.js
        entrypoint: '../../../victim.js',
        install: { type: 'mcp-server', hosts: ['claude'] },
      }, null, 2),
    );

    const r = runCli(['serve', 'evil-serve']);

    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/REFUSED|path escape refused|PathEscapeError/i);
    // The escape must never have executed — no PWNED marker written anywhere.
    expect(fs.existsSync(path.join(workspace, 'PWNED'))).toBe(false);
  });

  it('accepts a manifest whose entrypoint stays inside the extension dir (finds it, then reports missing dist)', () => {
    const extDir = path.join(workspace, 'extensions', 'mcp-servers', 'good-serve');
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        id: 'good-serve',
        version: '0.1.0',
        type: 'mcp-server',
        title: 'good-serve',
        description: 'good-serve',
        runtime: 'code',
        entrypoint: 'dist/index.js',
        install: { type: 'mcp-server', hosts: ['claude'] },
      }, null, 2),
    );
    // No dist/index.js on disk — serve should get PAST containment and fail
    // later with "entrypoint not found" (proves the refusal above is
    // specifically about escape, not a blanket regression breaking serve).
    const r = runCli(['serve', 'good-serve']);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).not.toMatch(/REFUSED|path escape refused|PathEscapeError/i);
    expect(r.stdout + r.stderr).toMatch(/entrypoint not found/i);
  });
});

// Lower-severity sites flagged by the follow-up audit (2026-08-15): read-only
// oracles, not RCE, but the same missing-containment shape.
describe('Manifest-entrypoint class — soxe validate does not read an escaping SIGTERM-check target', () => {
  it('does not leak file existence/content for an escaping entrypoint (no crash, no read)', () => {
    const extDir = path.join(workspace, 'ext-validate');
    fs.mkdirSync(extDir, { recursive: true });
    const victim = path.join(workspace, 'validate-victim.txt');
    fs.writeFileSync(victim, "process.on('SIGTERM', () => {});\n"); // would flip hasSigterm=true if read
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        id: 'validate-escape',
        version: '0.1.0',
        type: 'service',
        title: 'validate-escape',
        description: 'validate-escape',
        runtime: 'node',
        entrypoint: '../validate-victim.txt',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        lifecycle: { background: true },
        install: { type: 'service', hosts: ['claude'], transports: ['stdio'] },
      }, null, 2),
    );

    const r = runCli(['validate', path.join(extDir, 'extension.json')]);

    // Must not crash/throw uncaught — the containment check degrades to
    // "no built entrypoint" for this advisory-only check, not a hard failure.
    expect(r.stderr).not.toMatch(/PathEscapeError|Uncaught|unhandled/i);
    // Since the escaping path is never read, the SIGTERM warning still fires
    // (src/index.ts doesn't exist either, so hasSigterm stays false).
    expect(r.stdout).toMatch(/no SIGTERM handler found/i);
  });
});

describe('Manifest-entrypoint class — soxe build does not trust an escaping "already built" oracle', () => {
  it('does not treat an escaping entrypoint as "already built" (proceeds to real build, which then fails cleanly)', () => {
    const extId = 'build-escape';
    const extDir = path.join(workspace, extId);
    fs.mkdirSync(extDir, { recursive: true });
    const victim = path.join(workspace, 'build-victim.js');
    fs.writeFileSync(victim, 'module.exports = {};\n'); // exists — would short-circuit "nothing to rebuild" if trusted
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        id: extId,
        version: '0.1.0',
        type: 'service',
        title: extId,
        description: extId,
        runtime: 'code',
        entrypoint: '../build-victim.js',
        install: { type: 'service', hosts: ['claude'] },
      }, null, 2),
    );
    // No package.json in extDir — `soxe build` must proceed past the
    // "entrypoint present" short-circuit and fail on the NEXT real check
    // (missing package.json), never on trusting the escaped file's existence.
    const r = runCli(['build', extId]);
    expect(r.stdout).not.toMatch(/entrypoint present, nothing to rebuild/i);
  });
});
