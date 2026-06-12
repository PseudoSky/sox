#!/usr/bin/env node
/**
 * tools/born-conformance.js — Born-conformance gate.
 *
 * For each of the 6 active types, this script:
 *   1. Calls scaffold() from libs/authoring to produce a FileSet
 *   2. Writes the FileSet to a temp directory (using writeFileSet)
 *   3. Reads and parses extension.json from the written output
 *   4. Validates it against libs/manifest validate()
 *   5. Asserts ok === true and errors is empty
 *
 * On any failure: prints the type + errors, exits non-zero.
 * On full pass: prints "born-conformance: PASS" + exits 0.
 *
 * Runs as an nx target (sox-nx:born-conformance) with no deps on devkit.
 * [authoring-lib.3] acceptance criterion gate.
 */

// @ts-check
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');

// Use createRequire for CJS modules (libs/authoring and libs/manifest output CJS)
const req = createRequire(import.meta.url);

const { scaffold, writeFileSet, ACTIVE_TYPES } = req(join(ROOT, 'libs/authoring/dist/index.js'));
const { validate } = req(join(ROOT, 'libs/manifest/dist/index.js'));

const RESULTS = [];
let anyFailed = false;

// IDs that do NOT end with the type name (manifest validation contract)
const TYPE_IDS = {
  'agent': 'bc-echo',
  'skill': 'bc-greet',
  'mcp-server': 'bc-mcp',
  'hook': 'bc-audit',
  'command': 'bc-status',
  'bundle': 'bc-pack',
};

for (const type of ACTIVE_TYPES) {
  const id = TYPE_IDS[type] ?? `bc-${type.replace('-', '')}x`;
  const tmpDir = mkdtempSync(join(tmpdir(), `sox-bc-${type}-`));

  try {
    // Step 1: scaffold
    const fileSet = scaffold({
      type,
      id,
      title: `Born Conformance ${type}`,
      description: `Born-conformance test extension for type ${type}`,
      author: 'sox-test',
      keywords: ['born-conformance', type],
    });

    // Step 2: write to temp dir
    writeFileSet(fileSet, tmpDir);

    // Step 3: read extension.json
    const manifestPath = join(tmpDir, 'extension.json');
    const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));

    // Step 4: validate against libs/manifest
    const result = validate(raw);

    // Step 5: assert
    if (!result.ok) {
      anyFailed = true;
      RESULTS.push({ type, status: 'FAIL', errors: result.errors });
    } else {
      RESULTS.push({ type, status: 'PASS', errors: [] });
    }
  } catch (err) {
    anyFailed = true;
    RESULTS.push({ type, status: 'FAIL', errors: [String(err)] });
  } finally {
    // Clean up temp dir
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

// Report
for (const r of RESULTS) {
  if (r.status === 'PASS') {
    console.log(`  [PASS] type=${r.type}`);
  } else {
    console.error(`  [FAIL] type=${r.type}`);
    for (const e of r.errors) {
      console.error(`         ${e}`);
    }
  }
}

if (anyFailed) {
  console.error('\nborn-conformance: FAIL');
  process.exit(1);
} else {
  console.log('\nborn-conformance: PASS');
  process.exit(0);
}
