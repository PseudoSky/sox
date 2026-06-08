// Command: Status Command
// Slash-invoked command that reports the current environment status deterministically, no LLM calls.
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
 * Command handler — invoked via slash command /status-command
 * Deterministic: no LLM calls, predictable output.
 * Reports the current environment status (node version, cwd, platform).
 */
export function run(input: CommandInput): CommandOutput {
  try {
    const stdout = execSync(
      `echo "status-command: node=$(node --version) cwd=$(pwd) platform=$(uname -s) args=${input.args.join(' ')}"`,
      {
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    return { stdout: stdout.trim(), exitCode: 0 };
  } catch (e) {
    return { stdout: String(e), exitCode: 1 };
  }
}
