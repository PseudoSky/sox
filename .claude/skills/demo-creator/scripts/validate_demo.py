#!/usr/bin/env python3
"""validate_demo.py — deterministic acceptance gate for a generated DEMO.md.

The demo-creator skill's Definition of Done contains checks that a language model
will happily self-certify as passing even when they are not (orphan stubs, stub
markers glued into runnable literals, leftover template machinery, beats missing a
Source line, requirements/capabilities that never get mapped). Those are exactly the
checks that must be mechanical. Run this before declaring a demo done:

    python3 validate_demo.py <demo-dir>     # dir containing DEMO.md (+ UNRESOLVED.md)
    python3 validate_demo.py path/to/DEMO.md

Exit code 0 = PASS (all gates green). Exit code 1 = FAIL (with a report of every
violation). Exit code 2 = usage / file-not-found error.

The checks are intentionally conservative: they flag things that are almost certainly
wrong, and explain each so the author can fix or consciously override. This is a gate,
not a style critic.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path


STUB_RE = re.compile(r"⟦U(\d+)⟧")
# A fenced code block: ``` ... ``` (also handles ```lang). We scan line-wise so we can
# report line numbers and tell "inside a literal" from "in prose/annotation".
FENCE_RE = re.compile(r"^\s*```")
# Inline code spans `like this` — also count as literals for the glued-stub check.
INLINE_CODE_RE = re.compile(r"`[^`]*`")
REQ_RE = re.compile(r"\bREQ-\d+\b")
CAP_RE = re.compile(r"\bCAP-?\d+\b")
# A "beat" starts at a #### heading (acts/beats/resilience) — the unit that needs a Source.
BEAT_HEADING_RE = re.compile(r"^####\s+")
SECTION_HEADING_RE = re.compile(r"^##\s+")
DO_MARKER = "▶️"
SOURCE_MARKER = "📎"
PROVES_MARKER = "🔗"

MACHINERY_PATTERNS = {
    "{{TOKEN}} placeholder": re.compile(r"\{\{"),
    "<!-- FILL comment": re.compile(r"<!--\s*FILL"),
    "«REPEAT marker": re.compile(r"«/?REPEAT"),
    "[OPTIONAL marker": re.compile(r"\[OPTIONAL"),
    "sidecar-spec comment": re.compile(r"SIDECAR FILE TO CREATE"),
}


@dataclass
class Result:
    failures: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def fail(self, msg: str) -> None:
        self.failures.append(msg)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)

    def note(self, msg: str) -> None:
        self.notes.append(msg)


def _iter_lines_with_fence_state(text: str):
    """Yield (lineno, line, in_fence) where in_fence is True for lines inside a ``` block.

    The fence delimiter lines themselves are reported as in_fence=False (they're not
    content), which keeps the glued-stub check focused on actual literal content.
    """
    in_fence = False
    for i, line in enumerate(text.splitlines(), start=1):
        if FENCE_RE.match(line):
            in_fence = not in_fence
            yield i, line, False  # the ``` line itself
            continue
        yield i, line, in_fence


def check_machinery(text: str, res: Result) -> None:
    for label, pat in MACHINERY_PATTERNS.items():
        hits = [str(i) for i, line, _ in _iter_lines_with_fence_state(text) if pat.search(line)]
        if hits:
            res.fail(
                f"Leftover template machinery — {label} found on line(s) {', '.join(hits)}. "
                f"Strip all template scaffolding before emitting."
            )


