#!/usr/bin/env node
/**
 * ihe1-eval.mjs  —  IHE-1 Evaluation Layer (Node.js)
 *
 * Reads IHE-1 generation output and scores each output by calling DeepSeek
 * directly as the judge (family bias caveat applies).
 *
 * Uses the same deepseekCall infrastructure as the generation layer —
 * reliable, fast, no framework overhead.
 *
 * Usage:
 *   node scripts/ihe1-eval.mjs sessions/<file>.json
 */

import { deepseekCall } from '../lib/deepseek-experiment.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TRIALS = 5;
const DIMS = ['ROLE_ADHERENCE', 'CONTENT_COVERAGE', 'FORMAT_COMPLIANCE', 'SPECIFICITY', 'NEGATION_COMPLIANCE', 'OVERALL'];
const EQUIVALENCE_DELTA = 0.5;

// ──────── Judge prompts per dimension ────────

function makeJudgePrompt(dim, instruction, output) {
  const rubrics = {
    ROLE_ADHERENCE: `
Rate 1-5 on ROLE ADHERENCE: Does the output reflect the persona described in the instruction?
5 = Perfect role/persona adherence throughout.
4 = Mostly consistent with minor generic sections.
3 = Mentions the role but reasoning is generic.
2 = Role not clearly reflected.
1 = Contradicts the assigned role.`,

    CONTENT_COVERAGE: `
Rate 1-5 on CONTENT COVERAGE: Does the output address ALL topics/constraints requested?
5 = Every requested point covered substantively.
4 = Most covered, one minor gap.
3 = Half covered, other half superficial or missing.
2 = Only a few points addressed.
1 = Ignores the instruction entirely.`,

    FORMAT_COMPLIANCE: `
Rate 1-5 on FORMAT COMPLIANCE: Does the output follow the specified format (JSON, headings, sections)?
5 = Exact format, no extra content.
4 = Mostly correct format with minor deviation.
3 = Format attempted but several errors.
2 = Some structural elements present but largely incorrect.
1 = Ignores format instructions.`,

    SPECIFICITY: `
Rate 1-5 on SPECIFICITY: Are findings concrete and artifact-specific?
5 = Specific claims referencing details from the content.
4 = Mostly specific with one vague section.
3 = Mix of specific and generic statements.
2 = Mostly generic, few specifics.
1 = Entirely generic platitudes.`,

    NEGATION_COMPLIANCE: `
Rate 1-5 on NEGATION COMPLIANCE: Does the output avoid explicitly forbidden behaviors?
5 = Zero forbidden behaviors present.
4 = Minor borderline case.
3 = One clear violation.
2 = Multiple violations.
1 = Heavily violates negations.`,

    OVERALL: `
Rate 1-5 on OVERALL quality: holistic assessment considering all relevant dimensions.
5 = Excellent, production-ready.
4 = Good, minor issues.
3 = Adequate, needs editing.
2 = Poor, significant gaps.
1 = Unusable.`,
  };

  return `
You are an impartial evaluator. Score the following output against the instruction.

INSTRUCTION:
${instruction}

OUTPUT:
${output}

${rubrics[dim] || rubrics.OVERALL}

Respond with ONLY a JSON object: {"score": N, "reason": "brief explanation"}
`.trim();
}

// ──────── Scoring ────────

