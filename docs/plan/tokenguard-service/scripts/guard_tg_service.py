#!/usr/bin/env python3
"""Guard for `tg-service`: the tokenguard service installs/starts/health(http)/
stops via the real soxe CLI and pseudonymizes a request end-to-end through a mock
upstream. Red until the service + proxy + adapters exist. Green when the demo
prints ROUNDTRIP OK + LEAKS 0.
"""
import subprocess
import sys


def main() -> int:
    if subprocess.run("npx --yes nx build tokenguard", shell=True).returncode != 0:
        print("guard(tg-service): tokenguard build failed")
        return 1
    r = subprocess.run("bash extensions/services/tokenguard/demo/proxy-roundtrip.sh",
                       shell=True, capture_output=True, text=True)
    out = r.stdout + r.stderr
    sys.stdout.write(out)
    if "ROUNDTRIP OK" not in out or "LEAKS 0" not in out:
        print("guard(tg-service): live round-trip failed or leaked")
        return 1
    print("guard(tg-service): PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
