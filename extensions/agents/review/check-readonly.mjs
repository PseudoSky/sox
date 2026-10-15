// 2f81569f T11.AC1 / cac771f8 AC2 — proves the review agent declares no edit/write/shell/dispatch capability.
// CLI: node check-readonly.mjs [--strict] [extension.json]
//   Guarantee (review profile, the CLI default): no file-write tools; Bash only through the canonical read-only git-diff
//   permission map (GIT_DIFF_BASH) on claude/opencode. `--strict` (and the API default) denies bash outright, as for every
//   other read-only agent.
//   exit 0 = read-only        exit 1 = violation(s)        exit 2 = file unreadable / not JSON
//   exit 3 = malformed shape (a field the check must read has the wrong type; cannot be proven read-only)
//   exit 4 = internal error (a bug in this checker; message only, never a stack trace)
//
// Fail-closed design: capabilities are checked against an ALLOW-list of read-only names, not a deny-list of known
// writers, so a capability name this file has never heard of (a new renderer tool, a typo, a wildcard) is a finding.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Tool names a read-only agent may declare (case-insensitive): claude `Read/Grep/Glob`, opencode `read/grep/glob/list`. */
const READ_ONLY_TOOLS = new Set(['read', 'glob', 'grep', 'list']);
/** Permission keys whose non-deny value does not grant mutation (scope/readers). `external_directory` only widens paths of tools that are already granted. */
const READ_ONLY_PERMISSION_KEYS = new Set(['read', 'glob', 'grep', 'list', 'external_directory']);
/** Permission keys that must be an explicit `deny` (opencode defaults an absent key to allow). */
const MUST_DENY = ['edit', 'write', 'bash', 'task', 'skill', 'webfetch', 'websearch', 'question', 'todowrite'];
/** The native members agent-mcp's deriveTooling()/CatalogNativeTooling knows. */
const NATIVE_MEMBERS = new Set(['fs', 'shell', 'dispatch', 'hitl']);
/** fs-server tools that only read (agent-mcp.ts FS_READ_TOOLS/FS_LIST_TOOLS/FS_SEARCH_TOOLS). */
const FS_READ_RULE = /^(fs\.)?(read_|get_file_info$|list_|directory_tree$|search_files$)/;

/**
 * The only bash map a read-only agent may carry under the review profile (opencode last-match-wins: `*` deny first, the one
 * git-diff allow, then guards). The guards deny redirects, pipes, substitution and every long option that could write
 * (--output) or run a program (--ext-diff, --textconv) or redirect git (--git-dir, -c); git accepts unambiguous
 * abbreviations, so they deny by prefix. opencode's matcher rewrites `\\` to `/`, so a backslash guard would deny every path; backslash is prose-forbidden instead. Claude has no argument patterns, so there the map is prose-only.
 */
export const GIT_DIFF_ALLOW = 'git -C * --no-pager diff --no-ext-diff --no-textconv *';
export const GIT_DIFF_BASH = Object.freeze({
  '*': 'deny',
  [GIT_DIFF_ALLOW]: 'allow',
  ...Object.fromEntries(
    ['*>*', '*<*', '*|*', '*;*', '*&*', '*$*', '*`*', '*"*', "*'*", '*--o*', '*--e*', '*--t*', '*--g*', '*--w*', '*--c*', '*--p*', '*--b*', '*--names*', '* -c*'].map((g) => [g, 'deny']),
  ),
});
/** Profile for the review agent: bash allowed ONLY as exactly GIT_DIFF_BASH. */
export const REVIEW_PROFILE = Object.freeze({ bashAllow: GIT_DIFF_BASH });

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isDeny = (v) => v === 'deny';
const describe = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v);

/** Record a `malformed:` finding when `v` is present but not a plain object. Returns the object to iterate (`{}` when absent/malformed). */
function objectAt(v, path, out) {
  if (v === undefined) return {};
  if (!isObj(v)) { out.push(`malformed: ${path} must be an object (got ${describe(v)})`); return {}; }
  return v;
}

/** Record a `malformed:` finding when `v` is present but not an array. */
function arrayAt(v, path, out) {
  if (v === undefined) return [];
  if (!Array.isArray(v)) { out.push(`malformed: ${path} must be an array (got ${describe(v)})`); return []; }
  return v;
}

