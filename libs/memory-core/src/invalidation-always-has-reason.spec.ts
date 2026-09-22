/**
 * invalidation-always-has-reason.spec.ts — 2026-09-22 re-review finding 3,
 * plan §2.1 durable guard. REVISED 2026-09-22 (second re-review, finding A)
 * after a blind reviewer found three real holes in the first version.
 *
 * d3d97584 removed the ONE automatic, anonymous `t_invalid` writer this repo
 * had (`applyNearDupResult` in enrich.ts) — the pass that destroyed 685 pairs
 * / ~1.1MB / 3,273 edges with no reason and no SUPERSEDES edge before anyone
 * noticed. That fix pins the ONE call site it touched. Nothing stops a
 * DIFFERENT function — today or in a future change — from adding its own
 * anonymous invalidation and reintroducing the exact same failure mode
 * somewhere else, invisibly.
 *
 * WHAT THIS SCAN COVERS (be exact — the first version of this guard
 * overstated its own reach, which a blind reviewer caught):
 *
 *   1. SCOPE — three roots, walked RECURSIVELY (subdirectories included),
 *      skipping `node_modules`/`dist`, `.ts` files only, excluding
 *      `*.spec.ts`/`*.test.ts`:
 *        - libs/memory-core/src
 *        - libs/data/graph/graph-store/src
 *        - extensions/bundles/sox-memory-bundle/members/*\/src (every bundle
 *          member — memory-cli, memory-flush, memory-server, memory-usage —
 *          added after finding A caught a LIVE unscanned writer in
 *          memory-flush/src/index.ts:270, same store, same bundle, previously
 *          invisible because it sat outside both original SCAN_DIRS AND the
 *          original scan was non-recursive besides)
 *      Anything OUTSIDE these three roots — other extensions, other libs,
 *      apps/, built dist/ artifacts — is NOT scanned. A writer introduced
 *      there is a real, current blind spot.
 *
 *   2. RAW SQL — any `UPDATE node|edge SET ... t_invalid = <non-NULL>`
 *      appearing ANYWHERE in a scanned file's text (not line-by-line — the
 *      first version's line-by-line regex missed any statement whose
 *      template literal spans multiple physical lines; this version searches
 *      whole-file text with a bounded lazy span between `UPDATE` and
 *      `t_invalid` so `SET meta = ?, t_invalid = ?` in either column order,
 *      across any number of lines, still matches). Matches ANY non-NULL
 *      binding style — `?`, `:name`, `$1`, or even a literal value — not
 *      just `?`. Still correctly excludes `t_invalid = NULL` (revival) and
 *      `t_invalid IS NULL`/`IS NOT NULL` (predicates) — those don't destroy
 *      anything.
 *
 *   3. GRAPHBACKEND-MEDIATED CALLS — a SEPARATE scan for `.invalidate(` /
 *      `.invalidateEdge(` call expressions in every scanned file EXCEPT
 *      graph-store/src/index.ts itself (where those methods are DEFINED —
 *      their own raw SQL is already caught by scan #2, and their internal
 *      delegation to each other would otherwise self-flag). This is the gap
 *      the first version missed entirely: a future automatic pass reaching
 *      for the ALREADY-ALLOWLISTED `GraphBackend.invalidate()` primitive
 *      instead of writing its own SQL would have been completely invisible.
 *      Today this scan finds ZERO production call sites outside graph-store
 *      (every existing caller is in a `*.spec.ts` file, excluded) — this is
 *      a forward guard, not a pin on existing behavior.
 *
 * WHAT THIS SCAN CANNOT DETECT (stated as a known gap, not implied covered):
 *   - Any invalidation outside the three scanned roots.
 *   - A GraphBackend-mediated call routed through an intermediate alias/
 *     wrapper (`const inv = backend.invalidate; inv(...)`) or dynamic
 *     dispatch (`backend['invalidate'](...)`) — the regex matches a literal
 *     `.invalidate(`/`.invalidateEdge(` token sequence only.
 *   - Invalidation performed by a codepath that never contains the literal
 *     substrings this scan looks for at all (e.g. a raw HTTP call to a
 *     remote store bypassing the adapter). This is a source-text scan, not a
 *     runtime trace or a type-level proof.
 *   - A brand-new SQL verb/column-rename shape not yet observed in this
 *     codebase (e.g. if `t_invalid` were ever renamed).
 *
 * This is an ATTRIBUTABILITY guard, not a semantic proof that every writer
 * records a reason — `gcOrphanedCommunityState` and the cluster/session
 * cleanup paths below are structural GC, not intent-carrying user actions,
 * and record no reason today. Its job is: a new writer within its reach
 * FAILS this test immediately, by file/line/function, rather than shipping
 * silently. Extending the allowlist is a deliberate, reviewed, one-line diff.
 *
 * The test also fails if an allowlisted entry NO LONGER APPEARS in source
 * (stale entry) — the allowlist is kept pinned to reality in both
 * directions, not just a permissive superset.
 *
 * Gate: npx nx test memory-core --skip-nx-cache -- invalidation-always-has-reason
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');

function listMemoryBundleMemberSrcDirs(): string[] {
  const membersDir = path.join(ROOT, 'extensions/bundles/sox-memory-bundle/members');
  if (!fs.existsSync(membersDir)) return [];
  return fs
    .readdirSync(membersDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(membersDir, d.name, 'src'))
    .filter((p) => fs.existsSync(p));
}

const SCAN_DIRS = [
  path.join(ROOT, 'libs/memory-core/src'),
  path.join(ROOT, 'libs/data/graph/graph-store/src'),
  ...listMemoryBundleMemberSrcDirs(),
];

/** Directories never descended into, anywhere under a scanned root. */
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', '.git']);

