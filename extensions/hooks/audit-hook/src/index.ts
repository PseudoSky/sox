// Hook: Audit Hook
// Binds PreToolUse lifecycle event and logs tool invocations to a file for auditing.
// Executes deterministically — no LLM calls.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface HookContext {
  event: string;
  timestamp: string;
  payload?: unknown;
}

/**
 * Hook handler — fires on the PreToolUse lifecycle event.
 *
 * order: 100 (default). Hooks should be order-independent where possible;
 * the `order` field is an escape hatch, not a dependency mechanism.
 *
 * Appends a JSON log line to $AUDIT_HOOK_LOG (default: ~/.sox/audit-hook.log).
 */
export function handler(ctx: HookContext): void {
  const logPath = process.env['AUDIT_HOOK_LOG'] ?? path.join(os.homedir(), '.sox', 'audit-hook.log');

  const logDir = path.dirname(logPath);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const logLine =
    JSON.stringify({
      timestamp: ctx.timestamp,
      event: ctx.event,
      payload: ctx.payload ?? null,
    }) + '\n';

  fs.appendFileSync(logPath, logLine, 'utf8');
}

/** Lifecycle event this hook binds to. */
export const event = 'PreToolUse';
