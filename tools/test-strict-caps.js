/**
 * test-strict-caps.js — P5 acceptance: strict_capabilities hard-block proof.
 *
 * Design contract (design.md §1.3, install.ts §strict_capabilities):
 *   - strict_capabilities:true + a provider that lacks required capabilities
 *     → install MUST hard-block (process.exit(1)).
 *   - strict_capabilities:true + a capable provider (or absent strict_capabilities)
 *     → install MUST succeed (exit 0).
 *
 * Approach: spawn child processes that invoke install.ts programmatically
 * (via tsx) with synthetic configs, assert the exit code.
 *
 * Two assertions:
 *   (a) HARD-BLOCK: config with strict_capabilities:true + incapable provider → exit != 0
 *   (b) PASS: config with default provider (capable) + strict_capabilities:true → exit 0
 *
 * Providers used:
 *   INSUFFICIENT: "ollama/llama3" — supports_response_schema:false, which fails
 *     memory-server's requires.structured_output:true under strict mode.
 *   DEFAULT (capable): "anthropic/claude-sonnet-4-5" — supports_response_schema:true,
 *     max_input_tokens:200000 — satisfies all memory extension requires blocks.
 *
 * Exit codes: 0 = all assertions pass, 1 = any assertion fails.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

function ok(label, cond) {
  if (cond) {
    console.log(`  OK: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

function fail(label, msg) {
  console.error(`  FAIL: ${label} — ${msg}`);
  failed++;
}

// ── Helper: run install.ts in a subprocess with a synthetic config ────────────

/**
 * Create a minimal extension.json for a test extension that requires
 * structured_output:true (like memory-server).
 *
 * We create a real extension dir that `loadExtensionManifest` can find.
 * The extensions in the monorepo already have this — we can use memory-server
 * directly via a synthetic scope config that points to it.
 */
function runInstall(opts) {
  const { scopeConfig, expectExit } = opts;

  // Write a temp config file
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-strict-caps-'));
  const configPath = path.join(tmpDir, 'extensions.json');
  fs.writeFileSync(configPath, JSON.stringify(scopeConfig, null, 2));

  // Run install via tsx (imports the source TS directly)
  const tsxBin = path.join(ROOT, 'node_modules', '.bin', 'tsx');

  // We invoke a small inline script that calls install() and exits appropriately.
  // install.ts calls process.exit(1) on hard-block, so we capture that exit code.
  const helperScript = `
import { install } from '${path.join(ROOT, 'scripts', 'install.ts').replace(/\\/g, '/')}';
try {
  await install({
    scope: 'project',
    mode: 'default',
    configPath: '${configPath.replace(/\\/g, '/')}',
    root: '${ROOT.replace(/\\/g, '/')}',
  });
  process.exit(0);
} catch(e) {
  console.error('[strict-caps-test] install threw:', e.message);
  process.exit(2);
}
`;

  const helperPath = path.join(tmpDir, 'run-install.mts');
  fs.writeFileSync(helperPath, helperScript);

  const result = spawnSync(tsxBin, [helperPath], {
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    encoding: 'utf8',
    timeout: 30000,
  });

  // Cleanup
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}

  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// ── Test setup: build a test config that triggers capability check ────────────

console.log('test-strict-caps.js: testing strict_capabilities hard-block...\n');

// ── (a) HARD-BLOCK: incapable provider + strict_capabilities:true ─────────────

console.log('--- (a) HARD-BLOCK: strict_capabilities:true + incapable provider ---');

// "ollama/llama3" has supports_response_schema:false → fails structured_output:true check
// memory-server requires structured_output:true and min_context_tokens:8192
const strictBlockConfig = {
  strict_capabilities: true,
  providers: {
    'ollama-local': {
      base_url: 'http://localhost:11434',
      api_key: 'ollama',
    },
  },
  install: [
    {
      id: 'memory-server',
      version: '^0.1.0',
      source: `file://${path.join(ROOT, 'extensions', 'mcp-servers', 'memory-server')}`,
    },
  ],
};

