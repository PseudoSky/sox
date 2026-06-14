#!/usr/bin/env node
/**
 * compile-task.js — the task-compiler (Layer 2 of the plan-state-machine
 * evolution plan).
 *
 * AUTHORITATIVE SPEC:
 *   docs/experiments/plan-state-machine-compile-task-spec.md
 *
 * `compile-task.js <plan-dir> <slug>` derives a minimal, self-contained
 * **work-order** from Layer 1 (README/dag.json/contexts/_shared.md/
 * references.json/audit_*.py) + current git refs. It carries ONLY what THIS
 * state needs and EXCLUDES everything else — the full dag, other states'
 * contexts, the README, the whole audit script. This is goal 2: eliminate
 * non-task-necessary plan context from a single executor tasking.
 *
 * The compiler is READ-ONLY on Layer 1 and PURE (same inputs + refs → same
 * work-order). Node standard library only — no npm dependencies. ESM.
 *
 * Usage:
 *   node compile-task.js <plan-dir> <slug> [--format md|json] [--stats]
 *
 *   --format md     (default) → human work-order.md for SOX agents
 *   --format json            → task-packet.json for agent-forge
 *   --stats                  → {work_order_bytes, excluded_bytes, reduction_ratio}
 *
 * Degraded mode (spec §7): an old plan with no recorded `start_ref` compiles
 * with `degraded:true`; read-only snapshots carry a `pointer` and `content:
 * null` (never fabricated). `dependents[]` degrades to [] when gitnexus is
 * unavailable.
 *
 * Exit codes:
 *   0 — work-order compiled
 *   2 — usage error (missing plan-dir/slug, not a directory, unknown slug)
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  collapseWs,
  collectCriterionIds,
  distillationField,
  extractAuditCommand,
  normPath,
  parseAcceptanceCriteria,
  parseRefCitations,
  parseReservationKey,
  sectionBody,
} from "./lib/context-parse.js";
import { normalizeStateEntry } from "./lib/normalize-state.js";

const SCHEMA_VERSION = 1;

// ── tiny I/O helpers (mirror gap-check.js / extract-training-record.js) ──

function readFileOrNull(file) {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

function readJsonOrNull(file) {
  const raw = readFileOrNull(file);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function byteLen(str) {
  return Buffer.byteLength(str ?? "", "utf-8");
}

// ── git helpers (execSync, mirror extract-training-record.js) ──

function git(cwd, argline) {
  try {
    return execSync(`git ${argline}`, {
      cwd,
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

/** `git show <ref>:<file>` content, or null if unavailable. */
function gitShow(cwd, ref, file) {
  if (!ref) return null;
  return git(cwd, `show ${JSON.stringify(`${ref}:${file}`)}`);
}

// ── gitnexus best-effort dependents (spec §4/§9 step 6) ──

/**
 * Best-effort blast-radius discovery for the symbols/files this state mutates.
 * Parses path-like tokens out of `npx gitnexus context` output (the format is
 * not contractually stable, so we keep only on-disk paths). Degrades to [] when
 * gitnexus is unavailable — the spec REQUIRES degradation, never a hard fail.
 */
function gitnexusDependents(cwd, targets) {
  const out = new Set();
  for (const target of targets) {
    try {
      const res = execSync(
        `npx gitnexus context ${JSON.stringify(target)} 2>/dev/null || true`,
        { cwd, encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 },
      );
      const re = /([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)(?::\d+)?/g;
      let m;
      while ((m = re.exec(res)) !== null) {
        const p = normPath(m[1]);
        if (p.includes("/") && p !== target) out.add(p);
      }
    } catch {
      /* unavailable — degrade to [] for this target */
    }
  }
  return [...out];
}

// ── reference resolution (spec §2: references.json ∩ [ref:X] cited) ──

/**
 * Inline ONLY the references this context cites, from references.json (a FLAT
 * slug-keyed object — never the whole file). Unknown citations are dropped
 * (the compiler does not invent reference bodies).
 */
function resolveReferences(refsJson, citedSlugs) {
  if (!refsJson || typeof refsJson !== "object") return [];
  const out = [];
  for (const slug of citedSlugs) {
    const ref = refsJson[slug];
    if (!ref || typeof ref !== "object") continue;
    out.push({
      ref: slug,
      title: ref.rule || ref.anchor || slug,
      body: ref.anchor && ref.rule ? `${ref.anchor} — ${ref.rule}` : ref.rule || ref.anchor || "",
      discovered_via: ref.discovered_via || "manual",
    });
  }
  return out;
}

// ── invariants from _shared.md (spec §2: lean always-applicable core) ──

/**
 * Extract the `[inv:name] — text` lines from _shared.md's `## Cross-cutting
 * invariants` section. The work-order carries the lean shared-invariant core,
 * plus any state-specific invariants the context declares inline.
 */
function parseSharedInvariants(sharedMd) {
  const body = sectionBody(sharedMd, "Cross-cutting invariants");
  if (!body) return [];
  const out = [];
  const re = /\*\*\[inv:[a-z0-9-]+\]\*\*\s*[—-]+\s*([^\n]*)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const text = collapseWs(m[1]);
    if (text) out.push(text);
  }
  return out;
}

