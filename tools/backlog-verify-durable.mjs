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
 * EXIT CODES  (three-valued, mirroring plan-status.mjs)
 *   0  DURABLE      — found from a separate process, WAL empty: the row is in
 *                     the main database
 *   0  COMMITTED    — found from a separate process; frames are in the shared
 *                     WAL with a healthy sidecar. The write has landed. The WAL
 *                     file stays non-empty because TRUNCATE is quiescence-gated
 *                     and defers while peers hold the store — the NORMAL steady
 *                     state of a busy store, not a fault.
 *   1  NOT_FOUND    — the item does not exist; a preceding "success" was phantom
 *   2  AT_RISK      — found, but frames are outstanding while the -tshm sidecar
 *                     is stale past the store's own threshold: the exact
 *                     reconciliation window in which acked writes were discarded
 *   2  UNKNOWN      — cannot establish anything (store unreachable, WAL unreadable)
 *
 * A non-zero exit is NOT a pass. "Could not check" and "verified fine" must
 * never render the same — that equivalence is the failure shape that produced
 * this incident and three others catalogued the same week.
 *
 * But the converse trap is just as real, and this tool fell into it (BL-570):
 * it originally treated ANY non-empty WAL as "durability not established", so
 * on a live multi-peer store it reported UNKNOWN forever and told the caller to
 * "re-run after a checkpoint" — something the caller had no way to cause. A
 * check that can never pass in normal operation is not conservative, it is
 * noise, and noise gets ignored. That is exactly how the previously-mandated
 * verification came to be trusted while being incapable of catching anything.
 * Under-reporting is the safe direction only while the report stays actionable.
 *
 * NOTE: everything here is `stat`-only. This tool never opens the database.
 * Open frequency is what distinguishes the corrupted backlog store from the
 * never-corrupted memory store, so a verifier that opened the store to check on
 * it would be adding the very risk it exists to detect.
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

/** The store's own sidecar-staleness threshold (BL-373/BUG-021). */
const TSHM_SKEW_THRESHOLD_MS = 60_000;

/**
 * Inspect WAL state WITHOUT OPENING THE STORE.
 *
 * Every additional open of this store is another roll of the dice against an
 * unfixed upstream Turso bug — that open frequency, not any single defect, is
 * what distinguishes the corrupted backlog store from the never-corrupted
 * memory store. A verifier that opened the database to check on it would be
 * adding the very risk it exists to detect, so everything here is `stat` only.
 *
 * WHY RAW WAL SIZE IS THE WRONG SIGNAL (BL-570)
 *
 * This function used to report `pending: bytes > 4096` and let that downgrade
 * DURABLE to UNKNOWN. That conflates two different guarantees:
 *
 *   - PASSIVE checkpoint copies committed frames into the main database. It
 *     needs no exclusivity and the adapter now runs it INLINE on every write
 *     past the WAL cap, so it cannot be starved. This is what makes data
 *     durable.
 *   - TRUNCATE reclaims the WAL FILE. It requires quiescence and is gated, so
 *     with live peers it may legitimately defer forever. This is what makes
 *     the file small.
 *
 * A busy store with several live peers therefore sits at a non-zero WAL
 * indefinitely while being perfectly durable. Judging durability by file size
 * made this tool report UNKNOWN forever, with the unactionable advice to
 * "re-run after a checkpoint" that the caller had no way to cause. A check that
 * can never pass in normal operation is not conservative — it is noise, and it
 * gets ignored. That is precisely how the previously-mandated verification came
 * to be trusted while being structurally incapable of catching the failure it
 * existed to catch. Under-reporting is only the safe direction while the report
 * stays actionable.
 *
 * THE SIGNAL THAT ACTUALLY MATTERS
 *
 * The writes were lost to a stale-`-tshm` reconciliation discarding frames the
 * shared WAL still held. That condition is directly observable: the WAL-index
 * sidecar's mtime falling behind the WAL's own. The store itself already emits
 * it as `store.integrity.sidecar_stale` against a 60s threshold. Skew, not
 * size, is the danger indicator.
 */
function walState(storePath) {
  const wal = `${storePath}-wal`;
  const tshm = `${storePath}-tshm`;
  if (!existsSync(storePath)) return { known: false, reason: `store not found at ${storePath}` };
  if (!existsSync(wal)) return { known: true, bytes: 0, frames: false, skewMs: 0, stale: false };
  try {
    const walStat = statSync(wal);
    const bytes = walStat.size;
    // A bare WAL header (~32 bytes, padded) carries no frames.
    const frames = bytes > 4096;

    // No sidecar means no reconciliation can be mid-flight against a stale one.
    if (!frames || !existsSync(tshm)) {
      return { known: true, bytes, frames, skewMs: 0, stale: false };
    }

    const skewMs = walStat.mtimeMs - statSync(tshm).mtimeMs;
    return { known: true, bytes, frames, skewMs, stale: skewMs > TSHM_SKEW_THRESHOLD_MS };
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
  } else if (after.stale) {
    // The one genuinely dangerous state: frames outstanding AND the sidecar
    // lagging past the store's own staleness threshold — the shape of the
    // reconciliation that discarded the lost writes.
    verdict = 'AT_RISK';
    exit = 2;
    reason =
      `item read back, but the WAL holds ${after.bytes} bytes of frames while the -tshm sidecar is ` +
      `${Math.round(after.skewMs / 1000)}s stale (threshold ${TSHM_SKEW_THRESHOLD_MS / 1000}s) — ` +
      `this is the stale-sidecar reconciliation window in which acked writes have been discarded. Do NOT trust this write.`;
  } else if (after.frames) {
    // Committed, cross-process visible, sidecar healthy. The frames live in the
    // shared WAL rather than the main database — which is the NORMAL steady
    // state of a busy store, because TRUNCATE is quiescence-gated and defers
    // while peers are live. The write has landed.
    verdict = 'COMMITTED';
    exit = 0;
    reason =
      `read from a separate process; ${after.bytes} bytes of frames are in the shared WAL with a healthy ` +
      `sidecar (skew ${Math.round(after.skewMs / 1000)}s) — the write is committed and cross-process visible. ` +
      `The WAL file stays non-empty because TRUNCATE is quiescence-gated and defers while peers hold the store; ` +
      `that is expected, not a fault.`;
  } else {
    verdict = 'DURABLE';
    exit = 0;
    reason = `read from a separate process and the WAL is empty (${after.bytes} bytes) — the row is in the main database`;
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
