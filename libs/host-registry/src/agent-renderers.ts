/**
 * libs/host-registry/src/agent-renderers.ts
 *
 * Per-host agent renderers ([def:agent-renderer]) — the "author once, install
 * everywhere" half of the cross-platform rendering spec
 * (docs/spec/cross-platform-install-rendering.md). Each host module attaches the
 * matching renderer as `render` on its HostModule.
 *
 * claude  → YAML frontmatter (name, description, tools, model, version)
 * opencode → YAML frontmatter (name, description, mode, temperature, permission)
 * codex   → TOML [agents.<name>] config value (description, model, prompt)
 *
 * Renderers are pure functions of (ir, prose, override, host rule). No host
 * module hardcodes another server's registration key — concrete server keys come
 * from `override.toolMap` (data), never from a host module constant.
 */

import type { AgentIr, AgentOverride, HostRenderer } from './internal.js';
import { stripFrontmatter, yamlScalar, yamlStringify } from './serialize.js';

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** Resolve a logical MCP server name to its concrete registration key on a host. */
function resolveServerKey(override: AgentOverride | undefined, server: string): string {
  return override?.toolMap?.[server] ?? server;
}

/** Claude built-ins: logical (lowercase) → concrete (Titlecase). */
const CLAUDE_BUILTINS: Record<string, string> = {
  read: 'Read',
  bash: 'Bash',
  write: 'Write',
  edit: 'Edit',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  glob: 'Glob',
  grep: 'Grep',
  task: 'Task',
  todowrite: 'TodoWrite',
  question: 'AskUserQuestion',
  skill: 'Skill',
};

/** Split IR tools into builtin strings and MCP server refs. */
function splitTools(ir: AgentIr): { builtins: string[]; mcp: Array<{ logical: string; server: string }> } {
  const builtins: string[] = [];
  const mcp: Array<{ logical: string; server: string }> = [];
  for (const ref of ir.tools ?? []) {
    if (typeof ref === 'string') builtins.push(ref);
    else mcp.push(ref);
  }
  return { builtins, mcp };
}

// ─── claude ──────────────────────────────────────────────────────────────────

const claudeRenderer: HostRenderer = {
  renderHeader(ir, override) {
    const header: Record<string, unknown> = {};
    const name = override?.name ?? ir.name;
    const description = override?.description ?? ir.description;
    if (name !== undefined) header['name'] = name;
    if (description !== undefined) header['description'] = description;

    if (override?.tools !== undefined) {
      header['tools'] = override.tools.join(', ');
    } else {
      const { builtins, mcp } = splitTools(ir);
      const concrete: string[] = builtins.map((b) => CLAUDE_BUILTINS[b] ?? b);
      for (const ref of mcp) {
        const key = resolveServerKey(override, ref.server);
        concrete.push(`mcp__${key}__*`);
      }
      if (concrete.length > 0) header['tools'] = concrete.join(', ');
    }

    header['model'] = override?.model ?? ir.model ?? 'sonnet';
    if (override?.version !== undefined) header['version'] = override.version;
    return header;
  },

  renderToolNames(ir, override) {
    const { mcp } = splitTools(ir);
    if (mcp.length === 0) return null;
    const lines = ['## Resolved tool names (Claude Code)', ''];
    for (const ref of mcp) {
      const key = resolveServerKey(override, ref.server);
      lines.push(`- \`${ref.logical}\` → \`mcp__${key}__*\` (server key \`${key}\`)`);
    }
    return lines.join('\n');
  },

  render(ir, prose, override) {
    const header = yamlStringify(claudeRenderer.renderHeader(ir, override));
    const body = stripFrontmatter(prose);
    const names = claudeRenderer.renderToolNames(ir, override);
    const content = `---\n${header}\n---\n${body}` + (names ? `\n${names}\n` : '\n');
    return { kind: 'file-body', content };
  },
};

// ─── opencode ────────────────────────────────────────────────────────────────

const opencodeRenderer: HostRenderer = {
  renderHeader(ir, override) {
    const header: Record<string, unknown> = {};
    const name = override?.name ?? ir.name;
    const description = override?.description ?? ir.description;
    if (name !== undefined) header['name'] = name;
    if (description !== undefined) header['description'] = description;
    // opencode needs a host model id (e.g. "deepseek/deepseek-flash"); the IR
    // model is a logical tier ("sonnet") opencode cannot resolve, so only an
    // explicit render override pins it. Unpinned agents inherit the parent
    // session's model at task() time (opencode task.ts: `next.model ?? msg.model`).
    const model = override?.model;
    if (model !== undefined) header['model'] = model;
    header['mode'] = override?.mode ?? ir.mode ?? 'all';
    const temperature = override?.temperature ?? ir.temperature;
    if (temperature !== undefined) header['temperature'] = temperature;
    const permission = override?.permission ?? ir.permission;
    if (permission !== undefined) header['permission'] = permission;
    return header;
  },

  renderToolNames(ir, override) {
    const { mcp } = splitTools(ir);
    if (mcp.length === 0) return null;
    const lines = ['## Resolved tool names (OpenCode)', ''];
    for (const ref of mcp) {
      const key = resolveServerKey(override, ref.server);
      lines.push(`- \`${ref.logical}\` → \`tools["${key}"].*\` (server key \`${key}\`)`);
    }
    return lines.join('\n');
  },

  render(ir, prose, override) {
    const header = yamlStringify(opencodeRenderer.renderHeader(ir, override));
    const body = stripFrontmatter(prose);
    const names = opencodeRenderer.renderToolNames(ir, override);
    const content = `---\n${header}\n---\n${body}` + (names ? `\n${names}\n` : '\n');
    return { kind: 'file-body', content };
  },
};

// ─── codex ───────────────────────────────────────────────────────────────────

const codexRenderer: HostRenderer = {
  renderHeader(ir, override) {
    const description = override?.description ?? ir.description;
    const model = override?.model ?? ir.model;
    const header: Record<string, unknown> = {};
    if (description !== undefined) header['description'] = description;
    if (model !== undefined) header['model'] = model;
    return header;
  },

  renderToolNames() {
    // Codex expresses tool access in TOML, not callable prefixes — no block.
    return null;
  },

  render(ir, prose, override) {
    // Codex agents are a config entry, not a file. The prose body lands in the
    // prompt field (exact field name TBD — spec §10.4). config-merge serializes
    // this object to TOML at keyPath `agents.<name>`.
    const value: Record<string, unknown> = {
      ...codexRenderer.renderHeader(ir, override),
      prompt: stripFrontmatter(prose),
    };
    return { kind: 'config-value', value };
  },
};

// ─── Exports ─────────────────────────────────────────────────────────────────

export const agentRenderers = {
  claude: claudeRenderer,
  opencode: opencodeRenderer,
  codex: codexRenderer,
};

// Re-export types for the host modules' convenience (type-only).
export type { HostRenderer, RenderedArtifact, AgentIr, AgentOverride, AgentToolRef } from './internal.js';
export { stripFrontmatter, yamlScalar, yamlStringify };
