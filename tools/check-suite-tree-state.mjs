#!/usr/bin/env node
/**
 * check-suite-tree-state — [BL-456] report the working-tree state of everything a suite result
 * actually depends on, so "the tests are green" can be read against the source that produced it.
 *
 * WHY THIS EXISTS
 * ---------------
 * `nx.json` sets `targetDefaults.test.dependsOn = ["^build"]`. So `nx test <project>` is NOT
 * read-only with respect to `dist/`: it rebuilds every upstream dependency first, from whatever
 * source is on disk — committed or not. In a shared, concurrently-edited checkout, "whatever is on
 * disk" routinely includes another agent's in-flight work that the running agent has never seen.
 *
 * Observed live 2026-08-05 during PKT-72: an agent's isolated spec runs were green; its first full
 * `nx test memory-server --skip-nx-cache` went red on `expected null to be +0`, an assertion
 * neither it nor its packet had touched. The input was a concurrent agent's uncommitted
 * `write-queue.ts` edit, rebuilt into `memory-core/dist` by the test run itself. The reverse is
 * worse and silent: a suite can go GREEN against another agent's half-finished code and be
 * reported as verification of work that was never exercised.
 *
 * `CLAUDE.md`'s BL-235 constraint warns only about a DIRECT `nx build`. Every agent is instructed
 * to run `nx test` as a matter of course, including in the mandatory pre-merge gate, and nothing
 * told them it carries a build of somebody else's source as a side effect.
 *
 * WHAT IT DOES
 * ------------
 * Resolves the project's transitive nx dependency set, maps each to its source root, and reports
 * `git status --porcelain` restricted to those roots. Dirt anywhere else in the repo is irrelevant
 * to the suite and is deliberately not reported — a report that is noisy gets ignored, and this
 * one has to be read.
 *
 * It ALSO reports any dependency whose `dist/` is older than its `src/` (see `staleDistOver`
 * below and `tools/dist-freshness.mjs`). `dist/` is gitignored, so `git status` is structurally
 * blind to it, and several vitest configs alias `@adhd/*` directly at `<pkg>/dist/index.js` —
 * meaning the suite runs the artifact, not the source this tool used to report on alone. On
 * 2026-09-22 that blind spot turned a six-hour-stale worktree build into a reported "main is red
 * and shipped that way" P0; main was green.
 *
 * Usage
 *   node tools/check-suite-tree-state.mjs --project memory-server
 *       Report. Exit 0 whether clean or dirty — this is evidence to publish alongside the suite
 *       result, not a gate that blocks work.
 *
 *   node tools/check-suite-tree-state.mjs --project memory-server --require-clean
 *       Exit 1 when the dependency set is dirty OR any dependency's dist/ predates its src/.
 *       For a packet whose acceptance IS the suite result.
 *
 *   node tools/check-suite-tree-state.mjs --project memory-server --json
 *       Machine-readable, for a report artifact.
 *
 * A dirty dependency set does not mean the run is wrong. It means the run cannot be attributed:
 * quote this output with the result, or re-run in an isolated worktree (the structural fix, and
 * already the dispatch default).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { formatStaleReport, staleDistArtifacts } from './dist-freshness.mjs';

/**
 * Transitive dependency set of `project`, including the project itself, from an nx graph object.
 * External (npm:) nodes are ignored — they are not built from this working tree.
 */
export function transitiveDeps(graph, project) {
  const seen = new Set();
  const walk = (name) => {
    if (seen.has(name) || !graph.nodes[name]) return;
    seen.add(name);
    for (const edge of graph.dependencies[name] ?? []) {
      if (!edge.target.startsWith('npm:')) walk(edge.target);
    }
  };
  walk(project);
  return [...seen];
}

/** Source roots for a dependency set, deduped and sorted — the paths a rebuild would read. */
export function sourceRoots(graph, projects) {
  return [
    ...new Set(
      projects
        .map((p) => graph.nodes[p]?.data?.sourceRoot ?? graph.nodes[p]?.data?.root)
        .filter(Boolean),
    ),
  ].sort();
}

/**
 * Package roots (not sourceRoots) for a dependency set — the dirs that own a `src/` and a
 * sibling `dist/`. Used for the build-artifact freshness half of the report.
 */
