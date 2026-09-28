#!/usr/bin/env node
/**
 * tools/test-7ff58364-gate-reaches-typecheck-tests.mjs — Tier 1 (hermetic, config-parse only).
 *
 * Pins backlog 7ff58364 / 7dd7a974 / 062504ba: `typecheck` must always build its upstream
 * dependency graph first (`^build` in `dependsOn`), and — wherever a project also defines a
 * `typecheck-tests` target — `typecheck` must depend on `typecheck-tests` so a whole-repo
 * `nx run-many -t typecheck` sweep actually reaches the spec-inclusive check and cannot report
 * green while `typecheck-tests` never ran.
 *
 * Before the fix: `nx.json` had no `targetDefaults.typecheck`/`typecheck-tests` entry at all, so
 * `typecheck` ran with NO `dependsOn` for every project that didn't declare its own — an
 * `nx run-many -t typecheck --skip-nx-cache` on a dirty upstream `dist/` could typecheck against
 * stale compiled output. `libs/memory-core/project.json` additionally overrode the (absent)
 * default with `dependsOn: ["typecheck-tests"]` only — no `^build` — and
 * `extensions/bundles/sox-memory-bundle/members/memory-server/project.json` /
 * `libs/observability/sox-telemetry/project.json` had `typecheck-tests` targets that `typecheck`
 * never depended on at all, so a `typecheck` gate that only runs `-t typecheck` (not `-t
 * typecheck,typecheck-tests`) never reached the spec check for those two projects.
 *
 * Checks:
 *   (a) config-merge: for every project with a `typecheck` target, the EFFECTIVE `dependsOn`
 *       (project-level `targets.typecheck.dependsOn` if present, else `nx.json`
 *       `targetDefaults.typecheck.dependsOn`, else `[]` — nx's own override-not-merge semantics)
 *       contains `^build`; if the project also has a `typecheck-tests` target, the effective
 *       `dependsOn` also contains `typecheck-tests`.
 *   (b) task-graph: `nx run-many -t typecheck --graph=<tmpfile>.json` (real graph, only when the
 *       target CODE_ROOT is an invocable nx workspace) actually contains a `<p>:typecheck-tests`
 *       task for every project that defines one — the graph-level proof that (a)'s config isn't
 *       merely declared but is actually reached by the whole-repo sweep.
 *
 * Usage:
 *   node tools/test-7ff58364-gate-reaches-typecheck-tests.mjs                 # live repo, both (a) and (b)
 *   node tools/test-7ff58364-gate-reaches-typecheck-tests.mjs --code-root <dir>  # config-only red demo
 *   node tools/test-7ff58364-gate-reaches-typecheck-tests.mjs --skip-graph   # (a) only, even on live repo
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TOOLS_DIR, '..');

const crIdx = process.argv.indexOf('--code-root');
const CODE_ROOT = crIdx !== -1 ? path.resolve(process.argv[crIdx + 1]) : REPO_ROOT;
const SKIP_GRAPH = process.argv.includes('--skip-graph');
const IN_PLACE = CODE_ROOT === REPO_ROOT;

let failed = 0;
function report(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
}

console.log('7ff58364/7dd7a974/062504ba — gate must reach typecheck-tests');
console.log(`CODE_ROOT: ${CODE_ROOT}${IN_PLACE ? ' (in place)' : ' (red-demo copy)'}`);

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function findProjectJsonFiles(root) {
  const EXCLUDE_DIRS = new Set([
    'node_modules',
    'dist',
    '.git',
    '.nx',
    '.worktrees',
    '.claude',
    // Research transcript fixtures under docs/research/**/transcripts/** are line-numbered
    // prose captures, not real nx projects — their project.json files are not valid JSON.
    'transcripts',
  ]);
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name)) continue;
        stack.push(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name === 'project.json') {
        out.push(path.join(dir, entry.name));
      }
    }
  }
  return out;
}

// --- (a) config-merge check -------------------------------------------------------------------

let nxJson;
try {
  nxJson = readJson(path.join(CODE_ROOT, 'nx.json'));
} catch (err) {
  report('nx.json is readable JSON', false, String(err));
  console.log(failed === 0 ? 'ALL 7ff58364 ASSERTIONS PASS' : `${failed} 7ff58364 ASSERTION(S) FAILED`);
  process.exit(1);
}

const defaultTypecheckDependsOn = nxJson.targetDefaults?.typecheck?.dependsOn ?? null;

const projectFiles = findProjectJsonFiles(CODE_ROOT);
report('at least one project.json discovered under CODE_ROOT', projectFiles.length > 0, `${projectFiles.length} found`);

const projectsChecked = [];
for (const file of projectFiles) {
  let proj;
  try {
    proj = readJson(file);
  } catch (err) {
    report(`${path.relative(CODE_ROOT, file)} is readable JSON`, false, String(err));
    continue;
  }
  const targets = proj.targets ?? {};
  if (!('typecheck' in targets)) continue;

  const name = proj.name ?? path.relative(CODE_ROOT, path.dirname(file));
  const hasTypecheckTests = 'typecheck-tests' in targets;
  projectsChecked.push({ name, file, hasTypecheckTests });

  // nx's own semantics: a project-level dependsOn REPLACES the targetDefaults entry, it does not
  // merge with it. Only fall back to the default when the project declares no dependsOn at all.
  const ownDependsOn = targets.typecheck.dependsOn;
  const effectiveDependsOn = Array.isArray(ownDependsOn) ? ownDependsOn : defaultTypecheckDependsOn ?? [];

  report(
    `${name}: typecheck.dependsOn (effective) contains "^build"`,
    Array.isArray(effectiveDependsOn) && effectiveDependsOn.includes('^build'),
    JSON.stringify(effectiveDependsOn),
  );

  if (hasTypecheckTests) {
    report(
      `${name}: has typecheck-tests, so typecheck.dependsOn (effective) contains "typecheck-tests"`,
      Array.isArray(effectiveDependsOn) && effectiveDependsOn.includes('typecheck-tests'),
      JSON.stringify(effectiveDependsOn),
    );
  }
}

report('at least one project with a typecheck target was checked', projectsChecked.length > 0, `${projectsChecked.length} checked`);

// --- (b) task-graph check ----------------------------------------------------------------------

const projectsWithTypecheckTests = projectsChecked.filter((p) => p.hasTypecheckTests).map((p) => p.name);

function canInvokeNx(root) {
  return fs.existsSync(path.join(root, 'package.json')) && fs.existsSync(path.join(root, 'node_modules'));
}

if (SKIP_GRAPH) {
  console.log('  (skipped: --skip-graph)');
} else if (!canInvokeNx(CODE_ROOT)) {
  console.log(`  (skipped: ${CODE_ROOT} has no invocable nx workspace — node_modules absent; config-only proof used for red demo)`);
} else {
  const graphFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bl7ff58364-graph-')), 'graph.json');
  try {
    execFileSync(
      'npx',
      ['nx', 'run-many', '-t', 'typecheck', '--all', '--graph=' + graphFile],
      { cwd: CODE_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    // `--graph=<file>` writes the file and exits 0 without actually running tasks; a non-zero
    // exit here means graph construction itself failed, which is a real failure to report.
    report('nx run-many -t typecheck --all --graph=<file> succeeded', fs.existsSync(graphFile), String(err.message ?? err));
  }

  if (fs.existsSync(graphFile)) {
    const graph = readJson(graphFile);
    // The JSON produced by `--graph=` nests the real per-task map under `tasks.tasks` (the
    // top-level `tasks` key is the whole TaskGraph shape: roots/tasks/dependencies/...).
    const taskKeys = Object.keys(graph.tasks?.tasks ?? graph.tasks ?? graph.graph?.tasks ?? {});
    for (const name of projectsWithTypecheckTests) {
      const wantKey = `${name}:typecheck-tests`;
      report(
        `task graph for "nx run-many -t typecheck" includes ${wantKey}`,
        taskKeys.includes(wantKey),
        `graph has ${taskKeys.length} task(s)`,
      );
    }
    fs.rmSync(path.dirname(graphFile), { recursive: true, force: true });
  } else {
    report('nx task graph file was produced', false, graphFile);
  }
}

console.log('');
console.log(failed === 0 ? 'ALL 7ff58364 ASSERTIONS PASS' : `${failed} 7ff58364 ASSERTION(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
