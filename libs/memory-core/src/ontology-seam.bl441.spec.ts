/**
 * BL-441 (PKT-60) AC-5 — "the seam is structurally single," the packet's own
 * task description's stated most-valuable test.
 *
 * Parses (via the TS compiler API — the spec's "stronger, preferred" option, to
 * avoid a false pass if someone renames the import, e.g.
 * `import { createGraphBackend as cgb }`) every `.ts` file under
 * `libs/memory-core/src/` (excluding `graph-backend.ts` itself and `*.spec.ts`
 * files) and asserts that none of them import `createGraphBackend` (under any
 * local alias) from `'@adhd/sox-graph-store'`.
 *
 * RED arm: run against merge-base `e1d6d759` (before PKT-60's seven-file edit)
 * — MUST report exactly 9 violations, naming file:line for each of the nine
 * call sites in cluster.ts (x3), enrich-batch.ts, entity-episodes.ts,
 * list-entities.ts, near-duplicates.ts, related.ts, supersession-chain.ts.
 * After the edit: zero.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import ts from 'typescript';

const SRC_DIR = join(__dirname); // libs/memory-core/src

interface Violation {
  file: string;
  line: number;
  localName: string;
}

/**
 * Reports one violation PER CALL SITE (not per import statement) — AC-5's stated
 * RED arm is "exactly nine violations (the nine call sites)", since cluster.ts
 * imports createGraphBackend once but calls it three times (:749, :820, :886).
 */
function findCreateGraphBackendCallSites(): Violation[] {
  const violations: Violation[] = [];
  const files = readdirSync(SRC_DIR).filter(
    (f) =>
      extname(f) === '.ts' &&
      f !== 'graph-backend.ts' &&
      !f.endsWith('.spec.ts') &&
      !f.endsWith('.test.ts'),
  );

  for (const file of files) {
    const fullPath = join(SRC_DIR, file);
    const text = readFileSync(fullPath, 'utf8');
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    // Resolve the LOCAL binding name(s) this file imports createGraphBackend under
    // (handles `import { createGraphBackend as cgb } from '@adhd/sox-graph-store'`).
    const localNames = new Set<string>();
    const findImports = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === '@adhd/sox-graph-store'
      ) {
        const namedBindings = node.importClause?.namedBindings;
        if (namedBindings && ts.isNamedImports(namedBindings)) {
          for (const spec of namedBindings.elements) {
            // spec.propertyName is set when aliased — it is the ORIGINAL exported
            // name; spec.name is always the local binding used at call sites.
            const importedName = (spec.propertyName ?? spec.name).text;
            if (importedName === 'createGraphBackend') {
              localNames.add(spec.name.text);
            }
          }
        }
      }
      ts.forEachChild(node, findImports);
    };
    findImports(sourceFile);
    if (localNames.size === 0) continue;

    // Walk every CallExpression invoking one of those local names.
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        localNames.has(node.expression.text)
      ) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.expression.getStart(sourceFile));
        violations.push({ file, line: line + 1, localName: node.expression.text });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return violations;
}

describe('AC-5 (BL-441) — createGraphBackend is called from exactly one file (graph-backend.ts) under libs/memory-core/src/', () => {
  it('zero call sites of createGraphBackend exist outside graph-backend.ts (structural single-seam invariant)', () => {
    const violations = findCreateGraphBackendCallSites();
    if (violations.length > 0) {
      const report = violations.map((v) => `  ${v.file}:${v.line} (as ${v.localName})`).join('\n');
      throw new Error(
        `Found ${violations.length} call site(s) of createGraphBackend outside graph-backend.ts:\n${report}`,
      );
    }
    expect(violations).toHaveLength(0);
  });
});
