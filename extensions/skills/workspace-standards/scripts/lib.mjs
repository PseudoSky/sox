// 9024e9ac T14.AC1 T14.AC3 T14.AC4 T14.AC5 T14.AC6 T14.AC7 T14.AC8 T14.AC10
// Shared, dependency-free logic for the workspace-standards scripts. Pure functions over
// strings and the filesystem; nothing here spawns a process or touches the network.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERBS = ['review', 'run', 'apply'];
export const TOOL_VOCAB = ['read', 'search', 'shell', 'edit', 'backlog'];
export const OBLIGATION_ID = /^[A-Z]{2}\.[0-9]+$/;
export const ROLES_COVERED_PREFIX = 'roles-covered:';

/** Named errors. `exit` is the process exit status of the CLI that reports it. */
export const ERR = {
  USAGE: { code: 'E_USAGE', exit: 64 },
  UNKNOWN_TARGET: { code: 'E_UNKNOWN_TARGET', exit: 2 },
  UNSUPPORTED_VERB: { code: 'E_UNSUPPORTED_VERB', exit: 3 },
  UNKNOWN_VERB: { code: 'E_UNKNOWN_VERB', exit: 4 },
  PLANNED_TARGET: { code: 'E_PLANNED_TARGET', exit: 5 },
  UNSUPPORTED_MODE: { code: 'E_UNSUPPORTED_MODE', exit: 6 },
  PLAYBOOK_MISSING: { code: 'E_PLAYBOOK_MISSING', exit: 7 },
};
const fail = (err, message, extra = {}) => ({ ok: false, error: { code: err.code, exit: err.exit, message, ...extra } });

export function readText(file) {
  return fs.readFileSync(file, 'utf8');
}
export function readJson(file) {
  return JSON.parse(readText(file));
}
export function loadRegistry(root = SKILL_ROOT) {
  return readJson(path.join(root, 'registry.json'));
}
const fileHasContent = (root, rel) => {
  if (!rel) return false;
  try {
    return fs.statSync(path.join(root, rel)).size > 0;
  } catch {
    return false;
  }
};
export { fileHasContent };

/** Every target in the registry, foundations first. */
export function listTargets(registry) {
  return [
    ...registry.foundations.map((f) => ({ ...f, kind: 'foundation' })),
    ...registry.standards.map((s) => ({ ...s, kind: 'standard' })),
  ];
}

/**
 * T14.AC3: resolve `<verb> <target>` to the playbook path. An unknown target, an unknown verb,
 * or a verb the target lacks is a named error, never a silent default.
 */
export function resolveVerb({ root = SKILL_ROOT, verb, target, mode } = {}) {
  if (!verb || !target) return fail(ERR.USAGE, 'usage: ws.mjs <review|run|apply> <target> [--mode <name>]');
  if (!VERBS.includes(verb)) return fail(ERR.UNKNOWN_VERB, `unknown verb "${verb}"; expected one of ${VERBS.join(', ')}`);
  const registry = loadRegistry(root);
  const targets = listTargets(registry);
  if (target === 'all') {
    if (verb === 'run') return fail(ERR.UNSUPPORTED_VERB, '"run" takes one target; "all" is valid for review and apply only');
    const items = targets.map((t) => ({
      target: t.id,
      kind: t.kind,
      status: t.status,
      playbook: t.status === 'active' ? (t.playbooks?.[verb] ?? null) : null,
    }));
    return { ok: true, verb, target: 'all', order: 'foundations first, then standards', items };
  }
  const t = targets.find((x) => x.id === target);
  if (!t) {
    return fail(ERR.UNKNOWN_TARGET, `unknown target "${target}"; registered: ${targets.map((x) => x.id).join(', ')}`);
  }
  if (t.status !== 'active') {
    return fail(ERR.PLANNED_TARGET, `target "${target}" is ${t.status}: it has no playbooks yet`);
  }
  let rel = t.playbooks?.[verb];
  if (mode) {
    rel = t.modes?.[verb]?.[mode];
    if (!rel) {
      const known = Object.keys(t.modes?.[verb] ?? {});
      return fail(ERR.UNSUPPORTED_MODE, `target "${target}" has no mode "${mode}" for verb "${verb}"; modes: ${known.join(', ') || 'none'}`);
    }
  }
  if (!rel) return fail(ERR.UNSUPPORTED_VERB, `target "${target}" has no playbook for verb "${verb}"`);
  if (!fileHasContent(root, rel)) return fail(ERR.PLAYBOOK_MISSING, `registry names "${rel}" for ${verb} ${target} but the file is missing or empty`);
  return { ok: true, verb, target, kind: t.kind, mode: mode ?? null, playbook: rel, path: path.join(root, rel) };
}

