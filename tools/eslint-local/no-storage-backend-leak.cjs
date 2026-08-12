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
 * disables, so the list stays auditable in one place). Each is keyed by
 * enclosing function + source text, NEVER by line number — see
 * `DEFAULT_EXCEPTIONS` below for why that distinction is load-bearing:
 *   - write-queue.ts `walBytes` — `config.type === 'turso'`: remote has no
 *     local WAL file to count; a driver-capability fact, not a dialect choice.
 *   - db.ts `_openDbInner` — `config.type === 'turso'` x2, guarding the
 *     cross-SQLite-version VACUUM repair path (BL-320) and the vec0 residue
 *     drop path (Turso cannot DROP a vec0 virtual table itself).
 *   - db.ts `_openDbInner` / `openDbReadOnly` — `(adapter as SqliteAdapter)
 *     .unwrap()`, each gated behind `if (!adapter.capabilities.nativeVectors)`
 *     — the exact capability-guarded pattern this rule exists to require
 *     everywhere else. This is the model BL-377/BL-380/BL-385 all failed to
 *     follow.
 *   - memory-server/src/index.ts (module scope) — `STORE_ADAPTER === 'turso'`
 *     used only to choose which native binding to `require()`-probe at
 *     startup (BL-94), so a missing binding fails fast with a clear message
 *     instead of mid-session. Diagnostic, not a SQL/dialect decision.
 *   - db.ts (module scope) — raw `better-sqlite3` imports x3 (one type-only),
 *     backing the two residue-repair sites above. Not a dialect choice:
 *     Turso/libSQL cannot itself DROP a `vec0` virtual table or fts5
 *     shadow-table residue (no vec0/fts5 module) left behind by an engine
 *     migration, so repairing that residue requires a real better-sqlite3
 *     connection regardless of which adapter the caller is using (BL-323). A
 *     genuine capability gap in the driver, not a reach-around.
 *
 * Anything NOT on this list is a real finding — file it (see BL-380,
 * BL-385, BL-388, BL-389 for the template) or fix it; do not add a silent
 * exception here without a citation matching the standard above.
 */

const BACKEND_LITERALS = new Set(['sqlite', 'turso']);
const BANNED_ADAPTER_CAST_TYPES = new Set(['SqliteAdapter', 'TursoAdapter']);
const BANNED_IMPORT_PREFIXES = ['better-sqlite3', '@tursodatabase/'];

/**
 * Blessed engine-behaviour sites, keyed by CONTENT — never by line number.
 *
 * A line-numbered allowlist fails OPEN, which is the one way a guard must never
 * fail: any edit above a blessed line shifts the exemption onto whatever code
 * moved into that slot, silently waving through a real leak, while the genuine
 * exception starts erroring and invites the next agent to "fix" correct code or
 * add the inline disable this rule's own message tells them not to add. These
 * files are edited constantly (BL-382 alone added 387 lines to
 * memory-server/src/index.ts), so that is a when, not an if.
 *
 * Each entry is `{ pathSuffix, fn, text, count }`:
 *   - `fn`    enclosing function name — keeps two identical expressions in
 *             different functions distinct (db.ts's two `as SqliteAdapter`
 *             sites live in `_openDbInner` and `openDbReadOnly`).
 *   - `text`  the offending node's source, whitespace-normalised.
 *   - `count` how many identical occurrences are blessed inside that function
 *             (default 1). Occurrences BEYOND the count are reported. Without
 *             this, `_openDbInner`'s two blessed `adapter.config.type ===
 *             'turso'` guards would auto-exempt any third one added later.
 *
 * Fail-closed by construction: change the code and the exemption stops
 * applying, which is the correct default — a rewritten guard must be re-blessed
 * deliberately, with a fresh citation.
 */
