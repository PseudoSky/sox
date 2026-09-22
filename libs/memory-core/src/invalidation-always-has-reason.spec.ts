/**
 * invalidation-always-has-reason.spec.ts — 2026-09-22 re-review finding 3,
 * plan §2.1 durable guard.
 *
 * d3d97584 removed the ONE automatic, anonymous `t_invalid` writer this repo
 * had (`applyNearDupResult` in enrich.ts) — the pass that destroyed 685 pairs
 * / ~1.1MB / 3,273 edges with no reason and no SUPERSEDES edge before anyone
 * noticed. That fix pins the ONE call site it touched. Nothing stops a
 * DIFFERENT function — today or in a future change — from adding its own
 * anonymous `UPDATE node/edge SET t_invalid = ?` and reintroducing the exact
 * same failure mode somewhere else in this surface, invisibly.
 *
 * This is the durable guard: a source scan that enumerates EVERY live
 * `t_invalid = ?` write (an actual invalidation — `t_invalid = NULL`
 * revivals and `t_invalid IS NULL` predicates are excluded, they don't
 * destroy anything) across memory-core and graph-store, and asserts the
 * enclosing function is in an explicit, reviewed ALLOWLIST below. It is not
 * a semantic proof that every writer records a reason (`gcOrphanedCommunityState`
 * and the cluster/session cleanup paths below are structural GC, not
 * intent-carrying user actions, and record no reason today) — it is an
 * ATTRIBUTABILITY guard: a new anonymous invalidation writer added anywhere
 * in this surface FAILS this test immediately, by name, rather than
 * shipping silently the way the near-dup pass did. Extending the allowlist
 * is a deliberate, reviewed, one-line diff — exactly the friction the plan
 * asked for ("if a future change reintroduces an automatic invalidation, it
 * will at least be attributable").
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
const SCAN_DIRS = [
  path.join(ROOT, 'libs/memory-core/src'),
  path.join(ROOT, 'libs/data/graph/graph-store/src'),
];

/** An actual invalidation write — excludes `= NULL` revivals and `IS NULL` predicates. */
const INVALIDATE_RE = /UPDATE\s+(?:node|edge)\s+SET\s+t_invalid\s*=\s*\?/i;

/**
 * Matches a function/method declaration line: `function name(...)`,
 * `export async function name(...)`, or a class method
 * `[private|public|protected|static] [async] name(...): ReturnType {`.
 * Single-line only (matches this codebase's declaration style at every
 * allowlisted site below) — a declaration split across multiple lines
 * attributes to the NEXT declaration walking backward, which still lands
 * inside the same class/file and is caught by a human reviewing a new
 * allowlist entry, not a silent miss.
 */
const FN_DECL_RE =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:private\s+|public\s+|protected\s+|static\s+)*(?:async\s+)?(\w+)\s*\([^)]*\)\s*:\s*(?:Promise|void|[A-Za-z0-9_<>[\], .]+)\s*\{)/;

interface InvalidationSite {
  file: string; // relative to repo root
  line: number; // 1-based
  fn: string | null;
}

function findEnclosingFunction(lines: string[], matchLineIdx: number): string | null {
  for (let i = matchLineIdx; i >= 0; i--) {
    const m = FN_DECL_RE.exec(lines[i]!);
    if (m) return m[1] ?? m[2] ?? null;
  }
  return null;
}

function scanForInvalidationSites(): InvalidationSite[] {
  const sites: InvalidationSite[] = [];
  for (const dir of SCAN_DIRS) {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.endsWith('.test.ts'));
    for (const f of files) {
      const full = path.join(dir, f);
      const content = fs.readFileSync(full, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (INVALIDATE_RE.test(lines[i]!)) {
          sites.push({
            file: path.relative(ROOT, full),
            line: i + 1,
            fn: findEnclosingFunction(lines, i),
          });
        }
      }
    }
  }
  return sites;
}

/**
 * REVIEWED (2026-09-22, re-review of d3d97584). Every entry here was manually
 * traced back to an INTENT-CARRYING or structural-GC call site — never an
 * automatic pass reacting to a similarity score. `enrich.ts` / `neardup.ts`
 * are deliberately ABSENT: their removal from this list is exactly what
 * d3d97584 fixed, and their staying absent is what this test protects.
 */
