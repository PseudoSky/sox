# Session Resume — 2026-06-23

**Branch:** `main`. **Everything below this session is committed + merged to `main` and the live migration has run.** Do NOT re-stage or re-implement — verify against `git log` if unsure.

---

## This session's arc (all merged to `main`)

Read newest→oldest in `git log --oneline --merges`. Highlights:

- **Memory subsystem to v1.1** — P4 (19-tool MCP surface incl. `memory_update`), P5 (structured export + SessionEnd auto-refresh), P6 (LLM `memory-organizer` removed; daemon → deterministic `runBatchEnrich`), filtered-clustering review + fixes, doc accuracy, BL-30 version/surface consistency, real-embed test-flake class closed.
- **ADR-0003 — content-addressed identity** (`8fc40bd`): extension identity = `id + sha256(entrypoint)`; per-extension semver retired; `memory_ping` returns the content address; lockfiles v2/bare-id.
- **Upgrade tooling** (`c63cf6f`): `verifyIntegrity` primitive (inherited by install/update/upgrade) + `soxe upgrade --all` (idempotent, all consumers × all scopes) + **auto rolling-restart** of changed services. `CLAUDE.md` AGENT SEQUENCE flipped to **"merge → immediately `soxe upgrade --all`"** (`003f5d2`).
- **BL-31** (`b1d4005`): `sox stop` verified-kill + SIGKILL escalation + store-path **orphan reaper** (fixed the LM-Studio zombie daemon).
- **`@sox` → `@adhd/sox-` scope rename** (`7885a30`) — founder-owned scope; workspace relinked; 0 `@sox` left.
- **BL-37** (`b3bf0d8`): daemon **self-contained bundle** from `bin.ts` + `NODE_PATH` for native addons; e2e Section E spawns from a copied store and asserts it stays up. (Also fixed a no-op-entry stacked bug.)
- **ADR-0004 — data root / placement / ownership index** (`ca20ecf`): `SOX_HOME` split into **`SOX_ECOSYSTEM_HOME`** (data root, default `~/.adhd/sox-ecosystem/`) + **`SOX_SANDBOX_ROOT`** (test-only reroute); user-scope placement → **real `~/.claude`** / global MCP; canonical `.adhd/sox-ecosystem/` layout; **ownership index** (`ownership.json`) tracking every owned file + config-key with `[no-untracked-injection]` / `[reversible-injection]` invariants + a born-conformance **reversibility gate**; `update`/`upgrade` re-materialize service stores (**closed BL-39**). `soxe migrate-home` added.
- **MCP install command fix** (`00e7f9e`, BL-40): `soxe install <mcp>` no longer writes `command:"sox"` (Homebrew audio tool) — now `SOX_CLI_BIN ?? process.argv[1] ?? 'soxe'`. + `docs/mcp-global-availability.md`.

**Live migration RAN:** `soxe migrate-home` relocated data → `~/.adhd/sox-ecosystem/` (install-registry, lockfile, supervisors) and re-placed skills + the `memory-server` MCP entry into the **real `~/.claude`** (`~/.claude.json` has `memory-server`; `~/.claude/skills` has memory-usage, gitnexus*, ticket-creation, …). Idempotent. Daemon (`memory-daemon`) running, **0 LM Studio connections**.

---

## In flight (this turn)

1. **Framework auto-merge of user-scope MCP → project `.mcp.json`** — the durable fix for Claude Code #16728 (project `.mcp.json` shadows user-scope without inheritance). Config-merge the server into each install-registry project's `.mcp.json`, tracked in the ownership index, reversible on uninstall.
2. **BL-41** — server expands a literal `~` `db_path` (no more stray `~/` dirs).
3. This `RESUME.md` refresh.

---

## MCP reachability — full diagnosis (memory unreachable to some agents)

Three independent causes:
1. **Sub-agent `tools:` allowlist** — an agent whose `tools:` omits `mcp__memory-server__*` is blocked from ALL MCP tools (per-agent declaration, no default-inherit). 230 `claude-agents` category agents already have it.
2. **#16728 + worktree trap** — project `.mcp.json` overrides user-scope; `claude-agents`'s root `.mcp.json` has `memory-server` **uncommitted**, so the 5 worktrees (HEAD) lack it. → **(your action, `claude-agents` repo):** `git add .mcp.json && git commit -m "fix(mcp): add memory-server"`, then `git merge`/recreate the worktrees + restart their sessions.
3. **`command:"sox"` collision** — ✅ fixed (BL-40).

The in-flight auto-merge (#1 above) systematizes cause #2 on the sox side.

---

## Open backlog (genuinely Open)

- **BL-33** `check-registry-sync.ts` scanner doesn't recurse into bundle members → false drift
- **BL-34** `sox` app entrypoint not index-resolvable → checksum hashes `extension.json`
- **BL-35** `install()` tests pollute the real install-registry (no path injection) — registry is heavily polluted (~585 records incl. fixtures + a stale `memory-organizer`)
- **BL-36** runtime record hardcodes `type:'mcp-server'` for every detached service
- **BL-38** `memory-server` shares the daemon's latent `tsc`-bare-requires shape + a stale tracked `bundle/`
- **BL-41** literal `~` `db_path` not expanded (being fixed this turn)

(BL-23/24 are folded into the `memory-enrichment` plan; BL-1…22, 25–40 resolved/folded.)

---

## Next planned work
- `runtime-productionization` (`.workflow/plans/runtime-productionization/SCOPE.md`) — P1–P9 already shipped (verify before re-doing).
- Founder env hygiene: `unset SOX_HOME` (retired by ADR-0004; only triggers a warning now).
- The `claude-agents` `.mcp.json` commit + worktree propagation (above).

## Standing invariants (don't regress)
- Identity = content checksum (ADR-0003); `version` is not an identity input.
- Data root = `SOX_ECOSYSTEM_HOME` (default `~/.adhd/sox-ecosystem/`); placement → real `~/.claude`; sandbox = `SOX_SANDBOX_ROOT` only.
- No untracked injection; every injection is verifiably reversible (ownership index + reversibility gate).
- Build only via nx; never edit `bin/soxe`; explicit-path git staging; merge → `soxe upgrade --all`.
