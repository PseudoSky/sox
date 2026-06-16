#!/usr/bin/env python3
"""Guard for `code-review`: the orchestrator's review is recorded with a PASS
verdict and the cross-project typecheck/lint/test gate is green. Red until
code-review.md exists with VERDICT: PASS and the gate passes.
"""
import subprocess
import sys

REVIEW = "docs/plan/tokenguard-service/code-review.md"
PROJECTS = "tokenguard-core,tokenguard,manifest,authoring,host-runtime,install-engine,host-registry,sox"


def main() -> int:
    if subprocess.run(f"grep -q 'VERDICT: PASS' {REVIEW}", shell=True).returncode != 0:
        print("guard(code-review): code-review.md missing or not VERDICT: PASS")
        return 1
    if subprocess.run(f"npx --yes nx run-many -t typecheck,lint,test --projects={PROJECTS}",
                      shell=True).returncode != 0:
        print("guard(code-review): cross-project typecheck/lint/test gate failed")
        return 1
    print("guard(code-review): PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
