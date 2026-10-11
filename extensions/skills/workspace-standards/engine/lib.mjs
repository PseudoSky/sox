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
/** Gate ids become evidence file names, so they are restricted to a safe charset (no separators, no `..`). */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
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
    if (!SAFE_ID.test(g.id) || g.id.includes('..')) { problems.push(`${at}: gate id ${JSON.stringify(g.id)} must match [A-Za-z0-9._-], start with a letter or digit, and not contain ".."`); continue; }
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

const declared = (table, key) => [...new Set(table.gates.flatMap((g) => asList(g[key]) ?? []))];

/**
 * Reject selection inputs that cannot select anything meaningful, so a typo is never a green run.
 * --step must be a known stage that at least one gate is bound to. The engine has no closed set of
 * classes or rigors (a table defines its own), so --class / --rigor must appear in some gate's
 * `classes` / `rigors`. Throws EngineError(E_USAGE, 64).
 */
export function validateSelection(table, { step, changeClass, rigor }) {
  if (!STAGES.includes(step)) throw new EngineError('E_USAGE', EXIT.USAGE, `unknown --step ${JSON.stringify(step)} (known: ${STAGES.join(', ')})`);
  if (!table.gates.some((g) => g.stage.includes(step))) throw new EngineError('E_USAGE', EXIT.USAGE, `no gate in the table is bound to step ${step}`);
  for (const [flag, value, key] of [['--class', changeClass, 'classes'], ['--rigor', rigor, 'rigors']]) {
    if (value === undefined) continue;
    const known = declared(table, key);
    if (!known.includes(value)) {
      throw new EngineError('E_USAGE', EXIT.USAGE, `unknown ${flag} ${JSON.stringify(value)}: no gate declares it (${known.length ? `declared: ${known.join(', ')}` : `no gate declares any ${key}`})`);
    }
  }
}

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

/** Remove `*.log` files in `dir` whose stem is not in `keepIds`. Missing directory is a no-op; nothing else is touched. */
export function clearStaleEvidence(dir, keepIds) {
  if (!fs.existsSync(dir)) return [];
  const removed = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith('.log') || keepIds.has(ent.name.slice(0, -4))) continue;
    fs.rmSync(path.join(dir, ent.name));
    removed.push(ent.name);
  }
  return removed;
}

const tail = (s, n = 2000) => (s.length > n ? s.slice(s.length - n) : s);

/**
 * Run the selected gates and build the report. Overall exit is the worst (highest) gate exit
 * (T62.AC2). A gate may itself exit 64 or 65, which is also what the engine uses for usage and table
 * errors; the two are told apart by the report: a gate result is `kind: "gate-report"`, an engine
 * error is `kind: "engine-error"` (written by the CLI) and always carries `engineError: true`.
 */
export function runGates(table, opts, { run = shellRunner, now = () => Date.now(), evidenceDir } = {}) {
  const { step, changeClass, rigor, changed, root, failOnObligation } = opts;
  const decisions = selectGates(table, { step, changeClass, rigor, changed });
  const rows = [];
  // 891dbac0 AC2: logs left by an earlier run for gates not run this time must not sit next to a fresh report.
  // Only `<id>.log` files inside the evidence directory are touched (ids are a safe charset, so a log is ours).
  const writtenIds = new Set(decisions.filter((d) => d.selected && d.gate.mechanism === 'mechanical' && d.gate.command).map((d) => d.gate.id));
  if (evidenceDir) clearStaleEvidence(evidenceDir, writtenIds);
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
  const warnings = [];
  if (rows.every((r) => !r.selected)) warnings.push(`step ${step}: 0 gates selected (every bound gate has nothing to check for this class, rigor, and changed paths)`);
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
    warnings,
    exit,
    engineError: false,
    released: false,
  };
}

// ---------------------------------------------------------------------------------------------
// Generic check entry points (T62.AC4). T41 fills the domain content by registering richer
// implementations; these defaults work purely over the command table.
// ---------------------------------------------------------------------------------------------

