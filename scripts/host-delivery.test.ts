/**
 * scripts/host-delivery.test.ts — P5 delivery-path tests.
 *
 * Tests for:
 *   - MCP registrar (host-side client, discovers tools from spawned server)
 *   - Prompt renderer (template substitution, parameter validation)
 *   - Command dispatch wiring (CommandRegistry → bin/sox verb surface)
 *   - Agent/skill invoker (in-process delivery)
 *
 * Closes analysis row #9 (runtime → delivered to consumer) for all 5 types.
 * Closes audit Gap C2 (MCP registrar), C3/C6 (command dispatcher).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

// ─── Prompt renderer ──────────────────────────────────────────────────────────

import { PromptRenderer } from './host/prompt-renderer.js';

describe('PromptRenderer — basic substitution', () => {
  let tmpDir: string;
  let renderer: PromptRenderer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-test-'));
    renderer = new PromptRenderer();
    fs.writeFileSync(
      path.join(tmpDir, 'extension.json'),
      JSON.stringify({
        id: 'test-prompt',
        version: '0.1.0',
        type: 'prompt',
        template_engine: 'handlebars',
        parameters: [
          { name: 'name', type: 'string', required: true },
          { name: 'context', type: 'string', required: false },
        ],
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('substitutes a required parameter', () => {
    const result = renderer.render({
      extDir: tmpDir,
      params: { name: 'Alice' },
      templateContent: 'Hello {{name}}!',
    });
    expect(result.rendered).toBe('Hello Alice!');
    expect(result.promptId).toBe('test-prompt');
  });

  it('handles optional parameters conditionally', () => {
    const result = renderer.render({
      extDir: tmpDir,
      params: { name: 'Bob', context: 'morning standup' },
      templateContent: 'Hello {{name}}!{{#if context}} Context: {{context}}{{/if}}',
    });
    expect(result.rendered).toBe('Hello Bob! Context: morning standup');
  });

  it('omits conditional block when optional param is absent', () => {
    const result = renderer.render({
      extDir: tmpDir,
      params: { name: 'Carol' },
      templateContent: 'Hello {{name}}!{{#if context}} Context: {{context}}{{/if}}',
    });
    expect(result.rendered).toBe('Hello Carol!');
  });

  it('throws when required parameter is missing', () => {
    expect(() =>
      renderer.render({
        extDir: tmpDir,
        params: {},
        templateContent: 'Hello {{name}}!',
      }),
    ).toThrow(/Required parameter "name"/);
  });

  it('warns about unknown parameters but still substitutes them', () => {
    const result = renderer.render({
      extDir: tmpDir,
      params: { name: 'Dave', unknown_param: 'value' },
      templateContent: '{{name}} {{unknown_param}}',
    });
    expect(result.rendered).toBe('Dave value');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('unknown_param');
  });

  it('throws for non-prompt extension type', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'extension.json'),
      JSON.stringify({ id: 'not-prompt', version: '0.1.0', type: 'skill' }),
    );
    expect(() =>
      renderer.render({
        extDir: tmpDir,
        params: { name: 'test' },
        templateContent: '{{name}}',
      }),
    ).toThrow(/expected "prompt"/);
  });

  it('HTML-escapes double-brace substitution', () => {
    const result = renderer.render({
      extDir: tmpDir,
      params: { name: '<script>alert("xss")</script>' },
      templateContent: '{{name}}',
    });
    expect(result.rendered).toContain('&lt;script&gt;');
    expect(result.rendered).not.toContain('<script>');
  });

  it('does NOT escape triple-brace substitution', () => {
    const result = renderer.render({
      extDir: tmpDir,
      params: { name: '<b>bold</b>' },
      templateContent: '{{{name}}}',
    });
    expect(result.rendered).toBe('<b>bold</b>');
  });

  it('handles {{else}} in conditional blocks', () => {
    const result = renderer.render({
      extDir: tmpDir,
      params: { name: 'Eve' },
      templateContent: '{{#if context}}ctx: {{context}}{{else}}no-ctx{{/if}}',
    });
    expect(result.rendered).toBe('no-ctx');
  });
});

describe('PromptRenderer — greeting-prompt integration', () => {
  it('renders the real greeting-prompt template with name and context', () => {
    const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    const extDir = path.join(ROOT, 'extensions', 'prompts', 'greeting-prompt');

    if (!fs.existsSync(path.join(extDir, 'extension.json'))) {
      // skip if not present (shouldn't happen)
      return;
    }

    const renderer = new PromptRenderer();
    const result = renderer.render({
      extDir,
      params: { name: 'Alice', context: 'morning standup' },
    });

    expect(result.promptId).toBe('greeting');
    expect(result.rendered).toContain('Alice');
    expect(result.rendered).toContain('morning standup');
    expect(result.warnings).toHaveLength(0);
  });

  it('renders the real greeting-prompt template with name only', () => {
    const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    const extDir = path.join(ROOT, 'extensions', 'prompts', 'greeting-prompt');

    if (!fs.existsSync(path.join(extDir, 'extension.json'))) {
      return;
    }

    const renderer = new PromptRenderer();
    const result = renderer.render({
      extDir,
      params: { name: 'Bob' },
    });

    expect(result.rendered).toContain('Bob');
    expect(result.warnings).toHaveLength(0);
  });
});

// ─── MCP Registrar (McpClient) — unit tests without spawning ─────────────────

import { McpRegistrar, McpClient } from './host/registrar.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

/** Build a fake child process with controllable stdout for MCP protocol testing. */
function makeFakeProc(): {
  proc: ChildProcess;
  sendLine: (line: string) => void;
  stdinLines: string[];
} {
  // Use a proper PassThrough stream so readline.createInterface can call resume()
  const stdout = new PassThrough();
  const stdinLines: string[] = [];
  const stdin = {
    write: (data: string) => { stdinLines.push(data); return true; },
  };

  const proc = new EventEmitter() as unknown as ChildProcess;
  (proc as unknown as Record<string, unknown>).stdout = stdout;
  (proc as unknown as Record<string, unknown>).stdin = stdin;
  (proc as unknown as Record<string, unknown>).exitCode = null;

  const sendLine = (line: string) => {
    stdout.write(line + '\n');
  };

  return { proc, sendLine, stdinLines };
}

