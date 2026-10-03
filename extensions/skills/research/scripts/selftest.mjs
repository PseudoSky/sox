#!/usr/bin/env node
// Red/green controls for the v4 verifier. Run: node selftest.mjs
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const verifier = new URL('./verify-research-run.mjs', import.meta.url).pathname;

function fixture(findingsText, sourcesVerified) {
  const d = mkdtempSync(join(tmpdir(), 'rp-v2-'));
  mkdirSync(join(d, 'findings'));
  writeFileSync(join(d, 'manifest.json'), JSON.stringify({
    run_id: 't', phases: [0, 1, 2, 3, 4, 5, 6, 7],
    capabilities: { available: ['memory', 'search'], absent: [] },
    min_sources_per_finding: 1, min_questions: 1,
    tool_use: {
      search_terms: 9, sources_verified: sourcesVerified, rate_limit_events: 0,
      calls: [
        { capability: 'search', tool: 'fetch', query: 'https://a.example/x', outcome: 'success' },
        { capability: 'search', tool: 'fetch', query: 'https://b.example/y', outcome: 'success' },
      ],
    },
  }));
  writeFileSync(join(d, 'questions.json'), JSON.stringify([
    { id: 'q0001', question: 'x', domain: 'db-storage', resolution: 'research', regen_history: [], memory_uids: [] },
  ]));
  writeFileSync(join(d, 'routing.json'), JSON.stringify({ q0001: 'P2' }));
  writeFileSync(join(d, 'findings', 'q0001.md'), findingsText);
  writeFileSync(join(d, 'memory-readback.json'), JSON.stringify({ run_id: 't', uids: { UID1: { status: 'resolved' } } }));
  writeFileSync(join(d, 'trace.md'), [0, 1, 2, 3, 4, 5, 6, 7].map((p) => `Phase: ${p}\nPrevious Phase completed: Yes`).join('\n'));
  return d;
}
const run = (d) => {
  const r = spawnSync('node', [verifier, d], { encoding: 'utf8' });
  return { code: r.status, err: (r.stderr || r.stdout || '').trim() };
};
const check = (name, ok, code, err) => console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (exit ${code}) ${ok ? '' : err.split('\n')[0]}`);

const GOOD = 'answer\nconfidence: MEDIUM\ncitations: https://a.example/x, https://b.example/y.\nmemory_uid: UID1\n';

{ // green: valid run
  const d = fixture(GOOD, 2);
  const r = run(d);
  check('green/valid-run', r.code === 0, r.code, r.err);
}
{ // red: readback BLOCKED
  const d = fixture(GOOD, 2);
  writeFileSync(join(d, 'memory-readback.json'), JSON.stringify({ run_id: 't', uids: { UID1: { status: 'BLOCKED' } } }));
  const r = run(d);
  check('red/blocked-readback', r.code === 1, r.code, r.err);
}
{ // red: memory available but no memory_uid line
  const d = fixture('answer\nconfidence: MEDIUM\ncitations: https://a.example/x\n', 1);
  const r = run(d);
  check('red/missing-memory_uid', r.code === 1, r.code, r.err);
}
{ // green: trailing-punctuation trim — same URL bare + with comma counts once; sources_verified=1 passes
  const f = 'answer\nconfidence: MEDIUM\ncitations: https://a.example/x (see also https://a.example/x,)\nmemory_uid: UID1\n';
  const d = fixture(f, 1);
  const r = run(d);
  check('green/citation-trim', r.code === 0, r.code, r.err);
}
{ // red: under-count declared
  const d = fixture(GOOD, 1);
  const r = run(d);
  check('red/source-undercount', r.code === 1, r.code, r.err);
}
{ // green: a Phase-2 context uid (memory_uids) need NOT appear in the read-back (gap-2 fix)
  const d = fixture(GOOD, 2);
  writeFileSync(join(d, 'questions.json'), JSON.stringify([
    { id: 'q0001', question: 'x', domain: 'db-storage', resolution: 'research', regen_history: [], memory_uids: ['FOREIGN_UID'] },
  ]));
  const r = run(d);
  check('green/foreign-uid-ignored', r.code === 0, r.code, r.err);
}
{ // red: resolution "memory" with no episode uid (gap-4 fix)
  const d = fixture(GOOD, 2);
  const qs = JSON.parse(readFileSync(join(d, 'questions.json'), 'utf8'));
  qs.push({ id: 'q0002', question: 'y', domain: 'db-storage', resolution: 'memory', regen_history: [], memory_uids: [] });
  writeFileSync(join(d, 'questions.json'), JSON.stringify(qs));
  const rt = JSON.parse(readFileSync(join(d, 'routing.json'), 'utf8'));
  rt.q0002 = 'memory (resolved in Phase 2)';
  writeFileSync(join(d, 'routing.json'), JSON.stringify(rt));
  const r = run(d);
  check('red/memory-needs-uid', r.code === 1, r.code, r.err);
}
{ // red: a citation URL with no matching successful tool call (provenance)
  const d = fixture('answer\nconfidence: MEDIUM\ncitations: https://unrecorded.example/z\nmemory_uid: UID1\n', 1);
  const r = run(d);
  check('red/citation-not-called', r.code === 1, r.code, r.err);
}

// re-read to prove the fixture file itself parses
console.log('manifest parses:', !!JSON.parse(readFileSync(join(fixture(GOOD, 2), 'manifest.json'), 'utf8')));
