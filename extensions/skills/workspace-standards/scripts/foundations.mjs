#!/usr/bin/env node
// 595965cc T49: the foundation targets. `apply routing` and `apply gates` write the composed routing and
// gates blocks in AGENTS.md (markers `workspace-standards:routing` and `workspace-standards:gates`) from
// every active standard's declaration; `review routing|gates` reports drift without writing anything.
// The managed-block mechanics are marker-engine.mjs; the ownership rule, role resolution and ledger
// parsing are lib.mjs; the backlog filer and the testing binding reader are apply-testing.mjs.
// A standard that declares `own` for a foundation is skipped by that foundation and reported as skipped.
//
// usage: foundations.mjs <apply|review> <routing|gates> [--root <repo>] [--dry-run] [--force] [--no-file]
//                        [--backlog-project <name>] [--gate-table <path>]
// exit:  0 applied/clean, 3 drift (a managed block, or the ledger block, differs from its rendering, no --force),
//        4 a backlog item could not be filed, 64 usage, 65 unreadable input or malformed markers
//
// Filing (595965cc T49.AC6): items are filed only when the writes that record them can land. Any drift in this
// run (the target block, roles.md, or the ledger block) means nothing is filed; the items are reported as
// wouldFile and the next clean run files them. All writes that need no uid happen first, the ledger last, so a
// failed write cannot leave filed items without a ledger; a ledger write that fails after filing throws an
// error naming every uid it could not record. The ledger block is never overwritten without --force.
//
// Gate keys: gates are keyed `<gateSet>/<id>` everywhere (ledger, command table rows that name a gateSet).
// A command-table row without a gateSet binds the bare id only while no other standard declares that id.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { upsertBlock, inspectBlock, unifiedDiff, MarkerError } from './marker-engine.mjs';
import { parseRoles, ownership, resolveRole, declaresUnbound, ledgerRows, escapeCell, loadAgents, loadRegistry, trace, commandedGateIds, tableGateStages, stagesFor, DEFAULT_GATE_TABLE, repoOptions, gatesOf, gateKey, sharedGateIds, isCommanded } from './lib.mjs';
import { backlogFiler, boundGates } from './apply-testing.mjs';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXIT = { OK: 0, DRIFT: 3, FILING: 4, USAGE: 64, INPUT: 65 };
export const FOUNDATIONS = ['routing', 'gates'];
export const AGENTS_REL = 'AGENTS.md';
export const ROLES_REL = 'docs/standards/roles.md';
export const GATE_TABLE_REL = 'gates.table.json';
export const ROSTER_GUARD_REL = 'tools/test-roster-guard.mjs';
export const LEDGER_TARGET = 'foundations-filed';
const RUNNER_USAGE = 'node <skill>/engine/cli.mjs run --step <A-H> --class <class> --rigor <rigor> --changed <path> --root <repo>: one report for every gate set bound to the step; a standard adds no runner of its own';
/** Flag for a role held at closeness 0: the holder has the tools but declares no obligation coverage. */
export const BOUND_NO_COVERAGE = 'bound-no-coverage';
const ROLE_USAGE = 'node <skill>/scripts/foundations.mjs review routing: each role resolves to the closest installed agent; drift and unbound roles are reported';
const STAGES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

const rd = (p) => fs.readFileSync(p, 'utf8');
const readIfExists = (p) => (fs.existsSync(p) ? rd(p) : null);
const cell = escapeCell;
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
const inputError = (message) => Object.assign(new Error(message), { code: 'E_INPUT' });

/** The active standards, each with its parsed declaration, ownership, and roles. Planned standards are not composed. */
export function loadStandards({ skillRoot = SKILL_ROOT, registry = loadRegistry(skillRoot) } = {}) {
  return registry.standards.filter((s) => s.status === 'active').map((s) => {
    const decl = JSON.parse(rd(path.join(skillRoot, s.declaration)));
    const rolesText = rd(path.join(skillRoot, s.roles));
    return { id: s.id, gateSet: s.gateSet ?? `${s.id}-gates`, binding: s.binding ?? null, decl, own: ownership(decl), rolesText, roles: parseRoles(rolesText).roles };
  });
}

