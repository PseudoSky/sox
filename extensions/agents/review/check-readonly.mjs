// 2f81569f T11.AC1 — proves the review agent declares no edit/write/shell capability.
// CLI: node check-readonly.mjs [extension.json]   exit 0 = read-only, 1 = violation(s), 2 = unreadable.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WRITE_TOOL = /^(edit|write|multiedit|notebookedit|apply[-_]?patch|patch|bash|shell|run|exec|mcp__.*)$/i;
const MUST_DENY = ['edit', 'write', 'bash'];

export function checkReadOnly(manifest) {
  const v = [];
  const agent = manifest?.agent ?? {};
  for (const t of agent.tools ?? []) {
    const name = typeof t === 'string' ? t : (t?.logical ?? '');
    if (WRITE_TOOL.test(name)) v.push(`agent.tools declares "${name}"`);
    if (typeof t !== 'string') v.push('agent.tools declares a non-core tool object (memory/MCP can write)');
  }
  for (const [host, r] of Object.entries(manifest?.render ?? {})) {
    for (const t of r?.tools ?? []) if (WRITE_TOOL.test(t)) v.push(`render.${host}.tools declares "${t}"`);
  }
  for (const k of MUST_DENY) if (agent.permission?.[k] !== 'deny') v.push(`permission.${k} is not "deny"`);
  for (const [k, val] of Object.entries(agent.permission ?? {})) {
    if (/^(memory_|mcp__)/.test(k) && val !== 'deny') v.push(`permission.${k} is not "deny"`);
  }
  return v;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), 'extension.json');
  let m;
  try { m = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { console.error(`check-readonly: cannot read ${path}: ${e.message}`); process.exit(2); }
  const v = checkReadOnly(m);
  if (v.length) { console.error(`check-readonly: FAIL\n- ${v.join('\n- ')}`); process.exit(1); }
  console.log(`check-readonly: OK (${path})`);
}
