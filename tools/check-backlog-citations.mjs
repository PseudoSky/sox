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
  const staleAllowlistEntries = []; // allowlist entries for ids that now DO resolve (or no longer cited)

  for (const [id, refs] of byId) {
    if (ids.has(id)) continue; // resolves fine
    if (Object.prototype.hasOwnProperty.call(allowlist, id)) {
      allowlisted.push({ id, refs, reason: allowlist[id].reason });
    } else {
      unresolved.push({ id, refs });
    }
  }

  const ID_KEY_PATTERN = /^[A-Z]+-\d{1,4}$/;
  for (const id of Object.keys(allowlist)) {
    if (!ID_KEY_PATTERN.test(id)) continue; // e.g. "_readme" — metadata, not an id entry
    if (ids.has(id)) {
      staleAllowlistEntries.push({ id, note: 'now resolves in the graph — remove from allowlist' });
    } else if (!byId.has(id)) {
      staleAllowlistEntries.push({ id, note: 'no longer cited anywhere in tracked source — remove from allowlist' });
    }
  }

  unresolved.sort((a, b) => b.refs.length - a.refs.length);

  const summary = {
    repo: opts.repo,
    totalCitations: citations.length,
    distinctIdsCited: byId.size,
    graphIdsKnown: ids.size,
    unresolvedCount: unresolved.length,
    unresolvedRefCount: unresolved.reduce((s, u) => s + u.refs.length, 0),
    allowlistedCount: allowlisted.length,
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
    } else {
      console.log('');
      console.log('PASS: every cited id resolves in the graph or is explicitly allowlisted.');
    }
  }

  process.exit(unresolved.length > 0 ? 1 : 0);
}

main();
