// Code-based grader. 0c91e632 AC3-AC6
export const GRADER_VERSION = 1;
export function grade(output, exp) {
  const text = String(output ?? '');
  const reasons = [];
  if (!text.trim()) reasons.push('empty output');
  for (const r of exp.match) if (!r.test(text)) reasons.push(`missing ${r}`);
  for (const r of exp.noMatch) if (r.test(text)) reasons.push(`forbidden ${r}`);
  return { pass: reasons.length === 0, reasons };
}
