// 891dbac0 T62.AC1 T62.AC2 T62.AC3 T62.AC4
// Domain-neutral gate and check engine. Dependency-free Node ESM. Pure functions plus an injectable
// process runner; nothing here imports a build tool or knows one exists. A repository's command
// table is the only place a concrete tool ever appears.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const STAGES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
export const MECHANISMS = ['mechanical', 'review'];
/** Testing policy §6.7: no change class or rigor relaxes these gates. */
export const NON_RELAXABLE_IDS = ['G1', 'G2', 'G4', 'G10', 'G12'];
export const EXIT = { USAGE: 64, TABLE: 65, CHECK_FAILED: 1 };
const DEFAULT_TIMEOUT_MS = 600_000;

export class EngineError extends Error {
  constructor(code, exit, message) {
    super(message);
    this.code = code;
    this.exit = exit;
  }
}

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const asList = (v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);

/** True when the gate row may not be relaxed by class, rigor, or changed paths. */
export const isNonRelaxable = (g) => NON_RELAXABLE_IDS.includes(g.id) || g.nonRelaxable === true || g.release === true;

/** Parse and validate a command table. Throws EngineError(E_TABLE) naming every problem found. */
export function parseTable(text, label = 'table') {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new EngineError('E_TABLE', EXIT.TABLE, `${label}: not valid JSON (${err.message})`);
  }
  const problems = [];
  if (!isObj(raw) || !Array.isArray(raw.gates)) problems.push('top level must be an object with a "gates" array');
  const gates = [];
  const seen = new Set();
  for (const [i, g] of (isObj(raw) && Array.isArray(raw.gates) ? raw.gates : []).entries()) {
    const at = `gates[${i}]`;
    if (!isObj(g) || typeof g.id !== 'string' || g.id === '') { problems.push(`${at}: id must be a non-empty string`); continue; }
    if (seen.has(g.id)) problems.push(`${at}: duplicate gate id ${g.id}`);
    seen.add(g.id);
    const stages = asList(g.stage) ?? [];
    if (stages.some((s) => !STAGES.includes(s))) problems.push(`${g.id}: stage must be drawn from ${STAGES.join('')}`);
    if (!MECHANISMS.includes(g.mechanism)) problems.push(`${g.id}: mechanism must be one of ${MECHANISMS.join(', ')}`);
    if (g.command !== undefined && typeof g.command !== 'string') problems.push(`${g.id}: command must be a string`);
    if (isNonRelaxable(g) && (g.classes !== undefined || g.paths !== undefined || g.rigors !== undefined)) {
      problems.push(`${g.id}: a non-relaxable gate may not declare classes, paths, or rigors (testing policy §6.7)`);
    }
    gates.push({ ...g, stage: stages });
  }
  if (problems.length) throw new EngineError('E_TABLE', EXIT.TABLE, `${label}: ${problems.join('; ')}`);
  return { ...raw, gates, stages: isObj(raw.stages) ? raw.stages : {} };
}

export function loadTable(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new EngineError('E_TABLE', EXIT.TABLE, `cannot read command table ${file} (${err.code ?? err.message})`);
  }
  return parseTable(text, file);
}

/** Glob to RegExp: `**` crosses directories, `*` and `?` stay inside one segment. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
export const matchesAny = (file, globs) => globs.some((g) => globToRegExp(g).test(file));

/**
 * Decide which gates run. A gate is selected when it is bound to the step AND has something to check
 * for this class, rigor, and changed paths. A non-relaxable gate always has something to check.
 */
export function selectGates(table, { step, changeClass, rigor, changed }) {
  return table.gates.map((g) => {
    if (!g.stage.includes(step)) return { gate: g, selected: false, reason: `not bound to stage ${step}` };
    if (isNonRelaxable(g)) return { gate: g, selected: true, reason: 'non-relaxable' };
    if (g.classes && changeClass !== undefined && !g.classes.includes(changeClass)) {
      return { gate: g, selected: false, reason: `nothing to check for class ${changeClass}` };
    }
    if (g.rigors && rigor !== undefined && !g.rigors.includes(rigor)) {
      return { gate: g, selected: false, reason: `nothing to check at rigor ${rigor}` };
    }
    if (g.paths && changed !== undefined && !changed.some((f) => matchesAny(f, g.paths))) {
      return { gate: g, selected: false, reason: 'no changed path matches' };
    }
    return { gate: g, selected: true, reason: 'has something to check' };
  });
}