/** Recursively list every scannable `.ts` source file (excludes *.spec.ts / *.test.ts). */
function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      out.push(...walkTsFiles(path.join(dir, entry.name)));
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.test.ts')
    ) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/**
 * Raw SQL invalidation write — whole-file, multi-line aware. Bounded lazy
 * span (max 300 chars) between `UPDATE node|edge SET` and `t_invalid =` so a
 * column reordering (`SET meta = ?, t_invalid = ?`) or a statement split
 * across lines still matches, without matching all the way into an unrelated
 * later UPDATE statement. Excludes `t_invalid = NULL` (revival).
 */
const RAW_SQL_INVALIDATE_RE =
  /UPDATE\s+(?:node|edge)\b[\s\S]{0,300}?\bt_invalid\s*=(?!\s*NULL\b)\s*/gi;

/** A `.invalidate(` / `.invalidateEdge(` call expression (GraphBackend-mediated invalidation). */
const GRAPHBACKEND_CALL_RE = /\.(invalidate|invalidateEdge)\s*\(/g;

/**
 * Matches a function/method declaration line: `function name(...)`,
 * `export async function name(...)`, or a class method
 * `[private|public|protected|static] [async] name(...): ReturnType {`.
 * Single-line only — a declaration split across multiple lines attributes to
 * the NEXT declaration walking backward, which still lands inside the same
 * class/file and is caught by a human reviewing a new allowlist entry.
 */
const FN_DECL_RE =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:private\s+|public\s+|protected\s+|static\s+)*(?:async\s+)?(\w+)\s*\([^)]*\)\s*:\s*(?:Promise|void|[A-Za-z0-9_<>[\], .]+)\s*\{)/;

interface InvalidationSite {
  file: string; // relative to repo root
  line: number; // 1-based, of the MATCH START
  fn: string | null;
  via: 'raw-sql' | 'graphbackend-call';
}

