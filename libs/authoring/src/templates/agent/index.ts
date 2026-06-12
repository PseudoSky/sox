/**
 * Agent template — scaffolds a declarative markdown agent extension.
 *
 * Real shape (from ~/dev/ai/claude-agents/categories/00-active/agents/):
 *   - Agents are .md files with YAML frontmatter (name, description, tools, model).
 *   - Runtime: declarative — no process spawned; the host reads the .md and
 *     injects it as a subagent definition.
 *   - Entrypoint: agent.md (the markdown definition file).
 *   - install-target: ~/.claude/agents/ (host discovery location).
 *   - No src/, no tsconfig, no build step required.
 *
 * Files:
 *   extension.json   (born-conformant manifest: type=agent, runtime=declarative,
 *                     entrypoint=agent.md, install-target=~/.claude/agents/)
 *   package.json     (minimal — no build scripts; just identity + metadata)
 *   agent.md         (YAML frontmatter + markdown body — the real agent definition)
 *   CHANGELOG.md
 *   README.md
 *
 * [inv:nx-free-core] — no nx-packages imports.
 */

import type { FileSet } from '../../index.js';
import type { TemplateOpts } from '../_shared.js';
import { manifestJson, changelogMd, readmeMd } from '../_shared.js';

export function agentTemplate(opts: TemplateOpts): FileSet {
  // Minimal package.json — declarative agents have no build step
  const agentPkg = JSON.stringify(
    {
      name: `@sox/extension-${opts.id}`,
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
      // [flex:entrypoint-optional] — present but points to the .md definition file
      entrypoint: 'agent.md',
      // [flex:install-target] — where the host discovers this agent
      'install-target': '~/.claude/agents/',
      requires: {
        tool_calling: true,
      },
    }),

    'package.json': agentPkg,

    // The canonical agent definition — YAML frontmatter + markdown body.
    // Matches the real shape from claude-agents/categories/00-active/agents/*.md
    'agent.md': [
      `---`,
      `name: ${opts.id}`,
      `description: ${opts.description}`,
      `tools: Read, Write, Edit, Bash, Glob, Grep`,
      `model: sonnet`,
      `---`,
      ``,
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
      `- \`Read\` — reads file contents`,
      `- \`Write\` — writes file contents`,
      `- \`Edit\` — edits file contents`,
      `- \`Bash\` — runs shell commands`,
      `- \`Glob\` — finds files by pattern`,
      `- \`Grep\` — searches file contents`,
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
      'No process is spawned. Install places `agent.md` at `~/.claude/agents/`.',
      '',
      '## Capabilities',
      '',
      '- Tool calling: yes',
      '',
      '## Usage',
      '',
      '```bash',
      `sox install ${opts.id}`,
      '```',
    ]),
  };
}