// Override the provider to the incapable one
// install.ts reads providers from config → resolveActiveProvider picks the first one.
// We need to inject the model string; let's check how resolveActiveProvider works.
// Actually, the issue is: install.ts uses `resolveActiveProvider` which picks the model
// from `providers.<name>.model` or falls back to something. But the capability table
// keys are "ollama/llama3" etc.
// The install.ts `resolveActiveProvider` path needs a `model` field in the provider config,
// OR we use the `overrideProvider` option in install().
//
// Since we're calling via spawn, we need to embed the override in the helper script.
// Let's use the overrideProvider option directly.

const strictBlockConfigSimple = {
  strict_capabilities: true,
  install: [
    {
      id: 'memory-server',
      version: '^0.1.0',
      source: `file://${path.join(ROOT, 'extensions', 'mcp-servers', 'memory-server')}`,
    },
  ],
};

// Run with overrideProvider pointing to an incapable model
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-strict-caps-block-'));
  const configPath = path.join(tmpDir, 'extensions.json');
  fs.writeFileSync(configPath, JSON.stringify(strictBlockConfigSimple, null, 2));

  const tsxBin = path.join(ROOT, 'node_modules', '.bin', 'tsx');
  const helperScript = `
import { install } from '${path.join(ROOT, 'scripts', 'install.ts').replace(/\\/g, '/')}';
try {
  await install({
    scope: 'project',
    mode: 'default',
    configPath: '${configPath.replace(/\\/g, '/')}',
    root: '${ROOT.replace(/\\/g, '/')}',
    overrideProvider: 'ollama/llama3',
  });
  process.exit(0);
} catch(e) {
  console.error('[strict-caps-test] install threw:', e?.message ?? e);
  process.exit(2);
}
`;

  const helperPath = path.join(tmpDir, 'run.mts');
  fs.writeFileSync(helperPath, helperScript);

  const result = spawnSync(tsxBin, [helperPath], {
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    encoding: 'utf8',
    timeout: 30000,
  });

  const exitCode = result.status ?? -1;

  // Should exit non-zero (hard-block)
  ok(
    'strict_capabilities:true + ollama/llama3 (no structured_output) → hard-block (exit != 0)',
    exitCode !== 0,
  );
  console.log(
    `    exit code: ${exitCode} (${exitCode !== 0 ? 'hard-blocked as expected' : 'UNEXPECTED PASS'})`,
  );

  // Confirm the stderr mentions capability mismatch
  const combinedOut = result.stdout + result.stderr;
  const hasMismatchMsg =
    combinedOut.includes('CAPABILITY MISMATCH') ||
    combinedOut.includes('structured_output') ||
    combinedOut.includes('hard-block');
  ok(
    'stderr mentions capability mismatch / hard-block reason',
    hasMismatchMsg,
  );
  if (!hasMismatchMsg) {
    console.log(`    stdout: ${result.stdout.slice(0, 200)}`);
    console.log(`    stderr: ${result.stderr.slice(0, 200)}`);
  }

  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
}

// ── (b) PASS: capable provider + strict_capabilities:true ────────────────────

console.log('\n--- (b) PASS: strict_capabilities:true + capable provider ---');

