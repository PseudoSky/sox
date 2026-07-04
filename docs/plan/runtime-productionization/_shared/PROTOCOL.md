# Execution protocol — how to run a context

## Bootstrap (do this first, in order)

1. Read `_shared/RULES.md`, `_shared/CONTRACTS.md`, then your context `README.md` fully.
2. Read `docs/decisions/0007-memory-single-writer-architecture.md` (the ADR this plan
   implements) and the BACKLOG.md entries your context lists.
3. Create your worktree (RULES §1). Set every item in your `progress.json` you are
   starting to `in_progress` as you start it — never batch-flip.
4. If your context has a `Depends on` line, verify the dependency contexts'
   `progress.json` show `"gate": {"status": "passed"}` before starting dependent items.
   Independent items may start regardless.

## progress.json schema (authoritative)

```jsonc
{
  "context": "01-write-path",
  "items": [
    {
      "id": "WP-1",
      "bl": ["BL-118"],
      "title": "…",
      "status": "pending | in_progress | complete | blocked",
      "evidence": {                       // REQUIRED (non-null) for status=complete
        "commands": [ {"cmd": "npx nx test memory-core", "exit": 0, "summary": "…"} ],
        "commits": ["<sha>"],
        "negative_control": {             // required where the item's row says NC:yes
          "break": "what was broken",
          "red": "failing output line + exit",
          "restore": "md5-verified byte-identical",
          "green": "passing output + exit"
        }
      },
      "notes": []
    }
  ],
  "gate": {
    "status": "pending | passed | failed",
    "evidence": null                      // same shape as item evidence; REQUIRED for passed
  },
  "blockers": [ {"item": "WP-3", "reason": "…", "needs": "owner decision on …"} ],
  "discovered": [ {"summary": "…", "where": "file:line", "severity": "high|medium|low"} ],
  "updated_at": "ISO-8601"
}
```

Rules with teeth: a `complete` without non-null evidence is INVALID. A `gate.passed`
without evidence is INVALID. The integrator re-runs gate commands from evidence verbatim
— if they don't reproduce, the context is reopened.

## Subdispatch guidance (what you may delegate to subagents)

You (the context executor) are the single committer, the single writer of
`progress.json`/`REPORT.md`, and the owner of all judgment. You MAY subdispatch:

- **Mechanical edit sweeps** — exact files, exact transformations, explicit "touch
  nothing else" fences.
- **Test authoring** from test cases you specify (name the behaviors and the negative
  controls; the subagent writes/runs them and reports exit codes).
- **Verification passes** — a separate verifier agent that re-runs your guards, checks
  your diff against the scope fence, and runs its OWN negative control (different from
  yours). Strongly recommended before flipping your gate to `passed`.
- **Read-only research** inside this repo (find call sites, map usages).

You may NOT subdispatch:

- Contract interpretation or anything touching `_shared/`.
- Edits outside your scope fence (including other contexts' packages).
- Git operations of any kind (subagents never run git).
- BACKLOG.md flips or progress.json writes.
- Scope decisions — a subagent that reports "this needs X outside scope" feeds your
  `blockers[]`, nothing else.

Every subdispatch prompt must contain: the exact file allowlist, the forbidden-paths
list, exit-code discipline (RULES §8), and "report evidence, change nothing beyond the
allowlist". Require subagents to write findings to a file under the repo `tmp/` AND
return them (teammate messages can be lost).

## Finishing a context

1. All items `complete` or `blocked` (blocked items documented — never silently
   dropped).
2. Gate run per your README, evidence recorded, ideally re-verified by a subdispatched
   verifier.
3. BL entries flipped (RULES §15). `REPORT.md` written: summary, per-item evidence
   digest, deviations, discovered[], exact commands a reviewer can re-run.
4. Final commit; leave the worktree clean (`git status --porcelain` empty).
5. Your final message: the REPORT.md content. Do not push; do not merge.
