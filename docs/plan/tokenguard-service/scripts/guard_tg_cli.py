#!/usr/bin/env python3
"""Guard for `tg-cli`: a CLI-seeded identifier is reflected by the already-running
proxy without a restart. Red until the CLI + shared mapstore + live reload exist.
Green when the live-seed demo prints LIVE SEED REFLECTED.
"""
import subprocess
import sys


def main() -> int:
    if subprocess.run("npx --yes nx build tokenguard", shell=True).returncode != 0:
        print("guard(tg-cli): tokenguard build failed")
        return 1
    r = subprocess.run("bash extensions/services/tokenguard/demo/live-seed.sh",
                       shell=True, capture_output=True, text=True)
    out = r.stdout + r.stderr
    sys.stdout.write(out)
    if "LIVE SEED REFLECTED" not in out:
        print("guard(tg-cli): CLI seed not reflected by the running proxy")
        return 1
    print("guard(tg-cli): PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
