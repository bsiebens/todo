import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryDriver } from './node-driver';
import { Store, StoreError } from './store';
import { addDays } from '../domain/dates';

let store: Store;
beforeEach(async () => {
  store = await Store.open(await createMemoryDriver());
});

describe('Store', () => {
  it('creates tasks with tags and a Created note', async () => {
    const id = await store.createTask({ title: 'Pay invoice', priority: 3, tagNames: ['finance', 'Finance'] });
    const s = store.snapshot;
    expect(s.tasks).toHaveLength(1);
    expect(s.tags.map((t) => t.name)).toEqual(['finance']);
    expect(s.taskTags).toEqual([{ taskId: id, tagId: s.tags[0]!.id }]);
    expect(s.notes.map((n) => [n.kind, n.body])).toEqual([['system', 'Created']]);
  });

  it('refuses dependency loops and enforces blocking with an override', async () => {
    const a = await store.createTask({ title: 'Get quote' });
    const b = await store.createTask({ title: 'Book flights' });
    await store.addDependency(a, b);
    await expect(store.addDependency(b, a)).rejects.toMatchObject({ code: 'cycle' });
    await expect(store.setStatus(b, 'done')).rejects.toBeInstanceOf(StoreError);
    await store.setStatus(b, 'done', 'Booked anyway, price was fine');
    expect(store.task(b).status).toBe('done');
    expect(store.snapshot.notes.some((n) => n.taskId === b && n.body.includes('override'))).toBe(true);
  });

  it('completing a blocker unblocks the dependant', async () => {
    const a = await store.createTask({ title: 'A' });
    const b = await store.createTask({ title: 'B' });
    await store.addDependency(a, b);
    await store.setStatus(a, 'done');
    await store.setStatus(b, 'in_progress');
    expect(store.task(b).status).toBe('in_progress');
    expect(store.task(b).startedAt).not.toBeNull();
  });

  it('creates the next instance when a recurring task is completed', async () => {
    const id = await store.createTask({ title: 'Water plants', dueDate: '2026-11-20', tagNames: ['home'], recurrence: { rule: 'FREQ=DAILY;INTERVAL=4', mode: 'after_completion' } });
    const { nextId } = await store.setStatus(id, 'done');
    expect(nextId).toBeTruthy();
    const next = store.task(nextId!);
    expect(next.status).toBe('todo');
    expect(next.seriesId).toBe(store.task(id).seriesId);
    expect(next.dueDate! > '2026-11-20').toBe(true);
    expect(store.snapshot.taskTags.filter((x) => x.taskId === nextId)).toHaveLength(1);
    // Reopening and completing again must not create a second open instance.
    await store.setStatus(id, 'todo');
    const again = await store.setStatus(id, 'done');
    expect(again.nextId).toBeUndefined();
  });

  it('combined working-day repeat rules give working days and reject bad rules', async () => {
    const id = await store.createTask({ title: 'Pay invoices' });
    const rule = 'FREQ=MONTHLY;BYMONTHDAY=15;X-WORKDAY=BEFORE\nFREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1';
    await store.setRecurrence(id, { rule, mode: 'schedule' });
    const due = store.task(id).dueDate!;
    expect([1, 2, 3, 4, 5]).toContain(new Date(`${due}T12:00:00`).getDay());
    const { nextId } = await store.setStatus(id, 'done');
    const next = store.task(nextId!).dueDate!;
    expect(next > due).toBe(true);
    expect([1, 2, 3, 4, 5]).toContain(new Date(`${next}T12:00:00`).getDay());
    await expect(store.setRecurrence(id, { rule: 'NONSENSE', mode: 'schedule' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('the next weekly task lands on the same weekday and keeps the start-after gap', async () => {
    const id = await store.createTask({ title: 'Timesheets', dueDate: '2026-11-27', recurrence: { rule: 'FREQ=WEEKLY', mode: 'schedule' } });
    await store.updateTask(id, { startAfter: '2026-11-24T00:00:00' });
    const { nextId } = await store.setStatus(id, 'done');
    const next = store.task(nextId!);
    expect(new Date(`${next.dueDate}T12:00:00`).getDay()).toBe(5);
    expect(next.dueDate! > '2026-11-27').toBe(true);
    expect(next.startAfter).toBe(`${addDays(next.dueDate!, -3)}T00:00:00`);
  });

  it('builds nested projects from a path and refuses moving into a descendant', async () => {
    const acme = await store.ensureProjectPath('Work/Clients/Acme');
    const again = await store.ensureProjectPath('work/clients/acme');
    expect(again).toBe(acme);
    expect(store.tree().path(acme!)).toBe('Work / Clients / Acme');
    const work = store.tree().findByPath('Work')!.id;
    await expect(store.updateProject(work, { parentId: acme })).rejects.toMatchObject({ code: 'cycle' });
  });

  it('logs due date changes and persists settings', async () => {
    const id = await store.createTask({ title: 'x', dueDate: '2026-12-03' });
    await store.updateTask(id, { dueDate: '2026-12-05' });
    expect(store.snapshot.notes.some((n) => n.body === 'Due date changed from 2026-12-03 to 2026-12-05')).toBe(true);
    await store.saveSettings({ contextMode: 'home', weights: { ...store.snapshot.settings.weights, due: 18 } });
    await store.reload();
    expect(store.snapshot.settings.contextMode).toBe('home');
    expect(store.snapshot.settings.weights.due).toBe(18);
  });

  it('deleting a project moves its tasks and sub-projects up', async () => {
    const acme = (await store.ensureProjectPath('Work/Acme'))!;
    const work = store.tree().findByPath('Work')!.id;
    const sub = await store.createProject('Audit', acme);
    const t = await store.createTask({ title: 't', projectId: acme });
    await store.deleteProject(acme);
    expect(store.task(t).projectId).toBe(work);
    expect(store.snapshot.projects.find((p) => p.id === sub)!.parentId).toBe(work);
  });
});

describe('sync outbox', () => {
  it('queues data from before the sync upgrade so the first sign-in uploads it', async () => {
    const { MIGRATIONS } = await import('./schema');
    const db = await createMemoryDriver();
    const first = (MIGRATIONS[0] as string).split(/;\s*$/m).map((s) => s.replace(/--.*$/gm, '').trim()).filter(Boolean);
    await db.batch([...first.map((sql) => ({ sql })), { sql: 'PRAGMA user_version = 1' }]);
    await db.batch([{ sql: "INSERT INTO task (id, title, created_at, updated_at) VALUES ('t1', 'Old task', 'x', 'x')" }]);
    const s = await Store.open(db);
    const ops = (await s.pendingOps()).map((p) => p.op);
    expect(ops.find((o) => o.entity === 'task' && o.field === 'title')).toMatchObject({ id: 't1', value: '"Old task"' });
    expect(ops.every((o) => o.hlc)).toBe(true);
  });

  it('records one change per field per write, with increasing clocks', async () => {
    const id = await store.createTask({ title: 'A', tagNames: ['x'] });
    await store.ackOps(Number.MAX_SAFE_INTEGER);
    await store.setTags(id, ['x']); // removes and re-adds the same tag
    await store.updateTask(id, { title: 'B' });
    const ops = (await store.pendingOps()).map((p) => p.op);
    const tagOps = ops.filter((o) => o.entity === 'task_tag');
    expect(tagOps.map((o) => o.value)).toEqual(['true']);
    const title = ops.find((o) => o.field === 'title')!;
    expect(title.value).toBe('"B"');
    expect(title.hlc > tagOps[0]!.hlc).toBe(true);
  });

  it('Focus stars carry the day they were given, and sync both fields', async () => {
    const id = await store.createTask({ title: 'Write report' });
    await store.ackOps(Number.MAX_SAFE_INTEGER);
    await store.setFocus([id], true);
    const today = new Date();
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    expect(store.task(id)).toMatchObject({ focus: true, focusDate: day });
    const ops = (await store.pendingOps()).map((p) => [p.op.field, p.op.value]);
    expect(ops).toEqual(expect.arrayContaining([['focus', '1'], ['focus_date', `"${day}"`]]));
    await store.setFocus([id], false);
    expect(store.task(id)).toMatchObject({ focus: false, focusDate: null });
    await store.applyRemote([{ entity: 'task', id, field: 'focus_date', value: '"2026-11-24"', hlc: '999999999999999:0000:zzz' }]);
    expect(store.task(id).focusDate).toBe('2026-11-24');
  });

  it('adds focus_date to a database already set up for sync', async () => {
    const { MIGRATIONS } = await import('./schema');
    const db = await createMemoryDriver();
    const split = (m: string | string[]) => (Array.isArray(m) ? m : m.split(/;\s*$/m).map((x) => x.replace(/--.*$/gm, '').trim()).filter(Boolean));
    await db.batch([...split(MIGRATIONS[0]!), ...split(MIGRATIONS[1]!)].map((sql) => ({ sql })).concat({ sql: 'PRAGMA user_version = 2' }));
    await db.batch([{ sql: "INSERT INTO task (id, title, focus, created_at, updated_at) VALUES ('t1', 'Old star', 1, 'x', 'x')" }]);
    const s = await Store.open(db);
    expect(s.task('t1')).toMatchObject({ focus: true, focusDate: null });
    await s.setFocus(['t1'], true);
    expect((await s.pendingOps()).some((p) => p.op.field === 'focus_date')).toBe(true);
  });

  it('ignores remote changes older than local ones', async () => {
    const id = await store.createTask({ title: 'Local' });
    const applied = await store.applyRemote([{ entity: 'task', id, field: 'title', value: '"Old remote"', hlc: '000000000000001:0000:zzz' }]);
    expect(applied).toBe(0);
    expect(store.task(id).title).toBe('Local');
    await store.applyRemote([{ entity: 'task', id, field: 'title', value: '"New remote"', hlc: '999999999999999:0000:zzz' }]);
    expect(store.task(id).title).toBe('New remote');
    // Applying remote changes does not queue them to be sent back.
    expect((await store.pendingOps()).some((p) => p.op.value === '"New remote"')).toBe(false);
  });
});

describe('Store.importTasks', () => {
  it('creates projects, tags, notes and done tasks in one go', async () => {
    const existing = await store.createProject('Work');
    const { detectAndParse } = await import('../domain/importers');
    const r = detectAndParse([{ name: 'list', text: '# work/Admin\n- [ ] Pay invoice #finance\n- [x] File taxes #finance\nCall mum @Home every week' }], '2026-11-24');
    r.items[0]!.notes.push('Ask for the PO number');
    expect(await store.importTasks(r.items, 'a text list')).toBe(3);
    const s = store.snapshot;
    const tree = store.tree();
    expect(s.projects.map((p) => tree.path(p.id, '/')).sort()).toEqual(['Home', 'Work', 'Work/Admin']);
    expect(s.projects.find((p) => p.name === 'Admin')!.parentId).toBe(existing);
    expect(s.tags.map((t) => t.name)).toEqual(['finance']);
    const byTitle = (t: string) => s.tasks.find((x) => x.title === t)!;
    expect(byTitle('File taxes')).toMatchObject({ status: 'done' });
    expect(byTitle('File taxes').completedAt).not.toBeNull();
    expect(byTitle('Call mum').seriesId).not.toBeNull();
    const notes = s.notes.filter((n) => n.taskId === byTitle('Pay invoice').id).map((n) => [n.kind, n.body]);
    expect(notes).toContainEqual(['system', 'Imported from a text list']);
    expect(notes).toContainEqual(['user', 'Ask for the PO number']);
    expect(await store.pendingCount()).toBeGreaterThan(0);
  });
});
