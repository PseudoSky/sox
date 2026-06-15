// Command: di-command
// di-command extension
// Slash-invoked, deterministic shell operation — no LLM calls.

import { execSync } from 'node:child_process';

export interface CommandInput {
  args: string[];
}

export interface CommandOutput {
  stdout: string;
  exitCode: number;
}

/**
 * Command handler — invoked via slash command /di-command
 * Deterministic: no LLM calls, predictable output.
 */
export function run(input: CommandInput): CommandOutput {
  try {
    const stdout = execSync(`echo "Command di-command: ${input.args.join(' ')}"`, {
      encoding: 'utf8',
      timeout: 5000,
    });
    return { stdout: stdout.trim(), exitCode: 0 };
  } catch (e) {
    return { stdout: String(e), exitCode: 1 };
  }
}