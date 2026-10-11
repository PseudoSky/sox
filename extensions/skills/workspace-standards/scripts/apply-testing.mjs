#!/usr/bin/env node
// 39a21823 T48.AC1 T48.AC2 T48.AC3 T48.AC4 T48.AC5 T48.AC6 T48.AC7 T48.AC8
// `apply testing`: writes the testing-specific repository side. Reads the testing declaration and the
// templates, then moves only (a) the `workspace-standards:testing` block in AGENTS.md, (b) the
// IMPLEMENTATION skeleton (created once, hand-maintained region never touched), and (c) a ledger of
// the backlog items filed for mechanisms it cannot write. Routing and gates output is written only
// when the declaration owns it. The managed-block mechanics live in marker-engine.mjs.
//
// usage: apply-testing.mjs [--root <repo>] [--declaration <file>] [--dry-run] [--check] [--force]
//                          [--no-file] [--backlog-project <name>]
// exit:  0 applied/clean, 3 drift reported (a managed block differs from its rendering, no --force),
//        4 a backlog item could not be filed, 64 usage, 65 unreadable input or malformed markers
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { upsertBlock, inspectBlock, unifiedDiff, MarkerError, renderBlock } from './marker-engine.mjs';
import { parseRoles, trace, ownership, ledgerRows, commandedGateIds } from './lib.mjs';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXIT = { OK: 0, DRIFT: 3, FILING: 4, USAGE: 64, INPUT: 65 };
const PLACEHOLDER = /^<.*>$/;
const rd = (p) => fs.readFileSync(p, 'utf8');
const readIfExists = (p) => (fs.existsSync(p) ? rd(p) : null);

// 595965cc T49.AC4: `ownership` lives in lib.mjs so apply testing and apply routing/gates read one rule.
export { ownership };
const gateList = (decl) => (Array.isArray(decl.gates) ? decl.gates : Array.isArray(decl.gateList) ? decl.gateList : []);
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');

/** Inner body (between the markers) of the agents-block template, with placeholders filled. */
export function renderTestingBody(template, decl) {
  const at = inspectBlock(template, 'testing');
  if (!at.found) throw new MarkerError('E_TEMPLATE', 'templates/agents-block.md has no workspace-standards:testing markers');
  const capability = table(['capability', 'tool', 'usage'], [['test-routing', 'workspace-standards', '`/workspace-standards run testing` returns the class, rigor, and playbook of a change']]);
  const classes = table(
    ['class', 'default rigor', 'author card'],
    (decl.workClasses ?? []).map((c) => [c.id, c.defaultRigor, c.card ? path.basename(c.card, '.md') : 'none']),
  );
  return at.body.replace('{{CAPABILITY_ROW}}', capability).replace('{{CLASS_TABLE}}', classes);
}

const renderRoutingBody = (rolesText) =>
  `## Testing routing\n${table(['role', 'tools', 'preferred agents'], parseRoles(rolesText).roles.map((r) => [r.name, r.tools.join(', '), r.hints.join(', ') || 'none']))}`;
const renderGatesBody = (decl) =>
  `## Testing gates\n${table(['gate', 'mechanism', 'stage', 'threshold'], gateList(decl).map((g) => [g.id, g.mechanism, [].concat(g.stage).join(', '), g.threshold]))}`;

/** Gate ids whose binding-table row names a real mechanism (not a `<placeholder>`). */
export function boundGates(skeletonText) {
  const bound = new Set();
  const from = skeletonText.indexOf('workspace-standards:testing:hand-maintained:begin');
  if (from === -1) return bound;
  const to = skeletonText.indexOf('workspace-standards:testing:hand-maintained:end', from);
  for (const line of skeletonText.slice(from, to === -1 ? undefined : to).split('\n')) {
    const m = /^\|\s*(G\d+)\s*\|\s*([^|]*?)\s*\|/.exec(line);
    if (m && m[2] !== '' && !PLACEHOLDER.test(m[2])) bound.add(m[1]);
  }
  return bound;
}

const LEDGER_TARGET = 'testing-mechanisms';
function readLedger(text) {
  const at = inspectBlock(text, LEDGER_TARGET);
  const rows = new Map();
  if (!at.found) return rows;
  for (const line of at.body.split('\n')) {
    const m = /^\|\s*(G\d+)\s*\|[^|]*\|\s*(\S+)\s*\|\s*$/.exec(line);
    if (m) rows.set(m[1], m[2]);
  }
  return rows;
}
const renderLedger = (gates, rows) =>
  `## Mechanisms filed by apply\n${table(['gate', 'mechanism needed', 'backlog item'], [...rows].map(([id, uid]) => [id, `checker for: ${gates.find((g) => g.id === id)?.threshold ?? id}`, uid]))}`;

