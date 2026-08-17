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

/** Reverse edges: package -> [{name, range, exactPin}] that depend on it. */
function consumerIndex(pkgs) {
  const idx = new Map();
  for (const p of pkgs.values()) {
    for (const [dep, range] of Object.entries(p.deps ?? {})) {
      if (!pkgs.has(dep)) continue;
      if (!idx.has(dep)) idx.set(dep, []);
      idx.get(dep).push({
        name: p.name,
        range,
        // An exact pin (no ^ or ~) does NOT float. Downstream stays on the old
        // version until the pin is edited — the most common silent-skip in a
        // multi-hop release chain.
        exactPin: /^\d/.test(String(range)),
      });
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
      console.log(`${pad}${r.name}  ${r.range}${r.exactPin ? '   <-- EXACT PIN: will NOT pick up a new release until edited' : ''}`);
    }
  }
}
