import { describe, expect, it } from 'vitest';
import { DependencyGraph } from './dependencies';
import { ProjectTree } from './projects';
import { makeProject, makeTask } from './testing';
import { computeUrgency, dueSignal } from './urgency';
import type { Task } from './types';

const tree = new ProjectTree([
  makeProject({ id: 'admin', name: 'Admin', context: 'office' }),
  makeProject({ id: 'clients', name: 'Clients', context: 'office' }),
  makeProject({ id: 'home', name: 'Home', context: 'home' }),
]);
const now = new Date('2026-11-24T09:00:00'); // Tuesday morning

function score(task: Task, others: Task[] = [], deps: { blockerId: string; blockedId: string }[] = [], context: 'office' | 'home' = 'office') {
  const tasks = new Map([task, ...others].map((t) => [t.id, t]));
  return computeUrgency({ task, now, context, graph: new DependencyGraph(deps), tasks, tree, tagWeights: [], lastUserNoteAt: null });
}

describe('dueSignal', () => {
  it('follows 0.8 x 3 / (3 + days)', () => {
    expect(dueSignal(now, now, 3)).toBeCloseTo(0.8);
    expect(dueSignal(new Date(now.getTime() + 3 * 864e5), now, 3)).toBeCloseTo(0.4);
    expect(dueSignal(new Date(now.getTime() - 7 * 864e5), now, 3)).toBeCloseTo(1);
    expect(dueSignal(new Date(now.getTime() - 30 * 864e5), now, 3)).toBeCloseTo(1);
  });
});

describe('computeUrgency (worked example from the design doc)', () => {
  it('Submit expense report scores 17.4', () => {
    const report = makeTask({ id: 'r', priority: 3, dueDate: '2026-11-25', dueTime: '17:00', projectId: 'admin', createdAt: '2026-11-14T09:00:00' });
    const archive = makeTask({ id: 'x' });
    const u = score(report, [archive], [{ blockerId: 'r', blockedId: 'x' }]);
    expect(u.score).toBeCloseTo(17.4, 1);
    expect(u.band).toBe('now');
  });

  it('Draft Q1 plan scores 14.4', () => {
    const plan = makeTask({ status: 'in_progress', priority: 2, dueDate: '2026-12-04', dueTime: '09:00', projectId: 'clients', createdAt: '2026-11-19T09:00:00' });
    expect(score(plan).score).toBeCloseTo(14.4, 1);
  });

  it('Fix leaking tap scores 3.5 at the office and 9.5 at home', () => {
    const tap = makeTask({ priority: 2, estimateMin: 15, projectId: 'home', createdAt: '2026-10-25T09:00:00' });
    expect(score(tap).score).toBeCloseTo(3.5, 1);
    expect(score(tap, [], [], 'home').score).toBeCloseTo(9.5, 1);
  });

  it('blocked tasks sink and inherit nothing', () => {
    const a = makeTask({ id: 'a' });
    const b = makeTask({ id: 'b', priority: 3, createdAt: now.toISOString() });
    const u = score(b, [a], [{ blockerId: 'a', blockedId: 'b' }]);
    expect(u.parts.find((p) => p.factor === 'Blocked')?.points).toBe(-10);
  });

  it('a task with no deadline inherits a downstream deadline', () => {
    const quote = makeTask({ id: 'q', title: 'Get quote', createdAt: now.toISOString() });
    const flights = makeTask({ id: 'f', title: 'Book flights', dueDate: '2026-11-24', dueTime: '18:00' });
    const u = score(quote, [flights], [{ blockerId: 'q', blockedId: 'f' }]);
    expect(u.inheritedFrom?.id).toBe('f');
    expect(u.parts.find((p) => p.factor === 'Due soon')!.points).toBeCloseTo(8.5, 1);
  });
});
