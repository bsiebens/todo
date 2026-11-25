import type { Project, Task } from './types';

let n = 0;
export function makeTask(p: Partial<Task> = {}): Task {
  n++;
  return {
    id: p.id ?? `t${n}`,
    title: `Task ${n}`,
    description: '',
    status: 'todo',
    priority: 0,
    dueDate: null,
    dueTime: null,
    startAfter: null,
    estimateMin: null,
    projectId: null,
    seriesId: null,
    focus: false,
    focusDate: null,
    sortKey: 'a0',
    createdAt: '2026-11-24T08:00:00',
    updatedAt: '2026-11-24T08:00:00',
    startedAt: null,
    completedAt: null,
    ...p,
  };
}

export function makeProject(p: Partial<Project> & { id: string; name: string }): Project {
  return { parentId: null, color: null, context: null, urgencyWeight: null, sortKey: 'a0', archivedAt: null, ...p };
}
