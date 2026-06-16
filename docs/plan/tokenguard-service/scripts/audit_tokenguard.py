#!/usr/bin/env python3
"""audit_tokenguard.py — structured checklist runner for the tokenguard-service plan.

Phases (each --phase runs its own checks; service/final also run prior phases):
    framework  → service-type, http-transport, mcp-as-service
    core       → core-engine, core-invariants            (standalone; parallel track)
    service    → framework + core + tg-service, tg-cli
    final      → service + decouple-generalize, code-review, every [dod.N], every [ref:]

Exits with the count of failures (0 = all pass). Each check() emits a
`[id] PASS`/`[id] FAIL` line — the orchestrator confirms each [dod.N] by its PASS.

EVIDENCE LADDER: behavioral [dod.N] checks are tier 3 — they drive the documented
entrypoint (a sox-CLI harness or the demo) and assert the real observable.
Structural clauses (old-is-gone / conformance) are grep/AST by nature.
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
    code, out = _run(cmd)
    failed = (
        (expect_empty and bool(out))
        or (expect_ok and "OK" not in out)
        or (not expect_empty and not expect_ok and code != 0)
    )
    if failed:
        print(f"[{criterion_id}] FAIL")
        failures.append(f"[{criterion_id}] FAIL:\n  {out[:200]}\n  Fix: {description}")
    else:
        print(f"[{criterion_id}] PASS")


# ─────────────────────────────────────────────────────────────────────────────
# Phase: framework
# ─────────────────────────────────────────────────────────────────────────────
def phase_framework() -> None:
    # ---- service-type ----
    check("service-type.1", "service in VALID_TYPES (manifest + new-extension script)",
          "grep -lq \"'service'\\|\\\"service\\\"\" libs/manifest/src/index.ts && grep -lq \"service\" scripts/new-extension.ts && echo OK", expect_ok=True)
    check("service-type.2", "ManifestInstall declares a transports field + service in unions",
          "grep -q 'transports' libs/manifest/src/index.ts && echo OK", expect_ok=True)
    check("service-type.3", "validate() constrains transports vocabulary (unit test in manifest project)",
          "npx --yes nx test manifest && echo PASS")
    check("service-type.4", "serviceTemplate exists + scaffold dispatch includes service",
          "grep -q 'serviceTemplate' libs/authoring/src/index.ts && echo OK", expect_ok=True)
    check("service-type.5", "docs/guidelines/service.md exists",
          "test -f docs/guidelines/service.md && echo OK", expect_ok=True)
    check("service-type.6", "scaffold harness drives sox init service",
          "grep -q 'init service' tools/tg-plan/check-service-scaffold.sh && echo OK", expect_ok=True)

    # ---- http-transport ----
    check("http-transport.1", "http-get health type recognized by supervisor",
          "grep -q 'http-get' libs/host-runtime/src/supervisor.ts && echo OK", expect_ok=True)
    check("http-transport.2", "http probe unit test (live vs dead port) passes",
          "npx --yes nx test host-runtime && echo PASS")
    check("http-transport.3", "http/service install routes through run-service",
          "grep -qE 'run-service|runServiceApply|runService' libs/install-engine/src/install.ts && echo OK", expect_ok=True)
    check("http-transport.4", "service surface present in host-registry",
          "grep -q 'service' libs/host-registry/src/claude.ts && echo OK", expect_ok=True)
    check("http-transport.5", "http-service harness asserts zero orphans on stop",
          "grep -q 'orphans=0' tools/tg-plan/check-http-service.sh && echo OK", expect_ok=True)

    # ---- mcp-as-service ----
    check("mcp-as-service.1", "mcp-server handled as service[transport=stdio]",
          "grep -q 'stdio' libs/manifest/src/index.ts && echo OK", expect_ok=True)
    check("mcp-as-service.2", "mcp-server install routes through unified run-service",
          "grep -qE 'run-service|runServiceApply' libs/install-engine/src/install.ts && echo OK", expect_ok=True)
    check("mcp-as-service.3", "mcpServerTemplate emits transports for stdio",
          "grep -q 'transports' libs/authoring/src/templates/mcp-server/index.ts && echo OK", expect_ok=True)
    check("mcp-as-service.4", "mcp-server guidelines state the service[stdio] relationship",
          "grep -q 'service' docs/guidelines/mcp-server.md && echo OK", expect_ok=True)
    check("mcp-as-service.5", "memory non-regress harness exercises lifecycle + C6 denial",
          "grep -q 'C6 DENY OK' tools/tg-plan/check-memory-nonregress.sh && echo OK", expect_ok=True)


# ─────────────────────────────────────────────────────────────────────────────
# Phase: core (standalone — parallel to framework)
# ─────────────────────────────────────────────────────────────────────────────
def phase_core() -> None:
    # ---- core-engine ----
    check("core-engine.1", "engine builds + exports the Mapper",
          "grep -qE 'class Mapper|export' libs/tokenguard-core/src/mapper.ts && echo OK", expect_ok=True)
    check("core-engine.2", "request scoping covers system/messages/metadata",
          "grep -q 'metadata' libs/tokenguard-core/src/tokenize.ts && echo OK", expect_ok=True)
    check("core-engine.3", "SSE reassembly present (not flat replacement)",
          "grep -qE 'detokenizeSse|delta' libs/tokenguard-core/src/sse.ts && echo OK", expect_ok=True)
    check("core-engine.4", "WOP engagement vocabulary absent from the lib",
          "grep -rniE 'engagement|roe' libs/tokenguard-core/src", expect_empty=True)
    check("core-engine.5", "tokenguard-core is a buildable nx project",
          "test -f libs/tokenguard-core/project.json && echo OK", expect_ok=True)

    # ---- core-invariants ----
    check("core-invariants.1", "round-trip exactness asserted",
          "grep -qE 'toBe|toEqual' libs/tokenguard-core/test/roundtrip.spec.ts && echo OK", expect_ok=True)
    check("core-invariants.2", "zero-leak wire guarantee asserted (tools untouched)",
          "grep -qE 'wireLeaks|tools' libs/tokenguard-core/test/roundtrip.spec.ts && echo OK", expect_ok=True)
    check("core-invariants.3", "SSE split-token reassembly asserted",
          "grep -qE 'delta|split' libs/tokenguard-core/test/sse.spec.ts && echo OK", expect_ok=True)
    check("core-invariants.4", "bijective + reload-stable cache asserted",
          "grep -qE 'reload|bijective|getOrCreate' libs/tokenguard-core/test/mapper.spec.ts && echo OK", expect_ok=True)
    check("core-invariants.5", "invariant suite runs as the nx test target",
          "npx --yes nx test tokenguard-core && echo PASS")


# ─────────────────────────────────────────────────────────────────────────────
# Phase: service
# ─────────────────────────────────────────────────────────────────────────────
def phase_service() -> None:
    phase_framework()
    phase_core()

    # ---- tg-service ----
    check("tg-service.1", "extension is type:service transport http, born-conformant",
          "grep -qE '\"service\"|http' extensions/services/tokenguard/extension.json && echo OK", expect_ok=True)
    check("tg-service.2", "service consumes the engine via package scope (no reach-in)",
          "grep -q '@sox/tokenguard-core' extensions/services/tokenguard/package.json && echo OK", expect_ok=True)
    check("tg-service.3", "config flows only through SOX_CONFIG_*",
          "grep -q 'SOX_CONFIG_' extensions/services/tokenguard/src/config.ts && echo OK", expect_ok=True)
    check("tg-service.4", "both provider adapters exist",
          "test -f extensions/services/tokenguard/src/adapters/anthropic.ts && test -f extensions/services/tokenguard/src/adapters/generic.ts && echo OK", expect_ok=True)
    check("tg-service.5", "permissions enforced at the resource sink",
          "grep -qE 'SOX_POLICY_|policy' extensions/services/tokenguard/src/index.ts && echo OK", expect_ok=True)
    check("tg-service.6", "demo harness asserts round-trip + zero leaks",
          "grep -qE 'ROUNDTRIP OK|LEAKS 0' extensions/services/tokenguard/demo/proxy-roundtrip.sh && echo OK", expect_ok=True)

    # ---- tg-cli ----
    check("tg-cli.1", "CLI exposes seed/map/summary",
          "grep -qE 'seed|map|summary' extensions/services/tokenguard/src/cli.ts && echo OK", expect_ok=True)
    check("tg-cli.2", "single shared map store",
          "grep -qE 'mapstore|token-mapping' extensions/services/tokenguard/src/mapstore.ts && echo OK", expect_ok=True)
    check("tg-cli.3", "running proxy reloads on seed change",
          "grep -qE 'watch|nudge|reload|socket' extensions/services/tokenguard/src/mapstore.ts && echo OK", expect_ok=True)
    check("tg-cli.4", "CLI reachable through sox exec",
          "grep -qE 'exec|argv' extensions/services/tokenguard/src/cli.ts && echo OK", expect_ok=True)
    check("tg-cli.5", "live-seed demo asserts reflection",
          "grep -q 'LIVE SEED REFLECTED' extensions/services/tokenguard/demo/live-seed.sh && echo OK", expect_ok=True)


# ─────────────────────────────────────────────────────────────────────────────
# Phase: final — every [dod.N], every [ref:], decoupling + reviewer
# ─────────────────────────────────────────────────────────────────────────────
def phase_final() -> None:
    phase_service()

    # ---- decouple-generalize ----
    check("decouple-generalize.1", "zero WOP vocabulary/paths in shipped source",
          "grep -rniE 'roe|engagement|labtarget|limabar|workspace/engagements|red.?team' libs/tokenguard-core/src extensions/services/tokenguard/src", expect_empty=True)
    check("decouple-generalize.2", "generic provider-agnostic usage documented (>=2 base-URL vars)",
          "grep -qiE 'BASE_URL' extensions/services/tokenguard/README.md && echo OK", expect_ok=True)
    check("decouple-generalize.3", "no provider hostname hard-coded in the engine",
          "grep -rniE 'anthropic\\.com|openai\\.com' libs/tokenguard-core/src", expect_empty=True)

    # ---- code-review ----
    check("code-review.1", "code-review.md present with VERDICT: PASS",
          "grep -q 'VERDICT: PASS' docs/plan/tokenguard-service/code-review.md && echo OK", expect_ok=True)
    check("code-review.2", "cross-project typecheck/lint/test gate recorded green",
          "grep -q 'run-many' docs/plan/tokenguard-service/code-review.md && echo OK", expect_ok=True)

    # ---- Definition of Done (behavioral = tier 3 through the entrypoint) ----
    check("dod.1", "scaffold a new service via the CLI and validate it",
          "bash tools/tg-plan/check-service-scaffold.sh | grep -q 'SCAFFOLD OK' && echo OK", expect_ok=True)
    check("dod.2", "start an http service, see it healthy, stop it with zero orphans",
          "bash tools/tg-plan/check-http-service.sh > /tmp/tg_http.out 2>&1; grep -q 'HTTP SERVICE HEALTHY' /tmp/tg_http.out && grep -q 'STOPPED CLEAN orphans=0' /tmp/tg_http.out && echo OK", expect_ok=True)
    check("dod.3", "memory service non-regression incl. C6 denial",
          "bash tools/tg-plan/check-memory-nonregress.sh > /tmp/tg_mem.out 2>&1; grep -q 'MEMORY OK' /tmp/tg_mem.out && grep -q 'C6 DENY OK' /tmp/tg_mem.out && echo OK", expect_ok=True)
    check("dod.4", "engine invariant suite green",
          "npx --yes nx test tokenguard-core && echo PASS")
    check("dod.5", "proxy pseudonymizes live traffic end-to-end with zero leaks",
          "bash extensions/services/tokenguard/demo/proxy-roundtrip.sh > /tmp/tg_rt.out 2>&1; grep -q 'ROUNDTRIP OK' /tmp/tg_rt.out && grep -q 'LEAKS 0' /tmp/tg_rt.out && echo OK", expect_ok=True)
    check("dod.6", "CLI seed reflected by the running proxy without restart",
          "bash extensions/services/tokenguard/demo/live-seed.sh | grep -q 'LIVE SEED REFLECTED' && echo OK", expect_ok=True)
    check("dod.7", "no engagement/red-team coupling remains (structural)",
          "grep -rniE 'roe|engagement|labtarget|workspace/engagements|red.?team|e2e-run' libs/tokenguard-core/src extensions/services/tokenguard/src", expect_empty=True)
    check("dod.8", "provider-agnostic: both adapters present + no provider host in engine (structural)",
          "test -f extensions/services/tokenguard/src/adapters/anthropic.ts && test -f extensions/services/tokenguard/src/adapters/generic.ts && ! grep -rqiE 'anthropic\\.com|openai\\.com' libs/tokenguard-core/src && echo OK", expect_ok=True)
    check("dod.9", "reviewer: code-review PASS + the four demo artifacts present (structural)",
          "grep -q 'VERDICT: PASS' docs/plan/tokenguard-service/code-review.md && test -f extensions/services/tokenguard/demo/out/prompts.txt && test -f extensions/services/tokenguard/demo/out/outbound.diff && test -f extensions/services/tokenguard/demo/out/raw-response.txt && test -f extensions/services/tokenguard/demo/out/inbound.diff && echo OK", expect_ok=True)
    check("dod.10", "non-goals documented (structural)",
          "grep -q 'does not add operating-system kernel sandboxing' docs/plan/tokenguard-service/README.md && echo OK", expect_ok=True)
    check("dod.11", "rollback/halt condition documented (structural)",
          "grep -q 'the plan halts' docs/plan/tokenguard-service/README.md && echo OK", expect_ok=True)

    # ---- Reference conformance (one per [ref:]) ----
    check("audit-final.ref-config-schema", "config via config_schema + read through SOX_CONFIG_*",
          "grep -q 'x-sox-prompt' extensions/services/tokenguard/extension.json && grep -q 'SOX_CONFIG_' extensions/services/tokenguard/src/config.ts && echo OK", expect_ok=True)
    check("audit-final.ref-run-service-spec", "unified run-service preserves the registry entry shape",
          "grep -q 'storePath' libs/install-engine/src/capabilities/run-service.ts && echo OK", expect_ok=True)
    check("audit-final.ref-supervisor-stop", "SIGTERM -> stop_timeout_ms -> SIGKILL stop path intact",
          "grep -q 'SIGKILL' libs/host-runtime/src/supervisor.ts && grep -q 'stop_timeout_ms' libs/host-runtime/src/supervisor.ts && echo OK", expect_ok=True)
    check("audit-final.ref-born-conformant-template", "service template emits a born-conformant fileset",
          "test -f libs/authoring/src/templates/service/index.ts && echo OK", expect_ok=True)
    check("audit-final.ref-host-keyed-target", "service template emits no literal host path",
          "grep -nE '\\.claude|/.claude' libs/authoring/src/templates/service/index.ts", expect_empty=True)
    check("audit-final.ref-c7-no-reach-in", "no cross-package ../dist reach-in from the service",
          "grep -rnE '\\.\\./.*dist' extensions/services/tokenguard/src", expect_empty=True)
    check("audit-final.ref-c6-policy-guard", "permissions enforced at the resource sink via SOX_POLICY_*",
          "grep -q 'SOX_POLICY_' extensions/services/tokenguard/src/index.ts && echo OK", expect_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", choices=["framework", "core", "service", "final"], required=True)
    args = parser.parse_args()

    {
        "framework": phase_framework,
        "core": phase_core,
        "service": phase_service,
        "final": phase_final,
    }[args.phase]()

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