/** Default filer: `adhd-backlog backlog create`. Returns the new item uid; throws on any failure. */
export function backlogFiler({ project, run = (args) => execFileSync('adhd-backlog', args, { encoding: 'utf8' }) }) {
  return (item) => {
    const out = run(['backlog', 'create', '--input', JSON.stringify({ title: item.title, body: item.body, project, by: 'workspace-standards-apply' })]);
    for (const line of out.split('\n').reverse()) {
      try {
        const j = JSON.parse(line);
        if (j.ok === true && j.data?.uid) return j.data.uid;
        if (j.ok === false) throw new Error(`backlog create refused: ${JSON.stringify(j.error ?? j)}`);
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
      }
    }
    throw new Error(`backlog create returned no uid: ${out.slice(0, 200)}`);
  };
}

/**
 * Run apply testing against `root`. Pure of the process: `filer(item) -> uid` is injected.
 * dryRun and check write nothing and file nothing; they differ only in intent (check = `review testing`).
 */
export function applyTesting({ root, skillRoot = SKILL_ROOT, declarationPath, dryRun = false, check = false, force = false, noFile = false, filer = null }) {
  const readOnly = dryRun || check;
  const registry = JSON.parse(rd(path.join(skillRoot, 'registry.json')));
  const std = registry.standards.find((s) => s.id === 'testing');
  const decl = JSON.parse(rd(declarationPath ?? path.join(skillRoot, std.declaration)));
  const own = ownership(decl);
  const template = rd(path.join(skillRoot, std.applyTemplate));
  const skeletonTpl = rd(path.join(skillRoot, path.dirname(std.applyTemplate), 'implementation-skeleton.md'));
  const result = { blocks: [], skipped: [], created: [], filed: [], wouldFile: [], failed: [], drift: [], warnings: [], diff: '', wrote: [] };
  const files = new Map(); // abs path -> { before, after }
  const stage = (rel, mutate) => {
    const abs = path.join(root, rel);
    const entry = files.get(abs) ?? { rel, before: readIfExists(abs) };
    entry.after = mutate(entry.after ?? entry.before ?? '');
    files.set(abs, entry);
  };
  const block = (rel, target, body) => stage(rel, (text) => {
    const r = upsertBlock(text, target, body, { force });
    result.blocks.push({ file: rel, target, action: r.action });
    if (r.action === 'drift') result.drift.push({ file: rel, target, diff: unifiedDiff(`${rel}#${target}`, r.current, r.rendered) });
    return r.text;
  });

  block('AGENTS.md', 'testing', renderTestingBody(template, decl));
  if (own.routing) {
    block('AGENTS.md', 'testing-routing', renderRoutingBody(rd(path.join(skillRoot, std.roles))));
    const rolesRel = 'docs/standards/testing-roles.md';
    const want = rd(path.join(skillRoot, std.roles));
    stage(rolesRel, (text) => {
      if (text === '' || text === want || force) { result.blocks.push({ file: rolesRel, target: 'roles', action: text === want ? 'unchanged' : text === '' ? 'created' : 'replaced' }); return want; }
      result.blocks.push({ file: rolesRel, target: 'roles', action: 'drift' });
      result.drift.push({ file: rolesRel, target: 'roles', diff: unifiedDiff(rolesRel, text, want) });
      return text;
    });
  } else result.skipped.push('routing: owned by apply routing (declaration does not say routing: own)');
  if (own.gates) block('AGENTS.md', 'testing-gates', renderGatesBody(decl));
  else result.skipped.push('gates: owned by apply gates (declaration does not say gates: own)');

  // IMPLEMENTATION skeleton: created once; an existing file is never rewritten except for the ledger block.
  const bindingRel = std.binding;
  const bindingAbs = path.join(root, bindingRel);
  const existing = readIfExists(bindingAbs);
  if (existing === null) {
    const policy = decl.policy ?? std.policy?.document ?? '<policy path>';
    stage(bindingRel, () => skeletonTpl.replace('<repository>', path.basename(path.resolve(root))).replace('<policy path>', policy));
    result.created.push(bindingRel);
  }
  const skeletonText = files.get(bindingAbs)?.after ?? existing;
  const gates = gateList(decl).filter((g) => g.mechanism === 'mechanical');
  const bound = boundGates(skeletonText);
  const ledger = readLedger(skeletonText);
  // 595965cc T49.AC6: a gate the foundation gates ledger already filed (apply gates ran first) is not filed twice.
  const gateSet = std.gateSet ?? `${std.id}-gates`;
  const filedByGates = ledgerRows(readIfExists(path.join(root, 'AGENTS.md')) ?? '', 'foundations-filed');
  const commanded = commandedGateIds(root);
  const todo = gates.filter((g) => !bound.has(g.id) && !ledger.has(g.id) && !commanded.has(g.id) && !filedByGates.has(`${gateSet}/${g.id}`));
  if (readOnly || noFile) result.wouldFile = todo.map((g) => g.id);
  else if (todo.length > 0) {
    if (!filer) throw new Error('applyTesting: a filer is required to file mechanism items (pass noFile to skip)');
    for (const g of todo) {
      try {
        const uid = filer({
          gate: g.id,
          title: `workspace-standards testing: build the ${g.id} mechanism`,
          body: `Gate ${g.id} is mechanical and has no binding in ${bindingRel}. Threshold: ${g.threshold}. Stages: ${[].concat(g.stage).join(', ')}.\n\nFiled by apply testing instead of editing code.\n\nCitations: [workspace-standards apply testing, scripts/apply-testing.mjs, ${declarationPath ?? std.declaration}]`,
        });
        ledger.set(g.id, uid);
        result.filed.push({ gate: g.id, uid });
      } catch (err) {
        trace('apply-testing:file', err);
        result.failed.push({ gate: g.id, error: err.message });
      }
    }
  }
  if (ledger.size > 0) stage(bindingRel, (text) => upsertBlock(text, LEDGER_TARGET, renderLedger(gates, ledger), { force: true }).text);

  const policyPath = decl.policy ?? std.policy?.document;
  if (policyPath && !fs.existsSync(path.join(root, policyPath))) result.warnings.push(`policy document ${policyPath} not found in the repository`);

  for (const [abs, e] of files) {
    if (e.after === e.before) continue;
    result.diff += unifiedDiff(e.rel, e.before ?? '', e.after);
    if (!readOnly) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, e.after);
      result.wrote.push(e.rel);
    }
  }
  result.exit = result.drift.length > 0 ? EXIT.DRIFT : result.failed.length > 0 ? EXIT.FILING : EXIT.OK;
  return result;
}

