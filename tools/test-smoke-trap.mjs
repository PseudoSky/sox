#!/usr/bin/env node
/**
 * tools/test-smoke-trap.mjs — regression test for clean-room-smoke.sh's
 * registry/index.json snapshot+restore trap.
 *
 * WHY THIS EXISTS
 * `scripts/acceptance/clean-room-smoke.sh` is the canonical "is it publishable?"
 * gate, and step 3 regenerates the REAL `$REPO/registry/index.json` in place via
 * `SOX_REGISTRY_PUBLISH=npm build-index`. That file is not a build artifact: its
 * checksums are deliberately pinned to published npm bytes (304513c4), while
 * `build-index` recomputes them from LOCAL disk bytes. Before the trap fix, the
 * cleanup handler only killed verdaccio — so running the gate you must pass
 * before publishing silently destroyed the supply-chain record you were about to
 * publish.
 *
 * WHAT IT ASSERTS
 * The restore fires on EVERY exit path, not just the happy one:
 *   1. SIGINT mid-run (Ctrl-C)      — the path a human actually hits
 *   2. `set -e` bail-out (failure)  — the path the real run took on 2026-09-22
 *   3. clean exit with no mutation  — must report "unchanged", not thrash the file
 *
 * HOW IT STAYS HONEST
 * The trap code is EXTRACTED FROM THE SHIPPED SCRIPT at runtime rather than
 * copied here. A copy would silently pass forever after someone edited the real
 * script; extraction means this test fails the moment the guard is removed or
 * renamed. If the extraction markers ever stop matching, the test fails loudly
 * instead of vacuously passing.
 *
 * Usage: node tools/test-smoke-trap.mjs
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// SMOKE_SCRIPT_PATH exists so this test can be pointed at a PRE-FIX copy of the
// script to prove it genuinely goes red when the guard is absent — a test that
// has never been observed failing is not evidence (BL-167).
const smokePath =
  process.env['SMOKE_SCRIPT_PATH'] ||
  path.join(repoRoot, 'scripts', 'acceptance', 'clean-room-smoke.sh');

const START = 'REGISTRY_INDEX=';
const END = 'trap cleanup EXIT';

/** Pull the live trap block out of the shipped script. */
function extractTrapBlock() {
  const src = fs.readFileSync(smokePath, 'utf8');
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.startsWith(START));
  const end = lines.findIndex((l) => l.startsWith(END));
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `test-smoke-trap: could not locate the trap block in ${smokePath} ` +
        `(looked for a line starting "${START}" and one starting "${END}"). ` +
        'The guard was removed, renamed, or restructured — that is the failure this test exists to catch.',
    );
  }
  return lines.slice(start, end + 1).join('\n');
}

let failures = 0;
const results = [];

function check(name, ok, detail) {
  results.push(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/**
 * Run the extracted trap in a throwaway repo, mutate the registry, then exit the
 * requested way. Resolves with the file's contents afterwards.
 */
function runScenario({ mutate, ending, signal }) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-trap-'));
  const repo = path.join(work, 'repo');
  fs.mkdirSync(path.join(repo, 'registry'), { recursive: true });
  const indexPath = path.join(repo, 'registry', 'index.json');
  const ORIGINAL = JSON.stringify([{ id: 'memory-server', checksum: 'sha256:PINNED' }], null, 2);
  fs.writeFileSync(indexPath, ORIGINAL);

  const body = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `REPO="${repo}"`,
    `WORK="${path.join(work, 'scratch')}"`,
    'mkdir -p "$WORK"',
    extractTrapBlock(),
    // Stand in for step 3's destructive `build-index` regeneration.
    mutate ? `printf '%s' 'CLOBBERED-BY-BUILD-INDEX' > "$REGISTRY_INDEX"` : 'true',
    'echo READY',
    ending,
  ].join('\n');

  const scriptPath = path.join(work, 'harness.sh');
  fs.writeFileSync(scriptPath, body, { mode: 0o755 });

  return new Promise((resolve) => {
    const child = spawn('bash', [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += String(d);
      if (signal && out.includes('READY')) {
        child.kill(signal);
        signal = null;
      }
    });
    child.on('close', () => {
      resolve({ contents: fs.readFileSync(indexPath, 'utf8'), stdout: out, ORIGINAL, work });
    });
  });
}

const SIGINT_SLEEP = 'sleep 30';
const FAILING = 'false';
const CLEAN = 'true';

const sigint = await runScenario({ mutate: true, ending: SIGINT_SLEEP, signal: 'SIGINT' });
check(
  'SIGINT mid-run restores the pinned index',
  sigint.contents === sigint.ORIGINAL,
  sigint.contents === sigint.ORIGINAL ? 'byte-identical' : `got ${JSON.stringify(sigint.contents.slice(0, 40))}`,
);
check('SIGINT path reports the restore', /RESTORED/.test(sigint.stdout), sigint.stdout.trim().split('\n').pop());

const bail = await runScenario({ mutate: true, ending: FAILING, signal: null });
check(
  'set -e bail-out restores the pinned index',
  bail.contents === bail.ORIGINAL,
  bail.contents === bail.ORIGINAL ? 'byte-identical' : `got ${JSON.stringify(bail.contents.slice(0, 40))}`,
);

const clean = await runScenario({ mutate: false, ending: CLEAN, signal: null });
check(
  'untouched index is left alone and reported "unchanged"',
  clean.contents === clean.ORIGINAL && /unchanged/.test(clean.stdout),
  clean.stdout.trim().split('\n').pop(),
);

console.log('test-smoke-trap: clean-room-smoke.sh registry restore guard');
console.log(results.join('\n'));
if (failures > 0) {
  console.error(`test-smoke-trap: FAIL — ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('test-smoke-trap: OK — restore fires on interrupt, on failure, and is a no-op when clean.');
