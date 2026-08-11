#!/usr/bin/env node
/**
 * check-service-error-logs.mjs — deployment error-log health gate.
 *
 * Part of the deploy/live-verify process (CONTRIBUTING.md §2.2.4/§2.3). After a service deploy
 * (memory-server, tokenguard, or any sox service), run this to verify the service's error logs are
 * actually healthy — the failure mode this catches is a service that IS "running" (launchd loaded,
 * ping ok) but silently spewing errors or silently dead.
 *
 * Detection classes (all observed live on 2026-08-11):
 *   1. dyld/native-load failures — a pinned node that can no longer load its libs (doctor-tick:
 *      `Library not loaded: ...libada.3.dylib` after homebrew ada-url 3→4; the unit was dead 5 days
 *      while launchd kept "running" it every 5 min).
 *   2. Non-noise stderr lines — anything that is not a known-benign line (SSE session open/close,
 *      proxy re-dial, spawn-lock wait) and matches an error pattern (error|fail|exception|dyld|short read).
 *   3. Stale logs — the newest err log for the service is older than --max-age-min (default 10),
 *      meaning the service stopped writing (dead/crashed) despite being "loaded".
 *   4. Crash-loop — same error signature repeated N times in the tail.
 *
 * Exit code: 0 = healthy, 1 = findings (each printed with evidence), 2 = usage/IO error.
 *
 * Usage:
 *   node tools/check-service-error-logs.mjs [--service memory-server] [--logs-root ~/.adhd/sox-ecosystem/run/logs]
 *       [--max-age-min 10] [--tail 200] [--no-noise-filter] [--json]
 *
 * Service → log dir: os-user-<service>/<service>-os-*.err.log under the logs root.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
function flag(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
}
const SERVICE = flag('--service', 'memory-server');
const LOGS_ROOT = flag('--logs-root', join(os.homedir(), '.adhd', 'sox-ecosystem', 'run', 'logs'));
const MAX_AGE_MIN = Number(flag('--max-age-min', '10'));
const TAIL = Number(flag('--tail', '200'));
const JSON_OUT = args.includes('--json');
const NOISE_FILTER = !args.includes('--no-noise-filter');

// Known-benign lines. These are expected proxy/serve churn, not service faults.
const NOISE = [
  /SSE session [0-9a-f]+ (opened|closed)/,
  /backend disconnected; re-dialing/,
  /ensuring backend/,
  /another holder owns the spawn lock/,
  /adopted-after-wait/,
  /backend connected:/,
  /backend live \(pid \d+\)/,
  /spawned — spawned backend pid \d+/,
  /client pipe closed/,
  /HTTP listener on/,
  /seeded schema from/,
  /BL-65 WARNING/,
  /refused to forward \d+ host-authoritative/,
  /proxy mode \(DEFAULT for mcp-server\)/,
];

const ERROR_PATTERNS = [
  /dyld|Library not loaded|dylib/,
  /\berror\b/i,
  /\bfail(ed|ure)?\b/i,
  /\bexception\b/i,
  /short read on WAL|malformed database schema/,
  /ECONNREFUSED|EACCES|ENOENT/,
];

function newestErrLog(service) {
  const dir = join(LOGS_ROOT, `os-user-${service}`);
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.err.log'));
  } catch {
    return { dir, file: null, error: `no log dir ${dir}` };
  }
  if (files.length === 0) return { dir, file: null, error: `no .err.log files in ${dir}` };
  files.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
  return { dir, file: files[0] };
}

function main() {
  const findings = [];
  const { dir, file, error } = newestErrLog(SERVICE);
  if (error) {
    const out = { service: SERVICE, verdict: 'FINDING', findings: [{ class: 'no-log', detail: error }], log: null };
    process.stdout.write(JSON_OUT ? JSON.stringify(out, null, 2) + '\n' : `${error}\n`);
    process.exit(1);
  }
  const full = join(dir, file);
  const st = statSync(full);
  const ageMin = (Date.now() - st.mtimeMs) / 60000;
  const lines = readFileSync(full, 'utf8').split('\n').filter(Boolean);
  const tail = lines.slice(-TAIL);

  // 1. stale log
  if (ageMin > MAX_AGE_MIN) {
    findings.push({ class: 'stale-log', detail: `${file} last written ${ageMin.toFixed(1)}m ago (max ${MAX_AGE_MIN}m) — service may be dead/crashed while 'loaded'` });
  }

  // 2. non-noise error lines in the tail
  const suspects = [];
  for (const line of tail) {
    if (NOISE_FILTER && NOISE.some((re) => re.test(line))) continue;
    if (ERROR_PATTERNS.some((re) => re.test(line))) suspects.push(line.trim());
  }
  if (suspects.length > 0) {
    findings.push({ class: 'error-lines', count: suspects.length, detail: suspects.slice(0, 8).join('\n    ') });
  }

  // 3. crash-loop signature: same suspicious line repeated >= 3 in the tail
  if (suspects.length >= 3) {
    const sigCounts = {};
    for (const s of suspects) {
      const sig = s.replace(/\d+/g, '#').slice(0, 120);
      sigCounts[sig] = (sigCounts[sig] || 0) + 1;
    }
    for (const [sig, n] of Object.entries(sigCounts)) {
      if (n >= 3) findings.push({ class: 'crash-loop', count: n, detail: `repeated ${n}x: ${sig}` });
    }
  }

  const verdict = findings.length === 0 ? 'HEALTHY' : 'FINDING';
  const out = {
    service: SERVICE,
    verdict,
    log: full,
    log_bytes: st.size,
    log_age_min: +ageMin.toFixed(1),
    tail_lines: tail.length,
    findings,
  };
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    if (verdict === 'HEALTHY') {
      process.stdout.write(`HEALTHY ${SERVICE}: ${file} (${st.size}B, ${ageMin.toFixed(1)}m old), no error lines in last ${tail.length} lines\n`);
    } else {
      process.stdout.write(`FINDING ${SERVICE}: ${file}\n`);
      for (const f of findings) {
        process.stdout.write(`  [${f.class}]${f.count ? ` x${f.count}` : ''} ${f.detail}\n`);
      }
    }
  }
  process.exit(verdict === 'HEALTHY' ? 0 : 1);
}

main();
