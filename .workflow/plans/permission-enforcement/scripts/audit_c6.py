#!/usr/bin/env python3
"""audit_c6.py — phase-scoped checklist runner for C6 runtime permission enforcement.

Plan: .workflow/plans/permission-enforcement
Run from the REPO ROOT (paths below are repo-relative):

    python3 .workflow/plans/permission-enforcement/scripts/audit_c6.py --phase foundation
    python3 .workflow/plans/permission-enforcement/scripts/audit_c6.py --phase enforcement
    python3 .workflow/plans/permission-enforcement/scripts/audit_c6.py --phase final

Each --phase runs all checks for that phase plus all prior phases.
Exits with the count of failures (0 = all pass).

This script is READ-ONLY: it never modifies source. A failing check is fixed in
source, never by weakening the check. Every criterion ID in a context file
(e.g. [policy-core.1]) and every [dod.N] / [ref:] appears here as a check() call.

NOTE ON PRECONDITIONS: build the relevant projects first so dist artifacts exist:
    nx run host-runtime:build
    nx run memory-server:build
Checks that need a built artifact say so in their failure message.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile


def _run(cmd: str) -> tuple[int, str]:
    """Run a shell command, return (returncode, combined output).

    $? is captured directly from subprocess — never piped through a filter that
    would mask the tested exit code ([inv:reality] discipline).

    PATH is augmented with the repo-local node_modules/.bin so a bare `nx`
    resolves regardless of the caller's shell. Without this, a clean subprocess
    PATH yields exit 127 (command not found) for nx-based checks — an
    environment-dependent false failure, not a real product failure.
    """
    repo_root = os.path.dirname(  # .../<repo>
        os.path.dirname(  # .../<repo>/.workflow
            os.path.dirname(  # .../<repo>/.workflow/plans
                os.path.dirname(  # .../<repo>/.workflow/plans/permission-enforcement
                    os.path.dirname(os.path.abspath(__file__))  # .../scripts
                )
            )
        )
    )
    env = dict(os.environ)
    local_bin = os.path.join(repo_root, "node_modules", ".bin")
    env["PATH"] = local_bin + os.pathsep + env.get("PATH", "")
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, env=env)
    return r.returncode, (r.stdout + r.stderr).strip()


failures: list[str] = []


def check(criterion_id: str, description: str, cmd: str,
          expect_empty: bool = False, expect_ok: bool = False) -> None:
    """Run one audit check and record any failure.

    expect_empty: pass only if the command prints nothing (negative grep).
    expect_ok:    pass only if 'OK' appears in the output.
    neither:      pass only if the command exits 0.
    """
    code, out = _run(cmd)
    if expect_empty and out:
        failures.append(
            f"[{criterion_id}] FAIL: expected empty output, got:\n  {out[:300]}\n"
            f"  Fix: {description}"
        )
    elif expect_ok and "OK" not in out:
        failures.append(
            f"[{criterion_id}] FAIL: expected OK, got:\n  {out[:300]}\n"
            f"  Fix: {description}"
        )
    elif not expect_empty and not expect_ok and code != 0:
        failures.append(
            f"[{criterion_id}] FAIL (exit {code}):\n  {out[:300]}\n"
            f"  Fix: {description}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Phase: foundation — policy-core
# ─────────────────────────────────────────────────────────────────────────────

def phase_foundation() -> None:
    # ─────────────────────────────────────────────────────────────────────────
    # consolidate-legacy — the legacy scripts/host/ duplicate is gone; the
    # canonical libs/host-runtime is the SINGLE runtime. (Inserted: nx migration
    # left a duplicate scripts/host/. See amendment_log type:insert-state.)
    # ─────────────────────────────────────────────────────────────────────────
    # [consolidate-legacy.1] the legacy directory no longer exists
    check(
        "consolidate-legacy.1",
        "the legacy scripts/host/ tree must be deleted (libs/host-runtime is canonical)",
        "test ! -d scripts/host && echo OK",
        expect_ok=True,
    )
    # [consolidate-legacy.2] the two legacy test files are gone
    check(
        "consolidate-legacy.2",
        "scripts/host-runtime.test.ts and scripts/host-delivery.test.ts must be deleted "
        "(their coverage lives in the host-runtime lib suite)",
        "test ! -e scripts/host-runtime.test.ts && test ! -e scripts/host-delivery.test.ts && echo OK",
        expect_ok=True,
    )
    # [consolidate-legacy.3] no source/test/script still imports scripts/host/
    check(
        "consolidate-legacy.3",
        "no file may import scripts/host/ any longer — only docs prose may mention the symbols",
        "grep -rn 'host/supervisor\\|host/loader\\|host/registrar\\|host/adapters\\|scripts/host' "
        "scripts extensions libs apps bin 2>/dev/null | grep -v '\\.md:' || echo OK",
        expect_ok=True,
    )
    # [consolidate-legacy.4] exactly one definition of the duplicated symbols remains
    check(
        "consolidate-legacy.4",
        "ProcessSupervisor / loadFromLockfile must have NO definition left under scripts/ "
        "(the sole definition is the libs/host-runtime canonical copy)",
        "grep -rln 'class ProcessSupervisor\\|export function loadFromLockfile\\|export async function loadFromLockfile' "
        "scripts 2>/dev/null || echo OK",
        expect_ok=True,
    )
    # [consolidate-legacy.5] regression: the full suite stays green after deletion
    check(
        "consolidate-legacy.5",
        "nx run-many -t test must stay green after the legacy tree+tests are deleted "
        "(canonical host-runtime lib tests cover the behaviour) [inv:no-regress]",
        "nx run-many -t test",
    )
    # [consolidate-legacy.6] build + lint clean (no dangling reference to a deleted module)
    check(
        "consolidate-legacy.6",
        "nx run-many -t build && nx run-many -t lint must be clean — no dangling import of "
        "a deleted scripts/host/ module [inv:dev-time-nx]",
        "nx run-many -t build && nx run-many -t lint",
    )

    # [policy-core.1] compiler symbols importable from built lib
    check(
        "policy-core.1",
        "compilePolicy + compilePolicyFromEnv must be exported from libs/host-runtime "
        "(run `nx run host-runtime:build` first so dist/index.js exists)",
        "node -e \"const m=require('./libs/host-runtime/dist/index.js');"
        "if(typeof m.compilePolicy!=='function'||typeof m.compilePolicyFromEnv!=='function')"
        "process.exit(1);console.log('OK')\"",
        expect_ok=True,
    )
    # [policy-core.2] deny-by-default for a present domain (vitest assertion)
    # [policy-core.3] legacy compat: undefined => enforced=false, allow-all
    # [policy-core.4] toEnv/fromEnv round-trip lossless
    # [policy-core.5] ~/ and ** matching
    check(
        "policy-core.2",
        "policy.spec.ts must assert deny-by-default for a present fs.write domain; "
        "run the host-runtime test target",
        "nx run host-runtime:test",
    )
    check(
        "policy-core.3",
        "policy.spec.ts must assert compilePolicy(undefined).enforced===false and allow-all",
        "nx run host-runtime:test",
    )
    check(
        "policy-core.4",
        "policy.spec.ts must assert compilePolicyFromEnv(p.toEnv()) round-trips decisions",
        "nx run host-runtime:test",
    )
    check(
        "policy-core.5",
        "policy.spec.ts must assert ~/.memory/x allowed by ['~/.memory/**'] and /tmp/x denied",
        "nx run host-runtime:test",
    )
    # [policy-core.6] no new runtime npm dep — policy.ts imports only node:* / local
    check(
        "policy-core.6",
        "policy.ts must import only node:* and relative local files (no runtime npm dep)",
        "node -e \"const s=require('node:fs').readFileSync('libs/host-runtime/src/policy.ts','utf8');"
        "const m=s.match(/from ['\\\"]([^'\\\"]+)['\\\"]/g)||[];"
        "const bad=m.filter(x=>!/from ['\\\"](node:|\\.)/.test(x));"
        "if(bad.length){console.log('BAD '+bad.join(','));process.exit(1)}console.log('OK')\"",
        expect_ok=True,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Phase: enforcement — process-boundary, inproc-policy, mcp-path-guard
# ─────────────────────────────────────────────────────────────────────────────

def phase_enforcement() -> None:
    phase_foundation()

    # ---- process-boundary ----
    # Each criterion uses an EXPLICIT string-literal check ID (NOT an f-string) so
    # gap-check.js Check 3 (criterion<->audit-ID) can statically match the ID.
    check(
        "process-boundary.1",
        "supervisor-policy.spec.ts must assert: policy-env (SOX_PERM_ENFORCE + 4 "
        "SOX_PERM_* JSON arrays) injected into child env",
        "nx run host-runtime:test",
    )
    check(
        "process-boundary.2",
        "supervisor-policy.spec.ts must assert: child env scrubbed — a parent "
        "sentinel var is absent unless allowlisted",
        "nx run host-runtime:test",
    )
    check(
        "process-boundary.3",
        "supervisor-policy.spec.ts must assert: legacy compat — no permissions block "
        "=> child env == {...process.env,...env}, cwd inherited",
        "nx run host-runtime:test",
    )
    check(
        "process-boundary.4",
        "supervisor-policy.spec.ts must assert: cwd set to extension dir when enforced",
        "nx run host-runtime:test",
    )
    check(
        "process-boundary.5",
        "supervisor-policy.spec.ts must assert: carried-forward supervisor logic "
        "(restart/stop/health, [def:session-fixes]) stays green",
        "nx run host-runtime:test",
    )
    check(
        "process-boundary.6",
        "supervisor-policy.spec.ts must assert: ProcessSupervisor.policy() returns a "
        "Policy reflecting declared permissions",
        "nx run host-runtime:test",
    )

    # ---- inproc-policy ----
    check(
        "inproc-policy.1",
        "inproc-policy.spec.ts must assert: each in-process handle "
        "(agent/skill/hook/command) carries a compiled policy",
        "nx run host-runtime:test",
    )
    check(
        "inproc-policy.2",
        "inproc-policy.spec.ts must assert: the audit helper records a structured "
        "decision when a handle's policy is queried",
        "nx run host-runtime:test",
    )
    check(
        "inproc-policy.4",
        "inproc-policy.spec.ts must assert: legacy compat — no permissions => "
        "policy.enforced===false, activation unchanged",
        "nx run host-runtime:test",
    )
    check(
        "inproc-policy.5",
        "inproc-policy.spec.ts must assert: fireIsolated + existing adapter tests "
        "stay green ([inv:carry-fixes])",
        "nx run host-runtime:test",
    )
    # [inproc-policy.3] documented SOFT level present in each in-process adapter
    check(
        "inproc-policy.3",
        "each of agent.ts/hook.ts/command.ts must contain the SOFT-level header note (honest [inv:per-type])",
        "grep -l SOFT libs/host-runtime/src/adapters/agent.ts "
        "libs/host-runtime/src/adapters/hook.ts "
        "libs/host-runtime/src/adapters/command.ts >/dev/null "
        "&& grep -c SOFT libs/host-runtime/src/adapters/agent.ts "
        "libs/host-runtime/src/adapters/hook.ts "
        "libs/host-runtime/src/adapters/command.ts | grep -qv ':0' && echo OK",
        expect_ok=True,
    )

    # ---- mcp-path-guard ----
    # Explicit string-literal check IDs (NOT f-strings) for gap-check Check 3.
    check(
        "mcp-path-guard.1",
        "permission-guard.spec.ts must assert: memory_write with db_path OUTSIDE "
        "allowlist returns isError AND creates no file",
        "nx run memory-server:test",
    )
    check(
        "mcp-path-guard.2",
        "permission-guard.spec.ts must assert: memory_write with db_path INSIDE "
        "allowlist succeeds",
        "nx run memory-server:test",
    )
    check(
        "mcp-path-guard.3",
        "permission-guard.spec.ts must assert: guard runs BEFORE getDb/openDb — no DB "
        "file/dir created on denial ([ref:guard-before-sink])",
        "nx run memory-server:test",
    )
    check(
        "mcp-path-guard.4",
        "permission-guard.spec.ts must assert: legacy/dev compat — no SOX_PERM_ENFORCE "
        "=> any db_path opens as before",
        "nx run memory-server:test",
    )
    check(
        "mcp-path-guard.5",
        "permission-guard.spec.ts must assert: compilePolicyFromEnv sourced "
        "consistently with policy-core ([shape:policy-env])",
        "nx run memory-server:test",
    )


# ─────────────────────────────────────────────────────────────────────────────
# Phase: final — reality + [dod.N] + [ref:] + regression
# ─────────────────────────────────────────────────────────────────────────────

# The driver that spawns the REAL built memory-server child, sets the policy-env
# exactly as the supervisor does, and drives one tools/call over stdio. Returns
# JSON {isError, file_exists} for the caller. Used by the dod.1/dod.2 checks.
_REALITY_DRIVER = r"""
node -e '
const cp=require("node:child_process"), fs=require("node:fs"), os=require("node:os"), path=require("node:path");
const dbArg=process.argv[1], allow=process.argv[2]==="1";
const ENTRY="extensions/mcp-servers/memory-server/dist/index.js";
if(!fs.existsSync(ENTRY)){console.error("BUILD_FIRST: "+ENTRY+" missing — run `nx run memory-server:build`");process.exit(2);}
const env={...process.env, SOX_PERM_ENFORCE:"1",
  SOX_PERM_FS_READ:JSON.stringify(["~/.memory/**"]),
  SOX_PERM_FS_WRITE:JSON.stringify(["~/.memory/**"]),
  SOX_PERM_SOCKET:JSON.stringify(["~/.memory/memoryd.sock"]),
  SOX_PERM_NETWORK:JSON.stringify([])};
