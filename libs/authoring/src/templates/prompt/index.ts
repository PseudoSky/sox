/**
 * Prompt template — MINIMAL --inject STUB only.
 *
 * The prompt type is PARKED BY DESIGN. This file exists solely to satisfy
 * [generators.5] (all six type templates must have an index.ts) and to
 * accept the --inject Appendix-A option so the schema check passes.
 *
 * DO NOT build out full prompt generation here. The scaffold function in
 * libs/authoring/src/index.ts does NOT wire prompt into the switch — it
 * remains outside ACTIVE_TYPES. This template is a leaf module only;
 * the authoring core does not call it via scaffold().
 *
 * What this stub does:
 *   - Exports promptTemplate(opts) → FileSet (minimal: extension.json + README)
 *   - Accepts opts.inject (--inject: rules | claude-md | undefined)
 *   - Emits install.type = 'prompt' in the descriptor [shape:install-descriptor]
 *   - Uses buildInstallDescriptor (no hardcoded host paths) [ref:host-keyed-target]
 *
 * [inv:nx-free-core] — no nx-packages imports.
 * [inv:host-agnostic-type] — install.type used; no literal host paths.
 */

import type { FileSet } from '../../index.js';
import type { TemplateOpts } from '../_shared.js';
import { buildInstallDescriptor, changelogMd, manifestJson, readmeMd } from '../_shared.js';

export function promptTemplate(opts: TemplateOpts): FileSet {
  // Minimal package.json — prompts are declarative, no build step
  const promptPkg = JSON.stringify(
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

  // Build install descriptor; include inject target as surface override
  const installDescriptor = buildInstallDescriptor('prompt', opts);
  if (opts.inject !== undefined && opts.inject !== '') {
    // --inject rules  → installs into .claude/rules/ (file-drop)
    // --inject claude-md → appends to CLAUDE.md (file-drop claude-md surface)
    installDescriptor['overrides'] = { inject: opts.inject };
  }

  return {
    'extension.json': manifestJson(opts, {
      // [flex:runtime-expanded] — declarative: no process; host injects the prompt
      runtime: 'declarative',
      // [shape:install-descriptor] — host-agnostic; engine resolves target from
      // libs/host-registry (claude: file-drop rules/ or claude-md surface).
      // [ref:host-keyed-target] — NO literal host path here.
      install: installDescriptor,
    }),

    'package.json': promptPkg,

    'CHANGELOG.md': changelogMd(),

    'README.md': readmeMd(opts, [
      '## Status',
      '',
      '> **Parked by design.** The `prompt` type is not yet fully implemented.',
      '> This scaffold is a minimal stub for the `--inject` option only.',
      '',
      '## Inject target',
      '',
      opts.inject !== undefined && opts.inject !== ''
        ? `\`${opts.inject}\` (set via --inject at init time)`
        : '`rules` (default — use `--inject claude-md` for CLAUDE.md injection)',
      '',
      '## Usage',
      '',
      '```bash',
      `soxe init prompt ${opts.id} --inject rules`,
      '```',
    ]),
  };
}
