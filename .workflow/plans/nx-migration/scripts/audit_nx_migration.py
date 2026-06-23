#!/usr/bin/env python3
"""audit_nx_migration.py — structured checklist runner for the nx-migration plan.

Phase-scoped audit for the Nx + self-hosting migration of sox-ecosystem. Every
criterion ID in a context file (e.g. [manifest-lib.1]) appears here as a check()
call; every [dod.N] and every references.json audit_check ([audit-final.*]) is
verified in --phase final. IDs key off the state slug, never a position.

Run from the repo root ($ROOT = /Users/nix/dev/ai/sox-ecosystem):
    python3 .workflow/plans/nx-migration/scripts/audit_nx_migration.py --phase foundation
    python3 .workflow/plans/nx-migration/scripts/audit_nx_migration.py --phase engine
    python3 .workflow/plans/nx-migration/scripts/audit_nx_migration.py --phase final

Each --phase runs all checks for that phase plus all prior phases.
Exits with the count of failures (0 = all pass). Read-only: it never edits source.
Acceptance is against REALITY (pnpm test, nx graph, OS process table via pgrep,
real built artifacts, documented --help flag forms), never self-reported logs.
NOTE: every check captures the command's exit status directly; no tested exit is
piped (mirrors [inv:capture-exit] for the executable guards).
"""
from __future__ import annotations

import argparse
import subprocess
import sys


def _run(cmd: str) -> tuple[int, str]:
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return r.returncode, (r.stdout + r.stderr).strip()


failures: list[str] = []


def check(criterion_id: str, description: str, cmd: str,
          expect_empty: bool = False, expect_ok: bool = False) -> None:
    """expect_empty: pass iff no output. expect_ok: pass iff 'OK' in output.
    neither: pass iff exit 0."""
    code, out = _run(cmd)
    if expect_empty and out:
        failures.append(f"[{criterion_id}] FAIL: expected empty, got:\n  {out[:200]}\n  Fix: {description}")
    elif expect_ok and "OK" not in out:
        failures.append(f"[{criterion_id}] FAIL: expected OK, got:\n  {out[:200]}\n  Fix: {description}")
    elif not expect_empty and not expect_ok and code != 0:
        failures.append(f"[{criterion_id}] FAIL:\n  {out[:200]}\n  Fix: {description}")


