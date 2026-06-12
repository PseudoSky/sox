/**
 * Skill template — scaffolds a declarative markdown skill extension.
 *
 * Real shape (from ~/dev/ai/claude-agents/categories/workflow/skills/):
 *   - Skills are SKILL.md files with YAML frontmatter (name, description).
 *   - Runtime: declarative — no process spawned; host reads and injects the
 *     SKILL.md at invocation time.
 *   - Entrypoint: SKILL.md (the markdown invocation guide).
 *   - install-target: ~/.claude/skills/<id>/ (host discovery location).
 *   - No src/, no tsconfig, no build step required.
 *
 * Files:
 *   extension.json   (born-conformant manifest: type=skill, runtime=declarative,
 *                     entrypoint=SKILL.md, install-target=~/.claude/skills/<id>/)
 *   package.json     (minimal — no build scripts)
 *   SKILL.md         (YAML frontmatter + markdown invocation guide — the real shape)
 *   CHANGELOG.md
 *   README.md
 *
 * [inv:nx-free-core] — no nx-packages imports.
 */

import type { FileSet } from '../../index.js';
import type { TemplateOpts } from '../_shared.js';
import { manifestJson, changelogMd, readmeMd } from '../_shared.js';

export function skillTemplate(opts: TemplateOpts): FileSet {
  // Minimal package.json — declarative skills have no build step
  const skillPkg = JSON.stringify(
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
      // [flex:runtime-expanded] — declarative: no process, host injects the SKILL.md
      runtime: 'declarative',
      // [flex:entrypoint-optional] — present but points to the markdown skill file
      entrypoint: 'SKILL.md',
      // [flex:install-target] — where the host discovers this skill
      'install-target': `~/.claude/skills/${opts.id}/`,
    }),

    'package.json': skillPkg,

    // The canonical skill definition — YAML frontmatter + markdown body.
    // Matches the real shape from claude-agents/categories/workflow/skills/*/SKILL.md
    'SKILL.md': [
      `---`,
      `name: ${opts.id}`,
      `description: ${opts.description}`,
      `---`,
      ``,
      `# ${opts.title}`,
      ``,
      `<!-- markdownlint-disable MD013 -->`,
      ``,
      `${opts.description}`,
      ``,
      `## When to use this skill`,
      ``,
      `<!-- Describe the conditions under which to invoke this skill. -->`,
      ``,
      `## When NOT to use this skill`,
      ``,
      `<!-- Describe situations where this skill should NOT be used. -->`,
      ``,
      `## Input contract`,
      ``,
      `<!-- Describe the inputs this skill expects (prose or schema). -->`,
      ``,
      `## Output contract`,
      ``,
      `<!-- Describe the output this skill produces (prose or schema). -->`,
      ``,
      `## Examples`,
      ``,
      `<!-- Provide one or two concrete examples of invocation and result. -->`,
      ``,
      `## Skill id`,
      ``,
      `\`${opts.id}\``,
    ].join('\n'),

    'CHANGELOG.md': changelogMd(),

    'README.md': readmeMd(opts, [
      '## When to use',
      '',
      `<!-- Describe when to invoke this skill. -->`,
      '',
      '## Runtime',
      '',
      '`declarative` — the host reads `SKILL.md` and injects it at invocation time.',
      `Install places \`SKILL.md\` at \`~/.claude/skills/${opts.id}/\`.`,
      '',
      '## Usage',
      '',
      '```bash',
      `sox install ${opts.id}`,
      '```',
    ]),
  };
}
