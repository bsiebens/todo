import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { DependencyGraph } from '../domain/dependencies';
import { ProjectTree } from '../domain/projects';
import { isOpen, type Context, type Id, type Note, type Tag, type Task } from '../domain/types';
import { computeUrgency, type Urgency } from '../domain/urgency';
import type { Settings, Snapshot, Store } from '../db/store';

export const StoreContext = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(StoreContext);
  if (!s) throw new Error('Store not ready');
  return s;
}

export function useSnapshot(): Snapshot {
  const store = useStore();
  return useSyncExternalStore(
    (fn) => store.subscribe(fn),
    () => store.snapshot,
  );
}

/** Re-renders every minute so time-based urgency stays current. */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function currentContext(settings: Settings, now: Date): Context {
  if (settings.contextMode !== 'auto') return settings.contextMode;
  const dow = now.getDay() === 0 ? 7 : now.getDay();
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return settings.officeDays.includes(dow) && hm >= settings.officeStart && hm < settings.officeEnd ? 'office' : 'home';
}

export interface Derived {
  now: Date;
  context: Context;
  tasks: Map<Id, Task>;
  graph: DependencyGraph;
  tree: ProjectTree;
  urgency: Map<Id, Urgency>;
  blocked: Set<Id>;
  tagsByTask: Map<Id, Tag[]>;
  notesByTask: Map<Id, Note[]>;
}

export function computeDerived(s: Snapshot, now: Date, weights = s.settings.weights): Derived {
  const tasks = new Map(s.tasks.map((t) => [t.id, t]));
  const graph = new DependencyGraph(s.deps);
  const tree = new ProjectTree(s.projects);
  const context = currentContext(s.settings, now);
  const tagById = new Map(s.tags.map((t) => [t.id, t]));
  const tagsByTask = new Map<Id, Tag[]>();
  for (const tt of s.taskTags) {
    const tag = tagById.get(tt.tagId);
    if (!tag) continue;
    if (!tagsByTask.has(tt.taskId)) tagsByTask.set(tt.taskId, []);
    tagsByTask.get(tt.taskId)!.push(tag);
  }
  const notesByTask = new Map<Id, Note[]>();
  for (const n of s.notes) {
    if (!notesByTask.has(n.taskId)) notesByTask.set(n.taskId, []);
    notesByTask.get(n.taskId)!.push(n);
  }
  const urgency = new Map<Id, Urgency>();
  const blocked = new Set<Id>();
  for (const t of s.tasks) {
    if (!isOpen(t)) continue;
    if (graph.isBlocked(t.id, tasks)) blocked.add(t.id);
    const lastUserNote = notesByTask.get(t.id)?.find((n) => n.kind === 'user');
    urgency.set(
      t.id,
      computeUrgency({
        task: t,
        now,
        context,
        graph,
        tasks,
        tree,
        tagWeights: (tagsByTask.get(t.id) ?? []).map((g) => g.urgencyWeight),
        lastUserNoteAt: lastUserNote?.createdAt ?? null,
        weights,
      }),
    );
  }
  return { now, context, tasks, graph, tree, urgency, blocked, tagsByTask, notesByTask };
}

export function useDerived(): Derived {
  const s = useSnapshot();
  const now = useNow();
  return useMemo(() => computeDerived(s, now), [s, now]);
}

export const byUrgency = (d: Derived) => (a: Task, b: Task) => (d.urgency.get(b.id)?.score ?? 0) - (d.urgency.get(a.id)?.score ?? 0);
