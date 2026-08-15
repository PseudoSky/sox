#!/usr/bin/env node
/**
 * snapshot-gc.mjs — retention reporting for pre-operation memory.db snapshots
 * under ~/.adhd/sox-ecosystem/memory/, per docs/decisions/0014-memory-snapshot-retention-policy.md.
 *
 * REPORT MODE ONLY. There is no --apply in this version, deliberately: ADR-0014
 * D5 states apply must not ship before a restore path is PROVEN, and as of this
 * writing that proof (BUG-MEMORY-SNAPSHOT-NO-RESTORE-PATH-001) exists only for
 * two of the ~15 directories on disk (see docs/reporting/memory/findings/
 * 2026-08-15-offline-vacuum-runbook-integrity-cap.md). Passing --apply prints
 * an explanation and exits non-zero rather than silently no-op'ing.
 *
 * This tool DELETES NOTHING. It only reads directory metadata (name, mtime)
 * and reports a classification + eligibility table.
 *
 * Policy (ADR-0014 D1/D2/D3):
 *   - Only 4 classes are ever classified: predeploy, prerebuild, preenable,
 *     prerestart. Everything else is reported as `unclassified` and is
 *     PERMANENTLY out of scope for automated retention (ADR-0014 D1) — never
 *     shown as eligible, regardless of any future --apply implementation.
 *   - Within a class: the single most-recent entry is always `protected`,
 *     unconditionally, regardless of age (ADR-0014 D2.1).
 *   - Count floor N=3: entries are only eligible once at least 3 newer
 *     siblings exist in the same class (ADR-0014 D2.2).
 *   - Age floor: 14 days (ADR-0014 D2.3). Both floors are AND-gated —
 *     an entry must clear both to be `eligible`.
 *   - Settling window: 10 minutes (ADR-0014 D3.2) — entries newer than this
 *     are excluded from class enumeration entirely (not protected, not
 *     eligible, not counted toward the count floor) so a `cp -r` still in
 *     flight is never mis-evaluated in either direction.
 *
 * Usage:
 *   node tools/snapshot-gc.mjs [--dir <path>] [--json]
 *   node tools/snapshot-gc.mjs --apply     # refuses, explains why, exit 1
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_DIR = join(homedir(), '.adhd', 'sox-ecosystem', 'memory');
const COUNT_FLOOR = 3;
const AGE_FLOOR_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const SETTLING_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

// Anchored patterns (ADR-0014 D1), each tolerating an optional ticket/stage
// prefix observed on disk (`bl331-predeploy-...`, `s5-preenable-...`).
const CLASS_PATTERNS = [
  { cls: 'predeploy', re: /^(?:[a-z0-9]+-)?predeploy-(\d{8}-\d{6})$/i },
  { cls: 'prerebuild', re: /^(?:[a-z0-9]+-)?pre(?:re)?build-(\d{8}-\d{6})$/i },
  { cls: 'preenable', re: /^(?:[a-z0-9]+-)?(?:[a-z0-9]+-)?preenable-(\d{8}-\d{6})$/i },
  { cls: 'prerestart', re: /^(?:[a-z0-9]+-)?prerestart-(\d{8}-\d{6})$/i },
];

function classify(name) {
  for (const { cls, re } of CLASS_PATTERNS) {
    const m = re.exec(name);
    if (m) return { cls, tsToken: m[1] };
  }
  return null;
}

function parseArgs(argv) {
  const opts = { dir: DEFAULT_DIR, json: false, apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') opts.dir = argv[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--apply') opts.apply = true;
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.apply) {
    console.error(
      '[snapshot-gc] --apply is NOT implemented in this version.\n' +
        '  ADR-0014 D5: apply may not ship before a restore path is proven for the class of\n' +
        '  directories being pruned. Proof exists today (tools/prove-snapshot-restore.mjs) for\n' +
        '  2 of ~15 directories on disk. Run report mode (the default) instead:\n' +
        '    node tools/snapshot-gc.mjs\n' +
        '  See docs/decisions/0014-memory-snapshot-retention-policy.md and\n' +
        '  BUG-MEMORY-SNAPSHOT-NO-RESTORE-PATH-001.',
    );
    process.exit(1);
  }

  const now = Date.now();
  let entries;
  try {
    entries = readdirSync(opts.dir, { withFileTypes: true });
  } catch (err) {
    console.error(`[snapshot-gc] cannot read ${opts.dir}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const byClass = new Map(); // cls -> array of {name, mtimeMs, ageMs}
  const unclassified = [];
  const provisional = []; // within settling window — excluded entirely from enumeration

  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue; // loose .mjs scripts etc. are never in scope
    const name = dirent.name;
    const full = join(opts.dir, name);
    let mtimeMs;
    try {
      mtimeMs = statSync(full).mtimeMs;
    } catch {
      continue; // vanished between readdir and stat — skip, do not guess
    }
    const ageMs = now - mtimeMs;

    const cls = classify(name);
    if (!cls) {
      unclassified.push({ name, mtimeMs, age_days: +(ageMs / 86400000).toFixed(1) });
      continue;
    }
    if (ageMs < SETTLING_WINDOW_MS) {
      provisional.push({ name, class: cls.cls, mtimeMs, age_seconds: Math.round(ageMs / 1000) });
      continue;
    }
    if (!byClass.has(cls.cls)) byClass.set(cls.cls, []);
    byClass.get(cls.cls).push({ name, mtimeMs, ageMs });
  }

  const classReports = [];
  for (const [cls, list] of byClass) {
    // Most-recent first.
    list.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const rows = list.map((e, idx) => {
      const isMostRecent = idx === 0;
      const newerSiblingCount = idx; // entries before this one in sorted-desc order
      const clearsCountFloor = newerSiblingCount >= COUNT_FLOOR;
      const clearsAgeFloor = e.ageMs > AGE_FLOOR_MS;
      const eligible = !isMostRecent && clearsCountFloor && clearsAgeFloor;
      return {
        name: e.name,
        age_days: +(e.ageMs / 86400000).toFixed(1),
        rank_from_newest: idx,
        protected_most_recent: isMostRecent,
        newer_sibling_count: newerSiblingCount,
        clears_count_floor: clearsCountFloor,
        clears_age_floor: clearsAgeFloor,
        status: isMostRecent ? 'protected' : eligible ? 'eligible' : 'kept',
      };
    });
    classReports.push({
      class: cls,
      count: list.length,
      protected_most_recent: rows[0]?.name ?? null,
      eligible_count: rows.filter((r) => r.status === 'eligible').length,
      entries: rows,
    });
  }
  classReports.sort((a, b) => a.class.localeCompare(b.class));

  const report = {
    dir: opts.dir,
    generated_at: new Date(now).toISOString(),
    policy: {
      count_floor: COUNT_FLOOR,
      age_floor_days: AGE_FLOOR_MS / 86400000,
      settling_window_minutes: SETTLING_WINDOW_MS / 60000,
    },
    classes: classReports,
    total_eligible: classReports.reduce((s, c) => s + c.eligible_count, 0),
    unclassified_out_of_scope: unclassified.sort((a, b) => a.name.localeCompare(b.name)),
    provisional_excluded_from_enumeration: provisional,
  };

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`snapshot-gc report — ${opts.dir}`);
  console.log(`policy: count_floor=${COUNT_FLOOR} age_floor=${report.policy.age_floor_days}d settling_window=${report.policy.settling_window_minutes}m\n`);
  if (classReports.length === 0) {
    console.log('(no directories matched any of the 4 validated classes: predeploy/prerebuild/preenable/prerestart)');
  }
  for (const c of classReports) {
    console.log(`[${c.class}] ${c.count} snapshot(s), ${c.eligible_count} eligible for prune`);
    for (const r of c.entries) {
      const tag = r.status === 'protected' ? 'PROTECTED (most-recent, never pruned)' : r.status === 'eligible' ? 'ELIGIBLE' : 'kept (floor not cleared)';
      console.log(`  ${r.name}  age=${r.age_days}d  newer_siblings=${r.newer_sibling_count}  -> ${tag}`);
    }
    console.log('');
  }
  console.log(`TOTAL ELIGIBLE (report only — no --apply implemented): ${report.total_eligible}`);
  console.log(`\nOut of scope, never touched (${report.unclassified_out_of_scope.length}): ${report.unclassified_out_of_scope.map((u) => u.name).join(', ') || '(none)'}`);
  if (report.provisional_excluded_from_enumeration.length > 0) {
    console.log(`\nProvisional (within ${report.policy.settling_window_minutes}m settling window, excluded from all counting): ${report.provisional_excluded_from_enumeration.map((p) => p.name).join(', ')}`);
  }
}

main();
