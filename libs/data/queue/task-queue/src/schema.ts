// @adhd/sox-task-queue — SQLite schema (SPEC §6)

export const PRAGMAS: string[] = [
  'PRAGMA journal_mode = WAL;',
  'PRAGMA busy_timeout = 5000;',
  'PRAGMA synchronous = NORMAL;',
  'PRAGMA foreign_keys = ON;',
  'PRAGMA cache_size = -64000;',
];

export const SCHEMA_VERSION = 1;

// NOTE (implementation detail, per SPEC §13 "Schema migration strategy"):
// a `_schema_version` table anchors forward-compatible migrations, matching
// the @adhd/sox-graph-store convention.
export const SCHEMA_VERSION_DDL = `
CREATE TABLE IF NOT EXISTS _schema_version (
  version INTEGER NOT NULL
);
`;

// NOTE (schema gap fill): §6 does not include a mid-run cancellation flag,
// yet §3's cancel()/isCancelled() contract requires one (a 'running' task
// is not moved out of 'running' status on cancel -- a side flag is set and
// polled by the worker). Adding `cancel_requested` is required to implement
// the documented contract; it is additive and does not change any column
// or index named in §6.
export const TASK_QUEUE_DDL = `
CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT    PRIMARY KEY,
  type              TEXT    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued','running','completed','failed','cancelled','scheduled')),
  priority          INTEGER NOT NULL DEFAULT 0,
  payload           TEXT    NOT NULL,
  retry_count       INTEGER NOT NULL DEFAULT 0,
  max_retries       INTEGER NOT NULL DEFAULT 3,
  scheduled_at      TEXT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at        TEXT,
  completed_at      TEXT,
  error             TEXT,
  dead              INTEGER NOT NULL DEFAULT 0,
  result            TEXT,
  lease_expires_at  TEXT,
  worker_id         TEXT,
  ttl_ms            INTEGER,
  cancel_requested  INTEGER NOT NULL DEFAULT 0,
  client_request_id TEXT    UNIQUE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_tasks_dequeue
  ON tasks(priority DESC, created_at ASC)
  WHERE status IN ('queued', 'scheduled');

CREATE INDEX IF NOT EXISTS idx_tasks_type_status
  ON tasks(type, status);

CREATE INDEX IF NOT EXISTS idx_tasks_running
  ON tasks(lease_expires_at)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_tasks_client_request
  ON tasks(client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_completed_at
  ON tasks(completed_at)
  WHERE status = 'completed';

CREATE TABLE IF NOT EXISTS request_ledger (
  client_request_id TEXT    PRIMARY KEY,
  task_id           TEXT    NOT NULL,
  t_created         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS scheduler_entries (
  id                TEXT    PRIMARY KEY,
  name              TEXT    UNIQUE NOT NULL,
  task_type         TEXT    NOT NULL,
  payload           TEXT    NOT NULL DEFAULT '{}',
  cron_expression   TEXT    NOT NULL,
  priority          INTEGER NOT NULL DEFAULT 0,
  max_retries       INTEGER NOT NULL DEFAULT 0,
  ttl_ms            INTEGER,
  run_on_start      INTEGER NOT NULL DEFAULT 0,
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_enqueued_at  TEXT,
  last_error        TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_scheduler_enabled
  ON scheduler_entries(enabled, last_enqueued_at);
`;

/** Apply pragmas + schema DDL to a fresh or existing better-sqlite3 connection. */
export function applySchema(db: import('better-sqlite3').Database): void {
  for (const pragma of PRAGMAS) db.exec(pragma);
  db.exec(SCHEMA_VERSION_DDL);
  db.exec(TASK_QUEUE_DDL);
  const row = db.prepare('SELECT COUNT(*) as n FROM _schema_version').get() as { n: number };
  if (row.n === 0) {
    db.prepare('INSERT INTO _schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
  }
}
