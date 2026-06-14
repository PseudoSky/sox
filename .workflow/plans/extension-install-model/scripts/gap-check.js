#!/usr/bin/env node
/**
 * gap-check.js — deterministic gap review for a state-machine plan directory.
 *
 * Validates the mechanical checks of Step 6 (deep gap review) so an author
 * never ships a plan with a machine-detectable hole. Node standard library
 * only — no npm dependencies.
 *
 * Usage:
 *   node scripts/gap-check.js <plan-dir> [--discover]
 *
 * <plan-dir> is a directory laid out per the plan-state-machine skill:
 *   <plan-dir>/README.md              (Definition of Done lives here)
 *   <plan-dir>/dag.json
 *   <plan-dir>/state.json
 *   <plan-dir>/references.json        (optional)
 *   <plan-dir>/final-review.md        (filled Step-7 checklist)
 *   <plan-dir>/contexts/<slug>.md
 *   <plan-dir>/scripts/audit_*.py     (audit scripts)
 *
 * Checks (each independent; all run, all reported):
 *   1. slug-set identity   — keys(dag.nodes) === keys(state.states)
 *   2. artifacts ↔ mutates — each node's artifacts === the mutates set parsed
 *                            from that node's context file (warning, not failure,
 *                            when the context Reservations block is unparseable)
 *   3. criterion/audit IDs — every [<slug>.<n>] criterion in a context file has a
 *                            matching check ID in some audit script
 *   4. dependency integrity— every depends_on resolves to a real slug; graph acyclic
 *   5. null gaps           — any required field null/empty in dag.json, state.json,
 *                            or references.json is a blocking gap
 *   6. references shape    — references.json must be a FLAT slug-keyed object;
 *                            a wrapper key (schema_version/refs/version) is rejected
 *   7. reference ↔ audit   — every reference declares an audit_check whose ID exists
 *                            in some audit script (no idiom ships unverified)
 *   8. Definition of Done  — README has a `## Definition of Done` with [dod.N] clauses,
 *                            and every [dod.N] is proven by a final-audit check
 *   9. final-review gate   — final-review.md exists with no unticked boxes
 *  10. discovery (opt-in,  — with --discover, every symbol in a node's `changes` block
 *      --discover)           is re-grepped (+ GitNexus when fresh) and each caller
 *                            location must be accounted for in mutates/read_only
 *
 * Exit code 0 when clean (warnings allowed). Non-zero = number of failures.
 * Each failure line names the offending file and what is wrong.
 *
 * NOTE: this script verifies MECHANICAL gaps only. The judgment review
 * (references/gap-review.md) and — unless --discover ran clean — the Step-0
 * caller mapping are NOT discharged by a green exit here.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const failures = [];
const warnings = [];

function fail(file, msg) {
  failures.push(`FAIL ${file}: ${msg}`);
}
function warn(file, msg) {
  warnings.push(`WARN ${file}: ${msg}`);
}

function isEmpty(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}

function readJsonOrNull(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    fail(file, `not valid JSON: ${e.message}`);
    return undefined; // distinguishes "present but broken" from "absent"
  }
}

/**
 * Parse the `mutates:` array out of a context markdown's Reservations block.
 * Returns { ok: true, mutates: [...] } or { ok: false } when the block is not
 * machine-parseable. The block shape (per work-state.template.md):
 *
 *   ```text
 *   read_only:  ["a", "b"]
 *   mutates:    ["c",
 *                "d"]
 *   ```
 */
