# @adhd/sox-registry

Drift detection for a JSON extension index. It loads `registry/index.json` from a repo root, compares it against the extension manifests actually found on disk, and reports three kinds of mismatch — entries that were removed without a rebuild (**stale**), entries that were added without a rebuild (**unindexed**), and entries whose source file changed without a checksum update (**mutated**). It also ships the sha256 checksum helpers the index itself is built from.

```bash
pnpm add @adhd/sox-registry
```

## Quick start

```typescript
import { detectDrift, assertNoDrift } from '@adhd/sox-registry';

// Non-throwing: inspect the report yourself.
const report = detectDrift('/path/to/repo');
if (!report.ok) {
  console.log('stale:', report.stale);         // in index, not on disk
  console.log('unindexed:', report.unindexed); // on disk, not in index
  console.log('mutated:', report.mutated);     // checksum mismatch
}

// Throwing: use directly as a CI gate.
assertNoDrift('/path/to/repo');
// throws Error('[registry] Drift detected — re-run ... ') when out of sync
```

## What it expects on disk

`detectDrift(root)` reads two things under `root`:

- **`registry/index.json`** — an array of `RegistryIndexEntry`, loaded via `loadIndex()`.
- **`extensions/<type-dir>/<id>/extension.json`** — one manifest per extension. `<type-dir>` must be one of `agents`, `skills`, `mcp-servers`, `prompts`, `hooks`, `commands`, `bundles`; each manifest needs an `id` field (manifests with `private: true` are skipped, and manifests missing or with unparseable JSON are silently skipped rather than treated as drift).

Checksum drift is only checked for entries whose `source` starts with `file://` — directory-sourced entries have no per-file checksum to compare.

## API reference

### Drift gate

```typescript
interface DriftReport {
  ok: boolean;           // true when stale/unindexed/mutated are all empty
  stale: string[];       // extension ids in the index but not found on disk
  unindexed: string[];   // extension ids on disk but not in the index
  mutated: string[];     // extension ids whose disk checksum no longer matches the index
}

function detectDrift(root: string): DriftReport;
function assertNoDrift(root: string): void; // throws a formatted Error when detectDrift(root).ok is false
```

### Index I/O

```typescript
function loadIndex(root: string): RegistryIndexEntry[];               // [] if registry/index.json doesn't exist
function writeIndex(root: string, entries: RegistryIndexEntry[]): void; // creates registry/ if missing

interface RegistryIndexEntry {
  id: string;
  type: string;
  version: string;
  title: string;
  description: string;
  source: string;          // e.g. "file:///abs/path/to/entry" or a directory URI
  checksum: string;         // "sha256:<hex>"
  compatibility: { host: string };
  requires?: {
    tool_calling?: boolean;
    structured_output?: boolean;
    min_context_tokens?: number;
  };
  members?: Array<{ id: string }>;
}
```

### Checksums

```typescript
function computeChecksum(data: Buffer | string): string;       // "sha256:<hex>"
function computeFileChecksum(filePath: string): string;        // reads the file, then computeChecksum
function verifyChecksum(filePath: string, expectedChecksum: string): boolean; // false if the file is missing
```

## Using it as a CI gate

```typescript
import { assertNoDrift } from '@adhd/sox-registry';

// e.g. in a build/lint script — exits non-zero (via the thrown Error) if
// registry/index.json has fallen out of sync with extensions/ on disk.
assertNoDrift(process.cwd());
```

## Building the index yourself

`writeIndex` and `computeFileChecksum` are the two calls a build-index script needs — read each `extension.json`, checksum its source file, and assemble `RegistryIndexEntry[]`:

```typescript
import { writeIndex, computeFileChecksum, type RegistryIndexEntry } from '@adhd/sox-registry';

const entries: RegistryIndexEntry[] = [
  {
    id: 'my-agent',
    type: 'agent',
    version: '0.1.0',
    title: 'My Agent',
    description: 'A test agent',
    source: 'file:///abs/path/to/extensions/agents/my-agent/extension.json',
    checksum: computeFileChecksum('/abs/path/to/extensions/agents/my-agent/extension.json'),
    compatibility: { host: '>=1.0.0' },
  },
];

writeIndex('/path/to/repo', entries);
```

## Gotchas

- `loadIndex` and `writeIndex` never throw on their own — a missing or malformed `registry/index.json` is treated as an empty index (`[]`), not an error.
- `detectDrift` silently skips any `extension.json` that fails to parse, rather than reporting it as a distinct error class — a malformed manifest simply won't count toward `onDiskIds`, and its absence from the index (if it's already indexed) surfaces as `stale` instead.
- Checksum drift detection only applies to `file://`-sourced entries; directory-sourced entries are excluded from the `mutated` check entirely.
