#!/usr/bin/env python3
"""Guard for `http-transport`: an http service installs, is health-probed, and
stops clean. Red until the http-get probe + http install routing + service
surface exist. Green when the harness prints HTTP SERVICE HEALTHY then
STOPPED CLEAN orphans=0.
"""
import subprocess
import sys


def main() -> int:
    if subprocess.run("npx --yes nx run-many -t build --projects=host-runtime,install-engine,host-registry,sox",
                      shell=True).returncode != 0:
        print("guard(http-transport): framework build failed")
        return 1
    r = subprocess.run("bash tools/tg-plan/check-http-service.sh",
                       shell=True, capture_output=True, text=True)
    out = r.stdout + r.stderr
    sys.stdout.write(out)
    if "HTTP SERVICE HEALTHY" not in out or "STOPPED CLEAN orphans=0" not in out:
        print("guard(http-transport): http service did not health+stop cleanly")
        return 1
    print("guard(http-transport): PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
