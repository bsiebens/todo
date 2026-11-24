import { describe, expect, it } from 'vitest';
import { checkTransition } from './status';

describe('checkTransition', () => {
  it('blocks start and done unless overridden', () => {
    expect(checkTransition('todo', 'in_progress', true)).toEqual({ ok: false, reason: 'blocked' });
    expect(checkTransition('todo', 'done', true)).toEqual({ ok: false, reason: 'blocked' });
    expect(checkTransition('todo', 'done', true, true)).toEqual({ ok: true });
  });
  it('always allows pause, cancel and reopen', () => {
    expect(checkTransition('in_progress', 'todo', true).ok).toBe(true);
    expect(checkTransition('todo', 'cancelled', true).ok).toBe(true);
    expect(checkTransition('done', 'todo', true).ok).toBe(true);
  });
});
