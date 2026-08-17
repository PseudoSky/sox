#!/usr/bin/env node
/**
 * backlog-verify-durable.mjs — prove a backlog item actually PERSISTED.
 *
 * WHY THIS EXISTS
 *
 * On 2026-08-15 roughly 15 backlog items were filed. Every `create-item` returned
 * success JSON with an allocated nodeId. Several were then verified with
 * `backlog get-item`, which returned full item bodies. None of them exist.
 *
 * The store holds 2,348 nodes; the allocated nodeIds ran to 2,358 — IDs minted
 * past the row count. The writes executed and the rows never landed
 * (BUG-BACKLOG-PHANTOM-WRITES-ACKED-NOT-DURABLE-001). Mechanism: uncheckpointed
 * WAL frames discarded by a later stale-tshm reconciliation, the class BL-512
 * documents as "created:true but row never persisted".
 *
 * THE TRAP THIS TOOL EXISTS TO CLOSE
 *
 * AGENTS.md mandates "Verify each write landed with backlog_get_item — a create
 * call reporting success is not proof it wrote." That discipline WAS followed
 * during the incident. It passed. The data was already doomed.
 *
 * A read issued from the SAME PROCESS is served out of that process's own
 * uncheckpointed WAL. It returns the row faithfully. It cannot distinguish
 * committed from uncommitted. The mandated check is structurally incapable of
 * detecting the failure it exists to catch — it returns a confident PASS for
 * data that will never exist.
 *
 * WHAT AN HONEST DURABILITY CHECK REQUIRES
 *
 *   1. Read back from a SEPARATE PROCESS, not the writing one.
 *   2. Confirm the write is not sitting unflushed in the WAL.
 *   3. Report UNKNOWN rather than PASS when neither can be established.
 *
 * This tool does all three and refuses to answer "durable" unless both hold.
 *
 * USAGE
 *   node tools/backlog-verify-durable.mjs --repo <repo> --human-id <ID> [--json]
 *   node tools/backlog-verify-durable.mjs --repo <repo> --human-id <ID> --wait-ms 2000
 *
 * EXIT CODES  (deliberately three-valued, mirroring plan-status.mjs)
 *   0  DURABLE      — found from a separate process AND not pending in the WAL
 *   1  NOT FOUND    — the item does not exist; a preceding "success" was phantom
 *   2  UNKNOWN      — cannot establish durability (store unreachable, WAL unreadable)
 *
 * Exit 2 is NOT a pass. Treat it exactly as you would treat exit 1 when deciding
 * whether to trust a write — the whole point is that "could not check" and
 * "verified fine" must never render the same, which is the failure shape that
 * produced this incident and three others catalogued the same week.
 */
import { execFileSync } from 'node:child_process';
import { statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_STORE = join(homedir(), '.adhd', 'backlog', 'production', 'data', 'backlog.db');

/** execFileSync defaults to a 1MB maxBuffer; the sox-ecosystem item list is
 *  already ~1.9MB and silently threw ENOBUFS, which a bare catch rendered as
 *  "repo has no items" (see tools/scorecard.mjs's own maxBuffer incident).
 *  Never let this number be the reason a verification lies. */
const MAX_BUFFER = 64 * 1024 * 1024;

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

/**
 * Read the item by spawning a FRESH `backlog` process.
 *
 * The separateness is the entire point: this process has never opened the store,
 * so it cannot be served from an in-process uncheckpointed WAL. If the row comes
 * back here, some other process's write reached shared storage.
 */
function readFromSeparateProcess(repo, humanId) {
  try {
    const out = execFileSync('backlog', ['get-item', '--repo', repo, '--human-id', humanId], {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const line of out.split('\n')) {
      try {
        const j = JSON.parse(line);
        if (j && j.humanId === humanId) return { found: true, nodeId: j.nodeId ?? null };
      } catch {
        /* non-JSON log lines are expected on this CLI's stdout; keep scanning */
      }
    }
    return { found: false };
  } catch (err) {
    // exit 134 is the SIGABRT/btree-panic signature seen during the 2026-08-17
    // corruption. That is emphatically not "item absent" — it is "cannot answer".
    const code = err?.status ?? null;
    return { found: false, unreachable: true, detail: `exit ${code}: ${String(err?.message ?? err).slice(0, 160)}` };
  }
}

/**
 * A non-trivial WAL means committed frames may not yet be in the main database.
 * That is exactly the window in which a stale-tshm reconciliation discarded the
 * lost writes. Size alone cannot prove a SPECIFIC row is unflushed, so this is
 * reported as a caveat that downgrades DURABLE to UNKNOWN — never as a pass.
 */
function walState(storePath) {
  const wal = `${storePath}-wal`;
  if (!existsSync(storePath)) return { known: false, reason: `store not found at ${storePath}` };
  if (!existsSync(wal)) return { known: true, bytes: 0, pending: false };
  try {
    const bytes = statSync(wal).size;
    // A bare WAL header (~32 bytes) carries no frames.
    return { known: true, bytes, pending: bytes > 4096 };
  } catch (err) {
    return { known: false, reason: String(err?.message ?? err).slice(0, 160) };
  }
}

function main() {
  const repo = arg('repo');
  const humanId = arg('human-id') ?? arg('humanId');
  const storePath = arg('store', DEFAULT_STORE);
  const waitMs = Number(arg('wait-ms', '0')) || 0;
  const asJson = hasFlag('json');

  if (!repo || !humanId) {
    console.error('usage: backlog-verify-durable.mjs --repo <repo> --human-id <ID> [--store <path>] [--wait-ms N] [--json]');
    process.exit(2);
  }

  if (waitMs > 0) {
    // Give a checkpoint a chance to land before judging. Deliberately opt-in:
    // silently sleeping would make the tool look more reliable than it is.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
  }

  const before = walState(storePath);
  const read = readFromSeparateProcess(repo, humanId);
  const after = walState(storePath);

  let verdict, exit, reason;
  if (read.unreachable) {
    verdict = 'UNKNOWN';
    exit = 2;
    reason = `store unreachable from a fresh process — ${read.detail}`;
  } else if (!read.found) {
    verdict = 'NOT_FOUND';
    exit = 1;
    reason = 'item absent when read from a separate process — any preceding success response was a PHANTOM WRITE';
  } else if (!after.known) {
    verdict = 'UNKNOWN';
    exit = 2;
    reason = `item read back, but WAL state unknown (${after.reason}) — cannot rule out an unflushed write`;
  } else if (after.pending) {
    verdict = 'UNKNOWN';
    exit = 2;
    reason = `item read back, but the WAL holds ${after.bytes} bytes of possibly-uncheckpointed frames — durability NOT established. Re-run after a checkpoint.`;
  } else {
    verdict = 'DURABLE';
    exit = 0;
    reason = `read from a separate process and the WAL is empty (${after.bytes} bytes) — the row is in shared storage`;
  }

  const result = {
    verdict,
    repo,
    humanId,
    nodeId: read.nodeId ?? null,
    wal_bytes_before: before.bytes ?? null,
    wal_bytes_after: after.bytes ?? null,
    reason,
  };

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const mark = verdict === 'DURABLE' ? '✓' : verdict === 'NOT_FOUND' ? '✗' : '⚠';
    console.log(`${mark} ${verdict} — ${repo}/${humanId}`);
    console.log(`  ${reason}`);
    if (verdict !== 'DURABLE') {
      console.log('  NOTE: this is not a pass. "Could not check" and "verified fine" must never be');
      console.log('        treated the same — that equivalence is what lost ~15 items on 2026-08-15.');
    }
  }
  process.exit(exit);
}

main();
