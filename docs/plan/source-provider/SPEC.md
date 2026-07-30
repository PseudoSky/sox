# SPEC — `@adhd/sox-source-provider`

> Unified SCM/filesystem abstraction package: file tree enumeration and raw
> content retrieval from GitHub, Bitbucket, and local filesystem through a
> single `SourceProvider` interface. Provider registry, URL normalization,
> fake provider for testing.
> Q&A-iterated design, 2026-07-04. All outstanding questions resolved (see §Decisions log).

---

## Table of Contents

1. [Use cases & design drivers](#1-use-cases--design-drivers)
2. [Core types](#2-core-types)
3. [`SourceProvider` — primary interface](#3-sourceprovider--primary-interface)
4. [`Manifest` — file tree result](#4-manifest--file-tree-result)
5. [GitHub provider](#5-github-provider)
6. [Bitbucket provider](#6-bitbucket-provider)
7. [Local filesystem provider](#7-local-filesystem-provider)
8. [Provider registry](#8-provider-registry)
9. [Fake provider](#9-fake-provider)
10. [URL normalization](#10-url-normalization)
11. [Error taxonomy](#11-error-taxonomy)
12. [Decisions log](#12-decisions-log)
13. [Metrics & observability](#13-metrics--observability)
14. [Spec gaps](#14-spec-gaps)

---

## 1. Use cases & design drivers

Three generalized use cases drive the interface:

| Use case | Origins | File tree scope | Content access pattern | Change detection |
|---|---|---|---|---|
| **Documentation ingestion from multiple SCM providers** | GitHub, Bitbucket, local repo | Recursive — whole-dir trees | Many small content reads (single files) | SHA-based — avoid re-read of unchanged files |
| **CI pipeline manifest comparison** | Any origin | Flat or recursive, pinned to ref | Sequential — tree then selective content | Manifest diff via SHA comparison |
| **Offline/air-gapped development** | Local filesystem only | Recursive, gitignore-aware | Streaming on large files | SHA-256 hashing at scan time |

### Cross-cutting requirements

| Requirement | Rationale | Violation cost |
|---|---|---|
| **Provider-agnostic interface** | Consumer never imports SCM-specific packages; registry resolves at runtime | Every consumer becomes coupled to every SCM API; testing requires network |
| **Explicit references only — no search/discovery** | SourceProvider fetches what you point it at; finding what to point at is the caller's problem | Scope creep into repo search, code search, and discovery — product-level IP, not an abstraction |
| **All file trees carry a revision identifier** | Consumers need to know what version they have (ref, SHA, or timestamp) for caching and diffing | Cannot answer "has this changed since last time?" |
| **Truncation signalling for large manifests** | GitHub Git Trees API returns 100K entry limit; consumer must know the tree is truncated | Silent data loss — consumer thinks it has the full tree when it doesn't |
| **No cloning** | Provider fetches file trees and content via API, not `git clone` | Significant disk usage, slow first fetch, security surface from arbitrary repo clones |
| **Token-based auth via config, not interactive OAuth** | Provider receives a token string at construction; OAuth flows are a caller concern | Auth logic duplicated in every consumer; impossible to unit test |
| **SHA-256 for local change detection** | Consistent hashing across all providers (GitHub uses git SHA-1 natively, but the abstraction normalizes to SHA-256 for cross-provider comparison) | Cannot compare manifests from different providers |
| **Configurable ignores for local filesystem** | Build artifacts, node_modules, .git must be excludeable without `.gitignore` | Inadvertent ingestion of gigabytes of generated files |

### What is NOT in scope

- **Search/discovery** — no GitHub Code Search, no repo discovery, no "find me all repos with this file". SourceProvider receives fully-qualified references.
- **Metadata enrichment** — no stars/forks/language detection/contributor stats. File trees and content only.
- **Authentication management** — no OAuth flow, no credential rotation, no token refresh. Provider receives a token; if it expires, the provider throws `ProviderAuthenticationError`.
- **Diff/delta computation** — no built-in diff. Consumer calls `fileTree()` twice and diffs the `Manifest` objects.
- **File writing** — no push, no commit, no PR creation. Read-only.
- **Caching** — no on-disk or in-memory cache. Consumers (e.g. `@adhd/sox-ingest`) bring their own caching. SourceProvider is the I/O layer.

---

## 2. Core types

```ts
// ── FileType ────────────────────────────────────────────────────────────────

type FileType = 'file' | 'dir' | 'symlink'

// ── FileEntry ───────────────────────────────────────────────────────────────

interface FileEntry {
  path: string               // Relative path from the tree root, POSIX separators
                             // e.g. "src/index.ts", "docs/README.md"
  type: FileType
  size: number               // Bytes. 0 for directories.
  sha: string                // Content hash. Git SHA-1 for SCM providers;
                             // SHA-256 hex for local filesystem provider.
                             // The hash algorithm is provider-specific and is
                             // recorded in Manifest.metadata.hashAlgorithm.
  contentUrl?: string        // Optional direct URL to fetch raw content.
                             // Present for SCM providers; absent for local
                             // filesystem (caller reads via content()).
  mode?: string              // POSIX file mode string (e.g. "100644", "100755").
                             // Present for SCM providers; optional for local.
  language?: string          // Inferred language (extension-based).
                             // Optional — populated if the provider computes it.
  lastModified?: string      // ISO timestamp. Present for local filesystem;
                             // absent for SCM providers (use revision instead).
}

// ── SourceRef ───────────────────────────────────────────────────────────────

// A normalized URI that uniquely identifies a source tree at a specific revision
// or point in time.
//
// Normalized forms:
//   /github.com/owner/repo           → default branch, HEAD
//   /github.com/owner/repo@v1.2.3    → tag v1.2.3
//   /github.com/owner/repo@abc1234   → commit SHA (short or full)
//   /github.com/owner/repo@refs/heads/feature  → branch ref
//   /bitbucket.org/workspace/repo@main
//   /local/home/user/project
//
// SourceRef is a branded string — validated at construction, immutable after.

interface SourceRefConstructor {
  // Parse a raw URI into a normalized SourceRef.
  // Accepts:
  //   "github:owner/repo"               → "github.com/owner/repo"
  //   "github:owner/repo@main"          → "github.com/owner/repo@main"
  //   "bitbucket:workspace/repo"         → "bitbucket.org/workspace/repo"
  //   "bitbucket:workspace/repo@branch"  → "bitbucket.org/workspace/repo@branch"
  //   "local:/path/to/repo"              → "local:/path/to/repo"
  //   "/absolute/path"                   → "local:/absolute/path"
  //   "https://github.com/owner/repo"    → "github.com/owner/repo"
  //   "https://github.com/owner/repo/tree/main" → "github.com/owner/repo@main"
  // THROWS InvalidSourceRefError on unparseable input.
  parse(raw: string): SourceRef

  scheme: string             // "github", "bitbucket", "local"
  authority: string          // "github.com", "bitbucket.org", "" (local)
  path: string               // "owner/repo", "workspace/repo", "/path/to/repo"
  ref?: string               // "main", "v1.2.3", "abc1234", undefined → default
  toString(): string         // Returns the normalized string form
}

// ── Manifest ────────────────────────────────────────────────────────────────

interface Manifest {
  revision: string              // Provider-specific revision identifier:
                                // commit SHA (SCM) or filesystem snapshot hash (local).
                                // SHA-256 hex for local; git SHA-1 for SCM providers.
  defaultBranch?: string        // Present for SCM providers; absent for local.
  rootUri: SourceRef            // The source ref this manifest was fetched for.
  truncated: boolean            // true when the provider stopped enumerating due
                                // to size limits. Consumer MUST NOT treat the
                                // entry list as complete when truncated === true.
  entries: FileEntry[]          // Flat array; no nested structure. All entries
                                // have path relative to rootUri.
  metadata: ManifestMetadata    // Provider-specific metadata.
  fetchedAt: string             // ISO timestamp of when this manifest was fetched.
}

interface ManifestMetadata {
  hashAlgorithm: 'sha1' | 'sha256'  // Which algorithm FileEntry.sha uses.
  entryCount: number                 // Total entries in the tree (may exceed
                                     // entries.length when truncated).
                                    // When not truncated, entryCount === entries.length.
  totalSize?: number                 // Sum of all file sizes in bytes.
                                     // Present when the provider can compute it
                                     // efficiently (local filesystem).
  treeSha?: string                   // Root tree SHA. Present for GitHub provider.
                                     // Enables efficient re-fetch: if treeSha hasn't
                                     // changed, consumer can skip content re-read.
}
```

### Why a flat array instead of a nested tree structure

Consumers of this package do one of two things:
1. **Iterate** all entries — a flat array is trivially iterable without recursion.
2. **Look up** entries by path — a flat array can be indexed into a `Map<string, FileEntry>` in O(n) at parse time. A nested tree requires a recursive walk to build the same map.

A flat array is simpler to serialize, diff, and paginate. Consumers that need a tree view can build it client-side.

### Why `sha` is provider-specific

GitHub and Bitbucket expose git SHA-1 hashes natively (the Git Trees API returns SHA-1). The local filesystem provider computes SHA-256. The algorithm is recorded in `Manifest.metadata.hashAlgorithm` so consumers can:
- Detect provider crossover (comparing SHA-1 to SHA-256 for the same file should fail loudly).
- Re-hash to a common algorithm if cross-provider comparison is needed.

---

## 3. `SourceProvider` — primary interface

```ts
interface SourceProvider {
  // ── Identification ──────────────────────────────────────────────────────

  // Which URL schemes this provider handles.
  // GitHub provider → ['github', 'github.com']
  // Bitbucket provider → ['bitbucket', 'bitbucket.org']
  // Local provider → ['local', 'file']
  supportedSchemes(): string[]

  // ── File tree ───────────────────────────────────────────────────────────

  // Recursive file tree for a given reference.
  // When path is provided, the tree is scoped to that subdirectory (and its
  // descendants). entries[].path is still relative to rootUri, not to 'path'.
  //
  // THROWS ProviderAuthenticationError, ProviderRateLimitError,
  //         ManifestTooLargeError, FileNotFoundError
  fileTree(ref: SourceRef, path?: string): Promise<Manifest>

  // ── File content ────────────────────────────────────────────────────────

  // Raw file content as a UTF-8 string.
  // Returns null if the path does not exist in the ref's tree.
  //
  // For binary files the provider SHOULD attempt to decode as UTF-8 and
  // return null if decoding fails. Binary file handling is a spec gap — see §14.
  //
  // THROWS ProviderAuthenticationError, ProviderRateLimitError
  content(ref: SourceRef, path: string): Promise<string | null>

  // ── Content stream (optional) ──────────────────────────────────────────

  // Raw file content as a ReadableStream (node.js Readable or Web Stream).
  // Useful for large files that shouldn't be loaded into memory entirely.
  //
  // Not all providers implement streaming. Callers should check for
  // this method's presence at runtime:
  //   if ('contentStream' in provider) { ... }
  //
  // THROWS ProviderAuthenticationError, ProviderRateLimitError
  contentStream?(ref: SourceRef, path: string): Promise<ReadableStream<Uint8Array> | null>

  // ── Health ─────────────────────────────────────────────────────────────

  // Quick check: is the provider configured and able to make requests?
  // Returns false if the token is missing or if base paths don't exist.
  // Should not make network calls — only local validation.
  isAvailable(): boolean
}
```

### Why no `search()` in the interface

Search/discovery (GitHub Code Search, repository discovery, "find me all repos with this topic") is a **product-level capability with product-level IP value**. It belongs in the consumer layer, not in a generalized abstraction. The `SourceProvider` interface is intentionally lean:
- `fileTree()` — enumerate files at a known reference
- `content()` — read a known file

That's it. A consumer that needs search implements it against the SCM's search API directly, or orchestrates it at a higher level of abstraction. This keeps `@adhd/sox-source-provider` generic, reusable, and free of product-specific concerns.

### Why `contentStream` is optional and runtime-checked

Not all sources support streaming. The GitHub Contents API returns the full body in one HTTP response — there is no byte-range streaming endpoint for raw content. The local filesystem provider can trivially stream. Making `contentStream` required would force every provider to implement a pattern that some cannot meaningfully support.

The runtime check (`'contentStream' in provider`) is explicit and safe. Consumers that need streaming fall back to `content()` + string chunking when the method is absent.

---

## 4. `Manifest` — file tree result

### Truncation contract

When `Manifest.truncated === true`:

1. **The entry list is incomplete.** The consumer MUST NOT draw conclusions from the absence of entries. For example, a consumer checking "does this repo contain a CONTRIBUTING.md?" cannot trust a negative result from a truncated manifest — the file might exist in the un-enumerated portion of the tree.

2. **Retry with a subdirectory scope.** The consumer can subdivide and retry:
   ```
   // Truncated at root → retry per top-level directory
   const rootManifest = await provider.fileTree(ref)
   if (rootManifest.truncated) {
     for (const entry of rootManifest.entries) {
       if (entry.type === 'dir') {
         const subManifest = await provider.fileTree(ref, entry.path)
         // Merge subManifest.entries into the full result
       }
     }
   }
   ```

3. **Truncation strategy is provider-specific.** The GitHub provider truncates at the Git Trees API limit (~100K entries). The Bitbucket provider truncates when the REST response exceeds a page limit. The local filesystem provider never truncates (it synthesizes the tree from filesystem traversal — no fixed limit).

### Manifest serialization

A `Manifest` should be trivially serializable to JSON for caching:

```ts
interface ManifestJson extends Manifest {
  // The entries array serializes cleanly — all fields are primitive.
}
```

The `SourceRef` in `rootUri` serializes to its string form via `.toString()` and is re-parsed on deserialization. Consumers can store `Manifest` objects in `@adhd/sox-blob-store` or similar, keyed by `rootUri.toString() + "@" + revision`.

---

## 5. GitHub provider

### Configuration

```ts
interface GitHubProviderConfig {
  // GitHub Personal Access Token (classic or fine-grained).
  // Must have Contents permission for the target repositories.
  token: string

  // Base URL for API calls. Defaults to "https://api.github.com".
  // Override for GitHub Enterprise Server.
  baseUrl?: string

  // Maximum entries in a single fileTree response before truncation.
  // The Git Trees API supports up to 100,000 entries (recursive).
  // Default: 100_000. Lower for memory-constrained environments.
  maxTreeEntries?: number

  // User-Agent header value. Defaults to "sox-source-provider/1.0".
  // GitHub API requires a User-Agent; this is configurable for auditing.
  userAgent?: string

  // Retry configuration for transient API errors (rate limits, 5xx).
  retry?: {
    maxRetries?: number        // Default: 3
    baseDelayMs?: number       // Default: 1000 (exponential backoff)
    maxDelayMs?: number        // Default: 60_000
  }
}
```

### Implementation strategy

#### File tree (`fileTree`)

Primary: **Git Trees API** (`GET /repos/{owner}/{repo}/git/trees/{tree_sha}?recursive=1`)

```
1. Resolve ref to a commit SHA:
   GET /repos/{owner}/{repo}/git/ref/{ref}
   → Extract object.sha (commit SHA)

2. Get the commit's tree SHA:
   GET /repos/{owner}/{repo}/git/commits/{commit_sha}
   → Extract tree.sha

3. Get the recursive tree:
   GET /repos/{owner}/{repo}/git/trees/{tree_sha}?recursive=1
   → Extract tree[] — each entry has {path, mode, type, sha, size}

4. Map each tree entry to FileEntry:
   - path: entry.path
   - type: entry.type === 'tree' → 'dir', else 'file'
   - size: entry.size (0 for dirs)
   - sha: entry.sha (git SHA-1)
   - contentUrl: `https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}`
   - mode: entry.mode
```

Fallback (when tree is truncated): **Contents API** (`GET /repos/{owner}/{repo}/contents/{path}`)

The Git Trees API returns a maximum of 100,000 entries for recursive trees. When the response is truncated (the `truncated` field in the API response is `true`), the provider falls back to the Contents API for **known subdirectory scopes**:

```
When tree.truncated === true:
  For each top-level directory in the partial tree:
    GET /repos/{owner}/{repo}/contents/{dir_path}?ref={ref}
    → Returns array of entries (non-recursive, one level only)
    → Recurse into each subdirectory (Contents API, depth-first)
    → Merge into the FileEntry list
```

The fallback is **explicit reference only** — the consumer must request a subdirectory via `fileTree(ref, path)`. The provider does NOT automatically subdivide an entire truncated tree (that could be thousands of API calls).

#### Content (`content`)

**Contents API** (`GET /repos/{owner}/{repo}/contents/{path}?ref={ref}`):

```
1. GET /repos/{owner}/{repo}/contents/{path}?ref={ref}
2. Response includes:
   - content (base64-encoded)
   - encoding: "base64"
   - sha, size, name, path
3. Decode base64 → UTF-8 string
4. If the content is not valid UTF-8: return null
```

#### Raw content via URL (no API token needed)

For public repos, the provider can optionally fall back to `raw.githubusercontent.com`:

```
GET https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}
```

This avoids API rate limit consumption for content reads. It is only used when:
- The repo is public (checked via `GET /repos/{owner}/{repo}` at first access).
- The caller has not disabled it in config.
- The caller only needs `content()`, not `fileTree()` (raw URLs don't support tree enumeration).

#### Rate limit handling

```
1. Check response headers:
   X-RateLimit-Remaining
   X-RateLimit-Reset (Unix timestamp)

2. If X-RateLimit-Remaining === 0:
   Compute wait time = X-RateLimit-Reset - now() + 1s
   THROW ProviderRateLimitError with retryAfterMs = wait time * 1000

3. On 403 with no RateLimit headers (abuse detection):
   Sleep 60s, retry (up to maxRetries)
   THROW ProviderRateLimitError with retryAfterMs: 60_000

4. On 401:
   THROW ProviderAuthenticationError
```

#### Error mapping

| GitHub API error | Provider error |
|---|---|
| `404` (Not Found) | `FileNotFoundError` |
| `401` (Bad credentials) | `ProviderAuthenticationError` |
| `403` + RateLimit headers | `ProviderRateLimitError` |
| `403` (abuse detection) | `ProviderRateLimitError` |
| `409` (Git tree conflict) | `SourceProviderError` (transient) |
| `422` (Unprocessable Entity) | `SourceProviderError` (permanent) |
| Tree truncated at root | `ManifestTooLargeError` (if path omitted) |
| Tree truncated at subdirectory | Manifest with `truncated: true` |

---

## 6. Bitbucket provider

### Configuration

```ts
interface BitbucketProviderConfig {
  // Bitbucket App Password or OAuth token.
  // Must have repository read access.
  token: string

  // Base URL for API calls. Defaults to "https://api.bitbucket.org/2.0".
  // Override for Bitbucket Data Center/Server.
  baseUrl?: string

  // Maximum entries per page in file tree responses.
  // Bitbucket paginates at 100 entries per page (API hard limit).
  // Default: 100.
  maxEntriesPerPage?: number

  // Maximum pages to traverse before truncation.
  // Default: 100 (10,000 entries).
  maxPages?: number

  // Retry configuration (same shape as GitHubProviderConfig.retry).
  retry?: {
    maxRetries?: number        // Default: 3
    baseDelayMs?: number       // Default: 1000
    maxDelayMs?: number        // Default: 60_000
  }
}
```

### Implementation strategy

#### File tree (`fileTree`)

**Source endpoint** (`GET /2.0/repositories/{workspace}/{repo}/src/{revision}/{path}`):

The Bitbucket Source API returns directory listings. Unlike GitHub's Git Trees API, Bitbucket does NOT have a single recursive tree endpoint. The provider must implement recursive traversal:

```
1. Resolve ref to a commit SHA (if ref is a branch name or tag name):
   GET /2.0/repositories/{workspace}/{repo}/refs/branches/{branch}
   → Extract target.hash

2. Walk the directory tree recursively:
   function walkDir(path = ""):
     GET /2.0/repositories/{workspace}/{repo}/src/{commit_sha}/{path}
     Response: {
       type: "directory",
       path: "...",
       commit: { hash: "..." },
       children: [
         { type: "commit_file" | "commit_directory", path: "...", ... }
       ]
     }

     // Bitbucket paginates children when there are >100 entries in a directory
     // Follow pagination via next link in response body.

     For each child:
       if type === "commit_file":
         add to entries with:
           sha ← child.commit.hash  (git SHA-1)
           size ← child.size
           path ← full path relative to root
       if type === "commit_directory":
         recurse into walkDir(child.path)

3. Set truncated = true if any paginated response was
   truncated (partial page) or if maxPages was reached.
```

**Optimization — single-level with depth tracking:**

For the common case where the consumer only needs a specific subdirectory (`fileTree(ref, "src")`), the provider walks only that subtree. The walk is depth-first with a configurable max depth (default: unlimited).

#### Content (`content`)

**Source endpoint for a single file:**

```
GET /2.0/repositories/{workspace}/{repo}/src/{revision}/{path}
```

The response includes the file content as a raw body (not base64-encoded — Bitbucket returns the file contents directly in the response for single-file GETs against the source endpoint).

```
1. GET /2.0/repositories/{workspace}/{repo}/src/{ref}/{path}
2. Response headers:
   Content-Type: text/plain; charset=utf-8 (or other)
3. Body: raw file content as string
4. If Content-Type is not textual: attempt UTF-8 decode; return null on failure
```

**Alternative — raw content URL:**

For public repos:
```
GET https://bitbucket.org/{workspace}/{repo}/raw/{ref}/{path}
```

Same guard conditions as the GitHub raw URL fallback (public repos only, opt-in).

#### Rate limit handling

```
1. Check response headers:
   X-RateLimit-Remaining
   X-RateLimit-Reset

2. Behavior mirrors GitHub provider:
   - Remaining = 0 → compute wait → THROW ProviderRateLimitError
   - 429 Too Many Requests → Retry-After header → THROW ProviderRateLimitError
   - 401 → THROW ProviderAuthenticationError
```

#### Error mapping

| Bitbucket API error | Provider error |
|---|---|
| `404` (Not Found) | `FileNotFoundError` |
| `401` (Unauthorized) | `ProviderAuthenticationError` |
| `403` (Forbidden) | `ProviderAuthenticationError` |
| `429` (Too Many Requests) | `ProviderRateLimitError` |
| Tree exceeds maxPages | Manifest with `truncated: true` |

---

## 7. Local filesystem provider

### Configuration

```ts
interface LocalProviderConfig {
  // Base path on the local filesystem. All SourceRef paths must be
  // within this base (enforced by path traversal guard).
  // If not set, any absolute path is allowed.
  allowedBasePath?: string

  // Path to .gitignore-style ignore files to respect.
  // By default, the provider looks for .gitignore at the root of each
  // scanned directory and applies it. Set to false to skip gitignore parsing.
  respectGitignore?: boolean            // Default: true

  // Additional ignore patterns (gitignore syntax).
  // These are merged with any .gitignore files found.
  // Example: ["*.log", ".cache/", "tmp/"]
  ignorePatterns?: string[]

  // Path to a custom ignore file (gitignore format).
  // If provided alongside respectGitignore, both are applied.
  ignoreFilePath?: string

  // Maximum file size in bytes for content reading.
  // Files exceeding this return null from content().
  // Default: 104_857_600 (100 MB).
  maxContentSize?: number

  // Whether to follow symlinks when scanning directories.
  // Default: false. Set to true with caution — follows symlinks
  // outside the project root.
  followSymlinks?: boolean

  // Hash algorithm for FileEntry.sha.
  // Default: 'sha256'. 'sha1' is available for compatibility.
  hashAlgorithm?: 'sha256' | 'sha1'

  // Filter: only include files matching these glob patterns.
  // Empty array = include all (minus ignores). Patterns use fast-glob syntax.
  includePatterns?: string[]

  // Concurrency for hashing. Number of file content reads + SHA hashes
  // to run in parallel during manifest generation.
  // Default: os.cpus().length.
  hashConcurrency?: number
}
```

### Dependencies

- `fs` (node:fs/promises) — directory reading and file content
- `fast-glob` — glob expansion and recursive file discovery
- `ignore` (kaelzhang/node-ignore) — `.gitignore` pattern matching
- `crypto` (node:crypto) — SHA-256/SHA-1 hashing

### Implementation strategy

#### File tree (`fileTree`)

**Phase 1 — Resolve the reference:**

```ts
// SourceRef.path is the local directory path
// e.g. SourceRef.parse("/home/user/project")
const rootPath = resolve(ref.path)

// Validate path traversal if allowedBasePath is set
if (config.allowedBasePath) {
  if (!rootPath.startsWith(resolve(config.allowedBasePath))) {
    throw new SourceProviderError(`path outside allowed base: ${rootPath}`)
  }
}

// Verify the path exists and is a directory
const stat = await fs.stat(rootPath)
if (!stat.isDirectory()) {
  throw new FileNotFoundError(`not a directory: ${rootPath}`)
}
```

**Phase 2 — Load ignore rules:**

```ts
const ig = ignore()

// Load .gitignore files from root and subdirectories
if (config.respectGitignore) {
  const gitignoreFiles = await findFiles(rootPath, '.gitignore')
  for (const gf of gitignoreFiles) {
    const content = await fs.readFile(gf, 'utf-8')
    // Determine the base directory of the .gitignore for relative pattern matching
    const baseDir = dirname(gf)
    ig.add(relativizePatterns(content, baseDir, rootPath))
  }
}

// Apply custom ignore patterns
if (config.ignorePatterns?.length) {
  ig.add(config.ignorePatterns)
}

// Always ignore .git directory
ig.add('.git/')
```

**Phase 3 — Scan files:**

```ts
// Use fast-glob for recursive file enumeration
const entries: FileEntry[] = []
const patterns = config.includePatterns?.length
  ? config.includePatterns
  : ['**/*']  // include everything (minus ignores)

const stream = fastGlob.stream(patterns, {
  cwd: rootPath,
  dot: true,               // include dotfiles (but ignored .git/ patterns handle it)
  absolute: false,          // relative paths
  onlyFiles: false,         // include directories
  markDirectories: true,    // append / to directory names
  followSymlinks: config.followSymlinks ?? false,
})

for await (const rawPath of stream) {
  const relativePath = String(rawPath).replace(/\/$/, '')  // strip trailing /
  if (ig.ignores(relativePath)) continue

  const absolutePath = join(rootPath, relativePath)
  const stat = await fs.stat(absolutePath)
  const type: FileType = stat.isDirectory() ? 'dir'
    : stat.isSymbolicLink() ? 'symlink'
    : 'file'

  const entry: FileEntry = {
    path: relativePath,
    type,
    size: stat.size,
    sha: '',                // computed in Phase 4
    lastModified: stat.mtime.toISOString(),
  }

  if (type === 'dir') {
    entry.sha = ''          // directories get empty sha
  }

  entries.push(entry)
}
```

**Phase 4 — Hash files (concurrent):**

```ts
// Hash only files that need it (configurable: always hash, or hash on demand)
// Default: hash during manifest generation.

const hashQueue = entries.filter(e => e.type === 'file')
const hasher = config.hashAlgorithm === 'sha1' ? createHash('sha1') : createHash('sha256')

// Use p-limit or similar for concurrent hashing
await Promise.all(
  hashQueue.map(async (entry) => {
    const content = await fs.readFile(join(rootPath, entry.path))
    entry.sha = hasher.copy().update(content).digest('hex')
  })
)
```

**Phase 5 — Build the manifest snapshot hash:**

```ts
// The revision is a SHA-256 of the sorted entry list (path + sha).
// This enables quick change detection: if the revision is the same
// from a previous scan, no files have changed.
const revision = createHash('sha256')
  .update(
    entries
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(e => `${e.path}:${e.sha}`)
      .join('\n')
  )
  .digest('hex')
```

**Why a snapshot hash instead of git SHA:**
- The local provider does not require a git repository. It works on any directory.
- The snapshot hash captures the exact state of all files — including untracked files that git would ignore.
- Change detection: compare `Manifest.revision` across two calls. If they match, no file has changed.

**Performance considerations:**

| Directory size | Files | Time estimate | Bottleneck |
|---|---|---|---|
| Small (<1K files) | 500 | <100ms | fast-glob scan |
| Medium (10K files) | 5,000 | 200-500ms | SHA-256 hashing |
| Large (100K files) | 50,000 | 2-5s | I/O + hashing |
| Very large (1M files) | 500,000 | 30-120s | I/O |

The hash concurrency setting (`hashConcurrency`) directly controls the large-dir case. Default: `os.cpus().length` (typically 8-16 on modern hardware) — saturates disk I/O without overwhelming the event loop.

#### Content (`content`)

```ts
async function content(ref: SourceRef, path: string): Promise<string | null> {
  const rootPath = resolve(ref.path)
  const targetPath = resolve(join(rootPath, path))

  // Path traversal guard
  if (!targetPath.startsWith(rootPath)) {
    throw new FileNotFoundError(`path traversal: ${path}`)
  }

  // Size check
  const stat = await fs.stat(targetPath)
  if (stat.size > config.maxContentSize) {
    return null  // Too large — caller should use contentStream or handle differently
  }

  // Read and decode
  try {
    const buffer = await fs.readFile(targetPath)
    return buffer.toString('utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    if ((err as NodeJS.ErrnoException).code === 'EISDIR') return null
    throw err
  }
}
```

#### Content stream (`contentStream`)

Trivial for the local provider — just returns a `fs.createReadStream`:

```ts
async function contentStream(ref: SourceRef, path: string): Promise<ReadableStream | null> {
  const rootPath = resolve(ref.path)
  const targetPath = resolve(join(rootPath, path))

  if (!targetPath.startsWith(rootPath)) {
    throw new FileNotFoundError(`path traversal: ${path}`)
  }

  try {
    const stat = await fs.stat(targetPath)
    if (stat.isDirectory()) return null
    // node:fs Readable → Web Stream via Readable.toWeb() or polyfill
    return Readable.toWeb(fs.createReadStream(targetPath)) as ReadableStream<Uint8Array>
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}
```

---

## 8. Provider registry

### Design

The registry maps URL schemes to provider factories. Consumers create a registry once (at application startup), register the providers they need, and then use `getProvider(sourceRef)` to obtain the correct provider for any given source reference.

```ts
// ── Provider factory ────────────────────────────────────────────────────────

// A factory that creates a provider instance.
// The factory receives any provider-specific configuration at registration time.
type ProviderFactory = () => SourceProvider

// ── Registry ────────────────────────────────────────────────────────────────

interface ProviderRegistry {
  // Register a provider factory for one or more URL schemes.
  // Schemes are the first path segment of a normalized SourceRef:
  //   "github.com", "bitbucket.org", "local"
  //
  // THROWS SchemeAlreadyRegisteredError if a scheme already has a provider.
  // Callers must deregister first, or use force=true.
  register(scheme: string, factory: ProviderFactory, opts?: { force?: boolean }): void

  // Register a provider that handles multiple schemes at once.
  // Useful when a single provider class handles "github" and "github.com".
  registerMany(schemes: string[], factory: ProviderFactory): void

  // Get the provider for a given source reference.
  // Resolves the scheme from the ref (first path segment of the URI).
  //
  // THROWS ProviderNotFoundError if no provider is registered for the ref's scheme.
  getProvider(ref: SourceRef): SourceProvider

  // Get all registered schemes.
  registeredSchemes(): string[]

  // Remove a provider registration. Returns true if a provider was removed.
  deregister(scheme: string): boolean

  // Create a new provider instance (calls the factory).
  // Returns a fresh instance each time (factories may be stateful — tokens, connections).
  // Use getProvider() for the common case (single instance per scheme).
  createProvider(scheme: string): SourceProvider
}

// ── Default registry implementation ─────────────────────────────────────────

class DefaultProviderRegistry implements ProviderRegistry {
  private factories = new Map<string, ProviderFactory>()
  private instances = new Map<string, SourceProvider>()

  register(scheme: string, factory: ProviderFactory, opts?: { force?: boolean }): void {
    if (this.factories.has(scheme) && !opts?.force) {
      throw new SchemeAlreadyRegisteredError(scheme)
    }
    this.factories.set(scheme, factory)
    this.instances.delete(scheme)  // invalidate cached instance
  }

  getProvider(ref: SourceRef): SourceProvider {
    const scheme = ref.toString().split('/')[0]  // e.g. "github.com", "bitbucket.org", "local"
    if (!this.instances.has(scheme)) {
      const factory = this.factories.get(scheme)
      if (!factory) throw new ProviderNotFoundError(scheme)
      this.instances.set(scheme, factory())
    }
    return this.instances.get(scheme)!
  }

  // ...
}
```

### Registration example

```ts
// Application bootstrap
import { ProviderRegistry } from '@adhd/sox-source-provider'
import { createGitHubProvider } from '@adhd/sox-source-provider/github'
import { createBitbucketProvider } from '@adhd/sox-source-provider/bitbucket'
import { createLocalProvider } from '@adhd/sox-source-provider/local'

const registry = new ProviderRegistry()

registry.registerMany(
  ['github.com', 'github'],
  () => createGitHubProvider({ token: process.env.GITHUB_TOKEN! })
)

registry.registerMany(
  ['bitbucket.org', 'bitbucket'],
  () => createBitbucketProvider({ token: process.env.BITBUCKET_TOKEN! })
)

registry.register(
  'local',
  () => createLocalProvider({ allowedBasePath: '/home/user/projects' })
)

// Usage — consumer has no idea which provider handles this ref
const ref = SourceRef.parse('github.com/owner/repo@main')
const provider = registry.getProvider(ref)
const manifest = await provider.fileTree(ref)
```

### Why lazy instance caching

Provider instances are cached by scheme within the registry. The first call to `getProvider(ref)` creates the instance; subsequent calls return the cached instance. This avoids:
- Re-authenticating for every request (token validation is per-session).
- Re-creating HTTP client connections (connection pooling benefit).
- Re-scanning filesystem configuration.

If a caller needs a fresh instance (e.g., after token rotation), they call `deregister(scheme)` followed by `register(scheme, factory)` — the next `getProvider` call creates a new instance.

---

## 9. Fake provider

### Design

An in-memory fixture provider for integration tests. Returns pre-configured file trees and content. Implements the same `SourceProvider` interface as real providers — no `instanceof` checks or conditional branches in consumer code.

```ts
// ── FakeProvider ────────────────────────────────────────────────────────────

interface FakeProviderEntry {
  path: string        // Relative path from the tree root
  content: string     // File content as a UTF-8 string
  type?: FileType     // Default: 'file'
  sha?: string        // Auto-computed from content if omitted
  size?: number       // Auto-computed from content if omitted
  mode?: string       // Default: '100644'
}

interface FakeProviderConfig {
  // Pre-configured file trees, keyed by SourceRef string form.
  // Each entry is a mapping from ref → array of FakeProviderEntry.
  //
  // Example:
  //   trees: {
  //     "github.com/owner/repo@main": [
  //       { path: "README.md", content: "# Hello" },
  //       { path: "src/index.ts", content: "export const x = 1" },
  //     ]
  //   }
  trees: Record<string, FakeProviderEntry[]>

  // When true, content() requests for paths not in the pre-configured
  // tree return null instead of throwing FileNotFoundError.
  // Default: false.
  allowMissingFiles?: boolean

  // Simulate truncation. When set, fileTree() returns truncated: true
  // if entries.length exceeds this value.
  // Default: Infinity (no truncation).
  truncateAfter?: number

  // Simulate provider errors. When set, the provider throws the
  // corresponding error for the configured number of calls.
  // Useful for testing consumer error handling.
  simulateErrors?: {
    fileTree?: ErrorConfig
    content?: ErrorConfig
  }
}

interface ErrorConfig {
  errorClass: new (message: string) => SourceProviderError
  afterCalls: number     // Start throwing after this many successful calls
  maxThrows: number      // How many times to throw before recovering
}

// ── Factory ─────────────────────────────────────────────────────────────────

function createFakeProvider(config: FakeProviderConfig): SourceProvider
```

### Usage example

```ts
import { createFakeProvider, SourceRef } from '@adhd/sox-source-provider'

const provider = createFakeProvider({
  trees: {
    'github.com/owner/repo@main': [
      { path: 'README.md', content: '# My Project' },
      { path: 'package.json', content: JSON.stringify({ name: 'test' }) },
      { path: 'src/index.ts', content: 'export const x = 42' },
    ],
    'github.com/owner/repo@v1.0.0': [
      { path: 'README.md', content: '# My Project (v1)' },
      { path: 'package.json', content: JSON.stringify({ name: 'test', version: '1.0.0' }) },
    ],
  },
})

const ref = SourceRef.parse('github.com/owner/repo@main')
const manifest = await provider.fileTree(ref)
// manifest.entries.length → 3
// manifest.entries[0].path → "README.md"

const readme = await provider.content(ref, 'README.md')
// readme → "# My Project"
```

### SHA auto-computation

When `sha` is omitted from a `FakeProviderEntry`, the fake provider computes it automatically using the same algorithm as the corresponding real provider:

- For `scheme === 'local'`: SHA-256 hex of content
- For `scheme === 'github.com'` or `'bitbucket.org'`: SHA-1 hex of the content `blob` object (emulating git SHA-1: `SHA-1("blob " + size + "\0" + content)`)

This ensures that consumers that compare SHAs across providers get consistent behavior: the fake matches the real provider's hash format.

### Why a fake provider (not just mocking)

1. **Integration test fidelity.** The fake implements the same `SourceProvider` interface and returns the same types. Consumer code paths are identical to production — no mocking framework, no conditional test wiring.
2. **No network calls.** Tests run in <1ms (in-memory lookups), not 500ms+ (API calls). CI pipelines don't need network access.
3. **Error simulation.** The fake can simulate authentication errors, rate limits, and truncation — scenarios that are difficult to reproduce against real SCM APIs.
4. **Deterministic SHAs.** The fake computes deterministic SHAs based on content, so test assertions are stable across runs and environments.

---

## 10. URL normalization

### Normalization rules

```ts
function normalizeSourceRef(input: string): SourceRef {
  // Strip protocol and trailing slashes
  let normalized = input.replace(/^https?:\/\//, '').replace(/\/$/, '')

  // Normalize "github:" shorthand → "github.com/"
  normalized = normalized.replace(/^github:/, 'github.com/')

  // Normalize "bitbucket:" shorthand → "bitbucket.org/"
  normalized = normalized.replace(/^bitbucket:/, 'bitbucket.org/')

  // Normalize GitHub tree/blob URLs to ref format
  // "github.com/owner/repo/tree/main/src" → "github.com/owner/repo@main/src"
  normalized = normalized.replace(
    /^(github\.com\/[^\/]+\/[^\/]+)\/tree\/([^\/]+)(\/.*)?$/,
    (_, base, ref, path) => `${base}@${ref}${path ?? ''}`
  )

  // Same for blob URLs
  normalized = normalized.replace(
    /^(github\.com\/[^\/]+\/[^\/]+)\/blob\/([^\/]+)(\/.*)?$/,
    (_, base, ref, path) => `${base}@${ref}${path ?? ''}`
  )

  // Normalize local paths
  // "/home/user/project" → "local:/home/user/project"
  if (normalized.startsWith('/')) {
    normalized = `local:${normalized}`
  }

  // Ensure "owner/repo" shorthand becomes fully qualified
  // e.g. "github.com/owner/repo" (no ref) stays as-is
  // e.g. "github.com/owner/repo@main" stays as-is

  return SourceRef.parse(normalized)
}
```

### Normalized form grammar

```
<SourceRef> ::= <scheme> ":" <path> ["@" <ref>] ["/" <subpath>]
<scheme>    ::= "github.com" | "bitbucket.org" | "local"
<path>      ::= <SCM path>   | <filesystem path>
<SCM path>  ::= <owner> "/" <repo>           # e.g. "owner/repo"
<filesystem> ::= <absolute path>             # e.g. "/home/user/project"
<ref>       ::= <branch> | <tag> | <commit SHA>
```

### URL normalization table

| Input | Normalized form |
|---|---|
| `github:owner/repo` | `github.com/owner/repo` |
| `github:owner/repo@main` | `github.com/owner/repo@main` |
| `https://github.com/owner/repo` | `github.com/owner/repo` |
| `https://github.com/owner/repo/tree/main` | `github.com/owner/repo@main` |
| `https://github.com/owner/repo/blob/main/README.md` | `github.com/owner/repo@main/README.md` |
| `bitbucket:workspace/repo` | `bitbucket.org/workspace/repo` |
| `https://bitbucket.org/workspace/repo/src/main` | `bitbucket.org/workspace/repo@main` |
| `/home/user/project` | `local:/home/user/project` |
| `local:/home/user/project` | `local:/home/user/project` |
| `~/projects/my-app` | `local:/home/user/projects/my-app` (tilde expanded) |

### SourceRef validation rules

```ts
// Validation is applied at SourceRef.parse() time:
//
// 1. Scheme must be one of: github.com, bitbucket.org, local
// 2. For SCM schemes (github.com, bitbucket.org):
//    - Path must match <owner>/<repo> (alphanumeric, hyphens, underscores, dots)
//    - Ref is optional but must be non-empty if present
// 3. For local scheme:
//    - Path must be an absolute filesystem path (starting with /)
//    - Ref is not allowed (THROWS InvalidSourceRefError if present)
// 4. Whitespace is not allowed anywhere in the ref
// 5. Lowercase schemes only (github.com, not GitHub.com)
//
// THROWS InvalidSourceRefError on any violation.
```

### Why normalize URLs instead of passing them through

1. **Provider lookup needs a scheme key.** The registry maps `'github.com'` to a `GitHubProvider`. Without normalization, the registry would need to handle `github.com`, `www.github.com`, `https://github.com`, `github:` — each requiring a separate registration rule.
2. **Ref extraction.** GitHub URLs encode the ref in the path (`/tree/main`, `/blob/v1.0.0/README.md`). Normalization extracts the ref and removes encoding ambiguity.
3. **Comparability.** Two consumers that reference the same repo should get the same normalized `SourceRef`. Without normalization, `https://github.com/owner/repo` and `github:owner/repo` would be different refs even though they point to the same tree.

---

## 11. Error taxonomy

```ts
// ── Base error ─────────────────────────────────────────────────────────────

class SourceProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SourceProviderError'
  }
}

// ── Concrete errors ─────────────────────────────────────────────────────────

// Thrown when no provider is registered for a given URL scheme.
// Example: getProvider() called with a "gitlab.com" ref when no
// GitLab provider is registered.
class ProviderNotFoundError extends SourceProviderError {
  constructor(public readonly scheme: string) {
    super(`no provider registered for scheme: ${scheme}`)
    this.name = 'ProviderNotFoundError'
  }
}

// Thrown when a provider cannot authenticate (invalid/missing token,
// expired token, 401 response from API).
class ProviderAuthenticationError extends SourceProviderError {
  constructor(
    message: string,
    public readonly scheme: string
  ) {
    super(message)
    this.name = 'ProviderAuthenticationError'
  }
}

// Thrown when the provider's API rate limit is exhausted.
// The caller should wait retryAfterMs before retrying.
class ProviderRateLimitError extends SourceProviderError {
  constructor(
    message: string,
    public readonly scheme: string,
    public readonly retryAfterMs: number,
    public readonly resetAt?: string     // ISO timestamp
  ) {
    super(message)
    this.name = 'ProviderRateLimitError'
  }
}

// Thrown when a scheme already has a registered provider (registry.register).
class SchemeAlreadyRegisteredError extends SourceProviderError {
  constructor(public readonly scheme: string) {
    super(`scheme already registered: ${scheme}`)
    this.name = 'SchemeAlreadyRegisteredError'
  }
}

// Thrown when the SourceRef string cannot be parsed.
class InvalidSourceRefError extends SourceProviderError {
  constructor(public readonly raw: string, reason: string) {
    super(`invalid source ref "${raw}": ${reason}`)
    this.name = 'InvalidSourceRefError'
  }
}

// Thrown when a file or directory does not exist in the source tree.
// Returned by fileTree() for non-existent directories.
// Returned by content() as null for missing files (not thrown).
class FileNotFoundError extends SourceProviderError {
  constructor(
    public readonly ref: string,
    public readonly path: string
  ) {
    super(`file not found: ${path} in ${ref}`)
    this.name = 'FileNotFoundError'
  }
}

// Thrown when the file tree is too large to enumerate in a single call.
// The consumer should retry with subdirectory-scoped fileTree() calls.
class ManifestTooLargeError extends SourceProviderError {
  constructor(
    public readonly ref: string,
    public readonly maxEntries: number,
    public readonly estimatedTotal: number
  ) {
    super(
      `manifest too large: ${estimatedTotal}+ entries exceeds ` +
      `max ${maxEntries}. Use fileTree() with a subdirectory path.`
    )
    this.name = 'ManifestTooLargeError'
  }
}

// Thrown on transient provider errors: network timeouts, DNS failures,
// 5xx responses, connection resets. The caller SHOULD retry with backoff.
class ProviderTransientError extends SourceProviderError {
  constructor(
    message: string,
    public readonly scheme: string,
    public readonly retryAfterMs?: number
  ) {
    super(message)
    this.name = 'ProviderTransientError'
  }
}
```

### Error hierarchy

```
Error
 └── SourceProviderError (abstract base)
      ├── ProviderNotFoundError
      ├── ProviderAuthenticationError
      ├── ProviderRateLimitError
      ├── SchemeAlreadyRegisteredError
      ├── InvalidSourceRefError
      ├── FileNotFoundError
      ├── ManifestTooLargeError
      └── ProviderTransientError
```

### Error handling guidelines for consumers

```ts
// Consumers should handle errors in order of specificity:
try {
  const manifest = await provider.fileTree(ref)
} catch (err) {
  if (err instanceof ProviderAuthenticationError) {
    // Log + alert: token is invalid
  } else if (err instanceof ProviderRateLimitError) {
    // Wait and retry: err.retryAfterMs
  } else if (err instanceof ManifestTooLargeError) {
    // Subdivide: fileTree(ref, "src"), fileTree(ref, "docs"), etc.
  } else if (err instanceof FileNotFoundError) {
    // The directory does not exist at this ref
  } else if (err instanceof ProviderTransientError) {
    // Retry with exponential backoff
  } else if (err instanceof SourceProviderError) {
    // Generic provider error — log and rethrow
  } else {
    // Unexpected (network stack, assertion, etc.)
  }
}
```

---

## 12. Decisions log

| # | Question | Decision | Rationale |
|---|---|---|---|
| D-1 | **Search/discovery — include in SourceProvider?** | **No** — search is a product-level concern, not an abstraction concern | Search (GitHub Code Search, repo discovery, "find repos with topic X") involves product-specific ranking, filtering, and IP. The SourceProvider abstraction is about fetching known references. Including search would create an infinite interface surface (search across repos? code? issues? wikis?) and couple the package to product decisions. Consumers that need search implement it against the SCM API directly or via a higher-level package. See §3. |
| D-2 | **Separate package vs. part of sox-ingest** | **Separate package** — SourceProvider is a different concern from ingest | `@adhd/sox-ingest` operates on already-in-hand document text — it chunks, normalizes, and prepares text for embedding. It doesn't know where that text came from. SourceProvider is about *fetching* — it talks to SCM APIs and filesystems. Merging them would couple the chunking pipeline to network I/O and make it impossible to unit test chunkers without mocking HTTP. Separate packages also allow the SourceProvider to be reused by non-ingest consumers (CI manifest comparison, deployment verification, policy scanning). See D-4 in retrieval-infrastructure SPEC for the analogous chunker-ingest separation. |
| D-3 | **Flat array vs. nested tree structure for Manifest.entries** | **Flat array** | Consumers iterate all entries (flat loop) or build a lookup map (O(n) from flat array vs. recursive walk from nested tree). Flat is simpler to serialize, diff, and paginate. Consumers that need a tree view build it client-side from the flat list using path prefix matching. See §2. |
| D-4 | **Truncation — throw (ManifestTooLargeError) vs. return truncated manifest with flag** | **Both** — throw at root scope if tree cannot be started; return truncated manifest with flag if partial tree is returned | When the root file tree cannot be fetched at all (e.g., GitHub tree has 200K entries and the API limit is 100K), the provider throws `ManifestTooLargeError` — the consumer must subdivide. When the API returns a partial tree (GitHub's `truncated: true`), the provider returns a `Manifest` with `truncated: true` and the entries it did receive — the consumer can decide whether partial data is useful or whether to subdivide and retry. See §4. |
| D-5 | **Fake provider — in-memory fixture vs. recording proxy** | **In-memory fixture** — pre-configured trees, no recording | A recording proxy (record API calls, playback in tests) introduces significant complexity: request matching, cassette management, version drift between recorded and actual API responses. An in-memory fixture provider is simple, deterministic, and trivially fast (<1ms per call). Test authors declare exactly what trees and files the fake should serve — no surprises from stale recordings. See §9. |
| D-6 | **URL normalization — separate normalization step vs. built into SourceRef** | **Built into SourceRef.parse()** — normalization is part of the parsing/validation pipeline | Every `SourceRef` starts as a raw string. Normalization runs once at parse time and produces a canonical form. The canonical form is used for: (a) provider lookup in the registry, (b) cache keys, (c) equality comparison. If normalization were a separate step, callers could forget to run it and pass denormalized refs to providers, causing missed cache hits or provider lookup failures. See §10. |
| D-7 | **contentStream — optional with runtime check vs. always required** | **Optional, runtime-checked** | Not all sources support streaming (GitHub Contents API, Bitbucket Source API for single files). Making `contentStream` required would force providers to either (a) implement a fake stream (buffer → stream wrapper, which is not genuine streaming) or (b) throw "not implemented". The runtime check is explicit and safe. See §3. |
| D-8 | **Local file tree hashing — SHA-256 of each file vs. SHA-1 of content blob** | **SHA-256** for content, **snapshot hash** for revision | The local filesystem provider is not git — it doesn't need git-compatible SHA-1 hashes. SHA-256 is collision-resistant and consistent with the rest of the `@adhd/sox` ecosystem (blob-store, graph-store). The snapshot hash (SHA-256 of sorted `path:sha` pairs) enables O(1) change detection: if the manifest revision from today matches yesterday's, zero files changed. See §7. |
| D-9 | **GitHub raw content fallback — enabled by default vs. opt-in** | **Opt-in** — disabled unless caller explicitly enables it | The `raw.githubusercontent.com` fallback avoids API rate limit consumption for content reads from public repos. However, it bypasses the configured token, which means: (a) rate limits on raw URLs are per-IP, not per-token, (b) private repos cannot use the fallback, (c) GitHub Enterprise custom hostnames don't have a raw subdomain. Making it opt-in ensures the caller understands these tradeoffs. |
| D-10 | **Bitbucket tree walking — depth-first vs. breadth-first** | **Depth-first** | Bitbucket does not have a recursive tree API — the provider must walk the directory tree one level at a time. Depth-first minimizes memory (stack depth vs. queue size — deep repos are rare; wide repos are common). Depth-first also reaches leaf files faster, which is the common case for content() calls that follow fileTree(). |
| D-11 | **Provider instance caching — lazy per-scheme vs. per-ref** | **Per-scheme** (one instance per scheme) | A `GitHubProvider` instance maintains an HTTP client with connection pooling and token state. Creating per-ref instances would multiply connections and re-authenticate for every ref. Per-scheme caching reuses the same client across all refs with the same scheme. Token rotation is handled by deregister + register. See §8. |
| D-12 | **Bitbucket pagination — maxPages based soft limit vs. hard API limit** | **Soft limit via maxPages config** | Bitbucket's pagination has no hard limit on total entries (unlike GitHub's 100K tree entries). An unbounded walk could make millions of API calls for a large repo. `maxPages` (default: 100 = 10K entries) provides a safety valve. The consumer is notified via `truncated: true`. |

---

## 13. Metrics & observability

Same pattern as all `@adhd/*` packages — `console` logging with `[source-provider]` prefix.

### Logging

| Level | When | Example |
|---|---|---|
| `error` | Unrecoverable: token revoked, API permanently unavailable, filesystem permission denied | `console.error('[source-provider] github: authentication failed for owner/repo — token appears to be revoked')` |
| `warn` | Degraded: rate limit approaching (remaining < 10), tree truncated, retry exhausted before error | `console.warn('[source-provider] github: tree truncated for owner/repo@main (100K+ entries)')` |
| `info` | State change: provider registered, manifest fetched, content read | `console.info('[source-provider] local: manifest fetched for /data/repo (1,234 files, 45.2 MB)')` |
| `debug` | Per-operation detail: API call timing, pagination steps, hash computation | `console.debug('[source-provider] github: fileTree(owner/repo@main) 1.2s, 856 entries, not truncated')` |

### Instrumentation

| Metric | Type | Labels | Description |
|---|---|---|---|
| `sox_source_filetree_count` | counter | `scheme`, `status` | Total fileTree calls, tagged by provider scheme and success/error/truncated |
| `sox_source_content_count` | counter | `scheme`, `status` | Total content calls, tagged by provider scheme and success/error/not-found |
| `sox_source_filetree_latency_ms` | histogram | `scheme` | fileTree latency distribution per provider scheme |
| `sox_source_content_latency_ms` | histogram | `scheme` | content latency distribution per provider scheme |
| `sox_source_rate_limit_hits` | counter | `scheme` | Rate limit errors encountered per provider scheme |
| `sox_source_truncated_manifests` | counter | `scheme` | Manifests returned with truncated: true |
| `sox_source_entries_total` | histogram | `scheme` | Distribution of entries per manifest (for capacity planning) |
| `sox_source_content_bytes_total` | counter | `scheme` | Cumulative bytes of content fetched, per scheme |
| `sox_source_local_hash_time_ms` | histogram | — | Time spent computing SHA-256 hashes during local file tree scans |
| `sox_source_registry_lookup_count` | counter | `hit`, `miss` | Registry.getProvider cache hits vs. misses |

---

## 14. Spec gaps

> Identified during design review. Items separated into **spec-level gaps** (generic
> interface omissions) vs. **implementation details** (belong in the implementation,
> not the spec).

---

### What belongs in the spec

#### 1. GitLab / Gitea / Azure DevOps providers

The current spec covers GitHub, Bitbucket, and local filesystem. GitLab (gitlab.com or self-hosted), Gitea, and Azure DevOps are natural extensions with similar API patterns (tree-ish enumeration + raw file content).

**What's involved:**
- GitLab: Repository Files API (`GET /projects/{id}/repository/tree`) + Raw File API (`GET /projects/{id}/repository/files/{path}/raw`). Pagination via query params. Token auth.
- Gitea: Same pattern — `GET /repos/{owner}/{repo}/contents/{path}` (similar to GitHub).
- Azure DevOps: `GET {org}/{project}/_apis/git/repositories/{repo}/items?scopePath={path}` + `&recursionLevel=Full`. Different auth scheme (PAT with `:base64` header).

**Resolution:** Spec and implement each as a separate provider package within the same repo (e.g. `@adhd/sox-source-provider/gitlab`, `@adhd/sox-source-provider/gitea`). Each follows the same `SourceProvider` interface contract. Registry handles `gitlab.com`, `gitea.com`, `dev.azure.com` schemes.

#### 2. Binary file detection and handling

The current spec says content() "attempts UTF-8 decode and returns null on failure" — but this is naive. Binary detection should be more robust.

**Resolution:** Add a `detectBinary(buffer: Uint8Array): boolean` utility that checks: (a) null bytes in the first 8KB, (b) ratio of non-printable ASCII bytes, (c) common binary magic bytes (PNG, PDF, ZIP, etc.). Add `contentBinary(ref, path): Promise<Uint8Array | null>` to the interface for consumers that need raw binary data. Mark the base `content()` as textual-only (throws `BinaryFileError` or returns null for detected binary files).

#### 3. OAuth flow integration point

The current spec says "token is received at construction time; OAuth is a caller concern." For a CLI tool that needs to initiate an OAuth flow interactively, this creates friction.

**Resolution:** Add an optional `OAuthProvider` interface in a separate module (`@adhd/sox-source-provider/oauth`):

```ts
interface OAuthProvider {
  // Initiate OAuth flow. Returns a URL the user must visit.
  getAuthorizationUrl(state: string): URL

  // Exchange authorization code for a token.
  exchangeCode(code: string, state: string): Promise<{ token: string; expiresAt?: string }>

  // Refresh an expired token.
  refreshToken(token: string): Promise<{ token: string; expiresAt?: string }>
}
```

The base `SourceProvider` package does not implement OAuth — this is a separate concern for consumers that need interactive auth (e.g. CLI tools). The primary token-passing path remains the core design.

#### 4. Large file streaming completion

`contentStream` is optional on the interface. For local provider it's naturally supported. For SCM providers that only support full-response content retrieval (GitHub Contents API, Bitbucket Source API), the "stream" would be a Readable wrapping the full in-memory buffer.

**Resolution:** Define a `createBufferStream(data: Uint8Array): ReadableStream<Uint8Array>` utility that wraps in-memory data as a stream. SCM providers use this when the API returns the full body. The stream interface is consistent for the consumer even when the underlying mechanism is not truly streaming.

#### 5. Concurrent manifest fetching

A consumer may need to fetch manifests from multiple providers simultaneously (e.g., diff a GitHub repo against a local checkout). The registry and individual providers are stateless with respect to request ordering — concurrent calls are safe at the provider level. However, the registry's lazy instance caching means a single `HTTPClient` is shared across all concurrent requests to the same provider scheme.

**Resolution:** Document thread/concurrency safety guarantees: (a) Providers MUST be safe to call concurrently (same instance, multiple in-flight `fileTree`/`content` calls). (b) The registry's `getProvider()` is safe to call concurrently. (c) Rate limit tracking is per-provider-instance and is updated atomically.

#### 6. Manifest caching / revision-based content optimization

When a consumer already has a manifest from a previous session, and the revision hasn't changed, it should be able to skip the `fileTree()` call entirely. The current spec doesn't define how the consumer detects this.

**Resolution:** Add an optional `getRevision(ref: SourceRef): Promise<string>` method to the `SourceProvider` interface. This returns just the revision identifier (commit SHA for SCM, snapshot hash for local) without enumerating the full tree. The consumer compares this to its cached revision; if unchanged, it uses the cached manifest.

```ts
interface SourceProvider {
  // Optional — not all providers implement it.
  // Returns the current revision of the tree without enumerating entries.
  // For GitHub: GET /repos/{owner}/{repo}/git/ref/{ref} → commit SHA
  // For local: stat all file mtimes + sizes → snapshot hash (lightweight, no content reads)
  getRevision?(ref: SourceRef): Promise<string>
}
```

---

### What belongs in the implementation, not the spec

**HTTP client choice** (undici, node-fetch, axios, native fetch) — the spec defines the API contract, not the transport layer. The implementation should choose based on Node.js version and bundler constraints.

**Retry backoff algorithm** (exponential with jitter vs. linear vs. constant) — the spec says "retry with backoff" but does not mandate a specific algorithm. The implementation chooses.

**Bitbucket pagination traversal** (follow `next` link in response vs. compute from page number + pagelen) — both are valid. The implementation chooses based on API response shape.

**GitHub tree entry → SHA-1 digest computation** — the spec says the provider uses `entry.sha` from the Git Trees API. The implementation must handle the difference between tree SHA (for directories) and blob SHA (for files). The spec only defines the public contract (FileEntry.sha is always the content hash for files).

**Local filesystem concurrency control** (p-limit vs. async queue vs. manual Promise.all batching) — the spec defines the `hashConcurrency` config value. The implementation chooses the concurrency control mechanism.

**SourceRef toString format** — the spec defines the input parsing and the semantic components (scheme, authority, path, ref). The exact `toString()` output format (which determines cache key format) is an implementation detail as long as `parse(toString(ref)) === ref` (round-trip stability).

---

## Dispatch

| | |
|---|---|
| **Agent** | `flash` |
| **Spec section** | Full document — new leaf package |
| **Files** | `libs/source-provider/` (new) |
| **Depends on** | `@octokit/rest` (GitHub provider), `fast-glob` (local provider), `ignore` (kaelzhang/node-ignore — local provider gitignore parsing) |

**Prompt notes for the agent:**
- `SourceProvider` is the primary export — consumers import `SourceProvider` and `SourceRef` from the package root
- Provider implementations live in subdirectories: `github/`, `bitbucket/`, `local/`, `fake/`
- The registry (`DefaultProviderRegistry`) is exported from the package root — consumers bootstrap it with their chosen providers
- No provider implementation is imported by consumers directly — everything goes through the registry
- `@octokit/rest` is the only non-standard dependency (SCM providers) — it can be optional / tree-shaken if only local provider is used
- Follow the existing `@adhd/sox-*` conventions: `console` logging with `[source-provider]` prefix, error classes extending `Error`, TypeScript strict mode
- The fake provider is NOT a test-only file — it is a first-class export of the package. Consumers use it for integration testing their own code
- All errors listed in §11 must be exported from the package root
- URL normalization is implemented as a static method on the `SourceRef` class (or a free function, `normalizeSourceRef`), not as a separate utility that callers might forget to use
- The package root should export: `SourceProvider`, `SourceRef`, `Manifest`, `FileEntry`, `FileType`, `ProviderRegistry`, `DefaultProviderRegistry`, `createFakeProvider`, `FakeProviderConfig`, `FakeProviderEntry`, and all error classes
- Live verification: follow `CONTRIBUTING.md` §2.x for data lib (new leaf package)
