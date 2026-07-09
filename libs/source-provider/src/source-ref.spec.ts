import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';

import { InvalidSourceRefError } from './errors.js';
import { normalizeSourceRef, SourceRef } from './source-ref.js';

describe('SourceRef.parse — GitHub', () => {
  it('parses the shorthand form', () => {
    const ref = SourceRef.parse('github:owner/repo');
    expect(ref.scheme).toBe('github');
    expect(ref.authority).toBe('github.com');
    expect(ref.path).toBe('owner/repo');
    expect(ref.ref).toBeUndefined();
    expect(ref.toString()).toBe('github.com/owner/repo');
  });

  it('parses the shorthand form with a ref', () => {
    const ref = SourceRef.parse('github:owner/repo@main');
    expect(ref.ref).toBe('main');
    expect(ref.toString()).toBe('github.com/owner/repo@main');
  });

  it('parses an already-normalized form', () => {
    const ref = SourceRef.parse('github.com/owner/repo@v1.2.3');
    expect(ref.path).toBe('owner/repo');
    expect(ref.ref).toBe('v1.2.3');
  });

  it('parses a commit SHA ref', () => {
    const ref = SourceRef.parse('github.com/owner/repo@abc1234');
    expect(ref.ref).toBe('abc1234');
  });

  it('parses a branch ref containing slashes', () => {
    const ref = SourceRef.parse('github.com/owner/repo@refs/heads/feature');
    expect(ref.ref).toBe('refs/heads/feature');
    expect(ref.toString()).toBe('github.com/owner/repo@refs/heads/feature');
  });

  it('strips the https:// protocol and trailing slash', () => {
    const ref = SourceRef.parse('https://github.com/owner/repo/');
    expect(ref.toString()).toBe('github.com/owner/repo');
  });

  it('rewrites a /tree/{ref} URL to @ref form', () => {
    const ref = SourceRef.parse('https://github.com/owner/repo/tree/main');
    expect(ref.toString()).toBe('github.com/owner/repo@main');
  });

  it('rewrites a /tree/{ref}/{subpath} URL, extracting the ref', () => {
    const ref = SourceRef.parse('https://github.com/owner/repo/tree/main/src');
    expect(ref.ref).toBe('main');
    expect(ref.path).toBe('owner/repo');
  });

  it('rewrites a /blob/{ref}/{file} URL, extracting the ref', () => {
    const ref = SourceRef.parse('https://github.com/owner/repo/blob/main/README.md');
    expect(ref.ref).toBe('main');
    expect(ref.path).toBe('owner/repo');
  });
});

describe('SourceRef.parse — Bitbucket', () => {
  it('parses the shorthand form', () => {
    const ref = SourceRef.parse('bitbucket:workspace/repo');
    expect(ref.scheme).toBe('bitbucket');
    expect(ref.authority).toBe('bitbucket.org');
    expect(ref.path).toBe('workspace/repo');
    expect(ref.toString()).toBe('bitbucket.org/workspace/repo');
  });

  it('parses the shorthand form with a ref', () => {
    const ref = SourceRef.parse('bitbucket:workspace/repo@branch');
    expect(ref.ref).toBe('branch');
  });

  it('rewrites a /src/{ref} URL to @ref form', () => {
    const ref = SourceRef.parse('https://bitbucket.org/workspace/repo/src/main');
    expect(ref.toString()).toBe('bitbucket.org/workspace/repo@main');
  });
});

describe('SourceRef.parse — local filesystem', () => {
  it('normalizes a bare absolute path', () => {
    const ref = SourceRef.parse('/home/user/project');
    expect(ref.scheme).toBe('local');
    expect(ref.authority).toBe('');
    expect(ref.path).toBe('/home/user/project');
    expect(ref.toString()).toBe('local:/home/user/project');
  });

  it('accepts an already-normalized local: form', () => {
    const ref = SourceRef.parse('local:/home/user/project');
    expect(ref.toString()).toBe('local:/home/user/project');
  });

  it('expands a tilde-prefixed path', () => {
    const ref = SourceRef.parse('~/projects/my-app');
    expect(ref.path).toBe(`${homedir()}/projects/my-app`);
  });

  it('expands a bare tilde', () => {
    const ref = SourceRef.parse('~');
    expect(ref.path).toBe(homedir());
  });

  it('rejects a local ref with @ref', () => {
    expect(() => SourceRef.parse('local:/home/user/project@main')).toThrow(InvalidSourceRefError);
  });

  it('rejects a relative local path', () => {
    expect(() => SourceRef.parse('local:relative/path')).toThrow(InvalidSourceRefError);
  });
});

describe('SourceRef.parse — validation errors', () => {
  it('throws InvalidSourceRefError for an empty string', () => {
    expect(() => SourceRef.parse('')).toThrow(InvalidSourceRefError);
  });

  it('throws InvalidSourceRefError for whitespace anywhere in the ref', () => {
    expect(() => SourceRef.parse('github.com/owner/re po')).toThrow(InvalidSourceRefError);
  });

  it('throws InvalidSourceRefError for an unrecognized scheme', () => {
    expect(() => SourceRef.parse('gitlab.com/owner/repo')).toThrow(InvalidSourceRefError);
  });

  it('throws InvalidSourceRefError for uppercase scheme casing', () => {
    expect(() => SourceRef.parse('GitHub.com/owner/repo')).toThrow(InvalidSourceRefError);
  });

  it('throws InvalidSourceRefError when the SCM path is not <owner>/<repo>', () => {
    expect(() => SourceRef.parse('github.com/owner-only')).toThrow(InvalidSourceRefError);
  });

  it('throws InvalidSourceRefError for an empty ref after @', () => {
    expect(() => SourceRef.parse('github.com/owner/repo@')).toThrow(InvalidSourceRefError);
  });

  it('error carries the raw input for diagnostics', () => {
    expect.assertions(2);
    try {
      SourceRef.parse('not-a-ref');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidSourceRefError);
      expect((err as InstanceType<typeof InvalidSourceRefError>).raw).toBe('not-a-ref');
    }
  });
});

describe('normalizeSourceRef — round-trip stability', () => {
  it('parse(toString(ref)) === ref for GitHub refs', () => {
    const ref = SourceRef.parse('github:owner/repo@main');
    const roundTripped = SourceRef.parse(ref.toString());
    expect(roundTripped.toString()).toBe(ref.toString());
    expect(roundTripped.scheme).toBe(ref.scheme);
    expect(roundTripped.path).toBe(ref.path);
    expect(roundTripped.ref).toBe(ref.ref);
  });

  it('parse(toString(ref)) === ref for local refs', () => {
    const ref = SourceRef.parse('/abs/path/to/repo');
    const roundTripped = SourceRef.parse(ref.toString());
    expect(roundTripped.toString()).toBe(ref.toString());
  });

  it('is the same function as SourceRef.parse', () => {
    expect(normalizeSourceRef('github:owner/repo').toString()).toBe(
      SourceRef.parse('github:owner/repo').toString(),
    );
  });
});