/** State-specific invariants from the context's distillation `Invariants` field. */
function parseStateInvariants(contextMd) {
  const raw = distillationField(contextMd, "Invariants");
  if (!raw) return [];
  // Reference tokens like [inv:name] resolve from _shared; keep any prose that
  // is not purely a reference pointer.
  const stripped = collapseWs(raw.replace(/\*\*\[inv:[a-z0-9-]+\]\*\*/g, "").replace(/\[inv:[a-z0-9-]+\]/g, ""));
  if (!stripped || /^[—\-.,;:\s]*$/.test(stripped)) return [];
  return [stripped];
}

// ── dispatch_profile heuristic (spec §5) ──

/**
 * First-pass (task → required_segments) label. Rule-based from kind, phase,
 * guard/audit shape, and task content. Marked confidence:heuristic-v1 so it is
 * never mistaken for a verified segment-selection label (spec §5).
 *
 * All 7 agent-forge SP-segment types are candidates:
 *   role, domain, tools, workflow, quality-gates, protocol, anti-patterns
 */
function deriveDispatchProfile(packet) {
  const segments = new Set();
  const { kind, guard, audit_checks, references, read_only_snapshots, dependents, invariants } =
    packet;

  // role — always present: every task needs a competence framing.
  segments.add("role");

  // domain — references or read-only snapshots establish a domain to operate in.
  if ((references && references.length) || (read_only_snapshots && read_only_snapshots.length)) {
    segments.add("domain");
  }

  // tools — any guard or audit command invokes tools.
  const guardCmd = guard && guard.command ? guard.command : "";
  if (guardCmd || (audit_checks && audit_checks.length)) {
    segments.add("tools");
  }

  // workflow — a work state has a procedure/delta to execute.
  if (kind === "work" || (packet.delta && packet.delta.trim())) {
    segments.add("workflow");
  }

  // quality-gates — guard + audit_checks + acceptance_criteria are the gates.
  if (guardCmd || (audit_checks && audit_checks.length) || (packet.acceptance_criteria && packet.acceptance_criteria.length)) {
    segments.add("quality-gates");
  }

  // protocol — transition + reserved-file boundaries are always emitted.
  segments.add("protocol");

  // anti-patterns — dependents (what not to break) or invariants (what must hold).
  if ((dependents && dependents.length) || (invariants && invariants.length)) {
    segments.add("anti-patterns");
  }

  // task_type — a coarse label from kind + dominant signal.
  let task_type = kind || "work";
  if (kind === "audit") task_type = "audit";
  else if (kind === "review") task_type = "review";
  else if (guardCmd && /grep|ast|import/.test(guardCmd)) task_type = "code-mutation";
  else task_type = "implementation";

  // Stable ordering matching the spec's canonical segment list.
  const ORDER = ["role", "domain", "tools", "workflow", "quality-gates", "protocol", "anti-patterns"];
  const required_segments = ORDER.filter((s) => segments.has(s));

  return { task_type, required_segments, confidence: "heuristic-v1" };
}

// ── core compile ──

