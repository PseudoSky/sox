/**
 * parse-args.spec.ts — A12 dual flag form tests
 *
 * Verifies [ref:dual-flag-form]: parseArgs handles BOTH --flag value AND --flag=value
 * for every flag. This is the acceptance test for A12.
 */

import { describe, it, expect } from 'vitest';
import { parseArgs } from './index.js';

describe('parseArgs — A12 dual flag forms', () => {
  it('parses --flag=value form (equals form)', () => {
    const result = parseArgs(['--scope=user']);
    expect(result['scope']).toBe('user');
  });

  it('parses --flag value form (space-separated form)', () => {
    const result = parseArgs(['--scope', 'user']);
    expect(result['scope']).toBe('user');
  });

  it('parses --flag=value for scope=org', () => {
    const result = parseArgs(['--scope=org']);
    expect(result['scope']).toBe('org');
  });

  it('parses --flag value for scope=org', () => {
    const result = parseArgs(['--scope', 'org']);
    expect(result['scope']).toBe('org');
  });

  it('parses --flag=value for all scope values', () => {
    for (const scope of ['org', 'user', 'project', 'local']) {
      const r = parseArgs([`--scope=${scope}`]);
      expect(r['scope']).toBe(scope);
    }
  });

  it('parses --flag value for all scope values', () => {
    for (const scope of ['org', 'user', 'project', 'local']) {
      const r = parseArgs(['--scope', scope]);
      expect(r['scope']).toBe(scope);
    }
  });

  it('both forms are identical for the same flag', () => {
    const a = parseArgs(['--scope', 'user']);
    const b = parseArgs(['--scope=user']);
    expect(a['scope']).toBe(b['scope']);
    expect(a['scope']).toBe('user');
  });

  it('parses a boolean flag (no value) as "true"', () => {
    const result = parseArgs(['--frozen-lockfile']);
    expect(result['frozen-lockfile']).toBe('true');
  });

  it('parses multiple flags in mixed forms', () => {
    const result = parseArgs(['--scope=user', '--frozen-lockfile', '--root', '/tmp/test']);
    expect(result['scope']).toBe('user');
    expect(result['frozen-lockfile']).toBe('true');
    expect(result['root']).toBe('/tmp/test');
  });

  it('parses --update flag', () => {
    const result = parseArgs(['--scope', 'project', '--update']);
    expect(result['scope']).toBe('project');
    expect(result['update']).toBe('true');
  });

  it('does not confuse the next --flag as a value in space-separated form', () => {
    const result = parseArgs(['--scope', '--other']);
    // --scope followed by --other means --scope is a boolean flag, --other is a boolean flag
    expect(result['scope']).toBe('true');
    expect(result['other']).toBe('true');
  });

  it('parses --runtime-file=<path> (equals form)', () => {
    const result = parseArgs(['--runtime-file=/tmp/runtime.json']);
    expect(result['runtime-file']).toBe('/tmp/runtime.json');
  });

  it('parses --runtime-file <path> (space form)', () => {
    const result = parseArgs(['--runtime-file', '/tmp/runtime.json']);
    expect(result['runtime-file']).toBe('/tmp/runtime.json');
  });

  it('handles an empty argv array', () => {
    const result = parseArgs([]);
    expect(result).toEqual({});
  });

  it('ignores positional arguments', () => {
    const result = parseArgs(['start', '--scope=user']);
    expect(result['scope']).toBe('user');
    // 'start' is positional — not a flag
  });
});
