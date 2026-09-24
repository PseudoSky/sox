/**
 * scripts/lib/isolation-guard.mjs — BL-173 live data-root isolation guard, with
 * change ATTRIBUTION (backlog d5c01be3).
 *
 * The smoke harness (scripts/smoke-test.mjs) redirects every child it spawns to
 * a scratch data root (SOX_ECOSYSTEM_HOME) and then asserts the LIVE data root
 * (~/.adhd/sox-ecosystem) was not written. The original assertion compared
 * whole-file shasums of four files and declared a FATAL breach on ANY
 * difference — so a concurrent, unrelated OPERATOR `soxe install <id>` from
 * another session (the 2026-09-24 incident: `soxe install backlog-operator
 * --host claude --scope user`, pid 36115, 21:03:11Z) was indistinguishable from
 * a smoke leak.
 *
 * This module decides, entry by entry, who made each change:
 *
 *   (a) On a byte mismatch, the four files are PARSED and diffed per entry
 *       (ledger entries, ownership records, install-registry records, lockfile
 *       `resolved` keys); every changed entry is printed with its id / host /
 *       scope / timestamps.
 *   (b′) The run is downgraded to a non-fatal WARNING only when EVERY changed
 *       entry is explained by an operator `cli_invoked` event (role ≠ harness)
 *       in the LIVE telemetry logs inside the run window, whose mutating verb
 *       AND target name that entry's extension id (or the bundle it belongs
 *       to). An entry for an id the smoke run itself touched is FATAL even if
 *       an operator event names it; an entry no event explains is FATAL.
 *   (b″) The scratch logs are scanned too (their harness `cli_invoked` targets
 *       join the smoke-touched set), and ANY role=harness event in the LIVE
 *       logs inside the run window is FATAL — a harness process wrote telemetry
 *       to the live root, which is itself a redirection leak.
 *
 * Anything the guard cannot attribute fails CLOSED: unparseable JSON, a changed
 * top-level field, bytes that changed with no entry-level difference, and
 * operator events that carry no `target` (a pre-d5c01be3 `soxe` dist).
 *
 * Node built-ins only — importable by the tier-1 guard test
 * tools/test-d5c01be3-isolation-attribution.mjs without any build.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Live data-root files the guard fingerprints and diffs. */
export const GUARDED_FILES = Object.freeze([
  'extensions.lock',
  'install-registry.json',
  'ledger.json',
  'ownership.json',
]);

/**
 * Verbs that can write the guarded files, i.e. the only verbs whose event may
 * explain a change. A read-only verb (`details`, `list`, `status`, …) naming
 * the same id explains nothing.
 */
export const MUTATING_VERBS = Object.freeze(new Set([
  'install',
  'uninstall',
  'update',
  'upgrade',
  'enable',
  'disable',
  'service',
]));

/** How far before the BEFORE snapshot an operator event may start and still explain a later write. */
export const DEFAULT_OPERATOR_SLACK_MS = 5 * 60_000;

// ──────────────────────────────────────────────────────────────────────────────
// Snapshots (fs)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Read every guarded file under `root`.
 * @param {string} root
 * @param {{ now?: () => number }} [opts]
 * @returns {{ root: string, takenAtMs: number, files: Record<string, { present: boolean, sha256: string|null, raw: string|null, error?: string }> }}
 */
export function snapshotLiveFiles(root, opts = {}) {
  const now = opts.now ?? Date.now;
  const files = {};
  for (const name of GUARDED_FILES) {
    const p = path.join(root, name);
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      files[name] = { present: true, sha256: crypto.createHash('sha256').update(raw).digest('hex'), raw };
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        files[name] = { present: false, sha256: null, raw: null };
      } else {
        // Unreadable is not "absent": record it so the diff fails closed on it.
        console.error(`[smoke] isolation-guard: could not read ${p}: ${(e && e.message) ?? e}`);
        files[name] = { present: true, sha256: `UNREADABLE:${(e && e.code) ?? 'error'}`, raw: null, error: String((e && e.message) ?? e) };
      }
    }
  }
  return { root, takenAtMs: now(), files };
}

// ──────────────────────────────────────────────────────────────────────────────
// Entry extraction (pure)
// ──────────────────────────────────────────────────────────────────────────────

/** Strip a legacy `@version` suffix from a key, never splitting a leading scope `@`. */
export function bareId(key) {
  if (typeof key !== 'string') return null;
  const at = key.lastIndexOf('@');
  return at > 0 ? key.slice(0, at) : key;
}

/**
 * Per-file schema: where the entry collection lives, how an entry is keyed, and
 * which fields identify it. Shapes from libs/install-engine/src/{install,
 * install-registry,ledger,ownership}.ts.
 */
