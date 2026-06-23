#!/usr/bin/env node
/**
 * tools/probe-mcp-project-automerge.mjs — Deliverable 1 reality gate (#16728).
 *
 * Proves the durable fix for Claude Code issue #16728: a user/global-scope MCP
 * server install is auto-merged into every KNOWN project's `.mcp.json` (the project
 * roots recorded in the install-registry), foreign servers preserved, and the merge
 * is REVERSED on uninstall — leaving the project `.mcp.json` byte-identical to its
 * pre-install snapshot.
 *
 * Runs in this process with HOME = throwaway temp, SOX_SANDBOX_ROOT UNSET (so the
 * user MCP config resolves to the temp HOME's real ~/.claude.json), SOX_ECOSYSTEM_HOME
 * = temp data root. A fixture project root is recorded in the install-registry; the
 * project carries a pre-existing FOREIGN server that must survive untouched.
 *
 * Exit 0 = the gate holds.
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

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-mcp-home-'));
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-mcp-data-'));
const TMP_PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-mcp-proj-'));
const TMP_PROJ2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-mcp-proj2-'));
process.on('exit', () => {
  for (const d of [TMP_HOME, TMP_DATA, TMP_PROJ, TMP_PROJ2]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

process.env['HOME'] = TMP_HOME;
process.env['USERPROFILE'] = TMP_HOME;
delete process.env['SOX_SANDBOX_ROOT'];
delete process.env['SOX_HOME'];
process.env['SOX_ECOSYSTEM_HOME'] = TMP_DATA;
// BL-49: this probe's fixture project roots are throwaway temp dirs (mkdtempSync under
// os.tmpdir()). knownProjectRoots() skips tmp roots by default (the BL-35 leak guard),
// which would make auto-merge target 0 projects here. Opt in so the fixtures count —
// production never sets this flag, so the BL-35 guard is unaffected outside this probe.
process.env['SOX_ALLOW_TMP_PROJECT_ROOTS'] = '1';

const engine = require(path.join(ROOT, 'libs/install-engine/dist/index.js'));
const {
  declarativeInstall,
  syncUserMcpToProjects,
  reverseUserMcpFromProjects,
  upsertInstallRecord,
  OwnershipIndex,
  ownershipPathFor,
  dataRoot,
} = engine;

const userDataDir = dataRoot('user');
const claudeJson = path.join(TMP_HOME, '.claude.json');

// ─── Two fixture project roots, recorded in the install-registry ─────────────
//   - TMP_PROJ : has a pre-existing .mcp.json with a FOREIGN server (must survive)
//   - TMP_PROJ2: has NO .mcp.json yet (merge must create it)
const projMcp = path.join(TMP_PROJ, '.mcp.json');
const proj2Mcp = path.join(TMP_PROJ2, '.mcp.json');

const foreignProject = {
  mcpServers: { 'project-local-server': { type: 'http', url: 'http://localhost:9/x' } },
  someProjectSetting: { keep: true },
};
fs.writeFileSync(projMcp, JSON.stringify(foreignProject, null, 2) + '\n');
const PROJ_SNAPSHOT = fs.readFileSync(projMcp, 'utf8');

// Record both project roots in the install-registry (sox "knows about" them).
upsertInstallRecord({ extId: 'some-proj-ext', version: '0.0.0', scope: 'project', root: TMP_PROJ, source: 'file://x' });
upsertInstallRecord({ extId: 'some-proj-ext', version: '0.0.0', scope: 'project', root: TMP_PROJ2, source: 'file://x' });
// A user-scope record too — must NOT be treated as a project root.
upsertInstallRecord({ extId: 'memory-server', version: '1.0.0', scope: 'user', root: TMP_HOME, source: 'file://x' });

// ─── INSTALL: register the MCP server at USER scope (→ ~/.claude.json) ─────────
await declarativeInstall(
  { ext: 'memory-server', type: 'mcp-server', hosts: ['claude'], profile: 'stdio', bundleId: 'sox-memory-bundle' },
  'user', TMP_HOME, userDataDir, { isProject: false },
);

ok(fs.existsSync(claudeJson), 'INSTALL: ~/.claude.json created by user-scope MCP install');
const globalEntry = JSON.parse(fs.readFileSync(claudeJson, 'utf8')).mcpServers['memory-server'];
ok(globalEntry != null, 'INSTALL: mcpServers.memory-server present globally in ~/.claude.json');

// ─── AUTO-MERGE: propagate to known projects (what the install hook calls) ────
const syncResults = await syncUserMcpToProjects({ extId: 'memory-server', host: 'claude' });
ok(syncResults.length === 2, `AUTO-MERGE: targeted both known project roots (got ${syncResults.length})`);

// ─── ASSERT injected into BOTH projects, foreign preserved ────────────────────
{
  const p1 = JSON.parse(fs.readFileSync(projMcp, 'utf8'));
  ok(JSON.stringify(p1.mcpServers['memory-server']) === JSON.stringify(globalEntry),
    'MERGE: project1 .mcp.json carries the SAME server entry as the global one');
  ok(p1.mcpServers['project-local-server'] != null,
    'MERGE: project1 foreign server preserved');
  ok(p1.someProjectSetting && p1.someProjectSetting.keep === true,
    'MERGE: project1 foreign top-level setting preserved');

  ok(fs.existsSync(proj2Mcp), 'MERGE: project2 .mcp.json created (had none)');
  const p2 = JSON.parse(fs.readFileSync(proj2Mcp, 'utf8'));
  ok(p2.mcpServers['memory-server'] != null, 'MERGE: project2 carries the server entry');
}

// Ownership index records the project merges keyed per (extId, projectRoot).
{
  const idx = OwnershipIndex.loadFromFile(ownershipPathFor('user'));
  const rec = idx.get('memory-server', 'user');
  ok(rec != null, 'OWNERSHIP: user-scope record exists for memory-server');
  const projEntries = (rec?.entries ?? []).filter(
    (e) => e.kind === 'config-key' && e.file.endsWith('.mcp.json'),
  );
  ok(projEntries.length === 2, `OWNERSHIP: both project .mcp.json merges recorded (got ${projEntries.length})`);
  ok(projEntries.some((e) => e.file === projMcp) && projEntries.some((e) => e.file === proj2Mcp),
    'OWNERSHIP: entries carry the absolute project .mcp.json paths');
}

// ─── IDEMPOTENCY: a second sync changes nothing ───────────────────────────────
{
  const again = await syncUserMcpToProjects({ extId: 'memory-server', host: 'claude' });
  ok(again.every((r) => r.action === 'up-to-date'), 'IDEMPOTENT: re-sync reports up-to-date for all projects');
}

// ─── UNINSTALL reversal across all projects ───────────────────────────────────
const reversed = await reverseUserMcpFromProjects({ extId: 'memory-server', host: 'claude' });
ok(reversed.length === 2, `REVERSE: reversed both project merges (got ${reversed.length})`);

// ─── ASSERT zero residue in projects, foreign preserved ───────────────────────
{
  const p1 = JSON.parse(fs.readFileSync(projMcp, 'utf8'));
  ok(p1.mcpServers['memory-server'] == null, 'RESIDUE: sox entry removed from project1');
  ok(p1.mcpServers['project-local-server'] != null, 'RESIDUE: project1 foreign server preserved');

  const AFTER = fs.readFileSync(projMcp, 'utf8');
  ok(AFTER === PROJ_SNAPSHOT, 'BYTE-CLEAN: project1 .mcp.json byte-identical to pre-install snapshot');
  if (AFTER !== PROJ_SNAPSHOT) {
    console.error('  --- snapshot ---\n' + PROJ_SNAPSHOT + '\n  --- after ---\n' + AFTER);
  }

  // project2 had no .mcp.json; after reversal mcpServers.memory-server is gone.
  const p2 = JSON.parse(fs.readFileSync(proj2Mcp, 'utf8'));
  ok(p2.mcpServers == null || p2.mcpServers['memory-server'] == null,
    'RESIDUE: sox entry removed from project2');
}

// Ownership project-merge entries are gone.
{
  const idx = OwnershipIndex.loadFromFile(ownershipPathFor('user'));
  const rec = idx.get('memory-server', 'user');
  const projEntries = (rec?.entries ?? []).filter(
    (e) => e.kind === 'config-key' && e.file.endsWith('.mcp.json'),
  );
  ok(projEntries.length === 0, 'OWNERSHIP: project-merge entries removed after reversal');
}

// Project ledger provenance: recorded in the canonical .adhd/sox-ecosystem location
// (NOT a stray root ledger.json) and FULLY cleared after reversal.
{
  const strayRootLedger = path.join(TMP_PROJ, 'ledger.json');
  ok(!fs.existsSync(strayRootLedger), 'LEDGER: no stray ledger.json at the project root');
  const projLedger = path.join(TMP_PROJ, '.adhd', 'sox-ecosystem', 'ledger.json');
  if (fs.existsSync(projLedger)) {
    const lf = JSON.parse(fs.readFileSync(projLedger, 'utf8'));
    const hasMem = (lf.entries ?? []).some(
      (en) => en.ext === 'memory-server' && (en.actions ?? []).length > 0,
    );
    ok(!hasMem, 'LEDGER: project ledger entry for memory-server cleared after reversal');
  } else {
    ok(true, 'LEDGER: project ledger absent after reversal (clean)');
  }
}

console.log(failed === 0
  ? '\n#16728 MCP project auto-merge gate: ALL PASS'
  : `\n#16728 MCP project auto-merge gate: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
