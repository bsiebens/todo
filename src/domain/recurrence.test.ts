import { describe, expect, it } from 'vitest';
import { describeRule, nextDueDate } from './recurrence';

describe('nextDueDate', () => {
  it('schedule mode follows the calendar', () => {
    expect(nextDueDate('FREQ=MONTHLY', 'schedule', '2026-11-01', '2026-11-01')).toBe('2026-12-01');
    expect(nextDueDate('FREQ=WEEKLY;BYDAY=MO,TH', 'schedule', '2026-11-23', '2026-11-23')).toBe('2026-11-26');
  });

  it('schedule mode skips missed occurrences', () => {
    // Daily task due 1 Nov, completed on 24 Nov: next is 25 Nov, not 2 Nov.
    expect(nextDueDate('FREQ=DAILY', 'schedule', '2026-11-01', '2026-11-24')).toBe('2026-11-25');
  });

  it('completing early keeps the schedule', () => {
    expect(nextDueDate('FREQ=WEEKLY', 'schedule', '2026-11-30', '2026-11-24')).toBe('2026-12-07');
  });

  it('last working day of the month', () => {
    expect(nextDueDate('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', 'schedule', '2026-11-30', '2026-11-30')).toBe('2026-12-31');
    expect(nextDueDate('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', 'schedule', '2026-12-31', '2026-12-31')).toBe('2027-01-29');
  });

  it('after completion counts from the completion date', () => {
    expect(nextDueDate('FREQ=DAILY;INTERVAL=4', 'after_completion', '2026-11-10', '2026-11-24')).toBe('2026-11-28');
    expect(nextDueDate('FREQ=MONTHLY', 'after_completion', null, '2026-11-24')).toBe('2026-12-24');
  });
});

describe('describeRule', () => {
  it('reads as a sentence', () => {
    expect(describeRule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'schedule')).toBe('Every weekday');
    expect(describeRule('FREQ=DAILY;INTERVAL=3', 'after_completion')).toBe('Every 3 days, counted from completion');
  });
});
