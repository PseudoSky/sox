#!/usr/bin/env python3
"""Guard for `mcp-as-service`: memory-server non-regresses after mcp-server is
folded onto the unified service model. Red until the routing refactor keeps the
stdio service path working. Green when the harness prints MEMORY OK + C6 DENY OK.
This is [inv:no-regress-mcp] — the highest-risk gate.
"""
import subprocess
import sys


def main() -> int:
    if subprocess.run("npx --yes nx run-many -t build --projects=manifest,install-engine,authoring,sox,memory-server",
                      shell=True).returncode != 0:
        print("guard(mcp-as-service): build failed")
        return 1
    r = subprocess.run("bash tools/tg-plan/check-memory-nonregress.sh",
                       shell=True, capture_output=True, text=True)
    out = r.stdout + r.stderr
    sys.stdout.write(out)
    if "MEMORY OK" not in out or "C6 DENY OK" not in out:
        print("guard(mcp-as-service): memory-server regressed (lifecycle or C6)")
        return 1
    print("guard(mcp-as-service): PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