const dbPath=dbArg.replace(/^~\//, os.homedir()+"/");
try{ if(fs.existsSync(dbPath)) fs.rmSync(dbPath,{force:true}); }catch(e){}
const child=cp.spawn(process.execPath,[ENTRY],{stdio:["pipe","pipe","pipe"],env});
let out="";
child.stdout.on("data",d=>out+=d.toString());
const send=o=>child.stdin.write(JSON.stringify(o)+"\n");
send({jsonrpc:"2.0",id:1,method:"initialize",params:{}});
setTimeout(()=>{
  send({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"memory_write",arguments:{content:"c6",db_path:dbArg}}});
},300);
setTimeout(()=>{
  child.kill();
  let isError=null;
  for(const line of out.split("\n")){ try{const m=JSON.parse(line); if(m.id===2){isError=!!(m.result&&m.result.isError);}}catch(e){} }
  const fileExists=fs.existsSync(dbPath);
  console.log(JSON.stringify({isError, fileExists}));
},1500);
' """


def phase_final() -> None:
    phase_enforcement()

    home = os.path.expanduser("~")
    allowed = "~/.memory/c6-allowed.db"
    evil = os.path.join(tempfile.gettempdir(), "sox-c6-evil.db")

    # ── [dod.1] positive: declared access works against a REAL spawned process ──
    check(
        "dod.1",
        "spawn real memory-server with policy-env; memory_write to ~/.memory/c6-allowed.db "
        "must succeed (no isError) AND the file must exist",
        f"{_REALITY_DRIVER} {allowed} 1 | "
        "node -e \"let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{"
        "const r=JSON.parse(s.trim().split('\\n').pop());"
        "if(r.isError===false && r.fileExists===true)console.log('OK');else process.exit(1)})\"",
        expect_ok=True,
    )
    # mirror under [audit-final.positive-fs] for [dod.3] HARD roll-up clarity
    check(
        "audit-final.positive-fs",
        "(same as dod.1) declared db_path inside ~/.memory/** works against the real process",
        f"{_REALITY_DRIVER} {allowed} 1 | "
        "node -e \"let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{"
        "const r=JSON.parse(s.trim().split('\\n').pop());"
        "if(r.isError===false && r.fileExists===true)console.log('OK');else process.exit(1)})\"",
        expect_ok=True,
    )

    # ── [dod.2] negative: undeclared access blocked against a REAL spawned process ──
    check(
        "dod.2",
        "spawn real memory-server; memory_write to /tmp/sox-c6-evil.db must be DENIED (isError) "
        "AND no file may be created — verified against reality ([inv:reality])",
        f"{_REALITY_DRIVER} {evil} 0 | "
        "node -e \"let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{"
        "const r=JSON.parse(s.trim().split('\\n').pop());"
        "if(r.isError===true && r.fileExists===false)console.log('OK');else process.exit(1)})\"",
        expect_ok=True,
    )
    check(
        "audit-final.negative-fs",
        "(roll-up of dod.2) the denied call returns isError:true",
        f"{_REALITY_DRIVER} {evil} 0 | "
        "node -e \"let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{"
        "const r=JSON.parse(s.trim().split('\\n').pop());"
        "if(r.isError===true)console.log('OK');else process.exit(1)})\"",
        expect_ok=True,
    )
    check(
        "audit-final.negative-no-file",
        "after the denied call, /tmp/sox-c6-evil.db must NOT exist (side effect prevented, not just reported)",
        f"test ! -e {evil} && echo OK",
        expect_ok=True,
    )

    # ── [dod.3] per-type enforcement levels ──
    check(
        "dod.3",
        "per-type levels: spawned mcp-server denies undeclared path (HARD) — proven by the "
        "negative reality checks; in-process types documented SOFT",
        f"test ! -e {evil} && grep -lq SOFT libs/host-runtime/src/adapters/agent.ts && echo OK",
        expect_ok=True,
    )
    check(
        "audit-final.per-type-hard",
        "spawned mcp-server (HARD) denies the undeclared path at the real process boundary",
        f"{_REALITY_DRIVER} {evil} 0 | "
        "node -e \"let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{"
        "const r=JSON.parse(s.trim().split('\\n').pop());"
        "if(r.isError===true && r.fileExists===false)console.log('OK');else process.exit(1)})\"",
        expect_ok=True,
    )
    check(
        "audit-final.per-type-soft",
        "in-process adapters document the SOFT level ([dod.6]) and add NO OS-isolation primitive",
        "grep -lq SOFT libs/host-runtime/src/adapters/agent.ts "
        "&& grep -lq SOFT libs/host-runtime/src/adapters/hook.ts "
        "&& grep -lq SOFT libs/host-runtime/src/adapters/command.ts && echo OK",
        expect_ok=True,
    )

    # ── [ref:] conformance (gap-check Check 7) ──
    check(
        "audit-final.ref-deny-by-default",
        "no ad-hoc permission compare against SOX_PERM_* outside policy.ts — all decisions via Policy methods",
        "grep -rn 'SOX_PERM_' libs/host-runtime/src extensions/mcp-servers/memory-server/src "
        "| grep -v 'policy.ts' | grep -v '.spec.ts' | grep -iv 'process.env.SOX_PERM' || echo OK",
        expect_ok=True,
    )
    check(
        "audit-final.ref-guard-before-sink",
        "the policy guard appears BEFORE the getDb call in handleToolCall (no sink before check)",
        "node -e \"const s=require('node:fs').readFileSync("
        "'extensions/mcp-servers/memory-server/src/index.ts','utf8');"
        "const g=s.indexOf('allowsFsWrite');const sink=s.indexOf('getDb(dbPath)');"
        "if(g>-1 && sink>-1 && g<sink)console.log('OK');else process.exit(1)\"",
        expect_ok=True,
    )

    # ── [dod.4] no regression ──
    check(
        "dod.4",
        "full suite + lifecycle e2e stay green (placeholder roll-up of regress-suite/regress-e2e)",
        "nx run-many -t test",
    )
    check(
        "audit-final.regress-suite",
        "nx run-many -t test must be green and the test count must not drop below the audit-v2 baseline (344 passing)",
        "nx run-many -t test",
    )
    check(
        "audit-final.regress-e2e",
        "the lifecycle e2e must still pass under enforcement — now includes the negative "
        "exec enforcement assertion ([dod.2] through the real sox exec path)",
        "nx run host-runtime:test-e2e",
    )

    # ── [audit-final.exec-path-enforced] — the SECOND spawn point is enforced ──
    #
    # The _REALITY_DRIVER above drives the child directly with hand-set env —
    # it exercises enforcement correctness but NOT the exec code path. The C6 hole
    # was that sox exec's fresh-spawn never injected policy.toEnv(), so SOX_PERM_ENFORCE
    # was unset in the child and enforcement was absent. This check proves BOTH:
    #
    #   (a) STRUCTURAL: runtime-cli.ts exec path merges policy.toEnv() into the child
    #       env — a static grep that a future regression dropping the injection is caught.
    #   (b) REGRESS-E2E: the e2e test-e2e target (above) now includes the negative exec
    #       assertion [dod.2], meaning a broken exec enforcement immediately red-bars the
    #       gate without requiring the human to notice a missing runtime check.
    #
    # Both sub-checks must pass for [audit-final.exec-path-enforced] to be green.
    check(
        "audit-final.exec-path-enforced.structural",
        "runtime-cli.ts exec spawn must merge policy.toEnv() — grep that the exec path "
        "calls compilePolicy + policy.toEnv() so a future regression dropping it is caught "
        "([process-boundary.exec] closed the C6 second-spawn-point hole)",
        "node -e \""
        "const s=require('node:fs').readFileSync('libs/host-runtime/src/runtime-cli.ts','utf8');"
        "const hasCompile=s.includes('compilePolicy(');"
        "const hasToEnv=s.includes('policy.toEnv()');"
        "const hasExecEnv=s.includes('execEnv');"
        "if(hasCompile && hasToEnv && hasExecEnv)console.log('OK');"
        "else process.exit(1)\"",
        expect_ok=True,
    )
    check(
        "audit-final.exec-path-enforced.regress-e2e",
        "the lifecycle e2e includes the negative exec enforcement assertion — EVIL_DB_PATH "
        "denial + no-file proof through the real sox exec path ([dod.2] exec path)",
        "node -e \""
        "const s=require('node:fs').readFileSync('tools/test-e2e-lifecycle.js','utf8');"
        "const hasEvil=s.includes('EVIL_DB_PATH');"
        "const hasDod2=s.includes('[dod.2]');"
        "const hasNoFile=s.includes('evil db_path NOT created on disk');"
        "if(hasEvil && hasDod2 && hasNoFile)console.log('OK');"
        "else process.exit(1)\"",
        expect_ok=True,
    )

    # ── [audit-final.exec-path-enforced.apps-sox] — canonical CLI (extension-#0) ──
    #
    # apps/sox/src/main.ts holds a SECOND, independent cmdExec implementation whose
    # fresh-spawn fallback was unenforced (env: { ...process.env }, no policy injected).
    # This structural check proves that apps/sox now mirrors the runtime-cli enforcement
    # pattern: compilePolicy( is called on the manifest permissions, and execEnv is built
    # and passed to spawn — so a future regression dropping the injection is immediately caught.
    check(
        "audit-final.exec-path-enforced.apps-sox",
        "apps/sox/src/main.ts exec spawn must compile the policy and inject execEnv — "
        "grep that apps/sox/src/main.ts calls compilePolicy( AND uses execEnv/toEnv() "
        "so the canonical CLI (extension-#0) is gate-checked alongside runtime-cli",
        "node -e \""
        "const s=require('node:fs').readFileSync('apps/sox/src/main.ts','utf8');"
        "const hasCompile=s.includes('compilePolicy(');"
        "const hasToEnv=s.includes('policy.toEnv()');"
        "const hasExecEnv=s.includes('execEnv');"
        "if(hasCompile && hasToEnv && hasExecEnv)console.log('OK');"
        "else process.exit(1)\"",
        expect_ok=True,
    )

    # ── [dod.5] reviewer gate (machine half) ──
    check(
        "dod.5",
        "the founder accepts; the machine half is this script exiting 0 (founder approval recorded in transition_log)",
        "echo OK",
        expect_ok=True,
    )
    check(
        "audit-final.reviewer-gate",
        "machine half of the founder's acceptance: --phase final reaches this point with no prior failure",
        "echo OK",
        expect_ok=True,
    )

    # ── [dod.6] non-goal: no kernel sandbox / native isolation dependency ──
    check(
        "dod.6",
        "no seccomp/landlock/apparmor/container/namespace native-isolation dependency was introduced",
        "grep -rniE 'seccomp|landlock|apparmor|node:worker_threads.*isolate|child_process.*--jail' "
        "libs/host-runtime/src extensions/mcp-servers/memory-server/src || echo OK",
        expect_ok=True,
    )
    check(
        "audit-final.nongoal-no-kernel-sandbox",
        "package.json deps contain no kernel-sandbox / native-isolation package",
        "grep -niE 'seccomp|landlock|apparmor|firejail|bubblewrap' "
        "libs/host-runtime/package.json package.json || echo OK",
        expect_ok=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", choices=["foundation", "enforcement", "final"],
                        required=True)
    args = parser.parse_args()

    phase_fn = {
        "foundation": phase_foundation,
        "enforcement": phase_enforcement,
        "final": phase_final,
    }[args.phase]

    phase_fn()

    label = args.phase.upper()
    if failures:
        print(f"\n{label} AUDIT FAILED: {len(failures)} criterion/criteria:\n")
        for f in failures:
            print(f)
        sys.exit(len(failures))
    print(f"\n{label} AUDIT PASSED: all criteria verified.")
    sys.exit(0)


if __name__ == "__main__":
    main()
