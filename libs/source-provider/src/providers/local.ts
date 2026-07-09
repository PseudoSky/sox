// @adhd/sox-source-provider — local filesystem provider
// Authoritative spec: sox-ecosystem/docs/plan/source-provider/SPEC.md §7

import { createReadStream, statSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { cpus } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';

import fg from 'fast-glob';
import ignoreFactory, { type Ignore } from 'ignore';

import { FileNotFoundError, SourceProviderError } from '../errors.js';
import type { SourceRef } from '../source-ref.js';
import type { FileEntry, FileType, Manifest, SourceProvider } from '../types.js';
import { mapWithConcurrency } from '../util/concurrency.js';

const DEFAULT_MAX_CONTENT_SIZE = 104_857_600; // 100 MB

export interface LocalProviderConfig {
  /**
   * Base path on the local filesystem. All SourceRef paths must be within
   * this base (enforced by a path traversal guard). If unset, any absolute
   * path is allowed.
   */
  allowedBasePath?: string;
  /** Respect `.gitignore` files found under the scanned tree. Default: true. */
  respectGitignore?: boolean;
  /** Additional ignore patterns (gitignore syntax), merged with any `.gitignore` files. */
  ignorePatterns?: string[];
  /** Path to a custom ignore file (gitignore format), applied alongside `respectGitignore`. */
  ignoreFilePath?: string;
  /** Maximum file size in bytes for `content()`. Files exceeding this return `null`. Default: 100 MB. */
  maxContentSize?: number;
  /** Follow symlinks when scanning directories. Default: false. */
  followSymlinks?: boolean;
  /** Hash algorithm for `FileEntry.sha`. Default: 'sha256'. */
  hashAlgorithm?: 'sha256' | 'sha1';
  /** Only include files matching these glob patterns (fast-glob syntax). Empty = include all (minus ignores). */
  includePatterns?: string[];
  /** Concurrency for hashing during manifest generation. Default: os.cpus().length. */
  hashConcurrency?: number;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function isWithin(base: string, target: string): boolean {
  if (base === target) return true;
  const rel = relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function posixJoin(...parts: string[]): string {
  return parts
    .filter((p) => p.length > 0)
    .join('/')
    .replace(/\/+/g, '/');
}

/** Prefix a `.gitignore` file's pattern lines with the directory it was found in (relative to the scan root). */
function prefixGitignoreContent(raw: string, baseDir: string): string {
  if (!baseDir) return raw;
  return raw
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      const negate = trimmed.startsWith('!');
      const pattern = negate ? trimmed.slice(1) : trimmed;
      const anchored = pattern.startsWith('/') ? pattern.slice(1) : pattern;
      const prefixed = `${baseDir}/${anchored}`;
      return negate ? `!${prefixed}` : prefixed;
    })
    .join('\n');
}

export class LocalProvider implements SourceProvider {
  constructor(private readonly config: LocalProviderConfig = {}) {}

  supportedSchemes(): string[] {
    return ['local', 'file'];
  }

  isAvailable(): boolean {
    if (this.config.allowedBasePath) {
      try {
        return statSync(resolve(this.config.allowedBasePath)).isDirectory();
      } catch {
        return false;
      }
    }
    return true;
  }

  async fileTree(ref: SourceRef, path?: string): Promise<Manifest> {
    const rootPath = resolve(ref.path);
    this.assertAllowedBase(rootPath);

    try {
      const rootStat = await fs.stat(rootPath);
      if (!rootStat.isDirectory()) throw new Error('not a directory');
    } catch {
      throw new FileNotFoundError(ref.toString(), path ?? '.');
    }

    const scanRoot = path ? join(rootPath, path) : rootPath;
    try {
      const scanStat = await fs.stat(scanRoot);
      if (!scanStat.isDirectory()) throw new Error('not a directory');
    } catch {
      throw new FileNotFoundError(ref.toString(), path ?? '.');
    }

    const ig = await this.buildIgnore(rootPath);
    const patterns = this.config.includePatterns?.length ? this.config.includePatterns : ['**/*'];
    const followSymbolicLinks = this.config.followSymlinks ?? false;

    const rawEntries = await fg(patterns, {
      cwd: scanRoot,
      dot: true,
      absolute: false,
      onlyFiles: false,
      markDirectories: true,
      followSymbolicLinks,
    });

    const entries: FileEntry[] = [];
    for (const rawPath of rawEntries) {
      const scanRelative = rawPath.replace(/\/$/, '');
      const fullRelative = path ? posixJoin(path, scanRelative) : scanRelative;
      if (ig.ignores(fullRelative)) continue;

      const absolutePath = join(scanRoot, scanRelative);
      const st = await fs.lstat(absolutePath);
      const type: FileType = st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'symlink' : 'file';

      entries.push({
        path: fullRelative,
        type,
        size: type === 'dir' ? 0 : st.size,
        sha: '',
        lastModified: st.mtime.toISOString(),
      });
    }

    const hashAlgorithm = this.config.hashAlgorithm ?? 'sha256';
    const concurrency = this.config.hashConcurrency ?? Math.max(1, cpus().length);
    const filesToHash = entries.filter((e) => e.type === 'file');

    await mapWithConcurrency(filesToHash, concurrency, async (entry) => {
      const absolutePath = join(rootPath, entry.path);
      const content = await fs.readFile(absolutePath);
      entry.sha = createHash(hashAlgorithm).update(content).digest('hex');
    });

    const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
    const revision = createHash('sha256')
      .update(sorted.map((e) => `${e.path}:${e.sha}`).join('\n'))
      .digest('hex');

    const totalSize = entries.reduce((sum, e) => sum + e.size, 0);

    return {
      revision,
      rootUri: ref,
      truncated: false,
      entries,
      metadata: {
        hashAlgorithm,
        entryCount: entries.length,
        totalSize,
      },
      fetchedAt: new Date().toISOString(),
    };
  }

  async content(ref: SourceRef, path: string): Promise<string | null> {
    const rootPath = resolve(ref.path);
    this.assertAllowedBase(rootPath);
    const targetPath = resolve(join(rootPath, path));

    if (!isWithin(rootPath, targetPath)) {
      throw new FileNotFoundError(ref.toString(), path);
    }

    let stat;
    try {
      stat = await fs.stat(targetPath);
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') return null;
      throw err;
    }

    if (stat.isDirectory()) return null;

    const maxSize = this.config.maxContentSize ?? DEFAULT_MAX_CONTENT_SIZE;
    if (stat.size > maxSize) return null;

    try {
      const buffer = await fs.readFile(targetPath);
      return buffer.toString('utf-8');
    } catch (err) {
      if (isErrnoException(err) && (err.code === 'ENOENT' || err.code === 'EISDIR')) return null;
      throw err;
    }
  }

  async contentStream(ref: SourceRef, path: string): Promise<ReadableStream<Uint8Array> | null> {
    const rootPath = resolve(ref.path);
    this.assertAllowedBase(rootPath);
    const targetPath = resolve(join(rootPath, path));

    if (!isWithin(rootPath, targetPath)) {
      throw new FileNotFoundError(ref.toString(), path);
    }

    try {
      const stat = await fs.stat(targetPath);
      if (stat.isDirectory()) return null;
      return Readable.toWeb(createReadStream(targetPath)) as ReadableStream<Uint8Array>;
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async getRevision(ref: SourceRef): Promise<string> {
    const manifest = await this.fileTree(ref);
    return manifest.revision;
  }

  private assertAllowedBase(rootPath: string): void {
    if (!this.config.allowedBasePath) return;
    const base = resolve(this.config.allowedBasePath);
    if (!isWithin(base, rootPath)) {
      throw new SourceProviderError(`path outside allowed base: ${rootPath}`);
    }
  }

  private async buildIgnore(rootPath: string): Promise<Ignore> {
    const ig = ignoreFactory();
    const respectGitignore = this.config.respectGitignore ?? true;

    if (respectGitignore) {
      const gitignoreFiles = await fg('**/.gitignore', {
        cwd: rootPath,
        dot: true,
        absolute: true,
        followSymbolicLinks: false,
      });
      for (const gf of gitignoreFiles.sort()) {
        const raw = await fs.readFile(gf, 'utf-8');
        const baseDir = relative(rootPath, dirname(gf)).split(sep).join('/');
        ig.add(prefixGitignoreContent(raw, baseDir === '.' ? '' : baseDir));
      }
    }

    if (this.config.ignoreFilePath) {
      const raw = await fs.readFile(this.config.ignoreFilePath, 'utf-8');
      ig.add(raw);
    }

    if (this.config.ignorePatterns?.length) {
      ig.add(this.config.ignorePatterns);
    }

    ig.add('.git/');
    return ig;
  }
}

export function createLocalProvider(config: LocalProviderConfig = {}): SourceProvider {
  return new LocalProvider(config);
}