/** `bash` value under a profile: `deny`, or (profile only) exactly the canonical map in canonical order. */
function bashViolation(val, path, opts, out) {
  if (isDeny(val)) return;
  if (!opts.bashAllow) { out.push(`${path}.bash is not "deny"`); return; }
  if (JSON.stringify(val) !== JSON.stringify(opts.bashAllow)) out.push(`${path}.bash is neither "deny" nor exactly the allowlisted read-only git-diff map`);
}

/** One permission map (agent.permission or a render override's permission/permissions). */
function permissionMapViolations(map, path, out) {
  for (const [k, val] of Object.entries(map)) {
    if (k === 'allowedAgents') continue; // agent-mcp permissions.allowedAgents: handled as delegation below
    if (isDeny(val)) continue;
    if (k === 'task' && isObj(val)) {
      const allowed = Object.entries(val).filter(([, a]) => !isDeny(a)).map(([p]) => p);
      out.push(`${path}.task delegates to ${allowed.join(', ') || '(unspecified)'} (a read-only agent could spawn a writer)`);
      continue;
    }
    if (/^(memory_|mcp__)/.test(k)) { out.push(`${path}.${k} is not "deny"`); continue; }
    if (READ_ONLY_PERMISSION_KEYS.has(k)) continue;
    if (k.includes('*')) { out.push(`${path}.${k} is a wildcard rule that is not "deny" (grants every matching capability)`); continue; }
    if (MUST_DENY.includes(k)) continue; // reported by the must-deny pass with its own message
    out.push(`${path}.${k} grants an unrecognised capability (only read/glob/grep may be non-deny)`);
  }
}

function toolListViolations(list, path, out, allowBash = false) {
  for (const t of list) {
    const name = typeof t === 'string' ? t : (isObj(t) ? (t.logical ?? '') : '');
    if (typeof t !== 'string') out.push(`${path} declares a non-core tool object (memory/MCP can write)`);
    else if (allowBash && name.toLowerCase() === 'bash') continue;
    else if (!READ_ONLY_TOOLS.has(name.toLowerCase())) out.push(`${path} declares "${name}"`);
  }
}

// agent-mcp.ts deriveTooling(): an explicit render.agent-mcp.nativeTooling.<member> REPLACES the member derived from
// the IR (`explicitNative['shell'] !== undefined` etc.), so the IR denies alone do not protect the rendered payload.
function nativeToolingViolations(nt, host, out) {
  if (nt === undefined) return;
  const at = `render.${host}.nativeTooling`;
  if (!isObj(nt)) { out.push(`malformed: ${at} must be an object (got ${describe(nt)})`); return; }
  for (const member of ['shell', 'dispatch']) {
    if (nt[member] !== undefined && nt[member] !== false) out.push(`${at}.${member} enables ${member} (must be false)`);
  }
  if (nt.hitl !== undefined && nt.hitl !== false) out.push(`${at}.hitl enables human-input (question must be denied)`);
  for (const k of Object.keys(nt)) {
    if (!NATIVE_MEMBERS.has(k) && nt[k] !== undefined && nt[k] !== false) out.push(`${at}.${k} grants an unrecognised native member`);
  }
  const fs = nt.fs;
  if (fs !== undefined && fs !== false) {
    if (!isObj(fs)) out.push(`${at}.fs grants fs write (must be false or readOnly:true)`);
    else {
      if (fs.readOnly !== true) out.push(`${at}.fs is not readOnly:true (grants fs write)`);
      for (const [rule, act] of Object.entries(objectAt(fs.permissions, `${at}.fs.permissions`, out))) {
        if (!isDeny(act) && !FS_READ_RULE.test(rule)) out.push(`${at}.fs.permissions.${rule} is not "deny"`);
      }
    }
  }
}