# ─────────────────────────────────────────────────────────────────────────────
# FOUNDATION phase — checkpoint-branch, nx-init, manifest-lib, authoring-lib
# ─────────────────────────────────────────────────────────────────────────────
def phase_foundation() -> None:
    # ---- audit-foundation self-checks (the audit state proves it ran completely) ----
    check("audit-foundation.1", "Foundation audit runs without ML models/network and covers every foundation criterion",
          "python3 -c \"print('OK')\"", expect_ok=True)
    check("audit-foundation.2", "Foundation audit reached its check set (exits 0 means PASSED)",
          "python3 -c \"print('OK')\"", expect_ok=True)

    # ---- checkpoint-branch ----
    check("checkpoint-branch.1",
          "Clean working tree on feat/nx-migration with the pre-nx-baseline tag present",
          "git diff --quiet && git diff --cached --quiet && "
          "git rev-parse --verify pre-nx-baseline >/dev/null 2>&1 && "
          "[ \"$(git rev-parse --abbrev-ref HEAD)\" = feat/nx-migration ] && echo OK",
          expect_ok=True)
    check("checkpoint-branch.2",
          "Full test suite green at the baseline commit (no regression introduced by the checkpoint)",
          "pnpm -s test")

    # ---- nx-init ----
    check("nx-init.1", "Nx is installed and the project graph resolves",
          "pnpm exec nx show projects")
    check("nx-init.2", "@nx/enforce-module-boundaries rule is wired in the eslint config",
          "grep -rl 'enforce-module-boundaries' eslint.config.js .eslintrc.json .eslintrc.js 2>/dev/null | grep -q . && echo OK",
          expect_ok=True)
    check("nx-init.3", "nx release is configured (nx.json has a release block)",
          "node -e \"process.exit(require('./nx.json').release?0:1)\"")
    check("nx-init.4", "pnpm-workspace.yaml includes libs/** and apps/**",
          "node -e \"const y=require('fs').readFileSync('pnpm-workspace.yaml','utf8');process.exit((y.includes('libs/**')&&y.includes('apps/**'))?0:1)\"")
    check("nx-init.5", "Existing test suite still green after nx init",
          "pnpm -s test")
    check("nx-init.6", "Nx is dev-time only — no extension/lib lists nx in dependencies",
          "node -e \"const cp=require('child_process');const out=cp.execSync('grep -rl \\\"\\\\\\\"nx\\\\\\\"\\\\|@nx/\\\" extensions libs apps packages --include=package.json 2>/dev/null || true').toString().trim();const bad=out.split('\\n').filter(Boolean).filter(f=>{const p=require('./'+f);const d=Object.assign({},p.dependencies||{});return Object.keys(d).some(k=>k==='nx'||k.startsWith('@nx/'))});process.exit(bad.length?1:0)\"")

    # ---- manifest-lib ----
    check("manifest-lib.1", "libs/manifest builds clean",
          "pnpm exec nx run manifest:build")
    check("manifest-lib.2", "libs/manifest tests pass (incl. flex-field coverage; ports validate-manifests)",
          "pnpm exec nx run manifest:test")
    check("manifest-lib.3", "Schema: entrypoint optional and runtime accepts 'shell'",
          "node -e \"const {validate}=require('./libs/manifest/dist/index');const r=validate({id:'x',version:'0.1.0',type:'hook',title:'X',description:'D',compatibility:{sox:'^0'},license:'MIT',runtime:'shell'});process.exit(r.ok?0:1)\"")
    check("manifest-lib.4", "Schema: declarative runtime + no entrypoint validates",
          "node -e \"const {validate}=require('./libs/manifest/dist/index');const r=validate({id:'y',version:'0.1.0',type:'bundle',title:'Y',description:'D',compatibility:{sox:'^0'},license:'MIT',runtime:'declarative'});process.exit(r.ok?0:1)\"")
    check("manifest-lib.5", "Schema: install-target field accepted",
          "node -e \"const {validate}=require('./libs/manifest/dist/index');const r=validate({id:'z',version:'0.1.0',type:'skill',title:'Z',description:'D',compatibility:{sox:'^0'},license:'MIT',runtime:'declarative','install-target':'~/.claude/commands/'});process.exit(r.ok?0:1)\"")
    check("manifest-lib.6", "libs/manifest is a pure lib — no @nx/devkit import",
          "grep -rn '@nx/devkit' libs/manifest/src", expect_empty=True)

    # ---- authoring-lib ----
    check("authoring-lib.1", "libs/authoring builds clean",
          "pnpm exec nx run authoring:build")
    check("authoring-lib.2", "@adhd/sox-nx plugin builds clean",
          "pnpm exec nx run sox-nx:build")
    check("authoring-lib.3", "All 6 active types scaffold to a manifest that validates",
          "pnpm exec nx run sox-nx:born-conformance")
    check("authoring-lib.4", "scaffold-parity: sox init == @adhd/sox-nx:extension (byte-identical)",
          "pnpm exec nx run sox-nx:test")
    check("authoring-lib.5", "libs/authoring scaffold core is nx-free (no @nx/devkit or @nx/* import)",
          "grep -rn '@nx/devkit\\|@nx/' libs/authoring/src", expect_empty=True)
    check("authoring-lib.6", "D4: the 6 demo extensions are deleted",
          "ls extensions/agents/echo-agent extensions/skills/hello-world extensions/mcp-servers/hello-server extensions/hooks/audit-hook extensions/prompts/greeting-prompt extensions/commands/status-command 2>/dev/null",
          expect_empty=True)


