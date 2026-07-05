/**
 * libs/host-runtime/src/data-paths.spec.ts — BL-180 runtime validation guard.
 *
 * Covers:
 *   - valid scopes resolve correctly
 *   - garbage scope string throws with a structured error naming the bad value
 *   - the error message contains the invalid scope string
 */

import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { dataRoot, userDataRoot, DATA_SUBDIR } from './data-paths.js';

describe('dataRoot — valid scopes', () => {
  it('user scope returns userDataRoot()', () => {
    const result = dataRoot('user');
    expect(result).toBe(userDataRoot());
  });

  it('project scope returns <root>/.adhd/sox-ecosystem/', () => {
    const root = '/some/project';
    expect(dataRoot('project', root)).toBe(path.join(root, DATA_SUBDIR));
  });

  it('local scope returns <root>/.adhd/sox-ecosystem/', () => {
    const root = '/some/project';
    expect(dataRoot('local', root)).toBe(path.join(root, DATA_SUBDIR));
  });

  it('org scope with root returns <root>/.adhd/sox-ecosystem/', () => {
    const root = '/org/root';
    expect(dataRoot('org', root)).toBe(path.join(root, DATA_SUBDIR));
  });

  it('org scope without root falls back to userDataRoot()', () => {
    expect(dataRoot('org')).toBe(userDataRoot());
  });

  it('project scope without root throws with a clear message', () => {
    expect(() => dataRoot('project')).toThrow(
      "[data-paths] scope 'project' requires a root directory",
    );
  });

  it('local scope without root throws with a clear message', () => {
    expect(() => dataRoot('local')).toThrow(
      "[data-paths] scope 'local' requires a root directory",
    );
  });
});

describe('dataRoot — unknown scope (BL-180 runtime guard)', () => {
  it('throws a structured error naming the bad value', () => {
    // Cast to bypass TypeScript — simulates unvalidated CLI input arriving at runtime.
    const badScope = 'badscope' as Parameters<typeof dataRoot>[0];
    expect(() => dataRoot(badScope)).toThrowError(
      /\[data-paths\] unknown scope "badscope"/,
    );
  });

  it('throws for "global" (a common wrong value)', () => {
    const globalScope = 'global' as Parameters<typeof dataRoot>[0];
    expect(() => dataRoot(globalScope)).toThrowError(
      /\[data-paths\] unknown scope "global"/,
    );
  });

  it('error message lists valid scopes', () => {
    const badScope = 'nope' as Parameters<typeof dataRoot>[0];
    let caught: unknown;
    try {
      dataRoot(badScope);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('Valid scopes: org, user, project, local');
  });

  it('does NOT return the bad string as a path', () => {
    const badScope = 'badscope' as Parameters<typeof dataRoot>[0];
    let result: string | undefined;
    try {
      result = dataRoot(badScope);
    } catch {
      // expected
    }
    // If we reach this, result must be undefined (throw happened)
    expect(result).toBeUndefined();
  });

  it('uses SOX_ECOSYSTEM_HOME for user scope (env override)', () => {
    const prev = process.env['SOX_ECOSYSTEM_HOME'];
    try {
      process.env['SOX_ECOSYSTEM_HOME'] = '/custom/home';
      expect(dataRoot('user')).toBe('/custom/home');
    } finally {
      if (prev === undefined) {
        delete process.env['SOX_ECOSYSTEM_HOME'];
      } else {
        process.env['SOX_ECOSYSTEM_HOME'] = prev;
      }
    }
  });
});