describe('McpClient — JSON-RPC over fake stdio', () => {
  it('sends a request and resolves on matching response', async () => {
    const { proc, sendLine, stdinLines } = makeFakeProc();
    const client = new McpClient(proc as ChildProcess);

    // Initiate the call (do not await yet — response arrives async)
    const callPromise = client.call('initialize', { protocolVersion: '2024-11-05' });

    // Simulate server sending back id=1 response
    await new Promise((r) => setTimeout(r, 10));
    const reqLine = stdinLines[0];
    expect(reqLine).toBeDefined();
    const req = JSON.parse(reqLine!.trim()) as { id: number };
    sendLine(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { serverInfo: { name: 'test', version: '1.0.0' }, capabilities: {} } }));

    const result = await callPromise as { serverInfo: { name: string } };
    expect(result.serverInfo.name).toBe('test');

    client.close();
  });

  it('rejects on error response', async () => {
    const { proc, sendLine, stdinLines } = makeFakeProc();
    const client = new McpClient(proc as ChildProcess);

    const callPromise = client.call('unknown/method', undefined, 5000);

    await new Promise((r) => setTimeout(r, 10));
    const req = JSON.parse(stdinLines[0]!.trim()) as { id: number };
    sendLine(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } }));

    await expect(callPromise).rejects.toThrow(/Method not found/);
    client.close();
  });
});

