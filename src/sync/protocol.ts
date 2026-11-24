/**
 * Shared by the app and the sync server: what a change looks like on the wire
 * and which tables and fields take part in sync.
 *
 * Every change is one field of one record ("op"), stamped with a hybrid logical
 * clock. Both sides keep, per field, the op with the highest clock (last writer
 * wins per field). Links (task tags, dependencies) are sets: their single field
 * `present` is true or false, so add and remove merge the same way.
 */

export interface Op {
  entity: EntityName;
  id: string;
  field: string;
  /** JSON encoding of the column value (string, number or null; `present` is a boolean). */
  value: string;
  hlc: string;
}

export interface PulledOp extends Op {
  seq: number;
}

export type FieldKind = 'text' | 'int' | 'real' | 'bool' | 'enum';

interface FieldSpec {
  kind: FieldKind;
  nullable: boolean;
  values?: readonly string[];
  min?: number;
  max?: number;
}

const t = (nullable = true): FieldSpec => ({ kind: 'text', nullable });
const i = (nullable = true, min?: number, max?: number): FieldSpec => ({ kind: 'int', nullable, min, max });
const r = (nullable = true): FieldSpec => ({ kind: 'real', nullable });
const e = (values: readonly string[], nullable = false): FieldSpec => ({ kind: 'enum', nullable, values });

export interface RowEntity {
  kind: 'row';
  table: string;
  fields: Record<string, FieldSpec>;
  /** Values used when a record arrives in pieces and a required column is not here yet. */
  defaults: Record<string, unknown>;
}

export interface SetEntity {
  kind: 'set';
  table: string;
  /** The two columns that make up the id "a:b". */
  columns: [string, string];
}

export interface KvEntity {
  kind: 'kv';
  table: string;
}

export const ENTITIES = {
  project: {
    kind: 'row',
    table: 'project',
    fields: {
      parent_id: t(),
      name: t(false),
      color: t(),
      context: e(['home', 'office', 'any'], true),
      urgency_weight: r(),
      sort_key: t(false),
      archived_at: t(),
      updated_at: t(false),
      deleted_at: t(),
    },
    defaults: { name: '', sort_key: 'a0', updated_at: '1970-01-01T00:00:00.000Z' },
  },
  series: {
    kind: 'row',
    table: 'recurrence_series',
    fields: { rrule: t(false), mode: e(['schedule', 'after_completion']), updated_at: t(false), deleted_at: t() },
    defaults: { rrule: 'FREQ=DAILY', mode: 'schedule', updated_at: '1970-01-01T00:00:00.000Z' },
  },
  tag: {
    kind: 'row',
    table: 'tag',
    fields: { name: t(false), color: t(), urgency_weight: r(false), updated_at: t(false), deleted_at: t() },
    defaults: { name: '', urgency_weight: 0, updated_at: '1970-01-01T00:00:00.000Z' },
  },
  task: {
    kind: 'row',
    table: 'task',
    fields: {
      title: t(false),
      description: t(false),
      status: e(['todo', 'in_progress', 'done', 'cancelled']),
      priority: i(false, 0, 4),
      due_date: t(),
      due_time: t(),
      start_after: t(),
      estimate_min: i(),
      project_id: t(),
      series_id: t(),
      focus: i(false, 0, 1),
      sort_key: t(false),
      created_at: t(false),
      updated_at: t(false),
      started_at: t(),
      completed_at: t(),
      deleted_at: t(),
    },
    defaults: { title: '', description: '', status: 'todo', priority: 0, focus: 0, sort_key: 'a0', created_at: '1970-01-01T00:00:00.000Z', updated_at: '1970-01-01T00:00:00.000Z' },
  },
  note: {
    kind: 'row',
    table: 'note',
    fields: { task_id: t(false), body: t(false), kind: e(['user', 'system']), created_at: t(false), edited_at: t(), deleted_at: t() },
    defaults: { task_id: '', body: '', kind: 'user', created_at: '1970-01-01T00:00:00.000Z' },
  },
  task_tag: { kind: 'set', table: 'task_tag', columns: ['task_id', 'tag_id'] },
  dependency: { kind: 'set', table: 'dependency', columns: ['blocker_id', 'blocked_id'] },
  setting: { kind: 'kv', table: 'setting' },
} as const satisfies Record<string, RowEntity | SetEntity | KvEntity>;

