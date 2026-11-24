import { describe, expect, it } from 'vitest';
import { answerQuickEntry } from '../platform/desktop-core';
import { createMemoryDriver } from './node-driver';
import { quickAddTask } from './quick-add';
import { Store } from './store';

describe('quickAddTask', () => {
  it('puts a task in the Inbox unless an @Project is given', async () => {
    const store = await Store.open(await createMemoryDriver());
    const a = await quickAddTask(store, 'Call accountant !high #finance');
    const b = await quickAddTask(store, 'Book flights @Travel');
    const ta = store.snapshot.tasks.find((t) => t.id === a)!;
    const tb = store.snapshot.tasks.find((t) => t.id === b)!;
    expect(ta).toMatchObject({ title: 'Call accountant', priority: 3, projectId: null });
    expect(tb.title).toBe('Book flights');
    expect(store.snapshot.projects.find((p) => p.id === tb.projectId)?.name).toBe('Travel');
    expect(await quickAddTask(store, '   ')).toBeNull();
  });
});

describe('answerQuickEntry', () => {
  const req = { id: 'r1', text: 'Buy milk' };
  it('saves only when signed in', async () => {
    let calls = 0;
    const add = async () => (calls++, 'task-1');
    expect(await answerQuickEntry(req, false, add)).toEqual({ id: 'r1', ok: false, error: 'Sign in to ToDo first.' });
    expect(calls).toBe(0);
    expect(await answerQuickEntry(req, true, add)).toEqual({ id: 'r1', ok: true });
  });
  it('reports a missing title and errors', async () => {
    expect(await answerQuickEntry(req, true, async () => null)).toMatchObject({ ok: false, error: 'Type a name for the task.' });
    expect(await answerQuickEntry(req, true, async () => Promise.reject(new Error('disk full')))).toMatchObject({ ok: false, error: 'disk full' });
  });
});
