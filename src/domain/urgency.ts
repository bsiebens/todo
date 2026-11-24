import type { DependencyGraph } from './dependencies';
import type { ProjectTree } from './projects';
import type { Context, Id, Task } from './types';

export interface UrgencyWeights {
  due: number;
  dueHalfLifeDays: number;
  priority: number;
  inProgress: number;
  blocking: number;
  blocked: number;
  focus: number;
  notStartable: number;
  context: number;
  age: number;
  ageFullDays: number;
  quickWin: number;
  quickWinMaxMin: number;
  recentActivity: number;
  bandNow: number;
  bandSoon: number;
}

export const DEFAULT_WEIGHTS: UrgencyWeights = {
  due: 12,
  dueHalfLifeDays: 3,
  priority: 8,
  inProgress: 5,
  blocking: 6,
  blocked: -10,
  focus: 15,
  notStartable: -20,
  context: 3,
  age: 2,
  ageFullDays: 60,
  quickWin: 1.5,
  quickWinMaxMin: 15,
  recentActivity: 1,
  bandNow: 15,
  bandSoon: 8,
};

export const PRESETS: Record<string, Partial<UrgencyWeights>> = {
  Balanced: {},
  'Deadline first': { due: 18, priority: 5 },
  'Priority first': { priority: 14, due: 8 },
  'Finish what I started': { inProgress: 10 },
};

export interface UrgencyInput {
  task: Task;
  now: Date;
  context: Context;
  graph: DependencyGraph;
  tasks: Map<Id, Task>;
  tree: ProjectTree;
  tagWeights: number[];
  lastUserNoteAt: string | null;
  weights?: UrgencyWeights;
}

export interface UrgencyPart {
  factor: string;
  detail: string;
  points: number;
}

export interface Urgency {
  score: number;
  band: 'now' | 'soon' | 'later';
  parts: UrgencyPart[];
  effectiveDue: Date | null;
  inheritedFrom: Task | null;
}

const DAY = 86_400_000;

/** Local ("floating") due moment. A date without time counts as the end of that day. */
export function dueMoment(t: Pick<Task, 'dueDate' | 'dueTime'>): Date | null {
  if (!t.dueDate) return null;
  return new Date(`${t.dueDate}T${t.dueTime ?? '23:59'}:00`);
}

/** 0.8 x H / (H + days left); overdue rises from 0.8 to 1.0 over 7 days. */
export function dueSignal(due: Date, now: Date, halfLife: number): number {
  const days = (due.getTime() - now.getTime()) / DAY;
  if (days <= 0) return 0.8 + 0.2 * Math.min(-days / 7, 1);
  return (0.8 * halfLife) / (halfLife + days);
}

function describeDays(due: Date, now: Date): string {
  const days = (due.getTime() - now.getTime()) / DAY;
  if (days < 0) return `overdue ${Math.max(1, Math.round(-days))} d`;
  if (days < 1) return `due in ${Math.max(1, Math.round(days * 24))} h`;
  return `due in ${Math.round(days)} d`;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function computeUrgency(input: UrgencyInput): Urgency {
  const w = input.weights ?? DEFAULT_WEIGHTS;
  const { task, now, graph, tasks, tree } = input;
  const parts: UrgencyPart[] = [];
  const add = (factor: string, detail: string, points: number) => {
    if (points !== 0) parts.push({ factor, detail, points: round1(points) });
  };

  // Due soon, using the earliest of its own due date and any downstream task's due date.
  let effectiveDue = dueMoment(task);
  let inheritedFrom: Task | null = null;
  for (const d of graph.openDownstream(task.id, tasks)) {
    const m = dueMoment(d);
    if (m && (!effectiveDue || m < effectiveDue)) {
      effectiveDue = m;
      inheritedFrom = d;
    }
  }
  if (effectiveDue) {
    const label = describeDays(effectiveDue, now) + (inheritedFrom ? ` (via "${inheritedFrom.title}")` : '');
    add('Due soon', label, w.due * dueSignal(effectiveDue, now, w.dueHalfLifeDays));
  }

  add('Priority', ['none', 'low', 'medium', 'high', 'critical'][task.priority]!, (w.priority * task.priority) / 4);
  if (task.status === 'in_progress') add('In progress', 'started', w.inProgress);

  const downstream = graph.openDownstream(task.id, tasks).length;
  if (downstream > 0) add('Blocking others', `blocks ${downstream}`, (w.blocking * Math.min(downstream, 4)) / 4);
  if (graph.isBlocked(task.id, tasks)) add('Blocked', 'waiting on another task', w.blocked);
  if (task.focus) add('Focus flag', 'flagged for today', w.focus);
  if (task.startAfter && new Date(task.startAfter) > now) add('Not yet startable', `after ${task.startAfter.slice(0, 10)}`, w.notStartable);

  const ctx = tree.effectiveContext(task.projectId);
  if (ctx !== 'any' && input.context !== 'any') {
    add('Context', ctx === input.context ? `${ctx}, matches` : `${ctx}, you are at ${input.context}`, ctx === input.context ? w.context : -w.context);
  }

  const ageDays = (now.getTime() - new Date(task.createdAt).getTime()) / DAY;
  if (ageDays > 0) add('Age', `${Math.floor(ageDays)} days old`, w.age * Math.min(ageDays / w.ageFullDays, 1));

  if (task.estimateMin !== null && task.estimateMin <= w.quickWinMaxMin) add('Quick win', `${task.estimateMin} min`, w.quickWin);
  if (input.lastUserNoteAt && now.getTime() - new Date(input.lastUserNoteAt).getTime() < 2 * DAY) add('Recent activity', 'note in last 48 h', w.recentActivity);

  const tagSum = input.tagWeights.reduce((a, b) => a + b, 0);
  if (tagSum) add('Tags', 'tag weights', tagSum);
  const pw = tree.effectiveWeight(task.projectId);
  if (pw) add('Project', task.projectId ? tree.path(task.projectId) : '', pw);

  const score = round1(parts.reduce((a, p) => a + p.points, 0));
  const band = score >= w.bandNow ? 'now' : score >= w.bandSoon ? 'soon' : 'later';
  return { score, band, parts, effectiveDue, inheritedFrom };
}
