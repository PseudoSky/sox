#!/usr/bin/env node
// research-playbooks verifier (v4) — hardened evidence-contract gate.
// Reconstructs the run from DISK + the memory read-back + the recorded tool manifest.
// It never reads prose for a pass/fail decision. Exit 0 only when every check passes.
//
// Usage: node verify-research-run.mjs <run_dir>

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const runDir = process.argv[2];
if (!runDir) {
  console.error('usage: node verify-research-run.mjs <run_dir>');
  process.exit(2);
}

const failures = [];
const fail = (m) => failures.push(m);

function readJSON(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return undefined;
  }
}

// Trim trailing prose punctuation so a citation-footer never inflates the count.
const TRAILING = /[.,;:)>"'\]]+$/;
function extractCitations(text) {
  const re = /(file:[^\s)`"']+|https?:\/\/[^\s)`"']+)/g;
  const out = new Set();
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[1].replace(TRAILING, ''));
  return out;
}

function normalizeCaps(caps) {
  if (Array.isArray(caps)) return { available: caps, absent: [] };
  if (caps && typeof caps === 'object') {
    return { available: caps.available || [], absent: caps.absent || [] };
  }
  return { available: [], absent: [] };
}

// ---- Check 1: manifest ----
const manifestPath = join(runDir, 'manifest.json');
let manifest;
if (!existsSync(manifestPath)) {
  fail('manifest.json is missing');
} else {
  manifest = readJSON(manifestPath);
  if (!manifest || typeof manifest !== 'object') {
    fail('manifest.json does not parse as a JSON object');
  } else {
    for (const k of ['run_id', 'phases', 'capabilities', 'tool_use']) {
      if (!(k in manifest)) fail(`manifest.json missing key: ${k}`);
    }
  }
}

const manifestObj = manifest && typeof manifest === 'object' ? manifest : {};
const caps = normalizeCaps(manifestObj.capabilities);
const hasMemory = caps.available.includes('memory');
const toolUse = manifestObj.tool_use || {};
const minQuestions = Number.isInteger(manifestObj.min_questions) ? manifestObj.min_questions : 1;
const minSources = Number.isInteger(manifestObj.min_sources_per_finding) ? manifestObj.min_sources_per_finding : 1;

// ---- Check 2: questions ----
const questions = readJSON(join(runDir, 'questions.json'));
if (!Array.isArray(questions)) {
  fail('questions.json is missing or is not a JSON array');
} else {
  if (questions.length < minQuestions) {
    fail(`questions.json has ${questions.length} question(s), needs >= ${minQuestions}`);
  }
  for (const q of questions) {
    if (!q || typeof q !== 'object' || !q.id) {
      fail('a question is missing its id');
      continue;
    }
    if (!['memory', 'research', 'not-research'].includes(q.resolution)) {
      fail(`${q.id}: resolution must be memory | research | not-research`);
    }
    if (!Array.isArray(q.regen_history)) {
      fail(`${q.id}: regen_history must be an array`);
    } else if (q.regen_history.length > 2) {
      fail(`${q.id}: regen_history has ${q.regen_history.length} entries (cap is 2)`);
    }
    if (q.resolution === 'memory' && (!Array.isArray(q.memory_uids) || q.memory_uids.length === 0)) {
      fail(`${q.id}: resolution "memory" requires non-empty memory_uids`);
    }
  }
}

// ---- Check 3: routing ----
const routing = readJSON(join(runDir, 'routing.json'));
const questionsArr = Array.isArray(questions) ? questions : [];
if (!routing || typeof routing !== 'object') {
  fail('routing.json is missing or is not a JSON object');
} else {
  for (const q of questionsArr) {
    if (!q || !q.id) continue;
    const target = routing[q.id];
    if (target === undefined) {
      fail(`${q.id}: no routing entry`);
      continue;
    }
    if (q.resolution === 'research') {
      const ids = Array.isArray(target) ? target : [target];
      if (ids.length === 0 || !ids.every((t) => /^P[1-7]$/.test(String(t)))) {
        fail(`${q.id}: resolution "research" must route to one or more of P1..P7, got ${JSON.stringify(target)}`);
      }
    }
    if (q.resolution === 'not-research' && !/^not-research \(.+\)$/.test(String(target))) {
      fail(`${q.id}: resolution "not-research" must be "not-research (<reason>)", got ${JSON.stringify(target)}`);
    }
    if (q.resolution === 'memory' && !/^memory( \(.+\))?$/.test(String(target))) {
      fail(`${q.id}: resolution "memory" must route to "memory (resolved in Phase 2)", got ${JSON.stringify(target)}`);
    }
  }
}