export function projectRoots(graph, projects) {
  return [
    ...new Set(projects.map((p) => graph.nodes[p]?.data?.root).filter(Boolean)),
  ].sort();
}

/**
 * [BL-456 follow-up, 2026-09-22] The dist-artifact half of attributability.
 *
 * `git status` is blind to `dist/` — it is gitignored — yet several project vitest configs
 * alias `@adhd/*` straight at `<pkg>/dist/index.js`, so the suite executes the ARTIFACT while
 * this tool was reporting on the SOURCE. On 2026-09-22 that gap produced a false P0: a worktree
 * whose `libs/memory-core/dist/` was six hours stale failed `recall-degradation-visibility.spec.ts`
 * AC-1/AC-2 (the two ACs that exercise the empty-corpus branch whose fix was only in source),
 * and CLEAN from this tool was quoted alongside the red as proof main itself was broken.
 *
 * Only roots that actually HAVE a `dist/` are checked — a package built on demand, or one every
 * consumer resolves from source, has nothing to go stale.
 */
export function staleDistOver(roots, cwd = process.cwd()) {
  const pkgs = roots
    .map((r) => ({ name: r, pkgDir: path.resolve(cwd, r) }))
    .filter((p) => existsSync(path.join(p.pkgDir, 'dist')) && existsSync(path.join(p.pkgDir, 'src')));
  return staleDistArtifacts(pkgs);
}

/** `git status --porcelain` restricted to the given paths. */
export function porcelainOver(roots, cwd = process.cwd()) {
  if (!roots.length) return [];
  const out = execFileSync('git', ['status', '--porcelain', '--', ...roots], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\n').filter(Boolean);
}

export function loadGraph() {
  const dir = mkdtempSync(path.join(tmpdir(), 'suite-tree-state-'));
  const file = path.join(dir, 'graph.json');
  try {
    // `nx graph --file` computes the project graph only. It runs no targets and touches no dist/.
    execFileSync('npx', ['nx', 'graph', `--file=${file}`], { stdio: 'ignore' });
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return raw.graph ?? raw;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const argv = process.argv.slice(2);
  const project = argv[argv.indexOf('--project') + 1];
  const json = argv.includes('--json');
  const requireClean = argv.includes('--require-clean');
  if (!project || project.startsWith('--')) {
    console.error('check-suite-tree-state: --project <name> is required.');
    return 2;
  }

  const graph = loadGraph();
  if (!graph.nodes[project]) {
    console.error(`check-suite-tree-state: unknown project "${project}".`);
    return 2;
  }

  const deps = transitiveDeps(graph, project);
  const roots = sourceRoots(graph, deps);
  const dirty = porcelainOver(roots);
  const staleDist = staleDistOver(projectRoots(graph, deps));
  const report = {
    project,
    dependencies: deps.sort(),
    sourceRoots: roots,
    dirty,
    staleDist,
    clean: dirty.length === 0 && staleDist.length === 0,
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.clean) {
    console.log(
      `check-suite-tree-state: CLEAN — ${deps.length} project(s) in ${project}'s dependency set, ` +
        'no uncommitted changes and no dist/ older than its src/. A suite result here is ' +
        'attributable to committed source [BL-456].',
    );
  } else {
    if (dirty.length > 0) {
      console.log(
        `check-suite-tree-state: DIRTY — ${dirty.length} uncommitted path(s) inside ${project}'s ` +
          `dependency set (${deps.length} project(s)) [BL-456]:`,
      );
      for (const line of dirty) console.log(`  ${line}`);
      console.log(
        '\n  `nx test` runs `^build` first, so these files WILL be compiled into the dist/ the suite\n' +
          '  loads — including another agent\'s in-flight work. Quote this output alongside the suite\n' +
          '  result, or re-run in an isolated worktree.',
      );
    }
    if (staleDist.length > 0) {
      if (dirty.length > 0) console.log('');
      console.log(formatStaleReport(staleDist, { context: `${project}'s dependency set` }));
      console.log(
        '\n  This is the half `git status` cannot see: dist/ is gitignored, so a CLEAN source report\n' +
          '  says nothing about the artifact a dist-aliased vitest config actually loads.',
      );
    }
  }
  return requireClean && !report.clean ? 1 : 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
