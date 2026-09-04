# Memory Session Flush

> Persist session working memory at conversation end, and gate scope-promotion requests — deterministic, zero LLM calls.

## Overview

`@adhd/sox-extension-memory-flush` binds two host lifecycle events:

**`SessionEnd`** — when a conversation closes:

1. Upserts a `session` node with the working-memory state (invalidates the previous entry for that `session_id`, inserts a new one).
2. Writes any pending episodes into the store (content-hash deduped) and enqueues each into the enrichment queue, so `memory-server`'s in-process batch pass picks them up — there is no separate daemon to notify.
3. If `export_enabled` + `export_dir` are configured (directly, or via `payload.export_config`), auto-exports the store to a markdown mirror, throttled to at most once per `export_throttle_secs` (default 60s) and fully failure-isolated — a failed export never breaks the flush.

**`ScopePromotionProposed`** — when a caller proposes promoting memory items from a narrower scope (e.g. `project`) to a wider one (e.g. `user`), the hook runs whatever promotion-approval callback has been registered via `setPromotionApprover`. If it approves, the hook copies the node(s) to the destination scope's store with a `SAME_AS` edge and marks the promotion applied. If it rejects, or no approver is registered, the row stays `proposed` and nothing is copied.

`order: 100` — ascending; ties broken by extension id.

```bash
pnpm add @adhd/sox-extension-memory-flush
```

## Quick start

The entrypoint exports `handler`, `events`, and the config setters — this is exactly how the package's own test suite drives it:

> **No type declarations ship with this package.** It is built as an executable bundle, so
> `dist/` contains no `.d.ts` and `package.json` declares no `types` field. The examples below
> are JavaScript. Importing it from TypeScript under `noImplicitAny` raises
> `TS7016: Could not find a declaration file for module` — add your own ambient declaration, or
> drive the package through its command line / MCP interface, which is its intended seam.

```js
import { handler, setExportConfig, _resetExportThrottle } from '@adhd/sox-extension-memory-flush';

// The store file must already exist — SessionEnd silently no-ops without it (see Gotchas).
// Create it first with `npx memory-cli init --scope project`, or let memory-server create it
// on its own first write.
const dbPath = `${process.cwd()}/.memory/project.db`;

// Optional: turn on auto-export for this process (default is off)
setExportConfig({ export_enabled: true, export_dir: '/path/to/export', export_throttle_secs: 0 });

const result = handler({
  event: 'SessionEnd',
  timestamp: new Date().toISOString(),
  payload: {
    session_id: 'session-123',
    db_path: dbPath,
    working_memory: { openFiles: ['src/index.ts'], lastGoal: 'fix the deadlock' },
    episodes: [{ content: 'Decided to retry on SQLITE_BUSY.', source: 'observation', importance: 6 }],
  },
});
if (result) await result; // SessionEnd returns a Promise; await it to know the flush completed
```

`handler` dispatches on `ctx.event` (`events` lists the two it binds) and never throws — a handler failure is caught and logged, never propagated to the host.

### As an installed hook

```bash
soxe install memory-flush --host=opencode --scope=project
```

The host fires `SessionEnd`/`ScopePromotionProposed` into `handler` automatically; you don't call it yourself. `memory-flush` requires `memory-server` to already be installed — it writes into the same store schema.

## When to use

- Install alongside `memory-server` whenever you want session continuity — without this hook, working memory is lost when the conversation ends.
- Install it when you need scope-promotion approval gating (e.g. policy-gated promotion from project to org memory).

## Lifecycle events bound

| Event | Behaviour |
| --- | --- |
| `SessionEnd` | Persist working memory, write + enqueue pending episodes, optionally auto-export. |
| `ScopePromotionProposed` | Run the registered promotion-approval callback; copy nodes on approval. |

## Configuration

Set the promotion approver programmatically — there is no CLI subcommand for it:

```js
import { setPromotionApprover } from '@adhd/sox-extension-memory-flush';

setPromotionApprover(async (payload) => {
  // payload: { extension_id, from_scope, to_scope, items: [{ uid, content? }], proposed_at }
  return { approved: true, srcDbPath: '/path/project.db', dstDbPath: '/path/user.db', decidedBy: 'policy' };
});
```

Without an approver registered, `ScopePromotionProposed` is logged and the proposal stays `proposed` — no action is taken.

Auto-export config keys (set via `setExportConfig`, or per-call via `payload.export_config`):

| Key | Default | Description |
| --- | --- | --- |
| `export_enabled` | `false` | Opt-in: run a markdown export after every `SessionEnd` flush. |
| `export_dir` | — | Required when `export_enabled` is true. |
| `export_throttle_secs` | `60` | Minimum seconds between auto-exports per process lifetime. |

## Constraints

- Deterministic: zero LLM calls in either handler.
- Side effects (DB writes, queue inserts, export) are scoped to the `db_path` in the event payload.
- `SessionEnd` returns a `Promise` (awaits the full flush + export cycle); `ScopePromotionProposed` also returns a `Promise`. Both catch their own errors internally rather than throwing into the host.

## Gotchas

- **`SessionEnd` silently no-ops if `db_path` doesn't already exist.** The session-state upsert and episode writes only run against a store file that's already on disk (`fs.existsSync(db_path)` gates the open); a missing file makes the whole write half of the handler return with **no write, no thrown error, and no log line** — `result` still resolves normally. Create the store first (`memory-cli init`, or let `memory-server` create it on its own first write) before pointing `handler` at it. The auto-export half is more forgiving: it checks existence separately and prints `[memory-flush] auto-export skipped: db_path not found: <path>` when it's missing, so a `SessionEnd` with export enabled can log an export-skip message while the session/episode write silently did nothing at all — those are two independent silent-vs-logged failure paths, not one.
- A literal `~`-prefixed path (e.g. `'~/.memory/project.db'`) is **not** shell-expanded by this package — pass an already-resolved absolute path (`` `${os.homedir()}/.memory/project.db` `` or similar).

## Usage

```bash
soxe install memory-flush
# or install the full subsystem:
soxe install sox-memory-bundle
```

## License

MIT
