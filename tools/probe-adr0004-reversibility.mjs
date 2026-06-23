#!/usr/bin/env node
/**
 * tools/probe-adr0004-reversibility.mjs — ADR-0004 §D6b reversibility gate.
 *
 * Born-conformance-style proof of [inv:reversible-injection]: for an injecting
 * extension, install → assert injected → uninstall → assert ZERO residue, with the
 * host config file byte-IDENTICAL to its pre-install snapshot (proving foreign entries
 * untouched AND sox-owned entries fully removed).
 *
 * Runs entirely in a child process with HOME = a throwaway temp dir, SOX_SANDBOX_ROOT
 * UNSET (so placement hits the temp HOME's real ~/.claude), SOX_ECOSYSTEM_HOME = a temp
 * data root. Uses the in-process declarativeInstall to inject, then drives the ownership
 * index + the same reversal the CLI cmdUninstall performs.
 *
 * Exit 0 = the gate holds (host files byte-clean after uninstall).
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

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-rev-home-'));
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-rev-data-'));
process.on('exit', () => {
  for (const d of [TMP_HOME, TMP_DATA]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

process.env['HOME'] = TMP_HOME;
process.env['USERPROFILE'] = TMP_HOME;
delete process.env['SOX_SANDBOX_ROOT'];     // placement → real host path
delete process.env['SOX_HOME'];             // retired var inert
process.env['SOX_ECOSYSTEM_HOME'] = TMP_DATA;

const { declarativeInstall, OwnershipIndex } = require(path.join(ROOT, 'libs/install-engine/dist/install.js'));
const lifecycle = require(path.join(ROOT, 'libs/install-engine/dist/lifecycle.js'));
const dataPaths = require(path.join(ROOT, 'libs/install-engine/dist/data-paths.js'));
const ownershipMod = require(path.join(ROOT, 'libs/install-engine/dist/ownership.js'));

const userDataDir = dataPaths.dataRoot('user');
const claudeJson = path.join(TMP_HOME, '.claude.json');

// ─── Pre-existing FOREIGN content in ~/.claude.json (must survive untouched) ──
const foreign = {
  mcpServers: { 'someones-other-server': { type: 'stdio', command: 'foo' } },
  someUserSetting: { keep: true },
};
fs.mkdirSync(path.dirname(claudeJson), { recursive: true });
fs.writeFileSync(claudeJson, JSON.stringify(foreign, null, 2) + '\n');
const SNAPSHOT = fs.readFileSync(claudeJson, 'utf8');

// ─── INSTALL: a skill (file-drop) + an mcp-server (config-merge) ──────────────
const skillSrc = path.join(TMP_DATA, '_src', 'memory-usage');
fs.mkdirSync(skillSrc, { recursive: true });
fs.writeFileSync(path.join(skillSrc, 'SKILL.md'), '# memory-usage\n');

await declarativeInstall(
  { ext: 'memory-usage', type: 'skill', hosts: ['claude'], srcPath: skillSrc, bundleId: 'sox-memory-bundle' },
  'user', TMP_HOME, userDataDir, { isProject: false },
);
await declarativeInstall(
  { ext: 'memory-server', type: 'mcp-server', hosts: ['claude'], profile: 'stdio', bundleId: 'sox-memory-bundle' },
  'user', TMP_HOME, userDataDir, { isProject: false },
);

const skillDir = path.join(TMP_HOME, '.claude', 'skills', 'memory-usage');

// ─── ASSERT INJECTED ──────────────────────────────────────────────────────────
ok(fs.existsSync(path.join(skillDir, 'SKILL.md')), 'INJECTED: skill placed in real ~/.claude/skills');
{
  const cfg = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
  ok(cfg.mcpServers && cfg.mcpServers['memory-server'] != null,
    'INJECTED: mcpServers.memory-server present in ~/.claude.json');
  ok(cfg.mcpServers['someones-other-server'] != null,
    'INJECTED: foreign mcp entry still present (merge preserved it)');
}
// Ownership index records BOTH injections.
const idxAfterInstall = ownershipMod.OwnershipIndex.loadFromFile(path.join(userDataDir, 'ownership.json'));
ok(idxAfterInstall.get('memory-usage', 'user') != null, 'INJECTED: ownership records the skill');
ok(idxAfterInstall.get('memory-server', 'user') != null, 'INJECTED: ownership records the mcp-server');

// ─── UNINSTALL via the ownership index (mirrors cmdUninstall) ─────────────────
async function uninstallViaOwnership(extId) {
  const idx = ownershipMod.OwnershipIndex.loadFromFile(path.join(userDataDir, 'ownership.json'));
  const rec = idx.get(extId, 'user');
  if (!rec) return;
  // 1. Reverse config merges via the ledger (preserves foreign keys).
  await lifecycle.uninstall({ ext: extId, host: rec.host ?? 'claude', scope: 'user', scopeRoot: userDataDir, isProject: false });
  // 2. Remove file-drops + materialized stores.
  for (const e of rec.entries) {
    if (e.kind === 'file-drop' || e.kind === 'materialize') {
      if (fs.existsSync(e.path)) fs.rmSync(e.path, { recursive: true, force: true });
    }
  }
  idx.remove(extId, 'user');
  idx.save();
}

await uninstallViaOwnership('memory-server');
await uninstallViaOwnership('memory-usage');

// ─── ASSERT ZERO RESIDUE ───────────────────────────────────────────────────────
ok(!fs.existsSync(skillDir), 'RESIDUE: skill dir removed from ~/.claude/skills');
{
  const cfg = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
  ok(cfg.mcpServers && cfg.mcpServers['memory-server'] == null,
    'RESIDUE: sox-owned mcpServers.memory-server removed');
  ok(cfg.mcpServers && cfg.mcpServers['someones-other-server'] != null,
    'RESIDUE: foreign mcp entry preserved');
}
const idxAfterUninstall = ownershipMod.OwnershipIndex.loadFromFile(path.join(userDataDir, 'ownership.json'));
ok(idxAfterUninstall.get('memory-server', 'user') == null, 'RESIDUE: ownership entry for mcp gone');
ok(idxAfterUninstall.get('memory-usage', 'user') == null, 'RESIDUE: ownership entry for skill gone');

// ─── THE byte-clean assertion: host config identical to pre-install snapshot ──
const AFTER = fs.readFileSync(claudeJson, 'utf8');
ok(AFTER === SNAPSHOT,
  'BYTE-CLEAN: ~/.claude.json is byte-identical to the pre-install snapshot');
if (AFTER !== SNAPSHOT) {
  console.error('  --- snapshot ---\n' + SNAPSHOT + '\n  --- after ---\n' + AFTER);
}

console.log(failed === 0
  ? '\nADR-0004 §D6b reversibility gate: ALL PASS'
  : `\nADR-0004 §D6b reversibility gate: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
