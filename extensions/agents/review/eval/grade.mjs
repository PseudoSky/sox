// Code-based grader (no LLM judge: avoids self-preference bias, agent-manager 7.4).
// 2f81569f T11.AC3
export function grade(output, exp) {
  const text = String(output ?? '');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const reasons = [];
  const check = (ok, why) => { if (!ok) reasons.push(why); };

  if (exp.refused) {
    check(/^REFUSED:/m.test(text), 'no REFUSED line');
    check(!/\[(blocker|major|minor|nit)\]/.test(text), 'reviewed despite refusal');
    return { pass: reasons.length === 0, reasons };
  }
  if (exp.mode) check(lines[0] === `mode: ${exp.mode}`, `first line is not "mode: ${exp.mode}"`);
  if (exp.anchor) check(exp.anchor.test(text), 'missing file:line anchor');
  if (exp.severity) check(exp.severity.test(text), 'missing severity tag');
  if (exp.clause) check(exp.clause.test(text), 'missing clause id');
  if (exp.noBlocking) check(!/\[(blocker|major)\]/.test(text), 'invented a blocking finding');
  if (exp.verdict) check(new RegExp(`^verdict:\\s*${exp.verdict}\\s*$`, 'm').test(text), `verdict is not ${exp.verdict}`);
  if (exp.readOnlyDecline) check(/read-only/i.test(text), 'no read-only decline');
  return { pass: reasons.length === 0, reasons };
}