describe('McpRegistrar — registration and tool exposure', () => {
  it('registers a server and exposes its tools', async () => {
    const { proc, sendLine, stdinLines } = makeFakeProc();
    const registrar = new McpRegistrar();

    // Drive the registration (sends initialize, then tools/list)
    const regPromise = registrar.register('test-server@0.1.0', proc as ChildProcess, 5000);

    // Wait for initialize request
    await new Promise((r) => setTimeout(r, 10));
    let req = JSON.parse(stdinLines[0]!.trim()) as { id: number; method: string };
    expect(req.method).toBe('initialize');
    sendLine(JSON.stringify({
      jsonrpc: '2.0', id: req.id,
      result: { serverInfo: { name: 'test-server', version: '0.1.0' }, capabilities: { tools: {} } },
    }));

    // Wait for tools/list request
    await new Promise((r) => setTimeout(r, 10));
    req = JSON.parse(stdinLines[1]!.trim()) as { id: number; method: string };
    expect(req.method).toBe('tools/list');
    sendLine(JSON.stringify({
      jsonrpc: '2.0', id: req.id,
      result: { tools: [{ name: 'memory_write', description: 'Write a memory' }, { name: 'memory_recall', description: 'Recall memories' }] },
    }));

    const reg = await regPromise;
    expect(reg.serverKey).toBe('test-server@0.1.0');
    expect(reg.serverInfo.name).toBe('test-server');
    expect(reg.tools).toHaveLength(2);
    expect(reg.tools.map((t) => t.name)).toContain('memory_write');
    expect(reg.tools.map((t) => t.name)).toContain('memory_recall');
    expect(reg.live).toBe(true);

    // Agent surface exposure
    expect(registrar.tools('test-server@0.1.0')).toHaveLength(2);
    expect(registrar.allToolNames()).toHaveLength(2);
  });

  it('marks server as not live when process exits', async () => {
    const { proc, sendLine, stdinLines } = makeFakeProc();
    const registrar = new McpRegistrar();

    const regPromise = registrar.register('dying-server@0.1.0', proc as ChildProcess, 5000);

    await new Promise((r) => setTimeout(r, 10));
    let req = JSON.parse(stdinLines[0]!.trim()) as { id: number };
    sendLine(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { serverInfo: { name: 'dying', version: '0.1.0' }, capabilities: {} } }));
    await new Promise((r) => setTimeout(r, 10));
    req = JSON.parse(stdinLines[1]!.trim()) as { id: number };
    sendLine(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { tools: [] } }));

    const reg = await regPromise;
    expect(reg.live).toBe(true);

    // Simulate process exit
    (proc as EventEmitter).emit('exit', 0, null);
    expect(reg.live).toBe(false);
  });

  it('tool call passes args through without db_path injection (Gap F5 conservative default)', async () => {
    const { proc, sendLine, stdinLines } = makeFakeProc();
    const registrar = new McpRegistrar();

    const regPromise = registrar.register('sec-server@0.1.0', proc as ChildProcess, 5000);

    // Initialize
    await new Promise((r) => setTimeout(r, 10));
    let req = JSON.parse(stdinLines[0]!.trim()) as { id: number; method?: string; params?: { name: string; arguments: Record<string, unknown> } };
    sendLine(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { serverInfo: { name: 'sec', version: '0.1.0' }, capabilities: {} } }));
    await new Promise((r) => setTimeout(r, 10));
    // tools/list
    req = JSON.parse(stdinLines[1]!.trim()) as { id: number; method?: string; params?: { name: string; arguments: Record<string, unknown> } };
    sendLine(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'my_tool' }] } }));
    await regPromise;

    // tools/call
    const callPromise = registrar.call('sec-server@0.1.0', 'my_tool', { my_arg: 'value' }, 5000);
    await new Promise((r) => setTimeout(r, 10));
    req = JSON.parse(stdinLines[2]!.trim()) as { id: number; method?: string; params?: { name: string; arguments: Record<string, unknown> } };
    expect(req.method).toBe('tools/call');
    // Only the caller-supplied arg is sent — no automatic db_path injection
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(req.params!.arguments).toEqual({ my_arg: 'value' });
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(req.params!.arguments['db_path']).toBeUndefined();
    sendLine(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: 'done' }] } }));

    const callResult = await callPromise;
    expect(callResult.content[0]?.text).toBe('done');
  });
});