const SCHEMAS = {
  'extensions.lock': {
    collection: 'resolved',
    entries: (doc) => Object.entries(doc.resolved ?? {}).map(([k, v]) => ({
      key: k, id: bareId(k), bundleId: v?.bundle_id ?? null, host: null, scope: null,
      timestamps: { resolved_at: v?.resolved_at ?? null }, value: v,
    })),
    formatKeys: ['lockfileVersion'],
  },
  'install-registry.json': {
    collection: 'installs',
    entries: (doc) => (Array.isArray(doc.installs) ? doc.installs : []).map((r) => ({
      key: `${r?.extId}|${r?.scope}|${r?.root}`, id: bareId(r?.extId), bundleId: null, host: null, scope: r?.scope ?? null,
      timestamps: { installedAt: r?.installedAt ?? null, updatedAt: r?.updatedAt ?? null }, value: r,
    })),
    formatKeys: ['version'],
  },
  'ledger.json': {
    collection: 'entries',
    entries: (doc) => (Array.isArray(doc.entries) ? doc.entries : []).map((e) => ({
      key: `${e?.ext}|${e?.host}|${e?.scope}`, id: bareId(e?.ext), bundleId: null, host: e?.host ?? null, scope: e?.scope ?? null,
      timestamps: { installedAt: e?.installedAt ?? null }, value: e,
    })),
    formatKeys: ['version'],
  },
  'ownership.json': {
    collection: 'owned',
    entries: (doc) => (Array.isArray(doc.owned) ? doc.owned : []).map((o) => ({
      key: `${o?.extId}|${o?.scope}`, id: bareId(o?.extId), bundleId: o?.bundleId ?? null, host: o?.host ?? null, scope: o?.scope ?? null,
      timestamps: { installedAt: o?.installedAt ?? null, updatedAt: o?.updatedAt ?? null }, value: o,
    })),
    formatKeys: ['version'],
  },
};

function parseDoc(fileSnap) {
  if (!fileSnap || !fileSnap.present) return { ok: true, doc: null };
  if (fileSnap.raw === null) return { ok: false, error: fileSnap.error ?? 'unreadable' };
  try {
    const doc = JSON.parse(fileSnap.raw);
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, error: 'top-level JSON is not an object' };
    return { ok: true, doc };
  } catch (e) {
    return { ok: false, error: `JSON parse failed: ${(e && e.message) ?? e}` };
  }
}

/**
 * Diff two snapshots entry by entry.
 * @returns {{ changedFiles: string[], changes: Array<object> }}
 *   Each change: { file, op: 'added'|'removed'|'modified'|'top-level'|'unparseable'|'bytes-only', key, id, bundleId, host, scope, before, after }
 *   `id === null` marks a change no event can ever explain.
 */
export function diffLiveEntries(before, after) {
  const changedFiles = [];
  const changes = [];
  for (const file of GUARDED_FILES) {
    const b = before.files[file];
    const a = after.files[file];
    if ((b?.sha256 ?? null) === (a?.sha256 ?? null)) continue;
    changedFiles.push(file);
    const pb = parseDoc(b);
    const pa = parseDoc(a);
    if (!pb.ok || !pa.ok) {
      changes.push({ file, op: 'unparseable', key: null, id: null, bundleId: null, host: null, scope: null,
        before: pb.ok ? null : pb.error, after: pa.ok ? null : pa.error });
      continue;
    }
    const schema = SCHEMAS[file];
    const docB = pb.doc ?? {};
    const docA = pa.doc ?? {};
    const fileChanges = [];

    // Top-level fields other than the entry collection.
    for (const k of new Set([...Object.keys(docB), ...Object.keys(docA)])) {
      if (k === schema.collection) continue;
      // A file coming into / going out of existence carries its format marker with it — that
      // alone is not an unattributable change; its entries are still attributed individually.
      if ((pb.doc === null || pa.doc === null) && schema.formatKeys.includes(k)) continue;
      if (JSON.stringify(docB[k]) !== JSON.stringify(docA[k])) {
        fileChanges.push({ file, op: 'top-level', key: k, id: null, bundleId: null, host: null, scope: null,
          before: docB[k] ?? null, after: docA[k] ?? null });
      }
    }

    const mapB = new Map(schema.entries(docB).map((e) => [e.key, e]));
    const mapA = new Map(schema.entries(docA).map((e) => [e.key, e]));
    for (const key of new Set([...mapB.keys(), ...mapA.keys()])) {
      const eb = mapB.get(key);
      const ea = mapA.get(key);
      let op = null;
      if (!eb) op = 'added';
      else if (!ea) op = 'removed';
      else if (JSON.stringify(eb.value) !== JSON.stringify(ea.value)) op = 'modified';
      if (!op) continue;
      const ref = ea ?? eb;
      fileChanges.push({ file, op, key, id: ref.id, bundleId: ea?.bundleId ?? eb?.bundleId ?? null,
        host: ref.host, scope: ref.scope,
        before: eb ? eb.timestamps : null, after: ea ? ea.timestamps : null });
    }

    if (fileChanges.length === 0) {
      // Bytes moved but nothing we can attribute did — fail closed rather than
      // letting "every entry explained" pass vacuously over zero entries.
      fileChanges.push({ file, op: 'bytes-only', key: null, id: null, bundleId: null, host: null, scope: null,
        before: b?.sha256 ?? null, after: a?.sha256 ?? null });
    }
    changes.push(...fileChanges);
  }
  return { changedFiles, changes };
}

