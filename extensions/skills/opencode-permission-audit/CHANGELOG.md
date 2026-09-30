# Changelog

## 0.1.0

- Initial skill: `scripts/opencode-permission-scan.py` — mines the opencode log and session DB for
  every permission ask (exact script segments, cwd, session, inferred answer), wasted-time deltas
  (overall / approved / rejected), a deny catalog, an auto-reject catalog, all permission-family DB
  error shapes, and a per-agent bash-map verdict with a drop-in corrected `permission.bash` block.
- `SKILL.md`: the audit workflow (scan → read Section 7 verdict → apply the fix → prove with a temp
  probe agent) plus the opencode inspection cheatsheet and the permissioning dynamics.
