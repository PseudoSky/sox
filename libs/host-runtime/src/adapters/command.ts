/**
 * libs/host-runtime/src/adapters/command.ts — Command verb registration adapter.
 * Ported from the pre-nx host runtime. Imports adjusted for lib paths.
 */

import type { PermissionsBlock } from '../supervisor.js';

export interface CommandInput {
  args: string[];
  [key: string]: unknown;
}

export interface CommandOutput {
  stdout?: string | undefined;
  stderr?: string | undefined;
  exitCode?: number | undefined;
  [key: string]: unknown;
}

export type CommandHandler = (input: CommandInput) => CommandOutput | Promise<CommandOutput>;

export interface CommandRegistration {
  key: string;
  verb: string;
  handler: CommandHandler;
  permissions: PermissionsBlock | undefined;
}

export class CommandRegistry {
  private readonly _commands = new Map<string, CommandRegistration>();

  register(reg: CommandRegistration): void {
    if (this._commands.has(reg.verb)) {
      console.warn(
        `[command-registry] Verb "${reg.verb}" already registered — overwriting with "${reg.key}"`,
      );
    }
    this._commands.set(reg.verb, reg);
  }

  has(verb: string): boolean {
    return this._commands.has(verb);
  }

  get(verb: string): CommandRegistration | undefined {
    return this._commands.get(verb);
  }

  verbs(): string[] {
    return [...this._commands.keys()];
  }

  clear(): void {
    this._commands.clear();
  }
}

export interface CommandAdapterOptions {
  key: string;
  entrypointPath: string;
  verb?: string | undefined;
  permissions?: PermissionsBlock | undefined;
  registry: CommandRegistry;
}

export interface CommandAdapterHandle {
  key: string;
  verb: string;
  permissions: PermissionsBlock | undefined;
  type: 'command';
}

export async function activateCommand(opts: CommandAdapterOptions): Promise<CommandAdapterHandle> {
  if (opts.permissions) {
    console.log(
      `[command-adapter] Activating "${opts.key}" — permissions declared (P4 record / P5 enforce):`,
      JSON.stringify(opts.permissions),
    );
  } else {
    console.log(`[command-adapter] Activating "${opts.key}" — no declared permissions`);
  }

  const mod = await import(opts.entrypointPath) as Record<string, unknown>;

  const verb = opts.verb ?? stripVersion(opts.key);
  const handler = normalizeHandler(mod, opts.key);

  opts.registry.register({
    key: opts.key,
    verb,
    handler,
    permissions: opts.permissions,
  });

  console.log(`[command-adapter] "${opts.key}" registered as verb "${verb}"`);

  return {
    key: opts.key,
    verb,
    permissions: opts.permissions,
    type: 'command',
  };
}

function normalizeHandler(mod: Record<string, unknown>, key: string): CommandHandler {
  if (typeof mod['run'] === 'function') {
    const runFn = mod['run'] as (input: CommandInput) => CommandOutput | Promise<CommandOutput>;
    return (input: CommandInput) => runFn(input);
  }

  if (typeof mod['runCli'] === 'function') {
    const runCliFn = mod['runCli'] as (argv: string[]) => void | Promise<void>;
    return async (input: CommandInput): Promise<CommandOutput> => {
      await runCliFn(input.args);
      return { exitCode: 0 };
    };
  }

  if (typeof mod['default'] === 'function') {
    const defaultFn = mod['default'] as (input: CommandInput) => CommandOutput | Promise<CommandOutput>;
    return (input: CommandInput) => defaultFn(input);
  }

  throw new Error(
    `[command-adapter] "${key}": entrypoint exports neither 'run' nor 'runCli'. ` +
      `Command modules must export one of these functions.`,
  );
}

function stripVersion(key: string): string {
  const atIdx = key.lastIndexOf('@');
  return atIdx > 0 ? key.slice(0, atIdx) : key;
}