/** T14.AC8: findings for every registered target that lacks a part the contract requires. */
export function reviewAll({ root = SKILL_ROOT } = {}) {
  const registry = loadRegistry(root);
  const findings = [];
  const add = (target, id, severity, detail) => findings.push({ target, id, severity, detail });
  for (const f of registry.foundations) {
    for (const verb of VERBS) {
      if (f.status !== 'active' || !fileHasContent(root, f.playbooks?.[verb])) {
        add(f.id, 'missing-playbook', f.status === 'active' ? 'error' : 'planned', `foundation lacks the "${verb}" playbook`);
      }
    }
  }
  for (const s of registry.standards) {
    const sev = s.status === 'active' ? 'error' : 'planned';
    if (s.status !== 'active') add(s.id, 'planned-standard', 'planned', `status is ${s.status}`);
    for (const verb of VERBS) {
      if (s.status !== 'active' || !fileHasContent(root, s.playbooks?.[verb])) {
        add(s.id, 'missing-playbook', sev, `no "${verb}" playbook`);
      }
    }
    let specOk = false;
    if (s.status === 'active' && fileHasContent(root, s.conformance)) {
      try {
        specOk = Array.isArray(readJson(path.join(root, s.conformance)).checks) && readJson(path.join(root, s.conformance)).checks.length > 0;
      } catch {
        specOk = false;
      }
    }
    if (!specOk) add(s.id, 'missing-conformance-spec', sev, 'no runnable conformance specification');
    if (s.status !== 'active' || !fileHasContent(root, s.applyTemplate)) add(s.id, 'missing-apply-template', sev, 'no apply template');
    if (s.status !== 'active' || !fileHasContent(root, s.declaration)) add(s.id, 'missing-declaration', sev, 'no machine-readable declaration');
  }
  return { findings, checked: { foundations: registry.foundations.length, standards: registry.standards.length } };
}
export const reviewAllExit = (findings, { allowPlanned = false } = {}) =>
  findings.some((f) => f.severity !== 'planned' || !allowPlanned) ? 1 : 0;

// ---------- roles.md ----------

/** T14.AC7: parse roles.md into roles with obligations, tools, independence, hints, no-holder. */
export function parseRoles(text) {
  const roles = [];
  const errors = [];
  let cur = null;
  for (const raw of text.split('\n')) {
    const h = /^## role: ([a-z][a-z-]*)\s*$/.exec(raw);
    if (h) {
      cur = { name: h[1], prefix: null, obligations: [], tools: [], distinctFrom: [], hints: [], independence: '', noHolder: '', deepBlocks: null };
      roles.push(cur);
      continue;
    }
    if (!cur) continue;
    const m = /^- ([A-Za-z.0-9-]+):\s*(.*)$/.exec(raw);
    if (!m) continue;
    const [, key, valRaw] = m;
    const val = valRaw.trim();
    const list = () => val.split(',').map((x) => x.trim()).filter(Boolean);
    if (OBLIGATION_ID.test(key)) {
      const c = /\[([^\]]*)\]\s*$/.exec(val);
      cur.obligations.push({ id: key, text: c ? val.slice(0, c.index).trim() : val, clauses: c ? c[1].split(',').map((x) => x.trim()).filter(Boolean) : [] });
    } else if (key === 'prefix') cur.prefix = val;
    else if (key === 'tools') cur.tools = list();
    else if (key === 'distinct-from') cur.distinctFrom = list();
    else if (key === 'hints') cur.hints = list();
    else if (key === 'independence') cur.independence = val;
    else if (key === 'no-holder') {
      cur.noHolder = val;
      const d = /deep-blocks:\s*(yes|no)/.exec(val);
      cur.deepBlocks = d ? d[1] === 'yes' : null;
    } else errors.push(`role ${cur.name}: unknown field "${key}"`);
  }
  return { roles, errors };
}

