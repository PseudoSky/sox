#!/usr/bin/env node
/**
 * release-consumers.mjs — who breaks if I publish this package?
 *
 * Internal consumers are DERIVED from the workspace. External consumers live in
 * other repos and cannot be derived, so each package declares them itself:
 *
 *   "sox": { "externalConsumers": [
 *     { "name": "@adhd/backlog", "repo": "/Users/nix/dev/node/adhd", "via": "@adhd/sox-graph-store" }
 *   ]}
 *
 * `via` names the intermediate package when the dependency is indirect. An
 * intermediate that pins an EXACT version is a hard stop: a new release is
 * invisible downstream until someone edits that pin, so the chain silently
 * "succeeds" while consumers keep running the old code.
 *
 * USAGE
 *   node tools/release-consumers.mjs                      # every published package
 *   node tools/release-consumers.mjs @adhd/sox-store-adapter
 *   node tools/release-consumers.mjs @adhd/sox-store-adapter --json
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';

const REPO = join(dirname(new URL(import.meta.url).pathname), '..');

function workspacePackages() {
  const out = execFileSync('rg', ['--files', 'libs', '-g', 'package.json', '--glob', '!node_modules'], {
    cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const pkgs = new Map();
  for (const rel of out.split('\n').filter(Boolean)) {
    try {
      const json = JSON.parse(readFileSync(join(REPO, rel), 'utf8'));
      if (!json.name?.startsWith('@adhd/')) continue;
      pkgs.set(json.name, {
        name: json.name,
        version: json.version,
        dir: rel.replace(/\/package\.json$/, ''),
        private: json.private === true,
        deps: { ...json.dependencies, ...json.peerDependencies },
        external: json.sox?.externalConsumers ?? [],
      });
    } catch { /* unreadable manifest — skip, reported by the caller's own gates */ }
  }
  return pkgs;
}

/**
 * Classify a dependency range by WHAT IT BECOMES WHEN PUBLISHED, not by the
 * string in the source manifest (BL-569).
 *
 * `pnpm pack`/`publish` REWRITES the `workspace:` protocol into a real range,
 * and the form of the protocol decides whether the published edge floats:
 *
 *   workspace:*  ->  "1.2.3"    EXACT — frozen at publish time, never floats
 *   workspace:~  ->  "~1.2.3"   floats within the patch range
 *   workspace:^  ->  "^1.2.3"   floats within the compatible range
 *
 * Verified from scratch (two-package throwaway workspace, `pnpm pack`, tarball
 * package.json inspected) — not from recall.
 *
 * This function previously tested `/^\d/` against the SOURCE string. Every
 * internal edge in this repo reads `workspace:*`, which does not start with a
 * digit, so the tool reported ZERO exact pins while 100% of published edges
 * were exact pins — blind in precisely the dimension it exists to check, and
 * its clean output was used to plan a release. Classify the published form.
 */
function classifyRange(range) {
  const s = String(range);

  if (s.startsWith('workspace:')) {
    const proto = s.slice('workspace:'.length);
    if (proto === '*' || proto === '' || /^\d/.test(proto)) {
      return {
        floats: false,
        note: 'workspace:* PUBLISHES AS AN EXACT PIN — downstream freezes at the version current when this package was last published. Use workspace:^',
      };
    }
    // workspace:^ / workspace:~ — publishes as the corresponding float.
    return { floats: true, publishes: proto };
  }

  // A literal range with no floating operator never picks up a new release.
  if (/^\d/.test(s)) {
    return { floats: false, note: 'EXACT PIN: will NOT pick up a new release until edited' };
  }

  // `^0.x.y` only floats within the minor — a 0.x MINOR bump is still a
  // required follow-up bump downstream, not an optional one. Callers plan
  // releases off this output, so say it rather than render it as "floats".
  const caretZero = /^\^0\.(\d+)\./.exec(s);
  if (caretZero) {
    return {
      floats: true,
      minorBumpBreaksFloat: true,
      note: `floats within 0.${caretZero[1]}.x only — a 0.x MINOR bump requires editing this range`,
    };
  }

  return { floats: true };
}

/** Reverse edges: package -> [{name, range, ...classification}] that depend on it. */
function consumerIndex(pkgs) {
  const idx = new Map();
  for (const p of pkgs.values()) {
    for (const [dep, range] of Object.entries(p.deps ?? {})) {
      if (!pkgs.has(dep)) continue;
      if (!idx.has(dep)) idx.set(dep, []);
      const cls = classifyRange(range);
      idx.get(dep).push({ name: p.name, range, ...cls, exactPin: !cls.floats });
    }
  }
  return idx;
}

function report(target, pkgs, idx, seen = new Set(), depth = 0) {
  if (seen.has(target)) return [];
  seen.add(target);
  const rows = [];
  for (const c of idx.get(target) ?? []) {
    rows.push({ ...c, depth, kind: 'internal' });
    rows.push(...report(c.name, pkgs, idx, seen, depth + 1));
  }
  for (const e of pkgs.get(target)?.external ?? []) {
    rows.push({ name: e.name, repo: e.repo, via: e.via, depth, kind: 'external' });
  }
  return rows;
}

const pkgs = workspacePackages();
const idx = consumerIndex(pkgs);
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const targets = args.filter((a) => !a.startsWith('--'));
const list = targets.length ? targets : [...pkgs.keys()].filter((n) => !pkgs.get(n).private).sort();

const result = {};
for (const t of list) {
  if (!pkgs.has(t)) { console.error(`unknown package: ${t}`); process.exit(2); }
  result[t] = report(t, pkgs, idx);
}

if (asJson) { console.log(JSON.stringify(result, null, 2)); process.exit(0); }

for (const [t, rows] of Object.entries(result)) {
  const p = pkgs.get(t);
  console.log(`\n${t}  ${p.version}${p.private ? '  (private)' : ''}`);
  if (!rows.length) { console.log('  (no consumers)'); continue; }
  for (const r of rows) {
    const pad = '  ' + '  '.repeat(r.depth);
    if (r.kind === 'external') {
      console.log(`${pad}EXTERNAL ${r.name}${r.via ? `  via ${r.via}` : ''}${r.repo ? `  [${r.repo}]` : ''}`);
    } else {
      const flag = r.note ? `   <-- ${r.note}` : '';
      console.log(`${pad}${r.name}  ${r.range}${flag}`);
    }
  }
}

// A frozen edge anywhere in the tree silently invalidates the whole release:
// downstream keeps executing the old code while every step reports success.
// Exit non-zero so `pnpm release` (which runs this before `changeset publish`)
// refuses to proceed rather than shipping a chain that cannot land.
const frozen = Object.entries(result).flatMap(([t, rows]) =>
  rows.filter((r) => r.kind === 'internal' && !r.floats).map((r) => `${t} <- ${r.name} (${r.range})`),
);
if (frozen.length) {
  console.error(`\n✗ ${frozen.length} non-floating internal edge(s) — a release here does NOT reach consumers:`);
  for (const f of frozen) console.error(`    ${f}`);
  console.error('  Fix the range (workspace:^) or schedule the follow-up bumps explicitly.');
  process.exit(1);
}
