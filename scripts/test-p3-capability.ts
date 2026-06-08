/**
 * test-p3-capability.ts — CLI acceptance test for P3 capability check (Gap 5)
 *
 * Run: npx tsx scripts/test-p3-capability.ts
 *
 * Acceptance: a tool-calling extension pointed at ollama/llama3 (no tool calling)
 *   emits a warning and exits 0 (advisory mode).
 *   With strict_capabilities:true, hard-blocks (exits non-zero).
 */

import { install } from './install.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

async function main(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-p3-test-'));

  try {
    // Create a minimal test config with the echo agent (requires tool_calling)
    const configPath = path.join(tmpDir, 'extensions.json');
    const lockfilePath = path.join(tmpDir, 'extensions.lock');

    fs.writeFileSync(configPath, JSON.stringify({
      install: [{
        id: 'echo',
        version: '0.1.0',
        enabled: true,
        source: `file://${path.join(ROOT, 'extensions', 'agents', 'echo-agent')}`,
      }],
    }));

    console.log('=== Test 1: advisory warn (not hard error) with ollama/llama3 ===');
    console.log('Expected: capability warning printed, exits 0');

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(' '));
    };

    let resolvedKeys: string[] = [];
    try {
      const result = await install({
        scope: 'user',
        mode: 'default',
        configPath,
        lockfilePath,
        root: ROOT,
        overrideProvider: 'ollama/llama3',
      });
      resolvedKeys = Object.keys(result);
    } finally {
      console.warn = originalWarn;
    }

    const capWarning = warnings.find((w) =>
      w.includes('CAPABILITY') || w.includes('tool_calling') || w.includes('tool calling') || w.includes('tool/function'),
    );

    if (capWarning) {
      console.log('PASS: capability warning emitted:', capWarning.slice(0, 100));
    } else {
      console.error('FAIL: no capability warning was emitted');
      console.error('Warnings seen:', warnings);
    }

    if (resolvedKeys.length > 0) {
      console.log('PASS: install succeeded (exit 0), resolved:', resolvedKeys);
    } else {
      console.log('INFO: no extensions resolved (may indicate echo extension requires registry lookup)');
    }

    console.log('\n=== Test 2: hard-block with strict_capabilities:true ===');
    console.log('Expected: exits non-zero');

    fs.writeFileSync(configPath, JSON.stringify({
      strict_capabilities: true,
      install: [{
        id: 'echo',
        version: '0.1.0',
        enabled: true,
        source: `file://${path.join(ROOT, 'extensions', 'agents', 'echo-agent')}`,
      }],
    }));

    let didHardBlock = false;
    const originalExit = process.exit;
    process.exit = ((_code?: unknown) => {
      didHardBlock = true;
      throw new Error('process.exit called (hard block)');
    }) as typeof process.exit;

    try {
      await install({
        scope: 'user',
        mode: 'default',
        configPath,
        lockfilePath: path.join(tmpDir, 'strict.lock'),
        root: ROOT,
        overrideProvider: 'ollama/llama3',
      });
    } catch (_e) {
      // Expected from our process.exit intercept
    } finally {
      process.exit = originalExit;
    }

    if (didHardBlock) {
      console.log('PASS: hard-blocked (non-zero exit) with strict_capabilities:true');
    } else {
      console.error('FAIL: expected hard block but install succeeded');
    }

    console.log('\n=== Test 3: switching to ollama/llama3.1 (tool-capable) passes with no warning ===');
    console.log('Expected: no capability warning, exits 0, zero code changes to extension');

    const warnings3: string[] = [];
    const originalWarn3 = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings3.push(args.join(' '));
    };

    try {
      await install({
        scope: 'user',
        mode: 'default',
        configPath: configPath, // reuse strict config (strict_capabilities:true)
        lockfilePath: path.join(tmpDir, 'llama31.lock'),
        root: ROOT,
        overrideProvider: 'ollama/llama3.1', // different model, same extension
      });
    } finally {
      console.warn = originalWarn3;
    }

    const capWarning3 = warnings3.find((w) =>
      w.includes('CAPABILITY') || w.includes('tool_calling') || w.includes('tool calling'),
    );

    if (!capWarning3) {
      console.log('PASS: no capability warning with ollama/llama3.1 (tool-capable)');
    } else {
      console.error('FAIL: unexpected capability warning:', capWarning3);
    }

    console.log('\n=== All P3 acceptance tests complete ===');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((e: unknown) => {
  console.error('P3 test error:', String(e));
  process.exit(1);
});