function compile(planDir, slug) {
  const cwd = planDir;
  const planName = path.basename(path.resolve(planDir));

  const dag = readJsonOrNull(path.join(planDir, "dag.json")) || {};
  const stateFile = readJsonOrNull(path.join(planDir, "state.json")) || {};
  const refsJson = readJsonOrNull(path.join(planDir, "references.json")); // optional

  const nodes = (dag.nodes && typeof dag.nodes === "object" && dag.nodes) || {};
  const node = nodes[slug];
  if (!node) return { error: `slug "${slug}" not found in dag.json.nodes` };

  const statesRaw = (stateFile.states && typeof stateFile.states === "object" && stateFile.states) || {};
  const stateEntry = normalizeStateEntry(statesRaw[slug] || {});
  // start_ref is recorded by state-transition.js --start; absent on old plans.
  const startRef = statesRaw[slug] ? statesRaw[slug].start_ref || null : null;
  const degraded = !startRef;

  const ctxRel = node.context ? String(node.context) : `contexts/${slug}.md`;
  const contextMd = readFileOrNull(path.join(planDir, ctxRel));
  const sharedMd = readFileOrNull(path.join(planDir, "contexts", "_shared.md"));

  // identity
  const identity = {
    plan: planName,
    slug,
    kind: node.kind || null,
    phase: node.phase || null,
  };

  // goal + delta (from the context's distillation / Goal section)
  const goal = collapseWs(sectionBody(contextMd, "Goal")) || "";
  const delta = distillationField(contextMd, "Delta Spec") || "";

  // acceptance criteria — only THIS slug's [slug.N] clauses (spec §2)
  const allCriteria = parseAcceptanceCriteria(contextMd);
  const acceptance_criteria = allCriteria
    .filter((c) => c.id.startsWith(slug + "."))
    .map((c) => ({ id: c.id, text: c.text, check: null /* filled below from audit */ }));

  // reserved (mutate) files — this state's disjoint write set (spec §2)
  const mutates = parseReservationKey(contextMd, "mutates");
  const dagArtifacts = Array.isArray(node.artifacts) ? node.artifacts.map(normPath) : [];
  // Union of context mutates + dag artifacts, deduped — the authoritative set.
  const reserved_files = [...new Set([...mutates, ...dagArtifacts])];

  // references — inline only the [ref:X] cited entries (spec §2)
  const cited = parseRefCitations(contextMd);
  const references = resolveReferences(refsJson, cited);

  // read-only snapshots — git show <start_ref>:<path> per file (spec §2/§7)
  const roFiles = parseReservationKey(contextMd, "read_only");
  const read_only_snapshots = roFiles.map((p) => ({
    path: p,
    at_ref: startRef || null,
    content: degraded ? null : gitShow(cwd, startRef, p),
    pointer: `git show ${startRef || "<start_ref>"}:${p}`,
  }));

  // invariants — lean shared core + state-specific (spec §2)
  const invariants = [...parseSharedInvariants(sharedMd), ...parseStateInvariants(contextMd)];

  // guard — single literal, tool-pinned (spec §2; we never re-arm it)
  const guard = node.guard ? { command: String(node.guard), expect_exit: 0 } : null;

  // audit_checks — extract only the [slug.N] checks from audit_*.py (spec §2)
  const audit_checks = [];
  const scriptsDir = path.join(planDir, "scripts");
  let auditTexts = [];
  if (fs.existsSync(scriptsDir)) {
    for (const f of fs.readdirSync(scriptsDir)) {
      if (!/^audit.*\.(py|js)$/.test(f)) continue;
      const txt = readFileOrNull(path.join(scriptsDir, f));
      if (txt !== null) auditTexts.push(txt);
    }
  }
  // For each owned acceptance criterion, find its matching check command.
  for (const c of acceptance_criteria) {
    let cmd = null;
    for (const txt of auditTexts) {
      cmd = extractAuditCommand(txt, c.id);
      if (cmd !== null) break;
    }
    if (cmd !== null) {
      audit_checks.push({ id: c.id, command: cmd });
      c.check = cmd;
    }
  }
  // Also pick up any [slug.N] audit IDs present in the script but not in the
  // context (defensive — keep the executor's view complete).
  for (const txt of auditTexts) {
    for (const id of collectCriterionIds(txt)) {
      if (!id.startsWith(slug + ".")) continue;
      if (audit_checks.some((a) => a.id === id)) continue;
      const cmd = extractAuditCommand(txt, id);
      if (cmd !== null) audit_checks.push({ id, command: cmd });
    }
  }

  // dependents — gitnexus blast radius over mutated symbols/files (spec §2/§9)
  // Best-effort; degrades to [] when gitnexus unavailable. Derived from the
  // state's declared `changes` symbols, falling back to reserved file paths.
  const changeTargets = [];
  const ch = node.changes && typeof node.changes === "object" ? node.changes : null;
  if (ch) {
    for (const s of Array.isArray(ch.deletes) ? ch.deletes : []) changeTargets.push(s);
    for (const s of Array.isArray(ch.resigns) ? ch.resigns : []) changeTargets.push(s);
    for (const r of Array.isArray(ch.renames) ? ch.renames : []) if (r && r.from) changeTargets.push(r.from);
  }
  const dependents = changeTargets.length ? gitnexusDependents(cwd, changeTargets) : [];

  // transition — exact state-transition.js commands (spec §2/§4)
  const transition = {
    start: `node scripts/state-transition.js ${planDir} ${slug} --start`,
    complete: `node scripts/state-transition.js ${planDir} ${slug} --complete --note '<...>'`,
  };

  const packet = {
    schema_version: SCHEMA_VERSION,
    ...identity,
    goal,
    delta,
    acceptance_criteria,
    reserved_files,
    references,
    read_only_snapshots,
    invariants,
    guard,
    audit_checks,
    dependents,
    transition,
    dispatch_profile: null, // filled next
    degraded,
  };

  packet.dispatch_profile = deriveDispatchProfile(packet);

  return { packet, contextMd, ctxRel, refsJson };
}

