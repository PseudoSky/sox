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
 * Resolves the project's transitive nx dependency set, maps each to its PROJECT ROOT (the dir
 * `nx.json`'s own `namedInputs.default` names as `{projectRoot}/**\/*` — not just `sourceRoot`, a
 * `src/` subdirectory of it), and reports `git status --porcelain` restricted to those roots plus
 * the repo's shared-global config (`nx.json` `namedInputs.sharedGlobals` names `tsconfig.base.json`; `nx.json`
 * itself is ALSO added even though it is already an implicit global input nx hashes into every
 * task automatically — it is listed here for the reader's benefit, not because nx would otherwise
 * miss it. `pnpm-lock.yaml`, `package.json`, `pnpm-workspace.yaml`, and `.npmrc` are added on top
 * because a change to any of them changes what gets resolved into `node_modules` — and therefore
 * what `^build`/`test` actually execute against — whether or not nx hashes them as cache inputs).
 * Dirt anywhere else in the repo is irrelevant to the suite and is deliberately not reported — a
 * report that is noisy gets ignored, and this one has to be read.
 *
 * [28f22e8d, 2026-09-28] Earlier versions of this tool restricted `git status` to `sourceRoot`
 * (`<project>/src`) instead of `root` (`<project>/`). Every project keeps files that feed its
 * build/test OUTSIDE `src/` — `project.json`, `tsconfig.json`, `vitest.config.ts`, and (for
 * memory-server specifically) its top-level `*.test.ts` files all live at the project root, one
 * level above `sourceRoot`. A dirty `project.json` was therefore invisible to this tool: it could
 * report CLEAN while three dependency-set `project.json` files sat uncommitted. See the
 * `sourceRoots()` vs `projectRoots()` functions below, and nx's own `{projectRoot}/**\/*` default
 * input in `nx.json`. (That glob — and every other one in this file — carries a backslash before
 * its middle slash: the un-escaped four-character sequence star-star-slash-star is also how a
 * JS block comment ends, so writing it literally here would truncate this very comment.)
 *
 * [48d92088, 2026-09-28] A project root is a plain path PREFIX, not a project boundary — it also
 * matches any nx project nested inside it (e.g. `graph-store` contains
 * `graph-store-conformance-consumer`; `sox-memory-bundle` contains its own member projects). A
 * nested project that is NOT itself part of the dependency set is excluded via `:(exclude)`
 * pathspec magic — see `buildPathspecs()`. The repo ROOT project (`.`, when it is itself part of
 * the dependency set) gets the same treatment for a stronger reason: `.` as a pathspec matches the
 * ENTIRE repo, so left unguarded it would defeat the whole point of this tool by reporting dirt in
 * every project, dependency set or not. `buildPathspecs()` scopes `.` down by excluding every
 * other project root — the result still includes non-project subdirectories of the repo root, not
 * only files that live directly at the top level.
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
 * sibling `dist/`. Used for the build-artifact freshness half of the report AND [28f22e8d] as the
 * root of the `git status` scope, since it is the whole dir nx's own `{projectRoot}/**\/*` default
 * input names — `project.json`, `tsconfig*.json`, `vitest.config.ts`, and top-level test files
 * included, not just the `src/` subtree `sourceRoots()` returns.
 */
export function projectRoots(graph, projects) {
  return [
    ...new Set(projects.map((p) => graph.nodes[p]?.data?.root).filter(Boolean)),
  ].sort();
}

/**
 * [28f22e8d] Repo-root config that feeds every project's build/test regardless of dependency
 * graph membership, restricted to files that actually exist (this tool must also run cleanly
 * against a fixture repo that has none of these). `tsconfig.base.json` is nx's own declared
 * `sharedGlobals` input (`nx.json` `namedInputs.sharedGlobals`) — a change here invalidates every
 * project's build cache. `nx.json` is included for the reader's benefit even though nx ALREADY
 * hashes it implicitly into every task (it is nx's own config file — plugins, target defaults,
 * task runner options — so nx treats a change to it as a global cache-busting input on its own;
 * this tool doesn't need to compensate for a gap there). `pnpm-lock.yaml`, `package.json`
 * (root — declares the pnpm workspace globs' consumers and root devDependencies),
 * `pnpm-workspace.yaml` (declares which package globs exist AT ALL — changing it changes
 * dependency resolution exactly like the lockfile does), and `.npmrc` (registry/resolution
 * settings) are included on a DIFFERENT basis than `nx.json`/`tsconfig.base.json` above: whether
 * or not nx hashes them as a cache input, a change to any of them changes what gets resolved into
 * `node_modules` — and therefore what `^build`/`test` actually execute against — just as surely
 * as a source edit.
 */
