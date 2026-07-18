#!/usr/bin/env node
/**
 * tools/probe-mcp-trust-sync.mjs — reality gate for the mcp-trust auto-management fix.
 *
 * Proves: an `mcp-server` install for the `claude` host appends the extId to
 * `enabledMcpjsonServers` for the relevant project root(s) in `~/.claude.json`
 * — user-scope installs targeting every known project (mirroring #16728's own
 * .mcp.json propagation), project-scope installs targeting only the project
 * being installed into — a human's OWN manually-approved trust entry for a
 * DIFFERENT extension survives untouched, and uninstall reverses EXACTLY what
 * sox granted, byte-clean.
 *
 * Runs in this process with HOME = throwaway temp, SOX_SANDBOX_ROOT UNSET,
 * SOX_ECOSYSTEM_HOME = temp data root. Two fixture project roots are recorded
 * in the install-registry AND pre-seeded into ~/.claude.json (mimicking
 * projects Claude Code has already opened) — one carrying a pre-existing
 * FOREIGN trust entry that must survive.
 *
 * Exit 0 = the gate holds.
 */

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
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

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-trust-home-'));
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-trust-data-'));
const TMP_PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-trust-proj-'));
const TMP_PROJ2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-trust-proj2-'));
const TMP_PROJ3 = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-trust-proj3-'));
process.on('exit', () => {
  for (const d of [TMP_HOME, TMP_DATA, TMP_PROJ, TMP_PROJ2, TMP_PROJ3]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

process.env['HOME'] = TMP_HOME;
process.env['USERPROFILE'] = TMP_HOME;
delete process.env['SOX_SANDBOX_ROOT'];
delete process.env['SOX_HOME'];
process.env['SOX_ECOSYSTEM_HOME'] = TMP_DATA;
process.env['SOX_ALLOW_TMP_PROJECT_ROOTS'] = '1'; // BL-49: fixture roots are under os.tmpdir()

const engine = require(path.join(ROOT, 'libs/install-engine/dist/index.js'));
const {
  syncMcpTrustToProjects,
  reverseMcpTrustFromProjects,
  upsertInstallRecord,
  OwnershipIndex,
  ownershipPathFor,
} = engine;

const claudeJson = path.join(TMP_HOME, '.claude.json');

// ─── Fixture: three project roots Claude Code has already opened ─────────────
//   - TMP_PROJ : enabledMcpjsonServers already has a FOREIGN entry (must survive)
//   - TMP_PROJ2: enabledMcpjsonServers is []
//   - TMP_PROJ3: NOT recorded in ~/.claude.json at all (Claude never opened it) —
//     must be skipped, not have a stanza invented for it.
fs.writeFileSync(claudeJson, JSON.stringify({
  projects: {
    [TMP_PROJ]: { enabledMcpjsonServers: ['some-other-server'] },
    [TMP_PROJ2]: { enabledMcpjsonServers: [] },
  },
}, null, 2) + '\n');
const proj1SnapshotBefore = JSON.parse(fs.readFileSync(claudeJson, 'utf8')).projects[TMP_PROJ];

// Record all three as known project roots (sox "knows about" them via install-registry).
upsertInstallRecord({ extId: 'some-proj-ext', version: '0.0.0', scope: 'project', root: TMP_PROJ, source: 'file://x' });
upsertInstallRecord({ extId: 'some-proj-ext', version: '0.0.0', scope: 'project', root: TMP_PROJ2, source: 'file://x' });
upsertInstallRecord({ extId: 'some-proj-ext', version: '0.0.0', scope: 'project', root: TMP_PROJ3, source: 'file://x' });

// ─── SYNC (what a user/org-scope install's hook calls): all known roots ──────
const syncResults = await syncMcpTrustToProjects({ extId: 'memory-server', host: 'claude' });
ok(syncResults.length === 3, `SYNC: targeted all 3 known project roots (got ${syncResults.length})`);

{
  const cfg = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
  const p1 = cfg.projects[TMP_PROJ].enabledMcpjsonServers;
  ok(p1.includes('memory-server'), 'TRUST: project1 now trusts memory-server');
  ok(p1.includes('some-other-server'), 'TRUST: project1 foreign trust entry preserved');
  ok(p1.length === 2, `TRUST: project1 has exactly 2 entries (got ${p1.length})`);

  const p2 = cfg.projects[TMP_PROJ2].enabledMcpjsonServers;
  ok(p2.includes('memory-server') && p2.length === 1, 'TRUST: project2 now trusts memory-server (was empty)');

  ok(cfg.projects[TMP_PROJ3] === undefined,
    'SKIP: project3 (never opened by Claude) got NO invented stanza');
}

// ─── SCOPE-TARGETED SYNC: a project-scope install trusts ONLY that project ───
// A DIFFERENT extId, so this cannot disturb memory-server's own trust grants
// recorded just above (which the later IDEMPOTENCY/REVERSE assertions depend on).
{
  const scoped = await syncMcpTrustToProjects({ extId: 'other-server', host: 'claude', roots: [TMP_PROJ2] });
  ok(scoped.length === 1 && scoped[0].projectRoot === TMP_PROJ2,
    'SCOPED: project-scope sync targets exactly the given root, not every known root');

  const after = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
  ok(after.projects[TMP_PROJ].enabledMcpjsonServers.includes('other-server') === false,
    'SCOPED: project1 untouched by a scoped sync for project2');

  // Clean up this sub-probe's own ownership record so it doesn't interfere below.
  await reverseMcpTrustFromProjects({ extId: 'other-server', host: 'claude' });
}

// Ownership index records the trust grants keyed per (extId='memory-server', user-scope).
{
  const idx = OwnershipIndex.loadFromFile(ownershipPathFor('user'));
  const rec = idx.get('memory-server', 'user');
  ok(rec != null, 'OWNERSHIP: user-scope record exists for memory-server');
  const trustEntries = (rec?.entries ?? []).filter((e) => e.kind === 'config-key' && e.keyPath.startsWith('trust:'));
  ok(trustEntries.length === 2, `OWNERSHIP: both granted trust entries recorded (got ${trustEntries.length})`);
}

// ─── IDEMPOTENCY: a second sync changes nothing ───────────────────────────────
{
  const again = await syncMcpTrustToProjects({ extId: 'memory-server', host: 'claude' });
  const relevant = again.filter((r) => r.projectRoot === TMP_PROJ || r.projectRoot === TMP_PROJ2);
  ok(relevant.every((r) => r.action === 'up-to-date'), 'IDEMPOTENT: re-sync reports up-to-date');
}

// ─── UNINSTALL reversal ────────────────────────────────────────────────────────
const reversed = await reverseMcpTrustFromProjects({ extId: 'memory-server', host: 'claude' });
ok(reversed.length === 2, `REVERSE: reversed trust in both projects (got ${reversed.length})`);

{
  const cfg = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
  const p1 = cfg.projects[TMP_PROJ].enabledMcpjsonServers;
  ok(!p1.includes('memory-server'), 'RESIDUE: memory-server trust removed from project1');
  ok(p1.includes('some-other-server'), 'RESIDUE: project1 foreign trust entry still preserved');

  const AFTER_P1 = JSON.stringify(cfg.projects[TMP_PROJ]);
  const BEFORE_P1 = JSON.stringify(proj1SnapshotBefore);
  ok(AFTER_P1 === BEFORE_P1, 'BYTE-CLEAN: project1 trust array identical to pre-install snapshot');
  if (AFTER_P1 !== BEFORE_P1) {
    console.error(`  --- before ---\n${BEFORE_P1}\n  --- after ---\n${AFTER_P1}`);
  }

  const p2 = cfg.projects[TMP_PROJ2].enabledMcpjsonServers;
  ok(!p2.includes('memory-server'), 'RESIDUE: memory-server trust removed from project2');
}

// Ownership trust entries are gone.
{
  const idx = OwnershipIndex.loadFromFile(ownershipPathFor('user'));
  const rec = idx.get('memory-server', 'user');
  const trustEntries = (rec?.entries ?? []).filter((e) => e.kind === 'config-key' && e.keyPath.startsWith('trust:'));
  ok(trustEntries.length === 0, 'OWNERSHIP: trust entries removed after reversal');
}

console.log(failed === 0
  ? '\nmcp-trust auto-management gate: ALL PASS'
  : `\nmcp-trust auto-management gate: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