const finding = (check, id, evidence) => ({ check, id, key: `${check}:${id}`, severity: 'error', evidence });

/** POSIX special/regular builtins a gate command may legitimately start with; they are not files on PATH. */
export const SHELL_BUILTINS = new Set(['test', '[', 'cd', 'true', 'false', ':', 'echo', 'printf', 'exit', 'export', 'set', 'unset', 'read', 'exec', 'eval', 'wait', 'type', 'command', 'umask', 'ulimit']);

/**
 * The command word of a shell command line: leading `VAR=value` assignments are skipped and a quoted
 * word is unquoted. Only the FIRST simple command is examined; `a && b`, `a; b`, and `a | b` check `a`
 * alone (documented limitation, README).
 */
export const firstToken = (command) => {
  let rest = command;
  for (;;) {
    const m = rest.match(/^\s*[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)(?=\s|$)/);
    if (!m) break;
    rest = rest.slice(m[0].length);
  }
  return (rest.match(/^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/) ?? []).slice(1).find(Boolean);
};

const isExecutable = (file) => {
  try {
    return fs.statSync(file).isFile() && (fs.accessSync(file, fs.constants.X_OK), true);
  } catch {
    return false;
  }
};

function onPath(bin) {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return dirs.some((d) => isExecutable(path.join(d, bin)));
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
        const ok = bin && (bin.includes('/') ? isExecutable(path.resolve(root, bin)) : SHELL_BUILTINS.has(bin) || onPath(bin));
        if (!ok) out.push(finding('liveness', g.id, `command not found or not executable: ${bin ?? '(empty)'}`));
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

/** Run the named checks once and return every finding (before any baseline is applied). */
export function collectFindings(names, ctx) {
  const unknown = names.filter((n) => !CHECKS[n]);
  if (unknown.length) throw new EngineError('E_UNKNOWN_CHECK', EXIT.USAGE, `unknown check: ${unknown.join(', ')} (known: ${Object.keys(CHECKS).join(', ')})`);
  return names.flatMap((n) => CHECKS[n](ctx));
}

/** Build the check report from findings already collected, so callers never run a check twice. */
export function reportFromFindings(names, findings, baselineKeys = []) {
  const r = applyBaseline(findings, baselineKeys);
  const exit = r.newFindings.length || r.stale.length ? EXIT.CHECK_FAILED : 0;
  return { schema: 1, kind: 'check-report', checks: names, findings: r.newFindings, tolerated: r.tolerated.map((f) => f.key), stale: r.stale, exit, engineError: false, released: false };
}

export const runChecks = (names, ctx, baselineKeys = []) => reportFromFindings(names, collectFindings(names, ctx), baselineKeys);

const writeBaseline = (file, keys) => fs.writeFileSync(file, `${JSON.stringify(Object.fromEntries(keys.map((k) => [k, true])), null, 2)}\n`);

/**
 * Shrink-only ratchet rewrite: the baseline may lose entries, never gain one. A missing or empty
 * baseline therefore accepts nothing (every finding would be an addition); first creation is the
 * separate, explicit {@link initBaseline}.
 */
export function shrinkBaseline(file, findings) {
  const old = fs.existsSync(file) ? readBaseline(file) : [];
  const next = findings.map((f) => f.key);
  const added = next.filter((k) => !old.includes(k));
  if (added.length) {
    const hint = old.length ? '' : ' (no baseline entries exist; create one explicitly with --init-baseline)';
    throw new EngineError('E_BASELINE_GROWS', EXIT.CHECK_FAILED, `baseline may only shrink; would add: ${added.join(', ')}${hint}`);
  }
  writeBaseline(file, next);
  return next;
}

/** Create a baseline from the current findings. Refuses to overwrite an existing file. */
export function initBaseline(file, findings) {
  if (fs.existsSync(file)) throw new EngineError('E_BASELINE_EXISTS', EXIT.USAGE, `baseline ${file} already exists; --init-baseline only creates one (use --update-baseline to shrink it)`);
  const next = findings.map((f) => f.key);
  writeBaseline(file, next);
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
