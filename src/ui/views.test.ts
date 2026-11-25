import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Snapshot } from '../db/store';
import { makeProject, makeTask } from '../domain/testing';
import { computeDerived } from './state';
import { selectView, type View } from './views';

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

const run = (s: Snapshot, view: View) => {
  const d = computeDerived(s, new Date('2026-11-25T09:00:00'));
  const r = selectView(view, s, d, { showHidden: false, includeSub: false });
  return { r, section: (title: string) => (r.sections.find((x) => x.title === title)?.tasks ?? []).map((t) => t.id).sort() };
};

const tasks = [
  makeTask({ id: 'plain' }), // fresh quick add
  makeTask({ id: 'project', projectId: 'p1' }),
  makeTask({ id: 'overdue', dueDate: '2026-11-20', priority: 4 }), // very urgent, not picked
  makeTask({ id: 'picked', focus: true, focusDate: '2026-11-25' }),
  makeTask({ id: 'yesterday', focus: true, focusDate: '2026-11-24' }), // unfinished from yesterday
  makeTask({ id: 'started', status: 'in_progress' }),
  makeTask({ id: 'done', status: 'done', focus: true, focusDate: '2026-11-25', completedAt: '2026-11-25T08:00:00' }),
];

describe('Focus view (today)', () => {
  it("shows only today's picks and tasks in progress, so it starts empty each morning", () => {
    const { section } = run(snap(tasks), { kind: 'focus' });
    expect(section('In progress')).toEqual(['started']);
    expect(section('Today')).toEqual(['picked']);
  });

  it("counts yesterday's leftovers and urgent tasks as suggestions", () => {
    expect(run(snap(tasks), { kind: 'focus' }).r.suggested).toBe(2);
  });
});

describe('All open view', () => {
  it("suggests urgent tasks and yesterday's leftovers, highest urgency first, and lists the rest", () => {
    const { r, section } = run(snap(tasks), { kind: 'plan' });
    expect(r.sections[0]!.tasks.map((t) => t.id)).toEqual(['overdue', 'yesterday']);
    expect(section('Everything else')).toEqual(['plain', 'project']);
    expect(section('Already in Focus')).toEqual(['picked', 'started']);
  });

  it('keeps low-urgency tasks out of the suggestions', () => {
    const { section } = run(snap([makeTask({ id: 'calm' })]), { kind: 'plan' });
    expect(section('Suggested for today')).toEqual([]);
    expect(section('Everything else')).toEqual(['calm']);
  });
});