/** Installed agents of a repository (`extensions/agents`); an absent directory is an empty roster. */
export function rosterFor(root) {
  const dir = path.join(root, 'extensions/agents');
  return fs.existsSync(dir) ? loadAgents(dir) : [];
}

/**
 * A gate has a mechanism when the repository's command table binds it to a command (keyed by the standard's
 * gate set), or the standard's own binding document names it (`bound`, read from the standard's registry
 * `binding` file; every standard is treated alike). `shared` is the set of gate ids declared by more than one set.
 */
export function mechanismFor({ standard, gate, commanded, bound = new Set(), shared = new Set() }) {
  if (gate.mechanism !== 'mechanical') return false;
  if (isCommanded(commanded, standard.gateSet, gate.id, shared)) return true;
  return bound.has(gate.id);
}

/** Routing block and the role holders behind it. Standards that declare routing: own are skipped and reported. */
export function composeRouting({ standards, agents }) {
  const skipped = [];
  const warnings = [];
  const holders = new Map();
  const holderRows = [];
  const taskRows = [];
  const unbound = [];
  const boundNoCoverage = [];
  const active = [];
  for (const s of standards) {
    if (s.own.routing) { skipped.push(`${s.id}: declares routing: own; apply routing skips it`); continue; }
    active.push(s);
    for (const role of s.roles) {
      const r = resolveRole(role, agents);
      holders.set(role.name, r.holder);
      // 595965cc T47 rank0: a closeness-0 binding (holder with no covered obligation) is eligible by tools alone; flag it, never hide it.
      const noCoverage = !!r.holder && r.covered.length === 0;
      holderRows.push([role.name, s.id, r.holder ? `\`${r.holder}\`` : '_unbound_', r.covered.join(', ') || (noCoverage ? `none (${BOUND_NO_COVERAGE})` : 'none')]);
      if (!r.holder) unbound.push(`${s.id}/${role.name}`);
      if (noCoverage) {
        boundNoCoverage.push(`${s.id}/${role.name}`);
        warnings.push(`${BOUND_NO_COVERAGE}: ${s.id}: role ${role.name} is held by ${r.holder}, which declares no roles-covered obligation for it (closeness 0)`);
      }
      if (!r.holder && !declaresUnbound(role)) warnings.push(`${s.id}: role ${role.name} has no eligible holder and does not declare no-holder: unbound`);
    }
  }
  for (const s of active) {
    for (const w of s.decl.workClasses ?? []) {
      if (!w.role) { taskRows.push([w.id, s.id, 'none', '_no role_']); continue; }
      if (!s.roles.some((r) => r.name === w.role)) {
        warnings.push(`${s.id}: work class ${w.id} names role ${w.role}, which roles.md does not define`);
        taskRows.push([w.id, s.id, w.role, '_unknown role_']);
        continue;
      }
      const holder = holders.get(w.role);
      taskRows.push([w.id, s.id, w.role, holder ? `\`${holder}\`` : '_unbound_']);
    }
  }
  const body = [
    '## Routing',
    'This table wins over the dispatcher\'s own default rows: for every task it names, the agent in its agent column takes the work. The dispatcher\'s rows apply only to tasks this table does not name.',
    '',
    '### Task-to-agent routing',
    table(['task', 'standard', 'role', 'agent'], taskRows),
    '',
    '### Role holders',
    table(['role', 'standard', 'holder', 'covered obligations'], holderRows),
    '',
    '### Capabilities',
    table(['capability', 'tool', 'usage'], [['role-routing', 'workspace-standards', `\`${ROLE_USAGE}\``]]),
  ].join('\n');
  return { body, skipped, warnings, unbound, boundNoCoverage };
}

/**
 * roles.md composed from every routed standard's roles.md; null when no standard routes (nothing to compose).
 * A role name defined twice is an input error.
 */
export function composeRoles({ standards }) {
  const seen = new Map();
  const parts = [];
  for (const s of standards) {
    if (s.own.routing) continue;
    for (const r of s.roles) {
      if (seen.has(r.name)) throw inputError(`role ${r.name} is defined by both ${seen.get(r.name)} and ${s.id}`);
      seen.set(r.name, s.id);
    }
    parts.push(`<!-- standard: ${s.id} -->`, s.rolesText.replace(/\n+$/, ''));
  }
  if (parts.length === 0) return null;
  return `<!-- Generated by workspace-standards apply routing from each standard's roles.md. -->\n${parts.join('\n\n')}\n`;
}

