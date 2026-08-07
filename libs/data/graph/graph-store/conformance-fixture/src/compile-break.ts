/**
 * PKT-62 / BL-443 — AC-5, the tarball's dist/*.d.ts compile-break criterion.
 *
 * Direct adaptation of open-rel-check.bl448.spec.ts:358-389's `assertNeverRel`/`classifyRel`
 * pattern, repointed to import `EdgeRel` from the bare specifier `@adhd/sox-graph-store` (resolved
 * through the INSTALLED tarball's node_modules, never a relative `./index.js` import).
 *
 * This file's *compiler exit code* is the assertion (SPEC-PKT-62.md Decision 5) — no runtime
 * assertions are needed beyond the sanity call below. If `EdgeRel`'s widening ((string & {})) did
 * not ship in the installed tarball's dist/index.d.ts, the `default` arm below narrows to `never`,
 * `assertNeverRel(rel)` compiles with ZERO error, and the `@ts-expect-error` directive becomes an
 * "Unused '@ts-expect-error' directive" error (TS 2578) — `tsc --noEmit` exits non-zero. Once the
 * widened type ships, the directive is necessary and `tsc --noEmit` exits 0.
 */
import type { EdgeRel } from '@adhd/sox-graph-store';

function assertNeverRel(x: never): never {
  throw new Error(`unreachable rel: ${String(x)}`);
}

function classifyRel(rel: EdgeRel): string {
  switch (rel) {
    case 'MENTIONS': return 'mentions';
    case 'SUPPORTS': return 'supports';
    case 'RELATES_TO': return 'relates_to';
    case 'DERIVED_FROM': return 'derived_from';
    case 'SUPERSEDES': return 'supersedes';
    case 'SAME_AS': return 'same_as';
    case 'ASSIGNED_TO': return 'assigned_to';
    case 'MEMBER_OF': return 'member_of';
    case 'PART_OF': return 'part_of';
    case 'DEPENDS_ON': return 'depends_on';
    default:
      // @ts-expect-error BL-448/PKT-62/BL-443 — necessary only once EdgeRel is widened in the
      // installed tarball's dist/index.d.ts (see file header). This is the file's entire mechanism.
      return assertNeverRel(rel);
  }
}

// Sanity call alongside the compile-time @ts-expect-error above — matches
// open-rel-check.bl448.spec.ts's own AC-Type convention.
if (classifyRel('MENTIONS') !== 'mentions' || classifyRel('DEPENDS_ON') !== 'depends_on') {
  throw new Error('compile-break.ts runtime sanity check failed');
}