async function scoreOutput(dim, instruction, output) {
  const prompt = makeJudgePrompt(dim, instruction, output);
  const resp = await deepseekCall({
    messages: [{ role: 'user', content: prompt }],
  });
  const text = resp.text.trim();
  try {
    // Extract JSON from response (handle markdown fences)
    const jsonMatch = text.match(/\{[\s\S]*"score"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return { score: parsed.score / 5, reason: parsed.reason || '' };  // normalize to 0-1
    }
    // Fallback: try to extract a number
    const numMatch = text.match(/[1-5]/);
    if (numMatch) {
      return { score: parseInt(numMatch[0]) / 5, reason: text.slice(0, 200) };
    }
    return { score: 0, reason: 'Could not parse judge response: ' + text.slice(0, 100) };
  } catch {
    return { score: 0, reason: 'Parse error: ' + text.slice(0, 100) };
  }
}

// ──────── Statistics ────────

function mean(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }
function std(arr) { const m = mean(arr); return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1)); }
function cohensD(x, y) {
  const m1 = mean(x), m2 = mean(y);
  const s1 = std(x), s2 = std(y);
  const pooled = Math.sqrt(((x.length - 1) * s1 ** 2 + (y.length - 1) * s2 ** 2) / (x.length + y.length - 2));
  return pooled === 0 ? 0 : (m1 - m2) / pooled;
}
function tost(rf, cf, delta) {
  const n = Math.min(rf.length, cf.length);
  const diff = rf.slice(0, n).map((v, i) => v - cf[i]);
  const m = mean(diff);
  const se = std(diff) / Math.sqrt(n);
  if (se === 0) return true;
  const t_lower = (m + delta) / se;
  const t_upper = (m - delta) / se;
  return t_lower > 1.96 && t_upper < -1.96;  // approximate alpha=0.05
}
function pearsonR(x, y) {
  const n = Math.min(x.length, y.length);
  const mx = mean(x), my = mean(y);
  const num = x.slice(0, n).reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0);
  const dx = Math.sqrt(x.slice(0, n).reduce((s, v) => s + (v - mx) ** 2, 0));
  const dy = Math.sqrt(y.slice(0, n).reduce((s, v) => s + (v - my) ** 2, 0));
  return dx === 0 || dy === 0 ? 0 : num / (dx * dy);
}

const SCENARIO_DIMS = {
  A: ['ROLE_ADHERENCE', 'NEGATION_COMPLIANCE', 'SPECIFICITY', 'OVERALL'],
  B: ['FORMAT_COMPLIANCE', 'CONTENT_COVERAGE', 'OVERALL'],
  C: ['CONTENT_COVERAGE', 'FORMAT_COMPLIANCE', 'SPECIFICITY', 'OVERALL'],
  D: ['ROLE_ADHERENCE', 'SPECIFICITY', 'OVERALL'],
  E: ['CONTENT_COVERAGE', 'SPECIFICITY', 'OVERALL'],
  F: ['NEGATION_COMPLIANCE', 'CONTENT_COVERAGE', 'SPECIFICITY', 'OVERALL'],
};

// ──────── Main ────────

