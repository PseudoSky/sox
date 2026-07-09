// @adhd/sox-source-provider — SourceRef: normalized, validated source reference
// Authoritative spec: sox-ecosystem/docs/plan/source-provider/SPEC.md §2, §10
//
// Normalized forms:
//   github.com/owner/repo             → default branch, HEAD
//   github.com/owner/repo@v1.2.3      → tag v1.2.3
//   github.com/owner/repo@abc1234     → commit SHA (short or full)
//   github.com/owner/repo@refs/heads/feature  → branch ref
//   bitbucket.org/workspace/repo@main
//   local:/home/user/project
//
// SourceRef is a branded, immutable value — validated once at construction
// (SourceRef.parse), never mutated afterwards.

import { homedir } from 'node:os';
import { InvalidSourceRefError } from './errors.js';

/**
 * A normalized URI that uniquely identifies a source tree at a specific
 * revision (or the default/HEAD when `ref` is absent).
 */
export interface SourceRef {
  /** "github" | "bitbucket" | "local" */
  readonly scheme: string;
  /** "github.com" | "bitbucket.org" | "" (local) */
  readonly authority: string;
  /** "owner/repo" | "workspace/repo" | "/path/to/repo" */
  readonly path: string;
  /** "main" | "v1.2.3" | "abc1234" | "refs/heads/feature" | undefined → default */
  readonly ref?: string;
  /** Returns the normalized string form. */
  toString(): string;
}

// The spec's `SourceRefConstructor` interface (§2) describes the same instance
// shape (scheme/authority/path/ref/toString) plus a static `parse()`. That is
// modelled here as the `SourceRef` interface (instance shape) merged with the
// `SourceRef` namespace below (the `parse()` static), via TypeScript
// declaration merging — so callers write `SourceRef.parse(raw)` and receive
// back a `SourceRef`-typed value, exactly as the spec's usage examples show.

const SCM_PATH_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const KNOWN_AUTHORITIES: Record<string, string> = {
  'github.com/': 'github',
  'bitbucket.org/': 'bitbucket',
};

class SourceRefImpl implements SourceRef {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly ref?: string;

  constructor(scheme: string, authority: string, path: string, ref?: string) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
    if (ref !== undefined) this.ref = ref;
  }

  toString(): string {
    if (this.scheme === 'local') {
      return `local:${this.path}`;
    }
    const base = `${this.authority}/${this.path}`;
    return this.ref !== undefined ? `${base}@${this.ref}` : base;
  }
}

/**
 * Parse + normalize a raw source URI into a validated {@link SourceRef}.
 *
 * Accepts:
 *   "github:owner/repo"               → "github.com/owner/repo"
 *   "github:owner/repo@main"          → "github.com/owner/repo@main"
 *   "bitbucket:workspace/repo"        → "bitbucket.org/workspace/repo"
 *   "bitbucket:workspace/repo@branch" → "bitbucket.org/workspace/repo@branch"
 *   "local:/path/to/repo"             → "local:/path/to/repo"
 *   "/absolute/path"                  → "local:/absolute/path"
 *   "~/projects/my-app"               → "local:/home/user/projects/my-app"
 *   "https://github.com/owner/repo"   → "github.com/owner/repo"
 *   "https://github.com/owner/repo/tree/main" → "github.com/owner/repo@main"
 *   "https://bitbucket.org/ws/repo/src/main"  → "bitbucket.org/ws/repo@main"
 *
 * THROWS {@link InvalidSourceRefError} on unparseable or invalid input —
 * never returns a partial/best-effort ref.
 *
 * NOTE: a GitHub "blob" URL that points at a specific file
 * (e.g. ".../blob/main/README.md") has its ref extracted, but the trailing
 * file subpath is intentionally dropped — `SourceRef.path` models only
 * "owner/repo" (see spec §2); the file path is a separate argument to
 * `SourceProvider.content(ref, path)`, not part of the ref itself.
 */
export function normalizeSourceRef(raw: string): SourceRef {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new InvalidSourceRefError(String(raw), 'must be a non-empty string');
  }
  if (/\s/.test(raw)) {
    throw new InvalidSourceRefError(raw, 'whitespace is not allowed in a source ref');
  }

  let working = raw;

  // Tilde expansion (must run before the absolute-path local check below).
  if (working === '~') {
    working = homedir();
  } else if (working.startsWith('~/')) {
    working = `${homedir()}${working.slice(1)}`;
  }

  // Strip protocol + trailing slash(es).
  working = working.replace(/^https?:\/\//, '').replace(/\/+$/, '');

  // Shorthand scheme prefixes.
  working = working.replace(/^github:/, 'github.com/');
  working = working.replace(/^bitbucket:/, 'bitbucket.org/');

  // GitHub tree/blob URL → @ref rewrite (trailing subpath dropped — see doc above).
  const ghTree = working.match(/^(github\.com\/[^/]+\/[^/]+)\/tree\/([^/]+)(?:\/.*)?$/);
  if (ghTree) {
    working = `${ghTree[1]}@${ghTree[2]}`;
  } else {
    const ghBlob = working.match(/^(github\.com\/[^/]+\/[^/]+)\/blob\/([^/]+)(?:\/.*)?$/);
    if (ghBlob) working = `${ghBlob[1]}@${ghBlob[2]}`;
  }

  // Bitbucket "/src/{ref}" URL → @ref rewrite.
  const bbSrc = working.match(/^(bitbucket\.org\/[^/]+\/[^/]+)\/src\/([^/]+)(?:\/.*)?$/);
  if (bbSrc) working = `${bbSrc[1]}@${bbSrc[2]}`;

  // Bare absolute filesystem path → local: scheme.
  if (working.startsWith('/')) {
    working = `local:${working}`;
  }

  // ── local: scheme ─────────────────────────────────────────────────────
  if (working.startsWith('local:')) {
    const rest = working.slice('local:'.length);
    if (rest.includes('@')) {
      throw new InvalidSourceRefError(raw, 'local source refs do not support @ref');
    }
    if (!rest.startsWith('/')) {
      throw new InvalidSourceRefError(raw, 'local source ref path must be absolute');
    }
    return new SourceRefImpl('local', '', rest);
  }

  // ── SCM schemes (github.com / bitbucket.org) ─────────────────────────
  for (const [prefix, scheme] of Object.entries(KNOWN_AUTHORITIES)) {
    if (!working.startsWith(prefix)) continue;
    const authority = prefix.slice(0, -1); // strip trailing '/'
    const rest = working.slice(prefix.length);
    const atIdx = rest.indexOf('@');
    const path = atIdx === -1 ? rest : rest.slice(0, atIdx);
    const ref = atIdx === -1 ? undefined : rest.slice(atIdx + 1);

    if (!SCM_PATH_RE.test(path)) {
      throw new InvalidSourceRefError(
        raw,
        `path must match <owner>/<repo>, got "${path}"`,
      );
    }
    if (ref !== undefined && ref.length === 0) {
      throw new InvalidSourceRefError(raw, 'ref must be non-empty when present');
    }

    return new SourceRefImpl(scheme, authority, path, ref);
  }

  throw new InvalidSourceRefError(
    raw,
    'unrecognized scheme — expected github.com/, bitbucket.org/, or an absolute local path',
  );
}

/**
 * `SourceRef.parse(raw)` — the primary entry point. See {@link normalizeSourceRef}.
 */
export namespace SourceRef {
  export function parse(raw: string): SourceRef {
    return normalizeSourceRef(raw);
  }
}
