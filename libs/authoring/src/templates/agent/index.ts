/**
 * Agent template — scaffolds a declarative markdown agent extension.
 *
 * Real shape (from ~/dev/ai/claude-agents/categories/00-active/agents/):
 *   - Agents are .md files with YAML frontmatter (name, description, tools, model).
 *   - Runtime: declarative — no process spawned; the host reads the .md and
 *     injects it as a subagent definition.
 *   - Entrypoint: agent.md (the markdown definition file).
 *   - Install target resolved from libs/host-registry at install time.
 *     [ref:host-keyed-target] — NO hardcoded ~/.claude/agents/ here.
 *   - No src/, no tsconfig, no build step required.
 *
 * Files:
 *   extension.json   (born-conformant manifest: type=agent, runtime=declarative,
 *                     entrypoint=agent.md, install block with type+hosts)
 *   package.json     (minimal — no build scripts; just identity + metadata)
 *   agent.md         (YAML frontmatter + markdown body — the real agent definition)
 *   CHANGELOG.md
 *   README.md
 *
 * [inv:nx-free-core] — no nx-packages imports.
 * [inv:host-agnostic-type] — install-target removed; install.type used instead.
 */

import type { FileSet } from '../../index.js';
import type { TemplateOpts } from '../_shared.js';
import { buildInstallDescriptor, changelogMd, manifestJson, readmeMd } from '../_shared.js';

export function agentTemplate(opts: TemplateOpts): FileSet {
  // Minimal package.json — declarative agents have no build step
  const agentPkg = JSON.stringify(
    {
      name: `@adhd/sox-extension-${opts.id}`,
      version: '0.1.0',
      description: opts.description,
      private: true,
      license: 'MIT',
      ...(opts.author !== undefined && opts.author !== '' ? { author: opts.author } : {}),
      ...(opts.keywords !== undefined && opts.keywords.length > 0 ? { keywords: opts.keywords } : {}),
    },
    null,
    2,
  );

  return {
    'extension.json': manifestJson(opts, {
      // [flex:runtime-expanded] — declarative: no process, host reads the .md
      runtime: 'declarative',
      // [flex:entrypoint-optional] — present but points to the PROSE-ONLY .md
      // definition file (no frontmatter — the host-specific header is rendered at
      // install time from `agent` + `render`).
      entrypoint: 'agent.md',
      // [def:agent-ir] Host-agnostic agent IR. The install engine renders this into
      // a per-host header (claude/opencode frontmatter, codex TOML) at install time.
      agent: {
        name: opts.id,
        description: opts.description,
        model: 'sonnet',
        mode: 'all',
        tools: ['read', 'bash', 'write', 'edit', 'webfetch', 'websearch'],
        permission: {
          read: 'allow',
          edit: 'allow',
          bash: { '*': 'allow' },
        },
      },
      // [def:agent-render-overrides] Per-host typed overrides merged over the IR.
      // Fill these in for hosts that need divergent headers (tools, model, version).
      render: {
        claude: {
          model: 'sonnet',
          tools: ['Read', 'Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch'],
        },
        opencode: {
          mode: 'all',
        },
      },
      // [shape:install-descriptor] — host-agnostic; engine resolves target from
      // libs/host-registry (claude: file-drop at .claude/agents/; codex: config-merge).
      // [ref:host-keyed-target] — NO literal ~/.claude/ path here.
      install: buildInstallDescriptor('agent', opts),
      requires: {
        tool_calling: true,
      },
      // Install-time configuration schema. Agents are declarative (Role B) — soxe
      // does not spawn them, so config is NOT injected as env vars. It IS available
      // via `soxe config get/set/list` and is prompted during `soxe install`.
      // Remove this block if your agent needs no persistent configuration.
      config_schema: {
        type: 'object',
        additionalProperties: false,
        required: [],
        properties: {
          example_setting: {
            type: 'string',
            description: 'An example configurable setting. Replace with your agent\'s actual config.',
            'x-sox-prompt': `Enter a value for ${opts.id} example_setting:`,
            'x-sox-default': 'default-value',
          },
        },
      },
    }),

    'package.json': agentPkg,

    // The canonical agent definition — PROSE ONLY (no YAML frontmatter).
    // The host-specific header (claude `tools`/`model`, opencode
    // `mode`/`temperature`/`permission`, codex TOML) is rendered at install time
    // from the `agent` IR + `render` overrides in extension.json
    // ([def:agent-renderer], docs/spec/cross-platform-install-rendering.md).
    'agent.md': [
      `# ${opts.title}`,
      ``,
      `${opts.description}`,
      ``,
      `## When to invoke this agent`,
      ``,
      `<!-- Describe the conditions under which an orchestrator should hand off to this agent. -->`,
      ``,
      `## What this agent does`,
      ``,
      `1. Receives a task description from the host or orchestrator.`,
      `2. Uses available tools to complete the task.`,
      `3. Returns a structured result to the caller.`,
      ``,
      `## Tools`,
      ``,
      `- \`read\` — reads file contents`,
      `- \`write\` — writes file contents`,
      `- \`edit\` — edits file contents`,
      `- \`bash\` — runs shell commands`,
      `- \`webfetch\` — fetches a URL`,
      ``,
      `## Constraints`,
      ``,
      `- Keep task scope narrow: one goal per delegation.`,
      `- Do NOT make external network calls unless explicitly permitted.`,
      ``,
      `## Agent id`,
      ``,
      `\`${opts.id}\``,
    ].join('\n'),

    'CHANGELOG.md': changelogMd(),

    'README.md': readmeMd(opts, [
      '## When to use',
      '',
      `<!-- Describe when to delegate to this agent. -->`,
      '',
      '## Runtime',
      '',
      '`declarative` — the host reads `agent.md` and injects it as a subagent definition.',
      'No process is spawned. Install target resolved from host-registry at install time.',
      '',
      '## Capabilities',
      '',
      '- Tool calling: yes',
      '',
      '## Usage',
      '',
      '```bash',
      `soxe install ${opts.id} --host claude --scope user`,
      '```',
    ]),
  };
}
