/**
 * cli-invoked-fields.spec.ts
 *
 * Unit coverage for `cliInvokedFields` (apps/sox/src/cli-invoked-fields.ts) —
 * the attribution fields the `cli_invoked` event carries so the smoke
 * harness's isolation guard (backlog d5c01be3) can match a live data-root
 * change to the operator invocation that made it.
 */
import { describe, expect, it } from 'vitest';

import { parseArgs } from '@adhd/sox-install-engine';

import { cliInvokedFields } from './cli-invoked-fields.js';

function fields(argv: string[]) {
  return cliInvokedFields(argv[0], parseArgs(argv.slice(1)));
}

describe('cliInvokedFields (d5c01be3)', () => {
  it('names the extension id an install acts on, with host and scope as passed', () => {
    expect(fields(['install', 'backlog-operator', '--host', 'claude', '--scope', 'user'])).toEqual({
      verb: 'install',
      subverb: null,
      target: 'backlog-operator',
      host: 'claude',
      scope: 'user',
      root: null,
      all: false,
    });
  });

  it('takes the id from the SECOND positional for `service <subverb> <id>`', () => {
    const f = fields(['service', 'enable', 'memory-server', '--scope=user']);
    expect(f.subverb).toBe('enable');
    expect(f.target).toBe('memory-server');
    expect(f.scope).toBe('user');
  });

  it('records `upgrade --all` as all:true with no target (explains no specific entry)', () => {
    const f = fields(['upgrade', '--all', '--scope=project', '--root', '/tmp/x']);
    expect(f.target).toBeNull();
    expect(f.all).toBe(true);
    expect(f.root).toBe('/tmp/x');
  });

  it('never records positionals of verbs that do not act on an extension id (no config values in logs)', () => {
    const f = fields(['config', 'set', 'secret.key', 's3cr3t-value']);
    expect(f.target).toBeNull();
    expect(f.subverb).toBeNull();
    expect(JSON.stringify(f)).not.toContain('s3cr3t-value');
  });

  it('handles a bare invocation (no verb)', () => {
    expect(cliInvokedFields(undefined, {})).toEqual({
      verb: null, subverb: null, target: null, host: null, scope: null, root: null, all: false,
    });
  });
});
