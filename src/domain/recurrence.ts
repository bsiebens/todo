import { RRule, Weekday } from 'rrule';
import type { RecurrenceMode } from './types';
import { addDays, parseDateStr, toDateStr } from './dates';

/**
 * rrule works in UTC; we feed it "floating" dates as UTC midnight and read them back
 * the same way, so a local calendar date never shifts.
 */
const toUtc = (s: string) => {
  const d = parseDateStr(s);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
};
const fromUtc = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

export function parseRule(rule: string, dtstart: string): RRule {
  const opts = RRule.parseString(rule.replace(/^RRULE:/, ''));
  return new RRule({ ...opts, dtstart: toUtc(dtstart) });
}

/**
 * Next due date for a recurring task.
 * - schedule: next occurrence of the rule strictly after max(previous due, today). Missed
 *   occurrences are skipped, so a holiday does not leave a pile of overdue copies.
 * - after_completion: completion date plus the rule's interval.
 */
export function nextDueDate(rule: string, mode: RecurrenceMode, previousDue: string | null, completedOn: string): string | null {
  if (mode === 'after_completion') {
    const opts = RRule.parseString(rule.replace(/^RRULE:/, ''));
    const n = opts.interval ?? 1;
    const d = parseDateStr(completedOn);
    switch (opts.freq) {
      case RRule.DAILY:
        return addDays(completedOn, n);
      case RRule.WEEKLY:
        return addDays(completedOn, 7 * n);
      case RRule.MONTHLY:
        d.setMonth(d.getMonth() + n);
        return toDateStr(d);
      case RRule.YEARLY:
        d.setFullYear(d.getFullYear() + n);
        return toDateStr(d);
      default:
        return addDays(completedOn, n);
    }
  }
  const anchor = previousDue ?? completedOn;
  const r = parseRule(rule, anchor);
  const after = previousDue && previousDue > completedOn ? previousDue : completedOn;
  const next = r.after(toUtc(after), false);
  return next ? fromUtc(next) : null;
}

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Plain-language summary, e.g. "Every 2 weeks on Monday, counted from completion". */
export function describeRule(rule: string, mode: RecurrenceMode): string {
  let text: string;
  try {
    const opts = RRule.parseString(rule.replace(/^RRULE:/, ''));
    const byday = (opts.byweekday as Weekday[] | undefined) ?? [];
    const days = byday.map((w) => (typeof w === 'number' ? w : w.weekday));
    if (opts.freq === RRule.WEEKLY && days.length === 5 && [0, 1, 2, 3, 4].every((d) => days.includes(d))) {
      text = 'Every weekday';
    } else if (opts.freq === RRule.MONTHLY && opts.bysetpos === -1 && days.length === 5) {
      text = 'Monthly on the last working day';
    } else {
      text = new RRule(opts).toText();
      text = text.charAt(0).toUpperCase() + text.slice(1);
      if (days.length && !text.includes('on')) text += ` on ${days.map((d) => DAY_NAMES[d]).join(', ')}`;
    }
  } catch {
    text = rule;
  }
  return mode === 'after_completion' ? `${text}, counted from completion` : text;
}

export const RECURRENCE_PRESETS: { label: string; rule: string; mode: RecurrenceMode }[] = [
  { label: 'Every day', rule: 'FREQ=DAILY', mode: 'schedule' },
  { label: 'Every weekday', rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', mode: 'schedule' },
  { label: 'Every week', rule: 'FREQ=WEEKLY', mode: 'schedule' },
  { label: 'Every 2 weeks', rule: 'FREQ=WEEKLY;INTERVAL=2', mode: 'schedule' },
  { label: 'Every month', rule: 'FREQ=MONTHLY', mode: 'schedule' },
  { label: 'Last working day of the month', rule: 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', mode: 'schedule' },
  { label: 'Every year', rule: 'FREQ=YEARLY', mode: 'schedule' },
  { label: '3 days after done', rule: 'FREQ=DAILY;INTERVAL=3', mode: 'after_completion' },
  { label: '1 week after done', rule: 'FREQ=WEEKLY', mode: 'after_completion' },
];