// ── exclusion measurement (spec §8) ──

/**
 * The goal-2 instrument: work_order_bytes vs. the Layer-1 inputs the executor
 * would otherwise read (dag.json + README + ALL sibling contexts + the full
 * audit scripts). reduction_ratio = 1 - work_order/excluded.
 */
function computeStats(planDir, workOrderBytes) {
  let excluded = 0;
  const add = (f) => {
    const t = readFileOrNull(f);
    if (t !== null) excluded += byteLen(t);
  };
  add(path.join(planDir, "dag.json"));
  add(path.join(planDir, "README.md"));
  const contextsDir = path.join(planDir, "contexts");
  if (fs.existsSync(contextsDir)) {
    for (const f of fs.readdirSync(contextsDir)) {
      if (f.endsWith(".md")) add(path.join(contextsDir, f));
    }
  }
  const scriptsDir = path.join(planDir, "scripts");
  if (fs.existsSync(scriptsDir)) {
    for (const f of fs.readdirSync(scriptsDir)) {
      if (/^audit.*\.(py|js)$/.test(f)) add(path.join(scriptsDir, f));
    }
  }
  const reduction_ratio = excluded > 0 ? Number((1 - workOrderBytes / excluded).toFixed(4)) : 0;
  return { work_order_bytes: workOrderBytes, excluded_bytes: excluded, reduction_ratio };
}

// ── renderers (spec §6: same content, two renderings) ──

function renderJson(packet) {
  return JSON.stringify(packet, null, 2) + "\n";
}

