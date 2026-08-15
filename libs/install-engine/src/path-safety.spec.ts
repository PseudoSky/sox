/**
 * libs/install-engine/src/path-safety.spec.ts
 *
 * BUG-EPIC-MANIFEST-PATH-ESCAPE-001 — unit coverage for the assertWithinBase
 * containment helper itself: prefix-safety (the `/base-evil` vs `/base` bug a
 * bare `startsWith` has), symlink escape (both a symlink INSIDE the base
 * pointing outward, and a symlink at an ancestor of the base), and
 * not-yet-existing candidate paths.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertWithinBase, joinWithinBase, PathEscapeError } from './path-safety.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'path-safety-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('assertWithinBase', () => {
  it('allows a candidate strictly inside base', () => {
    const base = path.join(tmp, 'base');
    fs.mkdirSync(base, { recursive: true });
    const candidate = path.join(base, 'sub', 'file.txt');
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    fs.writeFileSync(candidate, 'ok');
    expect(() => assertWithinBase(base, candidate)).not.toThrow();
  });

  it('allows base itself', () => {
    const base = path.join(tmp, 'base');
    fs.mkdirSync(base, { recursive: true });
    expect(() => assertWithinBase(base, base)).not.toThrow();
  });

  it('refuses a literal ../ escape', () => {
    const base = path.join(tmp, 'base');
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'evil.txt'), 'evil');
    const candidate = path.join(base, '..', 'evil.txt');
    expect(() => assertWithinBase(base, candidate)).toThrow(PathEscapeError);
  });

  it('is prefix-safe: /base-evil is NOT inside /base (the bare startsWith bug)', () => {
    const base = path.join(tmp, 'base');
    const sibling = path.join(tmp, 'base-evil');
    fs.mkdirSync(base, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    // A naive `candidate.startsWith(base)` check would WRONGLY allow this,
    // because the string "base-evil" starts with the string "base".
    expect(() => assertWithinBase(base, sibling)).toThrow(PathEscapeError);
  });

  it('refuses a symlink INSIDE the base that points outside it', () => {
    const base = path.join(tmp, 'base');
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(base, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    const link = path.join(base, 'escape-link');
    fs.symlinkSync(path.join(outside, 'secret.txt'), link);
    // The string `link` reads as "inside base" — only realpath resolution
    // catches that the filesystem will follow it OUT on open/read.
    expect(() => assertWithinBase(base, link)).toThrow(PathEscapeError);
  });

  it('refuses when base itself resolves through an outward-pointing ancestor symlink', () => {
    const real = path.join(tmp, 'real-base');
    fs.mkdirSync(real, { recursive: true });
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    const linkedBase = path.join(tmp, 'linked-base');
    fs.symlinkSync(real, linkedBase);
    // candidate escapes THROUGH the base's own symlink to a sibling of `real`.
    const candidate = path.join(linkedBase, '..', 'outside', 'secret.txt');
    expect(() => assertWithinBase(linkedBase, candidate)).toThrow(PathEscapeError);
  });

  it('handles a not-yet-existing candidate by resolving the nearest real ancestor', () => {
    const base = path.join(tmp, 'base');
    fs.mkdirSync(base, { recursive: true });
    const candidate = path.join(base, 'not', 'yet', 'created.txt');
    expect(() => assertWithinBase(base, candidate)).not.toThrow();
  });

  it('refuses a not-yet-existing candidate that escapes via ../ segments', () => {
    const base = path.join(tmp, 'base');
    fs.mkdirSync(base, { recursive: true });
    const candidate = path.join(base, '..', 'not-yet-created-evil.txt');
    expect(() => assertWithinBase(base, candidate)).toThrow(PathEscapeError);
  });
});

describe('joinWithinBase', () => {
  it('joins and returns the resolved path when safe', () => {
    const base = path.join(tmp, 'base');
    fs.mkdirSync(base, { recursive: true });
    const resolved = joinWithinBase(base, 'sub/file.txt');
    expect(resolved).toBe(fs.realpathSync(base) + path.sep + 'sub' + path.sep + 'file.txt');
  });

  it('refuses an untrusted ../ segment', () => {
    const base = path.join(tmp, 'base');
    fs.mkdirSync(base, { recursive: true });
    expect(() => joinWithinBase(base, '../../evil.txt')).toThrow(PathEscapeError);
  });
});
