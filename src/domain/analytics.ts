import { addDays, diffDays, parseDateStr, toDateStr } from './dates';
import { isOpen, type Id, type Priority, type Task } from './types';
import { dueMoment, type Urgency } from './urgency';

/** Analytics over the local task list. Pure functions; the UI passes in derived state. */

export type RangeKey = '7d' | '30d' | '90d' | '12m';

export const RANGES: { key: RangeKey; label: string }[] = [
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
  { key: '12m', label: '12 months' },
];

export interface Bucket {
  /** First local day of the bucket (YYYY-MM-DD). */
  start: string;
  /** Last local day of the bucket, inclusive. */
  end: string;
  label: string;
}

export interface TrendPoint extends Bucket {
  created: number;
  completed: number;
  /** Open tasks at the end of the bucket. */
  open: number;
  /**
   * Share of tasks created in this bucket that are done now; null when none were created.
   * Daily buckets use a trailing 7-day window so the line is not dominated by single days.
   */
  completionRate: number | null;
}

export interface BreakdownRow {
  key: string;
  label: string;
  color: string | null;
  open: number;
  overdue: number;
  completed: number;
}

export interface AnalyticsInput {
  tasks: Task[];
  now: Date;
  range: RangeKey;
  blocked: Set<Id>;
  urgency: Map<Id, Urgency>;
  /** Project id → display label (full path). */
  projectLabel: (id: Id) => { label: string; color: string | null } | null;
  tagsByTask: Map<Id, { id: Id; name: string; color: string | null }[]>;
}

export interface Analytics {
  range: RangeKey;
  periodStart: string;
  today: string;
  counts: {
    open: number;
    todo: number;
    inProgress: number;
    blocked: number;
    deferred: number;
    ready: number;
    overdue: number;
    dueToday: number;
    completed: number; // all time, status done
    cancelled: number; // all time
  };
  period: {
    created: number;
    completed: number;
    cancelled: number;
    /** Done ÷ created, for tasks created in the period. */
    completionRate: number | null;
    /** Done on or before the due moment, for tasks completed in the period that had a due date. */
    onTimeRate: number | null;
    onTimeBase: number;
    /** Days from creation to completion. */
    leadTimeAvg: number | null;
    leadTimeMedian: number | null;
    /** Days from first start to completion. */
    cycleTimeAvg: number | null;
    throughputPerWeek: number;
    netChange: number;
  };
  /** Overdue ÷ open tasks with a due date. */
  overdueRate: number | null;
  openWithDue: number;
  openAgeAvg: number | null;
  oldestOpen: Task | null;
  trend: TrendPoint[];
  byProject: BreakdownRow[];
  byTag: BreakdownRow[];
  byPriority: BreakdownRow[];
  urgencyBands: { now: number; soon: number; later: number };
  urgencyHistogram: { from: number; to: number; count: number; band: 'now' | 'soon' | 'later' }[];
}

const DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Local calendar day of an ISO timestamp. */
export const localDay = (iso: string) => toDateStr(new Date(iso));