/** Default process runner. Injectable so unit tests never spawn. */
export function shellRunner(command, { cwd, timeoutMs }) {
  const r = spawnSync(command, { shell: true, cwd, encoding: 'utf8', timeout: timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  let exit;
  if (typeof r.status === 'number') exit = r.status;
  else if (r.error?.code === 'ETIMEDOUT') exit = 124;
  else if (r.signal) exit = 128 + (os.constants.signals[r.signal] ?? 0);
  else exit = 127;
  return { exit, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ? String(r.error.message) : undefined };
}

const tail = (s, n = 2000) => (s.length > n ? s.slice(s.length - n) : s);

/** Run the selected gates and build the report. Overall exit is the worst (highest) gate exit. */
export function runGates(table, opts, { run = shellRunner, now = () => Date.now(), evidenceDir } = {}) {
  const { step, changeClass, rigor, changed, root, failOnObligation } = opts;
  const decisions = selectGates(table, { step, changeClass, rigor, changed });
  const rows = [];
  for (const d of decisions) {
    const g = d.gate;
    const base = { id: g.id, stage: g.stage, mechanism: g.mechanism, command: g.command ?? null };
    if (!d.selected) { rows.push({ ...base, selected: false, outcome: 'not-applicable', exit: null, reason: d.reason }); continue; }
    if (g.mechanism !== 'mechanical' || !g.command) {
      rows.push({ ...base, selected: true, outcome: 'obligation', exit: null, reason: 'no mechanism: an obligation, not yet a gate' });
      continue;
    }
    const t0 = now();
    const r = run(g.command, { cwd: root, timeoutMs: g.timeoutMs });
    const row = { ...base, selected: true, outcome: r.exit === 0 ? 'pass' : 'fail', exit: r.exit, durationMs: now() - t0, reason: d.reason };
    if (r.error) row.error = r.error;
    if (evidenceDir) {
      fs.mkdirSync(evidenceDir, { recursive: true });
      const file = path.join(evidenceDir, `${g.id}.log`);
      fs.writeFileSync(file, `$ ${g.command}\nexit ${r.exit}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}\n`);
      row.evidence = file;
    } else if (r.exit !== 0) row.evidenceTail = tail(`${r.stdout}\n${r.stderr}`);
    rows.push(row);
  }
  const failed = rows.filter((r) => r.outcome === 'fail');
  const obligations = rows.filter((r) => r.outcome === 'obligation');
  let exit = failed.reduce((worst, r) => Math.max(worst, r.exit), 0);
  if (exit === 0 && failOnObligation && obligations.length) exit = 1;
  return {
    schema: 1,
    kind: 'gate-report',
    step, class: changeClass ?? null, rigor: rigor ?? null, changed: changed ?? null,
    gates: rows,
    summary: {
      selected: rows.filter((r) => r.selected).length,
      passed: rows.filter((r) => r.outcome === 'pass').length,
      failed: failed.map((r) => r.id),
      obligations: obligations.map((r) => r.id),
    },
    exit,
    released: false,
  };
}

// ---------------------------------------------------------------------------------------------
// Generic check entry points (T62.AC4). T41 fills the domain content by registering richer
// implementations; these defaults work purely over the command table.
// ---------------------------------------------------------------------------------------------

const finding = (check, id, evidence) => ({ check, id, key: `${check}:${id}`, severity: 'error', evidence });

const firstToken = (command) => (command.match(/^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/) ?? []).slice(1).find(Boolean);

function onPath(bin) {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return dirs.some((d) => fs.existsSync(path.join(d, bin)));
}

export const CHECKS = {
  /** Every required clause id has exactly one binding row. Clauses come from table.clauses or ctx.clauses. */
  completeness({ table, clauses }) {
    const required = clauses ?? table.clauses ?? [];
    const out = [];
    for (const c of required) {
      const n = table.gates.filter((g) => g.id === c || asList(g.clauses)?.includes(c)).length;
      if (n === 0) out.push(finding('completeness', c, `clause ${c} has no binding row`));
      if (n > 1) out.push(finding('completeness', c, `clause ${c} has ${n} binding rows, expected exactly one`));
    }
    return out;
  },
  /** Every command and referenced path in a mechanical binding exists. */
  liveness({ table, root }) {
    const out = [];
    for (const g of table.gates) {
      if (g.mechanism === 'mechanical' && g.command) {
        const bin = firstToken(g.command);
        const ok = bin && (bin.includes('/') ? fs.existsSync(path.resolve(root, bin)) : onPath(bin) || fs.existsSync(path.resolve(root, bin)));
        if (!ok) out.push(finding('liveness', g.id, `command not found: ${bin ?? '(empty)'}`));
      }
      for (const ref of asList(g.references) ?? []) {
        if (!fs.existsSync(path.resolve(root, ref))) out.push(finding('liveness', g.id, `referenced path missing: ${ref}`));
      }
    }
    return out;
  },
  /** A gate bound to a stage is invoked by that stage (table.stages[stage].invokes); an unbound gate is a finding. */
  reachability({ table }) {
    const out = [];
    for (const g of table.gates) {
      if (g.stage.length === 0) { out.push(finding('reachability', g.id, 'gate is bound to no stage')); continue; }
      for (const s of g.stage) {
        const invokes = asList(table.stages[s]?.invokes) ?? [];
        if (!invokes.includes(g.id)) out.push(finding('reachability', `${g.id}@${s}`, `stage ${s} does not invoke ${g.id}`));
      }
    }
    return out;
  },
  /** Each mechanical gate has a seeded-violation command that must exit non-zero. */
  teeth({ table, root, run }) {
    const out = [];
    for (const g of table.gates.filter((x) => x.mechanism === 'mechanical')) {
      const seeded = g.seeded?.command;
      if (!seeded) { out.push(finding('teeth', g.id, 'no seeded-violation command declared')); continue; }
      const r = run(seeded, { cwd: root, timeoutMs: g.timeoutMs });
      if (r.exit === 0) out.push(finding('teeth', g.id, `seeded violation was not caught: \`${seeded}\` exited 0`));
    }
    return out;
  },
};

/** Register or replace a check entry point (how T41 plugs in domain content). */
export function registerCheck(name, fn) {
  if (typeof fn !== 'function') throw new EngineError('E_USAGE', EXIT.USAGE, `check ${name} must be a function`);
  CHECKS[name] = fn;
}

/**
 * Shrink-only ratchet: baseline is `{ "<check>:<id>": true }` keys. A finding outside the baseline is
 * new (fail). A baseline key with no finding is stale (fail) so the baseline can only shrink.
 */
export function applyBaseline(findings, baselineKeys) {
  const base = new Set(baselineKeys);
  const keys = new Set(findings.map((f) => f.key));
  return {
    newFindings: findings.filter((f) => !base.has(f.key)),
    tolerated: findings.filter((f) => base.has(f.key)),
    stale: [...base].filter((k) => !keys.has(k)),
  };
}

export function runChecks(names, ctx, baselineKeys = []) {
  const unknown = names.filter((n) => !CHECKS[n]);
  if (unknown.length) throw new EngineError('E_UNKNOWN_CHECK', EXIT.USAGE, `unknown check: ${unknown.join(', ')} (known: ${Object.keys(CHECKS).join(', ')})`);
  const findings = names.flatMap((n) => CHECKS[n](ctx));
  const r = applyBaseline(findings, baselineKeys);
  const exit = r.newFindings.length || r.stale.length ? EXIT.CHECK_FAILED : 0;
  return { schema: 1, kind: 'check-report', checks: names, findings: r.newFindings, tolerated: r.tolerated.map((f) => f.key), stale: r.stale, exit, released: false };
}

/** Rewrite the baseline only if it would not grow. Returns the keys written or throws. */
export function shrinkBaseline(file, findings) {
  const old = fs.existsSync(file) ? Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))) : [];
  const next = findings.map((f) => f.key);
  const added = next.filter((k) => !old.includes(k));
  if (old.length && added.length) throw new EngineError('E_BASELINE_GROWS', EXIT.CHECK_FAILED, `baseline may only shrink; new findings: ${added.join(', ')}`);
  fs.writeFileSync(file, `${JSON.stringify(Object.fromEntries(next.map((k) => [k, true])), null, 2)}\n`);
  return next;
}

export function readBaseline(file) {
  if (!file || !fs.existsSync(file)) return [];
  try {
    return Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    throw new EngineError('E_BASELINE', EXIT.TABLE, `baseline ${file} is not valid JSON (${err.message})`);
  }
}
