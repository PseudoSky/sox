#!/usr/bin/env node
/**
 * scripts/cascade-plan.ts — republish-cascade plan + cross-check (BL-452)
 *
 * Root cause this closes (SPEC-PKT-79 §1, BL-452): `.changeset/config.json`'s
 * `updateInternalDependencies: "patch"` already computes the correct transitive
 * republish set (verified: memory-core@0.4.1→0.4.2 correctly re-pinned
 * store-adapter@0.1.1→0.1.2). The tax was never "the tool can't do this" — it was
 * that `PUBLISHING.md` documents a standing distrust of `changeset publish`'s
 * auto-scoping (a named incident: sox-memory-core 0.2.1→0.3.0 shipped as an
 * unwanted side effect on 2026-07-16), so a human re-derives the republish set by
 * hand every time with nothing checking the hand-derivation against the real
 * graph. This script is that check.
 *
 * What it computes (Decision B): the STATIC package.json dependency-graph
 * transitive closure of `workspace:*` consumers for a target package (or the set
 * of packages named across pending `.changeset/*.md` frontmatter, if no target is
 * given) — via the SAME directory-walk SHAPE as `scripts/check-publishable.ts:
 * 78-97` (depth cap, node_modules/dist/bundle exclusion; reproduced rather than
 * imported, since check-publishable.ts is out of this packet's file list), but
 * with ONE deliberate deviation from its roots list, found and fixed live against
 * this exact repo (see "Roots" below) — **not** a re-litigation of Decision F,
 * which governs a different, narrower scope (see that note for why). It then
 * cross-validates that closure against `changeset status --output=<tmp file>`'s
 * `releases[].name` set computed for the SAME pending changesets. This is
 * deliberately NOT a reimplementation of changesets' own bump-cascade algorithm
 * (that would be the exact two-sources-of-truth DRY violation BL-452 is about, in
 * miniature) — it is a cross-check between two independent computations of the
 * same answer, and it fails when they disagree.
 *
 * Roots (deviation from Decision F, evidence-based): `check-publishable.ts`'s
 * roots list is `['libs','apps','extensions','packages']` — correct for ITS
 * scope, because it only ever cares about `private !== true` packages, and every
 * currently-publishable `@adhd/sox-*` package lives under those four roots
 * (confirmed: the one package.json under `tools/*` is `@adhd/sox-baseline-
 * capture`, `"private": true`). BL-452's cascade closure has no such filter — it
 * must match everything `changeset status` would bump, and changesets resolves
 * workspace membership from `pnpm-workspace.yaml` directly (via
 * `@manypkg/get-packages`), which lists `'tools/*'` as a real workspace glob.
 * Verified live: `tools/baseline-capture/package.json` has `devDependencies:
 * {"@adhd/sox-store-adapter":"workspace:*"}` — a real edge `changeset status`
 * DOES cascade to (private packages still get their internal pin bumped for
 * workspace consistency, even though they never `npm publish`). Running this
 * script against store-adapter with a scratch changeset (AC-452-2) BEFORE this
 * fix produced exactly the disagreement class AC-452-1 predicted: "a workspace:*
 * edge the static walker's directory traversal missed... because it lives under
 * an excluded roots entry" — reproduced live, not manufactured, then fixed by
 * adding `'tools'` to this script's own roots list (`check-publishable.ts`'s
 * roots stay as-is; that file is untouched, per the out-of-bounds list).
 *
 * `changeset status` is READ-ONLY (confirmed via `--help`, @changesets/cli
 * 2.31.0 — only `version`/`publish` mutate). This script never calls
 * `changeset version` or `changeset publish` and never edits `.changeset/` or
 * any `package.json`.
 *
 * Edge scope, corrected against real behaviour (verified 2026-08-06, reading
 * `@changesets/get-dependents-graph@2.1.4`'s `getDependencyGraph`, the exact
 * function `changeset status` uses to build its own cascade):
 *   - Changesets cascades over ALL FOUR dependency fields — `dependencies`,
 *     `devDependencies` (unless `link:`/`file:` or `ignoreDevDependencies`),
 *     `peerDependencies`, `optionalDependencies` — not just `dependencies`.
 *     This is not academic: `libs/data/analysis/analysis/package.json` reaches
 *     `@adhd/sox-store-adapter` ONLY via `devDependencies` (`workspace:*`) —
 *     scanning `dependencies` alone silently drops a real, already-published
 *     consumer from the closure. Confirmed via
 *     `grep -rl '"@adhd/sox-' libs apps` across all four fields.
 *   - Changesets ALSO cascades a plain (non-`workspace:`) semver range if it
 *     is valid AND satisfied by the dependency's current version — it is not
 *     `workspace:*`-exclusive. It explicitly does NOT cascade a dist-tag
 *     (`"latest"`, `"next"`, ...) reference, by design (its own source
 *     comment: "the depRange could have been a tag ... we should not count
 *     this as a local monorepo dependant"). Verified empirically: every
 *     `@adhd/sox-*` internal edge in this repo, across all four dependency
 *     fields, already uses `workspace:*` exclusively (zero exceptions found).
 *     Reproducing changesets' generic semver-range-satisfaction matcher here
 *     would need a `semver` dependency and duplicate real logic with no
 *     present benefit (Decision B's own DRY warning) — so this walker only
 *     follows `workspace:` edges. If this repo ever adopts a plain-range
 *     internal pin, this script will UNDER-count relative to `changeset
 *     status` and the cross-check below will correctly fail loud (the
 *     dangerous direction is caught; see the disagreement branch), rather
 *     than silently drifting.
 *
 * Usage:
 *   npx tsx scripts/cascade-plan.ts [root] [--package <name>[,<name>...]] [--json]
 *
 *   [root]              repo root to scan (default: cwd).
 *   --package <name>    target package(s) to compute the cascade for. Comma-
 *                        separated for multiple roots. If omitted, auto-detects
 *                        from every package named in a pending `.changeset/*.md`
 *                        frontmatter block in this tree.
 *   --json               machine-readable output on stdout (in addition to the
 *                        human-readable plan on stderr-safe stdout lines).
 *
 * Exit 1 when:
 *   - no target package(s) could be determined (no --package and no pending
 *     changesets), or
 *   - the static-graph closure and the changesets-computed closure disagree in
 *     either direction (a package changesets would bump that the graph walk
 *     missed, or vice versa) — exactly the class of gap that produced the
 *     under/over-scoped manual publish risk this packet exists to close.
 *
 * Output (both modes): a topologically-sorted publish plan, LEAVES FIRST — i.e.
 * a package with no in-closure `workspace:*` dependency of its own comes first,
 * so publishing in this order always lets a consumer pin an already-published
 * version of its dependency (matches `updateInternalDependencies: "patch"`'s own
 * requirement that the dependency exists before the consumer's pin is rewritten).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
};
const hasFlag = (name: string): boolean =>
  argv.includes(`--${name}`) || argv.some((a) => a.startsWith(`--${name}=`));

const positionals = argv.filter((a, i) => {
  if (a.startsWith('--')) return false;
  const prev = argv[i - 1];
  return prev !== '--package';
});

const root = path.resolve(positionals[0] ?? process.cwd());
const jsonMode = hasFlag('json');
const packageArg = flagValue('package');

interface Pkg {
  name?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

// Same field set changesets' getAllDependencies() scans (DEPENDENCY_TYPES in
// @changesets/get-dependents-graph) — see module docstring "Edge scope".
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

// ── package walk (mirrors scripts/check-publishable.ts:78-97 verbatim — see
//    module docstring for why this is reproduced rather than imported) ────────
function findPackageJsons(): string[] {
  const out: string[] = [];
  // 'tools' added beyond check-publishable.ts's roots — see module docstring "Roots".
  const roots = ['libs', 'apps', 'extensions', 'packages', 'tools'];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'bundle') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (e.name === 'package.json') {
        out.push(full);
      }
    }
  };
  for (const r of roots) {
    const abs = path.join(root, r);
    if (fs.existsSync(abs)) walk(abs, 0);
  }
  return out;
}

// ── pending changeset packages (mirrors check-publishable.ts:114-146) ─────────
function pendingChangesetPackages(): Set<string> {
  const out = new Set<string>();
  const dir = path.join(root, '.changeset');
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');
  } catch {
    return out;
  }
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!m?.[1]) continue;
    for (const line of m[1].split(/\r?\n/)) {
      const dep = /^\s*["']?(@?[^"':]+)["']?\s*:\s*\w+/.exec(line);
      if (dep?.[1]) out.add(dep[1].trim());
    }
  }
  return out;
}

interface Graph {
  /** package name -> set of package names it depends on via workspace:* */
  dependsOn: Map<string, Set<string>>;
  /** package name -> set of package names that depend on it via workspace:* */
  consumers: Map<string, Set<string>>;
  names: Set<string>;
}

