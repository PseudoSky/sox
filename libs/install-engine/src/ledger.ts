/**
 * libs/install-engine/src/ledger.ts
 *
 * Per-scope provenance ledger — [def:ledger], [inv:ledger-reversible], [ref:ledger-reversible].
 *
 * A ledger records every shared-file write (config-merge / array-merge) as a
 * LedgerAction keyed by (ext, host, scope).  Capabilities read/write the ledger
 * so that reverse() can undo ONLY sox-owned entries and never touch foreign keys.
 *
 * Ledger location:
 *   project scope → <scope-root>/.sox/ledger.json  (committed, portable — repo-relative paths)
 *   user scope    → ~/.sox/ledger.json              (gitignored)
 *   org/local     → <scope-root>/.sox/ledger.json
 *
 * Portability invariant ([def:ledger] ADR resolved #3):
 *   The project ledger must contain ONLY repo-relative paths and keyPaths / hashes —
 *   no absolute or user-home paths.  The Ledger.assertPortable() helper enforces this
 *   on write so tests can verify it.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';

// --- Shape: LedgerAction ([shape:ledger-action]) ---

/** The six capability identifiers that can appear in a ledger action. */
export type CapabilityId =
  | 'config-merge'
  | 'array-merge'
  | 'materialize'
  | 'file-drop'
  | 'bin-link'
  | 'run-service';

/**
 * A single recorded write in the ledger.
 * - file      : repo-relative path for project ledger; absolute for user ledger
 * - keyPath   : dot/bracket path within the shared file (e.g. "mcpServers.tokenguard")
 * - values    : array-merge only - the exact values sox appended (deny-wins)
 * - appliedHash: config-merge only - sha256 of the value sox set
 */
export interface LedgerAction {
  cap: CapabilityId;
  file: string;
  keyPath: string;
  values?: string[];
  appliedHash?: string;
}

/** One entry in the ledger keyed by (ext@version, host, scope). */
export interface LedgerEntry {
  ext: string;
  host: string;
  scope: string;
  actions: LedgerAction[];
  installedAt: string;
}

/** The full ledger file shape. */
export interface LedgerFile {
  version: 1;
  entries: LedgerEntry[];
}

// --- Utilities ---

/** Compute sha256 of an arbitrary value (stringified). */
export function sha256(value: unknown): string {
  const s = JSON.stringify(value);
  return 'sha256:' + crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * Resolve the ledger file path for a given scope root.
 * Always <scope-root>/.sox/ledger.json regardless of scope kind.
 */
export function ledgerPath(scopeRoot: string): string {
  return path.join(scopeRoot, '.sox', 'ledger.json');
}

/**
 * Resolve the user ledger path (~/.sox/ledger.json).
 * This file is gitignored and may contain absolute paths.
 */
export function userLedgerPath(): string {
  return path.join(os.homedir(), '.sox', 'ledger.json');
}

// --- Ledger class ---

/**
 * Ledger - reads and writes the per-scope provenance file.
 *
 * Usage:
 *   const ledger = Ledger.load(scopeRoot);
 *   ledger.record({ ext, host, scope, action });
 *   ledger.save();
 *
 *   // To reverse:
 *   const actions = ledger.actionsFor(ext, host, scope);
 *   // ...undo each action...
 *   ledger.remove(ext, host, scope);
 *   ledger.save();
 */
export class Ledger {
  private readonly filePath: string;
  private data: LedgerFile;
  private readonly isProject: boolean;

  private constructor(filePath: string, data: LedgerFile, isProject: boolean) {
    this.filePath = filePath;
    this.data = data;
    this.isProject = isProject;
  }

  /** Load or create the ledger at the given scope root. */
  static load(scopeRoot: string, opts?: { isProject?: boolean }): Ledger {
    const fp = ledgerPath(scopeRoot);
    let data: LedgerFile = { version: 1, entries: [] };
    if (fs.existsSync(fp)) {
      try {
        const raw = fs.readFileSync(fp, 'utf8');
        data = JSON.parse(raw) as LedgerFile;
        if (!Array.isArray(data.entries)) {
          data.entries = [];
        }
      } catch {
        data = { version: 1, entries: [] };
      }
    }
    return new Ledger(fp, data, opts?.isProject ?? false);
  }

  /** Record a new action for (ext, host, scope). Merges into existing entry. */
  record(opts: {
    ext: string;
    host: string;
    scope: string;
    action: LedgerAction;
  }): void {
    const { ext, host, scope, action } = opts;
    if (this.isProject) {
      this.assertPortableAction(action);
    }
    let entry = this.data.entries.find(
      (e) => e.ext === ext && e.host === host && e.scope === scope
    );
    if (!entry) {
      entry = { ext, host, scope, actions: [], installedAt: new Date().toISOString() };
      this.data.entries.push(entry);
    }
    entry.actions.push(action);
  }

  /** Return all recorded actions for (ext, host, scope), or []. */
  actionsFor(ext: string, host: string, scope: string): LedgerAction[] {
    const entry = this.data.entries.find(
      (e) => e.ext === ext && e.host === host && e.scope === scope
    );
    return entry?.actions ?? [];
  }

  /** Remove the entry for (ext, host, scope) after reversal. */
  remove(ext: string, host: string, scope: string): void {
    this.data.entries = this.data.entries.filter(
      (e) => !(e.ext === ext && e.host === host && e.scope === scope)
    );
  }

  /** Return a copy of all entries (for testing/inspection). */
  entries(): LedgerEntry[] {
    return [...this.data.entries];
  }

  /** Persist the ledger to disk, creating parent dirs as needed. */
  save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2) + '\n', 'utf8');
  }

  /** The on-disk path of this ledger file. */
  get path(): string {
    return this.filePath;
  }

  /**
   * Assert that a project-ledger action contains no absolute or user-home paths.
   * Throws if the action would violate the portability invariant.
   */
  private assertPortableAction(action: LedgerAction): void {
    const abs = path.isAbsolute(action.file);
    const hasHome = action.file.startsWith('~') || action.file.startsWith(os.homedir());
    if (abs || hasHome) {
      throw new Error(
        '[inv:ledger-reversible] Project ledger must not contain absolute or user-home paths. ' +
        'Offending file: ' + action.file
      );
    }
  }

  /**
   * Assert that ALL actions in this ledger are portable (repo-relative paths).
   * Used by tests to verify the project-ledger portability invariant.
   */
  assertAllPortable(): void {
    for (const entry of this.data.entries) {
      for (const action of entry.actions) {
        this.assertPortableAction(action);
      }
    }
  }
}