// ---- Check 4 + gather citations / uids ----
const allCitations = new Set();
const citedUids = new Set();
for (const q of questionsArr) {
  if (!q || q.resolution !== 'research' || !q.id) continue;
  const fp = join(runDir, 'findings', `${q.id}.md`);
  if (!existsSync(fp)) {
    fail(`${q.id}: findings/${q.id}.md is missing`);
    continue;
  }
  const text = readFileSync(fp, 'utf8');
  if (!text.trim()) {
    fail(`${q.id}: findings/${q.id}.md is empty`);
    continue;
  }
  const conf = /confidence:\s*(HIGH|MEDIUM|LOW)/i.exec(text);
  if (!conf) {
    fail(`${q.id}: findings/${q.id}.md has no "confidence: HIGH|MEDIUM|LOW" line`);
  }
  const cites = extractCitations(text);
  for (const c of cites) allCitations.add(c);
  if (cites.size < minSources && !/confidence:\s*LOW/i.test(text)) {
    fail(`${q.id}: ${cites.size} distinct citation(s) < min_sources_per_finding ${minSources} (and confidence is not LOW)`);
  }
  const uidRe = /memory_uid:\s*([A-Za-z0-9_:.-]+)/gi;
  let um;
  let found = false;
  while ((um = uidRe.exec(text)) !== null) {
    citedUids.add(um[1]);
    found = true;
  }
  if (hasMemory && !found) {
    fail(`${q.id}: memory capability declared but findings/${q.id}.md has no "memory_uid:" line`);
  }
}

// ---- Check 5: memory read-back coverage ----
if (hasMemory) {
  const rbPath = join(runDir, 'memory-readback.json');
  if (!existsSync(rbPath)) {
    fail('memory capability declared but memory-readback.json is missing');
  } else {
    const rb = readJSON(rbPath);
    if (!rb || typeof rb !== 'object') {
      fail('memory-readback.json does not parse as a JSON object');
    } else {
      const uidsMap = rb.uids && typeof rb.uids === 'object' ? rb.uids : {};
      const missingUids = [];
      for (const u of citedUids) {
        const entry = uidsMap[u];
        if (entry === undefined) {
          missingUids.push(`${u} (absent)`);
        } else {
          const status = String(entry && entry.status ? entry.status : entry);
          if (/blocked/i.test(status)) missingUids.push(`${u} (BLOCKED)`);
        }
      }
      if (missingUids.length) {
        fail(`memory read-back does not resolve every cited uid: ${missingUids.join(', ')}`);
      }
    }
  }
}

// ---- Check 6: trace phases ----
const tracePath = join(runDir, 'trace.md');
if (!existsSync(tracePath)) {
  fail('trace.md is missing');
} else {
  const trace = readFileSync(tracePath, 'utf8');
  for (let p = 0; p <= 7; p++) {
    if (!new RegExp(`Phase:\\s*${p}\\b`).test(trace)) fail(`trace.md has no "Phase: ${p}" declaration`);
  }
  if (!/Previous Phase completed:\s*Yes/i.test(trace)) {
    fail('trace.md has no "Previous Phase completed: Yes" declaration');
  }
}

// ---- Check 7: tool manifest vs artifacts ----
if (typeof toolUse.sources_verified !== 'number') {
  fail('manifest.tool_use.sources_verified must be a number');
} else if (toolUse.sources_verified < allCitations.size) {
  fail(`tool_use.sources_verified ${toolUse.sources_verified} < distinct citations ${allCitations.size}`);
}

// ---- Check 8: rate limits ----
if (typeof toolUse.rate_limit_events !== 'number') {
  fail('manifest.tool_use.rate_limit_events must be a number');
} else if (toolUse.rate_limit_events > 2) {
  fail(`tool_use.rate_limit_events ${toolUse.rate_limit_events} > 2`);
}

// ---- Check 9: search-term baseline ----
const researchCount = questionsArr.filter((q) => q && q.resolution === 'research').length;
if (researchCount > 0) {
  if (typeof toolUse.search_terms !== 'number') {
    fail('manifest.tool_use.search_terms must be a number when there are research questions');
  } else if (toolUse.search_terms < 3 * researchCount) {
    fail(`tool_use.search_terms ${toolUse.search_terms} < 3 x ${researchCount} research questions`);
  }
}

// ---- Check 10: tool provenance (every citation URL must match a recorded call) ----
if (researchCount > 0) {
  const calls = Array.isArray(toolUse.calls) ? toolUse.calls : null;
  if (!calls || calls.length === 0) {
    fail('manifest.tool_use.calls must be a non-empty array recording external calls');
  } else {
    const okQueries = calls
      .filter((c) => c && !/fail|error|timeout/i.test(String(c.outcome)))
      .map((c) => String(c.query === undefined ? '' : c.query));
    const urlCitations = [...allCitations].filter((c) => /^https?:\/\//.test(c));
    const unmatched = urlCitations.filter((u) => !okQueries.some((q) => q.includes(u) || u.includes(q)));
    if (unmatched.length) {
      fail(`citation URL(s) with no matching successful tool call: ${unmatched.join(', ')}`);
    }
  }
}

// ---- Verdict ----
if (failures.length) {
  console.error(`VERIFY FAIL — ${failures.length} issue(s) in ${runDir}:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`VERIFY PASS — ${runDir}`);
process.exit(0);