// ─── Command dispatch ─────────────────────────────────────────────────────────

import { CommandRegistry } from './host/adapters/command.js';

describe('CommandRegistry — verb→handler dispatch (P5 bin/sox wiring)', () => {
  let registry: CommandRegistry;

  beforeEach(() => {
    registry = new CommandRegistry();
  });

  it('registers and dispatches a command handler by verb', async () => {
    registry.register({
      key: 'echo-cmd@0.1.0',
      verb: 'echo',
      handler: async (input) => ({ stdout: `echo: ${input.args.join(' ')}`, exitCode: 0 }),
      permissions: undefined,
    });

    expect(registry.has('echo')).toBe(true);
    const reg = registry.get('echo');
    expect(reg).toBeDefined();
    const output = await reg!.handler({ args: ['hello', 'world'] });
    expect(output.stdout).toBe('echo: hello world');
    expect(output.exitCode).toBe(0);
  });

  it('returns all registered verbs', () => {
    registry.register({ key: 'a@0.1.0', verb: 'cmd-a', handler: async () => ({ exitCode: 0 }), permissions: undefined });
    registry.register({ key: 'b@0.1.0', verb: 'cmd-b', handler: async () => ({ exitCode: 0 }), permissions: undefined });
    expect(registry.verbs()).toContain('cmd-a');
    expect(registry.verbs()).toContain('cmd-b');
    expect(registry.verbs()).toHaveLength(2);
  });

  it('overwrites existing verb registration (last wins — cascade precedence)', () => {
    registry.register({ key: 'old@0.1.0', verb: 'shared', handler: async () => ({ stdout: 'old', exitCode: 0 }), permissions: undefined });
    registry.register({ key: 'new@0.1.0', verb: 'shared', handler: async () => ({ stdout: 'new', exitCode: 0 }), permissions: undefined });
    const reg = registry.get('shared');
    expect(reg?.key).toBe('new@0.1.0');
  });

  it('returns undefined for unknown verb', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
    expect(registry.has('nonexistent')).toBe(false);
  });

  it('carries declared permissions through registration', () => {
    const permissions = { fs: { read: ['~/.config/**'] } };
    registry.register({ key: 'perm-cmd@0.1.0', verb: 'perm-cmd', handler: async () => ({ exitCode: 0 }), permissions });
    expect(registry.get('perm-cmd')?.permissions).toEqual(permissions);
  });
});

// ─── Agent invoker delivery ───────────────────────────────────────────────────

import { activateAgent, activateSkill } from './host/adapters/agent.js';

describe('Agent invoker — P5 delivery to consumer', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-agent-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('invokes agent and delivers result to consumer', async () => {
    const entrypointPath = path.join(tmpDir, 'agent.cjs');
    fs.writeFileSync(
      entrypointPath,
      `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.invoke = async function invoke(input) {
  return { answer: input.question + '?' };
};`,
    );
    const handle = await activateAgent({ key: 'qa-agent@0.1.0', entrypointPath });
    const result = await handle.invoke({ question: 'what is P5' }) as { answer: string };
    expect(result.answer).toBe('what is P5?');
  });

  it('runs skill and delivers result to consumer', async () => {
    const entrypointPath = path.join(tmpDir, 'skill.cjs');
    fs.writeFileSync(
      entrypointPath,
      `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.run = async function run(input) {
  return { processed: input.data.toUpperCase() };
};`,
    );
    const handle = await activateSkill({ key: 'proc-skill@0.1.0', entrypointPath });
    const result = await handle.run({ data: 'hello p5' }) as { processed: string };
    expect(result.processed).toBe('HELLO P5');
  });
});
