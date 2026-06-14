#!/usr/bin/env python3
"""dod-reconcile guard — verify DOD.md + CLAUDE.md split "run" into
run(process) vs placed+discoverable(declarative). Run from repo root.

Exits 0 only when both docs carry the 'placed' split marker (red→green:
fails before dod-reconcile does the edit, passes after). Pinned form
(python .py) so guard pass/fail measures the docs, not the shell.
"""
import pathlib
import sys


def has_split(p: str) -> bool:
    fp = pathlib.Path(p)
    return fp.exists() and "placed" in fp.read_text(encoding="utf-8")


ok = has_split("DOD.md") and has_split("CLAUDE.md")
if not ok:
    sys.stderr.write(
        "dod-reconcile: DOD.md/CLAUDE.md do not yet split run(process) vs "
        "placed+discoverable(declarative) — expected the token 'placed' in both.\n"
    )
sys.exit(0 if ok else 1)