function buildGraph(): Graph {
  const dependsOn = new Map<string, Set<string>>();
  const consumers = new Map<string, Set<string>>();
  const names = new Set<string>();

  for (const pkgPath of findPackageJsons()) {
    let pkg: Pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Pkg;
    } catch {
      continue;
    }
    if (typeof pkg.name !== 'string') continue;
    names.add(pkg.name);
    if (!dependsOn.has(pkg.name)) dependsOn.set(pkg.name, new Set());
    for (const field of DEPENDENCY_FIELDS) {
      for (const [dep, range] of Object.entries(pkg[field] ?? {})) {
        if (!range.startsWith('workspace:')) continue; // only workspace:* edges cascade — see "Edge scope"
        if (field === 'devDependencies' && (range.startsWith('link:') || range.startsWith('file:'))) continue;
        dependsOn.get(pkg.name)!.add(dep);
        if (!consumers.has(dep)) consumers.set(dep, new Set());
        consumers.get(dep)!.add(pkg.name);
      }
    }
  }

  return { dependsOn, consumers, names };
}

/** BFS forward through `consumers` edges: root + everyone who transitively depends on it. */
function transitiveClosure(graph: Graph, targets: string[]): Set<string> {
  const closure = new Set<string>();
  const queue = [...targets];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (closure.has(name)) continue;
    closure.add(name);
    for (const consumer of graph.consumers.get(name) ?? []) {
      if (!closure.has(consumer)) queue.push(consumer);
    }
  }
  return closure;
}