async function main() {
  const sessionPath = process.argv[2];
  if (!sessionPath) { console.error('Usage: node scripts/ihe1-eval.mjs <session-file.json>'); process.exit(1); }

  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
  const results = session.results;

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  IHE-1 EVALUATION LAYER (Node.js)');
  console.log(`  Judge: deepseek-chat (family bias caveat — same as generator)`);
  console.log(`  Scenarios: ${results.length}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const allRf = [];
  const allCf = [];

  for (const scenario of results) {
    const sid = scenario.scenario.id;
    const dims = SCENARIO_DIMS[sid] || ['OVERALL'];
    const instruction = scenario.instruction;
    const rfScores = {};
    const cfScores = {};
    const rfTokens = [];
    const cfTokens = [];
    let cfWins = 0, rfWins = 0, ties = 0;

    console.log(`── ${sid}: ${scenario.scenario.name} (${dims.join(', ')}) ──`);

    for (let t = 0; t < scenario.trials.length; t++) {
      const trial = scenario.trials[t];
      process.stdout.write(`  Trial ${t}: `);

      // Score RF on all applicable dims
      for (const dim of dims) {
        const rf = await scoreOutput(dim, instruction, trial.rf.output);
        const cf = await scoreOutput(dim, instruction, trial.cf.output);
        if (!rfScores[dim]) rfScores[dim] = [];
        if (!cfScores[dim]) cfScores[dim] = [];
        rfScores[dim].push(rf.score);
        cfScores[dim].push(cf.score);
      }
      rfTokens.push(trial.rf.output.split(/\s+/).length);
      cfTokens.push(trial.cf.output.split(/\s+/).length);

      // Pairwise preference via OVERALL score
      const rfOverall = rfScores['OVERALL'] ? rfScores['OVERALL'][rfScores['OVERALL'].length - 1] : 0;
      const cfOverall = cfScores['OVERALL'] ? cfScores['OVERALL'][cfScores['OVERALL'].length - 1] : 0;
      if (cfOverall > rfOverall) cfWins++;
      else if (rfOverall > cfOverall) rfWins++;
      else ties++;

      process.stdout.write(`done\n`);
    }

    // Report per dimension
    for (const dim of dims) {
      const rf = rfScores[dim];
      const cf = cfScores[dim];
      if (!rf || !cf) continue;
      const muRf = mean(rf), muCf = mean(cf);
      const sdRf = std(rf), sdCf = std(cf);
      const d = cohensD(rf, cf);
      const equiv = tost(rf, cf, EQUIVALENCE_DELTA);

      // Length bias
      const allScores = [...rf, ...cf];
      const allToks = [...rfTokens, ...cfTokens];
      const r = pearsonR(allScores, allToks);

      console.log(`    ${dim}: RF μ=${muRf.toFixed(3)} σ=${sdRf.toFixed(3)}  CF μ=${muCf.toFixed(3)} σ=${sdCf.toFixed(3)}  d=${d.toFixed(3)}  TOST↔${equiv ? 'YES' : 'NO'}  len_r=${r.toFixed(3)}${Math.abs(r) > 0.3 ? ' ⚠️' : ''}`);

      allRf.push(...rf);
      allCf.push(...cf);
    }

    // Preference
    const total = cfWins + rfWins + ties;
    console.log(`    PREFERENCE: CF ${cfWins}/${total}  RF ${rfWins}/${total}  tie ${ties}/${total}`);
    console.log('');
  }

  // ──────── Aggregate ────────
  console.log('─────────────────────────────────────────────────────────');
  console.log('  AGGREGATE');
  console.log('─────────────────────────────────────────────────────────');
  const muRf = mean(allRf), muCf = mean(allCf);
  const d = cohensD(allRf, allCf);
  const equiv = tost(allRf, allCf, EQUIVALENCE_DELTA);
  console.log(`  N=${allRf.length} scores`);
  console.log(`  RF μ=${muRf.toFixed(3)}  CF μ=${muCf.toFixed(3)}  Δ=${(muRf - muCf).toFixed(3)}`);
  console.log(`  Cohen's d=${d.toFixed(3)}  TOST equivalence at Δ=${EQUIVALENCE_DELTA}: ${equiv ? '✅ YES' : '❌ NO'}`);

  // ──────── Verdict ────────
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  VERDICT');
  console.log('═══════════════════════════════════════════════════════════');
  if (equiv && Math.abs(d) < 0.5) {
    console.log('  ✅ CONTENT-FIRST INSTRUCTION-EQUIVALENT TO ROLE-FIRST');
    console.log('     TOST equivalence holds at Δ=0.5.');
    console.log('     Effect size negligible (|d| < 0.5).');
    console.log('     The thesis strictly dominates.');
  } else if (equiv) {
    console.log('  ⚠️  CONTENT-FIRST EQUIVALENT BUT LARGER EFFECT SIZE');
    console.log(`     TOST holds but d=${d.toFixed(3)} — check per-scenario details.`);
  } else {
    console.log('  ❌ CONTENT-FIRST NOT EQUIVALENT AT Δ=0.5');
    console.log('     Check per-scenario details for which dimensions fail.');
    console.log('     The thesis may have a quality trade-off.');
  }
  console.log('═══════════════════════════════════════════════════════════');
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
