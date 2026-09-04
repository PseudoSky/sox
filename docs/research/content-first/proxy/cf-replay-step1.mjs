#!/usr/bin/env node
/**
 * cf-replay-step1.mjs — write base (step-1) request records for all 4 forks.
 *
 * DESIGN (user-corrected): the decision-point context must contain ALL prior
 * information (FEATURE.md, ACCEPTANCE.md, every tool result up to the decision)
 * MINUS the persona being tested. The captured decision contexts are already
 * persona-free (verified: architect.md probe absent from both). So:
 *
 *   base     = captured context (clean prior info)
 *   SP@0     = base + architect persona appended to SYSTEM prompt (position 0)
 *   SP@tail  = base + architect persona appended to the LAST USER message
 *
 * The ONLY difference between the two variants is persona placement.
 * No API calls here — just materialize the message arrays for continuation.
 */
import fs from 'node:fs';

const OUT = '/tmp/cf-replay';
const ARCH = '/Users/nix/.config/opencode/agents/architect.md';
fs.mkdirSync(OUT, { recursive: true });

const arms = [
  { name: 'cf-pre', ctx: '/tmp/cf-pre-decision-ctx.json' },
  { name: 'cf-fixed', ctx: '/tmp/cf-fixed-decision-ctx.json' },
];

function build(messages, variant) {
  const sys = messages[0];
  const sysContent = typeof sys.content === 'string' ? sys.content : JSON.stringify(sys.content);
  const rest = JSON.parse(JSON.stringify(messages.slice(1)));
  const persona = fs.readFileSync(ARCH, 'utf8');
  const block = `\n\n--- Role: architect ---\n\n${persona}`;

  if (variant === 'sp0') {
    // persona appended to the SYSTEM prompt (position 0)
    return [{ role: 'system', content: sysContent + block }, ...rest];
  }

  // spTail: persona appended to the TRUE LAST message, regardless of role —
  // exactly [inv:persona-always-tail]: result[lastIdx].content += suffix.
  // (NOT "last user" — in an opencode tool stream that is index 1 = the CF-pre
  // bug. The true last message here is a tool result at index 74/66.)
  const tail = JSON.parse(JSON.stringify(rest));
  const lastIdx = tail.length - 1;
  const lastMsg = tail[lastIdx];
  const cur = typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content);
  tail[lastIdx] = { ...lastMsg, content: cur + block };
  return [{ role: 'system', content: sysContent }, ...tail];
}

for (const arm of arms) {
  const messages = JSON.parse(fs.readFileSync(arm.ctx, 'utf8')).messages;
  for (const variant of ['sp0', 'sptail']) {
    const request = build(messages, variant);
    const file = `${OUT}/${arm.name}-${variant}-run1.jsonl`;
    const record = { step: 1, ts: new Date().toISOString(), arm: arm.name, variant, run: 1, baseRequest: true, request };
    fs.writeFileSync(file, JSON.stringify(record) + '\n');
    console.log(`base: ${file} (${request.length} msgs, sys ${request[0].content.length} chars)`);
  }
}

// verification: the two variants differ ONLY in persona placement
console.log('\n=== verification: variant difference is only the persona ===');
for (const arm of arms) {
  const a = JSON.parse(fs.readFileSync(`${OUT}/${arm.name}-sp0-run1.jsonl`, 'utf8')).request;
  const b = JSON.parse(fs.readFileSync(`${OUT}/${arm.name}-sptail-run1.jsonl`, 'utf8')).request;
  const strip = (m) => m.map(x => ({ ...x, content: typeof x.content === 'string' ? x.content.replace(/\n\n--- Role: architect ---\n\n[\s\S]*?$/, '') : x.content }));
  const aStripped = JSON.stringify(strip(a));
  const bStripped = JSON.stringify(strip(b));
  console.log(`${arm.name}: identical after persona-strip? ${aStripped === bStripped}`);
}