function lineNumberForIndex(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

function findEnclosingFunction(lines: string[], matchLineIdx: number): string | null {
  for (let i = matchLineIdx; i >= 0; i--) {
    const m = FN_DECL_RE.exec(lines[i]!);
    if (m) return m[1] ?? m[2] ?? null;
  }
  return null;
}

function scanFile(full: string): InvalidationSite[] {
  const content = fs.readFileSync(full, 'utf8');
  const lines = content.split('\n');
  const rel = path.relative(ROOT, full);
  const sites: InvalidationSite[] = [];

  for (const m of content.matchAll(RAW_SQL_INVALIDATE_RE)) {
    const line = lineNumberForIndex(content, m.index!);
    sites.push({ file: rel, line, fn: findEnclosingFunction(lines, line - 1), via: 'raw-sql' });
  }

  // GraphBackend-mediated calls are scanned in every file EXCEPT graph-store's
  // own definition file — its SQL is already caught above, and its internal
  // `invalidate()` -> `invalidateInTx()` delegation would otherwise self-flag.
  if (!rel.endsWith('libs/data/graph/graph-store/src/index.ts')) {
    for (const m of content.matchAll(GRAPHBACKEND_CALL_RE)) {
      const line = lineNumberForIndex(content, m.index!);
      sites.push({ file: rel, line, fn: findEnclosingFunction(lines, line - 1), via: 'graphbackend-call' });
    }
  }

  return sites;
}

function scanForInvalidationSites(): InvalidationSite[] {
  const sites: InvalidationSite[] = [];
  for (const dir of SCAN_DIRS) {
    for (const full of walkTsFiles(dir)) {
      sites.push(...scanFile(full));
    }
  }
  return sites;
}

/**
 * REVIEWED (2026-09-22, re-review of d3d97584; revised same day after
 * finding A). Every entry here was manually traced back to an
 * INTENT-CARRYING or structural-GC call site — never an automatic pass
 * reacting to a similarity score. `enrich.ts` / `neardup.ts` are
 * deliberately ABSENT: their removal from this list is exactly what
 * d3d97584 fixed, and their staying absent is what this test protects.
 */
const ALLOWLIST: ReadonlyArray<{ file: string; fn: string; via: 'raw-sql' | 'graphbackend-call'; why: string }> = [
  {
    file: 'libs/memory-core/src/cluster.ts',
    fn: 'materializeClusters',
    via: 'raw-sql',
    why: 'Stale MEMBER_OF/community rows retired when cluster membership is recomputed — structural GC of derived state, not a user-content decision.',
  },
  {
    file: 'libs/memory-core/src/cluster.ts',
    fn: 'dropSubsetLens',
    via: 'raw-sql',
    why: 'Retires a provenance-scoped community slice explicitly requested to be dropped via memory_curate drop_lens — caller intent.',
  },
  {
    file: 'libs/memory-core/src/community-gc.ts',
    fn: 'gcOrphanedCommunityState',
    via: 'raw-sql',
    why: 'Called ONLY from memoryInvalidate and merge_duplicates (both already intent-carrying) to retire community rows orphaned BY that same intentional invalidation — not an independent trigger.',
  },
  {
    file: 'libs/memory-core/src/curate.ts',
    fn: 'curateMergeDuplicates',
    via: 'raw-sql',
    why: 'memory_curate merge_duplicates — an explicit human/agent review decision on a SAME_AS candidate surfaced by memory_near_duplicates. The intent-carrying surface d3d97584 left in place.',
  },
  {
    file: 'libs/memory-core/src/extensions.ts',
    fn: 'buildCommunities',
    via: 'raw-sql',
    why: 'Same structural GC as materializeClusters (buildCommunities is the batch-enrichment entry point cluster.ts is invoked from) — retiring stale derived MEMBER_OF/community rows on recompute.',
  },
  {
    file: 'libs/memory-core/src/session.ts',
    fn: 'memorySaveSessionState',
    via: 'raw-sql',
    why: 'Replaces a prior session-state row for the SAME session_id with a fresh one on save — caller-driven state replacement, not content destruction.',
  },
  {
    file: 'libs/memory-core/src/write.ts',
    fn: 'memoryInvalidate',
    via: 'raw-sql',
    why: 'The canonical intent-carrying invalidation tool (memory_invalidate) — takes an explicit `reason` parameter from the caller.',
  },
  {
    file: 'libs/data/graph/graph-store/src/index.ts',
    fn: 'invalidateInTx',
    via: 'raw-sql',
    why: "GraphBackend's tx-scoped node invalidation primitive — takes an optional `reason` and records `invalidatedReason`/`invalidatedAt` in meta when supplied.",
  },
  {
    file: 'libs/data/graph/graph-store/src/index.ts',
    fn: 'invalidateEdge',
    via: 'raw-sql',
    why: "GraphBackend's edge invalidation primitive (the scanner attributes invalidateEdgeInTx's SQL to its public wrapper invalidateEdge, whose single-line declaration precedes it — same class, same primitive) — same reason-carrying contract as invalidateInTx.",
  },
  {
    file: 'extensions/bundles/sox-memory-bundle/members/memory-flush/src/index.ts',
    fn: 'handleSessionEnd',
    via: 'raw-sql',
    why: 'Found by the blind reviewer (finding A) — same shape as memorySaveSessionState: replaces a prior session-state row for the SAME session_id on session-end flush, caller-driven state replacement.',
  },
];

describe('invalidation-always-has-reason — durable guard (plan §2.1, revised 2026-09-22 finding A)', () => {
  it('every t_invalid write / GraphBackend-mediated invalidation call in scope is an explicitly reviewed, allowlisted site', () => {
    const sites = scanForInvalidationSites();
    expect(sites.length).toBeGreaterThan(0); // sanity: the scan itself must find real sites

    const allowedKeys = new Set(ALLOWLIST.map((a) => `${a.file}::${a.fn}::${a.via}`));
    const unallowed = sites.filter((s) => !allowedKeys.has(`${s.file}::${s.fn ?? '<unknown>'}::${s.via}`));

    if (unallowed.length > 0) {
      const report = unallowed
        .map((s) => `  [${s.via}] ${s.file}:${s.line} (function: ${s.fn ?? '<could not resolve enclosing function>'})`)
        .join('\n');
      throw new Error(
        `${unallowed.length} invalidation site(s) found OUTSIDE the reviewed allowlist in ` +
          `invalidation-always-has-reason.spec.ts. A NEW automatic/anonymous invalidation writer, or a NEW ` +
          `caller of the GraphBackend.invalidate()/invalidateEdge() primitives, may have been introduced — ` +
          `this is exactly the failure mode d3d97584 fixed (BUG-CLUSTER: 685 pairs / ~1.1MB / 3,273 orphaned ` +
          `edges destroyed with no reason). If this site is a deliberate, reviewed, intent-carrying ` +
          `invalidation, add it to ALLOWLIST with a "why"; otherwise it is a regression — fix it before ` +
          `touching the allowlist.\n\n${report}`,
      );
    }
  });

  it('every allowlisted call site still exists in source (no stale entries)', () => {
    const sites = scanForInvalidationSites();
    const foundKeys = new Set(sites.map((s) => `${s.file}::${s.fn ?? '<unknown>'}::${s.via}`));

    const stale = ALLOWLIST.filter((a) => !foundKeys.has(`${a.file}::${a.fn}::${a.via}`));
    if (stale.length > 0) {
      const report = stale.map((a) => `  [${a.via}] ${a.file} :: ${a.fn}`).join('\n');
      throw new Error(
        `${stale.length} ALLOWLIST entr${stale.length === 1 ? 'y is' : 'ies are'} stale — no matching ` +
          `invalidation site found in current source. Either the function was renamed/removed (update or ` +
          `delete the entry) or the scan's function-attribution regex needs adjustment.\n\n${report}`,
      );
    }
  });

  it('regression pin: enrich.ts and neardup.ts contain zero invalidation sites (the d3d97584 fix itself)', () => {
    const sites = scanForInvalidationSites();
    const stillPresent = sites.filter(
      (s) => s.file.endsWith('enrich.ts') || s.file.endsWith('neardup.ts'),
    );
    expect(stillPresent).toEqual([]);
  });
});
