#!/usr/bin/env python3
"""Guard for `decouple-generalize`: prove zero WOP coupling remains and that the
generic, provider-agnostic usage is documented. Red until the negative greps are
empty and the docs exist. Structural by nature (the behavioral proof is the live
round-trip in tg-service).
"""
import subprocess
import sys


def grep_empty(pattern: str, paths: str) -> bool:
    r = subprocess.run(f"grep -rniE '{pattern}' {paths}",
                       shell=True, capture_output=True, text=True)
    out = (r.stdout + r.stderr).strip()
    if out:
        sys.stdout.write(out + "\n")
    return out == ""


def exists(path: str) -> bool:
    return subprocess.run(f"test -f {path}", shell=True).returncode == 0


def main() -> int:
    ok = True
    src = "libs/tokenguard-core/src extensions/services/tokenguard/src"
    if not grep_empty("roe|engagement|labtarget|limabar|workspace/engagements|red.?team|e2e-run", src):
        print("guard(decouple): WOP coupling still present in shipped source")
        ok = False
    if not grep_empty("anthropic\\.com|openai\\.com", "libs/tokenguard-core/src"):
        print("guard(decouple): provider hostname hard-coded in the engine")
        ok = False
    for f in ("libs/tokenguard-core/README.md",
              "extensions/services/tokenguard/README.md",
              "extensions/services/tokenguard/CLAUDE.md"):
        if not exists(f):
            print(f"guard(decouple): missing doc {f}")
            ok = False
    if subprocess.run("grep -qiE 'BASE_URL' extensions/services/tokenguard/README.md",
                      shell=True).returncode != 0:
        print("guard(decouple): generic *_BASE_URL usage not documented")
        ok = False
    if not ok:
        return 1
    print("guard(decouple): PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
