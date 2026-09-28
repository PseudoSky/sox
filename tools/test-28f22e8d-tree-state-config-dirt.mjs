#!/usr/bin/env node
/**
 * tools/test-28f22e8d-tree-state-config-dirt.mjs
 *
 * Red->green contract pin for BL-28f22e8d: `tools/check-suite-tree-state.mjs` restricted its
 * `git status` scope to each dependency's `sourceRoot` (a `src/` subdirectory) instead of its
 * `root` (the whole project dir). `project.json`, `tsconfig.json`, `vitest.config.ts`, and
 * top-level `*.test.ts` files all live at `root`, one level above `sourceRoot` — so a dirty
 * `project.json` was invisible to the tool, which reported CLEAN while three dependency-set
 * `project.json` files sat uncommitted (observed live: memory-server's own dependency set,
 * 2026-09-28).
 *
 * Arms:
 *   1. A dirty file directly under a dependency's PROJECT ROOT but OUTSIDE its sourceRoot
 *      (e.g. `libs/lib/project.json`) IS reported. This is the exact regression shape.
 *   2. A dirty file still inside sourceRoot continues to be reported (no loss of the original
 *      BL-456 behavior).
 *   3. A dirty file in the repo ROOT config set (`nx.json`) IS reported, even though it belongs
 *      to no single project's root.
 *   4. A dirty file OUTSIDE every dependency's root and outside the root config set is NOT
 *      reported (the anti-noise design is preserved).
 *   5. [48d92088, 2026-09-28] A project root is a plain path PREFIX: a dirty file inside a nx
 *      project NESTED inside a dependency-set root, but not itself part of the dependency set,
 *      is NOT reported — while dirt in the parent dependency-set project itself still is.
 *   6. [48d92088, 2026-09-28] When the repo ROOT project (`root: '.'`) is itself part of the
 *      dependency set, a dirty file literally at the repo root IS reported, but `.`'s pathspec
 *      is NOT allowed to sweep in dirt from every other unrelated project in the repo — the
 *      failure mode `.` as a bare git pathspec would otherwise produce.
 *   7. [48d92088, 2026-09-28] Self-cancellation guard: `:(exclude)` wins over every matching
 *      include pattern globally, not just the include it was paired with. An excluded root that
 *      is an ANCESTOR of a genuinely-included dependency root must NOT be excluded — doing so
 *      would silently swallow that descendant dependency's own dirt. Deps `.` and `a/b/m`, with
 *      `a/b` (containing `a/b/m`) NOT itself a dependency: `a/b/m`'s dirt is still reported.
 *   8. Live (non-hermetic — see `tools/guards-manifest.mjs`'s `28f22e8d` entry): the real repo's
 *      `check-suite-tree-state.mjs --project memory-server --json` output carries non-empty
 *      `projectRoots` and `rootConfigFiles` fields (the fix is wired into `main()`, not just
 *      exported and unused).
 *
 * Uses throwaway scratch git repos (fs.mkdtempSync) — never the invoking checkout's real tree —
 * for arms 1-7. Each scratch-repo block is wrapped in try/finally so the temp dir is always
 * removed, including on assertion or git-command failure.
 *
 * Usage: node tools/test-28f22e8d-tree-state-config-dirt.mjs
 * Exit 0 iff every assertion holds.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TOOLS, '..');
const TOOL = path.join(TOOLS, 'check-suite-tree-state.mjs');

// BL-479 — strip inherited GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE/GIT_COMMON_DIR so this scratch
// repo's git commands can never resolve against the invoking checkout's real index.
const SAFE_GIT_ENV = { ...process.env };
delete SAFE_GIT_ENV.GIT_DIR;
delete SAFE_GIT_ENV.GIT_INDEX_FILE;
delete SAFE_GIT_ENV.GIT_WORK_TREE;
delete SAFE_GIT_ENV.GIT_COMMON_DIR;

let failed = 0;
function report(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
}

const mod = await import(`file://${TOOL}`);

// A fixture graph in the shape `nx graph --file` emits — same shape as BL-456's own fixture.
// `libNested` lives inside `lib`'s project root (`libs/lib/nested`) but is a SEPARATE nx project
// with no dependency edge to/from `app` — the exact item-2 nested-project-over-scope shape.
const graph = {
  nodes: {
    app: { data: { sourceRoot: 'apps/app/src', root: 'apps/app' } },
    lib: { data: { sourceRoot: 'libs/lib/src', root: 'libs/lib' } },
    deep: { data: { sourceRoot: 'libs/deep/src', root: 'libs/deep' } },
    unrelated: { data: { sourceRoot: 'libs/unrelated/src', root: 'libs/unrelated' } },
    libNested: { data: { sourceRoot: 'libs/lib/nested/src', root: 'libs/lib/nested' } },
  },
  dependencies: {
    app: [
      { source: 'app', target: 'lib', type: 'static' },
      { source: 'app', target: 'npm:vitest', type: 'static' },
    ],
    lib: [{ source: 'lib', target: 'deep', type: 'static' }],
    deep: [],
    unrelated: [],
    libNested: [],
  },
};

// ---------------------------------------------------------------------------
// Arms 1-4 — a scratch git repo shaped like the fixture, with project-root-level files.
// ---------------------------------------------------------------------------
{
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bl28f22e8d-')));
  try {
    const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: SAFE_GIT_ENV });
    git(['init', '-q']);
    git(['config', 'user.email', 'test@test.com']);
    git(['config', 'user.name', 'test']);

    for (const p of [
      'apps/app/src',
      'libs/lib/src',
      'libs/deep/src',
      'libs/unrelated/src',
      'libs/lib/nested/src',
    ]) {
      fs.mkdirSync(path.join(dir, p), { recursive: true });
      fs.writeFileSync(path.join(dir, p, 'index.ts'), 'export const x = 1;\n');
    }
    // Project-root-level files that sourceRoot-only scoping misses — the regression shape.
    fs.writeFileSync(path.join(dir, 'libs/lib/project.json'), '{"name":"lib"}\n');
    fs.writeFileSync(path.join(dir, 'apps/app/project.json'), '{"name":"app"}\n');
    fs.writeFileSync(path.join(dir, 'libs/unrelated/project.json'), '{"name":"unrelated"}\n');
    fs.writeFileSync(path.join(dir, 'libs/lib/nested/project.json'), '{"name":"libNested"}\n');
    fs.writeFileSync(path.join(dir, 'nx.json'), '{"targetDefaults":{}}\n');
    fs.writeFileSync(path.join(dir, 'README.md'), 'scratch repo\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'chore: initial']);

    // Defensive: on the pre-fix file, `buildReport` does not exist at all — `main()` inlined the
    // (buggy) sourceRoot-only scoping instead. Report that as a failed assertion rather than an
    // uncaught TypeError that aborts every remaining arm.
    if (typeof mod.buildReport !== 'function') {
      report(
        'BL-28f22e8d: check-suite-tree-state.mjs exports buildReport() (the function main() uses)',
        false,
        'export missing (pre-fix) — cannot exercise the CLI code path at all',
      );
    }
    // `buildReport` is what `main()` itself calls — exercising it here pins the EXACT code path the
    // CLI runs, not a hand-assembled equivalent (a guard calling `projectRoots`/`porcelainOver`
    // directly would pass even with the bug in place, since those two already existed pre-fix; only
    // `main()`'s choice of which roots to hand to `porcelainOver` was wrong).
    const build = (proj) => mod.buildReport(graph, proj, dir);

    report(
      'BL-28f22e8d: a clean tree reports nothing',
      typeof mod.buildReport === 'function' && build('app').dirty.length === 0,
    );

    // Arm 1 — dirty project.json, directly under root but OUTSIDE sourceRoot. THE regression shape.
    fs.writeFileSync(path.join(dir, 'libs/lib/project.json'), '{"name":"lib","changed":true}\n');
    {
      const rep = typeof mod.buildReport === 'function' ? build('app') : { dirty: [] };
      report(
        'BL-28f22e8d: buildReport() DOES report a dirty project.json at project root (the fix)',
        rep.dirty.length === 1 && rep.dirty[0].includes('libs/lib/project.json'),
        `dirty=${JSON.stringify(rep.dirty)}`,
      );
    }
    git(['checkout', '--', 'libs/lib/project.json']);

    // Arm 2 — dirty file still inside sourceRoot must still be reported (no regression on BL-456).
    fs.writeFileSync(path.join(dir, 'libs/deep/src/index.ts'), 'export const x = 2;\n');
    {
      const rep = typeof mod.buildReport === 'function' ? build('app') : { dirty: [] };
      report(
        'BL-28f22e8d: a dirty file inside sourceRoot is still reported (BL-456 behavior preserved)',
        rep.dirty.length === 1 && rep.dirty[0].includes('libs/deep/src/index.ts'),
        `dirty=${JSON.stringify(rep.dirty)}`,
      );
    }
    git(['checkout', '--', 'libs/deep/src/index.ts']);

    // Arm 3 — dirty root config file (nx.json) IS reported even though it belongs to no project root.
    fs.writeFileSync(path.join(dir, 'nx.json'), '{"targetDefaults":{"changed":true}}\n');
    {
      const rep = typeof mod.buildReport === 'function' ? build('app') : { dirty: [] };
      report(
        'BL-28f22e8d: a dirty repo-root config file (nx.json) IS reported',
        rep.dirty.length === 1 && rep.dirty[0].includes('nx.json'),
        `dirty=${JSON.stringify(rep.dirty)}`,
      );
    }
    git(['checkout', '--', 'nx.json']);

    // Arm 4 — dirt outside every dependency root and outside root config is NOT reported.
    fs.writeFileSync(path.join(dir, 'libs/unrelated/project.json'), '{"name":"unrelated","changed":true}\n');
    fs.writeFileSync(path.join(dir, 'README.md'), 'scratch repo, changed\n');
    {
      const rep = typeof mod.buildReport === 'function' ? build('app') : { dirty: [] };
      report(
        'BL-28f22e8d: dirt outside the dependency set and outside root config is NOT reported',
        rep.dirty.length === 0,
        `dirty=${JSON.stringify(rep.dirty)}`,
      );
    }
    git(['checkout', '--', 'libs/unrelated/project.json', 'README.md']);

    // Arm 5 [BL-48d92088, item 2] — a project root is a plain path PREFIX, so it also matches any nx
    // project nested inside it. `libNested` (root `libs/lib/nested`) sits inside `lib`'s own root
    // (`libs/lib`) but has NO dependency edge to/from `app` — dirt there must NOT be reported, even
    // though dirt in `lib`'s own root (a real dependency-set member) still must be.
    fs.writeFileSync(path.join(dir, 'libs/lib/project.json'), '{"name":"lib","changed":true}\n');
    fs.writeFileSync(path.join(dir, 'libs/lib/nested/src/index.ts'), 'export const x = 2;\n');
    {
      const rep = typeof mod.buildReport === 'function' ? build('app') : { dirty: [] };
      const parentReported = rep.dirty.some((l) => l.includes('libs/lib/project.json'));
      const nestedReported = rep.dirty.some((l) => l.includes('libs/lib/nested/src/index.ts'));
      report(
        'BL-48d92088[nested]: dirt in a dependency-set project root IS reported alongside a nested non-dependency project',
        parentReported,
        `dirty=${JSON.stringify(rep.dirty)}`,
      );
      report(
        'BL-48d92088[nested]: dirt in a NESTED project that is NOT itself in the dependency set is NOT reported',
        !nestedReported,
        `dirty=${JSON.stringify(rep.dirty)}`,
      );
    }
    git(['checkout', '--', 'libs/lib/project.json', 'libs/lib/nested/src/index.ts']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Arm 6 [BL-48d92088, item 3] — the repo ROOT project (`root: '.'`) is itself part of the
// dependency set. `.` as a bare git pathspec matches the ENTIRE repo, so naively passing it
// through would sweep in dirt from every other unrelated project — the exact failure mode this
// arm pins against. A dirty file literally at the repo root must still be reported.
// ---------------------------------------------------------------------------
{
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bl28f22e8d-rootdep-')));
  try {
    const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: SAFE_GIT_ENV });
    git(['init', '-q']);
    git(['config', 'user.email', 'test@test.com']);
    git(['config', 'user.name', 'test']);

    const rootGraph = {
      nodes: {
        root: { data: { sourceRoot: '.', root: '.' } },
        other: { data: { sourceRoot: 'libs/other/src', root: 'libs/other' } },
      },
      dependencies: { root: [], other: [] },
    };

    fs.mkdirSync(path.join(dir, 'libs/other/src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'libs/other/src/index.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(dir, 'libs/other/project.json'), '{"name":"other"}\n');
    fs.writeFileSync(path.join(dir, 'root-config.txt'), 'root file\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'chore: initial']);

    const build = () =>
      typeof mod.buildReport === 'function'
        ? mod.buildReport(rootGraph, 'root', dir)
        : { dirty: [] };

    fs.writeFileSync(path.join(dir, 'root-config.txt'), 'root file, changed\n');
    fs.writeFileSync(path.join(dir, 'libs/other/src/index.ts'), 'export const x = 2;\n');
    const rep = build();
    const rootFileReported = rep.dirty.some((l) => l.includes('root-config.txt'));
    const otherProjectReported = rep.dirty.some((l) => l.includes('libs/other'));
    report(
      'BL-48d92088[root]: a dirty file at the literal repo root IS reported when the root project (".") is in the dependency set',
      rootFileReported,
      `dirty=${JSON.stringify(rep.dirty)}`,
    );
    report(
      'BL-48d92088[root]: dirt inside ANOTHER project is NOT swept in by the "." dependency\'s pathspec',
      !otherProjectReported,
      `dirty=${JSON.stringify(rep.dirty)}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Arm 7 [BL-48d92088, self-cancellation] — an excluded root must never be an ANCESTOR of a
// genuinely-included dependency root. `:(exclude)` wins over every matching include pattern in
// the SAME pathspec set, globally — so excluding a non-dependency ancestor directory would also
// cancel a real descendant dependency's own separate include entry. Deps here are `.` and
// `a/b/m`; `a/b` (which CONTAINS `a/b/m`) is NOT a dependency. Naively excluding `a/b` from `.`'s
// scope (because `a/b` itself isn't in the dependency set) would silently swallow `a/b/m`'s dirt
// too, even though `a/b/m` has its own explicit include entry. `a/b/m`'s dirt must still be
// reported; `a/b`'s own (non-`a/b/m`) files are the accepted over-report (documented as the safe
// direction to be wrong in — see `buildPathspecs()`'s `isAncestorOfPkgRoot`).
// ---------------------------------------------------------------------------
{
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bl48d92088-ancestor-')));
  try {
    const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: SAFE_GIT_ENV });
    git(['init', '-q']);
    git(['config', 'user.email', 'test@test.com']);
    git(['config', 'user.name', 'test']);

    const ancestorGraph = {
      nodes: {
        root: { data: { sourceRoot: '.', root: '.' } },
        deepDep: { data: { sourceRoot: 'a/b/m/src', root: 'a/b/m' } },
        // `ab` (root `a/b`) is a REAL nx project — NOT a dependency of `root` — that is an
        // ancestor directory of `deepDep`'s root. Without it as a graph node, buildPathspecs()
        // would never even consider excluding `a/b` (allRoots wouldn't contain it), so this arm
        // would pass vacuously. Its presence is what makes the exclusion actually fire.
        ab: { data: { sourceRoot: 'a/b/src', root: 'a/b' } },
      },
      dependencies: {
        root: [{ source: 'root', target: 'deepDep', type: 'static' }],
        deepDep: [],
        ab: [],
      },
    };

    fs.mkdirSync(path.join(dir, 'a/b/m/src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a/b/m/src/index.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(dir, 'a/b/other.txt'), 'ancestor-only file\n');
    fs.writeFileSync(path.join(dir, 'root-file.txt'), 'root file\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'chore: initial']);

    const build = () =>
      typeof mod.buildReport === 'function'
        ? mod.buildReport(ancestorGraph, 'root', dir)
        : { dirty: [] };

    fs.writeFileSync(path.join(dir, 'a/b/m/src/index.ts'), 'export const x = 2;\n');
    const rep = build();
    const deepDepReported = rep.dirty.some((l) => l.includes('a/b/m/src/index.ts'));
    report(
      'BL-48d92088[ancestor]: dirt in a real DESCENDANT dependency (a/b/m) is still reported even ' +
        "though its non-dependency ANCESTOR directory (a/b) would otherwise be excluded from '.'",
      deepDepReported,
      `dirty=${JSON.stringify(rep.dirty)}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Arm 8 — live, against the real repo: the fix is wired into `main()`'s --json output. NOT
// hermetic (it spawns against this checkout's real git state, not a scratch fixture) — see the
// `28f22e8d` entry in `tools/guards-manifest.mjs` for why it still runs as Tier 1.
// ---------------------------------------------------------------------------
{
  // Strip GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE/GIT_COMMON_DIR — this guard runs from the
  // pre-commit hook, which has already set GIT_INDEX_FILE to the in-progress commit's temporary
  // lock file; inheriting it here would make this spawn's `git status` read that lock file
  // instead of the real index (same class of bug as BL-479, see test-bl456's arm 6).
  const r = spawnSync(process.execPath, [TOOL, '--project', 'memory-server', '--json'], {
    cwd: REPO,
    encoding: 'utf8',
    env: SAFE_GIT_ENV,
  });
  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    parseError = e;
  }
  report(
    'BL-28f22e8d: live --json output carries non-empty projectRoots and rootConfigFiles fields',
    (r.status ?? 1) === 0 &&
      Array.isArray(parsed?.projectRoots) &&
      parsed.projectRoots.length > 0 &&
      Array.isArray(parsed?.rootConfigFiles) &&
      parsed.rootConfigFiles.includes('nx.json'),
    parsed
      ? `projectRoots=${parsed.projectRoots?.length} rootConfigFiles=${JSON.stringify(parsed.rootConfigFiles)}`
      : `exit=${r.status} stderr=${(r.stderr ?? '').trim().slice(0, 200)}` +
          (parseError ? ` jsonParseError=${parseError.message} stdout=${r.stdout.slice(0, 200)}` : ''),
  );
}

console.log(
  failed === 0
    ? '\nAll BL-28f22e8d assertions passed.'
    : `\n${failed} BL-28f22e8d assertion(s) FAILED.`,
);
process.exit(failed === 0 ? 0 : 1);
