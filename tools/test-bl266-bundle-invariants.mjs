#!/usr/bin/env node
/**
 * tools/test-bl266-bundle-invariants.mjs
 *
 * Red->green contract pin for the five invariants BL-266 requires to survive
 * ANY migration of the esbuild bundle driver (tools/bundle-extension.cjs ->
 * whatever replaces it). Run against a built dist/ dir to check the
 * dist-content invariants (a, b); run with --build-cmd to additionally
 * exercise the build-PROCESS invariants (c, d) by mutating source and
 * re-invoking the build. (e) is checked by rebuilding twice and diffing.
 *
 * Usage:
 *   node tools/test-bl266-bundle-invariants.mjs --outdir <dir> --externals <pkg,pkg,...> [--sidecars <name.js,...>]
 *   node tools/test-bl266-bundle-invariants.mjs --outdir <dir> --externals <...> --build-cmd "<shell command>" --source <file-to-mutate> --rebuild-cmd "<shell command>"
 *
 * Each invariant prints PASS/FAIL/SKIP with the concrete evidence.
 *
 * SKIP is a distinct, non-passing outcome (BL-469): invariants (c), (d) and (e) require
 * --build-cmd/--source/--rebuild-cmd to actually execute a build. Without those flags they
 * are NOT verified — they are reported as [SKIP], never as [PASS], and the summary line
 * states exactly how many invariants were verified vs. skipped. "ALL 5 INVARIANTS PASS" is
 * printed iff all 5 were both requested and observed to pass.
 *
 * EXIT CODE CONTRACT (explicit, per BL-466's "a guard the harness does not execute must
 * fail the run"): any FAIL exits 1. Any SKIP also exits 1 by default — a skipped invariant
 * is an unconfigured run, not a tolerated one, and this script must never let a caller
 * mistake "didn't check" for "checked and fine". Pass --allow-skip to opt into exit 0 when
 * skips are present but nothing actually failed (e.g. deliberately running only the
 * dist-content checks (a)/(b) against an already-built artifact with no source tree on
 * hand to mutate). --allow-skip never suppresses a FAIL.
 */
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const outdir = arg('outdir');
const externals = (arg('externals', '') || '').split(',').filter(Boolean);
const sidecars = (arg('sidecars', '') || '').split(',').filter(Boolean);
const buildCmd = arg('build-cmd');
const rebuildCmd = arg('rebuild-cmd', buildCmd);
const sourceToMutate = arg('source');
const allowSkip = process.argv.includes('--allow-skip');

if (!outdir) {
  console.error('usage: --outdir <dir> --externals <a,b> [--sidecars <x.js,y.js>] [--build-cmd "..."] [--source <file>] [--rebuild-cmd "..."] [--allow-skip]');
  process.exit(2);
}

const TOTAL_INVARIANTS = 5;
let passed = 0;
let failed = 0;
let skipped = 0;

/**
 * status: true -> PASS, false -> FAIL, 'skip' -> SKIP (not verified — see BL-469).
 * A skipped invariant MUST NOT increment `passed` and MUST NOT be printed as PASS —
 * that is the exact defect this function exists to prevent from recurring.
 */
function report(name, status, detail) {
  const label = status === 'skip' ? 'SKIP' : status ? 'PASS' : 'FAIL';
  console.log(`[${label}] ${name}${detail ? ' — ' + detail : ''}`);
  if (status === 'skip') skipped++;
  else if (status) passed++;
  else failed++;
}