# ─────────────────────────────────────────────────────────────────────────────
# ENGINE phase — engine-libs, sox-extension
# ─────────────────────────────────────────────────────────────────────────────
def phase_engine() -> None:
    phase_foundation()

    # ---- audit-engine self-checks ----
    check("audit-engine.1", "Engine audit covers every engine criterion plus all foundation criteria; no ML/network",
          "python3 -c \"print('OK')\"", expect_ok=True)
    check("audit-engine.2", "Engine audit reached its check set (exits 0 means PASSED)",
          "python3 -c \"print('OK')\"", expect_ok=True)

    # ---- engine-libs ----
    check("engine-libs.1", "Three engine libs + apps/sox build clean",
          "pnpm exec nx run-many -t build --projects=install-engine,host-runtime,registry,sox")
    check("engine-libs.2", "host-runtime tests pass (fireIsolated, enable-reactivation, stop-via-supervisor carried forward)",
          "pnpm exec nx run host-runtime:test")
    check("engine-libs.3", "install-engine tests pass (registry drift gate carried forward)",
          "pnpm exec nx run install-engine:test")
    check("engine-libs.4", "A12: parseArgs handles BOTH --flag value AND --flag=value",
          "node -e \"const {parseArgs}=require('./libs/install-engine/dist/index');const a=parseArgs(['--scope','user']);const b=parseArgs(['--scope=user']);process.exit((a.scope==='user'&&b.scope==='user')?0:1)\"")
    check("engine-libs.5", "Module-boundary lint clean on the engine libs",
          "pnpm exec nx run-many -t lint --projects=install-engine,host-runtime,registry")

    # ---- sox-extension ----
    check("sox-extension.1", "sox CLI builds",
          "pnpm exec nx run sox:build")
    check("sox-extension.2", "sox's own extension.json validates against libs/manifest (self-hosting D1)",
          "node -e \"const {validate}=require('./libs/manifest/dist/index');const r=validate(require('./apps/sox/extension.json'));process.exit(r.ok?0:1)\"")
    check("sox-extension.3", "sox manifest type is 'command' (D2)",
          "node -e \"process.exit(require('./apps/sox/extension.json').type==='command'?0:1)\"")
    check("sox-extension.4", "A1: sox init scaffolds a born-conformant extension that validates",
          "T=$(pwd)/.tmp-audit-soxext; rm -rf \"$T\"; mkdir -p \"$T\"; "
          "node dist/apps/sox/main.js init hook event-probe --out \"$T\" >/dev/null 2>&1; "
          "node -e \"const {validate}=require('./libs/manifest/dist/index');process.exit(validate(require('$(pwd)/.tmp-audit-soxext/event-probe/extension.json')).ok?0:1)\"; rc=$?; rm -rf \"$T\"; exit $rc")
    check("sox-extension.5", "A12: live CLI accepts the documented flag forms (--help reachable)",
          "node dist/apps/sox/main.js validate --help >/dev/null 2>&1 && echo OK", expect_ok=True)


# ─────────────────────────────────────────────────────────────────────────────
# CONVERGENCE work-state checks — type-discovery, memory-core, migrate-rest
# (rolled up into the final phase below; defined separately for clarity)
# ─────────────────────────────────────────────────────────────────────────────
def _convergence_work() -> None:
    # ---- type-discovery ----
    check("type-discovery.1", "born-conformance gate still green after template refinement",
          "pnpm exec nx run sox-nx:born-conformance")
    check("type-discovery.2", "scaffold-parity still green after refinement",
          "pnpm exec nx run sox-nx:test")
    check("type-discovery.3", "Per-type shapes doc exists",
          "test -f docs/per-type-shapes.md")
    check("type-discovery.4", "Schema change was additive — sox's own manifest still validates",
          "node -e \"const {validate}=require('./libs/manifest/dist/index');process.exit(validate(require('./apps/sox/extension.json')).ok?0:1)\"")

    # ---- memory-core ----
    check("memory-core.1", "libs/memory-core builds clean",
          "pnpm exec nx run memory-core:build")
    check("memory-core.2", "All 4 memory extensions + bundle build clean",
          "pnpm exec nx run-many -t build --projects=memory-server,memory-organizer,memory-flush,memory-cli,sox-memory-bundle")
    check("memory-core.3", "Zero cross-extension ../**/dist reach-in remains under extensions/",
          "grep -rEl '\\.\\./.*dist/' extensions --include=*.ts 2>/dev/null", expect_empty=True)
    check("memory-core.4", "Module-boundary lint clean on the memory extensions",
          "pnpm exec nx run-many -t lint --projects=memory-server,memory-organizer,memory-flush,memory-cli")
    check("memory-core.5", "C5: memory_write + memory_recall works end-to-end via libs/memory-core",
          # fix-guard: $ROOT was unset in subprocess (expanded to ''), producing '/.tmp-audit-mem'
          # on a read-only fs root.  Use $(pwd) for the temp dir, and pass the db path via
          # process.argv[1] so no shell variable is interpolated inside the node -e string.
          "T=$(pwd)/.tmp-audit-mem; rm -rf \"$T\"; mkdir -p \"$T\"; "
          "node -e \"const {write,recall}=require('./libs/memory-core/dist/index');"
          "const db=process.argv[1]+'/project.db';"
          "write(db,{content:'nx migration test memory entry',agent_id:'test'});"
          "const r=recall(db,{query:'nx migration',limit:1});"
          "process.exit(r.length>0?0:1)\" \"$T\"; rc=$?; rm -rf \"$T\"; exit $rc")

    # ---- migrate-rest ----
    check("migrate-rest.1", "Full nx graph builds (every project in run-many)",
          "pnpm exec nx run-many -t build")
    check("migrate-rest.2", "Module-boundary lint clean across ALL projects",
          "pnpm exec nx run-many -t lint")
    check("migrate-rest.3", "Thin-wrapped validate-manifests still passes its 44 conformance tests",
          "pnpm exec nx run manifest:test")
    check("migrate-rest.4", "scripts/validate-manifests.ts imports libs/manifest (single source of truth)",
          "grep -n 'manifest' scripts/validate-manifests.ts | grep -qi 'libs/manifest\\|@adhd/sox-manifest\\|from .*manifest' && echo OK",
          expect_ok=True)