const ALLOWLIST: ReadonlyArray<{ file: string; fn: string; why: string }> = [
  {
    file: 'libs/memory-core/src/cluster.ts',
    fn: 'materializeClusters',
    why: 'Stale MEMBER_OF/community rows retired when cluster membership is recomputed — structural GC of derived state, not a user-content decision.',
  },
  {
    file: 'libs/memory-core/src/cluster.ts',
    fn: 'dropSubsetLens',
    why: 'Retires a provenance-scoped community slice explicitly requested to be dropped via memory_curate drop_lens — caller intent.',
  },
  {
    file: 'libs/memory-core/src/community-gc.ts',
    fn: 'gcOrphanedCommunityState',
    why: 'Called ONLY from memoryInvalidate and merge_duplicates (both already intent-carrying) to retire community rows orphaned BY that same intentional invalidation — not an independent trigger.',
  },
  {
    file: 'libs/memory-core/src/curate.ts',
    fn: 'curateMergeDuplicates',
    why: 'memory_curate merge_duplicates — an explicit human/agent review decision on a SAME_AS candidate surfaced by memory_near_duplicates. The intent-carrying surface d3d97584 left in place.',
  },
  {
    file: 'libs/memory-core/src/extensions.ts',
    fn: 'buildCommunities',
    why: 'Same structural GC as materializeClusters (buildCommunities is the batch-enrichment entry point cluster.ts is invoked from) — retiring stale derived MEMBER_OF/community rows on recompute.',
  },
  {
    file: 'libs/memory-core/src/session.ts',
    fn: 'memorySaveSessionState',
    why: 'Replaces a prior session-state row for the SAME session_id with a fresh one on save — caller-driven state replacement, not content destruction.',
  },
  {
    file: 'libs/memory-core/src/write.ts',
    fn: 'memoryInvalidate',
    why: 'The canonical intent-carrying invalidation tool (memory_invalidate) — takes an explicit `reason` parameter from the caller.',
  },
  {
    file: 'libs/data/graph/graph-store/src/index.ts',
    fn: 'invalidateInTx',
    why: "GraphBackend's tx-scoped node invalidation primitive — takes an optional `reason` and records `invalidatedReason`/`invalidatedAt` in meta when supplied.",
  },
  {
    file: 'libs/data/graph/graph-store/src/index.ts',
    fn: 'invalidateEdge',
    why: "GraphBackend's edge invalidation primitive (the scanner attributes invalidateEdgeInTx's SQL to its public wrapper invalidateEdge, whose single-line declaration precedes it — same class, same primitive) — same reason-carrying contract as invalidateInTx.",
  },
];

describe('invalidation-always-has-reason — durable guard (plan §2.1, 2026-09-22 re-review finding 3)', () => {
  it('every t_invalid write site in memory-core/graph-store is an explicitly reviewed, allowlisted call site', () => {
    const sites = scanForInvalidationSites();
    expect(sites.length).toBeGreaterThan(0); // sanity: the scan itself must find real sites

    const allowedKeys = new Set(ALLOWLIST.map((a) => `${a.file}::${a.fn}`));
    const unallowed = sites.filter((s) => !allowedKeys.has(`${s.file}::${s.fn ?? '<unknown>'}`));

    if (unallowed.length > 0) {
      const report = unallowed
        .map((s) => `  ${s.file}:${s.line} (function: ${s.fn ?? '<could not resolve enclosing function>'})`)
        .join('\n');
      throw new Error(
        `${unallowed.length} t_invalid write site(s) found OUTSIDE the reviewed allowlist in ` +
          `invalidation-always-has-reason.spec.ts. A NEW automatic/anonymous invalidation writer ` +
          `may have been introduced — this is exactly the failure mode d3d97584 fixed (BUG-CLUSTER: ` +
          `685 pairs / ~1.1MB / 3,273 orphaned edges destroyed with no reason). If this site is a ` +
          `deliberate, reviewed, intent-carrying invalidation, add it to ALLOWLIST with a "why"; ` +
          `otherwise it is a regression — fix it before touching the allowlist.\n\n${report}`,
      );
    }
  });

  it('every allowlisted call site still exists in source (no stale entries)', () => {
    const sites = scanForInvalidationSites();
    const foundKeys = new Set(sites.map((s) => `${s.file}::${s.fn ?? '<unknown>'}`));

    const stale = ALLOWLIST.filter((a) => !foundKeys.has(`${a.file}::${a.fn}`));
    if (stale.length > 0) {
      const report = stale.map((a) => `  ${a.file} :: ${a.fn}`).join('\n');
      throw new Error(
        `${stale.length} ALLOWLIST entr${stale.length === 1 ? 'y is' : 'ies are'} stale — no matching ` +
          `t_invalid write found in current source. Either the function was renamed/removed (update or ` +
          `delete the entry) or the scan's function-attribution regex needs adjustment.\n\n${report}`,
      );
    }
  });

  it('regression pin: enrich.ts and neardup.ts contain zero t_invalid writers (the d3d97584 fix itself)', () => {
    const sites = scanForInvalidationSites();
    const stillPresent = sites.filter(
      (s) => s.file.endsWith('enrich.ts') || s.file.endsWith('neardup.ts'),
    );
    expect(stillPresent).toEqual([]);
  });
});
