// @ts-check
/**
 * no-storage-backend-leak — enforces the storage boundary.
 *
 * Owner directive (2026-07-31, verbatim, docs/reporting/memory/PLAN.md
 * "Standing architectural rule"): "None of the code outside store-adapter
 * should be showing sqlite or turso other than in the adapter instantiation
 * options." Adopted form: `libs/data/store/store-adapter/**` is the ONLY
 * module permitted to name a backend (it subsumes `migration.ts`, which
 * lives inside that package).
 *
 * Everything else must go through capabilities and dialects (`FTSDialect`,
 * `VectorDialect` — `libs/memory-core/src/dialect.ts`) or the adapter's own
 * async API. Backend choice is an *instantiation option*, nothing more.
 *
 * Four independent violations of this shape were found in a single day, all
 * silent, all on the default (Turso) backend:
 *   - BL-377: `(adapter as SqliteAdapter).unwrap()` in export.ts/reembed.ts
 *     — broken since the migration, read as test debt for weeks.
 *   - BL-380: six more unchecked casts (vector-store x3, memory-cli x3).
 *   - BL-381: hardcoded `vec0` SQL bypassing VectorDialect — near-dup
 *     detection dead on Turso, confirmed on 3/3 live writes.
 *   - BL-385 (CRITICAL): backup.ts hardcodes a sqlite adapter + `.unwrap()`
 *     + `VACUUM INTO` — a Turso store cannot be backed up AT ALL.
 * All four passed review, typecheck, and CI. This rule encodes the
 * capability-guarded form the codebase already demonstrates correctly in
 * `db.ts` and would have caught every one of them.
 *
 * BANNED, outside `libs/data/store/store-adapter/**`:
 *   1. `as SqliteAdapter` / `as TursoAdapter` type assertions.
 *   2. `.unwrap()` calls (the only thing that ever calls `.unwrap()` in this
 *      repo is a backend-specific cast — see the four BL items above).
 *   3. The string literals 'sqlite' / 'turso' used as a backend
 *      discriminator: `===`/`!==`/`==`/`!=` comparisons and `switch` case
 *      tests. Object-literal properties (`{ type: 'sqlite', ... }`, i.e.
 *      constructing adapter config — an "instantiation option" in the
 *      owner's own words) are explicitly NOT banned.
 *   4. Raw `better-sqlite3` / `@tursodatabase/*` imports (static or dynamic
 *      `import()`/`require()`).
 *
 * Test files (`*.spec.ts`, `*.test.ts`, `__tests__/**`) are exempt at the
 * eslint.config.js level — tests legitimately pin/exercise a specific
 * backend. This rule only guards production code paths.
 *
 * KNOWN, NAMED EXCEPTIONS (engine-behaviour branches, not dialect leaks —
 * distinguished explicitly rather than silenced via scattered inline
 * disables, so the list stays auditable in one place):
 *   - write-queue.ts:417   — `config.type === 'turso'` — remote has no local
 *     WAL file to count; a driver-capability fact, not a SQL dialect choice.
 *   - db.ts:348             — `config.type === 'turso'` guard on the
 *     cross-SQLite-version VACUUM repair path (BL-320 telemetry).
 *   - db.ts:664             — `config.type === 'turso'` guard on the vec0
 *     residue drop path (Turso cannot DROP a vec0 virtual table itself).
 *   - db.ts:373, db.ts:896  — `(adapter as SqliteAdapter).unwrap()`, but
 *     gated behind `if (!adapter.capabilities.nativeVectors)` — the exact
 *     capability-guarded pattern this rule exists to require everywhere
 *     else. This is the model BL-377/BL-380/BL-385 all failed to follow.
 *   - memory-server/src/index.ts:2702 — `STORE_ADAPTER === 'turso'` used
 *     only to choose which native binding to `require()`-probe at startup
 *     (BL-94) so a missing binding fails fast with a clear message instead
 *     of mid-session. Diagnostic, not a SQL/dialect decision.
 *   - db.ts:20, db.ts:209, db.ts:260 — raw `better-sqlite3` imports (one
 *     type-only, backing the two below). Not a dialect choice: Turso/libSQL
 *     cannot itself DROP a `vec0` virtual table or fts5 shadow-table residue
 *     (no vec0/fts5 module) left behind by an engine migration, so repairing
 *     that residue requires a real better-sqlite3 connection regardless of
 *     which adapter the caller is using (BL-323). A genuine capability gap
 *     in the underlying driver, not a caller reaching around the adapter
 *     for convenience.
 *
 * Anything NOT on this list is a real finding — file it (see BL-380,
 * BL-385, BL-388, BL-389 for the template) or fix it; do not add a silent
 * exception here without a citation matching the standard above.
 */

const BACKEND_LITERALS = new Set(['sqlite', 'turso']);
const BANNED_ADAPTER_CAST_TYPES = new Set(['SqliteAdapter', 'TursoAdapter']);
const BANNED_IMPORT_PREFIXES = ['better-sqlite3', '@tursodatabase/'];

/** file-path-suffix -> Set(1-based line numbers) blessed as engine-behaviour, not a leak. */
const DEFAULT_EXCEPTIONS = [
  { pathSuffix: 'libs/memory-core/src/write-queue.ts', lines: [417] },
  { pathSuffix: 'libs/memory-core/src/db.ts', lines: [20, 209, 260, 348, 664, 373, 896] },
  {
    pathSuffix:
      'extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts',
    lines: [2702],
  },
];

function normalize(p) {
  return p.split('\\').join('/');
}

