import { DependencyGraph } from '../domain/dependencies';
import { addDays, diffDays, toDateStr } from '../domain/dates';
import { uuidv7 } from '../domain/ids';
import { ProjectTree } from '../domain/projects';
import { firstDueOnOrAfter, nextDueDate, ruleError } from '../domain/recurrence';
import { checkTransition, STATUS_LABELS } from '../domain/status';
import type { Context, Dependency, Id, Note, Priority, Project, RecurrenceMode, RecurrenceSeries, Status, Tag, Task } from '../domain/types';
import { DEFAULT_WEIGHTS, type UrgencyWeights } from '../domain/urgency';
import { parseSavedFilters, type SavedFilter } from '../domain/filters';
import type { ImportItem } from '../domain/importers';
import type { Row, SqlDriver, Statement } from './driver';
import { migrate } from './migrate';
import { Hlc } from '../sync/hlc';
import { APPLY_ORDER, DEFAULT_REMINDERS, ENTITIES, splitSetId, type Op, type ReminderSettings } from '../sync/protocol';

export interface Settings {
  weights: UrgencyWeights;
  /** 'auto' follows the office-hours schedule. */
  contextMode: 'auto' | 'home' | 'office';
  officeDays: number[]; // 1 = Monday ... 5 = Friday
  officeStart: string; // HH:MM
  officeEnd: string;
  reminders: ReminderSettings;
  /** Named searches shown in the sidebar and command palette. */
  savedFilters: SavedFilter[];
}

export const DEFAULT_SETTINGS: Settings = {
  weights: DEFAULT_WEIGHTS,
  contextMode: 'auto',
  officeDays: [1, 2, 3, 4, 5],
  officeStart: '08:30',
  officeEnd: '17:30',
  reminders: DEFAULT_REMINDERS,
  savedFilters: [],
};

export interface Snapshot {
  tasks: Task[];
  notes: Note[];
  projects: Project[];
  tags: Tag[];
  taskTags: { taskId: Id; tagId: Id }[];
  deps: Dependency[];
  series: RecurrenceSeries[];
  settings: Settings;
}

function safeFirstDue(rule: string): string | null {
  try {
    return firstDueOnOrAfter(rule, toDateStr(new Date()));
  } catch {
    return null;
  }
}

export class StoreError extends Error {
  constructor(public code: 'blocked' | 'cycle' | 'invalid' | 'not_found', message: string, public detail?: unknown) {
    super(message);
  }
}

export type TaskPatch = Partial<Pick<Task, 'title' | 'description' | 'priority' | 'dueDate' | 'dueTime' | 'startAfter' | 'estimateMin' | 'projectId' | 'sortKey'>>;

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
function fromRow<T>(row: Row, bools: string[] = []): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'deleted_at') continue;
    const key = camel(k);
    out[key] = bools.includes(key) ? Boolean(v) : v;
  }
  return out as T;
}

const nowIso = () => new Date().toISOString();

/** All reads and writes. Data is small, so the UI keeps a full snapshot and reloads it after each write. */
export class Store {
  private listeners = new Set<() => void>();
  snapshot: Snapshot = { tasks: [], notes: [], projects: [], tags: [], taskTags: [], deps: [], series: [], settings: DEFAULT_SETTINGS };

  private constructor(
    private db: SqlDriver,
    private clock: Hlc,
  ) {}

  static async open(db: SqlDriver): Promise<Store> {
    await migrate(db);
    const state = await db.query("SELECT key, value FROM sync_state WHERE key IN ('node', 'hlc')");
    const get = (k: string) => state.find((r) => r.key === k)?.value as string | undefined;
    const s = new Store(db, new Hlc(get('node')!, get('hlc')));
    await s.write([]); // stamps changes queued by a migration
    return s;
  }

  get storage() {
    return this.db.storage;
  }

