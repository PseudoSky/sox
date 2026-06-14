#!/usr/bin/env node
/**
 * gen-audit-stubs.js — codegen audit-check stubs from acceptance criteria (S4).
 *
 * Phase 5 of the plan-state-machine evolution plan. Closes the criteria ↔ audit
 * seam mechanically: every acceptance criterion `[slug.N]` declared in a context
 * file must be proven by a `check("slug.N", ...)` in an audit script (gap-check
 * Check 3). This generator finds criteria with NO matching audit check and emits
 * ready-to-paste `check(...)` stubs, so authoring the audit never lags the
 * criteria — the inconsistency class S4 surfaced.
 *
 * Usage:
 *   node scripts/gen-audit-stubs.js <plan-dir> [--phase <phase>] [--json]
 *
 * Prints stubs to stdout (does not modify audit scripts — paste in deliberately).
 * Exit code = number of criteria still missing a check (0 = fully covered).
 * Node stdlib only.
 */

import fs from "node:fs";
import path from "node:path";

function readFileOrNull(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
function readJsonOrNull(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** All [slug.N] criterion IDs in text. */
function collectCriterionIds(text) {
  const ids = new Set();
  const re = /\[([a-z0-9-]+\.[A-Za-z0-9_-]+)\]/g;
  let m;
  while ((m = re.exec(text)) !== null) ids.add(m[1]);
  return ids;
}
/** check("id", ...) and bare [id] audit IDs in audit script text. */
function collectAuditIds(text) {
  const ids = new Set();
  const re = /check\(\s*["']([A-Za-z0-9_.-]+)["']/g;
  let m;
  while ((m = re.exec(text)) !== null) ids.add(m[1]);
  for (const id of collectCriterionIds(text)) ids.add(id);
  return ids;
}

/** Extract the human text following a criterion ID on its line, for the stub comment. */
function criterionText(md, id) {
  const line = md.split("\n").find((l) => l.includes(`[${id}]`));
  if (!line) return "";
  return line
    .replace(/.*\[[a-z0-9-]+\.[A-Za-z0-9_-]+\]\**/i, "")
    .replace(/[`*]/g, "")
    .trim()
    .slice(0, 80);
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const pi = args.indexOf("--phase");
  const phaseFilter = pi >= 0 ? args[pi + 1] : null;
  const planDir = args.find((a) => !a.startsWith("--") && a !== phaseFilter);

  if (!planDir) {
    process.stderr.write("usage: gen-audit-stubs.js <plan-dir> [--phase <phase>] [--json]\n");
    process.exit(2);
  }

  const dag = readJsonOrNull(path.join(planDir, "dag.json")) || {};
  const nodes = (dag.nodes && typeof dag.nodes === "object" && dag.nodes) || {};
  const contextsDir = path.join(planDir, "contexts");
  const scriptsDir = path.join(planDir, "scripts");

  // Existing audit IDs across all audit scripts.
  const auditIds = new Set();
  try {
    for (const f of fs.readdirSync(scriptsDir)) {
      if (!/^audit.*\.(py|js)$/.test(f)) continue;
      for (const id of collectAuditIds(readFileOrNull(path.join(scriptsDir, f)) || "")) auditIds.add(id);
    }
  } catch {}

  // Criteria per slug, filtered to this state's own [slug.N] IDs.
  const missing = []; // {id, slug, phase, text}
  try {
    for (const f of fs.readdirSync(contextsDir)) {
      if (!f.endsWith(".md") || f === "_shared.md") continue;
      const slug = f.replace(/\.md$/, "");
      const node = nodes[slug] || {};
      if (phaseFilter && node.phase !== phaseFilter) continue;
      const md = readFileOrNull(path.join(contextsDir, f)) || "";
      for (const id of collectCriterionIds(md)) {
        if (!id.startsWith(`${slug}.`)) continue;
        if (!auditIds.has(id)) {
          missing.push({ id, slug, phase: node.phase ?? null, text: criterionText(md, id) });
        }
      }
    }
  } catch {}

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ plan: path.basename(path.resolve(planDir)), missing }, null, 2)}\n`);
  } else if (missing.length === 0) {
    process.stdout.write("gen-audit-stubs: every criterion already has a matching audit check.\n");
  } else {
    // Group stubs by phase for paste-in.
    const byPhase = new Map();
    for (const c of missing) {
      const key = c.phase || "unphased";
      if (!byPhase.has(key)) byPhase.set(key, []);
      byPhase.get(key).push(c);
    }
    process.stdout.write(`# ${missing.length} criterion(s) lack an audit check — paste these stubs:\n\n`);
    for (const [phase, items] of byPhase) {
      process.stdout.write(`def phase_${String(phase).replace(/[^a-z0-9_]/gi, "_")}():\n`);
      for (const c of items) {
        const cmd = "<deterministic command — exits 0 iff the criterion holds>";
        process.stdout.write(`    check(${JSON.stringify(c.id)}, ${JSON.stringify(c.text || c.id)}, ${JSON.stringify(cmd)})\n`);
      }
      process.stdout.write("\n");
    }
  }

  process.exit(missing.length);
}

main();
