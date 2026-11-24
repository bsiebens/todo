import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryDriver } from './node-driver';
import { Store, StoreError } from './store';

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
