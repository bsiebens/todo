import { describe, expect, it } from 'vitest';
import { buckets, computeAnalytics, type AnalyticsInput } from './analytics';
import { makeTask } from './testing';
import type { Task } from './types';
import type { Urgency } from './urgency';

// Local noon on 24 Nov 2026 keeps local-day conversions stable in any time zone.
const now = new Date(2026, 10, 24, 12, 0, 0);
const at = (day: number, month = 10, hour = 10) => new Date(2026, month, day, hour).toISOString();

function run(tasks: Task[], extra: Partial<AnalyticsInput> = {}) {
  return computeAnalytics({
    tasks,
    now,
    range: '30d',
    blocked: new Set(),
    urgency: new Map(),
    projectLabel: (id) => ({ label: id.toUpperCase(), color: null }),
    tagsByTask: new Map(),
    ...extra,
  });
}

describe('buckets', () => {
  it('builds daily, weekly and monthly buckets ending today', () => {
    expect(buckets('7d', '2026-11-24').map((b) => b.start)).toEqual(['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24']);
    const w = buckets('90d', '2026-11-24');
    expect(w).toHaveLength(13);
    expect(w.at(-1)).toMatchObject({ start: '2026-11-18', end: '2026-11-24' });
    const m = buckets('12m', '2026-11-24');
    expect(m).toHaveLength(12);
    expect(m[0]).toMatchObject({ start: '2025-12-01', end: '2025-12-31' });
    expect(m.at(-1)).toMatchObject({ start: '2026-11-01', end: '2026-11-24' });
  });
});

describe('computeAnalytics', () => {
  it('counts open work by state', () => {
    const tasks = [
      makeTask({ id: 'a', status: 'in_progress' }),
      makeTask({ id: 'b' }),
      makeTask({ id: 'c' }),
      makeTask({ id: 'd', startAfter: new Date(2026, 10, 30).toISOString() }),
      makeTask({ id: 'e', dueDate: '2026-11-20' }),
      makeTask({ id: 'f', dueDate: '2026-11-24' }),
      makeTask({ id: 'g', status: 'done', completedAt: at(20) }),
      makeTask({ id: 'h', status: 'cancelled', completedAt: at(20) }),
    ];
    const a = run(tasks, { blocked: new Set(['c']) });
    expect(a.counts).toMatchObject({ open: 6, inProgress: 1, blocked: 1, deferred: 1, ready: 3, overdue: 1, dueToday: 1, completed: 1, cancelled: 1 });
    expect(a.overdueRate).toBe(0.5);
  });

  it('computes period KPIs', () => {
    const tasks = [
      // created 10 Nov, done 14 Nov (4 days), due 15 Nov: on time
      makeTask({ status: 'done', createdAt: at(10), startedAt: at(12), completedAt: at(14), dueDate: '2026-11-15' }),
      // created 20 Nov, done 22 Nov (2 days), due 21 Nov: late
      makeTask({ status: 'done', createdAt: at(20), completedAt: at(22), dueDate: '2026-11-21' }),
      // created 21 Nov, still open
      makeTask({ createdAt: at(21) }),
      // created long ago, cancelled in period
      makeTask({ status: 'cancelled', createdAt: at(1, 5), completedAt: at(23) }),
    ];
    const a = run(tasks);
    expect(a.period.created).toBe(3);
    expect(a.period.completed).toBe(2);
    expect(a.period.cancelled).toBe(1);
    expect(a.period.completionRate).toBeCloseTo(2 / 3);
    expect(a.period.onTimeRate).toBe(0.5);
    expect(a.period.leadTimeMedian).toBeCloseTo(3);
    expect(a.period.cycleTimeAvg).toBeCloseTo(2);
    expect(a.period.netChange).toBe(0);
    expect(a.period.throughputPerWeek).toBeCloseTo((2 / 30) * 7);
  });

  it('builds the trend with open backlog per bucket', () => {
    const tasks = [
      makeTask({ createdAt: at(22) }),
      makeTask({ status: 'done', createdAt: at(22), completedAt: at(23) }),
      makeTask({ status: 'done', createdAt: at(1, 9), completedAt: at(24) }),
    ];
    const t = run(tasks, { range: '7d' }).trend;
    const byDay = Object.fromEntries(t.map((p) => [p.start, p]));
    expect(byDay['2026-11-22']).toMatchObject({ created: 2, completed: 0, open: 3, completionRate: 0.5 });
    expect(byDay["2026-11-23"]).toMatchObject({ created: 0, completed: 1, open: 2, completionRate: 0.5 });
    expect(byDay['2026-11-24']).toMatchObject({ completed: 1, open: 1 });
  });

  it('breaks down by project, tag and priority', () => {
    const tasks = [
      makeTask({ id: 'a', projectId: 'work', priority: 3, dueDate: '2026-11-01' }),
      makeTask({ id: 'b', projectId: 'work', priority: 3 }),
      makeTask({ id: 'c', priority: 1, status: 'done', completedAt: at(23) }),
      makeTask({ id: 'd', projectId: 'home', status: 'done', completedAt: at(1, 1) }), // outside period: ignored
    ];
    const tag = { id: 'x', name: 'finance', color: null };
    const a = run(tasks, { tagsByTask: new Map([['a', [tag]], ['c', [tag]]]) });
    expect(a.byProject.map((r) => [r.label, r.open, r.overdue, r.completed])).toEqual([
      ['WORK', 2, 1, 0],
      ['Inbox (no project)', 0, 0, 1],
    ]);
    expect(a.byTag).toEqual([{ key: 'x', label: '#finance', color: null, open: 1, overdue: 1, completed: 1 }]);
    expect(a.byPriority.find((r) => r.label === 'High')).toMatchObject({ open: 2, overdue: 1 });
    expect(a.byPriority.find((r) => r.label === 'Low')).toMatchObject({ completed: 1 });
  });

  it('summarises urgency', () => {
    const u = (score: number, band: Urgency['band']): Urgency => ({ score, band, parts: [], effectiveDue: null, inheritedFrom: null });
    const tasks = [makeTask({ id: 'a' }), makeTask({ id: 'b' }), makeTask({ id: 'c' })];
    const a = run(tasks, { urgency: new Map([['a', u(2, 'later')], ['b', u(9, 'soon')], ['c', u(17, 'now')]]) });
    expect(a.urgencyBands).toEqual({ now: 1, soon: 1, later: 1 });
    expect(a.urgencyHistogram.map((b) => [b.from, b.count, b.band])).toEqual([
      [0, 1, 'later'],
      [5, 1, 'soon'],
      [10, 0, 'later'],
      [15, 1, 'now'],
    ]);
  });

  it('handles an empty list', () => {
    const a = run([]);
    expect(a.counts.open).toBe(0);
    expect(a.period.completionRate).toBeNull();
    expect(a.urgencyHistogram).toEqual([]);
  });
});
