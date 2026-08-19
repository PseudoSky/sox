#!/usr/bin/env node
/**
 * check-backlog-citations.mjs
 *
 * Extracts every \b(BL|BUG|DEBT)-[0-9]{1,4}\b reference from tracked source
 * and fails if any of them do not resolve to a real item in the backlog
 * graph (`backlog export-json`). This is the CI-actionable form of the audit
 * that produced DEBT-006: 514 references to 48 distinct ids across 139
 * tracked files resolved to nothing in the graph.
 *
 * Three known causes an id can legitimately fail to resolve without being a
 * bug (see DEBT-006 body):
 *   (A) INVENTED ids   — an agent guessed a future id above the allocation
 *       high-water mark. Always a real defect; never allowlist these.
 *   (B) PLAN-LOCAL ids — a plan directory (e.g.
 *       docs/plan/bug014-store-hardening/) defines its own numbering that
 *       collides with a graph family (BUG-*, DEBT-*). These ARE legitimate,
 *       but must be recorded in the allowlist with an explanatory note so a
 *       reader (human or agent) can tell "not in the graph, and that's
 *       intentional" from "not in the graph, and that's a bug".
 *   (C) MIGRATION-DROPPED ids — existed in the pre-graph BACKLOG.md at
 *       deletion time but were never carried into the graph by the
 *       2026-08-06 migration. Recoverable candidates should be re-filed
 *       (deduped against the graph first) rather than allowlisted forever.
 *
 * Usage:
 *   node tools/check-backlog-citations.mjs [--repo <name>] [--allowlist <path>]
 *        [--json] [--no-graph-fetch]
 *
 * Exit code: 0 if every non-allowlisted id resolves in the graph, 1 otherwise.
 *
 * Dependencies: node builtins + `rg` (ripgrep) + the `backlog` CLI already
 * installed on this machine (`~/Library/pnpm/backlog`). No npm packages.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const ID_PATTERN = '\\b(BL|BUG|DEBT)-[0-9]{1,4}\\b';

function parseArgs(argv) {
  const opts = {
    repo: 'sox-ecosystem',
    allowlist: path.join(__dirname, 'backlog-citation-allowlist.json'),
    json: false,
    noGraphFetch: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') opts.repo = argv[++i];
    else if (a === '--allowlist') opts.allowlist = path.resolve(argv[++i]);
    else if (a === '--json') opts.json = true;
    else if (a === '--no-graph-fetch') opts.noGraphFetch = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node tools/check-backlog-citations.mjs [--repo <name>] [--allowlist <path>] [--json] [--no-graph-fetch]',
      );
      process.exit(0);
    }
  }
  return opts;
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
    ...opts,
  });
}

// --- 1. tracked file set (git ls-files never includes .gitignore'd/untracked cruft) ---
function trackedFileSet() {
  const out = sh('git', ['ls-files', '-z']);
  return new Set(out.split('\0').filter(Boolean));
}

// --- 2. every id occurrence, via a single ripgrep pass over the working tree ---
// rg already honors .gitignore; we additionally intersect with `git ls-files`
// so a locally-untracked-but-unignored scratch file can never fail the gate.
function findCitations(trackedSet) {
  let raw;
  try {
    raw = sh('rg', [
      '-n', // line numbers
      '-o', // only the match
      '-I', // no filenames baked into -o output confusion; we add --with-filename explicitly
      '--with-filename',
      '--no-heading',
      '-e',
      ID_PATTERN,
      '.',
    ]);
  } catch (err) {
    // rg exits 1 when there are zero matches anywhere — not an error for us.
    if (err.status === 1 && !err.stdout) return [];
    if (err.stdout) raw = err.stdout;
    else throw err;
  }

  const citations = []; // { id, file, line }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    // format: <path>:<line>:<match>
    const m = line.match(/^(.*?):(\d+):([A-Z]+-\d{1,4})$/);
    if (!m) continue;
    const [, file, lineNo, id] = m;
    const relFile = file.startsWith('./') ? file.slice(2) : file;
    if (!trackedSet.has(relFile)) continue; // untracked/ignored — not in scope
    if (relFile === 'tools/check-backlog-citations.mjs') continue; // this file's own docstring
    // The allowlist's own `reason` prose cites ids while EXPLAINING them
    // (e.g. "originally filed in ... BL-276..BL-295"). Scanning it makes the
    // gate permanently red for a self-inflicted reason — and a check that is
    // always failing is a check everyone learns to ignore, which is the exact
    // failure mode this gate exists to prevent.
    if (relFile === 'tools/backlog-citation-allowlist.json') continue;
    citations.push({ id, file: relFile, line: Number(lineNo) });
  }
  return citations;
}

// --- 3. graph ids, straight from the backlog CLI (the graph is the source of truth) ---
function graphIds(repo) {
  const raw = sh('backlog', ['export-json', '--filter', JSON.stringify({ repo })], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // The CLI logs a trailing pino line to stderr in some invocations; stdout
  // should be clean JSON, but guard against a stray trailing line anyway by
  // parsing only the leading JSON array.
  const trimmed = raw.trim();
  const items = JSON.parse(trimmed);
  return new Set(items.map((it) => it.humanId));
}

// --- 4. allowlist ---
// Shape: { "<ID>": { reason: string, addedAt?: string, addedBy?: string } }
function loadAllowlist(allowlistPath) {
  if (!existsSync(allowlistPath)) return {};
  const raw = readFileSync(allowlistPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Malformed allowlist JSON at ${allowlistPath}: ${err.message}`);
  }
}

// --- 5. collision detection (extracted so DEBT-008's regression test can
// drive it directly with fabricated byId/allowlist/graphIds inputs, with no
// git/rg/backlog subprocess involved) ---
//
// A PLAN-LOCAL id that LATER gets allocated as a real graph id is the most
// dangerous state this gate can encounter, and the naive reading of it is
// exactly backwards. Before this check existed, the gate reported such an
// entry as "now resolves in the graph — remove from allowlist": deleting
// the entry would have made every plan-local citation silently "resolve"
// to an unrelated graph item that happens to share the string.
//
// Concrete case that motivated this (measured 2026-08-18): allowlisted
// BUG-019 is docs/plan/bug014-store-hardening/SPEC.md T5, "refcounted
// per-connection open marker". The graph then allocated its own BUG-019,
// "wal-cap backstop's PASSIVE checkpoint fails under sustained load".
// Two unrelated defects, one string, 60+ citations in store-adapter — and
// the gate was advising that they be blessed as correct.
//
// So: a collision is a FAILURE, not a cleanup note. Citations from INSIDE
// the owning plan directory keep their plan-local meaning and are fine.
// Citations from anywhere else are genuinely ambiguous and must be
// repointed at the id the work actually landed under.
//
// This is also DEBT-008's own enforcement surface: DEBT-008's actual fix is
// the new BUG014.T<n>-style syntax (see docs/plan/bug014-store-hardening/
// SPEC.md's PLAN-LOCAL IDS banner) which never matches ID_PATTERN at all, so
// a plan-local citation written that way is never even collected into
// `byId` — there is nothing for this function to flag. This collision
// detector is the backstop for the population that predates that fix (the
// allowlisted entries below) and for any future author who reverts to the
// bare `BUG-0NN` form despite the banner: THAT citation still lands in
// `byId`, and if its id is later allocated in the graph, this function
// reports it exactly as it does today.
const ID_KEY_PATTERN = /^[A-Z]+-\d{1,4}$/;

function computeCollisions({ byId, allowlist, graphIds }) {
  const collisions = [];
  const staleAllowlistEntries = [];
  for (const id of Object.keys(allowlist)) {
    if (!ID_KEY_PATTERN.test(id)) continue; // e.g. "_readme" — metadata, not an id entry
    const entry = allowlist[id];
    const planDir = entry.planDir ?? null;

    if (graphIds.has(id)) {
      // EVERY allowlisted id that later resolves in the graph is a collision,
      // whatever its `cause`. An allowlist entry exists precisely to assert
      // "this citation does NOT mean a graph item" — so the moment the graph
      // allocates that number, the entry and the graph disagree about what
      // the string means, and every citation inherits the ambiguity.
      //
      // `planDir` names the directory that legitimately owns the local
      // meaning, if one does; refs inside it keep that meaning and pass.
      // With no planDir there is no owning scope, so every ref is ambiguous.
      //
      // `disambiguatedRefs` is the escape hatch for a reference that MUST
      // keep the old string — a historical incident record, where rewriting
      // the id would falsify what was actually written at the time, OR a
      // site independently VERIFIED (e.g. via `backlog get-item`) to already
      // mean the current graph item correctly, so no rewrite is needed.
      // Listing a file there asserts the ambiguity is resolved for that
      // site. It is deliberately per-file and not a blanket suppression.
      const refs = byId.get(id) ?? [];
      const disambiguated = new Set(entry.disambiguatedRefs ?? []);
      const ambiguous = refs.filter(
        (r) => !(planDir && r.file.startsWith(`${planDir}/`)) && !disambiguated.has(r.file),
      );
      collisions.push({ id, planDir, entry, refs, ambiguous });
    } else if (!byId.has(id)) {
      staleAllowlistEntries.push({ id, note: 'no longer cited anywhere in tracked source — remove from allowlist' });
    }
  }
  const blockingCollisions = collisions.filter((c) => c.ambiguous.length > 0);
  return { collisions, blockingCollisions, staleAllowlistEntries };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  const tracked = trackedFileSet();
  const citations = findCitations(tracked);

  const byId = new Map(); // id -> [{file,line}]
  for (const c of citations) {
    if (!byId.has(c.id)) byId.set(c.id, []);
    byId.get(c.id).push({ file: c.file, line: c.line });
  }

  let ids;
  if (opts.noGraphFetch) {
    ids = new Set();
  } else {
    ids = graphIds(opts.repo);
  }

  const allowlist = loadAllowlist(opts.allowlist);

  const unresolved = []; // ids with zero graph match and not allowlisted
  const allowlisted = []; // ids with zero graph match but explicitly allowlisted

  for (const [id, refs] of byId) {
    if (ids.has(id)) continue; // resolves fine
    if (Object.prototype.hasOwnProperty.call(allowlist, id)) {
      allowlisted.push({ id, refs, reason: allowlist[id].reason });
    } else {
      unresolved.push({ id, refs });
    }
  }

  const { collisions, blockingCollisions, staleAllowlistEntries } = computeCollisions({
    byId,
    allowlist,
    graphIds: ids,
  });

  unresolved.sort((a, b) => b.refs.length - a.refs.length);

  const summary = {
    repo: opts.repo,
    totalCitations: citations.length,
    distinctIdsCited: byId.size,
    graphIdsKnown: ids.size,
    unresolvedCount: unresolved.length,
    unresolvedRefCount: unresolved.reduce((s, u) => s + u.refs.length, 0),
    allowlistedCount: allowlisted.length,
    collisionCount: collisions.length,
    blockingCollisionCount: blockingCollisions.length,
    ambiguousRefCount: blockingCollisions.reduce((s, c) => s + c.ambiguous.length, 0),
    staleAllowlistEntries,
  };

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          summary,
          unresolved: unresolved.map((u) => ({
            id: u.id,
            refCount: u.refs.length,
            files: [...new Set(u.refs.map((r) => r.file))],
            sample: u.refs.slice(0, 5),
          })),
          allowlisted: allowlisted.map((a) => ({ id: a.id, refCount: a.refs.length, reason: a.reason })),
          collisions: collisions.map((c) => ({
            id: c.id,
            planDir: c.planDir,
            totalRefs: c.refs.length,
            ambiguousRefCount: c.ambiguous.length,
            ambiguousFiles: [...new Set(c.ambiguous.map((r) => r.file))],
          })),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`backlog citation check — repo=${opts.repo}`);
    console.log(`  tracked citations scanned : ${summary.totalCitations}`);
    console.log(`  distinct ids cited        : ${summary.distinctIdsCited}`);
    console.log(`  graph ids known           : ${summary.graphIdsKnown}`);
    console.log(`  allowlisted (plan-local)  : ${summary.allowlistedCount}`);
    console.log(`  UNRESOLVED ids            : ${summary.unresolvedCount} (${summary.unresolvedRefCount} refs)`);
    console.log(
      `  NAMESPACE COLLISIONS      : ${summary.blockingCollisionCount} (${summary.ambiguousRefCount} ambiguous refs)`,
    );
    if (collisions.length) {
      console.log('');
      console.log('ALLOWLIST / GRAPH ID COLLISIONS:');
      console.log('  These ids are allowlisted as NOT meaning a graph item, yet the graph has');
      console.log('  since allocated that same number. A citation outside the owning scope is');
      console.log('  ambiguous: a reader (human or agent) resolves it to the graph item and');
      console.log('  gets an unrelated defect.');
      for (const c of collisions) {
        const files = [...new Set(c.ambiguous.map((r) => r.file))];
        console.log('');
        console.log(
          `  ${c.id}  [${c.entry.cause ?? 'no cause'}] — owning scope: ${c.planDir ?? '(none — every ref is ambiguous)'}`,
        );
        console.log(`      allowlisted meaning: ${String(c.entry.reason ?? '').slice(0, 140)}`);
        console.log(`      ambiguous refs     : ${c.ambiguous.length} of ${c.refs.length} total`);
        for (const f of files.slice(0, 8)) console.log(`        - ${f}`);
        if (files.length > 8) console.log(`        ... and ${files.length - 8} more files`);
      }
    }
    if (staleAllowlistEntries.length) {
      console.log('');
      console.log('STALE ALLOWLIST ENTRIES (safe to remove):');
      for (const s of staleAllowlistEntries) console.log(`  - ${s.id}: ${s.note}`);
    }
    if (unresolved.length) {
      console.log('');
      console.log('UNRESOLVED IDS (cited in tracked source, absent from the graph):');
      for (const u of unresolved) {
        const files = [...new Set(u.refs.map((r) => r.file))];
        console.log(`  ${u.id}  (${u.refs.length} refs, ${files.length} files)`);
        for (const f of files.slice(0, 5)) console.log(`      - ${f}`);
        if (files.length > 5) console.log(`      ... and ${files.length - 5} more files`);
      }
      console.log('');
      console.log(
        `FAIL: ${unresolved.length} id(s) cited in tracked source do not resolve in the backlog graph.`,
      );
      console.log(
        `      If genuinely plan-local, add to ${path.relative(REPO_ROOT, opts.allowlist)} with a reason.`,
      );
      console.log('      Otherwise: invented id (fix the citation) or migration-dropped (re-file in the graph).');
    } else if (!blockingCollisions.length) {
      console.log('');
      console.log('PASS: every cited id resolves in the graph or is explicitly allowlisted.');
    }
    if (blockingCollisions.length) {
      console.log('');
      console.log(
        `FAIL: ${blockingCollisions.length} allowlisted id(s) collide with a real graph id and are ` +
          `cited from ${summary.ambiguousRefCount} place(s) outside their own owning scope.`,
      );
      console.log('      Fix by repointing each citation at the id the work ACTUALLY landed under,');
      console.log('      by filing a real graph item for it, or — for a historical record that must');
      console.log('      keep the old string — by disambiguating it inline. Deleting the allowlist');
      console.log('      entry is NOT the fix: that silently blesses the citation as correct when it');
      console.log('      now points at an unrelated item.');
    }
  }

  process.exit(unresolved.length > 0 || blockingCollisions.length > 0 ? 1 : 0);
}

export { ID_PATTERN, computeCollisions };

// Only run as a CLI when executed directly — importing this module (e.g.
// from tools/check-backlog-citations.debt008.test.mjs) must not shell out to
// git/rg/backlog or call process.exit().
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