/** Kahn's-algorithm topological sort, dependency-first ("leaves first"), restricted to `subset`. */
function topoSort(graph: Graph, subset: Set<string>): string[] {
  const inDegree = new Map<string, number>();
  for (const name of subset) inDegree.set(name, 0);
  for (const name of subset) {
    for (const dep of graph.dependsOn.get(name) ?? []) {
      if (subset.has(dep)) inDegree.set(name, (inDegree.get(name) ?? 0) + 1);
    }
  }

  const ready = [...subset].filter((n) => inDegree.get(n) === 0).sort();
  const out: string[] = [];
  while (ready.length > 0) {
    const name = ready.shift()!;
    out.push(name);
    for (const consumer of graph.consumers.get(name) ?? []) {
      if (!subset.has(consumer)) continue;
      const remaining = (inDegree.get(consumer) ?? 0) - 1;
      inDegree.set(consumer, remaining);
      if (remaining === 0) {
        ready.push(consumer);
        ready.sort();
      }
    }
  }

  if (out.length !== subset.size) {
    const missing = [...subset].filter((n) => !out.includes(n));
    throw new Error(
      `cascade-plan: dependency cycle detected among ${missing.join(', ')} — cannot compute a ` +
        'publish order. This would also break changesets\' own updateInternalDependencies cascade.',
    );
  }
  return out;
}

