/**
 * Hook template — scaffolds a shell lifecycle hook extension.
 *
 * Real shape (from ~/dev/ai/claude-agents/tools/hooks/):
 *   - Dominant pattern: shell scripts (*.sh) with #!/usr/bin/env bash shebang.
 *   - Read JSON payload from stdin (via `jq` or `cat | python3`).
 *   - Output: JSON to stdout (hookSpecificOutput) OR exit 0 for no-op.
 *   - runtime: shell, entrypoint: hook.sh (the script file itself).
 *   - Also present: node CJS hooks (*.cjs / *.js) for more complex logic.
 *   - Hook payload arrives on stdin; hooks must be self-contained (no imports).
 *   - Install target resolved from libs/host-registry at install time.
 *     [ref:host-keyed-target] — NO hardcoded host paths here.
 *
 * Files:
 *   extension.json   (born-conformant manifest: type=hook, runtime=shell,
 *                     entrypoint=hook.sh, order=100, events=[PreToolUse],
 *                     install block with type+hosts)
 *   package.json     (minimal — shell hooks have no build step)
 *   hook.sh          (#!/usr/bin/env bash — reads stdin JSON, runs logic, exits 0)
 *   CHANGELOG.md
 *   README.md
 *
 * [inv:nx-free-core] — no nx-packages imports.
 * [inv:host-agnostic-type] — install.type used; target resolved from host-registry.
 */

import type { FileSet } from '../../index.js';
import type { TemplateOpts } from '../_shared.js';
import { buildInstallDescriptor, changelogMd, manifestJson, readmeMd } from '../_shared.js';

export function hookTemplate(opts: TemplateOpts): FileSet {
  // Minimal package.json — shell hooks have no build step
  const hookPkg = JSON.stringify(
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
      // [flex:runtime-expanded] — shell: hook.sh is a bash script, no node required
      runtime: 'shell',
      // [flex:entrypoint-optional] — present; points to the shell script
      entrypoint: 'hook.sh',
      order: 100,
      events: ['PreToolUse'],
      // [shape:install-descriptor] — host-agnostic; engine resolves target from
      // libs/host-registry (claude: file-drop hook-script + config-merge settings).
      // [ref:host-keyed-target] — NO literal ~/.claude/ path here.
      install: buildInstallDescriptor('hook', opts),
    }),

    'package.json': hookPkg,

    // Shell hook script — reads JSON from stdin, processes, outputs JSON or exits 0.
    // Matches the real shape from claude-agents/tools/hooks/*.sh
    'hook.sh': [
      `#!/usr/bin/env bash`,
      `# ${opts.id} — PreToolUse hook`,
      `# ${opts.description}`,
      `#`,
      `# Receives JSON on stdin; outputs hookSpecificOutput JSON or exits 0 (no-op).`,
      `# Runs deterministically — NO LLM calls inside a hook handler.`,
      `# order: 100 (hooks fire in ascending order; ties broken by id lexicographically).`,
      ``,
      `set -u`,
      ``,
      `input=$(cat)`,
      ``,
      `# ── Extract fields from the hook payload ──────────────────────────────────`,
      `tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null)`,
      `[ -z "$tool_name" ] && exit 0`,
      ``,
      `# ── Gate: only act on specific tools ─────────────────────────────────────`,
      `# Remove or adjust this guard to match the tools you want to intercept.`,
      `# To act on ALL tools, delete the gate entirely.`,
      `# Example: [ "$tool_name" != "Bash" ] && exit 0`,
      ``,
      `# ── Main logic ───────────────────────────────────────────────────────────`,
      `# TODO: implement hook logic here.`,
      `# Exit 0 to allow the tool call to proceed (no output = no-op).`,
      `# To inject a system message:`,
      `#   jq -cn '{"systemMessage": "your message here"}'`,
      `# To deny the tool call:`,
      `#   jq -cn '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"reason"}}'`,
      ``,
      `exit 0`,
    ].join('\n'),

    'CHANGELOG.md': changelogMd(),

    'README.md': readmeMd(opts, [
      '## When to use',
      '',
      `<!-- Describe when this hook should be installed. -->`,
      '',
      '## Lifecycle event',
      '',
      '`PreToolUse` (default; change `events` in `extension.json` to rebind)',
      '',
      '## Runtime',
      '',
      '`shell` — `hook.sh` is executed by the host as a bash script.',
      'The JSON hook payload arrives on **stdin**; output a JSON response to **stdout**',
      'or exit 0 for a no-op (allow).',
      '',
      '## Execution order',
      '',
      '`order: 100` — hooks fire in ascending order; ties broken lexicographically by id.',
      '',
      '## Output protocol',
      '',
      '| Intent | stdout |',
      '| ------ | ------ |',
      '| Allow (no-op) | nothing (or empty) — exit 0 |',
      '| Inject system message | `{"systemMessage": "..."}` |',
      '| Deny tool call | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}` |',
      '',
      '## Constraints',
      '',
      '- Deterministic: no LLM calls inside a hook handler.',
      '- Side effects must be idempotent (hooks may fire more than once on retry).',
      '- Must complete quickly (host may time out long-running hooks).',
      '',
      '## Usage',
      '',
      '```bash',
      `sox install ${opts.id}`,
      '```',
    ]),
  };
}
