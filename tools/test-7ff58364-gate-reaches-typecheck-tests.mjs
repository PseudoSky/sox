#!/usr/bin/env node
/**
 * tools/test-7ff58364-gate-reaches-typecheck-tests.mjs — Tier 1 (hermetic; config-merge proof
 * plus, where an invocable nx workspace is available, a real task-graph proof).
 *
 * Pins backlog 7ff58364 / 7dd7a974 / 062504ba / 3b752549 / da25489b: `typecheck` must always build
 * its upstream dependency graph first (`^build` in `dependsOn`), and — wherever a project also
 * defines a `typecheck-tests` target — `typecheck` must depend on `typecheck-tests` so a whole-repo
 * `nx run-many -t typecheck` sweep actually reaches the spec-inclusive check and cannot report
 * green while `typecheck-tests` never ran.
 *
 * da25489b layered the gate further into a three-target chain so a whole-repo sweep can no longer
 * report green while EITHER the spec check OR the production-only check silently never ran:
 *   `typecheck` (executor `nx:noop`, no command of its own)
 *     -> `typecheck-tests` (spec-inclusive tsc)
 *          -> `typecheck-src` (production-only tsc, what `typecheck`'s own command used to be)
 * `typecheck-src`'s own `dependsOn` must reach `^build` but must NOT depend on `typecheck-tests` or
 * `typecheck` — the dependency direction only ever runs downward through the chain above, never
 * back up it (a cycle would hang nx's task graph).
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
 * Checks, for every project that defines a `typecheck` target:
 *   config-merge (effective `dependsOn`/`executor` = project-level override if present, else
 *   `nx.json` `targetDefaults` entry, else `[]` — nx's own override-not-merge semantics):
 *     - effective `typecheck.dependsOn` contains `^build`
 *   ...and, wherever that project ALSO defines a `typecheck-tests` target:
 *     - effective `typecheck.dependsOn` contains `typecheck-tests`
 *     - A1: the project defines a `typecheck-src` target
 *     - A2: effective `typecheck-tests.dependsOn` contains `typecheck-src`
 *     - A3: effective `typecheck-src.dependsOn` contains `^build`, and contains neither
 *       `typecheck-tests` nor `typecheck` (no back-edge / no cycle)
 *     - A4: the project's own `typecheck.executor` is `"nx:noop"`
 *   ...and, for EVERY project that defines a `typecheck-src` target (independent of whether it also
 *   defines `typecheck-tests` — A7 is a config-shape check on typecheck-src alone):
 *     - A7: the tsconfig named by typecheck-src's own `-p <path>` command flag resolves (via
 *       TypeScript's own `parseJsonConfigFileContent`, extends chain included) to a file set
 *       containing no `.spec.ts`/`.test.ts` files — i.e. typecheck-src never compiles specs. Pins
 *       BL-565d6f8c: before the fix, `memory-server:typecheck-src` pointed straight at
 *       `tsconfig.json` (no exclude), so it type-checked every spec file under src alongside
 *       production code and folded spec-only errors into the production triage bucket.
 *   task-graph (real `nx run-many -t typecheck --graph=<file>`, only when the target CODE_ROOT is
 *   an invocable nx workspace — the graph-level proof that the config above isn't merely declared
 *   but is actually reached by the whole-repo sweep):
 *     - A5: the graph contains both `<p>:typecheck-src` and `<p>:typecheck-tests` tasks, and
 *       `graph.tasks.dependencies["<p>:typecheck-tests"]` includes `<p>:typecheck-src`
 *
 * A6 (resolver coverage): the effective-`dependsOn` resolver used above is generic over any of
 * `typecheck` / `typecheck-tests` / `typecheck-src` — not hardcoded to read only
 * `nx.json.targetDefaults.typecheck`. A resolver that only knew about `typecheck` would silently
 * report `[]` (vacuously passing "excludes typecheck-tests/typecheck") for `typecheck-src`'s
 * defaults even when `nx.json` genuinely sets them, which would make A3 unable to ever fail.
 * Proven structurally: `effectiveDependsOn()` below takes the target name as a parameter and is
 * exercised for all three targets, not a copy-pasted read of one nx.json path.
 *
 * Usage:
 *   node tools/test-7ff58364-gate-reaches-typecheck-tests.mjs                    # live repo, both proofs
 *   node tools/test-7ff58364-gate-reaches-typecheck-tests.mjs --code-root <dir>  # config-only red demo
 *   node tools/test-7ff58364-gate-reaches-typecheck-tests.mjs --skip-graph       # config-merge only, even on live repo
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

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

console.log('7ff58364/7dd7a974/062504ba/3b752549/da25489b — gate must reach typecheck-tests and typecheck-src');
console.log(`CODE_ROOT: ${CODE_ROOT}${IN_PLACE ? ' (in place)' : ' (red-demo copy)'}`);

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// --- project discovery -------------------------------------------------------------------------
//
// A6 (resolver coverage, discovery half — honest about when each path actually runs): discover
// every project via a SINGLE `nx graph --file=<tmp>.json` call rather than a hand-rolled
// filesystem walk with an ad-hoc exclusion list, or (ef033f92) the earlier `nx show projects
// --json` + N * `nx show project <p> --json` loop (1 + 2*68 = 137 subprocess spawns, ~42.6s on
// this repo). `nx graph`'s project-graph JSON carries the same fully-resolved
// `data.{root,targets}` per project as `nx show project` in one ~1s call. The fs-walk fallback
// (`discoverProjectsViaFilesystem`, with its own maintained `EXCLUDE_DIRS` — including a
// 'transcripts' entry for non-project `project.json`-shaped fixtures under docs/research/**) runs
// ONLY when `canInvokeNx(CODE_ROOT)` is false, i.e. ONLY on the `--code-root <dir>` red-demo path
// against a bare fixture copy with no `node_modules` — never on the live, in-place repo, and never
// merely because `--skip-graph` was passed (that flag only skips the separate task-graph proof
// below, A5; it has no effect on how projects are discovered in the first place).

function canInvokeNx(root) {
  return fs.existsSync(path.join(root, 'package.json')) && fs.existsSync(path.join(root, 'node_modules'));
}

// Single `nx graph --file=<tmp>.json` call feeds project discovery for every project at once —
// `graph.nodes[name].data.{root,targets}` carries the same fully-resolved target config as `nx
// show project <name> --json`, so this replaces what used to be 1 + 2*N `npx nx show ...`
// subprocess spawns (1 for `nx show projects`, 2 per project) with exactly one nx invocation.
// Measured on this repo (68 projects): ~42.6s (N+1 `nx show` calls) -> ~1s (single `nx graph`).
function discoverProjectsViaNx(root) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-ef033f92-graph-'));
  try {
    const graphFile = path.join(tmpDir, 'project-graph.json');
    execFileSync('npx', ['nx', 'graph', '--file=' + graphFile], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const graph = readJson(graphFile);
    const nodes = graph.graph?.nodes ?? {};
    const out = [];
    for (const [name, node] of Object.entries(nodes)) {
      const data = node?.data ?? {};
      const projectJsonPath = data.root ? path.join(root, data.root, 'project.json') : null;
      out.push({
        name,
        targets: data.targets ?? {},
        file: projectJsonPath && fs.existsSync(projectJsonPath) ? projectJsonPath : null,
      });
    }
    return out;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function discoverProjectsViaFilesystem(root) {
  const EXCLUDE_DIRS = new Set([
    'node_modules',
    'dist',
    '.git',
    '.nx',
    '.worktrees',
    '.claude',
    // Research transcript fixtures under docs/research/**/transcripts/** are line-numbered
    // prose captures, not real nx projects — their project.json files are not valid JSON. Only
    // reached on the filesystem-walk fallback (no invocable nx workspace to ask instead).
    'transcripts',
  ]);
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      console.error(`test-7ff58364: readdirSync(${dir}) failed, skipping: ${err.message ?? err}`);
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name)) continue;
        stack.push(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name === 'project.json') {
        files.push(path.join(dir, entry.name));
      }
    }
  }
  const out = [];
  for (const file of files) {
    let proj;
    try {
      proj = readJson(file);
    } catch (err) {
      report(`${path.relative(root, file)} is readable JSON`, false, String(err));
      continue;
    }
    out.push({ name: proj.name ?? path.relative(root, path.dirname(file)), targets: proj.targets ?? {}, file });
  }
  return out;
}

let nxJson;
try {
  nxJson = readJson(path.join(CODE_ROOT, 'nx.json'));
} catch (err) {
  report('nx.json is readable JSON', false, String(err));
  console.log(failed === 0 ? 'ALL 7ff58364 ASSERTIONS PASS' : `${failed} 7ff58364 ASSERTION(S) FAILED`);
  process.exit(1);
}

const targetDefaults = nxJson.targetDefaults ?? {};

// A6: generic over the target name — not a single hardcoded read of targetDefaults.typecheck.
// nx's own semantics: a project-level dependsOn REPLACES the targetDefaults entry, it does not
// merge with it. Only fall back to the default when the project declares no dependsOn at all.
function effectiveDependsOn(targetName, targets) {
  const own = targets[targetName]?.dependsOn;
  if (Array.isArray(own)) return own;
  const def = targetDefaults[targetName]?.dependsOn;
  return Array.isArray(def) ? def : [];
}

// Discovery independent of --skip-graph: even a config-only run benefits from asking nx directly
// when it's available, so use it whenever CODE_ROOT is invocable, and only fall back to the
// filesystem walk (red-demo fixtures) when it is not.
const canAskNx = canInvokeNx(CODE_ROOT);
let allProjects;
if (canAskNx) {
  try {
    allProjects = discoverProjectsViaNx(CODE_ROOT);
  } catch (err) {
    report('nx graph --file=<tmp>.json succeeded', false, String(err.message ?? err));
    allProjects = discoverProjectsViaFilesystem(CODE_ROOT);
  }
} else {
  allProjects = discoverProjectsViaFilesystem(CODE_ROOT);
}

report('at least one project discovered under CODE_ROOT', allProjects.length > 0, `${allProjects.length} found`);

const projectsChecked = [];
for (const { name, targets } of allProjects) {
  if (!('typecheck' in targets)) continue;

  const hasTypecheckTests = 'typecheck-tests' in targets;
  const hasTypecheckSrc = 'typecheck-src' in targets;
  projectsChecked.push({ name, hasTypecheckTests, hasTypecheckSrc });

  const typecheckDependsOn = effectiveDependsOn('typecheck', targets);
  report(
    `${name}: typecheck.dependsOn (effective) contains "^build"`,
    typecheckDependsOn.includes('^build'),
    JSON.stringify(typecheckDependsOn),
  );

  if (hasTypecheckTests) {
    report(
      `${name}: has typecheck-tests, so typecheck.dependsOn (effective) contains "typecheck-tests"`,
      typecheckDependsOn.includes('typecheck-tests'),
      JSON.stringify(typecheckDependsOn),
    );

    // A1
    report(`${name}: A1 — defines typecheck-src`, hasTypecheckSrc, hasTypecheckSrc ? 'present' : 'missing');

    // A2
    const typecheckTestsDependsOn = effectiveDependsOn('typecheck-tests', targets);
    report(
      `${name}: A2 — typecheck-tests.dependsOn (effective) contains "typecheck-src"`,
      typecheckTestsDependsOn.includes('typecheck-src'),
      JSON.stringify(typecheckTestsDependsOn),
    );

    // A3 — only meaningful if typecheck-src actually exists; otherwise A1 already failed and this
    // would just be reporting on an absent target's (vacuous []) defaults.
    if (hasTypecheckSrc) {
      const typecheckSrcDependsOn = effectiveDependsOn('typecheck-src', targets);
      report(
        `${name}: A3 — typecheck-src.dependsOn (effective) contains "^build"`,
        typecheckSrcDependsOn.includes('^build'),
        JSON.stringify(typecheckSrcDependsOn),
      );
      report(
        `${name}: A3 — typecheck-src.dependsOn (effective) excludes "typecheck-tests" and "typecheck" (no back-edge)`,
        !typecheckSrcDependsOn.includes('typecheck-tests') && !typecheckSrcDependsOn.includes('typecheck'),
        JSON.stringify(typecheckSrcDependsOn),
      );
    }

    // A4
    const typecheckExecutor = targets.typecheck?.executor;
    report(`${name}: A4 — typecheck.executor === "nx:noop"`, typecheckExecutor === 'nx:noop', String(typecheckExecutor));
  }

  // A7 — runs for every project with a typecheck-src target (not gated on hasTypecheckTests):
  // the tsconfig that typecheck-src's own command actually invokes must resolve to a file set
  // that excludes *.spec.ts / *.test.ts. This is a project-config-shape check, unrelated to
  // whether the project also happens to define typecheck-tests. Config resolution is done via
  // TypeScript's own `parseJsonConfigFileContent` (extends chain, include/exclude, matched
  // fileNames) rather than a hand-rolled glob or a full `tsc --listFilesOnly` spawn per project —
  // it is the same resolution logic tsc itself uses, but returns instantly with no type checking.
  if (hasTypecheckSrc) {
    const command = targets['typecheck-src']?.options?.command;
    const match = typeof command === 'string' ? command.match(/(?:^|\s)-p\s+(\S+)/) : null;
    if (!match) {
      report(`${name}: A7 — typecheck-src command has a "-p <tsconfig>" flag`, false, JSON.stringify(command));
    } else {
      const configPath = path.resolve(CODE_ROOT, match[1]);
      if (!fs.existsSync(configPath)) {
        report(`${name}: A7 — tsconfig referenced by typecheck-src exists`, false, configPath);
      } else {
        const readResult = ts.readConfigFile(configPath, ts.sys.readFile);
        if (readResult.error) {
          report(
            `${name}: A7 — tsconfig referenced by typecheck-src parses`,
            false,
            ts.flattenDiagnosticMessageText(readResult.error.messageText, '\n'),
          );
        } else {
          const parsed = ts.parseJsonConfigFileContent(readResult.config, ts.sys, path.dirname(configPath));
          const specOrTestFiles = parsed.fileNames.filter((f) => f.endsWith('.spec.ts') || f.endsWith('.test.ts'));
          report(
            `${name}: A7 — typecheck-src tsconfig (${path.relative(CODE_ROOT, configPath)}) excludes *.spec.ts/*.test.ts`,
            specOrTestFiles.length === 0,
            specOrTestFiles.length === 0
              ? `${parsed.fileNames.length} file(s) resolved, none spec/test`
              : `${specOrTestFiles.length} spec/test file(s) included: ${specOrTestFiles
                  .slice(0, 5)
                  .map((f) => path.relative(CODE_ROOT, f))
                  .join(', ')}`,
          );
        }
      }
    }
  }
}

report('at least one project with a typecheck target was checked', projectsChecked.length > 0, `${projectsChecked.length} checked`);

// --- task-graph check (A5) -----------------------------------------------------------------------

const projectsWithTypecheckTests = projectsChecked.filter((p) => p.hasTypecheckTests).map((p) => p.name);

if (SKIP_GRAPH) {
  console.log('  (skipped: --skip-graph)');
} else if (!canAskNx) {
  console.log(`  (skipped: ${CODE_ROOT} has no invocable nx workspace — node_modules absent; config-only proof used for red demo)`);
} else {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl7ff58364-graph-'));
  try {
    const graphFile = path.join(tmpDir, 'graph.json');
    let graphExitOk = true;
    try {
      execFileSync(
        'npx',
        ['nx', 'run-many', '-t', 'typecheck', '--all', '--graph=' + graphFile],
        { cwd: CODE_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      // Check the actual nx exit status, not just whether the graph file happens to exist:
      // `--graph=<file>` normally writes the file and exits 0 without running any tasks, so a
      // non-zero exit here means graph construction itself failed — report it once, here, and do
      // not also fall through to the "graph file was produced" check below (that would double-
      // count the same underlying failure as two separate FAILs).
      graphExitOk = false;
      report('nx run-many -t typecheck --all --graph=<file> succeeded', false, String(err.message ?? err));
    }

    if (graphExitOk) {
      if (fs.existsSync(graphFile)) {
        const graph = readJson(graphFile);
        // The JSON produced by `--graph=` nests the real per-task map under `tasks.tasks` (the
        // top-level `tasks` key is the whole TaskGraph shape: roots/tasks/dependencies/...).
        const taskKeys = Object.keys(graph.tasks?.tasks ?? graph.tasks ?? graph.graph?.tasks ?? {});
        const dependencies = graph.tasks?.dependencies ?? {};
        for (const name of projectsWithTypecheckTests) {
          const srcKey = `${name}:typecheck-src`;
          const testsKey = `${name}:typecheck-tests`;
          report(
            `A5: task graph for "nx run-many -t typecheck" includes ${srcKey}`,
            taskKeys.includes(srcKey),
            `graph has ${taskKeys.length} task(s)`,
          );
          report(
            `A5: task graph for "nx run-many -t typecheck" includes ${testsKey}`,
            taskKeys.includes(testsKey),
            `graph has ${taskKeys.length} task(s)`,
          );
          const testsDeps = dependencies[testsKey] ?? [];
          report(
            `A5: graph.tasks.dependencies["${testsKey}"] includes "${srcKey}"`,
            Array.isArray(testsDeps) && testsDeps.includes(srcKey),
            JSON.stringify(testsDeps),
          );
        }
      } else {
        // Count the missing-graph-file case exactly once (this branch only runs when the nx
        // invocation itself reported success but still left no file behind).
        report('nx task graph file was produced', false, graphFile);
      }
    }
  } finally {
    // Always clean up the mkdtemp scratch dir, on every exit path (success, graph-exec failure,
    // missing-file, or a thrown JSON-parse error) — not only on the happy path.
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

console.log('');
console.log(failed === 0 ? 'ALL 7ff58364 ASSERTIONS PASS' : `${failed} 7ff58364 ASSERTION(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