function main(argv) {
  const flags = { value: ['--root', '--declaration', '--backlog-project'], bool: ['--dry-run', '--check', '--force', '--no-file'] };
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags.value.includes(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) { process.stderr.write(`${a} requires a value\n`); return EXIT.USAGE; }
      opt[a] = v;
    } else if (flags.bool.includes(a)) opt[a] = true;
    else { process.stderr.write(`unknown argument ${a}\nusage: apply-testing.mjs [--root <repo>] [--declaration <file>] [--dry-run] [--check] [--force] [--no-file] [--backlog-project <name>]\n`); return EXIT.USAGE; }
  }
  const root = path.resolve(opt['--root'] ?? process.cwd());
  let r;
  try {
    r = applyTesting({
      root, declarationPath: opt['--declaration'], dryRun: !!opt['--dry-run'], check: !!opt['--check'], force: !!opt['--force'], noFile: !!opt['--no-file'],
      filer: backlogFiler({ project: opt['--backlog-project'] ?? path.basename(root) }),
    });
  } catch (err) {
    trace('apply-testing', err);
    process.stderr.write(`${err.message}\n`);
    return err instanceof MarkerError || err.code === 'ENOENT' || err.code === 'E_INPUT' || err instanceof SyntaxError ? EXIT.INPUT : 1;
  }
  if (r.diff) process.stdout.write(r.diff);
  process.stdout.write(`${JSON.stringify({ ...r, diff: undefined, drift: r.drift.map(({ file, target }) => ({ file, target })) })}\n`);
  for (const d of r.drift) process.stderr.write(`DRIFT ${d.file} [${d.target}]: block differs from its rendering; re-run with --force to overwrite\n${d.diff}`);
  return r.exit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
export { renderBlock };
