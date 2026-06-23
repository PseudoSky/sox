#!/usr/bin/env node
/**
 * tools/probe-adr0004-placement.mjs — ADR-0004 P3 reality proof.
 *
 * Proves the decoupling the founder needs, end to end, in a child process whose HOME
 * is a throwaway temp dir (so "real ~/.claude" means the temp HOME's .claude, never the
 * developer's actual home):
 *
 *   1. SOX_SANDBOX_ROOT is UNSET → host placement targets the REAL host path.
 *   2. SOX_ECOSYSTEM_HOME is set to a temp data dir → sox DATA lands there.
 *   3. A user-scope skill file-drop lands in $HOME/.claude/skills (the real discovery
 *      path), NOT under SOX_ECOSYSTEM_HOME ([inv:data-root-never-reroutes]).
 *   4. A user-scope mcp-server config-merge lands in $HOME/.claude.json.
 *   5. The per-scope ledger/ownership/data lands under SOX_ECOSYSTEM_HOME.
 *
 * Run directly: `node tools/probe-adr0004-placement.mjs`. Exit 0 = proof holds.
 * This is invoked by the host-runtime e2e (P3) and is also runnable standalone.
 */

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  PASS: ${msg}`);
  else { console.error(`  FAIL: ${msg}`); failed++; }
};

// ─── Throwaway HOME + data root (never touch the real home) ───────────────────
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-p3-home-'));
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-p3-data-'));
const cleanup = () => {
  for (const d of [TMP_HOME, TMP_DATA]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
};
process.on('exit', cleanup);

// CRITICAL: host-registry captures os.homedir() at MODULE LOAD. Override HOME (and the
// macOS USERPROFILE fallback) BEFORE requiring any dist module so homedir() = TMP_HOME.
process.env['HOME'] = TMP_HOME;
process.env['USERPROFILE'] = TMP_HOME;
delete process.env['SOX_SANDBOX_ROOT'];       // (1) placement → real host path
delete process.env['SOX_HOME'];               // retired var must be inert
process.env['SOX_ECOSYSTEM_HOME'] = TMP_DATA; // (2) data → temp data root

// Sanity: the loaded host-registry must see TMP_HOME as home.
const hostRegistry = require(path.join(ROOT, 'libs/host-registry/dist/index.js'));
const claude = hostRegistry.getHost('claude');
const skillUserDir = claude.surfaces['skill'].paths.user;
const mcpUserFile = claude.surfaces['mcp-server'].paths.user;
ok(skillUserDir === path.join(TMP_HOME, '.claude', 'skills'),
  `skill user surface resolves to real ~/.claude/skills (got ${skillUserDir})`);
ok(mcpUserFile === path.join(TMP_HOME, '.claude.json'),
  `mcp user surface resolves to real ~/.claude.json (got ${mcpUserFile})`);
ok(!skillUserDir.startsWith(TMP_DATA),
  'skill placement is NOT under the data root [inv:data-root-never-reroutes]');

// ─── Place a user-scope skill via the real declarativeInstall path ────────────
const { declarativeInstall } = require(path.join(ROOT, 'libs/install-engine/dist/install.js'));
const dataPaths = require(path.join(ROOT, 'libs/install-engine/dist/data-paths.js'));

// Build a tiny skill source dir.
const skillSrc = path.join(TMP_DATA, '_src', 'memory-usage');
fs.mkdirSync(skillSrc, { recursive: true });
fs.writeFileSync(path.join(skillSrc, 'SKILL.md'), '# memory-usage\nprobe skill\n');

// scopeRoot = the DATA dir for user scope (ADR-0004 §D2).
const userDataDir = dataPaths.dataRoot('user');
ok(userDataDir === path.join(TMP_DATA), `user data dir = $SOX_ECOSYSTEM_HOME (got ${userDataDir})`);

const results = await declarativeInstall(
  { ext: 'memory-usage', type: 'skill', hosts: ['claude'], srcPath: skillSrc },
  'user',
  TMP_HOME,       // workspaceRoot (relative base; unused for user absolute paths)
  userDataDir,    // scopeRoot = data dir
  { isProject: false },
);
const placed = results.find((r) => r.host === 'claude' && r.scope === 'user');
ok(placed != null, 'declarativeInstall placed the user skill');
if (placed) {
  const target = placed.target;
  ok(target.startsWith(path.join(TMP_HOME, '.claude', 'skills')),
    `(3) skill landed in REAL ~/.claude/skills (got ${target})`);
  ok(fs.existsSync(path.join(target, 'SKILL.md')), 'skill SKILL.md exists at the real path');
  ok(!target.startsWith(TMP_DATA), 'skill did NOT land under the data root');
}

// ─── The ledger (data) landed under the data root, not the host path ──────────
const ledgerPath = dataPaths.ledgerPathFor('user');
ok(ledgerPath === path.join(TMP_DATA, 'ledger.json'),
  `(5) ledger path is under $SOX_ECOSYSTEM_HOME (got ${ledgerPath})`);
ok(fs.existsSync(ledgerPath), 'ledger file written under the data root');
ok(!fs.existsSync(path.join(TMP_HOME, '.claude', 'ledger.json')),
  'no ledger leaked into the host ~/.claude');

// ─── Place a user-scope mcp-server (config-merge → real ~/.claude.json) ───────
const mcpResults = await declarativeInstall(
  {
    ext: 'memory-server',
    type: 'mcp-server',
    hosts: ['claude'],
    profile: 'stdio',
  },
  'user',
  TMP_HOME,
  userDataDir,
  { isProject: false },
);
const mcpPlaced = mcpResults.find((r) => r.capability === 'config-merge');
ok(mcpPlaced != null, 'declarativeInstall merged the user mcp-server config');
if (mcpPlaced) {
  ok(mcpPlaced.target === path.join(TMP_HOME, '.claude.json'),
    `(4) mcp config merged into REAL ~/.claude.json (got ${mcpPlaced.target})`);
  const cfg = JSON.parse(fs.readFileSync(path.join(TMP_HOME, '.claude.json'), 'utf8'));
  ok(cfg.mcpServers && cfg.mcpServers['memory-server'] != null,
    'mcpServers.memory-server present in the real ~/.claude.json');
}

console.log(failed === 0
  ? '\nADR-0004 P3 placement proof: ALL PASS'
  : `\nADR-0004 P3 placement proof: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