/** Gates block: the gate registry, the stage bindings, and the one runner. Standards that declare gates: own are skipped. */
export function composeGates({ standards, bound, tableStages = new Map(), shared = new Set() }) {
  const skipped = [];
  const registry = [];
  const byStage = new Map(STAGES.map((st) => [st, []]));
  for (const s of standards) {
    if (s.own.gates) { skipped.push(`${s.id}: declares gates: own; apply gates skips it`); continue; }
    for (const g of gatesOf(s.decl)) {
      const stages = stagesFor(tableStages, s.gateSet, g, shared);
      const id = gateKey(s.gateSet, g.id);
      registry.push([s.gateSet, g.id, g.mechanism, stages.join(', '), bound(s, g) ? 'command' : 'obligation', g.threshold]);
      for (const st of stages) if (byStage.has(st)) byStage.get(st).push(id);
    }
  }
  const body = [
    '## Gates',
    '### Gate registry',
    table(['gate set', 'gate', 'mechanism', 'stage', 'bound', 'threshold'], registry),
    '',
    '### Stage bindings',
    table(['stage', 'gates'], STAGES.map((st) => [st, byStage.get(st).length ? byStage.get(st).join(', ') : '_none_'])),
    '',
    '### Gate runner',
    table(['capability', 'tool', 'usage'], [['gate-runner', 'workspace-standards', `\`${RUNNER_USAGE}\``]]),
  ].join('\n');
  return { body, skipped };
}

const renderLedger = (rows) => `## Mechanisms filed by apply\n${table(['gate', 'mechanism needed', 'backlog item'], [...rows].map(([key, uid]) => [key, `checker for ${key}`, uid]))}`;

/**
 * Apply or review one foundation target against `root`. The filer is injected; check and dryRun write
 * and file nothing. Returns the same shape as applyTesting: blocks, skipped, filed, failed, drift, diff, wrote, exit.
 */