function parseMutates(mdText) {
  // Grab the fenced block immediately after a `## Reservations` heading.
  const resHeading = mdText.search(/^##\s+Reservations\s*$/m);
  if (resHeading === -1) return { ok: false };
  const after = mdText.slice(resHeading);
  const fence = after.match(/```[a-z]*\n([\s\S]*?)```/);
  if (!fence) return { ok: false };
  const block = fence[1];

  // Find `mutates:` and capture everything up to the next top-level key
  // (read_only:, **Merge, or end of block).
  const mIdx = block.search(/(^|\n)\s*mutates\s*:/);
  if (mIdx === -1) return { ok: false };
  let tail = block.slice(mIdx).replace(/(^|\n)\s*mutates\s*:/, "");
  // Cut at the next recognised key so a following read_only: doesn't bleed in.
  const stop = tail.search(/\n\s*(read_only\s*:|\*\*)/);
  if (stop !== -1) tail = tail.slice(0, stop);

  // Extract quoted string literals — the file paths.
  const files = [];
  const re = /["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(tail)) !== null) files.push(m[1]);
  if (files.length === 0) {
    // mutates present but no quoted entries — could be an empty `[]`.
    if (/\[\s*\]/.test(tail)) return { ok: true, mutates: [] };
    return { ok: false };
  }
  return { ok: true, mutates: files };
}

/** Collect criterion IDs [<slug>.<token>] from arbitrary text. */
function collectCriterionIds(text) {
  const ids = new Set();
  const re = /\[([a-z0-9-]+\.[A-Za-z0-9_-]+)\]/g;
  let m;
  while ((m = re.exec(text)) !== null) ids.add(m[1]);
  return ids;
}

/** Collect check IDs referenced anywhere in audit script text. */
function collectAuditIds(text) {
  const ids = new Set();
  // check("slug.n", ...) or check('slug.n', ...)
  const reCall = /check\(\s*["']([A-Za-z0-9_.-]+)["']/g;
  let m;
  while ((m = reCall.exec(text)) !== null) ids.add(m[1]);
  // Bare [slug.n] tokens in comments/docstrings.
  for (const id of collectCriterionIds(text)) ids.add(id);
  return ids;
}

// ── Check 4 helper: cycle detection over a slug → depends_on adjacency. ──
function findCycle(adj) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  for (const k of adj.keys()) color.set(k, WHITE);
  const stack = [];

  function dfs(node) {
    color.set(node, GRAY);
    stack.push(node);
    for (const dep of adj.get(node) || []) {
      if (!adj.has(dep)) continue; // dangling edges handled separately
      if (color.get(dep) === GRAY) {
        const start = stack.indexOf(dep);
        return stack.slice(start).concat(dep);
      }
      if (color.get(dep) === WHITE) {
        const c = dfs(dep);
        if (c) return c;
      }
    }
    stack.pop();
    color.set(node, BLACK);
    return null;
  }

  for (const node of adj.keys()) {
    if (color.get(node) === WHITE) {
      const c = dfs(node);
      if (c) return c;
    }
  }
  return null;
}

/** Strip a leading "./" so grep/GitNexus paths compare equal to declared ones. */
function normPath(p) {
  return String(p).replace(/^\.\//, "").trim();
}

/**
 * Extract the quoted file list for a named key inside the `## Reservations`
 * fenced block (e.g. "read_only"). Returns an array, or null if not parseable.
 */
function parseReservationKey(mdText, key) {
  const resHeading = mdText.search(/^##\s+Reservations\s*$/m);
  if (resHeading === -1) return null;
  const after = mdText.slice(resHeading);
  const fence = after.match(/```[a-z]*\n([\s\S]*?)```/);
  if (!fence) return null;
  const block = fence[1];
  const kRe = new RegExp(`(^|\\n)\\s*${key}\\s*:`);
  const kIdx = block.search(kRe);
  if (kIdx === -1) return null;
  let tail = block.slice(kIdx).replace(kRe, "");
  const stop = tail.search(/\n\s*(read_only\s*:|mutates\s*:|\*\*)/);
  if (stop !== -1) tail = tail.slice(0, stop);
  const files = [];
  const re = /["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(tail)) !== null) files.push(m[1]);
  return files;
}

/** grep the codebase for a symbol; return the set of files that reference it. */
function grepSymbolFiles(symbol) {
  const dirs = ["src", "tests", "test", "scripts", "docs", "lib", "app"].filter((d) =>
    fs.existsSync(d)
  );
  if (dirs.length === 0) dirs.push(".");
  const files = new Set();
  try {
    const out = execSync(
      `grep -rlw ${JSON.stringify(symbol)} ${dirs
        .map((d) => JSON.stringify(d))
        .join(" ")} 2>/dev/null || true`,
      { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 }
    );
    for (const line of out.split("\n")) {
      const f = normPath(line);
      if (f) files.add(f);
    }
  } catch {
    /* grep exits 1 on no-match; neutralised by `|| true` */
  }
  return files;
}

/** Probe GitNexus availability + freshness via `npx gitnexus status`. */
function gitnexusStatus() {
  try {
    const out = execSync("npx gitnexus status 2>&1", {
      encoding: "utf-8",
      maxBuffer: 4 * 1024 * 1024,
    });
    const stale = /stale|out[- ]of[- ]date|re-?run.*analyze/i.test(out);
    return { available: true, fresh: !stale };
  } catch {
    return { available: false, fresh: false };
  }
}

/**
 * Best-effort GitNexus caller discovery: parse path-like tokens out of
 * `gitnexus context` output, keeping only those that exist on disk (defensive
 * against the exact output format, which is not contractually stable).
 */
function gitnexusCallerFiles(symbol) {
  const files = new Set();
  try {
    const out = execSync(`npx gitnexus context ${JSON.stringify(symbol)} 2>/dev/null || true`, {
      encoding: "utf-8",
      maxBuffer: 8 * 1024 * 1024,
    });
    const re = /([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)(?::\d+)?/g;
    let m;
    while ((m = re.exec(out)) !== null) {
      const p = normPath(m[1]);
      if (p.includes("/") && fs.existsSync(p)) files.add(p);
    }
  } catch {
    /* ignore — fall back to grep-only */
  }
  return files;
}

function main() {
  const args = process.argv.slice(2);
  const discover = args.includes("--discover");
  // --dag-only: shift-left pre-flight. Run only the structural checks (slug-set
  // identity, dependency integrity, null-gaps on dag.json/state.json) and skip
  // every check that needs context/audit/references files, so the DAG topology
  // can be validated before those files are authored. Additive; default off.
  const dagOnly = args.includes("--dag-only");
  const planDir = args.find((a) => !a.startsWith("--"));
  if (!planDir) {
    process.stderr.write("usage: node scripts/gap-check.js <plan-dir> [--discover] [--dag-only]\n");
    process.exit(2);
  }
  if (!fs.existsSync(planDir) || !fs.statSync(planDir).isDirectory()) {
    process.stderr.write(`error: not a directory: ${planDir}\n`);
    process.exit(2);
  }

  const dagPath = path.join(planDir, "dag.json");
  const statePath = path.join(planDir, "state.json");
  const refsPath = path.join(planDir, "references.json");
  const contextsDir = path.join(planDir, "contexts");
  const scriptsDir = path.join(planDir, "scripts");

  const dag = readJsonOrNull(dagPath);
  const state = readJsonOrNull(statePath);
  const refs = readJsonOrNull(refsPath); // null if absent (optional)

  if (dag === null) fail(dagPath, "missing — every plan must have a dag.json");
  if (state === null) fail(statePath, "missing — every plan must have a state.json");

  const dagOk = dag && typeof dag === "object";
  const stateOk = state && typeof state === "object";

  const nodes = dagOk && dag.nodes && typeof dag.nodes === "object" ? dag.nodes : {};
  const states = stateOk && state.states && typeof state.states === "object" ? state.states : {};
  const dagSlugs = Object.keys(nodes);
  const stateSlugs = Object.keys(states);

  // ── Check 1: slug-set identity ──
  if (dagOk && stateOk) {
    const inDagNotState = dagSlugs.filter((s) => !(s in states));
    const inStateNotDag = stateSlugs.filter((s) => !(s in nodes));
    for (const s of inDagNotState) {
      fail(statePath, `slug "${s}" is in dag.json.nodes but missing from state.json.states`);
    }
    for (const s of inStateNotDag) {
      fail(dagPath, `slug "${s}" is in state.json.states but missing from dag.json.nodes`);
    }
  }

  // ── Check 4: dependency integrity (dangling edges + acyclicity) ──
  if (dagOk) {
    const adj = new Map();
    for (const [slug, node] of Object.entries(nodes)) {
      const deps = Array.isArray(node && node.depends_on) ? node.depends_on : [];
      adj.set(slug, deps);
      for (const dep of deps) {
        if (!(dep in nodes)) {
          fail(dagPath, `node "${slug}" depends_on "${dep}" which is not a node in dag.json`);
        }
      }
    }
    const cycle = findCycle(adj);
    if (cycle) {
      fail(dagPath, `dependency cycle detected: ${cycle.join(" -> ")}`);
    }
  }

  // ── Pre-read context files + audit scripts ──
  const contextText = {}; // slug -> md text
  if (fs.existsSync(contextsDir)) {
    for (const f of fs.readdirSync(contextsDir)) {
      if (!f.endsWith(".md")) continue;
      const slug = f.replace(/\.md$/, "");
      contextText[slug] = fs.readFileSync(path.join(contextsDir, f), "utf-8");
    }
  }

  let auditIds = new Set();
  if (fs.existsSync(scriptsDir)) {
    for (const f of fs.readdirSync(scriptsDir)) {
      if (!/^audit.*\.(py|js)$/.test(f)) continue;
      const txt = fs.readFileSync(path.join(scriptsDir, f), "utf-8");
      for (const id of collectAuditIds(txt)) auditIds.add(id);
    }
  }

  // ── Check 2: artifacts ↔ mutates ──
  if (dagOk && !dagOnly) {
    for (const [slug, node] of Object.entries(nodes)) {
      const artifacts = Array.isArray(node && node.artifacts) ? node.artifacts : [];
      const ctxRel = node && node.context ? String(node.context) : `contexts/${slug}.md`;
      const ctxPath = path.join(planDir, ctxRel);
      if (!fs.existsSync(ctxPath)) {
        fail(dagPath, `node "${slug}" context "${ctxRel}" does not exist`);
        continue;
      }
      const md = fs.readFileSync(ctxPath, "utf-8");
      const parsed = parseMutates(md);
      if (!parsed.ok) {
        // Not machine-parseable: emit a warning and check the dag node internally.
        warn(ctxPath, `Reservations/mutates block not machine-parseable; verified dag node "${slug}" artifacts internally only`);
        if (artifacts.length === 0) {
          fail(dagPath, `node "${slug}" has empty artifacts and its context mutates set is unparseable — declare artifacts`);
        }
        continue;
      }
      const a = new Set(artifacts);
      const mset = new Set(parsed.mutates);
      const onlyArtifacts = [...a].filter((x) => !mset.has(x));
      const onlyMutates = [...mset].filter((x) => !a.has(x));
      for (const x of onlyArtifacts) {
        fail(dagPath, `node "${slug}" artifacts has "${x}" not in ${ctxRel} mutates`);
      }
      for (const x of onlyMutates) {
        fail(ctxPath, `mutates has "${x}" not in dag.json node "${slug}" artifacts`);
      }
    }
  }

  // ── Check 3: criterion/audit ID match ──
  if (!dagOnly)
    for (const [slug, md] of Object.entries(contextText)) {
    // Only criterion IDs whose prefix matches this state's slug are "owned" here.
    const ids = collectCriterionIds(md);
    for (const id of ids) {
      if (!id.startsWith(slug + ".")) continue; // foreign citations ignored
      if (!auditIds.has(id)) {
        fail(
          path.join(contextsDir, `${slug}.md`),
          `acceptance criterion [${id}] has no matching check ID in any audit script`
        );
      }
    }
  }

  // ── Check 5: null gaps in dag.json ──
  if (dagOk) {
    const REQ_NODE = ["kind", "phase", "depends_on", "guard", "artifacts", "context"];
    for (const [slug, node] of Object.entries(nodes)) {
      if (!node || typeof node !== "object") {
        fail(dagPath, `node "${slug}" is null/empty`);
        continue;
      }
      for (const field of REQ_NODE) {
        // depends_on / artifacts may be empty arrays legitimately ONLY for depends_on.
        if (field === "depends_on") {
          if (!Array.isArray(node[field])) fail(dagPath, `node "${slug}" field "depends_on" is null/missing (use [])`);
          continue;
        }
        if (isEmpty(node[field])) {
          fail(dagPath, `node "${slug}" required field "${field}" is null/empty`);
        }
      }
    }
  }

  // ── Check 5: null gaps in state.json ──
  if (stateOk) {
    if (isEmpty(state.current_state)) {
      fail(statePath, `required field "current_state" is null/empty`);
    } else if (stateOk && dagOk && !(state.current_state in nodes)) {
      fail(statePath, `current_state "${state.current_state}" is not a slug in dag.json.nodes`);
    }
    for (const [slug, st] of Object.entries(states)) {
      if (!st || typeof st !== "object") {
        fail(statePath, `state "${slug}" is null/empty`);
        continue;
      }
      if (isEmpty(st.status)) {
        fail(statePath, `state "${slug}" required field "status" is null/empty`);
      }
    }
  }

  // ── Check 5/6/7: references.json (optional file) ──
  if (!dagOnly && refs && typeof refs === "object") {
    // Check 6: must be a FLAT slug-keyed object — reject the wrapper shape.
    // A wrapper shows up two ways, neither of which a real reference entry can
    // look like (entries are objects with anchor/rule): a scalar-valued
    // top-level key (e.g. `schema_version: 2`), or a known object-valued
    // envelope key (`refs`/`nodes`/`states`). We do NOT hard-list slug-shaped
    // names like `version`/`title` — those are legitimate ref-slugs.
    const scalarKeys = Object.entries(refs)
      .filter(([, v]) => v === null || typeof v !== "object")
      .map(([k]) => k);
    const envelopeKeys = ["refs", "nodes", "states"].filter(
      (k) => k in refs && refs[k] && typeof refs[k] === "object"
    );
    const wrappers = [...scalarKeys, ...envelopeKeys];
    if (wrappers.length > 0) {
      fail(
        refsPath,
        `must be a FLAT slug-keyed object — found wrapper key(s) ${wrappers
          .map((w) => `"${w}"`)
          .join(", ")}. Unlike dag.json/state.json, references.json has NO ` +
          `schema_version and NO wrapper: each top-level key is a ref-slug ` +
          `whose value is the reference object.`
      );
    } else {
      for (const [refSlug, ref] of Object.entries(refs)) {
        if (!/^[a-z0-9-]+$/.test(refSlug)) {
          fail(refsPath, `reference slug "${refSlug}" does not match ^[a-z0-9-]+$`);
        }
        if (!ref || typeof ref !== "object") {
          fail(refsPath, `reference "${refSlug}" is null/empty`);
          continue;
        }
        // Check 5: required fields populated.
        for (const field of ["anchor", "rule", "discovered_via"]) {
          if (isEmpty(ref[field])) {
            fail(refsPath, `reference "${refSlug}" required field "${field}" is null/empty`);
          }
        }
        if (ref.discovered_via && !["gitnexus", "manual"].includes(ref.discovered_via)) {
          fail(refsPath, `reference "${refSlug}" discovered_via "${ref.discovered_via}" must be "gitnexus" or "manual"`);
        }
        // Check 7: every idiom is verified by a final-audit check.
        if (isEmpty(ref.audit_check)) {
          fail(refsPath, `reference "${refSlug}" has no audit_check — every idiom must be proven by a final-audit check (a null audit_check is a blocking gap)`);
        } else {
          const acId = String(ref.audit_check).replace(/^\[|\]$/g, "");
          if (!auditIds.has(acId)) {
            fail(refsPath, `reference "${refSlug}" audit_check "${ref.audit_check}" has no matching check ID in any audit script`);
          }
        }
      }
    }
  }

  // ── Check 8: Definition of Done present + every [dod.N] proven by an audit check ──
  const readmePath = path.join(planDir, "README.md");
  if (!dagOnly && !fs.existsSync(readmePath)) {
    fail(readmePath, "README.md missing — the plan needs a README with a `## Definition of Done` section (Step 1a)");
  } else if (!dagOnly) {
    const readme = fs.readFileSync(readmePath, "utf-8");
    if (!/^##\s+Definition of Done\s*$/m.test(readme)) {
      fail(readmePath, "no `## Definition of Done` section — Step 1a requires an agreed, IDed DoD before any work state");
    } else {
      const dodIds = [...collectCriterionIds(readme)].filter((id) => id.startsWith("dod."));
      if (dodIds.length === 0) {
        fail(readmePath, "`## Definition of Done` has no [dod.N] clauses — the DoD must enumerate IDed clauses");
      }
      for (const id of dodIds) {
        if (!auditIds.has(id)) {
          fail(readmePath, `Definition-of-Done clause [${id}] is not proven by any final-audit check — every [dod.N] must map to a check`);
        }
      }
    }
  }

  // ── Check 9: final-review gate (Step 7 checklist filled, no unticked boxes) ──
  const reviewPath = path.join(planDir, "final-review.md");
  if (!dagOnly && !fs.existsSync(reviewPath)) {
    fail(reviewPath, "final-review.md missing — copy references/final-review-checklist.md into the plan dir and tick every box (Step 7)");
  } else if (!dagOnly) {
    const review = fs.readFileSync(reviewPath, "utf-8");
    let unticked = 0;
    for (const ln of review.split("\n")) {
      if (/\[\s\]/.test(ln) && !/N\/A/i.test(ln)) unticked++;
    }
    if (unticked > 0) {
      fail(reviewPath, `${unticked} unchecked box(es) in final-review.md — every Step-7 item must be [x] or marked N/A before publish`);
    }
  }

  // ── Check 10: discovery completeness (opt-in via --discover) ──
  if (discover && dagOk && !dagOnly) {
    const accounted = new Set();
    for (const node of Object.values(nodes)) {
      for (const a of Array.isArray(node && node.artifacts) ? node.artifacts : []) {
        accounted.add(normPath(a));
      }
    }
    for (const md of Object.values(contextText)) {
      for (const f of parseReservationKey(md, "read_only") || []) accounted.add(normPath(f));
    }

    const gx = gitnexusStatus();
    let oracle = "grep";
    if (gx.available && gx.fresh) {
      oracle = "grep+gitnexus";
    } else if (gx.available && !gx.fresh) {
      warn(dagPath, "--discover: GitNexus index is STALE — caller discovery used grep only; run `npx gitnexus analyze` for graph-verified coverage");
    } else {
      warn(dagPath, "--discover: GitNexus unavailable — caller discovery used grep only (lower fidelity)");
    }

    let anyChanges = false;
    for (const [slug, node] of Object.entries(nodes)) {
      const ch = node && node.changes;
      if (!ch || typeof ch !== "object") continue;
      anyChanges = true;
      const syms = [];
      for (const s of Array.isArray(ch.deletes) ? ch.deletes : []) syms.push(s);
      for (const s of Array.isArray(ch.resigns) ? ch.resigns : []) syms.push(s);
      for (const r of Array.isArray(ch.renames) ? ch.renames : []) if (r && r.from) syms.push(r.from);
      for (const sym of syms) {
        const found = grepSymbolFiles(sym);
        if (oracle === "grep+gitnexus") for (const f of gitnexusCallerFiles(sym)) found.add(f);
        for (const f of [...found].filter((x) => !accounted.has(x))) {
          fail(dagPath, `--discover: symbol "${sym}" (changed in node "${slug}") is referenced in "${f}", which no state mutates or reserves read_only — Step-0 caller mapping is incomplete`);
        }
      }
    }
    if (!anyChanges) {
      warn(dagPath, "--discover requested but no node declares a `changes` block — declare changed symbols (deletes/resigns/renames) to enable discovery-completeness checking");
    }
    process.stdout.write(`gap-check: discovery oracle = ${oracle}\n`);
  }

  // ── Report ──
  for (const w of warnings) process.stdout.write(w + "\n");
  if (dagOnly) {
    process.stdout.write(
      "NOTE: --dag-only — ran structural checks only (slug-set identity, dependency integrity, null-gaps); content checks (artifacts/criteria/audit/references/DoD/final-review/discovery) were skipped. Re-run without --dag-only before publish.\n",
    );
  }
  const boundary = discover
    ? "NOTE: --discover ran (caller mapping checked against the declared `changes` set). The non-mechanical gap-review (references/gap-review.md) is the planner's own mandatory work; a green exit does not discharge it. FAIL lines above are hard blocks, not advisory warnings."
    : "NOTE: mechanical checks only — Step-0 caller mapping (re-run with --discover) and the non-mechanical gap-review (references/gap-review.md) are the planner's job, NOT verified here. FAIL lines above are hard blocks, not advisory warnings.";
  process.stdout.write(boundary + "\n");
  if (failures.length === 0) {
    process.stdout.write(`gap-check PASSED: ${planDir} (${warnings.length} warning(s))\n`);
    process.exit(0);
  }
  process.stdout.write(`\ngap-check FAILED: ${failures.length} gap(s) in ${planDir}\n`);
  for (const f of failures) process.stdout.write(f + "\n");
  process.exit(failures.length);
}

main();
