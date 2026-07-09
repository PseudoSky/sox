// @adhd/sox-source-provider — fake provider (in-memory test double)
// Authoritative spec: sox-ecosystem/docs/plan/source-provider/SPEC.md §9
//
// The fake provider is a first-class export, not a test-only file (SPEC
// Dispatch notes). It implements the exact same `SourceProvider` interface
// as the real providers — no `instanceof` checks, no conditional branches in
// consumer code — so integration tests exercise the real consumer code path.

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { FileNotFoundError, SourceProviderError } from '../errors.js';
import { normalizeSourceRef, type SourceRef } from '../source-ref.js';
import type { FileEntry, FileType, Manifest, SourceProvider } from '../types.js';

export interface FakeProviderEntry {
  /** Relative path from the tree root. */
  path: string;
  /** File content as a UTF-8 string. */
  content: string;
  /** Default: 'file'. */
  type?: FileType;
  /** Auto-computed from content if omitted (git-blob SHA-1 for SCM schemes, SHA-256 for local). */
  sha?: string;
  /** Auto-computed from content (UTF-8 byte length) if omitted. */
  size?: number;
  /** Default: '100644'. */
  mode?: string;
}

export interface ErrorConfig {
  errorClass: new (message: string) => SourceProviderError;
  /** Start throwing after this many successful calls. */
  afterCalls: number;
  /** How many times to throw before recovering. */
  maxThrows: number;
}

export interface FakeProviderConfig {
  /** Pre-configured file trees, keyed by SourceRef string form (see SourceRef.toString()). */
  trees: Record<string, FakeProviderEntry[]>;
  /**
   * When true, `content()` requests for paths not in the pre-configured tree
   * return `null` instead of throwing `FileNotFoundError`. Default: false.
   */
  allowMissingFiles?: boolean;
  /**
   * Simulate truncation: `fileTree()` returns `truncated: true` (and only
   * the first `truncateAfter` entries) once `entries.length` exceeds this
   * value. Default: no truncation.
   */
  truncateAfter?: number;
  /** Simulate provider errors for a configured number of calls, then recover. */
  simulateErrors?: {
    fileTree?: ErrorConfig;
    content?: ErrorConfig;
  };
}

interface ResolvedTree {
  entries: FileEntry[];
  contents: Map<string, string>;
  revision: string;
  hashAlgorithm: 'sha1' | 'sha256';
  totalSize: number;
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/** Emulate git's blob SHA-1: SHA-1("blob " + byteLength + "\0" + content). */
function gitBlobSha1(content: string): string {
  const buf = Buffer.from(content, 'utf-8');
  const header = Buffer.from(`blob ${buf.length}\0`, 'utf-8');
  return createHash('sha1').update(Buffer.concat([header, buf])).digest('hex');
}

function resolveTree(refKey: string, fakeEntries: FakeProviderEntry[]): ResolvedTree {
  // Validates the key is a well-formed SourceRef string and determines which
  // hash algorithm to emulate (SHA-256 for local, git-blob SHA-1 for SCM).
  const ref = normalizeSourceRef(refKey);
  const hashAlgorithm: 'sha1' | 'sha256' = ref.scheme === 'local' ? 'sha256' : 'sha1';
  const contents = new Map<string, string>();

  const entries: FileEntry[] = fakeEntries.map((fe) => {
    const type: FileType = fe.type ?? 'file';
    const size = fe.size ?? Buffer.byteLength(fe.content, 'utf-8');
    const sha = fe.sha ?? (hashAlgorithm === 'sha256' ? sha256Hex(fe.content) : gitBlobSha1(fe.content));
    contents.set(fe.path, fe.content);
    return {
      path: fe.path,
      type,
      size,
      sha,
      mode: fe.mode ?? '100644',
    };
  });

  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const revision = createHash('sha256')
    .update(sorted.map((e) => `${e.path}:${e.sha}`).join('\n'))
    .digest('hex');
  const totalSize = entries.reduce((sum, e) => sum + e.size, 0);

  return { entries, contents, revision, hashAlgorithm, totalSize };
}

/** Tracks invocation count and throws `cfg.errorClass` for a configured window of calls. */
function makeErrorSimulator(cfg: ErrorConfig | undefined): () => void {
  let calls = 0;
  let thrown = 0;
  return () => {
    calls += 1;
    if (!cfg) return;
    if (calls > cfg.afterCalls && thrown < cfg.maxThrows) {
      thrown += 1;
      throw new cfg.errorClass(`simulated error (call #${calls})`);
    }
  };
}

class FakeSourceProvider implements SourceProvider {
  private readonly trees = new Map<string, ResolvedTree>();
  private readonly allowMissingFiles: boolean;
  private readonly truncateAfter: number;
  private readonly simulateFileTreeError: () => void;
  private readonly simulateContentError: () => void;

  constructor(config: FakeProviderConfig) {
    for (const [key, entries] of Object.entries(config.trees)) {
      this.trees.set(key, resolveTree(key, entries));
    }
    this.allowMissingFiles = config.allowMissingFiles ?? false;
    this.truncateAfter = config.truncateAfter ?? Infinity;
    this.simulateFileTreeError = makeErrorSimulator(config.simulateErrors?.fileTree);
    this.simulateContentError = makeErrorSimulator(config.simulateErrors?.content);
  }

  supportedSchemes(): string[] {
    return ['github', 'github.com', 'bitbucket', 'bitbucket.org', 'local', 'file'];
  }

  isAvailable(): boolean {
    return true;
  }

  async fileTree(ref: SourceRef, path?: string): Promise<Manifest> {
    this.simulateFileTreeError();

    const key = ref.toString();
    const tree = this.trees.get(key);
    if (!tree) throw new FileNotFoundError(key, path ?? '.');

    let entries = tree.entries;
    if (path) {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      entries = entries.filter((e) => e.path === path || e.path.startsWith(prefix));
    }

    let truncated = false;
    if (entries.length > this.truncateAfter) {
      truncated = true;
      entries = entries.slice(0, this.truncateAfter);
    }

    return {
      revision: tree.revision,
      rootUri: ref,
      truncated,
      entries: entries.map((e) => ({ ...e })),
      metadata: {
        hashAlgorithm: tree.hashAlgorithm,
        entryCount: tree.entries.length,
        totalSize: tree.totalSize,
      },
      fetchedAt: new Date().toISOString(),
    };
  }

  async content(ref: SourceRef, path: string): Promise<string | null> {
    this.simulateContentError();

    const key = ref.toString();
    const tree = this.trees.get(key);
    const found = tree?.contents.get(path);
    if (found === undefined) {
      if (this.allowMissingFiles) return null;
      throw new FileNotFoundError(key, path);
    }
    return found;
  }

  async contentStream(ref: SourceRef, path: string): Promise<ReadableStream<Uint8Array> | null> {
    const text = await this.content(ref, path);
    if (text === null) return null;
    const buffer = Buffer.from(text, 'utf-8');
    return Readable.toWeb(Readable.from(buffer)) as ReadableStream<Uint8Array>;
  }

  async getRevision(ref: SourceRef): Promise<string> {
    const key = ref.toString();
    const tree = this.trees.get(key);
    if (!tree) throw new FileNotFoundError(key, '.');
    return tree.revision;
  }
}

/** Create an in-memory fixture provider for integration tests (SPEC §9). */
export function createFakeProvider(config: FakeProviderConfig): SourceProvider {
  return new FakeSourceProvider(config);
}