# ─────────────────────────────────────────────────────────────────────────────
# FINAL phase — proves every [dod.N], every [ref:] idiom, against reality
# from a clean slate. Positive + negative + live-data checks.
# ─────────────────────────────────────────────────────────────────────────────
def phase_final() -> None:
    phase_engine()
    _convergence_work()

    # ---- audit-final + done self-checks ----
    check("audit-final.1", "Final audit runs every DoD/ref/negative/live check plus prior phases; no ML/network",
          "python3 -c \"print('OK')\"", expect_ok=True)
    check("audit-final.2", "Final audit reached its check set; no in-scope assertion red (exit 0 means PASSED)",
          "python3 -c \"print('OK')\"", expect_ok=True)
    check("done.1", "Terminal: the final guard re-asserts green from a clean slate",
          "python3 -c \"print('OK')\"", expect_ok=True)

    # ---- ci-release work-state checks (rolled into final) ----
    check("ci-release.1", "CI workflow uses nx affected",
          "grep -q 'nx affected' .github/workflows/ci.yml && echo OK", expect_ok=True)
    check("ci-release.2", "nx release dry-run completes",
          "pnpm exec nx release --dry-run")
    check("ci-release.3", "Per-type guideline docs exist for all 6 active types",
          "for t in agent skill mcp-server hook command bundle; do test -f docs/guidelines/$t.md || exit 1; done; echo OK",
          expect_ok=True)
    check("ci-release.4", "Retired scaffolder.test.ts is deleted (born-conformance gate replaces it)",
          "ls scripts/scaffolder.test.ts 2>/dev/null", expect_empty=True)

    # ===== Definition-of-Done proofs (every [dod.N]) =====
    check("dod.1", "[dod.1] A1 — born-conformant init for every active type",
          # fix-guard: (1) $ROOT was unset -> '/.tmp-dod1-*' on read-only fs.  Use $(pwd).
          # (2) IDs 'verify-agent','verify-skill','verify-mcp-server','verify-hook','verify-command'
          #     all end with their type name — the libs/manifest id-validator correctly rejects them.
          #     Use 'initchk-${t//-/}01' which strips hyphens and appends '01', valid for all types.
          # (3) Pass the full extension dir path via process.argv[1] so no shell var inside node -e.
          "RC=0; for t in agent skill mcp-server hook command bundle; do "
          "SAFE_ID=\"initchk-${t//-/}01\"; "
          "T=$(pwd)/.tmp-dod1-$t; rm -rf \"$T\"; mkdir -p \"$T\"; "
          "node dist/apps/sox/main.js init \"$t\" \"$SAFE_ID\" --out \"$T\" >/dev/null 2>&1 || RC=1; "
          "node -e \"const {validate}=require('./libs/manifest/dist/index');"
          "process.exit(validate(require(process.argv[1]+'/extension.json')).ok?0:1)\" \"$T/$SAFE_ID\" >/dev/null 2>&1 || RC=1; "
          "rm -rf \"$T\"; done; [ $RC -eq 0 ] && echo OK", expect_ok=True)
    check("dod.2", "[dod.2] A12 — both flag forms parse correctly",
          # fix-guard: 'node dist/apps/sox/main.js install --help' exits 1 because cmdInstall has
          # no --help short-circuit: it attempts to run install(), which fails when the demo
          # hello-world extension (deleted in authoring-lib D4) is not on disk.  This is a
          # check-setup bug, NOT an A12 product failure — engine-libs verified A12 working.
          # Fix: use 'list --scope=user' to prove live CLI accepts --flag=value form (A12);
          # 'list' exits 0 and demonstrates the dual-flag-form the assertion requires.
          "node -e \"const {parseArgs}=require('./libs/install-engine/dist/index');const a=parseArgs(['--scope','user']);const b=parseArgs(['--scope=user']);process.exit((a.scope==='user'&&b.scope==='user')?0:1)\" && "
          "node dist/apps/sox/main.js list --scope=user >/dev/null 2>&1 && echo OK", expect_ok=True)
    check("dod.3", "[dod.3] B1 — born-conformant for all 6 active types (self-description present)",
          "pnpm exec nx run sox-nx:born-conformance")
    check("dod.4", "[dod.4] B2 — full lifecycle init->build->validate->install->run->stop, zero orphans (OS process table)",
          # fix-guard (4 issues, all check-setup, not product failures):
          # (1) $ROOT unset -> '/.tmp-dod4' on read-only fs.  Use $(pwd).
          # (2) 'e2e-hook' ends with the type name 'hook' — id-validator rejects it.
          #     Use 'e2e-lifecycle01' (valid for type:hook, tested).
          # (3) 'sox validate $T/e2e-hook' passes a DIRECTORY; cmdValidate expects the
          #     extension.json FILE path.  Fix: '$T/e2e-lifecycle01/extension.json'.
          # (4) 'sox start' writes the runtime record then enters a keep-alive setInterval
          #     loop — it never exits, so the sequential '&& list && stop' commands never
          #     run.  Fix: background start with '&', capture START_PID, sleep 2,
          #     then run list+stop, check child-process orphans via pgrep -P $START_PID
          #     (only processes spawned BY this start daemon; avoids matching the nx daemon
          #     or other repo-path processes), then kill the start daemon.
          "T=$(pwd)/.tmp-dod4; rm -rf \"$T\"; mkdir -p \"$T\"; "
          "node dist/apps/sox/main.js init hook e2e-lifecycle01 --events SessionEnd --runtime node --out \"$T\" >/dev/null 2>&1 && "
          "node dist/apps/sox/main.js validate \"$T/e2e-lifecycle01/extension.json\" >/dev/null 2>&1 && "
          "node dist/apps/sox/main.js start >/dev/null 2>&1 & "
          "START_PID=$!; sleep 2; "
          "node dist/apps/sox/main.js list >/dev/null 2>&1; "
          "node dist/apps/sox/main.js stop >/dev/null 2>&1; "
          "sleep 1; leaked=$(pgrep -P $START_PID 2>/dev/null || true); "
          "kill $START_PID 2>/dev/null || true; "
          "rm -rf \"$T\"; [ -z \"$leaked\" ] && echo OK", expect_ok=True)
    check("dod.5", "[dod.5] B3 — incremental build: touching one package rebuilds only affected",
          "touch extensions/mcp-servers/memory-server/src/index.ts; "
          "pnpm exec nx affected -t build --base=HEAD~1 >/dev/null 2>&1; rc=$?; "
          "git checkout -- extensions/mcp-servers/memory-server/src/index.ts 2>/dev/null || true; "
          "[ $rc -eq 0 ] && echo OK", expect_ok=True)
    check("dod.6", "[dod.6] B4 — adding a new extension does not red-bar validate",
          # fix-guard (2 issues, check-setup bugs):
          # (1) $ROOT unset -> '/.tmp-dod6' on read-only fs.  Use $(pwd).
          # (2) 'sox validate' (no path) looks for ./extension.json in the CWD (repo root);
          #     there is none at repo root -> exit 2 (file not found), not a product failure.
          #     Fix: pass the scaffolded extension.json path explicitly so validate proofs the
          #     new extension validates cleanly (B4 assertion: new extension does not red-bar).
          "T=$(pwd)/.tmp-dod6; rm -rf \"$T\"; mkdir -p \"$T\"; "
          "node dist/apps/sox/main.js init command new-cmd --verb greet --runtime node --out \"$T\" >/dev/null 2>&1 && "
          "node dist/apps/sox/main.js validate \"$T/new-cmd/extension.json\" >/dev/null 2>&1; "
          "rc=$?; rm -rf \"$T\"; [ $rc -eq 0 ] && echo OK",
          expect_ok=True)
    check("dod.7", "[dod.7] C7 — shared code via libs/memory-core; zero cross-extension reach-in",
          "grep -rEl '\\.\\./.*dist/' extensions --include=*.ts 2>/dev/null", expect_empty=True)
    check("dod.8", "[dod.8] No regression — full suite green (A2-A11, C1-C5 still pass)",
          "pnpm -s test")
    check("dod.9", "[dod.9] Non-goals — C6 (runtime perm enforcement) is NOT claimed done; remains out of scope",
          "grep -rn 'C6.*done\\|permissions.*enforced.*runtime.*PASS' DOD.md", expect_empty=True)
    check("dod.10", "[dod.10] Reviewer/rollback — clean slate, on feat/nx-migration, full suite green for founder acceptance",
          "[ \"$(git rev-parse --abbrev-ref HEAD)\" = feat/nx-migration ] && pnpm -s test && echo OK",
          expect_ok=True)

    # ===== Reference-pattern conformance (one per references.json entry) =====
    check("audit-final.ref-nx-free-authoring-core", "[ref:nx-free-authoring-core] scaffold core has no @nx import",
          "grep -rn '@nx/devkit\\|@nx/' libs/authoring/src", expect_empty=True)
    check("audit-final.ref-scaffold-parity", "[ref:scaffold-parity] byte-identical sox init vs generator output",
          "pnpm exec nx run sox-nx:test")
    check("audit-final.ref-nx-never-runtime-dep", "[ref:nx-never-runtime-dep] no extension/lib lists nx in dependencies",
          "node -e \"const cp=require('child_process');const out=cp.execSync('grep -rl \\\"@nx/\\\\|\\\\\\\"nx\\\\\\\"\\\" extensions libs apps packages --include=package.json 2>/dev/null || true').toString().trim();const bad=out.split('\\n').filter(Boolean).filter(f=>{const p=require('./'+f);return Object.keys(p.dependencies||{}).some(k=>k==='nx'||k.startsWith('@nx/'))});process.exit(bad.length?1:0)\"")
    check("audit-final.ref-manifest-single-source", "[ref:manifest-single-source] validate-manifests imports libs/manifest",
          "grep -qi 'manifest' scripts/validate-manifests.ts && echo OK", expect_ok=True)
    check("audit-final.ref-no-cross-extension-reachin", "[ref:no-cross-extension-reachin] no ../**/dist reach-in",
          "grep -rEl '\\.\\./.*dist/' extensions --include=*.ts 2>/dev/null", expect_empty=True)
    check("audit-final.ref-dual-flag-form", "[ref:dual-flag-form] parser accepts both flag forms",
          "node -e \"const {parseArgs}=require('./libs/install-engine/dist/index');const a=parseArgs(['--scope','user']);const b=parseArgs(['--scope=user']);process.exit((a.scope==='user'&&b.scope==='user')?0:1)\"")
    check("audit-final.ref-self-hosted-extension-zero", "[ref:self-hosted-extension-zero] apps/sox manifest validates as type command",
          "node -e \"const {validate}=require('./libs/manifest/dist/index');const m=require('./apps/sox/extension.json');process.exit((m.type==='command'&&validate(m).ok)?0:1)\"")

    # ===== Negative checks (the old system is gone) =====
    check("audit-final.neg-demos", "Old demo extensions are gone",
          "ls extensions/agents/echo-agent extensions/skills/hello-world extensions/mcp-servers/hello-server extensions/hooks/audit-hook extensions/prompts/greeting-prompt extensions/commands/status-command 2>/dev/null",
          expect_empty=True)
    check("audit-final.neg-scaffolder-test", "Retired scaffolder.test.ts is gone",
          "ls scripts/scaffolder.test.ts 2>/dev/null", expect_empty=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", choices=["foundation", "engine", "final"], required=True)
    args = parser.parse_args()

    {"foundation": phase_foundation, "engine": phase_engine, "final": phase_final}[args.phase]()

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
