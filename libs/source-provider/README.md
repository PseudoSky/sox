# @adhd/sox-source-provider

A single `SourceProvider` interface for enumerating file trees and reading raw file content from GitHub, Bitbucket, or the local filesystem — **without cloning**. Consumers write code against the interface and a `ProviderRegistry` once; which backend actually answers is resolved from the URL scheme of a `SourceRef`, so nothing in calling code ever does `instanceof GitHubProvider`. A first-class in-memory fake ships alongside the real providers for testing.

```bash
pnpm add @adhd/sox-source-provider
```

## Quick start

This example uses the local filesystem provider — no tokens or network access required — against a real directory:

```typescript
import { createLocalProvider, SourceRef } from '@adhd/sox-source-provider';

const provider = createLocalProvider(); // scans the OS filesystem directly
const ref = SourceRef.parse('/abs/path/to/my-project');

const manifest = await provider.fileTree(ref);
console.log(manifest.truncated); // false
console.log(manifest.entries.map((e) => e.path));
// [ 'README.md', 'src', 'src/index.ts', ... ]

const readme = await provider.content(ref, 'README.md');
console.log(readme); // file contents as a UTF-8 string, or null if missing
```

## Referencing a source: `SourceRef`

`SourceRef.parse()` is the one entry point for turning a raw string into a validated, immutable reference. It throws `InvalidSourceRefError` rather than ever returning a partial ref.

```typescript
import { SourceRef } from '@adhd/sox-source-provider';

SourceRef.parse('github:owner/repo').toString();               // "github.com/owner/repo"
SourceRef.parse('github:owner/repo@v1.2.3').toString();         // "github.com/owner/repo@v1.2.3"
SourceRef.parse('https://github.com/owner/repo/tree/main').toString(); // "github.com/owner/repo@main"
SourceRef.parse('bitbucket:my-workspace/my-repo@develop').toString(); // "bitbucket.org/my-workspace/my-repo@develop"
SourceRef.parse('/abs/path/to/repo').toString();                // "local:/abs/path/to/repo"
SourceRef.parse('~/projects/my-app').toString();                // "local:/home/you/projects/my-app"
```

```typescript
interface SourceRef {
  readonly scheme: string;    // "github" | "bitbucket" | "local"
  readonly authority: string; // "github.com" | "bitbucket.org" | "" (local)
  readonly path: string;      // "owner/repo" | "workspace/repo" | "/path/to/repo"
  readonly ref?: string;      // "main" | "v1.2.3" | "abc1234" | "refs/heads/feature" | undefined
  toString(): string;
}
```

A `SourceRef` never encodes a file subpath — even a GitHub blob URL pointing at a specific file (`.../blob/main/README.md`) has its `ref` extracted, but the trailing file path is dropped. The file path is always a separate argument to `provider.content(ref, path)`.

## Resolving providers: `ProviderRegistry`

For code that needs to work across schemes, register each provider once and resolve by `SourceRef`:

```typescript
import {
  DefaultProviderRegistry,
  createGitHubProvider,
  createBitbucketProvider,
  createLocalProvider,
  SourceRef,
} from '@adhd/sox-source-provider';

const registry = new DefaultProviderRegistry();
registry.register('github.com', () => createGitHubProvider({ token: process.env.GITHUB_TOKEN! }));
registry.register('bitbucket.org', () => createBitbucketProvider({ token: process.env.BITBUCKET_TOKEN! }));
registry.register('local', () => createLocalProvider());

async function readFile(rawRef: string, path: string): Promise<string | null> {
  const ref = SourceRef.parse(rawRef);
  const provider = registry.getProvider(ref); // resolved by ref.authority, or "local"
  return provider.content(ref, path);
}

await readFile('github:owner/repo', 'package.json');
await readFile('/abs/path/to/repo', 'package.json');
```

```typescript
interface ProviderRegistry {
  register(scheme: string, factory: () => SourceProvider, opts?: { force?: boolean }): void;
  registerMany(schemes: string[], factory: () => SourceProvider): void;
  getProvider(ref: SourceRef): SourceProvider;      // throws ProviderNotFoundError if unregistered
  registeredSchemes(): string[];
  deregister(scheme: string): boolean;
  createProvider(scheme: string): SourceProvider;   // fresh instance, bypassing the per-scheme cache
}
```