def check_stub_placement(text: str, res: Result) -> set[int]:
    """Stubs must annotate, never live inside a runnable literal.

    Returns the set of stub numbers that appear anywhere in DEMO.md (for reconciliation).
    """
    demo_stub_ids: set[int] = set()
    for lineno, line, in_fence in _iter_lines_with_fence_state(text):
        ids_on_line = STUB_RE.findall(line)
        if not ids_on_line:
            continue
        demo_stub_ids.update(int(n) for n in ids_on_line)
        # Inside a fenced code block => glued into a literal. Hard fail.
        if in_fence:
            res.fail(
                f"Stub marker inside a code block (line {lineno}): a ⟦U#⟧ tag is glued into a "
                f"runnable literal, which corrupts the command/JSON and breaks copy-paste "
                f"runnability (R1/R9). Move the tag to the step's 📎 Source line; put a plain "
                f"plausible value in the literal.\n      → {line.strip()}"
            )
            continue
        # Outside a fence but inside an inline `code span` => also glued. Hard fail.
        for span in INLINE_CODE_RE.findall(line):
            if STUB_RE.search(span):
                res.fail(
                    f"Stub marker inside an inline code span (line {lineno}): {span} — the ⟦U#⟧ "
                    f"tag must annotate, not sit inside a literal. Move it onto the Source line."
                )
                break
    return demo_stub_ids


def parse_unresolved_ids(unresolved_path: Path, res: Result) -> set[int] | None:
    if not unresolved_path.exists():
        res.fail(
            f"UNRESOLVED.md not found beside DEMO.md ({unresolved_path}). The skill requires the "
            f"uncertainty ledger to exist (it may state 'none' if every interface is grounded)."
        )
        return None
    text = unresolved_path.read_text(encoding="utf-8")
    ids: set[int] = {int(n) for n in STUB_RE.findall(text)}
    # Also accept bare `U<n>` ids, but ONLY where a ledger actually declares them: as the
    # first token of a table cell (optionally after a leading pipe) or a list item. This
    # avoids miscounting an incidental "U7" buried in prose as a logged stub, which would
    # otherwise manufacture a phantom orphan.
    for pat in (r"(?m)^\s*\|?\s*U(\d+)\b", r"(?m)^\s*[-*]\s*U(\d+)\b"):
        ids |= {int(m.group(1)) for m in re.finditer(pat, text)}
    return ids


def check_reconciliation(demo_ids: set[int], ledger_ids: set[int] | None, res: Result) -> None:
    if ledger_ids is None:
        return  # already failed on missing file
    orphans_in_ledger = ledger_ids - demo_ids
    orphans_in_demo = demo_ids - ledger_ids
    if orphans_in_ledger:
        res.fail(
            f"Orphan stubs in UNRESOLVED.md (logged but never used inline in DEMO.md): "
            f"{sorted_u(orphans_in_ledger)}. Either tag the corresponding step in DEMO.md or "
            f"remove the dead ledger row — the two sets must be identical."
        )
    if orphans_in_demo:
        res.fail(
            f"Orphan stubs in DEMO.md (used inline but missing from UNRESOLVED.md): "
            f"{sorted_u(orphans_in_demo)}. Every ⟦U#⟧ used must have a ledger row."
        )
    if not orphans_in_ledger and not orphans_in_demo:
        if demo_ids:
            res.note(f"Stub reconciliation OK: {len(demo_ids)} stub(s), DEMO ↔ ledger match exactly.")
        else:
            res.note("No interface stubs — every interface is grounded in context.")


def sorted_u(ids: set[int]) -> str:
    return ", ".join(f"⟦U{n}⟧" for n in sorted(ids))


def check_beats_have_source(text: str, res: Result) -> None:
    """Every beat (#### heading) up to the next heading must contain a 📎 Source line.

    We only enforce this for beats that actually contain an action (▶️ Do) — pure prose
    sub-headings (rare) are exempt and reported as a note.
    """
    lines = text.splitlines()
    # Find indices of beat headings.
    beat_starts = [i for i, l in enumerate(lines) if BEAT_HEADING_RE.match(l)]
    for idx, start in enumerate(beat_starts):
        # Beat body runs until the next #### or ## heading.
        end = len(lines)
        for j in range(start + 1, len(lines)):
            if BEAT_HEADING_RE.match(lines[j]) or SECTION_HEADING_RE.match(lines[j]):
                end = j
                break
        body = "\n".join(lines[start:end])
        title = lines[start].strip()
        has_action = DO_MARKER in body
        has_source = SOURCE_MARKER in body
        if has_action and not has_source:
            res.fail(
                f"Beat missing 📎 Source (line {start + 1}): \"{title}\" has an action (▶️ Do) but "
                f"no Source line. Every step must cite what grounds it (R10)."
            )
        if has_action and PROVES_MARKER not in body:
            res.warn(
                f"Beat missing 🔗 Proves (line {start + 1}): \"{title}\" has an action but no "
                f"requirement/capability mapping. Traceability (R4) expects one."
            )


