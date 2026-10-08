// 2f81569f T11.AC1 — proves the review agent declares no edit/write/shell capability.
// CLI: node check-readonly.mjs [extension.json]   exit 0 = read-only, 1 = violation(s), 2 = unreadable.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WRITE_TOOL = /^(edit|write|multiedit|notebookedit|apply[-_]?patch|patch|bash|shell|run|exec|mcp__.*)$/i;
const MUST_DENY = ['edit', 'write', 'bash', 'task', 'skill', 'webfetch', 'websearch', 'question', 'todowrite'];

const FS_WRITE_RULE = /write|edit|create|move/i;

// agent-mcp.ts deriveTooling(): an explicit render.agent-mcp.nativeTooling.<member> REPLACES the member derived from
// the IR (`explicitNative['shell'] !== undefined` etc.), so the IR denies alone do not protect the rendered payload.
function nativeToolingViolations(nt) {
  const v = [];
  if (nt === undefined || nt === null) return v;
  for (const member of ['shell', 'dispatch']) {
    if (nt[member] !== undefined && nt[member] !== false) v.push(`render.agent-mcp.nativeTooling.${member} enables ${member} (must be false)`);
  }
  if (nt.hitl !== undefined && nt.hitl !== false) v.push('render.agent-mcp.nativeTooling.hitl enables human-input (question must be denied)');
  const fs = nt.fs;
  if (fs !== undefined && fs !== false) {
    if (fs === true || typeof fs !== 'object' || fs === null) v.push('render.agent-mcp.nativeTooling.fs grants fs write (must be false or readOnly:true)');
    else {
      if (fs.readOnly !== true) v.push('render.agent-mcp.nativeTooling.fs is not readOnly:true (grants fs write)');
      for (const [rule, act] of Object.entries(fs.permissions ?? {})) {
        if (FS_WRITE_RULE.test(rule) && act !== 'deny') v.push(`render.agent-mcp.nativeTooling.fs.permissions.${rule} is not "deny"`);
      }
    }
  }
  return v;
}

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
    // A render override REPLACES the IR permission map (agent-renderers.ts: `override?.permission ?? ir.permission`).
    for (const k of MUST_DENY) if (r?.permissions?.[k] !== undefined && r.permissions[k] !== 'deny') v.push(`render.${host}.permissions.${k} is not "deny"`);
    if (r?.permission !== undefined) for (const k of MUST_DENY) if (r.permission[k] !== 'deny') v.push(`render.${host}.permission replaces the IR map and omits "${k}: deny"`);
    // A render override can carry a logical-capability grant (memory_*/mcp__*) just like the IR map.
    for (const field of ['permission', 'permissions']) {
      for (const [k, val] of Object.entries(r?.[field] ?? {})) {
        if (/^(memory_|mcp__)/.test(k) && val !== 'deny') v.push(`render.${host}.${field}.${k} is not "deny"`);
      }
    }
    if (host === 'agent-mcp' && Object.keys(r?.mcpServers ?? {}).length > 0) v.push('render.agent-mcp.mcpServers grants MCP servers (can write)');
    if (host === 'agent-mcp') v.push(...nativeToolingViolations(r?.nativeTooling));
    if (host === 'agent-mcp' && r?.nativeWebTools === true) v.push('render.agent-mcp.nativeWebTools enables web access (webfetch/websearch must be denied)');
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