/** memberId → Set(bundleId), from lockfile `bundle_id` and ownership `bundleId` in either snapshot. */
export function bundleMembership(...snapshots) {
  const m = new Map();
  const add = (id, bid) => {
    if (!id || !bid) return;
    if (!m.has(id)) m.set(id, new Set());
    m.get(id).add(bid);
  };
  for (const snap of snapshots) {
    for (const file of ['extensions.lock', 'ownership.json']) {
      const p = parseDoc(snap.files[file]);
      if (!p.ok || !p.doc) continue;
      for (const e of SCHEMAS[file].entries(p.doc)) add(e.id, e.bundleId);
    }
  }
  return m;
}

// ──────────────────────────────────────────────────────────────────────────────
// Telemetry logs (fs)
// ──────────────────────────────────────────────────────────────────────────────

/** Every `<root>/<service>/logs` directory that exists. */
export function telemetryLogDirs(root) {
  let services;
  try {
    services = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    console.error(`[smoke] isolation-guard: cannot list ${root}: ${(e && e.message) ?? e}`);
    return [];
  }
  return services
    .filter((d) => d.isDirectory())
    .map((d) => path.join(root, d.name, 'logs'))
    .filter((p) => fs.existsSync(p));
}

/**
 * Read telemetry JSONL events whose `ts` lies in [sinceMs, untilMs] from every
 * `*.jsonl` in `dirs` modified at/after `sinceMs`.
 * @returns {{ events: Array<object>, parseErrors: number, filesRead: string[] }}
 */
export function readTelemetryEvents(dirs, { sinceMs, untilMs }) {
  const events = [];
  const filesRead = [];
  let parseErrors = 0;
  for (const dir of dirs) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      console.error(`[smoke] isolation-guard: cannot list ${dir}: ${(e && e.message) ?? e}`);
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const p = path.join(dir, name);
      let st;
      try { st = fs.statSync(p); } catch (e) {
        console.error(`[smoke] isolation-guard: cannot stat ${p}: ${(e && e.message) ?? e}`);
        continue;
      }
      if (st.mtimeMs < sinceMs) continue;
      let text;
      try { text = fs.readFileSync(p, 'utf-8'); } catch (e) {
        console.error(`[smoke] isolation-guard: cannot read ${p}: ${(e && e.message) ?? e}`);
        continue;
      }
      filesRead.push(p);
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        let ev;
        try { ev = JSON.parse(line); } catch {
          parseErrors++; // counted and reported by the caller — a torn tail line is normal for a live sink
          continue;
        }
        const t = Date.parse(ev?.ts ?? '');
        if (!Number.isFinite(t) || t < sinceMs || t > untilMs) continue;
        events.push({ ...ev, _file: p, _tsMs: t });
      }
    }
  }
  return { events, parseErrors, filesRead };
}

// ──────────────────────────────────────────────────────────────────────────────
// Attribution (pure)
// ──────────────────────────────────────────────────────────────────────────────

function describeEvent(ev) {
  const parts = [`pid=${ev.pid ?? '?'}`, `role=${ev.role ?? '?'}`, `verb=${ev.verb ?? '?'}`];
  if (ev.subverb) parts.push(`subverb=${ev.subverb}`);
  parts.push(`target=${ev.target ?? '(none)'}`);
  if (ev.host) parts.push(`host=${ev.host}`);
  if (ev.scope) parts.push(`scope=${ev.scope}`);
  parts.push(`ts=${ev.ts}`);
  return parts.join(' ');
}

function describeChange(c) {
  const ts = (o) => (o && typeof o === 'object' ? Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(',') : String(o ?? '-'));
  return `${c.file} ${c.op} ${c.key ?? '-'} id=${c.id ?? '-'}` +
    `${c.bundleId ? ` bundle=${c.bundleId}` : ''} host=${c.host ?? '-'} scope=${c.scope ?? '-'}` +
    ` before[${ts(c.before)}] after[${ts(c.after)}]`;
}