function renderMd(packet) {
  const L = [];
  const degradedTag = packet.degraded ? " (degraded)" : "";
  L.push(`# Work order — ${packet.plan} · ${packet.slug}${degradedTag}`);
  L.push("");
  L.push(`**Kind:** ${packet.kind || "?"} · **Phase:** ${packet.phase || "?"}`);
  L.push("");

  L.push("## Goal");
  L.push("");
  L.push(packet.goal || "_(none recorded)_");
  L.push("");

  if (packet.delta) {
    L.push("## Delta");
    L.push("");
    L.push(packet.delta);
    L.push("");
  }

  L.push("## Acceptance criteria");
  L.push("");
  if (packet.acceptance_criteria.length === 0) {
    L.push("_(none)_");
  } else {
    for (const c of packet.acceptance_criteria) {
      L.push(`- **[${c.id}]** ${c.text}`);
      if (c.check) L.push(`  - check: \`${c.check}\``);
    }
  }
  L.push("");

  L.push("## Reserved files (this state only)");
  L.push("");
  for (const f of packet.reserved_files) L.push(`- \`${f}\``);
  if (packet.reserved_files.length === 0) L.push("_(none)_");
  L.push("");

  if (packet.references.length) {
    L.push("## References");
    L.push("");
    for (const r of packet.references) {
      L.push(`- **[ref:${r.ref}]** ${r.title} — ${r.body} _(via ${r.discovered_via})_`);
    }
    L.push("");
  }

  if (packet.read_only_snapshots.length) {
    L.push("## Read-only snapshots");
    L.push("");
    for (const s of packet.read_only_snapshots) {
      L.push(`### \`${s.path}\` @ ${s.at_ref || "<unresolved>"}`);
      L.push("");
      if (s.content !== null && s.content !== undefined) {
        L.push("```");
        L.push(s.content);
        L.push("```");
      } else {
        L.push(`_(not snapshotted — resolve with \`${s.pointer}\`)_`);
      }
      L.push("");
    }
  }

  if (packet.invariants.length) {
    L.push("## Invariants");
    L.push("");
    for (const inv of packet.invariants) L.push(`- ${inv}`);
    L.push("");
  }

  L.push("## Guard");
  L.push("");
  if (packet.guard) {
    L.push(`\`\`\`\n${packet.guard.command}\n\`\`\``);
    L.push(`Expect exit ${packet.guard.expect_exit}.`);
  } else {
    L.push("_(no guard declared)_");
  }
  L.push("");

  if (packet.audit_checks.length) {
    L.push("## Audit checks");
    L.push("");
    for (const a of packet.audit_checks) {
      L.push(`- **[${a.id}]** \`${a.command}\``);
    }
    L.push("");
  }

  if (packet.dependents.length) {
    L.push("## Dependents (blast radius — do not break)");
    L.push("");
    for (const d of packet.dependents) L.push(`- \`${d}\``);
    L.push("");
  }

  L.push("## Transition");
  L.push("");
  L.push("```");
  L.push(packet.transition.start);
  L.push(packet.transition.complete);
  L.push("```");
  L.push("");

  L.push("## Dispatch profile");
  L.push("");
  L.push(`- task_type: \`${packet.dispatch_profile.task_type}\``);
  L.push(`- required_segments: ${packet.dispatch_profile.required_segments.join(", ")}`);
  L.push(`- confidence: \`${packet.dispatch_profile.confidence}\``);
  L.push("");

  return L.join("\n");
}

// ── argv ──

function parseArgs(argv) {
  const args = argv.slice(2);
  const positionals = [];
  let format = "md";
  let stats = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--format") {
      format = args[++i];
    } else if (a === "--stats") {
      stats = true;
    } else if (a.startsWith("--")) {
      // unknown flag — ignore (forward-compatible)
    } else {
      positionals.push(a);
    }
  }
  return { planDir: positionals[0], slug: positionals[1], format, stats };
}

function main() {
  const { planDir, slug, format, stats } = parseArgs(process.argv);

  if (!planDir || !slug) {
    process.stderr.write(
      "usage: node compile-task.js <plan-dir> <slug> [--format md|json] [--stats]\n",
    );
    process.exit(2);
  }
  if (!fs.existsSync(planDir) || !fs.statSync(planDir).isDirectory()) {
    process.stderr.write(`error: not a directory: ${planDir}\n`);
    process.exit(2);
  }
  if (format !== "md" && format !== "json") {
    process.stderr.write(`error: --format must be md|json, got "${format}"\n`);
    process.exit(2);
  }

  const result = compile(planDir, slug);
  if (result.error) {
    process.stderr.write(`error: ${result.error}\n`);
    process.exit(2);
  }

  const rendered = format === "json" ? renderJson(result.packet) : renderMd(result.packet);

  if (stats) {
    const s = computeStats(planDir, byteLen(rendered));
    process.stdout.write(JSON.stringify(s) + "\n");
    process.exit(0);
  }

  process.stdout.write(rendered);
  if (format === "md" && !rendered.endsWith("\n")) process.stdout.write("\n");
  process.exit(0);
}

// Allow import for tests without executing main(); run only as a CLI.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

export { compile, computeStats, deriveDispatchProfile, renderJson, renderMd };
