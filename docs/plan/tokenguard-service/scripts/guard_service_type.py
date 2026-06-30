#!/usr/bin/env python3
"""Guard for `service-type`: `soxe init service` scaffolds a born-conformant service.

Red until: manifest knows `service` + transports, serviceTemplate + scaffold
dispatch exist, soxe init/validate handle `service`, and the scaffold harness is
present. Green when the scaffold round-trip prints SCAFFOLD OK.
"""
import subprocess
import sys


def run(cmd: str) -> int:
    return subprocess.run(cmd, shell=True).returncode


def main() -> int:
    # Build the CLI so `./bin/sox` reflects the new type handling.
    if run("npx --yes nx build sox") != 0:
        print("guard(service-type): soxe build failed")
        return 1
    # Drive the documented entrypoint: init -> build -> validate a fresh service.
    r = subprocess.run("bash tools/tg-plan/check-service-scaffold.sh",
                       shell=True, capture_output=True, text=True)
    out = r.stdout + r.stderr
    sys.stdout.write(out)
    if "SCAFFOLD OK" not in out:
        print("guard(service-type): scaffold did not reach SCAFFOLD OK")
        return 1
    print("guard(service-type): PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