export function applyFoundation({ target, root, standards = loadStandards(), agents = rosterFor(root), check = false, dryRun = false, force = false, noFile = false, filer = null, gateTable: gateTableArg }) {
  const { gateTable } = repoOptions(root, { gateTable: gateTableArg });
  if (!FOUNDATIONS.includes(target)) throw inputError(`unknown foundation "${target}"; expected routing or gates`);
  const readOnly = dryRun || check;
  const commanded = commandedGateIds(root, gateTable);
  const tableStages = tableGateStages(root, gateTable);
  // Each standard's binding document (registry `binding`) names the gates it already mechanises and the
  // mechanisms it already filed (`<id>-mechanisms` ledger). No standard is special-cased.
  const bindings = new Map(standards.map((s) => {
    const text = s.binding ? readIfExists(path.join(root, s.binding)) ?? '' : '';
    return [s.id, { bound: text ? boundGates(text, s.id) : new Set(), ledger: text ? ledgerRows(text, `${s.id}-mechanisms`) : new Map() }];
  }));
  const shared = sharedGateIds(standards.filter((s) => !s.own.gates));
  const hasMechanism = (s, gate) => mechanismFor({ standard: s, gate, commanded, bound: bindings.get(s.id).bound, shared });
  const result = { target, blocks: [], skipped: [], unbound: [], boundNoCoverage: [], level: 'full', filed: [], failed: [], wouldFile: [], drift: [], warnings: [], diff: '', wrote: [], exit: EXIT.OK };
  const files = new Map();
  const agentsAbs = path.join(root, AGENTS_REL);
  const stage = (abs, rel, mutate) => {
    const entry = files.get(abs) ?? { rel, before: readIfExists(abs) };
    entry.after = mutate(entry.after ?? entry.before ?? '');
    files.set(abs, entry);
  };
  const flush = () => {
    for (const [abs, e] of files) {
      if (e.after === e.before) continue;
      result.diff += unifiedDiff(e.rel, e.before ?? '', e.after);
      if (readOnly) continue;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, e.after);
      result.wrote.push(e.rel);
      e.before = e.after;
    }
  };
  const block = (target2, body) => stage(agentsAbs, AGENTS_REL, (text) => {
    const r = upsertBlock(text, target2, body, { force });
    result.blocks.push({ file: AGENTS_REL, target: target2, action: r.action });
    if (r.action === 'drift') result.drift.push({ file: AGENTS_REL, target: target2, diff: unifiedDiff(`${AGENTS_REL}#${target2}`, r.current, r.rendered) });
    // review: a block that was never applied is drift too, not a clean pass
    if (r.action === 'created' && check) result.drift.push({ file: AGENTS_REL, target: target2, diff: unifiedDiff(`${AGENTS_REL}#${target2}`, '', r.rendered) });
    return r.text;
  });
  const stageWhole = (rel, want) => {
    const abs = path.join(root, rel);
    const before = readIfExists(abs);
    if (before === want) { result.blocks.push({ file: rel, target: 'roles', action: 'unchanged' }); return; }
    if (before !== null && !force) {
      result.blocks.push({ file: rel, target: 'roles', action: 'drift' });
      result.drift.push({ file: rel, target: 'roles', diff: unifiedDiff(rel, before, want) });
      return;
    }
    if (before === null && check) {
      result.blocks.push({ file: rel, target: 'roles', action: 'created' });
      result.drift.push({ file: rel, target: 'roles', diff: unifiedDiff(rel, '', want) });
      return;
    }
    result.blocks.push({ file: rel, target: 'roles', action: before === null ? 'created' : 'replaced' });
    files.set(abs, { rel, before, after: want });
  };
  const agentsText = readIfExists(agentsAbs) ?? '';
  const filed = ledgerRows(agentsText, LEDGER_TARGET);
  const todo = [];

  if (target === 'routing') {
    const r = composeRouting({ standards, agents });
    result.skipped.push(...r.skipped.map((s) => `routing: ${s}`));
    result.warnings.push(...r.warnings);
    result.unbound.push(...r.unbound);
    result.boundNoCoverage.push(...r.boundNoCoverage);
    // D17: a thin roster lowers the reported level instead of failing; unbound and closeness-0 roles both count.
    if (result.unbound.length + result.boundNoCoverage.length > 0) result.level = 'lowered';
    block('routing', r.body);
    const roles = composeRoles({ standards });
    if (roles !== null) stageWhole(ROLES_REL, roles);
    if (!fs.existsSync(path.join(root, ROSTER_GUARD_REL)) && !filed.has('routing/roster-guard')) {
      todo.push({ key: 'routing/roster-guard', title: 'workspace-standards routing: build the roster guard', body: `${ROSTER_GUARD_REL} is absent, so the task-to-agent routing table in ${AGENTS_REL} is not checked against the installed roster. Threshold: every agent name the table routes to resolves to an installed agent.` });
    }
  } else {
    const g = composeGates({ standards, bound: hasMechanism, tableStages, shared });
    result.skipped.push(...g.skipped.map((s) => `gates: ${s}`));
    block('gates', g.body);
    for (const s of standards) {
      if (s.own.gates) continue;
      for (const gate of gatesOf(s.decl)) {
        if (gate.mechanism !== 'mechanical') continue;
        if (hasMechanism(s, gate)) continue;
        const key = gateKey(s.gateSet, gate.id);
        if (filed.has(key)) continue;
        if (bindings.get(s.id).ledger.has(gate.id)) continue; // the standard's own apply filed it already
        todo.push({ key, gate: gate.id, title: `workspace-standards gates: build the ${key} mechanism`, body: `Gate ${key} is mechanical and has no command in ${GATE_TABLE_REL}. Threshold: ${gate.threshold}. Stages: ${[].concat(gate.stage).join(', ')}.\n\nFiled by apply gates instead of writing code.\n\nCitations: [workspace-standards apply gates, scripts/foundations.mjs, ${s.id} standard.json]` });
      }
    }
  }

  // The ledger block is managed: if it was hand-edited, the new rows could not be recorded.
  const stagedAgents = files.get(agentsAbs)?.after ?? agentsText;
  if (inspectBlock(stagedAgents, LEDGER_TARGET).found) {
    const chk = upsertBlock(stagedAgents, LEDGER_TARGET, renderLedger(filed));
    if (chk.action === 'drift' && !force) {
      result.blocks.push({ file: AGENTS_REL, target: LEDGER_TARGET, action: 'drift' });
      result.drift.push({ file: AGENTS_REL, target: LEDGER_TARGET, diff: unifiedDiff(`${AGENTS_REL}#${LEDGER_TARGET}`, chk.current, chk.rendered) });
    }
  }
  const ledgerDrifted = result.drift.some((d) => d.target === LEDGER_TARGET);

  if (!readOnly) flush(); // every write that needs no uid lands before anything is filed
  if (readOnly || noFile) result.wouldFile = todo.map((t) => t.key);
  else if (result.drift.length > 0) {
    result.wouldFile = todo.map((t) => t.key);
    if (todo.length > 0) result.warnings.push(`drift in ${[...new Set(result.drift.map((d) => `${d.file}#${d.target}`))].join(', ')}: nothing was filed because the writes that record the items were refused (resolve the drift or pass --force)`);
  } else if (todo.length > 0) {
    if (!filer) throw new Error('applyFoundation: a filer is required to file mechanism items (pass noFile to skip)');
    for (const t of todo) {
      try {
        const uid = filer({ gate: t.gate ?? t.key, title: t.title, body: t.body });
        filed.set(t.key, uid);
        result.filed.push({ key: t.key, uid });
      } catch (err) {
        trace('apply-foundation:file', err);
        result.failed.push({ key: t.key, error: err.message });
      }
    }
  }
  // Safe without force: the block was absent or equal to its own rendering (checked above), or --force was given.
  if (filed.size > 0 && !ledgerDrifted) stage(agentsAbs, AGENTS_REL, (text) => upsertBlock(text, LEDGER_TARGET, renderLedger(filed), { force: true }).text);

  try {
    flush();
  } catch (err) {
    trace('apply-foundation:ledger-write', err);
    const orphans = result.filed.map((f) => `${f.key}=${f.uid}`).join(', ');
    throw Object.assign(new Error(orphans ? `${err.message}; filed but not recorded in ${AGENTS_REL}: ${orphans}` : err.message), { code: err.code, filed: result.filed });
  }
  result.exit = result.drift.length > 0 ? EXIT.DRIFT : result.failed.length > 0 ? EXIT.FILING : EXIT.OK;
  return result;
}