export function validateRoles(parsed) {
  const errors = [...parsed.errors];
  const names = new Set(parsed.roles.map((r) => r.name));
  const seen = new Set();
  if (parsed.roles.length === 0) errors.push('no roles found');
  for (const r of parsed.roles) {
    if (!r.prefix || !/^[A-Z]{2}$/.test(r.prefix)) errors.push(`role ${r.name}: prefix must be two capitals`);
    if (r.obligations.length === 0) errors.push(`role ${r.name}: no obligations`);
    for (const o of r.obligations) {
      if (seen.has(o.id)) errors.push(`duplicate obligation id ${o.id}`);
      seen.add(o.id);
      if (r.prefix && !o.id.startsWith(`${r.prefix}.`)) errors.push(`role ${r.name}: obligation ${o.id} does not start with prefix ${r.prefix}`);
      if (o.clauses.length === 0) errors.push(`obligation ${o.id}: no clause cited`);
    }
    if (r.tools.length === 0) errors.push(`role ${r.name}: no tools`);
    for (const t of r.tools) if (!TOOL_VOCAB.includes(t)) errors.push(`role ${r.name}: unknown tool "${t}"`);
    for (const d of r.distinctFrom) if (!names.has(d)) errors.push(`role ${r.name}: distinct-from names unknown role "${d}"`);
    if (!r.independence) errors.push(`role ${r.name}: no independence field`);
    if (!r.noHolder) errors.push(`role ${r.name}: no no-holder outcome`);
    else if (r.deepBlocks === null) errors.push(`role ${r.name}: no-holder must state deep-blocks: yes|no`);
  }
  const prefixes = parsed.roles.map((r) => r.prefix);
  if (new Set(prefixes).size !== prefixes.length) errors.push('duplicate role prefix');
  return errors;
}
export const obligationIds = (parsed) => new Set(parsed.roles.flatMap((r) => r.obligations.map((o) => o.id)));

// ---------- policy (STRATEGY) clause ids ----------

/** Clause ids defined by a policy document: sections from numbered headings, P#, G#, R#. */
export function parseStrategy(text) {
  const sections = new Set();
  const ids = new Set();
  for (const line of text.split('\n')) {
    const h = /^#{2,3}\s+(\d+(?:\.\d+)*)\.?\s/.exec(line);
    if (h) sections.add(h[1]);
    const p = /^\*\*(P\d+) /.exec(line);
    if (p) ids.add(p[1]);
    const g = /^\| (G\d+) \|/.exec(line);
    if (g) ids.add(g[1]);
    const r = /^\| (R\d+) \|/.exec(line);
    if (r) ids.add(r[1]);
  }
  return { sections, ids };
}

export const FORBIDDEN_CITATION = /\b[DTF]\d{1,2}\b|§1[A-G]\b|\bBL-\d+\b|STRATEGY_MAP|\bMAP\b|\bAC\d+\b/g;

/** Citations in a card: §sections and P#/G#/R# ids. */
export function extractCitations(text) {
  const sections = [...text.matchAll(/§(\d+(?:\.\d+)*)/g)].map((m) => m[1]);
  const ids = [...text.matchAll(/\b([PGR]\d{1,2})\b/g)].map((m) => m[1]);
  const forbidden = [...text.matchAll(FORBIDDEN_CITATION)].map((m) => m[0]);
  return { sections, ids, forbidden };
}