const DEFAULT_EXCEPTIONS = [
  // Remote stores have no local WAL file to measure. Engine behaviour, not a
  // dialect choice.
  {
    pathSuffix: 'libs/memory-core/src/write-queue.ts',
    fn: 'walBytes',
    text: "this.adapter.config.type === 'turso'",
  },
  // Turso/libSQL cannot itself DROP a vec0 virtual table or fts5 shadow-table
  // residue left by an engine migration (no vec0/fts5 module), so repairing it
  // needs a real better-sqlite3 connection regardless of the caller's adapter
  // (BL-323). A driver capability gap, not a reach-around.
  {
    pathSuffix: 'libs/memory-core/src/db.ts',
    fn: '_openDbInner',
    text: "adapter.config.type === 'turso'",
    count: 2,
  },
  {
    pathSuffix: 'libs/memory-core/src/db.ts',
    fn: '_openDbInner',
    text: 'adapter as SqliteAdapter',
  },
  {
    pathSuffix: 'libs/memory-core/src/db.ts',
    fn: 'openDbReadOnly',
    text: 'adapter as SqliteAdapter',
  },
  // Raw better-sqlite3 references backing the residue-repair paths. These are
  // three structurally DIFFERENT sites, not one repeated three times — a
  // module-scope type-only import plus two dynamic `import()`s inside the two
  // repair functions. The former line-number list could not express that
  // distinction; naming each scope separately means a new raw import anywhere
  // else in db.ts is reported rather than absorbed by a shared budget.
  {
    pathSuffix: 'libs/memory-core/src/db.ts',
    fn: null, // `import type Database from 'better-sqlite3'` at module scope
    text: 'better-sqlite3',
  },
  {
    pathSuffix: 'libs/memory-core/src/db.ts',
    fn: 'dropVec0ViaBetterSqlite3',
    text: 'better-sqlite3',
  },
  {
    pathSuffix: 'libs/memory-core/src/db.ts',
    fn: 'dropFtsResidueViaBetterSqlite3',
    text: 'better-sqlite3',
  },
  // BL-507: Turso/libSQL (unlike stock SQLite) cannot resolve an FK that
  // references the parent's `rowid` alias explicitly (`REFERENCES node(rowid)`
  // — the Drizzle-era edge DDL); with foreign_keys=ON every write dies with
  // `foreign key mismatch referencing "node"` (measured on a copy of the live
  // backlog.db, 2026-08-11). The edge rebuild in `ensureCheckConstraints`
  // must fire on turso only — stock SQLite resolves the form, and its stores
  // must stay byte-identical (BL-448 AC-3). A driver capability fact, not a
  // dialect choice.
  {
    pathSuffix: 'libs/data/graph/graph-store/src/index.ts',
    fn: 'ensureCheckConstraints',
    text: "this.adapter.config.type === 'turso'",
  },
  // (BL-508) The engine-identity guard in graph-store's open path: the store's
  // engine marker is a FILE-STORE fact, not a SQL/dialect choice — no
  // `adapter.capabilities.*` field expresses "which engine's marker this file
  // carries". Only a turso ADAPTER is fail-closed against a sqlite marker
  // (assertStoreEngineSync); sqlite adapters already refused at construction
  // (SqliteAdapterImpl BL-329/BL-508 probe), so branching on the adapter type
  // here is the minimal honest discriminator.
  {
    pathSuffix: 'libs/data/graph/graph-store/src/index.ts',
    fn: 'engineIdentity',
    text: "this.adapter.config.type === 'turso'",
  },
  // BL-94 startup binding probe: names the driver to fail fast with a clear
  // message instead of mid-session. Diagnostic, not a SQL/dialect decision.
  {
    pathSuffix:
      'extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts',
    fn: null,
    text: "process.env.STORE_ADAPTER === 'turso'",
  },
];

function normalize(p) {
  return p.split('\\').join('/');
}