def check_coverage_matrix(text: str, res: Result) -> None:
    """Every REQ-/CAP- id named in §7 should also appear in a beat's 🔗 Proves.

    Heuristic: collect ids that appear on a 🔗 Proves line vs ids that appear in the
    coverage tables. Anything in the matrix but never proven by a beat is a build gap.
    """
    proven: set[str] = set()
    matrix: set[str] = set()
    in_matrix = False
    for line in text.splitlines():
        if SECTION_HEADING_RE.match(line) and "Coverage" in line and "Traceability" in line:
            in_matrix = True
        elif SECTION_HEADING_RE.match(line) and in_matrix:
            in_matrix = False
        ids = {normalize_id(t) for t in REQ_RE.findall(line)} | {
            normalize_id(c) for c in CAP_RE.findall(line)
        }
        if PROVES_MARKER in line:
            proven |= ids
        if in_matrix:
            matrix |= ids
    unproven = matrix - proven
    if unproven:
        res.warn(
            f"Coverage gap: {len(unproven)} id(s) appear in the §7 matrix but in no beat's "
            f"🔗 Proves line: {', '.join(sorted(unproven))}. Either add a beat that proves each, "
            f"or confirm the matrix row points at a real beat. (Heuristic — verify.)"
        )
    if matrix and not unproven:
        res.note(f"Coverage OK: all {len(matrix)} matrix id(s) are proven by ≥1 beat.")


def normalize_id(token: str) -> str:
    # Normalize REQ-1 / REQ-001 / CAP07 / CAP-7 to one zero-padded form so the coverage
    # heuristic never treats different-width spellings of the same id as distinct.
    m = re.match(r"(REQ|CAP)", token)
    digits = re.sub(r"\D", "", token)
    prefix = m.group(1) if m else "ID"
    return f"{prefix}-{int(digits):03d}" if digits else token


def resolve_demo_path(arg: str) -> Path | None:
    p = Path(arg).expanduser()
    if p.is_dir():
        cand = p / "DEMO.md"
        return cand if cand.exists() else None
    if p.is_file():
        return p
    return None


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        print("usage: validate_demo.py <demo-dir | DEMO.md>", file=sys.stderr)
        return 2
    demo_path = resolve_demo_path(argv[1])
    if demo_path is None:
        print(f"error: could not find DEMO.md at {argv[1]}", file=sys.stderr)
        return 2

    text = demo_path.read_text(encoding="utf-8")
    res = Result()

    check_machinery(text, res)
    demo_ids = check_stub_placement(text, res)
    ledger_ids = parse_unresolved_ids(demo_path.parent / "UNRESOLVED.md", res)
    check_reconciliation(demo_ids, ledger_ids, res)
    check_beats_have_source(text, res)
    check_coverage_matrix(text, res)

    print(f"validate_demo.py — {demo_path}")
    print("=" * 60)
    for n in res.notes:
        print(f"  ✓ {n}")
    for w in res.warnings:
        print(f"  ⚠ WARN: {w}")
    for f in res.failures:
        print(f"  ✗ FAIL: {f}")
    print("=" * 60)
    if res.failures:
        print(f"RESULT: FAIL ({len(res.failures)} failure(s), {len(res.warnings)} warning(s))")
        return 1
    print(f"RESULT: PASS ({len(res.warnings)} warning(s))")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