/** T14.AC4: findings for one card. `strategy` is optional; without it existence is not checked. */
export function checkCard({ name, text, bytes, maxBytes = 4096, strategy = null, obligations = null }) {
  const f = [];
  if (bytes > maxBytes) f.push(`${name}: ${bytes} bytes exceeds ${maxBytes}`);
  const c = extractCitations(text);
  if (c.forbidden.length) f.push(`${name}: non-STRATEGY reference(s) ${[...new Set(c.forbidden)].join(', ')}`);
  if (c.sections.length + c.ids.length === 0) f.push(`${name}: cites no STRATEGY clause id`);
  if (strategy) {
    for (const s of new Set(c.sections)) {
      const parts = s.split('.');
      const heading = parts.slice(0, Math.min(parts.length, 2)).join('.');
      if (!strategy.sections.has(heading)) f.push(`${name}: §${s} not found in the policy`);
    }
    for (const id of new Set(c.ids)) if (!strategy.ids.has(id)) f.push(`${name}: ${id} not found in the policy`);
  }
  if (obligations) {
    const line = /^Clauses?:.*Obligations?:\s*(.+?)\.?\s*$/m.exec(text) ?? /Obligations?:\s*([A-Z0-9., ]+)/.exec(text);
    const listed = line ? [...line[1].matchAll(/[A-Z]{2}\.[0-9]+/g)].map((m) => m[0]) : [];
    if (listed.length === 0) f.push(`${name}: names no obligation id`);
    for (const id of listed) if (!obligations.has(id)) f.push(`${name}: obligation ${id} is not defined in roles.md`);
  }
  return f;
}