/** Collapse all whitespace so reformatting/prettier does not break an exemption. */
function normalizeText(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

/** Nearest named enclosing function, or null at module scope. */
function enclosingFnName(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (
      n.type === 'FunctionDeclaration' ||
      n.type === 'FunctionExpression' ||
      n.type === 'ArrowFunctionExpression'
    ) {
      if (n.id && n.id.name) return n.id.name;
      const p = n.parent;
      if (p && p.type === 'VariableDeclarator' && p.id && p.id.name) return p.id.name;
      if (p && (p.type === 'MethodDefinition' || p.type === 'Property') && p.key && p.key.name) {
        return p.key.name;
      }
      // An anonymous callback does not establish identity — keep walking out to
      // the nearest NAMED scope so a snippet cannot be blessed by virtue of
      // sitting inside some arbitrary inline closure.
      continue;
    }
    if (n.type === 'MethodDefinition' && n.key && n.key.name) return n.key.name;
  }
  return null;
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
                // Enclosing function name, or null for module scope. Required
                // (not optional) so an exemption always states its scope —
                // omitting it would silently mean "module scope" and bless a
                // wider surface than intended.
                fn: { type: ['string', 'null'] },
                text: { type: 'string' },
                count: { type: 'integer', minimum: 1 },
              },
              required: ['pathSuffix', 'fn', 'text'],
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
      blessedBudgetExceeded:
        "`{{text}}` appears more times in `{{scope}}` than the {{count}} blessed in tools/eslint-local/no-storage-backend-leak.cjs. READ THIS BEFORE 'FIXING' THE LINE IT POINTS AT: identical occurrences in one scope are indistinguishable, so the reported location is whichever one the traversal reached last — it is very likely the long-standing, legitimately-blessed site, and the NEW one is elsewhere in the same function. Find the occurrence that was actually added and either route it through a dialect/capability, or, if it is genuinely engine behaviour, raise `count` with a citation. Do not silence this inline.",
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
    const exceptions = (
      Array.isArray(options.exceptions) ? options.exceptions : DEFAULT_EXCEPTIONS
    ).filter((e) => filename.endsWith(normalize(e.pathSuffix)));

    const sourceCode = context.sourceCode ?? context.getSourceCode();
    /** how many times each blessed (fn, text) pair has been consumed in this file */
    const consumed = new Map();
    /**
     * Nodes already blessed once. `(adapter as SqliteAdapter).unwrap()` trips
     * TWO visitors — the cast and the unwrap call — and both resolve to the same
     * TSAsExpression. Without this, the second visit finds the budget spent and
     * reports a site that was legitimately blessed a moment earlier.
     */
    const blessedNodes = new WeakSet();

    /**
     * A site is blessed only if an exception in THIS file matches its enclosing
     * function AND its normalised source text AND the blessed count for that
     * pair is not yet exhausted. Budget exhaustion is the point: it turns "a
     * fourth identical guard appeared in _openDbInner" into a reported finding
     * rather than a free pass.
     */
    function isBlessed(node, textOverride) {
      if (exceptions.length === 0) return false;
      if (blessedNodes.has(node)) return true; // already charged — do not double-bill
      const text = normalizeText(textOverride ?? sourceCode.getText(node));
      const fn = enclosingFnName(node);
      for (const e of exceptions) {
        if ((e.fn ?? null) !== fn) continue;
        if (normalizeText(e.text) !== text) continue;
        const key = `${fn}.${text}`;
        const used = consumed.get(key) ?? 0;
        if (used >= (e.count ?? 1)) {
          // Budget spent. Report with the dedicated message rather than letting
          // the caller emit the generic one: the location here is NOT reliably
          // the offending site (identical text in one scope is
          // indistinguishable), so the generic wording would send a reader off
          // to "fix" correct, long-blessed code.
          context.report({
            node,
            messageId: 'blessedBudgetExceeded',
            data: { text, scope: fn ?? 'module scope', count: String(e.count ?? 1) },
          });
          return true; // already reported — suppress the caller's generic report
        }
        consumed.set(key, used + 1);
        blessedNodes.add(node);
        return true;
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
        if (isBlessed(node)) return;
        context.report({ node, messageId: 'castViolation', data: { type: typeName } });
      },

      // `<anything>.unwrap()`
      'CallExpression[callee.type="MemberExpression"]'(node) {
        const callee = node.callee;
        if (callee.computed) return;
        if (callee.property.type !== 'Identifier' || callee.property.name !== 'unwrap') return;
        const obj = callee.object;
        const inner = obj && obj.type === 'TSAsExpression' ? obj : null;
        if (isBlessed(inner ?? node)) return;
        context.report({ node, messageId: 'unwrapViolation' });
      },

      // `x === 'sqlite'` / `x !== 'turso'` / etc., and switch(...) case 'sqlite':
      BinaryExpression(node) {
        if (!['===', '!==', '==', '!='].includes(node.operator)) return;
        for (const side of [node.left, node.right]) {
          if (side.type === 'Literal' && typeof side.value === 'string' && BACKEND_LITERALS.has(side.value)) {
            if (isBlessed(node)) continue;
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
        if (isBlessed(node.test)) return;
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
      if (isBlessed(sourceNode, source)) return;
      context.report({ node: sourceNode, messageId: 'rawImportViolation', data: { source } });
    }
  },
};
