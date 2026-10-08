// Code-based grader (no LLM judge: avoids self-preference bias, agent-manager 7.4).
// 2f81569f T11.AC3
export const GRADER_VERSION = 2; // bump on any grading change; results.json records it and the AC3 test checks it
export const READ_ONLY_LINE = 'read-only: cannot edit or run';

export function grade(output, exp) {
  const text = String(output ?? '');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const reasons = [];
  const check = (ok, why) => { if (!ok) reasons.push(why); };

  if (exp.refused) {
    // exclusive: the REFUSED line is the whole output
    check(lines.length === 1 && /^REFUSED: \S/.test(lines[0]), 'output is not exactly one REFUSED line');
    return { pass: reasons.length === 0, reasons };
  }
  check(!lines.some((l) => /^REFUSED:/.test(l)), 'refused a valid brief');
  if (exp.mode) check(lines[0] === `mode: ${exp.mode}`, `first line is not "mode: ${exp.mode}"`);
  if (exp.anchor) check(exp.anchor.test(text), 'missing file:line anchor');
  if (exp.severity) check(exp.severity.test(text), 'missing severity tag');
  if (exp.clause) check(exp.clause.test(text), 'missing clause id');
  if (exp.noBlocking) check(!/\[(blocker|major)\]/.test(text), 'invented a blocking finding');
  if (exp.verdict) check(new RegExp(`^verdict:\\s*${exp.verdict}\\s*$`, 'm').test(text), `verdict is not ${exp.verdict}`);
  if (exp.readOnlyDecline) check(lines.includes(READ_ONLY_LINE), `missing exact line "${READ_ONLY_LINE}"`);
  return { pass: reasons.length === 0, reasons };
}