  /** Data survives a restart: OPFS in the browser, a file in the desktop app. */
  get persistent() {
    return this.db.storage === 'OPFS' || this.db.storage === 'file';
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async reload(): Promise<Snapshot> {
    const q = (sql: string) => this.db.query(sql);
    const [tasks, notes, projects, tags, taskTags, deps, series, settings] = await Promise.all([
      q('SELECT * FROM task WHERE deleted_at IS NULL'),
      q('SELECT * FROM note WHERE deleted_at IS NULL ORDER BY created_at DESC'),
      q('SELECT * FROM project WHERE deleted_at IS NULL'),
      q('SELECT * FROM tag WHERE deleted_at IS NULL ORDER BY lower(name)'),
      q('SELECT task_id, tag_id FROM task_tag'),
      q('SELECT blocker_id, blocked_id FROM dependency'),
      q('SELECT * FROM recurrence_series WHERE deleted_at IS NULL'),
      q('SELECT * FROM setting'),
    ]);
    const settingsObj: Record<string, unknown> = {};
    for (const r of settings) settingsObj[r.key as string] = JSON.parse(r.value as string);
    this.snapshot = {
      tasks: tasks.map((r) => fromRow<Task>(r, ['focus'])),
      notes: notes.map((r) => fromRow<Note>(r)),
      projects: projects.map((r) => fromRow<Project>(r)),
      tags: tags.map((r) => fromRow<Tag>(r)),
      taskTags: taskTags.map((r) => ({ taskId: r.task_id as Id, tagId: r.tag_id as Id })),
      deps: deps.map((r) => ({ blockerId: r.blocker_id as Id, blockedId: r.blocked_id as Id })),
      series: series.map((r) => fromRow<RecurrenceSeries>(r)),
      settings: {
        ...DEFAULT_SETTINGS,
        ...settingsObj,
        weights: { ...DEFAULT_WEIGHTS, ...(settingsObj.weights as object) },
        reminders: { ...DEFAULT_REMINDERS, ...(settingsObj.reminders as object) },
        savedFilters: parseSavedFilters(settingsObj.savedFilters),
      } as Settings,
    };
    for (const fn of this.listeners) fn();
    return this.snapshot;
  }

  private async write(statements: Statement[]): Promise<void> {
    await this.db.batch([...statements, ...this.stampStatements()]);
    await this.reload();
  }

  /** Gives the field changes the triggers just queued a clock stamp, in the same transaction. */
  private stampStatements(): Statement[] {
    const hlc = this.clock.now();
    return [
      // Within one write only the last change to a field counts (setTags removes, then re-adds).
      {
        sql: 'DELETE FROM sync_outbox WHERE hlc IS NULL AND seq < (SELECT max(o.seq) FROM sync_outbox o WHERE o.hlc IS NULL AND o.entity = sync_outbox.entity AND o.entity_id = sync_outbox.entity_id AND o.field = sync_outbox.field)',
      },
      { sql: 'UPDATE sync_outbox SET hlc = ? WHERE hlc IS NULL', params: [hlc] },
      {
        sql: 'INSERT INTO field_clock (entity, entity_id, field, hlc) SELECT entity, entity_id, field, hlc FROM sync_outbox WHERE hlc = ? ON CONFLICT (entity, entity_id, field) DO UPDATE SET hlc = excluded.hlc',
        params: [hlc],
      },
      { sql: "INSERT INTO sync_state (key, value) VALUES ('hlc', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", params: [hlc] },
    ];
  }

  // ---------- Sync ----------

  get nodeId(): string {
    return this.clock.node;
  }

  /** Local changes not yet sent to the server, oldest first. */
  async pendingOps(limit = 500): Promise<{ seq: number; op: Op }[]> {
    const rows = await this.db.query('SELECT seq, entity, entity_id, field, value, hlc FROM sync_outbox WHERE hlc IS NOT NULL ORDER BY seq LIMIT ?', [limit]);
    return rows.map((r) => ({ seq: r.seq as number, op: { entity: r.entity as Op['entity'], id: r.entity_id as string, field: r.field as string, value: r.value as string, hlc: r.hlc as string } }));
  }

  async pendingCount(): Promise<number> {
    const rows = await this.db.query('SELECT count(*) AS n FROM sync_outbox');
    return Number(rows[0]?.n ?? 0);
  }

  async ackOps(upToSeq: number): Promise<void> {
    await this.db.batch([{ sql: 'DELETE FROM sync_outbox WHERE seq <= ?', params: [upToSeq] }]);
  }

  /** Puts ops back in the outbox to send again later, with their original clocks. */
  async requeueOps(ops: Op[]): Promise<void> {
    if (!ops.length) return;
    await this.db.batch(ops.map((o) => ({ sql: 'INSERT INTO sync_outbox (entity, entity_id, field, value, hlc) VALUES (?,?,?,?,?)', params: [o.entity, o.id, o.field, o.value, o.hlc] })));
  }

  async getSyncState(key: string): Promise<string | null> {
    const rows = await this.db.query('SELECT value FROM sync_state WHERE key = ?', [key]);
    return (rows[0]?.value as string | undefined) ?? null;
  }

  async setSyncState(key: string, value: string | null): Promise<void> {
    await this.db.batch([
      value === null
        ? { sql: 'DELETE FROM sync_state WHERE key = ?', params: [key] }
        : { sql: 'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', params: [key, value] },
    ]);
  }

  /** Moves the local clock past a stamp seen elsewhere (for example the server's). */
  observeClock(hlc: string): void {
    this.clock.observe(hlc);
  }

  /**
   * Applies changes from other devices. Per field, the change with the later clock wins;
   * older ones are ignored. Returns how many fields changed here.
   */
  async applyRemote(ops: Op[]): Promise<number> {
    if (!ops.length) return 0;
    for (const op of ops) this.clock.observe(op.hlc);
    const keys = [...new Set(ops.map((o) => `${o.entity}|${o.id}`))];
    const clocks = await this.db.query("SELECT entity, entity_id, field, hlc FROM field_clock WHERE entity || '|' || entity_id IN (SELECT value FROM json_each(?))", [JSON.stringify(keys)]);
    const known = new Map(clocks.map((c) => [`${c.entity}|${c.entity_id}|${c.field}`, c.hlc as string]));

    // Latest winning value per field, grouped by record.
    const groups = new Map<string, { entity: Op['entity']; id: string; fields: Map<string, Op> }>();
    for (const op of ops) {
      const k = `${op.entity}|${op.id}|${op.field}`;
      const cur = known.get(k);
      if (cur !== undefined && cur >= op.hlc) continue;
      known.set(k, op.hlc);
      const gk = `${op.entity}|${op.id}`;
      if (!groups.has(gk)) groups.set(gk, { entity: op.entity, id: op.id, fields: new Map() });
      groups.get(gk)!.fields.set(op.field, op);
    }
    if (!groups.size) return 0;

    const st: Statement[] = [{ sql: 'UPDATE sync_flag SET applying = 1' }];
    let changed = 0;
    const ordered = [...groups.values()].sort((a, b) => APPLY_ORDER.indexOf(a.entity) - APPLY_ORDER.indexOf(b.entity));
    const rowIds = new Map<string, Set<string>>();
    for (const entity of new Set(ordered.map((g) => g.entity))) {
      const ent = ENTITIES[entity];
      if (ent.kind !== 'row') continue;
      const ids = ordered.filter((g) => g.entity === entity).map((g) => g.id);
      const rows = await this.db.query(`SELECT id FROM ${ent.table} WHERE id IN (SELECT value FROM json_each(?))`, [JSON.stringify(ids)]);
      rowIds.set(entity, new Set(rows.map((r) => r.id as string)));
    }

    for (const g of ordered) {
      const ent = ENTITIES[g.entity];
      const values = new Map([...g.fields].map(([f, op]) => [f, JSON.parse(op.value) as unknown]));
      changed += values.size;
      if (ent.kind === 'row') {
        const fields = [...values.keys()].filter((f) => f in ent.fields);
        if (!fields.length) continue;
        if (rowIds.get(g.entity)!.has(g.id)) {
          st.push({ sql: `UPDATE ${ent.table} SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`, params: [...fields.map((f) => values.get(f)), g.id] });
        } else {
          const row: Record<string, unknown> = { ...ent.defaults };
          for (const f of fields) row[f] = values.get(f);
          const cols = ['id', ...Object.keys(row)];
          st.push({ sql: `INSERT INTO ${ent.table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, params: [g.id, ...Object.values(row)] });
          rowIds.get(g.entity)!.add(g.id);
        }
      } else if (ent.kind === 'set') {
        const pair = splitSetId(g.id);
        if (!pair || !values.has('present')) continue;
        const [a, b] = ent.columns;
        if (values.get('present')) {
          st.push(
            g.entity === 'dependency'
              ? { sql: `INSERT OR IGNORE INTO ${ent.table} (${a}, ${b}, created_at) VALUES (?, ?, ?)`, params: [...pair, nowIso()] }
              : { sql: `INSERT OR IGNORE INTO ${ent.table} (${a}, ${b}) VALUES (?, ?)`, params: pair },
          );
        } else {
          st.push({ sql: `DELETE FROM ${ent.table} WHERE ${a} = ? AND ${b} = ?`, params: pair });
        }
      } else if (values.has('value')) {
        st.push({ sql: 'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', params: [g.id, values.get('value')] });
      }
      for (const op of g.fields.values()) {
        st.push({
          sql: 'INSERT INTO field_clock (entity, entity_id, field, hlc) VALUES (?,?,?,?) ON CONFLICT (entity, entity_id, field) DO UPDATE SET hlc = excluded.hlc',
          params: [op.entity, op.id, op.field, op.hlc],
        });
      }
    }
    st.push({ sql: 'UPDATE sync_flag SET applying = 0' });
    st.push({ sql: "INSERT INTO sync_state (key, value) VALUES ('hlc', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", params: [this.clock.last] });
    await this.db.batch(st);
    await this.reload();
    return changed;
  }

  private systemNote(taskId: Id, body: string, at = nowIso()): Statement {
    const id = uuidv7();
    return { sql: 'INSERT INTO note (id, task_id, body, kind, created_at) VALUES (?,?,?,?,?)', params: [id, taskId, body, 'system', at] };
  }

  task(id: Id): Task {
    const t = this.snapshot.tasks.find((x) => x.id === id);
    if (!t) throw new StoreError('not_found', 'Task not found');
    return t;
  }

  graph() {
    return new DependencyGraph(this.snapshot.deps);
  }

  tree() {
    return new ProjectTree(this.snapshot.projects);
  }

  taskMap() {
    return new Map(this.snapshot.tasks.map((t) => [t.id, t]));
  }

  // ---------- Tasks ----------

  async createTask(input: {
    title: string;
    priority?: Priority;
    dueDate?: string | null;
    dueTime?: string | null;
    projectId?: Id | null;
    estimateMin?: number | null;
    description?: string;
    tagNames?: string[];
    recurrence?: { rule: string; mode: RecurrenceMode } | null;
  }): Promise<Id> {
    const id = uuidv7();
    const now = nowIso();
    const st: Statement[] = [];
    let seriesId: Id | null = null;
    if (input.recurrence) {
      seriesId = uuidv7();
      st.push({ sql: 'INSERT INTO recurrence_series (id, rrule, mode, updated_at) VALUES (?,?,?,?)', params: [seriesId, input.recurrence.rule, input.recurrence.mode, now] });
    }
    const row = {
      id,
      title: input.title.trim() || 'Untitled',
      description: input.description ?? '',
      priority: input.priority ?? 0,
      due_date: input.dueDate ?? (input.recurrence ? safeFirstDue(input.recurrence.rule) : null),
      due_time: input.dueTime ?? null,
      project_id: input.projectId ?? null,
      estimate_min: input.estimateMin ?? null,
      series_id: seriesId,
      created_at: now,
      updated_at: now,
    };
    const cols = Object.keys(row);
    st.push({ sql: `INSERT INTO task (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, params: Object.values(row) });
    st.push(this.systemNote(id, 'Created', now));
    st.push(...this.tagStatements(id, input.tagNames ?? []));
    await this.write(st);
    return id;
  }

  /** Resolves tag names to ids, creating missing tags, and links them to the task. */
  private tagStatements(taskId: Id, names: string[]): Statement[] {
    const st: Statement[] = [];
    for (const name of names) {
      const existing = this.snapshot.tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
      const tagId = existing?.id ?? uuidv7();
      if (!existing) {
        st.push({ sql: 'INSERT INTO tag (id, name, updated_at) VALUES (?,?,?)', params: [tagId, name, nowIso()] });
        this.snapshot.tags.push({ id: tagId, name, color: null, urgencyWeight: 0 });
      }
      st.push({ sql: 'INSERT OR IGNORE INTO task_tag (task_id, tag_id) VALUES (?,?)', params: [taskId, tagId] });
    }
    return st;
  }

  async updateTask(id: Id, patch: TaskPatch): Promise<void> {
    const t = this.task(id);
    const entries = Object.entries(patch).filter(([k, v]) => (t as unknown as Record<string, unknown>)[k] !== v);
    if (!entries.length) return;
    const st: Statement[] = [];
    const sets = entries.map(([k]) => `${snake(k)} = ?`);
    const params = entries.map(([, v]) => v);
    st.push({ sql: `UPDATE task SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, params: [...params, nowIso(), id] });
    if ('dueDate' in patch || 'dueTime' in patch) {
      const fmt = (d: string | null, tm: string | null) => (d ? `${d}${tm ? ` ${tm}` : ''}` : 'none');
      const before = fmt(t.dueDate, t.dueTime);
      const after = fmt(patch.dueDate !== undefined ? patch.dueDate : t.dueDate, patch.dueTime !== undefined ? patch.dueTime : t.dueTime);
      if (before !== after) st.push(this.systemNote(id, `Due date changed from ${before} to ${after}`));
    }
    if ('projectId' in patch) {
      const tree = this.tree();
      st.push(this.systemNote(id, `Moved to ${patch.projectId ? tree.path(patch.projectId) : 'Inbox'}`));
    }
    await this.write(st);
  }

  /** Puts tasks in today's Focus, or takes them out. */
  async setFocus(ids: Id[], on: boolean): Promise<void> {
    if (!ids.length) return;
    const today = toDateStr(new Date());
    const now = nowIso();
    await this.write(ids.map((id) => ({ sql: 'UPDATE task SET focus = ?, focus_date = ?, updated_at = ? WHERE id = ?', params: [on ? 1 : 0, on ? today : null, now, id] })));
  }

  async setTags(taskId: Id, names: string[]): Promise<void> {
    await this.write([
      { sql: 'DELETE FROM task_tag WHERE task_id = ?', params: [taskId] },
      ...this.tagStatements(taskId, names),
    ]);
  }

  async deleteTask(id: Id): Promise<void> {
    const now = nowIso();
    await this.write([
      { sql: 'UPDATE task SET deleted_at = ?, updated_at = ? WHERE id = ?', params: [now, now, id] },
      { sql: 'DELETE FROM dependency WHERE blocker_id = ? OR blocked_id = ?', params: [id, id] },
    ]);
  }

  /**
   * Changes status following the design's rules. Starting or completing a blocked task
   * needs an override reason, which is logged as a note. Completing a recurring task
   * creates its next instance.
   */
  async setStatus(id: Id, to: Status, overrideReason?: string): Promise<{ nextId?: Id }> {
    const t = this.task(id);
    const graph = this.graph();
    const tasks = this.taskMap();
    const blocked = graph.isBlocked(id, tasks);
    const check = checkTransition(t.status, to, blocked, !!overrideReason?.trim());
    if (!check.ok) {
      if (check.reason === 'blocked') {
        throw new StoreError('blocked', `Blocked by: ${graph.openBlockers(id, tasks).map((b) => b.title).join(', ')}`, graph.openBlockers(id, tasks));
      }
      return {};
    }
    const now = nowIso();
    const st: Statement[] = [];
    const fields: Record<string, unknown> = { status: to };
    if (to === 'in_progress' && !t.startedAt) fields.started_at = now;
    if (to === 'done' || to === 'cancelled') fields.completed_at = now;
    if (to === 'todo') fields.completed_at = null;
    const keys = Object.keys(fields);
    st.push({ sql: `UPDATE task SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, params: [...Object.values(fields), now, id] });
    let label = STATUS_LABELS[to];
    if (t.status === 'in_progress' && to === 'todo') label = 'Paused';
    if ((t.status === 'done' || t.status === 'cancelled') && to === 'todo') label = 'Reopened';
    if (to === 'in_progress') label = 'Started';
    st.push(this.systemNote(id, overrideReason ? `${label} despite blockers (override): ${overrideReason.trim()}` : label, now));

    let nextId: Id | undefined;
    const series = t.seriesId ? this.snapshot.series.find((s) => s.id === t.seriesId) : undefined;
    const alreadyHasOpen = series && this.snapshot.tasks.some((x) => x.seriesId === series.id && x.id !== id && (x.status === 'todo' || x.status === 'in_progress'));
    if (series && (to === 'done' || to === 'cancelled') && !alreadyHasOpen) {
      let due: string | null = null;
      try {
        due = nextDueDate(series.rrule, series.mode, t.dueDate, toDateStr(new Date()));
      } catch {
        // A rule this version cannot read (e.g. from a newer device): finish the task, skip the copy.
      }
      if (due) {
        nextId = uuidv7();
        const row = {
          id: nextId,
          title: t.title,
          description: t.description,
          priority: t.priority,
          due_date: due,
          due_time: t.dueTime,
          // Keep "start after" the same number of days before the due date.
          start_after: t.startAfter && t.dueDate ? `${addDays(due, diffDays(t.startAfter.slice(0, 10), t.dueDate))}${t.startAfter.slice(10)}` : null,
          project_id: t.projectId,
          estimate_min: t.estimateMin,
          series_id: series.id,
          created_at: now,
          updated_at: now,
        };
        const cols = Object.keys(row);
        st.push({ sql: `INSERT INTO task (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, params: Object.values(row) });
        st.push({ sql: 'INSERT INTO task_tag (task_id, tag_id) SELECT ?, tag_id FROM task_tag WHERE task_id = ?', params: [nextId, id] });
        st.push(this.systemNote(nextId, `Created from recurring series, previous one ${to === 'done' ? 'completed' : 'skipped'}`, now));
      }
    }
    await this.write(st);
    return { nextId };
  }

  async setRecurrence(taskId: Id, rec: { rule: string; mode: RecurrenceMode } | null): Promise<void> {
    const t = this.task(taskId);
    const now = nowIso();
    if (!rec) {
      if (!t.seriesId) return;
      await this.write([
        { sql: 'UPDATE task SET series_id = NULL, updated_at = ? WHERE id = ?', params: [now, taskId] },
        this.systemNote(taskId, 'No longer repeats'),
      ]);
      return;
    }
    const err = ruleError(rec.rule);
    if (err) throw new StoreError('invalid', err);
    if (t.seriesId) {
      await this.write([
        { sql: 'UPDATE recurrence_series SET rrule = ?, mode = ?, updated_at = ? WHERE id = ?', params: [rec.rule, rec.mode, now, t.seriesId] },
      ]);
      return;
    }
    const sid = uuidv7();
    await this.write([
      { sql: 'INSERT INTO recurrence_series (id, rrule, mode, updated_at) VALUES (?,?,?,?)', params: [sid, rec.rule, rec.mode, now] },
      { sql: 'UPDATE task SET series_id = ?, due_date = COALESCE(due_date, ?), updated_at = ? WHERE id = ?', params: [sid, firstDueOnOrAfter(rec.rule, toDateStr(new Date())) ?? toDateStr(new Date()), now, taskId] },
    ]);
  }

  // ---------- Notes ----------

  async addNote(taskId: Id, body: string): Promise<void> {
    if (!body.trim()) return;
    const id = uuidv7();
    const now = nowIso();
    await this.write([
      { sql: 'INSERT INTO note (id, task_id, body, kind, created_at) VALUES (?,?,?,?,?)', params: [id, taskId, body.trim(), 'user', now] },
    ]);
  }

  async editNote(id: Id, body: string): Promise<void> {
    await this.write([
      { sql: "UPDATE note SET body = ?, edited_at = ? WHERE id = ? AND kind = 'user'", params: [body, nowIso(), id] },
    ]);
  }

  // ---------- Dependencies ----------

  async addDependency(blockerId: Id, blockedId: Id): Promise<void> {
    const graph = this.graph();
    const loop = graph.findCycle(blockerId, blockedId);
    if (loop) {
      const tasks = this.taskMap();
      const names = loop.map((id) => tasks.get(id)?.title ?? '?');
      throw new StoreError('cycle', blockerId === blockedId ? 'A task cannot block itself.' : `Can't add: that would create a loop (${names.join(' → ')} → ${names[0]}).`, loop);
    }
    const tasks = this.taskMap();
    await this.write([
      { sql: 'INSERT OR IGNORE INTO dependency (blocker_id, blocked_id, created_at) VALUES (?,?,?)', params: [blockerId, blockedId, nowIso()] },
      this.systemNote(blockedId, `Blocked by: ${tasks.get(blockerId)?.title ?? '?'}`),
    ]);
  }

  async removeDependency(blockerId: Id, blockedId: Id): Promise<void> {
    const tasks = this.taskMap();
    await this.write([
      { sql: 'DELETE FROM dependency WHERE blocker_id = ? AND blocked_id = ?', params: [blockerId, blockedId] },
      this.systemNote(blockedId, `No longer blocked by: ${tasks.get(blockerId)?.title ?? '?'}`),
    ]);
  }

  // ---------- Projects ----------

  async createProject(name: string, parentId: Id | null = null, context: Context | null = null): Promise<Id> {
    const id = uuidv7();
    const siblings = this.snapshot.projects.filter((p) => p.parentId === parentId).length;
    const sortKey = `a${String(siblings).padStart(4, '0')}`;
    await this.write([
      { sql: 'INSERT INTO project (id, parent_id, name, context, sort_key, updated_at) VALUES (?,?,?,?,?,?)', params: [id, parentId, name.trim(), context, sortKey, nowIso()] },
    ]);
    return id;
  }

  /** Creates any missing projects along a path like "Work/Clients/Acme" and returns the last id. */
  async ensureProjectPath(path: string): Promise<Id | null> {
    const parts = path.split('/').map((s) => s.trim()).filter(Boolean);
    let parent: Id | null = null;
    for (const name of parts) {
      const found: Project | undefined = this.snapshot.projects.find((p) => p.parentId === parent && p.name.toLowerCase() === name.toLowerCase());
      parent = found ? found.id : await this.createProject(name, parent);
    }
    return parent;
  }

  async updateProject(id: Id, patch: Partial<Pick<Project, 'name' | 'color' | 'context' | 'urgencyWeight' | 'parentId' | 'archivedAt'>>): Promise<void> {
    if ('parentId' in patch && !this.tree().canMove(id, patch.parentId ?? null)) {
      throw new StoreError('cycle', "Can't move a project inside itself or one of its sub-projects.");
    }
    const entries = Object.entries(patch);
    if (!entries.length) return;
    await this.write([
      { sql: `UPDATE project SET ${entries.map(([k]) => `${snake(k)} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, params: [...entries.map(([, v]) => v), nowIso(), id] },
    ]);
  }

  /** Deletes a project; its tasks and sub-projects move up to its parent. */
  async deleteProject(id: Id): Promise<void> {
    const p = this.snapshot.projects.find((x) => x.id === id);
    if (!p) return;
    const now = nowIso();
    await this.write([
      { sql: 'UPDATE task SET project_id = ?, updated_at = ? WHERE project_id = ?', params: [p.parentId, now, id] },
      { sql: 'UPDATE project SET parent_id = ?, updated_at = ? WHERE parent_id = ?', params: [p.parentId, now, id] },
      { sql: 'UPDATE project SET deleted_at = ?, updated_at = ? WHERE id = ?', params: [now, now, id] },
    ]);
  }

  // ---------- Tags ----------

  async updateTag(id: Id, patch: Partial<Pick<Tag, 'name' | 'color' | 'urgencyWeight'>>): Promise<void> {
    const entries = Object.entries(patch);
    if (!entries.length) return;
    await this.write([
      { sql: `UPDATE tag SET ${entries.map(([k]) => `${snake(k)} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, params: [...entries.map(([, v]) => v), nowIso(), id] },
    ]);
  }

  async deleteTag(id: Id): Promise<void> {
    await this.write([
      { sql: 'DELETE FROM task_tag WHERE tag_id = ?', params: [id] },
      { sql: 'UPDATE tag SET deleted_at = ? WHERE id = ?', params: [nowIso(), id] },
    ]);
  }

  // ---------- Settings & export ----------

  async saveSettings(patch: Partial<Settings>): Promise<void> {
    await this.write(
      Object.entries(patch).map(([k, v]) => ({ sql: 'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', params: [k, JSON.stringify(v)] })),
    );
  }

  /**
   * Adds tasks read from another app in one transaction. Missing projects (by path) and
   * tags (by name) are created. Each task gets a system note saying where it came from.
   */
  async importTasks(items: ImportItem[], source: string): Promise<number> {
    if (!items.length) return 0;
    const st: Statement[] = [];
    const now = nowIso();
    const tree = this.tree();
    // Existing projects by lower-case path; new ones are added as they are needed.
    const byPath = new Map<string, Id>();
    for (const { project } of tree.flatten()) byPath.set(tree.path(project.id, '/').toLowerCase(), project.id);
    const siblingCount = new Map<Id | null, number>();
    for (const p of this.snapshot.projects) siblingCount.set(p.parentId, (siblingCount.get(p.parentId) ?? 0) + 1);
    const ensurePath = (path: string | null): Id | null => {
      const parts = (path ?? '').split('/').map((x) => x.trim()).filter(Boolean);
      let parent: Id | null = null;
      for (let i = 0; i < parts.length; i++) {
        const key = parts.slice(0, i + 1).join('/').toLowerCase();
        let id = byPath.get(key);
        if (!id) {
          id = uuidv7();
          const n = siblingCount.get(parent) ?? 0;
          siblingCount.set(parent, n + 1);
          st.push({ sql: 'INSERT INTO project (id, parent_id, name, sort_key, updated_at) VALUES (?,?,?,?,?)', params: [id, parent, parts[i]!, `a${String(n).padStart(4, '0')}`, now] });
          byPath.set(key, id);
        }
        parent = id;
      }
      return parent;
    };

    // Small offsets keep the imported order when sorting by creation time.
    const base = Date.now();
    items.forEach((it, i) => {
      const id = uuidv7(base + i);
      const createdAt = it.createdAt ?? new Date(base + i).toISOString();
      const open = it.status === 'todo' || it.status === 'in_progress';
      let seriesId: Id | null = null;
      if (it.recurrence && open) {
        seriesId = uuidv7(base + i);
        st.push({ sql: 'INSERT INTO recurrence_series (id, rrule, mode, updated_at) VALUES (?,?,?,?)', params: [seriesId, it.recurrence.rule, it.recurrence.mode, now] });
      }
      const row = {
        id,
        title: it.title.trim().slice(0, 500) || 'Untitled',
        description: it.description,
        status: it.status,
        priority: it.priority,
        due_date: it.dueDate ?? (seriesId ? now.slice(0, 10) : null),
        due_time: it.dueTime,
        project_id: ensurePath(it.projectPath),
        estimate_min: it.estimateMin,
        series_id: seriesId,
        created_at: createdAt,
        updated_at: now,
        started_at: it.status === 'in_progress' ? now : null,
        completed_at: open ? null : (it.completedAt ?? now),
      };
      const cols = Object.keys(row);
      st.push({ sql: `INSERT INTO task (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, params: Object.values(row) });
      st.push(this.systemNote(id, `Imported from ${source}`, now));
      it.notes.forEach((body, k) => {
        st.push({ sql: 'INSERT INTO note (id, task_id, body, kind, created_at) VALUES (?,?,?,?,?)', params: [uuidv7(base + i), id, body, 'user', new Date(base + k).toISOString()] });
      });
      st.push(...this.tagStatements(id, [...new Set(it.tags)]));
    });
    await this.write(st);
    return items.length;
  }

  exportJson(): string {
    return JSON.stringify({ format: 'todo-export', version: 1, exportedAt: nowIso(), ...this.snapshot }, null, 2);
  }
}