export type EntityName = keyof typeof ENTITIES;
export const ENTITY_NAMES = Object.keys(ENTITIES) as EntityName[];

/** Order in which pulled changes are applied, parents before children. */
export const APPLY_ORDER: EntityName[] = ['setting', 'project', 'series', 'tag', 'task', 'note', 'task_tag', 'dependency'];

export const setId = (a: string, b: string) => `${a}:${b}`;
export function splitSetId(id: string): [string, string] | null {
  const parts = id.split(':');
  return parts.length === 2 && parts[0] && parts[1] ? [parts[0], parts[1]] : null;
}

const MAX_TEXT = 100_000;

/** Checks an op from a client before the server stores it. Returns a reason when invalid. */
export function validateOp(op: unknown): string | null {
  if (!op || typeof op !== 'object') return 'not an object';
  const o = op as Record<string, unknown>;
  if (typeof o.entity !== 'string' || !(o.entity in ENTITIES)) return 'unknown entity';
  if (typeof o.id !== 'string' || !o.id || o.id.length > 200) return 'bad id';
  if (typeof o.field !== 'string') return 'bad field';
  if (typeof o.hlc !== 'string' || !/^\d{15}:[0-9a-z]{4}:[0-9a-z-]{1,64}$/.test(o.hlc)) return 'bad clock';
  if (typeof o.value !== 'string' || o.value.length > MAX_TEXT) return 'bad value';
  let v: unknown;
  try {
    v = JSON.parse(o.value);
  } catch {
    return 'value is not JSON';
  }
  const ent = ENTITIES[o.entity as EntityName];
  if (ent.kind === 'set') {
    if (o.field !== 'present') return 'unknown field';
    if (typeof v !== 'boolean') return 'present must be true or false';
    if (!splitSetId(o.id)) return 'bad link id';
    return null;
  }
  if (ent.kind === 'kv') {
    if (o.field !== 'value') return 'unknown field';
    return typeof v === 'string' ? null : 'setting must be text';
  }
  const spec = (ent.fields as Record<string, FieldSpec>)[o.field];
  if (!spec) return 'unknown field';
  if (v === null) return spec.nullable ? null : 'field is required';
  switch (spec.kind) {
    case 'text':
      return typeof v === 'string' ? null : 'expected text';
    case 'enum':
      return typeof v === 'string' && spec.values!.includes(v) ? null : 'unexpected value';
    case 'int':
    case 'bool':
      if (typeof v !== 'number' || !Number.isInteger(v)) return 'expected a whole number';
      if ((spec.min !== undefined && v < spec.min) || (spec.max !== undefined && v > spec.max)) return 'out of range';
      return null;
    case 'real':
      return typeof v === 'number' && Number.isFinite(v) ? null : 'expected a number';
  }
}

// ---------- HTTP API shapes ----------

export interface PushRequest {
  ops: Op[];
}

export interface Rejected {
  op: Op;
  reason: 'invalid' | 'cycle' | 'project_cycle';
  message: string;
}

export interface PushResponse {
  accepted: number;
  rejected: Rejected[];
  /** Server time, so the client clock can't fall far behind. */
  hlc: string;
}

export interface PullResponse {
  ops: PulledOp[];
  cursor: number;
  more: boolean;
}

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  current: boolean;
}

export interface AuthStatus {
  setupDone: boolean;
  emailEnabled: boolean;
}

export interface ReminderSettings {
  /** Notify when a task with a due time is due. */
  atDueTime: boolean;
  /** Minutes before the due time. */
  leadMin: number;
  /** Morning summary of what is due today or overdue. */
  digest: boolean;
  digestTime: string; // HH:MM
}

export const DEFAULT_REMINDERS: ReminderSettings = { atDueTime: true, leadMin: 0, digest: true, digestTime: '08:00' };
