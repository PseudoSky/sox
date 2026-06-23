#!/usr/bin/env python3
"""audit_eim.py — structured checklist runner for the Extension Install &
Reinjection Model migration.

Phase-cumulative: each --phase runs all checks for that phase PLUS every prior
phase. Exits with the count of failures (0 = all pass). Read-only over source —
fixes happen in source files, never by weakening a check.

Usage:
    python3 scripts/audit_eim.py --phase foundation
    python3 scripts/audit_eim.py --phase enforcement
    python3 scripts/audit_eim.py --phase final

CONTRACT (gap-check / env-pin enforce):
  - Every acceptance criterion [<slug>.n] in contexts/<slug>.md has a check()
    with that EXACT id here (gap-check Check 3).
  - Every references.json idiom has its [audit-final.ref-<slug>] check (Check 7).
  - Every Definition-of-Done clause [dod.1]..[dod.13] in README.md has a check
    whose id literally contains that clause id (Check 8).
  - _run prepends the repo-local node_modules/.bin to PATH so a bare `nx`
    resolves deterministically in this subprocess (a real C6 failure was a 127
    from an unaugmented PATH — do NOT remove the augmentation).
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys

# ── Repo-root + PATH augmentation ───────────────────────────────────────────
# This script lives at <repo>/.workflow/plans/extension-install-model/scripts/.
# Compute the repo root from the script path (4 levels up) and prepend its
# node_modules/.bin so a bare `nx` (or any local CLI) resolves in this clean
# subprocess instead of exiting 127.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(_SCRIPT_DIR, "..", "..", "..", ".."))
_LOCAL_BIN = os.path.join(REPO_ROOT, "node_modules", ".bin")


def _env_with_local_bin() -> dict[str, str]:
    env = dict(os.environ)
    env["PATH"] = _LOCAL_BIN + os.pathsep + env.get("PATH", "")
    return env


def _run(cmd: str) -> tuple[int, str]:
    """Run a shell command from the repo root with node_modules/.bin on PATH.

    Returns (returncode, combined stdout+stderr). cwd is pinned to REPO_ROOT so
    every grep/test path in a check is repo-relative regardless of caller cwd.
    """
    r = subprocess.run(
        cmd,
        shell=True,
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        env=_env_with_local_bin(),
    )
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
            f"[{criterion_id}] FAIL: expected empty output, got:\n  {out[:200]}\n"
            f"  Fix: {description}"
        )
    elif expect_ok and "OK" not in out:
        failures.append(
            f"[{criterion_id}] FAIL: expected OK, got:\n  {out[:200]}\n"
            f"  Fix: {description}"
        )
    elif not expect_empty and not expect_ok and code != 0:
        failures.append(
            f"[{criterion_id}] FAIL:\n  {out[:200]}\n"
            f"  Fix: {description}"
        )


# ═════════════════════════════════════════════════════════════════════════════
# Phase: FOUNDATION — schema-delta, capability-engine, host-registry
# ═════════════════════════════════════════════════════════════════════════════
def phase_foundation() -> None:
    # ---- schema-delta ----
    check(
        "schema-delta.1",
        "schema.json must declare hybrid install-descriptor fields (profiles/serves/source)",
        "grep -nE '\"(profiles|serves|source)\"' libs/manifest/src/schema.json",
    )
    check(
        "schema-delta.2",
        "validate must reject lifecycle on type:agent + manifest tests cover it [dod.6]",
        "grep -n 'lifecycle' libs/manifest/src/index.ts && nx run manifest:test",
    )
    check(
        "schema-delta.3",
        "validate must enforce profiles ⊆ serves",
        "grep -nE 'serves|profiles' libs/manifest/src/index.ts",
    )
    check(
        "schema-delta.4",
        "validate must refuse managed (claude) / project-forbidden (codex) keys [inv:never-managed]",
        "nx run manifest:test",
    )
    check(
        "schema-delta.5",
        "Back-compat: non-agent manifests still validate; manifest build is green",
        "nx run manifest:build",
    )

    # ---- capability-engine ----
    check(
        "capability-engine.1",
        "All six capability modules export apply/reverse/update/verify",
        "for f in file-drop config-merge array-merge bin-link run-service materialize; do "
        "grep -lqE 'apply|reverse|update|verify' libs/install-engine/src/capabilities/$f.ts || exit 1; done",
    )
    check(
        "capability-engine.2",
        "config-merge is format-aware (json AND toml) [inv:format-aware-merge]",
        "grep -niE 'toml' libs/install-engine/src/capabilities/config-merge.ts",
    )
    check(
        "capability-engine.3",
        "config-merge/array-merge record a ledger action; reverse is exact [inv:ledger-reversible]",
        "grep -nE 'ledger' libs/install-engine/src/capabilities/config-merge.ts "
        "libs/install-engine/src/capabilities/array-merge.ts",
    )
    check(
        "capability-engine.4",
        "ledger.ts exists with reverse/action support; project ledger is portable",
        "grep -nE 'reverse|action' libs/install-engine/src/ledger.ts",
    )
    check(
        "capability-engine.5",
        "Capabilities are idempotent (covered by install-engine:test double-apply)",
        "nx run install-engine:test",
    )

    # ---- host-registry ----
    check(
        "host-registry.1",
        "Two host modules ship detect/scopePaths/surfaces",
        "for h in claude codex; do "
        "grep -lqE 'detect|scopePaths|surfaces' libs/host-registry/src/$h.ts || exit 1; done",
    )
    check(
        "host-registry.2",
        "Literal host paths live in libs/host-registry (here, by design) [ref:host-keyed-target]",
        "grep -nE '\\.claude|\\.codex' libs/host-registry/src/claude.ts libs/host-registry/src/codex.ts",
    )
    check(
        "host-registry.3",
        "Codex module encodes project-forbidden keys [inv:never-managed]",
        "grep -nE 'model_providers|notify|profile|otel' libs/host-registry/src/codex.ts",
    )
    check(
        "host-registry.4",
        "Claude module never-managed guard present; host-registry tests assert no managed path",
        "grep -niE 'managed' libs/host-registry/src/claude.ts && nx run host-registry:test",
    )
    check(
        "host-registry.5",
        "P0.6 codex skills/plugin paths verified + recorded",
        "grep -niE 'P0.6|skills path|agents/skills' "
        "libs/host-registry/src/codex.ts libs/host-registry/src/host-registry.spec.ts",
    )


# ═════════════════════════════════════════════════════════════════════════════
# Phase: ENFORCEMENT — mcp-runtime, install-lifecycle, generators,
#                      rehome-memory-server
# ═════════════════════════════════════════════════════════════════════════════
def phase_enforcement() -> None:
    phase_foundation()  # cumulative — always run prior phases first.

    # ---- mcp-runtime ----
    check(
        "mcp-runtime.1",
        "serve() author API wraps the official @modelcontextprotocol/sdk (no reimpl)",
        "grep -nE 'serve|defineTool' libs/mcp-runtime/src/serve.ts && "
        "grep -nE '@modelcontextprotocol/sdk' libs/mcp-runtime/src/*.ts",
    )
    check(
        "mcp-runtime.2",
        "Dual transport (stdio + sse/http) selected by flag/env",
        "grep -niE 'stdio|sse|http' libs/mcp-runtime/src/transport.ts",
    )
    check(
        "mcp-runtime.3",
        "C6 enforcement reads policy-env at the sink on every path [inv:c6-holds] [ref:policy-env-enforce]",
        "grep -nE 'compilePolicyFromEnv' libs/mcp-runtime/src/enforce.ts && nx run mcp-runtime:test",
    )
    check(
        "mcp-runtime.4",
        "One generic conformance test (initialize + tools/list) exists",
        "grep -nqE 'initialize|tools/list' libs/mcp-runtime/src/conformance.spec.ts",
    )
    check(
        "mcp-runtime.5",
        "serves is derived from building on the wrapper",
        "grep -niE 'serves' libs/mcp-runtime/src/index.ts",
    )

    # ---- install-lifecycle ----
    check(
        "install-lifecycle.1",
        "install/lifecycle/diff modules exist and are wired",
        "for f in install lifecycle diff; do test -f libs/install-engine/src/$f.ts || exit 1; done",
    )
    check(
        "install-lifecycle.2",
        "Declarative install→diff→update→uninstall on the real FS [dod.1][dod.5]",
        "nx run host-runtime:test-e2e",
    )
    check(
        "install-lifecycle.3",
        "Old single-string install-target consumer gone from main.ts",
        "grep -nE 'install-target' apps/sox/src/main.ts",
        expect_empty=True,
    )
    check(
        "install-lifecycle.4",
        "sox diff / sox update exist with --host/--profile/--scope/--trust",
        "grep -nE 'diff|update' bin/sox apps/sox/src/main.ts",
    )
    check(
        "install-lifecycle.5",
        "A capability that cannot cleanly reverse aborts [dod.12]",
        "grep -niE 'abort|cannot.*reverse|reversib' libs/install-engine/src/lifecycle.ts",
    )

    # ---- generators ----
    check(
        "generators.1",
        "nx generator schema exposes the Appendix-A options",
        "grep -nE 'content|from|inject|profile|mode|surface|transports|trust' "
        "packages/sox-nx/src/generators/extension/schema.json",
    )
    check(
        "generators.2",
        "init emits the hybrid install descriptor (covered by authoring:test)",
        "nx run authoring:test",
    )
    check(
        "generators.3",
        "--content @source fills body + stamps source: provenance [dod.7]",
        "grep -niE 'source|content' packages/sox-nx/src/generators/extension/extension.ts && "
        "nx run sox-nx:test",
    )
    check(
        "generators.4",
        "Born-conformant + byte-identical (sox init ⇄ nx) [ref:born-conformant-scaffold]",
        "nx run sox-nx:test && nx run authoring:test",
    )
    check(
        "generators.5",
        "All six type templates accept the new options",
        "for t in mcp-server agent skill command hook prompt; do "
        "test -f libs/authoring/src/templates/$t/index.ts || exit 1; done",
    )

    # ---- rehome-memory-server ----
    check(
        "rehome-memory-server.1",
        "memory-server uses serve() from @adhd/sox-mcp-runtime",
        "grep -nE 'serve|@adhd/sox-mcp-runtime' extensions/mcp-servers/memory-server/src/index.ts",
    )
    check(
        "rehome-memory-server.2",
        "Vendored guard symbols GONE from the extension [dod.6]",
        "grep -rn 'checkDbPathPolicy\\|getPolicy\\|handleToolCall' "
        "extensions/mcp-servers/memory-server/src/",
        expect_empty=True,
    )
    check(
        "rehome-memory-server.3",
        "No vendored compilePolicyFromEnv copy remains in the extension [dod.6]",
        "grep -rn 'compilePolicyFromEnv' extensions/mcp-servers/memory-server/src/",
        expect_empty=True,
    )
    check(
        "rehome-memory-server.4",
        "extension.json declares @adhd/sox-mcp-runtime",
        "grep -nE 'mcp-runtime' extensions/mcp-servers/memory-server/extension.json",
    )
    check(
        "rehome-memory-server.5",
        "Behavior + C6 reality check unchanged [inv:no-regress][inv:c6-holds]",
        "nx run host-runtime:test-e2e",
    )


# ═════════════════════════════════════════════════════════════════════════════
# Phase: FINAL — convergence criteria + DoD proofs + reference conformance + live
# ═════════════════════════════════════════════════════════════════════════════
def phase_final() -> None:
    phase_enforcement()  # cumulative — runs foundation + enforcement first.

    # ---- convergence: ingestion-skill ----
    check(
        "ingestion-skill.1",
        "sox-ingest skill exists with SKILL.md + manifest + references [dod.13]",
        "test -f extensions/skills/sox-ingest/SKILL.md && "
        "test -f extensions/skills/sox-ingest/extension.json && "
        "test -f extensions/skills/sox-ingest/references/by-type.md && "
        "test -f extensions/skills/sox-ingest/references/by-operation.md",
    )
    check(
        "ingestion-skill.2",
        "Legacy ingestion prompts + migration-plan GONE [dod.13]",
        "test ! -d docs/ingestion/prompts && test ! -e docs/ingestion/migration-plan.md",
    )
    check(
        "ingestion-skill.3",
        "SKILL.md encodes the full flow + delegates to references/",
        "grep -niE 'initialize|generalize|validate|publish|install|enable|remove' "
        "extensions/skills/sox-ingest/SKILL.md && "
        "grep -nE 'references/' extensions/skills/sox-ingest/SKILL.md",
    )
    check(
        "ingestion-skill.4",
        "Born-conformant declarative skill; install descriptor present [dod.1]",
        "nx run-many -t lint && grep -nE 'install' extensions/skills/sox-ingest/extension.json",
    )

    # ---- convergence: dod-reconcile ----
    check(
        "dod-reconcile.1",
        "DOD.md splits B2 run into process vs placed/declarative [dod.9]",
        "grep -niE 'placed|declarative' DOD.md",
    )
    check(
        "dod-reconcile.2",
        "CLAUDE.md status reflects the split run bar [dod.9]",
        "grep -niE 'placed' CLAUDE.md",
    )

    # ─────────────────────────────────────────────────────────────────────────
    # Definition-of-Done proofs. Each check id literally contains its [dod.N]
    # clause id so gap-check Check 8 maps every clause to a check. POSITIVE +
    # NEGATIVE + LIVE kinds are spread across these.
    # ─────────────────────────────────────────────────────────────────────────
    check(
        "dod.1",
        "[dod.1] Declarative reinjection end-to-end (claude project+user, codex) — real FS e2e",
        # non-vacuous: the e2e must actually exercise declarative placement + codex, not just memory-server
        "grep -q '.claude/agents' tools/test-e2e-lifecycle.js && "
        "grep -qiE 'codex' tools/test-e2e-lifecycle.js && "
        "nx run host-runtime:test-e2e",
    )
    check(
        "dod.2",
        "[dod.2] mcp stdio (.mcp.json, --trust prompt) AND sox service; undeclared access denied (C6)",
        # non-vacuous: the e2e must exercise the stdio-in-.mcp.json path, not only the sox-service path
        "grep -q '.mcp.json' tools/test-e2e-lifecycle.js && "
        "nx run mcp-runtime:test && nx run host-runtime:test-e2e",
    )
    check(
        "dod.3",
        "[dod.3] Six capabilities apply/reverse/update/verify, idempotent, scope+host-aware",
        "for f in file-drop config-merge array-merge bin-link run-service materialize; do "
        "grep -lqE 'apply' libs/install-engine/src/capabilities/$f.ts || exit 1; done && "
        "nx run install-engine:test",
    )
    check(
        "dod.4",
        "[dod.4] Host registry ships claude + codex; detection + forbidden-key refusal",
        "test -f libs/host-registry/src/claude.ts && test -f libs/host-registry/src/codex.ts && "
        "nx run host-registry:test",
    )
    check(
        "dod.5",
        "[dod.5] Provenance ledger drives diff/uninstall; reverse leaves foreign keys untouched",
        "grep -nE 'reverse|action' libs/install-engine/src/ledger.ts && nx run install-engine:test",
    )
    # NEGATIVE: the old system must be gone.
    check(
        "dod.6",
        "[dod.6] Old system gone — install-target consumer + memory vendored guard absent (grep empty)",
        "grep -rn 'checkDbPathPolicy\\|getPolicy' extensions/mcp-servers/memory-server/src/ ; "
        "grep -n 'install-target' apps/sox/src/main.ts",
        expect_empty=True,
    )
    check(
        "dod.7",
        "[dod.7] Generators expose Appendix-A options; --content @source stamps source provenance",
        "grep -niE 'source|content' packages/sox-nx/src/generators/extension/extension.ts && "
        "nx run sox-nx:test",
    )
    check(
        "dod.8",
        "[dod.8] No regression — nx run-many build,lint,test + C6 e2e + memory-* green",
        "nx run-many -t build,lint,test && nx run host-runtime:test-e2e && "
        "nx run memory-server:test",
    )
    check(
        "dod.9",
        "[dod.9] DoD reconciled — DOD.md/CLAUDE.md split run(process)/placed(declarative)",
        "grep -q 'placed' DOD.md && grep -q 'placed' CLAUDE.md",
    )
    # NEGATIVE (boundary): no check may assert the foreign host executed content.
    check(
        "dod.10",
        "[dod.10] Non-goals/boundary — no audit check claims the foreign host executed content [inv:boundary]",
        "grep -n 'host executed' scripts/audit_eim.py 2>/dev/null || true",
        expect_empty=True,
    )
    check(
        "dod.11",
        "[dod.11] Reviewer=founder — final audit exits 0 (proof object); founder approval is the gate",
        "echo OK",
        expect_ok=True,
    )
    check(
        "dod.12",
        "[dod.12] Rollback — a capability that cannot cleanly reverse aborts",
        "grep -niE 'abort|cannot.*reverse|reversib' libs/install-engine/src/lifecycle.ts",
    )
    # NEGATIVE (file-existence): skill present + legacy docs gone. The actual
    # swarm-cost ingest DRIVEN BY THE SKILL is a MANUAL founder-review step
    # ([dod.11] checklist) — not machine-run here (an LLM-driven skill run can't
    # be scripted deterministically). Do not overclaim it as a live check.
    check(
        "dod.13",
        "[dod.13] Ingestion skill replaces docs/ingestion (skill present + legacy docs gone); live swarm-cost ingest verified manually at founder review",
        "test -d extensions/skills/sox-ingest && test ! -d docs/ingestion/prompts && "
        "test ! -e docs/ingestion/migration-plan.md",
    )

    # ─────────────────────────────────────────────────────────────────────────
    # Reference conformance — one check per references.json idiom. The check id
    # matches each idiom's audit_check [audit-final.ref-<slug>] (gap-check 7).
    # ─────────────────────────────────────────────────────────────────────────
    check(
        "audit-final.ref-ledger-reversible",
        "[ref:ledger-reversible] config/array merges record a ledger action + reverse exactly",
        "grep -nE 'ledger' libs/install-engine/src/capabilities/config-merge.ts "
        "libs/install-engine/src/capabilities/array-merge.ts libs/install-engine/src/ledger.ts && "
        "nx run install-engine:test",
    )
    check(
        "audit-final.ref-host-keyed-target",
        "[ref:host-keyed-target] No literal host-discovery path outside libs/host-registry",
        "grep -rnE \"['\\\"](~?/?\\.(claude|codex)[/'\\\"]|~/.claude|~/.codex)\" "
        "libs/install-engine/src apps/sox/src packages/sox-nx/src libs/authoring/src "
        "--include='*.ts' | grep -v 'libs/host-registry' || true",
        expect_empty=True,
    )
    check(
        "audit-final.ref-config-merge-format",
        "[ref:config-merge-format] Host configs read/written only via config-merge (json+toml)",
        "grep -rnE 'writeFileSync' libs/install-engine/src --include='*.ts' "
        "| grep -iE 'settings\\.json|\\.mcp\\.json|claude\\.json|config\\.toml' "
        "| grep -v 'config-merge' || true",
        expect_empty=True,
    )
    check(
        "audit-final.ref-policy-env-enforce",
        "[ref:policy-env-enforce] Every mcp spawn path enforces policy-env at the sink",
        "grep -nE 'compilePolicyFromEnv' libs/mcp-runtime/src/enforce.ts && nx run mcp-runtime:test",
    )
    check(
        "audit-final.ref-born-conformant-scaffold",
        "[ref:born-conformant-scaffold] sox init ⇄ nx byte-identical via the single scaffolder",
        "nx run sox-nx:test && nx run authoring:test",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--phase",
        choices=["foundation", "enforcement", "final"],
        required=True,
    )
    args = parser.parse_args()

    phase_fn = {
        "foundation": phase_foundation,
        "enforcement": phase_enforcement,
        "final": phase_final,
    }[args.phase]

    phase_fn()

    phase_label = args.phase.upper()
    if failures:
        print(f"\n{phase_label} AUDIT FAILED: {len(failures)} criterion/criteria:\n")
        for f in failures:
            print(f)
        sys.exit(len(failures))
    else:
        print(f"\n{phase_label} AUDIT PASSED: all criteria verified.")
        sys.exit(0)


if __name__ == "__main__":
    main()
