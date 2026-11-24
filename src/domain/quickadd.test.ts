import { describe, expect, it } from 'vitest';
import { parseQuickAdd } from './quickadd';

const today = '2026-11-24'; // Tuesday

describe('parseQuickAdd', () => {
  it('parses the design doc example', () => {
    const r = parseQuickAdd('Call accountant fri 14:00 !high #finance @Work/Admin every month', today);
    expect(r).toMatchObject({
      title: 'Call accountant',
      dueDate: '2026-11-27',
      dueTime: '14:00',
      priority: 3,
      tags: ['finance'],
      projectPath: 'Work/Admin',
      rule: 'FREQ=MONTHLY',
      mode: 'schedule',
    });
  });

  it('understands relative and absolute dates', () => {
    expect(parseQuickAdd('x tomorrow', today).dueDate).toBe('2026-11-25');
    expect(parseQuickAdd('x in 2 weeks', today).dueDate).toBe('2026-12-08');
    expect(parseQuickAdd('x 3 dec', today).dueDate).toBe('2026-12-03');
    expect(parseQuickAdd('x 3/1', today).dueDate).toBe('2027-01-03');
    expect(parseQuickAdd('x tue', today).dueDate).toBe('2026-11-24');
    expect(parseQuickAdd('x next week', today).dueDate).toBe('2026-11-30');
  });

  it('parses times and puts them on today when no date is given', () => {
    expect(parseQuickAdd('x at 2pm', today)).toMatchObject({ dueDate: today, dueTime: '14:00', title: 'x' });
    expect(parseQuickAdd('x 9h', today).dueTime).toBe('09:00');
  });

  it('parses recurrence including after-completion', () => {
    expect(parseQuickAdd('Water plants every 3 days after done', today)).toMatchObject({
      title: 'Water plants', rule: 'FREQ=DAILY;INTERVAL=3', mode: 'after_completion', dueDate: today,
    });
    expect(parseQuickAdd('Standup every weekday 9:30', today).rule).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
    expect(parseQuickAdd('Gym every mon,thu', today)).toMatchObject({ rule: 'FREQ=WEEKLY;BYDAY=MO,TH', dueDate: '2026-11-26' });
  });

  it('parses estimates and leaves unknown words in the title', () => {
    expect(parseQuickAdd('Read 3 chapters ~30m', today)).toMatchObject({ title: 'Read 3 chapters', estimateMin: 30 });
  });
});
