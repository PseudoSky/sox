#!/usr/bin/env node
/**
 * tools/test-bl456-suite-tree-state.mjs
 *
 * Red->green contract pin for BL-456: `nx.json` declares `targetDefaults.test.dependsOn =
 * ["^build"]`, so `nx test <project>` rebuilds every upstream `dist/` from whatever source is on
 * disk — including a concurrent agent's uncommitted edits. A suite can therefore go green against
 * work its runner has never seen, and be reported as verification.
 *
 * Arms:
 *   1. BL-456 mechanism, asserted against the real `nx.json`: `test` really does depend on
 *      `^build`. If this ever stops being true, the whole hazard is gone and this tool should go
 *      with it — so the claim is pinned to the file rather than restated in prose.
 *   2. BL-456 dependency set: the transitive walk includes upstream projects, excludes external
 *      npm nodes, and excludes unrelated projects.
 *   3. BL-456 detection: an uncommitted file inside the dependency set is reported.
 *   4. BL-456 narrowness: an uncommitted file OUTSIDE the dependency set is NOT reported — a noisy
 *      report is an ignored report.
 *   5. BL-456 gate: `--require-clean` exits non-zero on a dirty dependency set and zero on a clean
 *      one.
 *   6. BL-456 live: the real repo's graph resolves, and `memory-server`'s dependency set is
 *      reported rather than assumed.
 *
 * Usage: node tools/test-bl456-suite-tree-state.mjs
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

let failed = 0;
function report(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
}

const mod = await import(`file://${TOOL}`);

// ---------------------------------------------------------------------------
// Arm 1 — the mechanism, read from nx.json rather than restated.
// ---------------------------------------------------------------------------
{
  const nx = JSON.parse(fs.readFileSync(path.join(REPO, 'nx.json'), 'utf8'));
  const dependsOn = nx.targetDefaults?.test?.dependsOn ?? [];
  report(
    'BL-456: nx.json still declares `targetDefaults.test.dependsOn = ["^build"]` (the hazard exists)',
    dependsOn.includes('^build'),
    `dependsOn=${JSON.stringify(dependsOn)}`,
  );
}

// ---------------------------------------------------------------------------
// A fixture graph in the shape `nx graph --file` emits.
// ---------------------------------------------------------------------------
const graph = {
  nodes: {
    app: { data: { sourceRoot: 'apps/app/src', root: 'apps/app' } },
    lib: { data: { sourceRoot: 'libs/lib/src', root: 'libs/lib' } },
    deep: { data: { sourceRoot: 'libs/deep/src', root: 'libs/deep' } },
    unrelated: { data: { sourceRoot: 'libs/unrelated/src', root: 'libs/unrelated' } },
  },
  dependencies: {
    app: [
      { source: 'app', target: 'lib', type: 'static' },
      { source: 'app', target: 'npm:vitest', type: 'static' },
    ],
    lib: [{ source: 'lib', target: 'deep', type: 'static' }],
    deep: [],
    unrelated: [],
  },
};

// ---------------------------------------------------------------------------
// Arm 2 — the dependency set.
// ---------------------------------------------------------------------------
{
  const deps = mod.transitiveDeps(graph, 'app').sort();
  report(
    'BL-456: the dependency set is transitive, excludes npm: nodes, and excludes unrelated projects',
    JSON.stringify(deps) === JSON.stringify(['app', 'deep', 'lib']),
    `deps=${JSON.stringify(deps)}`,
  );
  report(
    'BL-456: every dependency contributes the source root a `^build` would read',
    JSON.stringify(mod.sourceRoots(graph, deps)) ===
      JSON.stringify(['apps/app/src', 'libs/deep/src', 'libs/lib/src']),
  );
}

// ---------------------------------------------------------------------------
// Arms 3-5 — detection, narrowness and the gate, against a real git tree.
// ---------------------------------------------------------------------------
{
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bl456-')));
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@test.com']);
  git(['config', 'user.name', 'test']);
  for (const p of ['apps/app/src', 'libs/lib/src', 'libs/deep/src', 'libs/unrelated/src']) {
    fs.mkdirSync(path.join(dir, p), { recursive: true });
    fs.writeFileSync(path.join(dir, p, 'index.ts'), 'export const x = 1;\n');
  }
  git(['add', '.']);
  git(['commit', '-q', '-m', 'chore: initial']);

  const roots = mod.sourceRoots(graph, mod.transitiveDeps(graph, 'app'));

  report('BL-456: a clean dependency set reports nothing', mod.porcelainOver(roots, dir).length === 0);

  // A concurrent agent's uncommitted edit, deep in the dependency set — the PKT-72 incident's shape.
  fs.writeFileSync(path.join(dir, 'libs/deep/src/index.ts'), 'export const x = 2; // in-flight\n');
  const dirty = mod.porcelainOver(roots, dir);
  report(
    "BL-456: an uncommitted edit inside the dependency set IS reported (the concurrent agent's work)",
    dirty.length === 1 && dirty[0].includes('libs/deep/src/index.ts'),
    `dirty=${JSON.stringify(dirty)}`,
  );

  // Dirt outside the dependency set cannot reach the suite's dist/ and must not be reported.
  fs.writeFileSync(path.join(dir, 'libs/unrelated/src/index.ts'), 'export const x = 3;\n');
  const dirty2 = mod.porcelainOver(roots, dir);
  report(
    'BL-456: an uncommitted edit OUTSIDE the dependency set is NOT reported',
    dirty2.length === 1 && !dirty2.some((l) => l.includes('unrelated')),
    `dirty=${JSON.stringify(dirty2)}`,
  );

  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Arm 6 — live, against the real repo graph. This is the form a packet quotes.
// ---------------------------------------------------------------------------
{
  const r = spawnSync(process.execPath, [TOOL, '--project', 'memory-server', '--json'], {
    cwd: REPO,
    encoding: 'utf8',
  });
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    /* reported below */
  }
  report(
    "BL-456: the real repo's graph resolves and memory-server's dependency set is enumerated",
    (r.status ?? 1) === 0 &&
      parsed?.dependencies?.includes('memory-core') &&
      parsed.dependencies.includes('memory-server') &&
      parsed.sourceRoots.length > 0,
    parsed
      ? `${parsed.dependencies.length} project(s), ${parsed.sourceRoots.length} source root(s), clean=${parsed.clean}`
      : `exit=${r.status} stderr=${(r.stderr ?? '').trim().slice(0, 200)}`,
  );
  report(
    'BL-456: --require-clean turns the report into a gate, and agrees with the report it printed',
    (() => {
      const g = spawnSync(process.execPath, [TOOL, '--project', 'memory-server', '--require-clean'], {
        cwd: REPO,
        encoding: 'utf8',
      });
      return parsed ? (parsed.clean ? g.status === 0 : g.status === 1) : false;
    })(),
    `dependency set is ${parsed?.clean ? 'clean' : 'dirty'} right now`,
  );
}

console.log(
  failed === 0 ? '\nAll BL-456 assertions passed.' : `\n${failed} BL-456 assertion(s) FAILED.`,
);
process.exit(failed === 0 ? 0 : 1);
