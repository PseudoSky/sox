#!/usr/bin/env node
/**
 * consistency-check.js — authoring-consistency seam gate (S4).
 *
 * Phase 5 of the plan-state-machine evolution plan
 * (docs/experiments/plan-state-machine-evolution-plan.md, "authoring-consistency gate").
 *
 * gap-check.js verifies STRUCTURE (IDs/files present). It does NOT verify that
 * the separated artifacts AGREE — the S4 failure class: a plan passes gap-check
 * green yet is internally inconsistent and blows up at review/execution. This
 * gate closes the mechanizable seams gap-check leaves open and emits a
 * `consistency_check_fail` event (Layer 3a) for each catch, so authoring
 * inconsistency moves from un-instrumented architectural review to a measured
 * gate.
 *
 * Seams checked:
 *   C1 (failure) — CITATION RESOLUTION. Every [def:X]/[inv:X]/[shape:X]/[fix:X]
 *      token cited in a context file must be DEFINED in contexts/_shared.md, and
 *      every [ref:X] must be a key in references.json. A cited-but-undefined
 *      token is a seam break (the context and the shared catalog disagree).
 *   C2 (warning) — DEAD DEFINITIONS. A [def:X]/[inv:X]/[shape:X]/[fix:X] defined
 *      in _shared.md that no context cites is drift (left behind after a context
 *      changed). Warning, not a hard block.
 *
 * Usage:
 *   node scripts/consistency-check.js <plan-dir> [--json] [--no-emit]
 *
 * Exit code = number of C1 failures (0 = consistent). Node stdlib only.
 */

import fs from "node:fs";
import path from "node:path";

import { emitEvent } from "./lib/emit-event.js";

const TOKEN_RE = /\[(def|inv|shape|fix|ref):([A-Za-z0-9_.\-]+)\]/g;

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

/** Collect {type, name} tokens from text. */
function collectTokens(text) {
  const out = [];
  if (!text) return out;
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) out.push({ type: m[1], name: m[2], token: `[${m[1]}:${m[2]}]` });
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const noEmit = args.includes("--no-emit");
  const planDir = args.find((a) => !a.startsWith("--"));

  if (!planDir) {
    process.stderr.write("usage: consistency-check.js <plan-dir> [--json] [--no-emit]\n");
    process.exit(2);
  }

  const contextsDir = path.join(planDir, "contexts");
  const sharedText = readFileOrNull(path.join(contextsDir, "_shared.md")) || "";
  const refs = readJsonOrNull(path.join(planDir, "references.json")) || {};
  const refKeys = new Set(Object.keys(refs).filter((k) => !["schema_version", "refs", "version"].includes(k)));

  // Defined tokens: any def/inv/shape/fix token that appears in _shared.md.
  const definedTokens = new Set(
    collectTokens(sharedText)
      .filter((t) => t.type !== "ref")
      .map((t) => t.token),
  );

  // Walk context files (exclude _shared.md).
  let contextFiles = [];
  try {
    contextFiles = fs
      .readdirSync(contextsDir)
      .filter((f) => f.endsWith(".md") && f !== "_shared.md");
  } catch {}

  const failures = []; // C1
  const citedTokens = new Set();

  for (const file of contextFiles) {
    const slug = file.replace(/\.md$/, "");
    const text = readFileOrNull(path.join(contextsDir, file)) || "";
    for (const t of collectTokens(text)) {
      citedTokens.add(t.token);
      let resolved;
      if (t.type === "ref") resolved = refKeys.has(t.name);
      else resolved = definedTokens.has(t.token);
      if (!resolved) {
        failures.push({
          slug,
          file: `contexts/${file}`,
          token: t.token,
          kind: t.type === "ref" ? "ref-not-in-references-json" : "definition-not-in-shared-md",
        });
      }
    }
  }

  // C2: dead definitions — defined in _shared.md, cited by no context.
  const deadDefs = [...definedTokens].filter((tok) => !citedTokens.has(tok));

  // Emit events (unless suppressed).
  if (!noEmit) {
    for (const f of failures) {
      emitEvent(planDir, {
        slug: f.slug,
        lifecycle: "authoring",
        event_type: "consistency_check_fail",
        outcome: "failure",
        detail: { seam: "citation-resolution", token: f.token, file: f.file, kind: f.kind },
      });
    }
    for (const tok of deadDefs) {
      emitEvent(planDir, {
        lifecycle: "authoring",
        event_type: "consistency_check_fail",
        outcome: "warning",
        detail: { seam: "dead-definition", token: tok, file: "contexts/_shared.md" },
      });
    }
  }

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify({ plan: path.basename(path.resolve(planDir)), failures, dead_definitions: deadDefs }, null, 2)}\n`,
    );
  } else {
    for (const f of failures) {
      process.stdout.write(`FAIL ${f.file}: cited ${f.token} is not defined (${f.kind})\n`);
    }
    for (const tok of deadDefs) {
      process.stdout.write(`WARN contexts/_shared.md: ${tok} defined but cited by no context\n`);
    }
    if (failures.length === 0) {
      process.stdout.write(
        `consistency-check: OK — all citations resolve${deadDefs.length ? ` (${deadDefs.length} dead-definition warning(s))` : ""}.\n`,
      );
    } else {
      process.stdout.write(`\nconsistency-check: ${failures.length} seam failure(s).\n`);
    }
  }

  process.exit(failures.length);
}

main();