export function rootConfigFiles(cwd = process.cwd()) {
  return [
    'nx.json',
    'tsconfig.base.json',
    'pnpm-lock.yaml',
    'package.json',
    'pnpm-workspace.yaml',
    '.npmrc',
  ].filter((f) => existsSync(path.join(cwd, f)));
}

/**
 * [48d92088, 2026-09-28] `git status -- <pathspec>` pathspecs to scope a `git status` scan to
 * exactly `pkgRoots`, with two corrections a plain list of dirs gets wrong:
 *
 *   1. A project root is a path PREFIX, not a project boundary — it also matches any nx project
 *      nested inside it (e.g. `graph-store` contains `graph-store-conformance-consumer`;
 *      `sox-memory-bundle` contains its own member projects). A nested project that is not itself
 *      part of `pkgRoots` is excluded via `:(exclude)` pathspec magic.
 *   2. The repo ROOT project (`root: '.'`, when it is itself part of the dependency set) needs the
 *      same treatment for a stronger reason: `.` as a pathspec matches the ENTIRE repo. Left
 *      unguarded it would defeat the whole point of this tool — reporting dirt in every project
 *      in the repo, dependency set or not. It is scoped down by excluding every OTHER project
 *      root that is not itself part of `pkgRoots` — the result still includes non-project
 *      subdirectories of the repo root, not only files that live directly at the top level
 *      (a project root that IS part of `pkgRoots` is already separately included as its own entry
 *      — excluding it here too would always cancel that legitimate inclusion, since `:(exclude)`
 *      wins over any matching include pattern in the same pathspec set regardless of ordering).
 *
 * A THIRD correction guards both of the above against a subtler self-cancellation: `:(exclude)`
 * wins over every matching include pattern in the SAME pathspec set, globally, regardless of
 * which include pattern produced the match. If an excluded root is itself an ANCESTOR directory
 * of a genuinely-included `pkgRoots` entry (not just equal to one — already handled above), the
 * exclude would cancel that descendant's own inclusion too, e.g. deps `.` and `a/b/m` with `a/b`
 * NOT a dependency: excluding `a/b` from `.`'s scope would also swallow `a/b/m`, even though
 * `a/b/m` is a real dependency-set member with its own explicit include entry. `isAncestorOfPkgRoot`
 * withholds the exclude in that case — the safe direction to be wrong in is over-reporting (dirt
 * in `a/b` itself, which is not a dependency, leaks into the report) rather than silently losing a
 * real dependency's dirt.
 */
