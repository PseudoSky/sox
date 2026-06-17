/**
 * mapstore.ts — single read/write owner of the live token-map file.
 *
 * Shared by the proxy (service process) and the CLI (exec'd process).
 * Responsibilities:
 *   - atomic append of a custom/tooling entry to token-mapping.json
 *   - full read of current entries for inspection
 *   - change signal via stdlib fs.watch + ~100ms debounce so the running
 *     proxy can re-read and merge without restart [def:live-map]
 *
 * Design decision (not executor discretion): stdlib fs.watch, no chokidar.
 * [tg-cli.2] [tg-cli.3]
 *
 * [inv:bijective-roundtrip] — appended entry is a standard MapEntry; the
 *   Mapper enforces bijection on load (existing real is never reassigned).
 * [inv:c7-no-reach-in] — imports engine via @sox/tokenguard-core only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { Mapper } from '@sox/tokenguard-core';
import type { MapEntry, Source } from '@sox/tokenguard-core';

// ── TokenMap shape ────────────────────────────────────────────────────────────

interface TokenMap {
  version: 2;
  entries: MapEntry[];
}

function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ── Atomic write helper ───────────────────────────────────────────────────────

function atomicWrite(filePath: string, doc: TokenMap): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

// ── Read helper ───────────────────────────────────────────────────────────────

/**
 * Read all entries from the token-map file. Returns [] if the file does not
 * exist or cannot be parsed.
 */
export function readEntries(mapPath: string): MapEntry[] {
  if (!fs.existsSync(mapPath)) return [];
  try {
    const raw = fs.readFileSync(mapPath, 'utf8');
    const doc = JSON.parse(raw) as Partial<TokenMap>;
    return Array.isArray(doc.entries) ? (doc.entries as MapEntry[]) : [];
  } catch {
    return [];
  }
}

// ── Append helper ─────────────────────────────────────────────────────────────

/**
 * Atomically append one custom/tooling entry to the token-map file.
 *
 * Uses a transient Mapper loaded from the current file so bijection is
 * enforced: if `real` already has a token, that existing token is returned
 * unchanged (idempotent). The explicit `token` (if provided) is honoured only
 * on first insert and only for source='custom'.
 *
 * Returns the allocated (or existing) token string.
 *
 * [inv:bijective-roundtrip] — real→token is stable across appends.
 */
export function appendEntry(
  mapPath: string,
  real: string,
  type: string,
  source: Source,
  explicitToken?: string,
): string {
  // Ensure the directory exists
  fs.mkdirSync(path.dirname(mapPath), { recursive: true });

  // Build a transient mapper from the current file to enforce bijection
  const mapper = new Mapper(mapPath);

  let token: string;
  if (explicitToken && source === 'custom') {
    token = mapper.registerExplicit(real, type, explicitToken, source);
  } else {
    token = mapper.getOrCreate(real, type, source);
  }

  // The Mapper already persisted via its internal _persist(); we also do an
  // explicit flush so the file is always the canonical v2 shape with all entries.
  const doc: TokenMap = { version: 2, entries: mapper.entries() };
  atomicWrite(mapPath, doc);

  return token;
}

// ── Watch + debounce ──────────────────────────────────────────────────────────

/**
 * Watch the token-map file for changes and call `onReload` after a ~100ms
 * debounce whenever the file is written.
 *
 * Uses stdlib `fs.watch` — no new dependency. [tg-cli.3] [def:live-map]
 *
 * Returns a stop function that closes the watcher.
 */
export function watchChanges(
  mapPath: string,
  onReload: () => void,
): () => void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleReload(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      try {
        onReload();
      } catch {
        // never crash the watcher on a reload error
      }
    }, 100);
  }

  // fs.watch fires on the file directly; we also watch the directory so we
  // catch atomic rename-into-place (tmp → final) which is how the map is written.
  const dir = path.dirname(mapPath);
  const base = path.basename(mapPath);

  let watcher: fs.FSWatcher | null = null;
  let dirWatcher: fs.FSWatcher | null = null;

  try {
    // Watch the file itself (for in-place writes)
    if (fs.existsSync(mapPath)) {
      watcher = fs.watch(mapPath, (_event) => {
        scheduleReload();
      });
      watcher.on('error', () => {
        // file may have been replaced — restart file watch on next dir event
      });
    }

    // Watch the directory for rename events (atomic tmp→final replacement)
    if (fs.existsSync(dir)) {
      dirWatcher = fs.watch(dir, (_event, filename) => {
        if (filename === base || filename === base + '.tmp') {
          scheduleReload();
          // If the file was just created (watcher was null), attach file watcher
          if (watcher === null && fs.existsSync(mapPath)) {
            try {
              watcher = fs.watch(mapPath, () => scheduleReload());
              watcher.on('error', () => { watcher = null; });
            } catch {
              // ignore
            }
          }
        }
      });
      dirWatcher.on('error', () => { /* ignore */ });
    }
  } catch {
    // If watch setup fails entirely (e.g. unsupported FS), continue without reload
  }

  return function stopWatcher(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    try { watcher?.close(); } catch { /* ignore */ }
    try { dirWatcher?.close(); } catch { /* ignore */ }
  };
}

// ── Reload helper — merge new entries into an existing Mapper ─────────────────

/**
 * Reload the map file into an existing Mapper, merging any new entries.
 * Existing entries in the Mapper are never overwritten (bijection guarantee).
 * New entries from disk that the Mapper does not yet know are inserted.
 *
 * Called by the running proxy on a watchChanges signal. [def:live-map]
 */
export function reloadIntoMapper(mapPath: string, mapper: Mapper): void {
  const entries = readEntries(mapPath);
  for (const e of entries) {
    if (!e.real || !e.token) continue;
    // getOrCreate is idempotent for existing reals; for new ones it allocates —
    // but we want to preserve the exact token from disk, so use registerExplicit.
    try {
      mapper.registerExplicit(e.real, e.type ?? 'id', e.token, (e.source ?? 'custom') as Source);
    } catch {
      // token conflict or invalid source — skip silently
    }
  }
}
