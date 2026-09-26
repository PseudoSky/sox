/**
 * render-override.spec.ts — host `providerFrom` render inheritance (bug eb1ab168).
 *
 * `readAgentRenderInputs(srcPath, host, render)` reads the manifest's
 * `render.<host>` block. When that block lacks BOTH `provider` and `model`, a
 * host renderer that declares `providerFrom: '<sibling>'` inherits the sibling's
 * `{provider, model}` (own fields win). This is how the agent-mcp catalog picks
 * up opencode's deepseek model instead of minting a Claude default — the agent-mcp
 * rows all inherited `claude-opus-4-1` while every extension's opencode model was
 * `deepseek/deepseek-flash`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readAgentRenderInputs } from './install.js';

/** Minimal AgentRenderLocal stub — readAgentRenderInputs only reads providerFrom. */
function renderer(providerFrom?: string): {
  providerFrom?: string;
  render: () => { kind: string; content?: string; value?: unknown };
} {
  return {
    ...(providerFrom !== undefined ? { providerFrom } : {}),
    render: () => ({ kind: 'file-body', content: '' }),
  };
}

let dir: string;

function writeManifest(manifest: Record<string, unknown>): string {
  fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return dir;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-render-override-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('readAgentRenderInputs — providerFrom inheritance', () => {
  it('inherits the sibling render model when the host render lacks provider and model', () => {
    writeManifest({
      agent: { name: 'dispatcher', model: 'opus' },
      render: { opencode: { model: 'deepseek/deepseek-flash', mode: 'all' } },
    });
    const inputs = readAgentRenderInputs(dir, 'agent-mcp', renderer('opencode'));
    expect(inputs).not.toBeNull();
    expect(inputs!.override?.['model']).toBe('deepseek/deepseek-flash');
    // The sibling's own fields beyond provider/model are NOT inherited.
    expect(inputs!.override?.['mode']).toBeUndefined();
  });

  it('inherits the sibling provider object when present', () => {
    writeManifest({
      agent: { name: 'x', model: 'opus' },
      render: { opencode: { provider: { type: 'openai', model: 'gpt-4o' } } },
    });
    const inputs = readAgentRenderInputs(dir, 'agent-mcp', renderer('opencode'));
    expect(inputs!.override?.['provider']).toEqual({ type: 'openai', model: 'gpt-4o' });
  });

  it('own model wins over the inherited sibling model', () => {
    writeManifest({
      agent: { name: 'x', model: 'opus' },
      render: {
        opencode: { model: 'deepseek/deepseek-flash' },
        'agent-mcp': { model: 'qwen-max' },
      },
    });
    const inputs = readAgentRenderInputs(dir, 'agent-mcp', renderer('opencode'));
    expect(inputs!.override?.['model']).toBe('qwen-max');
  });

  it('own provider is enough — no inheritance when the host render has a provider', () => {
    writeManifest({
      agent: { name: 'x', model: 'opus' },
      render: {
        opencode: { model: 'deepseek/deepseek-flash' },
        'agent-mcp': { provider: { type: 'claudecli' } },
      },
    });
    const inputs = readAgentRenderInputs(dir, 'agent-mcp', renderer('opencode'));
    expect(inputs!.override?.['model']).toBeUndefined();
    expect(inputs!.override?.['provider']).toEqual({ type: 'claudecli' });
  });

  it('absent sibling ⇒ override unchanged (undefined)', () => {
    writeManifest({ agent: { name: 'x', model: 'opus' }, render: { claude: { model: 'opus' } } });
    const inputs = readAgentRenderInputs(dir, 'agent-mcp', renderer('opencode'));
    expect(inputs!.override).toBeUndefined();
  });

  it('no providerFrom on the renderer ⇒ override unchanged', () => {
    writeManifest({
      agent: { name: 'x', model: 'opus' },
      render: { opencode: { model: 'deepseek/deepseek-flash' } },
    });
    const inputs = readAgentRenderInputs(dir, 'agent-mcp', renderer());
    expect(inputs!.override).toBeUndefined();
  });

  // NEGATIVE CONTROL: a bare logical tier in the sibling is passed through
  // verbatim. The agent-mcp renderer then THROWS on it (proven in
  // agent-mcp.spec.ts) — it must NEVER fall back to an anthropic default.
  it('NC: a bare-tier sibling model passes through unchanged (renderer then throws)', () => {
    writeManifest({
      agent: { name: 'dispatcher', model: 'opus' },
      render: { opencode: { model: 'opus' } },
    });
    const inputs = readAgentRenderInputs(dir, 'agent-mcp', renderer('opencode'));
    expect(inputs!.override?.['model']).toBe('opus');
    expect(inputs!.override?.['model']).not.toContain('deepseek');
  });

  it('returns null when the extension has no extension.json', () => {
    expect(readAgentRenderInputs(path.join(dir, 'nope'), 'agent-mcp', renderer('opencode'))).toBeNull();
  });
});
