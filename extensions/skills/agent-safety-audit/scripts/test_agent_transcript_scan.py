#!/usr/bin/env python3
"""Regression tests for agent-transcript-scan.py's command-precision helpers.

WHY (BL-225): the first full-corpus run produced 503 R7-redirect-link findings,
almost all false positives — a `>` inside a heredoc body or a quoted argument
(`> 0`, `> await`, `link -> =`) was read as a redirect, and `bash_links` parsed
any `ln` token without requiring `-s` or a path-like destination. Those bogus
links polluted the cross-transcript link map that R7 correlates against.

Run:  python3 scripts/test_agent_transcript_scan.py
Exits non-zero on the first failing assertion.
"""

import importlib.util
import os
import sys

# Importing the scanner must not leave a __pycache__ beside it.
sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.environ.get("ATSCAN", os.path.join(HERE, "agent-transcript-scan.py"))
SPEC = importlib.util.spec_from_file_location("atscan", TARGET)
scan = importlib.util.module_from_spec(SPEC)
# dataclasses look their module up in sys.modules during decoration.
sys.modules[SPEC.name] = scan
SPEC.loader.exec_module(scan)


def helper(name, fallback=None):
    """Pre-fix revisions lack some helpers; a missing helper is a failure, not
    a crash, so the same test file can prove red against the old artifact."""
    return getattr(scan, name, fallback)

FAILED = 0


def check(name, got, want):
    global FAILED
    if got == want:
        print(f"  ok   {name}")
    else:
        FAILED += 1
        print(f"  FAIL {name}\n       got  {got!r}\n       want {want!r}")


REDIRECT = helper("redirect_dests")
LINKS = helper("bash_links")
STRIP = helper("strip_heredocs")
ISPATH = helper("looks_like_path")


def call(fn, *a, **k):
    if fn is None:
        return "<helper missing>"
    try:
        return fn(*a, **k)
    except Exception as e:  # noqa: BLE001 - surfaced as a failure below
        return f"<error: {e}>"


print("RED-shape: the pre-fix false positives must now be rejected")
# A heredoc body is data. Pre-fix, redirect_dests saw `> 0` and returned ['0'].
heredoc = "python3 - <<'PYEOF'\nassert x > 0\nPYEOF"
check("heredoc body `> 0` is not a redirect",
      [d for d in call(REDIRECT, heredoc) if d == "0"], [])
check("strip_heredocs drops the body",
      "assert x > 0" in call(STRIP, heredoc), False)
# A `>` inside a quoted argument is not an operator. Pre-fix it matched.
check("quoted `a > b` is not a redirect",
      call(REDIRECT, """echo "a > b" """), [])
check("`link -> =` debris is not a path", call(ISPATH, "="), False)
check("bare digit is not a path", call(ISPATH, "0"), False)
check("bare word is not a path", call(ISPATH, "await"), False)
# A plain `ln` (no -s) is not a symlink. Pre-fix it returned ('bar', 'foo').
check("`ln foo bar` is not a symlink", call(LINKS, "ln foo bar"), [])

print("GREEN-shape: the true shapes must still be found")
check("a real redirect is found",
      call(REDIRECT, "printf x > $S/out.log", {"S": "/tmp/foo"}),
      ["/tmp/foo/out.log"])
check("a real `ln -sf` is found (the incident landmine)",
      call(LINKS, "ln -sf $(which node) $S/bin/skillspector"),
      [("$S/bin/skillspector", "$(which node)")])
check("`ln -s ../../node_modules node_modules` is found",
      call(LINKS, "ln -s ../../node_modules node_modules"),
      [("node_modules", "../../node_modules")])
check("implication arrow `->` is not a redirect",
      call(REDIRECT, "echo a -> b"), [])

print(f"\n{'PASS' if FAILED == 0 else 'FAIL'}: {FAILED} failing")
sys.exit(1 if FAILED else 0)
