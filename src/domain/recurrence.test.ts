import { describe, expect, it } from 'vitest';
import { describeRule, firstDueOnOrAfter, nextDueDate, parseRuleSet, ruleError, serializeRuleSet, upcomingDates } from './recurrence';

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

  it('first working day of the month', () => {
    // 1 Nov 2026 is a Sunday, 1 Aug 2026 a Saturday.
    expect(nextDueDate('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1', 'schedule', '2026-10-01', '2026-10-01')).toBe('2026-11-02');
    expect(nextDueDate('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1', 'schedule', '2026-07-01', '2026-07-01')).toBe('2026-08-03');
  });

  it('working day on or before the 15th', () => {
    const r = 'FREQ=MONTHLY;BYMONTHDAY=15;X-WORKDAY=BEFORE';
    // 15 Nov 2026 is a Sunday -> Friday 13 Nov; 15 Dec is a Tuesday; 15 Aug 2026 a Saturday -> 14 Aug.
    expect(nextDueDate(r, 'schedule', '2026-10-15', '2026-10-15')).toBe('2026-11-13');
    expect(nextDueDate(r, 'schedule', '2026-11-13', '2026-11-13')).toBe('2026-12-15');
    expect(nextDueDate(r, 'schedule', '2026-07-15', '2026-07-15')).toBe('2026-08-14');
  });

  it('working day on or before can fall in the previous month', () => {
    // 1 Aug 2026 is a Saturday -> Friday 31 July.
    expect(nextDueDate('FREQ=MONTHLY;BYMONTHDAY=1;X-WORKDAY=BEFORE', 'schedule', '2026-07-01', '2026-07-01')).toBe('2026-07-31');
  });

  it('working day on or after', () => {
    // 1 Nov 2026 is a Sunday -> Monday 2 Nov. 31 Jan 2027 is a Sunday -> Monday 1 Feb.
    expect(nextDueDate('FREQ=MONTHLY;BYMONTHDAY=1;X-WORKDAY=AFTER', 'schedule', '2026-10-01', '2026-10-01')).toBe('2026-11-02');
    expect(nextDueDate('FREQ=MONTHLY;BYMONTHDAY=31;X-WORKDAY=AFTER', 'schedule', '2026-12-31', '2026-12-31')).toBe('2027-02-01');
  });

  it('day 31 clamps to the end of short months', () => {
    expect(nextDueDate('FREQ=MONTHLY;BYMONTHDAY=31', 'schedule', '2027-01-31', '2027-01-31')).toBe('2027-02-28');
    expect(nextDueDate('FREQ=MONTHLY;BYMONTHDAY=-1', 'schedule', '2027-02-28', '2027-02-28')).toBe('2027-03-31');
  });

  it('nth weekday and yearly', () => {
    expect(nextDueDate('FREQ=MONTHLY;BYDAY=2TU', 'schedule', '2026-11-10', '2026-11-10')).toBe('2026-12-08');
    expect(nextDueDate('FREQ=MONTHLY;BYDAY=-1FR', 'schedule', '2026-11-27', '2026-11-27')).toBe('2026-12-25');
    expect(nextDueDate('FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1', 'schedule', '2026-11-24', '2026-11-24')).toBe('2027-03-01');
  });

  it('several rules combine into one sequence', () => {
    const r = 'FREQ=MONTHLY;BYMONTHDAY=15;X-WORKDAY=BEFORE\nFREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1';
    expect(nextDueDate(r, 'schedule', '2026-11-13', '2026-11-13')).toBe('2026-11-30');
    expect(nextDueDate(r, 'schedule', '2026-11-30', '2026-11-30')).toBe('2026-12-15');
    expect(upcomingDates(r, 'schedule', '2026-11-24', '2026-11-24', 4)).toEqual(['2026-11-30', '2026-12-15', '2026-12-31', '2027-01-15']);
  });

  it('intervals count from the previous due date', () => {
    expect(nextDueDate('FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15;X-WORKDAY=BEFORE', 'schedule', '2026-10-15', '2026-10-15')).toBe('2027-01-15');
  });

  it('after completion counts from the completion date', () => {
    expect(nextDueDate('FREQ=DAILY;INTERVAL=4', 'after_completion', '2026-11-10', '2026-11-24')).toBe('2026-11-28');
    expect(nextDueDate('FREQ=MONTHLY', 'after_completion', null, '2026-11-24')).toBe('2026-12-24');
    expect(nextDueDate('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', 'after_completion', null, '2026-11-24')).toBe('2026-11-30');
  });
});

describe('first due date', () => {
  it('starts on or after today', () => {
    expect(firstDueOnOrAfter('FREQ=MONTHLY;BYMONTHDAY=15;X-WORKDAY=BEFORE', '2026-11-24')).toBe('2026-12-15');
    expect(firstDueOnOrAfter('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', '2026-11-30')).toBe('2026-11-30');
  });
});

describe('parse and serialise', () => {
  it('round-trips structured parts', () => {
    const r = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR\nFREQ=MONTHLY;BYMONTHDAY=15;X-WORKDAY=BEFORE\nFREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1';
    expect(serializeRuleSet(parseRuleSet(r))).toBe(r);
    expect(parseRuleSet('RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1')[0]!.kind).toBe('firstWorkday');
  });

  it('keeps other iCalendar rules as raw and rejects nonsense', () => {
    expect(parseRuleSet('FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2')[0]!.kind).toBe('raw');
    expect(ruleError('hello')).toMatch(/Not a valid rule/);
    expect(ruleError('')).toMatch(/empty/);
  });
});

describe('describeRule', () => {
  it('reads as a sentence', () => {
    expect(describeRule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'schedule')).toBe('Every working day');
    expect(describeRule('FREQ=DAILY;INTERVAL=3', 'after_completion')).toBe('Every 3 days, counted from completion');
    expect(describeRule('FREQ=MONTHLY;BYMONTHDAY=15;X-WORKDAY=BEFORE\nFREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', 'schedule')).toBe(
      'Every month on the 15th, or the working day before, plus the last working day of the month',
    );
  });
});
