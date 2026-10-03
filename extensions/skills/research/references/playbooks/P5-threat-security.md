# P5 — threat-security

**Decision class.** Security and threat-intelligence research — vulnerabilities, advisories, threat
actors, exposures, and mitigations.

**Scope domains:** `security`.
**Answer category:** `fact-with-citation`, `pattern-recommendation`.

## Output contract

1. **Threat/claim → authoritative source → affected versions → mitigation.** Each row cites a
   primary source (CVE/NVD record, vendor advisory, or a pinned commit).
2. **Version ranges** precise enough to decide exposure (`>=x <y`, or the exact affected release).
3. **Severity** with its basis, not a bare number.
4. **Mitigation** — the concrete action, with the config/version that carries it.

## Verification rules (hard gate)

- Primary advisories only (CVE/NVD/vendor); a blog is corroboration, never the citation.
- Affected-version ranges verified against the advisory, not inferred from a summary.
- Independence: at least two independent sources before a claim is HIGH.
- Source credibility and information credibility both stated (Admiralty Code).
- Confidence stated before publication.

## Agent merge (process borrowed)

- `security-threat-intelligence-analyst` — Admiralty Code, confidence-before-publication,
  threat-actor and advisory sourcing.

## Fail conditions

- An advisory claim with no version range.
- A blog-only citation.
- A severity with no source basis.