function main(argv) {
  const verb = argv[0];
  const target = argv[1];
  if (!['apply', 'review'].includes(verb) || !FOUNDATIONS.includes(target)) {
    process.stderr.write('usage: foundations.mjs <apply|review> <routing|gates> [--root <repo>] [--dry-run] [--force] [--no-file] [--backlog-project <name>] [--gate-table <path>]\n');
    return EXIT.USAGE;
  }
  const flags = { value: ['--root', '--backlog-project', '--gate-table'], bool: ['--dry-run', '--force', '--no-file'] };
  const opt = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (flags.value.includes(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) { process.stderr.write(`${a} requires a value\n`); return EXIT.USAGE; }
      opt[a] = v;
    } else if (flags.bool.includes(a)) opt[a] = true;
    else { process.stderr.write(`unknown argument ${a}\n`); return EXIT.USAGE; }
  }
  const root = path.resolve(opt['--root'] ?? process.cwd());
  let r;
  try {
    r = applyFoundation({
      target, root, check: verb === 'review', dryRun: !!opt['--dry-run'], force: !!opt['--force'], noFile: !!opt['--no-file'], gateTable: opt['--gate-table'],
      filer: backlogFiler({ project: opt['--backlog-project'] ?? path.basename(root) }),
    });
  } catch (err) {
    trace(`foundations ${verb} ${target}`, err);
    process.stderr.write(`${err.message}\n`);
    return err instanceof MarkerError || err.code === 'ENOENT' || err.code === 'E_INPUT' || err instanceof SyntaxError ? EXIT.INPUT : 1;
  }
  if (r.diff) process.stdout.write(r.diff);
  process.stdout.write(`${JSON.stringify({ ...r, diff: undefined, drift: r.drift.map(({ file, target: t }) => ({ file, target: t })) })}\n`);
  for (const d of r.drift) process.stderr.write(`DRIFT ${d.file} [${d.target}]: block differs from its rendering; re-run apply with --force to overwrite\n${d.diff}`);
  return r.exit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
