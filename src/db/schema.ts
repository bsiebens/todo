import { focusDateMigration, syncMigration } from './sync-schema';

/**
 * Ordered migrations; PRAGMA user_version records how many have run.
 * A string is split on semicolons at line ends; an array is a list of whole statements.
 */
export const MIGRATIONS: (string | string[])[] = [
  `
  CREATE TABLE project (
    id TEXT PRIMARY KEY,
    parent_id TEXT REFERENCES project(id),
    name TEXT NOT NULL,
    color TEXT,
    context TEXT CHECK (context IN ('home','office','any')),
    urgency_weight REAL,
    sort_key TEXT NOT NULL DEFAULT 'a0',
    archived_at TEXT,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE TABLE recurrence_series (
    id TEXT PRIMARY KEY,
    rrule TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('schedule','after_completion')),
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE TABLE task (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done','cancelled')),
    priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4),
    due_date TEXT,
    due_time TEXT,
    start_after TEXT,
    estimate_min INTEGER,
    project_id TEXT REFERENCES project(id),
    series_id TEXT REFERENCES recurrence_series(id),
    focus INTEGER NOT NULL DEFAULT 0,
    sort_key TEXT NOT NULL DEFAULT 'a0',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    deleted_at TEXT
  );
  CREATE INDEX task_project ON task(project_id);
  CREATE INDEX task_status ON task(status);
  CREATE TABLE note (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES task(id),
    body TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user','system')),
    created_at TEXT NOT NULL,
    edited_at TEXT,
    deleted_at TEXT
  );
  CREATE INDEX note_task ON note(task_id);
  CREATE TABLE tag (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT,
    urgency_weight REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE UNIQUE INDEX tag_name ON tag(lower(name)) WHERE deleted_at IS NULL;
  CREATE TABLE task_tag (
    task_id TEXT NOT NULL REFERENCES task(id),
    tag_id TEXT NOT NULL REFERENCES tag(id),
    PRIMARY KEY (task_id, tag_id)
  );
  CREATE TABLE dependency (
    blocker_id TEXT NOT NULL REFERENCES task(id),
    blocked_id TEXT NOT NULL REFERENCES task(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id),
    CHECK (blocker_id <> blocked_id)
  );
  CREATE TABLE setting (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  -- Local change log, the outbox the sync engine will push in phase 3.
  CREATE TABLE change_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    op TEXT NOT NULL,
    data TEXT NOT NULL,
    at TEXT NOT NULL
  );
  `,
  syncMigration(),
  focusDateMigration(),
];