/**
 * Decide the isolation verdict.
 *
 * @param {object} input
 * @param {ReturnType<typeof snapshotLiveFiles>} input.before  live snapshot taken right before the first smoke-spawned soxe
 * @param {ReturnType<typeof snapshotLiveFiles>} input.after   live snapshot taken after teardown
 * @param {Array<object>} input.liveEvents     telemetry events from the LIVE root's logs (already window-filtered with slack)
 * @param {Array<object>} [input.scratchEvents] telemetry events from the SCRATCH root's logs
 * @param {Iterable<string>} input.smokeTouchedIds  extension/bundle ids the smoke run spawned soxe against
 * @param {number} [input.operatorSlackMs]
 * @returns {{ verdict: 'ok'|'warning'|'fatal', lines: string[], changes: Array<object>, harnessLeaks: Array<object> }}
 */
export function evaluateIsolation(input) {
  const { before, after } = input;
  const liveEvents = input.liveEvents ?? [];
  const scratchEvents = input.scratchEvents ?? [];
  const slack = input.operatorSlackMs ?? DEFAULT_OPERATOR_SLACK_MS;
  const t0 = before.takenAtMs;
  const t1 = after.takenAtMs;
  const lines = [];
  let fatal = false;

  // (b″) scratch harness targets are smoke-touched too.
  const touched = new Set(input.smokeTouchedIds ?? []);
  for (const ev of scratchEvents) {
    if (ev.event === 'cli_invoked' && ev.role === 'harness' && ev.target) touched.add(ev.target);
  }

  // (b″) any harness event in the LIVE logs inside the strict run window is a redirection leak.
  const harnessLeaks = liveEvents.filter((ev) => ev.role === 'harness' && ev._tsMs >= t0 && ev._tsMs <= t1);
  for (const ev of harnessLeaks) {
    lines.push(`ISOLATION FAILURE: role=harness telemetry landed in the LIVE data root during the run: event=${ev.event} ${describeEvent(ev)} file=${ev._file}`);
    fatal = true;
  }

  const { changedFiles, changes } = diffLiveEntries(before, after);
  if (changes.length === 0) {
    if (!fatal) lines.push('isolation OK — live data-root files byte-identical before/after');
    return { verdict: fatal ? 'fatal' : 'ok', lines, changes, harnessLeaks };
  }

  lines.push(`live data-root changed during the run (${changedFiles.join(', ')}); attributing ${changes.length} entry change(s):`);
  const membership = bundleMembership(before, after);
  const operatorEvents = liveEvents.filter((ev) =>
    ev.event === 'cli_invoked' && ev.role !== 'harness' && MUTATING_VERBS.has(ev.verb) &&
    ev._tsMs >= t0 - slack && ev._tsMs <= t1);

  let unexplained = 0;
  for (const c of changes) {
    lines.push(`  ${describeChange(c)}`);
    if (c.id === null) {
      lines.push(`    → UNEXPLAINED: ${c.op} change cannot be attributed to any single extension (fail closed)`);
      unexplained++;
      continue;
    }
    const owners = new Set([c.id, ...(membership.get(c.id) ?? []), ...(c.bundleId ? [c.bundleId] : [])]);
    const touchedHit = [...owners].find((o) => touched.has(o));
    if (touchedHit) {
      lines.push(`    → SMOKE-TOUCHED: the smoke run itself acted on ${touchedHit}; a live change to it is a leak regardless of any operator event`);
      unexplained++;
      continue;
    }
    const explainer = operatorEvents.find((ev) =>
      typeof ev.target === 'string' && owners.has(ev.target) &&
      (ev.scope == null || c.scope == null || ev.scope === c.scope) &&
      (ev.host == null || c.host == null || ev.host === c.host));
    if (explainer) {
      lines.push(`    → explained by operator ${describeEvent(explainer)}`);
      continue;
    }
    const namesIt = liveEvents.find((ev) => ev.event === 'cli_invoked' && ev.role !== 'harness' && typeof ev.target === 'string' && owners.has(ev.target));
    const untargeted = operatorEvents.filter((ev) => ev.target == null);
    let why = 'no operator cli_invoked event in the live log names this extension';
    if (namesIt) why = `closest event does not qualify (${describeEvent(namesIt)}) — wrong verb/scope/host or outside the run window`;
    else if (untargeted.length > 0) why += ` (${untargeted.length} mutating operator event(s) carry no target — e.g. \`upgrade --all\` or a pre-d5c01be3 soxe dist — and cannot explain a specific entry)`;
    lines.push(`    → UNEXPLAINED: ${why}`);
    unexplained++;
  }

  if (unexplained > 0) {
    fatal = true;
    lines.push(`ISOLATION FAILURE: ${unexplained} of ${changes.length} live entry change(s) are not explained by a concurrent operator invocation`);
  } else if (!fatal) {
    lines.push(`WARNING: live data-root changed during the run, but every change is explained by a concurrent OPERATOR invocation (not a smoke leak) — ${changes.length} entry change(s)`);
  }
  return { verdict: fatal ? 'fatal' : 'warning', lines, changes, harnessLeaks };
}
