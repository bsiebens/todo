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
    expect(upcomingDates(r, 'schedule', '2026-11-30', '2026-11-24', 4)).toEqual(['2026-11-30', '2026-12-15', '2026-12-31', '2027-01-15']);
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

describe('anchoring on the due date (preview and completion agree)', () => {
  it('every week follows the due date weekday, not today', () => {
    // Timesheets: due Fri 27 Nov, viewed on Tue 24 Nov.
    expect(upcomingDates('FREQ=WEEKLY', 'schedule', '2026-11-27', '2026-11-24', 4)).toEqual(['2026-11-27', '2026-12-04', '2026-12-11', '2026-12-18']);
    expect(describeRule('FREQ=WEEKLY', 'schedule', '2026-11-27')).toBe('Every week on Friday');
    // Completing early (Tue) or on time (Fri) both create the next one on Fri 4 Dec.
    expect(nextDueDate('FREQ=WEEKLY', 'schedule', '2026-11-27', '2026-11-24')).toBe('2026-12-04');
    expect(nextDueDate('FREQ=WEEKLY', 'schedule', '2026-11-27', '2026-11-27')).toBe('2026-12-04');
    // Completing late skips to the next Friday after today.
    expect(nextDueDate('FREQ=WEEKLY', 'schedule', '2026-11-27', '2026-12-01')).toBe('2026-12-04');
  });

  it('an overdue task previews from today', () => {
    expect(upcomingDates('FREQ=WEEKLY', 'schedule', '2026-11-20', '2026-11-24', 2)).toEqual(['2026-11-27', '2026-12-04']);
  });

  it('every month and every year use the due date and clamp instead of skipping', () => {
    expect(describeRule('FREQ=MONTHLY', 'schedule', '2027-01-31')).toBe('Every month on the 31st');
    expect(nextDueDate('FREQ=MONTHLY', 'schedule', '2027-01-31', '2027-01-31')).toBe('2027-02-28');
    expect(describeRule('FREQ=YEARLY', 'schedule', '2026-12-03')).toBe('Every year on 3 December');
    expect(nextDueDate('FREQ=YEARLY', 'schedule', '2028-02-29', '2028-02-29')).toBe('2029-02-28');
  });

  it('intervals keep their phase when a working-day shift crosses a month', () => {
    // Every 2 months on the 1st or the working day before: 1 Aug 2026 is a Saturday -> 31 Jul.
    // The next one must be October (2 months after August), not September.
    const r = 'FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=1;X-WORKDAY=BEFORE';
    expect(nextDueDate(r, 'schedule', '2026-07-31', '2026-07-31')).toBe('2026-10-01');
    const a = 'FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=31;X-WORKDAY=AFTER';
    // 31 Jan 2027 is a Sunday -> Mon 1 Feb; next is 31 Mar (Wed).
    expect(nextDueDate(a, 'schedule', '2027-02-01', '2027-02-01')).toBe('2027-03-31');
  });

  it('after completion preview assumes done on the due date', () => {
    expect(upcomingDates('FREQ=WEEKLY', 'after_completion', '2026-11-27', '2026-11-24', 3)).toEqual(['2026-11-27', '2026-12-04', '2026-12-11']);
  });
});

describe('every rule produces only dates that fit it', () => {
  const wd = (s: string) => (new Date(`${s}T12:00:00`).getDay() + 6) % 7;
  const dom = (s: string) => Number(s.slice(8));
  const len = (s: string) => new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)), 0).getDate();
  const isWork = (s: string) => wd(s) < 5;
  const cases: [string, (d: string, due: string) => boolean][] = [
    ['FREQ=DAILY', () => true],
    ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', isWork],
    ['FREQ=WEEKLY', (d, due) => wd(d) === wd(due)],
    ['FREQ=WEEKLY;INTERVAL=2', (d, due) => wd(d) === wd(due) && Math.round((Date.parse(d) - Date.parse(due)) / 86400000) % 14 === 0],
    ['FREQ=MONTHLY', (d, due) => dom(d) === Math.min(dom(due), len(d))],
    ['FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1', (d) => isWork(d) && dom(d) <= 3],
    ['FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', (d) => isWork(d) && dom(d) >= len(d) - 2],
    ['FREQ=MONTHLY;BYMONTHDAY=15;X-WORKDAY=BEFORE', (d) => isWork(d) && dom(d) <= 15 && dom(d) >= 13],
    ['FREQ=MONTHLY;BYMONTHDAY=1;X-WORKDAY=AFTER', (d) => isWork(d) && dom(d) <= 3],
    ['FREQ=MONTHLY;BYMONTHDAY=-1', (d) => dom(d) === len(d)],
    ['FREQ=MONTHLY;BYDAY=2TU', (d) => wd(d) === 1 && dom(d) >= 8 && dom(d) <= 14],
    ['FREQ=MONTHLY;BYDAY=-1FR', (d) => wd(d) === 4 && dom(d) > len(d) - 7],
    ['FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1', (d) => d.slice(5) === '03-01'],
  ];
  it.each(cases)('%s', (rule, fits) => {
    for (let k = 0; k < 60; k += 7) {
      const today = `2026-${String(1 + (k % 12)).padStart(2, '0')}-1${k % 10}`;
      const due = firstDueOnOrAfter(rule, today)!;
      expect(fits(due, due)).toBe(true);
      const dates = upcomingDates(rule, 'schedule', due, today, 8);
      expect(dates[0]).toBe(due);
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i]! > dates[i - 1]!).toBe(true);
        expect(fits(dates[i]!, due), `${rule} from ${due}: ${dates[i]}`).toBe(true);
      }
    }
  });
});