export function buildPathspecs(graph, pkgRoots) {
  const pkgRootSet = new Set(pkgRoots);
  const allRoots = [
    ...new Set(Object.values(graph.nodes).map((n) => n.data?.root).filter(Boolean)),
  ];
  const isAncestorOfPkgRoot = (candidate) => {
    const prefix = `${candidate.replace(/\/$/, '')}/`;
    return pkgRoots.some((pr) => pr !== candidate && pr.startsWith(prefix));
  };
  const specs = [];
  for (const root of pkgRoots) {
    specs.push(root);
    if (root === '.') {
      for (const other of allRoots) {
        if (other !== '.' && !pkgRootSet.has(other) && !isAncestorOfPkgRoot(other)) {
          specs.push(`:(exclude)${other}`);
        }
      }
      continue;
    }
    const prefix = `${root.replace(/\/$/, '')}/`;
    for (const other of allRoots) {
      if (
        other !== root &&
        other.startsWith(prefix) &&
        !pkgRootSet.has(other) &&
        !isAncestorOfPkgRoot(other)
      ) {
        specs.push(`:(exclude)${other}`);
      }
    }
  }
  return [...new Set(specs)];
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

/**
 * [28f22e8d] `git status --porcelain` always reads `GIT_DIR`/`GIT_INDEX_FILE`/`GIT_WORK_TREE`/
 * `GIT_COMMON_DIR` over `cwd`-based repo discovery when any of them is set — so an inherited
 * value from an ENCLOSING git process (this tool commonly runs from `.husky/pre-commit`, which
 * sets `GIT_INDEX_FILE` to the in-progress commit's `next-index-<pid>.lock`) silently redirects
 * `git status` away from `cwd` entirely. `porcelainOver`'s whole contract is "restricted to
 * `cwd`" — inheriting these breaks that contract for every caller, not just tests that build a
 * scratch repo under a real hook. Stripped unconditionally, not opt-in.
 */
function gitEnv() {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  return env;
}

/**
 * `git status --porcelain` restricted to the given paths.
 *
 * [BL-48d92088] `--untracked-files=all` is passed explicitly, not left to the ambient config.
 * `git status` defaults to reporting ALL untracked files (`status.showUntrackedFiles` defaults to
 * `all`), but that default is a per-user/per-repo git config setting a caller can override — with
 * `status.showUntrackedFiles=no` set, a brand-new untracked file inside a dependency root is
 * silently omitted and this tool reports CLEAN (and `--require-clean` passes) even though the
 * suite's `^build` step will pick that file up. `--untracked-files=all` on the CLI always wins
 * over config, making the report's behavior independent of whatever the invoking user or CI image
 * happens to have set.
 */
export function porcelainOver(roots, cwd = process.cwd()) {
  if (!roots.length) return [];
  const out = execFileSync(
    'git',
    ['status', '--porcelain', '--untracked-files=all', '--', ...roots],
    {
      cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: gitEnv(),
    },
  );
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

/**
 * [28f22e8d] Build the report object for `project` against `graph`. Extracted out of `main()` so
 * a regression guard can exercise EXACTLY the scoping logic the CLI uses, instead of re-deriving
 * it from lower-level exports (`projectRoots`/`rootConfigFiles` existed before the fix too — only
 * `main()`'s choice of which to pass to `porcelainOver` was wrong, so a guard testing those
 * exports in isolation would not have caught this bug).
 */
export function buildReport(graph, project, cwd = process.cwd()) {
  const deps = transitiveDeps(graph, project);
  const pkgRoots = projectRoots(graph, deps);
  const globalConfig = rootConfigFiles(cwd);
  // [28f22e8d] `git status` scope is the project ROOTS (project.json, tsconfig*.json,
  // vitest.config.ts, top-level test files included) plus shared root config — not sourceRoots,
  // which is a `src/` subdirectory that misses all of the above. sourceRoots is still reported
  // below (informational: the narrower set a plain source-only rebuild would read).
  // [48d92088] `pkgRoots` is expanded to `buildPathspecs()` pathspecs first — plain dirs would
  // over-scope into nested non-dependency projects and, when `.` is a dependency, the whole repo.
  const dirty = porcelainOver([...buildPathspecs(graph, pkgRoots), ...globalConfig], cwd);
  const staleDist = staleDistOver(pkgRoots, cwd);
  return {
    project,
    dependencies: [...deps].sort(),
    sourceRoots: sourceRoots(graph, deps),
    projectRoots: pkgRoots,
    rootConfigFiles: globalConfig,
    dirty,
    staleDist,
    clean: dirty.length === 0 && staleDist.length === 0,
  };
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

  const report = buildReport(graph, project);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.clean) {
    console.log(
      `check-suite-tree-state: CLEAN — ${report.dependencies.length} project(s) in ${project}'s ` +
        "dependency set, no uncommitted changes and no dist/ older than its src/. A suite result " +
        'here is attributable to committed source [BL-456].',
    );
  } else {
    if (report.dirty.length > 0) {
      console.log(
        `check-suite-tree-state: DIRTY — ${report.dirty.length} uncommitted path(s) inside ${project}'s ` +
          `dependency set (${report.dependencies.length} project(s)) [BL-456]:`,
      );
      for (const line of report.dirty) console.log(`  ${line}`);
      console.log(
        '\n  `nx test` runs `^build` first, so these files WILL be compiled into the dist/ the suite\n' +
          '  loads — including another agent\'s in-flight work. Quote this output alongside the suite\n' +
          '  result, or re-run in an isolated worktree.',
      );
    }
    if (report.staleDist.length > 0) {
      if (report.dirty.length > 0) console.log('');
      console.log(formatStaleReport(report.staleDist, { context: `${project}'s dependency set` }));
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