/** T14.AC5: the last level-2 heading of a playbook must be "Record". */
export function endsInRecord(text) {
  const heads = [...text.matchAll(/^## (.+?)\s*$/gm)].map((m) => m[1]);
  if (heads.length === 0) return { ok: false, last: null };
  return { ok: /^Record\b/.test(heads[heads.length - 1]), last: heads[heads.length - 1] };
}

/** T14.AC6: every required field appears backticked in the format document. */
export function missingFormatFields(text, fields) {
  return fields.filter((f) => !text.includes('`' + f + '`'));
}

/** Expand ["P1-P14","G1-G12"] into ids. */
export function expandRanges(ranges) {
  return ranges.flatMap((r) => {
    const m = /^([A-Z])(\d+)-\1(\d+)$/.exec(r);
    if (!m) return [r];
    return Array.from({ length: Number(m[3]) - Number(m[2]) + 1 }, (_, i) => `${m[1]}${Number(m[2]) + i}`);
  });
}

// ---------- roles-covered declarations (T14.AC10) ----------

export function coveredIds(manifest) {
  return (manifest.capabilities ?? [])
    .filter((c) => typeof c === 'string' && c.startsWith(ROLES_COVERED_PREFIX))
    .map((c) => c.slice(ROLES_COVERED_PREFIX.length));
}

/** Findings for each agent: no declaration, or ids roles.md does not define. */
export function reviewRouting({ agents, obligations }) {
  const findings = [];
  const report = [];
  for (const { agent, manifest } of agents) {
    const covered = coveredIds(manifest);
    report.push({ agent, covered });
    if (covered.length === 0) {
      findings.push({ agent, id: 'no-roles-covered-declaration', detail: 'capabilities has no "roles-covered:<id>" entry' });
      continue;
    }
    for (const id of covered) {
      if (!OBLIGATION_ID.test(id)) findings.push({ agent, id: 'malformed-obligation-id', detail: id });
      else if (!obligations.has(id)) findings.push({ agent, id: 'unknown-obligation-id', detail: id });
    }
  }
  return { findings, agents: report };
}

export function loadAgents(agentsDir) {
  const out = [];
  for (const d of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const mf = path.join(agentsDir, d.name, 'extension.json');
    if (!fs.existsSync(mf)) continue;
    const manifest = readJson(mf);
    if (manifest.type && manifest.type !== 'agent') continue;
    out.push({ agent: manifest.id ?? d.name, manifest });
  }
  return out.sort((a, b) => a.agent.localeCompare(b.agent));
}

// ---------- conformance ----------

const STANDARD_REQUIRED = ['standard', 'policy', 'roles', 'workClasses', 'gates', 'carriers'];
export function validateDeclaration(decl) {
  const e = [];
  for (const k of STANDARD_REQUIRED) if (!(k in decl)) e.push(`declaration lacks "${k}"`);
  for (const k of Object.keys(decl)) if (![...STANDARD_REQUIRED, 'own'].includes(k)) e.push(`declaration has unknown key "${k}"`);
  if (decl.own !== undefined && !(Array.isArray(decl.own) && decl.own.every((x) => ['routing', 'gates'].includes(x)))) e.push('own must be a list drawn from routing, gates');
  for (const w of decl.workClasses ?? []) {
    if (!w.id) e.push('workClass without id');
    if (!['none', 'light', 'standard', 'deep'].includes(w.defaultRigor)) e.push(`workClass ${w.id}: bad defaultRigor`);
  }
  const gateIds = new Set();
  for (const g of decl.gates ?? []) {
    for (const k of ['id', 'threshold', 'mechanism', 'stage']) if (!(k in g)) e.push(`gate ${g.id ?? '?'} lacks ${k}`);
    if (!['mechanical', 'review'].includes(g.mechanism)) e.push(`gate ${g.id}: mechanism must be mechanical|review`);
    if (!Array.isArray(g.stage) || g.stage.length === 0 || !g.stage.every((s) => /^[A-H]$/.test(s))) e.push(`gate ${g.id}: stage must be a non-empty list of A-H`);
    if (gateIds.has(g.id)) e.push(`duplicate gate ${g.id}`);
    gateIds.add(g.id);
  }
  for (const [clause, carrier] of Object.entries(decl.carriers ?? {})) {
    if (!['check', 'field', 'brief-slice', 'card'].includes(carrier)) e.push(`carrier for ${clause}: "${carrier}" is not check|field|brief-slice|card`);
  }
  return e;
}

/** Run a conformance specification. Returns { checks, ok }. */
export function runConformance({ root = SKILL_ROOT, standardDir, spec, strategyText = null }) {
  const strategy = strategyText ? parseStrategy(strategyText) : null;
  const rel = (p) => path.join(standardDir, p);
  const rolesParsed = parseRoles(readText(rel('roles.md')));
  const oblig = obligationIds(rolesParsed);
  const checks = [];
  for (const c of spec.checks) {
    let findings = [];
    try {
      switch (c.kind) {
        case 'declaration-valid': {
          const decl = readJson(rel('standard.json'));
          findings = validateDeclaration(decl);
          const roleNames = rolesParsed.roles.map((r) => r.name).sort().join(',');
          if ([...decl.roles].sort().join(',') !== roleNames) findings.push('declaration roles differ from roles.md roles');
          break;
        }
        case 'roles-valid':
          findings = validateRoles(rolesParsed);
          if (c.expectedRoles && rolesParsed.roles.length !== c.expectedRoles) findings.push(`expected ${c.expectedRoles} roles, found ${rolesParsed.roles.length}`);
          break;
        case 'carriers-complete': {
          const decl = readJson(rel('standard.json'));
          for (const id of expandRanges(c.ranges)) if (!decl.carriers?.[id]) findings.push(`no carrier for ${id}`);
          break;
        }
        case 'gates-complete': {
          const decl = readJson(rel('standard.json'));
          const have = new Set(decl.gates.map((g) => g.id));
          for (const id of expandRanges(c.ids)) if (!have.has(id)) findings.push(`gate ${id} not declared`);
          break;
        }
        case 'cards':
          for (const name of c.required) {
            const file = rel(path.join(c.dir, name));
            if (!fs.existsSync(file)) {
              findings.push(`${name}: missing`);
              continue;
            }
            findings.push(...checkCard({ name, text: readText(file), bytes: fs.statSync(file).size, maxBytes: c.maxBytes, strategy, obligations: oblig }));
          }
          break;
        case 'playbooks-end-in-record':
          for (const name of c.files) {
            const file = rel(name);
            if (!fs.existsSync(file)) findings.push(`${name}: missing`);
            else {
              const r = endsInRecord(readText(file));
              if (!r.ok) findings.push(`${name}: last section is "${r.last}", not "Record"`);
            }
          }
          break;
        case 'formats':
          for (const [name, fields] of Object.entries(c.formats)) {
            const file = rel(path.join(c.dir, name));
            if (!fs.existsSync(file)) findings.push(`${name}: missing`);
            else for (const f of missingFormatFields(readText(file), fields)) findings.push(`${name}: field \`${f}\` not documented`);
          }
          break;
        default:
          findings.push(`unknown check kind "${c.kind}"`);
      }
    } catch (err) {
      findings.push(`check threw: ${err.message}`);
    }
    checks.push({ id: c.id, kind: c.kind, ok: findings.length === 0, findings });
  }
  return { standard: spec.standard, strategy: strategy ? 'checked against the provided policy' : 'not provided: clause-id existence not checked', checks, ok: checks.every((x) => x.ok) };
}
