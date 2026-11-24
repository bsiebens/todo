import { addDays, formatDue, toDateStr } from '../domain/dates';
import { isOpen, type Id, type Task } from '../domain/types';
import type { Snapshot } from '../db/store';
import { byUrgency, type Derived } from './state';

export type View =
  | { kind: 'focus' }
  | { kind: 'upcoming' }
  | { kind: 'inbox' }
  | { kind: 'project'; id: Id }
  | { kind: 'tag'; id: Id }
  | { kind: 'search'; q: string }
  | { kind: 'logbook' }
  | { kind: 'projects' }
  | { kind: 'tags' }
  | { kind: 'settings' };

export interface Section {
  title: string | null;
  tasks: Task[];
}

export interface ViewResult {
  title: string;
  sections: Section[];
  hidden?: { blocked: number; later: number };
}

const isDeferred = (t: Task, now: Date) => !!t.startAfter && new Date(t.startAfter) > now;

export function selectView(view: View, s: Snapshot, d: Derived, opts: { showHidden: boolean; includeSub: boolean }): ViewResult {
  const open = s.tasks.filter(isOpen);
  const sortU = byUrgency(d);
  const today = toDateStr(d.now);

  switch (view.kind) {
    case 'focus': {
      const inProgress = open.filter((t) => t.status === 'in_progress').sort(sortU);
      const todo = open.filter((t) => t.status === 'todo');
      const blocked = todo.filter((t) => d.blocked.has(t.id)).sort(sortU);
      const later = todo.filter((t) => !d.blocked.has(t.id) && isDeferred(t, d.now)).sort(sortU);
      const next = todo.filter((t) => !d.blocked.has(t.id) && !isDeferred(t, d.now)).sort(sortU);
      const sections: Section[] = [];
      if (inProgress.length) sections.push({ title: 'In progress', tasks: inProgress });
      sections.push({ title: 'Next up', tasks: next });
      if (opts.showHidden) {
        if (blocked.length) sections.push({ title: 'Blocked', tasks: blocked });
        if (later.length) sections.push({ title: 'Later', tasks: later });
      }
      return { title: 'Focus', sections, hidden: { blocked: blocked.length, later: later.length } };
    }
    case 'upcoming': {
      const dated = open.filter((t) => t.dueDate).sort((a, b) => `${a.dueDate}${a.dueTime ?? '99'}`.localeCompare(`${b.dueDate}${b.dueTime ?? '99'}`));
      const groups = new Map<string, Task[]>();
      const push = (k: string, t: Task) => {
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(t);
      };
      const horizon = addDays(today, 14);
      for (const t of dated) {
        if (t.dueDate! < today) push('Overdue', t);
        else if (t.dueDate! <= horizon) push(formatDue(t.dueDate, null, today), t);
        else push('Later', t);
      }
      return { title: 'Upcoming', sections: [...groups].map(([title, tasks]) => ({ title, tasks })) };
    }
    case 'inbox':
      return { title: 'Inbox', sections: [{ title: null, tasks: open.filter((t) => !t.projectId).sort(sortU) }] };
    case 'project': {
      const ids = new Set([view.id, ...(opts.includeSub ? d.tree.descendantIds(view.id) : [])]);
      return {
        title: d.tree.path(view.id),
        sections: [{ title: null, tasks: open.filter((t) => t.projectId && ids.has(t.projectId)).sort(sortU) }],
      };
    }
    case 'tag': {
      const tag = s.tags.find((t) => t.id === view.id);
      const ids = new Set(s.taskTags.filter((x) => x.tagId === view.id).map((x) => x.taskId));
      return { title: `#${tag?.name ?? ''}`, sections: [{ title: null, tasks: open.filter((t) => ids.has(t.id)).sort(sortU) }] };
    }
    case 'search':
      return { title: 'Search', sections: [{ title: null, tasks: search(view.q, s, d).sort(sortU) }] };
    case 'logbook': {
      const closed = s.tasks
        .filter((t) => !isOpen(t))
        .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
        .slice(0, 300);
      return { title: 'Logbook', sections: [{ title: null, tasks: closed }] };
    }
    default:
      return { title: '', sections: [] };
  }
}

/**
 * Filters: free text, #tag, project:Work/Clients, status:open|done|todo|in_progress|cancelled|all,
 * due<7d, due:today, due:overdue, !high (minimum priority).
 */
export function search(q: string, s: Snapshot, d: Derived): Task[] {
  const today = toDateStr(d.now);
  const words = q.trim().split(/\s+/).filter(Boolean);
  let status = 'open';
  const filters: ((t: Task) => boolean)[] = [];
  const text: string[] = [];
  for (const w of words) {
    const lw = w.toLowerCase();
    let m: RegExpExecArray | null;
    if (lw.startsWith('#')) {
      const tag = s.tags.find((t) => t.name.toLowerCase() === lw.slice(1));
      filters.push((t) => !!tag && (d.tagsByTask.get(t.id) ?? []).some((g) => g.id === tag.id));
    } else if (lw.startsWith('project:')) {
      const p = d.tree.findByPath(w.slice(8));
      const ids = p ? new Set([p.id, ...d.tree.descendantIds(p.id)]) : new Set<string>();
      filters.push((t) => !!t.projectId && ids.has(t.projectId));
    } else if (lw.startsWith('status:')) {
      status = lw.slice(7);
    } else if ((m = /^due<(\d+)d$/.exec(lw))) {
      const lim = addDays(today, +m[1]!);
      filters.push((t) => !!t.dueDate && t.dueDate < lim);
    } else if (lw === 'due:today') {
      filters.push((t) => t.dueDate === today);
    } else if (lw === 'due:overdue') {
      filters.push((t) => !!t.dueDate && t.dueDate < today);
    } else if ((m = /^!(low|med|medium|high|crit|critical)$/.exec(lw))) {
      const min = { low: 1, med: 2, medium: 2, high: 3, crit: 4, critical: 4 }[m[1] as 'low'];
      filters.push((t) => t.priority >= min);
    } else {
      text.push(lw);
    }
  }
  return s.tasks.filter((t) => {
    if (status === 'open' && !isOpen(t)) return false;
    if (status !== 'open' && status !== 'all' && t.status !== status) return false;
    const hay = `${t.title} ${t.description}`.toLowerCase();
    if (!text.every((w) => hay.includes(w))) return false;
    return filters.every((f) => f(t));
  });
}

export function viewKey(v: View): string {
  return 'id' in v ? `${v.kind}:${v.id}` : v.kind === 'search' ? 'search' : v.kind;
}