/** Runs `changeset status --output=<tmp>` against `root` using THIS repo's own changesets install. */
function changesetStatusReleases(): { ok: true; names: Set<string> } | { ok: false; error: string } {
  const changesetBin = path.resolve(__dirname, '..', 'node_modules', '.bin', 'changeset');
  if (!fs.existsSync(changesetBin)) {
    return { ok: false, error: `changesets binary not found at ${changesetBin} — run pnpm install` };
  }
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-plan-status-')), 'status.json');
  const res = spawnSync(changesetBin, ['status', `--output=${outFile}`], {
    cwd: root,
    encoding: 'utf8',
  });
  if (res.error) return { ok: false, error: `failed to spawn changeset status: ${res.error.message}` };
  if (res.status !== 0) {
    return {
      ok: false,
      error: `changeset status exited ${res.status}: ${res.stderr || res.stdout}`,
    };
  }
  let parsed: { releases?: { name: string }[] };
  try {
    parsed = JSON.parse(fs.readFileSync(outFile, 'utf8')) as { releases?: { name: string }[] };
  } catch (e) {
    return { ok: false, error: `could not parse changeset status --output JSON: ${(e as Error).message}` };
  } finally {
    fs.rmSync(path.dirname(outFile), { recursive: true, force: true });
  }
  return { ok: true, names: new Set((parsed.releases ?? []).map((r) => r.name)) };
}

function main(): void {
  const graph = buildGraph();

  let targets: string[];
  if (packageArg) {
    targets = packageArg.split(',').map((s) => s.trim()).filter(Boolean);
  } else {
    targets = [...pendingChangesetPackages()];
  }

  if (targets.length === 0) {
    console.error(
      'cascade-plan: FAIL — no target package(s). Pass --package <name>, or add a pending ' +
        '.changeset/*.md naming the package(s) you intend to release.',
    );
    process.exit(1);
  }

  const unknown = targets.filter((t) => !graph.names.has(t));
  if (unknown.length > 0) {
    console.error(
      `cascade-plan: FAIL — target package(s) not found in this workspace: ${unknown.join(', ')}`,
    );
    process.exit(1);
  }

  const graphClosure = transitiveClosure(graph, targets);
  const statusResult = changesetStatusReleases();

  if (!statusResult.ok) {
    console.error(`cascade-plan: FAIL — could not cross-check against changeset status: ${statusResult.error}`);
    process.exit(1);
  }

  const changesetClosure = statusResult.names;

  const graphOnly = [...graphClosure].filter((n) => !changesetClosure.has(n)).sort();
  const changesetOnly = [...changesetClosure].filter((n) => !graphClosure.has(n)).sort();

  if (graphOnly.length > 0 || changesetOnly.length > 0) {
    console.error('cascade-plan: FAIL — static-graph closure and changesets-computed closure disagree:');
    if (graphOnly.length > 0) {
      console.error(
        `  - graph walk found these consumers but \`changeset status\` would NOT bump them: ${graphOnly.join(', ')}`,
      );
      console.error(
        '    (a workspace:* edge the static walker sees that changesets does not cascade to — ' +
          'check for a mismatched dependency range, or a package outside changeset\'s workspace detection.)',
      );
    }
    if (changesetOnly.length > 0) {
      console.error(
        `  - \`changeset status\` would bump these but the static graph walk missed them: ${changesetOnly.join(', ')}`,
      );
      console.error(
        '    (this is the dangerous direction: a package that would actually be republished with no ' +
          'proof it was accounted for — investigate before publishing.)',
      );
    }
    process.exit(1);
  }

  const plan = topoSort(graph, graphClosure);

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          targets,
          plan,
          graphClosure: [...graphClosure].sort(),
          changesetClosure: [...changesetClosure].sort(),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`cascade-plan: OK — targets [${targets.join(', ')}] cross-checked against changeset status.`);
    console.log('cascade-plan: publish order (leaves first):');
    for (const [i, name] of plan.entries()) console.log(`  ${i + 1}. ${name}`);
  }
}

main();