`getProvider()` lazily creates one cached instance per scheme on first use (so a provider isn't re-authenticated or re-connected on every call). Call `deregister(scheme)` then `register(scheme, factory)` again to force a fresh instance, e.g. after rotating a token.

## The `SourceProvider` interface

Every concrete provider — GitHub, Bitbucket, local, and the fake — implements exactly this shape:

```typescript
interface SourceProvider {
  supportedSchemes(): string[];

  fileTree(ref: SourceRef, path?: string): Promise<Manifest>;
  // path scopes the walk to a subdirectory; entries[].path is still relative
  // to the tree root, never to `path`.
  // THROWS ProviderAuthenticationError, ProviderRateLimitError, ManifestTooLargeError, FileNotFoundError

  content(ref: SourceRef, path: string): Promise<string | null>;
  // returns null if the path doesn't exist (or, for binary content, if UTF-8 decoding fails)
  // THROWS ProviderAuthenticationError, ProviderRateLimitError

  contentStream?(ref: SourceRef, path: string): Promise<ReadableStream<Uint8Array> | null>; // optional
  getRevision?(ref: SourceRef): Promise<string>;                                            // optional

  isAvailable(): boolean; // local validation only, no network calls
}
```

```typescript
interface Manifest {
  revision: string;           // commit SHA (SCM) or filesystem snapshot hash (local)
  defaultBranch?: string;     // present for SCM providers
  rootUri: SourceRef;
  truncated: boolean;         // true = entries is incomplete; never infer absence from a truncated manifest
  entries: FileEntry[];
  metadata: ManifestMetadata;
  fetchedAt: string;          // ISO timestamp
}

interface FileEntry {
  path: string;         // relative to Manifest.rootUri, POSIX separators
  type: 'file' | 'dir' | 'symlink';
  size: number;         // bytes; 0 for directories
  sha: string;          // git SHA-1 for SCM providers, SHA-256 hex for local
  contentUrl?: string;  // present for SCM providers
  mode?: string;        // e.g. "100644", "100755"
  language?: string;    // populated only if the provider computes it
  lastModified?: string; // present for local, absent for SCM
}

interface ManifestMetadata {
  hashAlgorithm: 'sha1' | 'sha256';
  entryCount: number;   // may exceed entries.length when truncated
  totalSize?: number;
  treeSha?: string;     // present for GitHub — unchanged treeSha means content hasn't changed
}
```

## Providers

### GitHub

```typescript
import { createGitHubProvider } from '@adhd/sox-source-provider';

const provider = createGitHubProvider({
  token: process.env.GITHUB_TOKEN!,   // Personal Access Token, classic or fine-grained (Contents permission)
  // baseUrl: 'https://ghes.example.com/api/v3', // GitHub Enterprise Server
  // maxTreeEntries: 100_000,                    // default; ManifestTooLargeError above this
  // retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 60_000 },
});
```

Uses the Git Trees API (`?recursive=1`) for the common case. If the tree exceeds `maxTreeEntries` and no `path` was given, it throws `ManifestTooLargeError` — retry with an explicit subdirectory `path`, which falls back to the Contents API (not subject to the Trees API's 100K-entry ceiling). Rate limits and auth failures surface as `ProviderRateLimitError` / `ProviderAuthenticationError` with the real `Retry-After`/reset headers threaded through.

### Bitbucket

```typescript
import { createBitbucketProvider } from '@adhd/sox-source-provider';

const provider = createBitbucketProvider({
  token: process.env.BITBUCKET_TOKEN!, // App Password or OAuth token, repository read access
  // baseUrl: 'https://bitbucket.example.com/2.0', // Data Center/Server
  // maxEntriesPerPage: 100, // Bitbucket's API hard limit
  // maxPages: 100,          // truncates after 10,000 entries
});
```

Bitbucket has no single recursive-tree endpoint, so this provider walks the Source API's per-directory listings depth-first, following the real `values`/`next` pagination shape.

### Local filesystem

```typescript
import { createLocalProvider } from '@adhd/sox-source-provider';

const provider = createLocalProvider({
  // allowedBasePath: '/abs/allowed/root', // refs outside this base throw
  // respectGitignore: true,               // default; honors every .gitignore found in the tree
  // ignorePatterns: ['*.env'],            // merged with .gitignore rules
  // maxContentSize: 104_857_600,          // default 100 MB; content() over this returns null
  // hashAlgorithm: 'sha256',              // default; 'sha1' also supported
  // includePatterns: ['**/*.ts'],         // glob allow-list, applied after ignores
});
```

Enumerates the real OS filesystem with `fast-glob`, respects nested `.gitignore` files (each one scoped to its own subdirectory), always excludes `.git/`, and hashes file content directly (`sha256` by default) rather than relying on any SCM's blob SHA. `fileTree(ref, path)` scoping and path-traversal are both enforced — a `content()` call that walks outside the scanned root throws `FileNotFoundError`, not a partial read.

### Fake provider (testing)

`createFakeProvider` is a first-class export, not a test-only import — it implements the identical `SourceProvider` interface, so integration tests exercise real consumer code with no `instanceof` branching:

```typescript
import { createFakeProvider, SourceRef } from '@adhd/sox-source-provider';

const ref = SourceRef.parse('github.com/owner/repo@main');
const provider = createFakeProvider({
  trees: {
    'github.com/owner/repo@main': [
      { path: 'README.md', content: '# My Project' },
      { path: 'src/index.ts', content: 'export const x = 42' },
    ],
  },
  // allowMissingFiles: false,      // default; content() for an unlisted path throws FileNotFoundError
  // truncateAfter: 500,            // simulate Manifest.truncated once entries exceed this
  // simulateErrors: {
  //   fileTree: { errorClass: ProviderRateLimitError, afterCalls: 2, maxThrows: 1 },
  // },
});

const manifest = await provider.fileTree(ref);
const readme = await provider.content(ref, 'README.md'); // "# My Project"
```

`sha` and `size` for each `FakeProviderEntry` are auto-computed from `content` when omitted (git-blob SHA-1 for SCM-scheme trees, SHA-256 for local-scheme trees) — the fake produces the same shape of manifest a real provider would.

## Error taxonomy

Every error thrown by this package subclasses `SourceProviderError`:

```typescript
class SourceProviderError extends Error {}

class ProviderNotFoundError extends SourceProviderError { scheme: string; }
class ProviderAuthenticationError extends SourceProviderError { scheme: string; }
class ProviderRateLimitError extends SourceProviderError { scheme: string; retryAfterMs: number; resetAt?: string; }
class SchemeAlreadyRegisteredError extends SourceProviderError { scheme: string; }
class InvalidSourceRefError extends SourceProviderError { raw: string; }
class FileNotFoundError extends SourceProviderError { ref: string; path: string; }
class ManifestTooLargeError extends SourceProviderError { ref: string; maxEntries: number; estimatedTotal: number; }
class ProviderTransientError extends SourceProviderError { scheme: string; retryAfterMs?: number; } // network timeouts, 5xx — caller should retry
```

```typescript
import { InvalidSourceRefError, SourceProviderError } from '@adhd/sox-source-provider';

try {
  SourceRef.parse('not a valid ref');
} catch (err) {
  if (err instanceof InvalidSourceRefError) {
    console.error(`bad ref "${err.raw}"`);
  }
}
```

## Invariants

- **No `search()` / discovery.** Every operation takes an explicit `SourceRef` — there is no repo-search or listing-by-query surface.
- **`SourceRef.parse()` never returns a partial ref.** Unparseable input always throws `InvalidSourceRefError`.
- **`Manifest.truncated === true` means the entry list is incomplete.** Never infer completeness (or absence of a file) from a truncated manifest — re-fetch scoped to a subdirectory instead.
- **Every thrown error is a typed `SourceProviderError` subclass** — safe to `instanceof`-narrow across every provider.
- **No caching in this package.** `SourceProvider` is I/O only; caching manifests or content across calls is the consumer's responsibility.
