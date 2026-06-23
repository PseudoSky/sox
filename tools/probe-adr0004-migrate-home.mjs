#!/usr/bin/env node
/**
 * tools/probe-adr0004-migrate-home.mjs — ADR-0004 §D8 migrate-home fixture proof.
 *
 * Builds an OLD-layout fixture (legacy data root + a sandboxed .claude tree), runs the
 * real `sox migrate-home` CLI against it, and asserts:
 *   - install-registry.json, supervisors.json, ext/ stores land in the NEW data root;
 *   - user-scope skills + ~/.claude.json MCP entries are RE-PLACED into the real ~/.claude;
 *   - a second run is a no-op (idempotent).
 *
 * Runs the CLI in a child with HOME = a throwaway temp dir. Exit 0 = proof holds.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOX_BIN = path.join(ROOT, 'bin', 'soxe');
const NODE = process.execPath;

let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  PASS: ${msg}`);
  else { console.error(`  FAIL: ${msg}`); failed++; }
};

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-mig-home-'));
process.on('exit', () => { try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ } });

// ─── Build the OLD-layout fixture under TMP_HOME ──────────────────────────────
// Legacy data root: TMP_HOME/.sox (install-registry, supervisors, one ext/ store).
const oldHome = path.join(TMP_HOME, '.sox');
fs.mkdirSync(path.join(oldHome, 'ext', 'memory-daemon'), { recursive: true });
fs.writeFileSync(path.join(oldHome, 'install-registry.json'),
  JSON.stringify({ version: 1, installs: [{ extId: 'memory-daemon', scope: 'user', root: TMP_HOME }] }, null, 2));
fs.writeFileSync(path.join(oldHome, 'supervisors.json'), JSON.stringify({ version: 1, supervisors: [] }, null, 2));
fs.writeFileSync(path.join(oldHome, 'ext', 'memory-daemon', 'index.js'), '// old store\n');

// Sandboxed host tree (a prior SOX_HOME=oldHome rerouted placements under here):
const sbxSkill = path.join(oldHome, '.claude', 'skills', 'memory-usage');
fs.mkdirSync(sbxSkill, { recursive: true });
fs.writeFileSync(path.join(sbxSkill, 'SKILL.md'), '# memory-usage (sandboxed copy)\n');
fs.writeFileSync(path.join(oldHome, '.claude.json'),
  JSON.stringify({ mcpServers: { 'memory-server': { type: 'stdio', command: 'soxe', args: ['serve', 'memory-server'] } } }, null, 2));

// A FOREIGN entry already in the real ~/.claude.json — must be preserved.
const realMcp = path.join(TMP_HOME, '.claude.json');
fs.writeFileSync(realMcp, JSON.stringify({ mcpServers: { 'foreign': { type: 'stdio', command: 'x' } } }, null, 2) + '\n');

const newHome = path.join(TMP_HOME, '.adhd', 'sox-ecosystem');

const runMigrate = (extraEnv = {}) => spawnSync(NODE, [
  SOX_BIN, 'migrate-home',
  `--old-home=${oldHome}`,
  `--old-sandbox=${oldHome}`,
  `--new-home=${newHome}`,
], {
  cwd: ROOT, encoding: 'utf8',
  env: { ...process.env, HOME: TMP_HOME, USERPROFILE: TMP_HOME, SOX_HOME: '', SOX_SANDBOX_ROOT: '', SOX_ECOSYSTEM_HOME: '', ...extraEnv },
});

// ─── Run 1 ────────────────────────────────────────────────────────────────────
const r1 = runMigrate();
process.stdout.write(r1.stdout || '');
if (r1.stderr) process.stderr.write(r1.stderr);
ok(r1.status === 0, 'migrate-home exits 0');

// Data relocated to the new root.
ok(fs.existsSync(path.join(newHome, 'install-registry.json')), 'install-registry.json moved to new data root');
ok(fs.existsSync(path.join(newHome, 'supervisors.json')), 'supervisors.json moved to new data root');
ok(fs.existsSync(path.join(newHome, 'ext', 'memory-daemon', 'index.js')), 'ext/ store moved to new data root');
ok(!fs.existsSync(path.join(oldHome, 'install-registry.json')), 'old install-registry.json removed (moved, not copied)');

// Skills re-placed into the REAL ~/.claude (not the sandbox).
const realSkill = path.join(TMP_HOME, '.claude', 'skills', 'memory-usage', 'SKILL.md');
ok(fs.existsSync(realSkill), 're-placed skill landed in REAL ~/.claude/skills');

// MCP merged into the real ~/.claude.json, foreign entry preserved.
{
  const cfg = JSON.parse(fs.readFileSync(realMcp, 'utf8'));
  ok(cfg.mcpServers['memory-server'] != null, 'MCP entry re-placed into real ~/.claude.json');
  ok(cfg.mcpServers['foreign'] != null, 'foreign MCP entry preserved during re-placement');
}

// ─── Run 2 (idempotency) ───────────────────────────────────────────────────────
const r2 = runMigrate();
process.stdout.write(r2.stdout || '');
ok(r2.status === 0, 'second migrate-home exits 0 (idempotent)');
ok(/0 moved/.test(r2.stdout) || /already-present/.test(r2.stdout),
  'second run moved nothing (idempotent no-op)');
// Real skill + data still present, unchanged.
ok(fs.existsSync(realSkill), 'skill still present after idempotent re-run');
ok(fs.existsSync(path.join(newHome, 'install-registry.json')), 'data still present after idempotent re-run');

console.log(failed === 0
  ? '\nADR-0004 §D8 migrate-home proof: ALL PASS'
  : `\nADR-0004 §D8 migrate-home proof: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