function buildExceptionSet(exceptions) {
  const map = new Map();
  for (const { pathSuffix, lines } of exceptions) {
    map.set(normalize(pathSuffix), new Set(lines));
  }
  return map;
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid naming a storage backend (sqlite/turso) or reaching through StoreAdapter to a raw driver outside libs/data/store/store-adapter/**. See BL-377, BL-380, BL-381, BL-385.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          exceptions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                pathSuffix: { type: 'string' },
                lines: { type: 'array', items: { type: 'integer' } },
              },
              required: ['pathSuffix', 'lines'],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      castViolation:
        "'as {{type}}' asserts a specific storage backend outside libs/data/store/store-adapter/**. Use the adapter's own async API (executeGet/executeAll/executeRun), or gate on `adapter.capabilities.*` if a raw handle is genuinely unavoidable (see db.ts:373/:896 for the blessed pattern). BL-377, BL-380.",
      unwrapViolation:
        "'.unwrap()' reaches through StoreAdapter to a backend-specific raw handle outside libs/data/store/store-adapter/**. On SqliteAdapter this is sync; on TursoAdapter (the default) it is async — a bare unwrap() silently returns the wrong shape on the default backend. Use the adapter's async API instead. BL-377, BL-380, BL-385.",
      literalDiscriminatorViolation:
        "The literal '{{value}}' is used here as a backend discriminator outside libs/data/store/store-adapter/**. Branch on capabilities (`adapter.capabilities.*`) or a dialect (`ftsDialectFor`/`vectorDialectFor` in libs/memory-core/src/dialect.ts) instead of comparing `config.type`. If this is a genuine engine-behaviour fact (not a SQL/dialect choice), name it in the exceptions list in tools/eslint-local/no-storage-backend-leak.cjs with a citation — do not silence it inline.",
      rawImportViolation:
        "'{{source}}' is a raw storage-driver import outside libs/data/store/store-adapter/**. Go through StoreAdapter/createStoreAdapter instead of importing the backend driver directly. BL-380.",
    },
  },

  create(context) {
    const filename = normalize(context.filename ?? context.getFilename());

    // Defense in depth: the eslint.config.js `ignores` glob already excludes
    // store-adapter, but a misconfigured override elsewhere must not silently
    // re-enable this rule inside the one module that's allowed to violate it.
    if (filename.includes('libs/data/store/store-adapter/')) {
      return {};
    }

    const options = context.options[0] || {};
    const exceptions = buildExceptionSet(
      Array.isArray(options.exceptions) ? options.exceptions : DEFAULT_EXCEPTIONS,
    );

    function isBlessed(line) {
      for (const [suffix, lines] of exceptions) {
        if (filename.endsWith(suffix) && lines.has(line)) return true;
      }
      return false;
    }

    return {
      // `as SqliteAdapter` / `as TursoAdapter`
      TSAsExpression(node) {
        const ann = node.typeAnnotation;
        if (!ann || ann.type !== 'TSTypeReference') return;
        const typeName = ann.typeName && ann.typeName.name;
        if (!typeName || !BANNED_ADAPTER_CAST_TYPES.has(typeName)) return;
        const line = node.loc.start.line;
        if (isBlessed(line)) return;
        context.report({ node, messageId: 'castViolation', data: { type: typeName } });
      },

      // `<anything>.unwrap()`
      'CallExpression[callee.type="MemberExpression"]'(node) {
        const callee = node.callee;
        if (callee.computed) return;
        if (callee.property.type !== 'Identifier' || callee.property.name !== 'unwrap') return;
        const line = node.loc.start.line;
        if (isBlessed(line)) return;
        context.report({ node, messageId: 'unwrapViolation' });
      },

      // `x === 'sqlite'` / `x !== 'turso'` / etc., and switch(...) case 'sqlite':
      BinaryExpression(node) {
        if (!['===', '!==', '==', '!='].includes(node.operator)) return;
        for (const side of [node.left, node.right]) {
          if (side.type === 'Literal' && typeof side.value === 'string' && BACKEND_LITERALS.has(side.value)) {
            const line = node.loc.start.line;
            if (isBlessed(line)) continue;
            context.report({
              node,
              messageId: 'literalDiscriminatorViolation',
              data: { value: side.value },
            });
          }
        }
      },
      SwitchCase(node) {
        if (!node.test || node.test.type !== 'Literal') return;
        if (typeof node.test.value !== 'string' || !BACKEND_LITERALS.has(node.test.value)) return;
        const line = node.loc.start.line;
        if (isBlessed(line)) return;
        context.report({
          node: node.test,
          messageId: 'literalDiscriminatorViolation',
          data: { value: node.test.value },
        });
      },

      // `import ... from 'better-sqlite3'` / `import('@tursodatabase/database')`
      ImportDeclaration(node) {
        checkImportSource(node.source);
      },
      ImportExpression(node) {
        checkImportSource(node.source);
      },
      'CallExpression[callee.name="require"]'(node) {
        checkImportSource(node.arguments[0]);
      },
    };

    function checkImportSource(sourceNode) {
      if (!sourceNode || sourceNode.type !== 'Literal' || typeof sourceNode.value !== 'string') return;
      const source = sourceNode.value;
      if (!BANNED_IMPORT_PREFIXES.some((prefix) => source.startsWith(prefix))) return;
      const line = sourceNode.loc.start.line;
      if (isBlessed(line)) return;
      context.report({ node: sourceNode, messageId: 'rawImportViolation', data: { source } });
    }
  },
};