// ---------------------------------------------------------------------------
// (a) Self-contained bundle + externalized natives with lazy-load semantics
// ---------------------------------------------------------------------------
function checkSelfContained() {
  const indexPath = path.join(outdir, 'index.js');
  if (!fs.existsSync(indexPath)) { report('(a) self-contained bundle', false, `${indexPath} missing`); return; }
  const text = fs.readFileSync(indexPath, 'utf8');
  const soxRequireRe = /require\(['"]@adhd\/sox-/g;
  const soxRefs = text.match(soxRequireRe) || [];
  if (soxRefs.length > 0) {
    report('(a) self-contained bundle', false, `${soxRefs.length} unresolved @adhd/sox-* require() calls remain (should be 0 — every workspace package must be inlined)`);
    return;
  }
  const lazyOk = [];
  const lazyMissing = [];
  for (const ext of externals) {
    // The lazy stub pattern: createRequire(...)(<pkg>) — matches bundle-extension.cjs's
    // lazyExternalPlugin output verbatim. A DIRECT top-level `require("pkg")` without
    // the createRequire indirection would mean the external loads eagerly, not lazily.
    const lazyRe = new RegExp(`createRequire\\([^)]*\\)\\(${ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/^"|"$/g, '')}`);
    const directRe = new RegExp(`(?<!_cr\\()require\\(['"]${ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\)`);
    if (lazyRe.test(text)) lazyOk.push(ext);
    else if (directRe.test(text)) lazyMissing.push(ext);
    // if neither pattern matches, the external may simply not be referenced by this
    // particular entry file (e.g. main entry doesn't touch fastembed directly) — not a failure.
  }
  if (lazyMissing.length > 0) {
    report('(a) self-contained bundle', false, `externals loaded eagerly (no createRequire lazy stub): ${lazyMissing.join(', ')}`);
    return;
  }
  report('(a) self-contained bundle', true, `0 unresolved @adhd/sox-* refs; lazy-external stub present for: ${lazyOk.join(', ') || '(none referenced by main entry)'}`);
}

// ---------------------------------------------------------------------------
// (b) Sidecar emission + fail-on-missing output verification
// ---------------------------------------------------------------------------
function checkSidecars() {
  if (sidecars.length === 0) { report('(b) sidecar emission', true, '(no sidecars declared for this bundle)'); return; }
  const missing = sidecars.filter((s) => !fs.existsSync(path.join(outdir, s)));
  if (missing.length > 0) {
    report('(b) sidecar emission', false, `missing: ${missing.join(', ')}`);
    return;
  }
  // Also run the actual verifySidecarReferences scan logic (bundler-agnostic —
  // it only reads emitted output, never cares which tool produced it).
  const emitted = new Set(fs.readdirSync(outdir).filter((f) => f.endsWith('.js')));
  const refRe = /__dirname[^;\n]{0,160}?['"]([A-Za-z0-9][\w.-]*\.js)['"]/g;
  const danglingRefs = [];
  for (const file of emitted) {
    const text = fs.readFileSync(path.join(outdir, file), 'utf8');
    let m;
    while ((m = refRe.exec(text)) !== null) {
      if (!emitted.has(m[1])) danglingRefs.push(`${m[1]} (referenced by ${file})`);
    }
  }
  if (danglingRefs.length > 0) {
    report('(b) sidecar emission', false, `dangling __dirname-sibling refs: ${danglingRefs.join(', ')}`);
    return;
  }
  report('(b) sidecar emission', true, `all declared sidecars present: ${sidecars.join(', ')}; no dangling __dirname refs`);
}

// ---------------------------------------------------------------------------
// (c) Atomic never-destroy-working-artifact output (BL-235)
// ---------------------------------------------------------------------------
function checkAtomicity() {
  if (!buildCmd || !sourceToMutate) { report('(c) atomic never-destroy', 'skip', 'no --build-cmd/--source given — NOT verified'); return; }
  const before = fs.existsSync(outdir) ? fs.readdirSync(outdir).sort() : null;
  if (!before || before.length === 0) { report('(c) atomic never-destroy', false, 'no pre-existing artifact to protect — run a successful build first'); return; }

  const backup = fs.readFileSync(sourceToMutate, 'utf8');
  fs.writeFileSync(sourceToMutate, backup + '\nthis is not valid typescript!! %%%$$$ syntax error injection for BL-266 test\n');
  let buildFailed = false;
  try {
    execSync(buildCmd, { stdio: 'pipe' });
  } catch {
    buildFailed = true;
  } finally {
    fs.writeFileSync(sourceToMutate, backup);
  }
  if (!buildFailed) {
    report('(c) atomic never-destroy', false, 'build against broken source did not fail — cannot exercise the invariant');
    return;
  }
  const after = fs.existsSync(outdir) ? fs.readdirSync(outdir).sort() : null;
  const survived = after !== null && after.length > 0 && JSON.stringify(after) === JSON.stringify(before);
  report('(c) atomic never-destroy', survived, survived
    ? `broken-source build failed as expected; ${outdir} unchanged (${after.length} files)`
    : `broken-source build failed, but ${outdir} was altered/destroyed (before=${before?.length ?? 'n/a'} files, after=${after?.length ?? 'MISSING'} files)`);
}

// ---------------------------------------------------------------------------
// (d) Typecheck as a first-class gate (BL-248)
// ---------------------------------------------------------------------------
function checkTypecheckGate() {
  if (!buildCmd || !sourceToMutate) { report('(d) typecheck gate', 'skip', 'no --build-cmd/--source given — NOT verified'); return; }
  const backup = fs.readFileSync(sourceToMutate, 'utf8');
  // A real TYPE error (not a syntax error) — valid JS/TS syntax, wrong type.
  fs.writeFileSync(sourceToMutate, backup + '\nconst __bl266TypeErrorProbe: number = "this is a string, not a number";\n');
  let buildFailedOnTypeError = false;
  try {
    execSync(buildCmd, { stdio: 'pipe' });
  } catch {
    buildFailedOnTypeError = true;
  } finally {
    fs.writeFileSync(sourceToMutate, backup);
  }
  report('(d) typecheck gate', buildFailedOnTypeError, buildFailedOnTypeError
    ? 'build command failed on a pure type error (assigning string to number)'
    : 'build command SUCCEEDED despite a real type error — typecheck is not gating this build target');
}

// ---------------------------------------------------------------------------
// (e) Registry checksum stability across no-op rebuilds
// ---------------------------------------------------------------------------
function sha256Dir(dir) {
  const hash = crypto.createHash('sha256');
  const files = fs.readdirSync(dir).filter((f) => !f.endsWith('.map')).sort(); // sourcemaps embed absolute staging paths by design (§ linked sourcemap) — excluded from the identity check deliberately
  for (const f of files) {
    hash.update(f);
    hash.update(fs.readFileSync(path.join(dir, f)));
  }
  return hash.digest('hex');
}
function checkChecksumStability() {
  if (!rebuildCmd) { report('(e) checksum stability', 'skip', 'no --rebuild-cmd given — NOT verified'); return; }
  const before = sha256Dir(outdir);
  execSync(rebuildCmd, { stdio: 'pipe' });
  const after = sha256Dir(outdir);
  report('(e) checksum stability', before === after, before === after
    ? `identical sha256 across no-op rebuild (excluding .map sourcemaps)`
    : `sha256 CHANGED across a no-op rebuild with no source changes (before=${before.slice(0, 12)} after=${after.slice(0, 12)})`);
}

checkSelfContained();
checkSidecars();
checkAtomicity();
checkTypecheckGate();
checkChecksumStability();

console.log('');
if (failed > 0) {
  console.log(`${failed} INVARIANT(S) FAILED (${passed} passed, ${skipped} skipped)`);
} else if (skipped > 0) {
  console.log(
    `${passed}/${TOTAL_INVARIANTS} INVARIANTS VERIFIED PASS, ${skipped}/${TOTAL_INVARIANTS} SKIPPED (not verified) — ` +
      `NOT all ${TOTAL_INVARIANTS} invariants pass; re-run with --build-cmd/--source/--rebuild-cmd to verify the rest`
  );
} else {
  console.log(`ALL ${TOTAL_INVARIANTS} INVARIANTS PASS`);
}

// Exit contract (BL-469 / BL-466): FAIL always exits 1. SKIP exits 1 by default — an
// unconfigured run must not be mistaken for a clean one — unless the caller explicitly
// opts in via --allow-skip, which never suppresses a genuine FAIL.
const exitCode = failed > 0 ? 1 : skipped > 0 && !allowSkip ? 1 : 0;
process.exit(exitCode);
