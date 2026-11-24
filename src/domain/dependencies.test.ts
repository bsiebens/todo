import { describe, expect, it } from 'vitest';
import { DependencyGraph } from './dependencies';
import { makeTask } from './testing';

describe('DependencyGraph', () => {
  it('refuses self-links and loops of any length', () => {
    const g = new DependencyGraph([
      { blockerId: 'a', blockedId: 'b' },
      { blockerId: 'b', blockedId: 'c' },
    ]);
    expect(g.wouldCreateCycle('a', 'a')).toBe(true);
    expect(g.wouldCreateCycle('c', 'a')).toBe(true);
    expect(g.findCycle('c', 'a')).toEqual(['a', 'b', 'c']);
    expect(g.wouldCreateCycle('a', 'c')).toBe(false);
    expect(g.wouldCreateCycle('d', 'a')).toBe(false);
  });

  it('a task is blocked only by open blockers', () => {
    const a = makeTask({ id: 'a' });
    const b = makeTask({ id: 'b' });
    const tasks = new Map([a, b].map((t) => [t.id, t]));
    const g = new DependencyGraph([{ blockerId: 'a', blockedId: 'b' }]);
    expect(g.isBlocked('b', tasks)).toBe(true);
    tasks.set('a', { ...a, status: 'done' });
    expect(g.isBlocked('b', tasks)).toBe(false);
    tasks.set('a', { ...a, status: 'cancelled' });
    expect(g.isBlocked('b', tasks)).toBe(false);
  });

  it('counts open tasks downstream, not counting done ones', () => {
    const ts = ['a', 'b', 'c', 'd'].map((id) => makeTask({ id }));
    ts[2] = { ...ts[2]!, status: 'done' };
    const tasks = new Map(ts.map((t) => [t.id, t]));
    const g = new DependencyGraph([
      { blockerId: 'a', blockedId: 'b' },
      { blockerId: 'b', blockedId: 'c' },
      { blockerId: 'c', blockedId: 'd' },
    ]);
    expect(g.openDownstream('a', tasks).map((t) => t.id).sort()).toEqual(['b', 'd']);
  });
});