// "anthropic/claude-sonnet-4-5" satisfies structured_output:true and min_context_tokens checks
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-strict-caps-pass-'));
  const configPath = path.join(tmpDir, 'extensions.json');

  const passConfig = {
    strict_capabilities: true,
    install: [
      {
        id: 'memory-server',
        version: '^0.1.0',
        source: `file://${path.join(ROOT, 'extensions', 'mcp-servers', 'memory-server')}`,
      },
    ],
  };
  fs.writeFileSync(configPath, JSON.stringify(passConfig, null, 2));

  const tsxBin = path.join(ROOT, 'node_modules', '.bin', 'tsx');
  const helperScript = `
import { install } from '${path.join(ROOT, 'scripts', 'install.ts').replace(/\\/g, '/')}';
try {
  await install({
    scope: 'project',
    mode: 'default',
    configPath: '${configPath.replace(/\\/g, '/')}',
    root: '${ROOT.replace(/\\/g, '/')}',
    overrideProvider: 'anthropic/claude-sonnet-4-5',
  });
  process.exit(0);
} catch(e) {
  console.error('[strict-caps-test] install threw:', e?.message ?? e);
  process.exit(2);
}
`;

  const helperPath = path.join(tmpDir, 'run.mts');
  fs.writeFileSync(helperPath, helperScript);

  const result = spawnSync(tsxBin, [helperPath], {
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    encoding: 'utf8',
    timeout: 30000,
  });

  const exitCode = result.status ?? -1;

  ok(
    'strict_capabilities:true + anthropic/claude-sonnet-4-5 (capable) → pass (exit 0)',
    exitCode === 0,
  );
  console.log(
    `    exit code: ${exitCode} (${exitCode === 0 ? 'passed as expected' : 'UNEXPECTED BLOCK'})`,
  );
  if (exitCode !== 0) {
    console.log(`    stdout: ${result.stdout.slice(0, 400)}`);
    console.log(`    stderr: ${result.stderr.slice(0, 400)}`);
  }

  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
}

// ── (c) PASS: default provider absent + strict_capabilities:true → unknown model warns but passes

console.log('\n--- (c) EDGE: strict_capabilities:true + unknown provider → warn + pass ---');

// When provider is not in the capability table, checkProviderCapabilities returns
// { ok: true, warnings: ["Unknown model..."] } — conservative pass.
// Under strict_capabilities, this should NOT hard-block (unknown is ok:true).
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-strict-caps-unk-'));
  const configPath = path.join(tmpDir, 'extensions.json');

  const unknownProviderConfig = {
    strict_capabilities: true,
    install: [
      {
        id: 'memory-server',
        version: '^0.1.0',
        source: `file://${path.join(ROOT, 'extensions', 'mcp-servers', 'memory-server')}`,
      },
    ],
  };
  fs.writeFileSync(configPath, JSON.stringify(unknownProviderConfig, null, 2));

  const tsxBin = path.join(ROOT, 'node_modules', '.bin', 'tsx');
  const helperScript = `
import { install } from '${path.join(ROOT, 'scripts', 'install.ts').replace(/\\/g, '/')}';
try {
  await install({
    scope: 'project',
    mode: 'default',
    configPath: '${configPath.replace(/\\/g, '/')}',
    root: '${ROOT.replace(/\\/g, '/')}',
    overrideProvider: 'unknown/some-new-model-xyz',
  });
  process.exit(0);
} catch(e) {
  console.error('[strict-caps-test] install threw:', e?.message ?? e);
  process.exit(2);
}
`;

  const helperPath = path.join(tmpDir, 'run.mts');
  fs.writeFileSync(helperPath, helperScript);

  const result = spawnSync(tsxBin, [helperPath], {
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    encoding: 'utf8',
    timeout: 30000,
  });

  const exitCode = result.status ?? -1;

  // Unknown model: checkProviderCapabilities returns ok:true (conservative pass)
  // so strict_capabilities should NOT block
  ok(
    'strict_capabilities:true + unknown provider (conservative pass) → exit 0',
    exitCode === 0,
  );
  console.log(
    `    exit code: ${exitCode} (${exitCode === 0 ? 'conservatively passed as expected' : 'unexpected block'})`,
  );

  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('');
if (failed === 0) {
  console.log(`test-strict-caps.js: ALL ASSERTIONS PASSED (${passed} checks)`);
  console.log('  (a) strict_capabilities:true + incapable provider → hard-block confirmed');
  console.log('  (b) strict_capabilities:true + capable provider → pass confirmed');
  console.log('  (c) strict_capabilities:true + unknown provider → conservative pass confirmed');
  process.exit(0);
} else {
  console.error(`test-strict-caps.js: FAILED (${failed} assertion(s) failed, ${passed} passed)`);
  process.exit(1);
}