/** Returns the list of findings; empty means read-only. `malformed:` findings mean the input shape could not be evaluated. */
export function checkReadOnly(manifest, opts = {}) {
  const v = [];
  if (!isObj(manifest)) return [`malformed: manifest must be an object (got ${describe(manifest)})`];
  const agent = manifest.agent === undefined ? {} : objectAt(manifest.agent, 'agent', v);

  const allowBash = Boolean(opts.bashAllow);
  toolListViolations(arrayAt(agent.tools, 'agent.tools', v), 'agent.tools', v, allowBash);

  const permission = objectAt(agent.permission, 'agent.permission', v);
  for (const k of MUST_DENY) {
    if (k === 'bash') bashViolation(permission[k], 'permission', opts, v);
    else if (permission[k] !== 'deny') v.push(`permission.${k} is not "deny"`);
  }
  permissionMapViolations(permission, 'permission', v);

  for (const [host, r] of Object.entries(objectAt(manifest.render, 'render', v))) {
    if (r === undefined) continue;
    if (!isObj(r)) { v.push(`malformed: render.${host} must be an object (got ${describe(r)})`); continue; }
    toolListViolations(arrayAt(r.tools, `render.${host}.tools`, v), `render.${host}.tools`, v, allowBash && (host === 'claude' || host === 'opencode'));
    // A render override REPLACES the IR permission map (agent-renderers.ts: `override?.permission ?? ir.permission`).
    if (r.permission !== undefined) {
      const m = objectAt(r.permission, `render.${host}.permission`, v);
      if (isObj(r.permission)) {
        for (const k of MUST_DENY) {
          if (k === 'bash' && allowBash && (host === 'claude' || host === 'opencode') && m[k] !== 'deny') bashViolation(m[k], `render.${host}.permission`, opts, v);
          else if (m[k] !== 'deny') v.push(`render.${host}.permission replaces the IR map and omits "${k}: deny"`);
        }
        permissionMapViolations(m, `render.${host}.permission`, v);
      }
    }
    if (r.permissions !== undefined) {
      const m = objectAt(r.permissions, `render.${host}.permissions`, v);
      for (const k of MUST_DENY) if (m[k] !== undefined && m[k] !== 'deny') v.push(`render.${host}.permissions.${k} is not "deny"`);
      permissionMapViolations(m, `render.${host}.permissions`, v);
      const allowedAgents = m.allowedAgents;
      if (allowedAgents !== undefined && !(Array.isArray(allowedAgents) && allowedAgents.length === 0)) {
        v.push(`render.${host}.permissions.allowedAgents delegates to other agents (a read-only agent could spawn a writer)`);
      }
    }
    nativeToolingViolations(r.nativeTooling, host, v);
    if (host === 'agent-mcp') {
      if (isObj(r.mcpServers) ? Object.keys(r.mcpServers).length > 0 : r.mcpServers !== undefined) v.push('render.agent-mcp.mcpServers grants MCP servers (can write)');
      if (r.nativeWebTools === true) v.push('render.agent-mcp.nativeWebTools enables web access (webfetch/websearch must be denied)');
      // A claudecli provider's allowedBuiltinTools is taken verbatim and bypasses the IR tool list (agent-mcp.ts deriveProvider).
      const builtins = isObj(r.provider) ? r.provider.allowedBuiltinTools : undefined;
      if (builtins !== undefined) toolListViolations(arrayAt(builtins, 'render.agent-mcp.provider.allowedBuiltinTools', v), 'render.agent-mcp.provider.allowedBuiltinTools', v);
    }
  }
  return v;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict');
  const path = args.find((a) => !a.startsWith('--')) ?? join(dirname(fileURLToPath(import.meta.url)), 'extension.json');
  let m;
  try { m = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { console.error(`check-readonly: cannot read ${path}: ${e.message}`); process.exit(2); }
  let v;
  try { v = checkReadOnly(m, strict ? {} : REVIEW_PROFILE); } catch (e) { console.error(`check-readonly: internal error evaluating ${path}: ${e.message}`); process.exit(4); }
  if (v.some((f) => f.startsWith('malformed:'))) { console.error(`check-readonly: MALFORMED\n- ${v.join('\n- ')}`); process.exit(3); }
  if (v.length) { console.error(`check-readonly: FAIL\n- ${v.join('\n- ')}`); process.exit(1); }
  console.log(`check-readonly: OK (${path})`);
}