const fmtDay = (s: string) => {
  const d = parseDateStr(s);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

export function buckets(range: RangeKey, today: string): Bucket[] {
  const out: Bucket[] = [];
  if (range === '7d' || range === '30d') {
    const n = range === '7d' ? 7 : 30;
    for (let i = n - 1; i >= 0; i--) {
      const day = addDays(today, -i);
      out.push({ start: day, end: day, label: fmtDay(day) });
    }
  } else if (range === '90d') {
    // 13 weeks, each ending on today's weekday.
    for (let i = 12; i >= 0; i--) {
      const end = addDays(today, -7 * i);
      out.push({ start: addDays(end, -6), end, label: fmtDay(addDays(end, -6)) });
    }
  } else {
    const t = parseDateStr(today);
    for (let i = 11; i >= 0; i--) {
      const first = new Date(t.getFullYear(), t.getMonth() - i, 1);
      const last = new Date(t.getFullYear(), t.getMonth() - i + 1, 0);
      const end = toDateStr(last) > today ? today : toDateStr(last);
      const label = MONTHS[first.getMonth()]! + (first.getMonth() === 0 || i === 11 ? ` ${String(first.getFullYear()).slice(2)}` : '');
      out.push({ start: toDateStr(first), end, label });
    }
  }
  return out;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

export const isOverdue = (t: Task, now: Date) => {
  if (!isOpen(t)) return false;
  const due = dueMoment(t);
  return !!due && due < now;
};

export function computeAnalytics(input: AnalyticsInput): Analytics {
  const { tasks, now, range, blocked, urgency } = input;
  const today = toDateStr(now);
  const bs = buckets(range, today);
  const periodStart = bs[0]!.start;
  const inPeriod = (day: string) => day >= periodStart && day <= today;

  const open = tasks.filter(isOpen);
  const deferred = (t: Task) => !!t.startAfter && new Date(t.startAfter) > now;
  const todo = open.filter((t) => t.status === 'todo');
  const counts = {
    open: open.length,
    todo: todo.length,
    inProgress: open.length - todo.length,
    blocked: todo.filter((t) => blocked.has(t.id)).length,
    deferred: todo.filter((t) => !blocked.has(t.id) && deferred(t)).length,
    ready: todo.filter((t) => !blocked.has(t.id) && !deferred(t)).length,
    overdue: open.filter((t) => isOverdue(t, now)).length,
    dueToday: open.filter((t) => t.dueDate === today).length,
    completed: tasks.filter((t) => t.status === 'done').length,
    cancelled: tasks.filter((t) => t.status === 'cancelled').length,
  };

  const created = tasks.filter((t) => inPeriod(localDay(t.createdAt)));
  const done = tasks.filter((t) => t.status === 'done' && t.completedAt && inPeriod(localDay(t.completedAt)));
  const cancelled = tasks.filter((t) => t.status === 'cancelled' && t.completedAt && inPeriod(localDay(t.completedAt)));

  const withDue = done.filter((t) => t.dueDate);
  const onTime = withDue.filter((t) => new Date(t.completedAt!) <= dueMoment(t)!).length;
  const lead = done.map((t) => Math.max(0, (new Date(t.completedAt!).getTime() - new Date(t.createdAt).getTime()) / DAY));
  const cycle = done.filter((t) => t.startedAt).map((t) => Math.max(0, (new Date(t.completedAt!).getTime() - new Date(t.startedAt!).getTime()) / DAY));
  const days = diffDays(today, periodStart) + 1;

  const period = {
    created: created.length,
    completed: done.length,
    cancelled: cancelled.length,
    completionRate: ratio(created.filter((t) => t.status === 'done').length, created.length),
    onTimeRate: ratio(onTime, withDue.length),
    onTimeBase: withDue.length,
    leadTimeAvg: avg(lead),
    leadTimeMedian: median(lead),
    cycleTimeAvg: avg(cycle),
    throughputPerWeek: (done.length / days) * 7,
    netChange: created.length - done.length - cancelled.length,
  };

  const openWithDue = open.filter((t) => t.dueDate).length;
  const ages = open.map((t) => (now.getTime() - new Date(t.createdAt).getTime()) / DAY);
  const oldestOpen = open.reduce<Task | null>((a, t) => (!a || t.createdAt < a.createdAt ? t : a), null);

  // Trend
  const closedDay = (t: Task) => (t.status === 'done' || t.status === 'cancelled') && t.completedAt ? localDay(t.completedAt) : null;
  const trend: TrendPoint[] = bs.map((b) => {
    const inB = (day: string | null) => !!day && day >= b.start && day <= b.end;
    const c = tasks.filter((t) => inB(localDay(t.createdAt)));
    return {
      ...b,
      created: c.length,
      completed: tasks.filter((t) => t.status === 'done' && inB(t.completedAt ? localDay(t.completedAt) : null)).length,
      open: tasks.filter((t) => {
        if (localDay(t.createdAt) > b.end) return false;
        const cd = closedDay(t);
        return !cd || cd > b.end;
      }).length,
      completionRate: (() => {
        const from = b.start === b.end ? addDays(b.end, -6) : b.start;
        const cohort = b.start === b.end ? tasks.filter((t) => { const d = localDay(t.createdAt); return d >= from && d <= b.end; }) : c;
        return ratio(cohort.filter((t) => t.status === 'done').length, cohort.length);
      })(),
    };
  });

  // Breakdowns
  const row = (key: string, label: string, color: string | null): BreakdownRow => ({ key, label, color, open: 0, overdue: 0, completed: 0 });
  const add = (r: BreakdownRow, t: Task) => {
    if (isOpen(t)) {
      r.open++;
      if (isOverdue(t, now)) r.overdue++;
    } else if (t.status === 'done' && t.completedAt && inPeriod(localDay(t.completedAt))) r.completed++;
  };
  const relevant = (t: Task) => isOpen(t) || (t.status === 'done' && !!t.completedAt && inPeriod(localDay(t.completedAt)));

  const projects = new Map<string, BreakdownRow>();
  const tags = new Map<string, BreakdownRow>();
  const prio = new Map<Priority, BreakdownRow>(
    ([4, 3, 2, 1, 0] as Priority[]).map((p) => [p, row(String(p), ['None', 'Low', 'Medium', 'High', 'Critical'][p]!, null)]),
  );
  for (const t of tasks) {
    if (!relevant(t)) continue;
    const pk = t.projectId ?? '';
    if (!projects.has(pk)) {
      const info = t.projectId ? input.projectLabel(t.projectId) : null;
      projects.set(pk, row(pk, info?.label ?? 'Inbox (no project)', info?.color ?? null));
    }
    add(projects.get(pk)!, t);
    for (const g of input.tagsByTask.get(t.id) ?? []) {
      if (!tags.has(g.id)) tags.set(g.id, row(g.id, `#${g.name}`, g.color));
      add(tags.get(g.id)!, t);
    }
    add(prio.get(t.priority)!, t);
  }
  const sortRows = (rows: BreakdownRow[]) => rows.sort((a, b) => b.open - a.open || b.completed - a.completed || a.label.localeCompare(b.label));

  // Urgency
  const scores = open.map((t) => urgency.get(t.id)).filter((u): u is Urgency => !!u);
  const urgencyBands = { now: 0, soon: 0, later: 0 };
  for (const u of scores) urgencyBands[u.band]++;
  const urgencyHistogram = histogram(scores);

  return {
    range,
    periodStart,
    today,
    counts,
    period,
    overdueRate: ratio(counts.overdue, openWithDue),
    openWithDue,
    openAgeAvg: avg(ages),
    oldestOpen,
    trend,
    byProject: sortRows([...projects.values()]),
    byTag: sortRows([...tags.values()]),
    byPriority: [...prio.values()],
    urgencyBands,
    urgencyHistogram,
  };
}

/** Equal-width bins (width 5) over the observed score range, each tagged with the band of its tasks' majority. */
function histogram(scores: Urgency[]) {
  if (!scores.length) return [];
  const width = 5;
  const lo = Math.floor(Math.min(...scores.map((u) => u.score)) / width) * width;
  const hi = Math.max(lo + width, Math.ceil((Math.max(...scores.map((u) => u.score)) + 0.0001) / width) * width);
  const bins: { from: number; to: number; count: number; band: 'now' | 'soon' | 'later'; tally: Record<string, number> }[] = [];
  for (let f = lo; f < hi; f += width) bins.push({ from: f, to: f + width, count: 0, band: 'later', tally: { now: 0, soon: 0, later: 0 } });
  for (const u of scores) {
    const b = bins[Math.min(bins.length - 1, Math.floor((u.score - lo) / width))]!;
    b.count++;
    b.tally[u.band]!++;
  }
  return bins.map(({ tally, ...b }) => ({
    ...b,
    band: (['now', 'soon', 'later'] as const).reduce((best, k) => (tally[k]! > tally[best]! ? k : best), 'later' as 'now' | 'soon' | 'later'),
  }));
}
