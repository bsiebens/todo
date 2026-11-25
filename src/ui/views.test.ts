import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Snapshot } from '../db/store';
import { makeProject, makeTask } from '../domain/testing';
import { computeDerived } from './state';
import { selectView } from './views';

const snap = (tasks: Snapshot['tasks']): Snapshot => ({
  tasks,
  notes: [],
  projects: [makeProject({ id: 'p1', name: 'Work' })],
  tags: [],
  taskTags: [],
  deps: [],
  series: [],
  settings: DEFAULT_SETTINGS,
});

const ids = (s: Snapshot, kind: 'focus' | 'inbox') => {
  const d = computeDerived(s, new Date('2026-11-25T09:00:00'));
  const r = selectView({ kind }, s, d, { showHidden: true, includeSub: false });
  return { ids: r.sections.flatMap((x) => x.tasks.map((t) => t.id)).sort(), hidden: r.hidden };
};

describe('Focus view', () => {
  const tasks = [
    makeTask({ id: 'plain' }), // fresh quick add, nothing set
    makeTask({ id: 'project', projectId: 'p1' }),
    makeTask({ id: 'due', dueDate: '2026-11-28' }),
    makeTask({ id: 'prio', priority: 3 }),
    makeTask({ id: 'star', focus: true }),
    makeTask({ id: 'started', status: 'in_progress' }),
  ];

  it('keeps unsorted Inbox tasks out of Focus', () => {
    const r = ids(snap(tasks), 'focus');
    expect(r.ids).toEqual(['due', 'prio', 'project', 'star', 'started']);
    expect(r.hidden?.inbox).toBe(1);
  });

  it('still lists them in the Inbox', () => {
    expect(ids(snap(tasks), 'inbox').ids).toContain('plain');
  });
});
