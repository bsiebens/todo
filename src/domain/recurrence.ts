import { RRule } from 'rrule';
import type { RecurrenceMode } from './types';
import { addDays, parseDateStr, toDateStr } from './dates';

/**
 * A repeat is a set of one or more rule parts. The task's sequence is the union of every
 * part's dates, so "15th of every month" plus "last working day of the month" gives both.
 *
 * Stored in recurrence_series.rrule as one iCalendar RRULE per line. Working-day shifts
 * that iCalendar cannot express ("last working day on or before the 15th") use a private
 * X-WORKDAY parameter; the sync server stores the text as-is, so every device that runs
 * this code computes the same dates. Working days are Monday to Friday.
 */

/** Weekday index used throughout: 0 = Monday … 6 = Sunday (same as rrule). */
export type WeekdayIdx = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type RulePart =
  | { kind: 'daily'; interval: number }
  /** days empty = the same weekday as the due date. */
  | { kind: 'weekly'; interval: number; days: WeekdayIdx[] }
  /** day 1..31 (clamped to the month's length), or -1 for the last day. */
  | { kind: 'monthDay'; interval: number; day: number }
  /** nth 1..4 or -1 (last). */
  | { kind: 'monthWeekday'; interval: number; nth: number; weekday: WeekdayIdx }
  | { kind: 'firstWorkday'; interval: number }
  | { kind: 'lastWorkday'; interval: number }
  /** Day N; on a weekend it moves back to the Friday before. */
  | { kind: 'workdayOnOrBefore'; interval: number; day: number }
  /** Day N; on a weekend it moves on to the Monday after. */
  | { kind: 'workdayOnOrAfter'; interval: number; day: number }
  | { kind: 'yearly'; interval: number; month: number; day: number }
  /** Any other iCalendar rule, kept verbatim. */
  | { kind: 'raw'; rule: string };

export type RuleKind = RulePart['kind'];

const RR_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const WORKDAYS = 'MO,TU,WE,TH,FR';
export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export class RuleError extends Error {}

// ---------- Parse / serialise ----------

function kv(line: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const seg of line.replace(/^RRULE:/i, '').split(';')) {
    if (!seg.trim()) continue;
    const [k, v = ''] = seg.split('=');
    m.set(k!.trim().toUpperCase(), v.trim().toUpperCase());
  }
  return m;
}

const intOr = (v: string | undefined, d: number) => (v && /^-?\d+$/.test(v) ? Number(v) : d);

/** Turn one stored line into a structured part (falls back to 'raw'). */
export function parsePart(line: string): RulePart {
  const raw = line.replace(/^RRULE:/i, '').trim();
  const p = kv(raw);
  const freq = p.get('FREQ');
  const interval = Math.max(1, intOr(p.get('INTERVAL'), 1));
  const keys = [...p.keys()].filter((k) => k !== 'FREQ' && k !== 'INTERVAL').sort().join(',');
  const byday = p.get('BYDAY') ?? '';
  const workday = p.get('X-WORKDAY');

  if (workday) {
    const day = intOr(p.get('BYMONTHDAY'), NaN);
    if (freq !== 'MONTHLY' || !(day >= 1 && day <= 31) || keys !== 'BYMONTHDAY,X-WORKDAY') throw new RuleError(`Unsupported working-day rule: ${raw}`);
    if (workday === 'BEFORE') return { kind: 'workdayOnOrBefore', interval, day };
    if (workday === 'AFTER') return { kind: 'workdayOnOrAfter', interval, day };
    throw new RuleError(`Unknown X-WORKDAY value: ${workday}`);
  }
  if (freq === 'DAILY' && keys === '') return { kind: 'daily', interval };
  if (freq === 'WEEKLY' && keys === '') return { kind: 'weekly', interval, days: [] };
  if (freq === 'WEEKLY' && keys === 'BYDAY') {
    const days = byday.split(',').map((d) => RR_DAYS.indexOf(d));
    if (days.every((d) => d >= 0)) return { kind: 'weekly', interval, days: [...new Set(days)].sort() as WeekdayIdx[] };
  }
  if (freq === 'MONTHLY') {
    if (keys === 'BYMONTHDAY') {
      const day = intOr(p.get('BYMONTHDAY'), NaN);
      if ((day >= 1 && day <= 31) || day === -1) return { kind: 'monthDay', interval, day };
    }
    if (keys === 'BYDAY,BYSETPOS' && byday === WORKDAYS) {
      const pos = intOr(p.get('BYSETPOS'), NaN);
      if (pos === 1) return { kind: 'firstWorkday', interval };
      if (pos === -1) return { kind: 'lastWorkday', interval };
    }
    if (keys === 'BYDAY') {
      const m = /^([+-]?\d)(MO|TU|WE|TH|FR|SA|SU)$/.exec(byday);
      if (m) {
        const nth = Number(m[1]);
        if ((nth >= 1 && nth <= 4) || nth === -1) return { kind: 'monthWeekday', interval, nth, weekday: RR_DAYS.indexOf(m[2]!) as WeekdayIdx };
      }
    }
  }
  if (freq === 'YEARLY' && keys === 'BYMONTH,BYMONTHDAY') {
    const month = intOr(p.get('BYMONTH'), NaN);
    const day = intOr(p.get('BYMONTHDAY'), NaN);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return { kind: 'yearly', interval, month, day };
  }
  // Anything else must at least be valid iCalendar.
  try {
    const opts = RRule.parseString(raw);
    if (opts.freq === undefined) throw new Error('missing FREQ');
    new RRule(opts).toString();
  } catch (e) {
    throw new RuleError(`Not a valid rule: ${raw}${e instanceof Error ? ` (${e.message})` : ''}`);
  }
  return { kind: 'raw', rule: raw.toUpperCase() };
}

/** Parse a stored rule (one or more lines). Throws RuleError when it is invalid. */
export function parseRuleSet(rule: string): RulePart[] {
  const lines = rule.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new RuleError('The rule is empty');
  return lines.map(parsePart);
}

const iv = (n: number) => (n > 1 ? `;INTERVAL=${n}` : '');

export function serializePart(p: RulePart): string {
  switch (p.kind) {
    case 'daily':
      return `FREQ=DAILY${iv(p.interval)}`;
    case 'weekly':
      return `FREQ=WEEKLY${iv(p.interval)}${p.days.length ? `;BYDAY=${p.days.map((d) => RR_DAYS[d]).join(',')}` : ''}`;
    case 'monthDay':
      return `FREQ=MONTHLY${iv(p.interval)};BYMONTHDAY=${p.day}`;
    case 'monthWeekday':
      return `FREQ=MONTHLY${iv(p.interval)};BYDAY=${p.nth}${RR_DAYS[p.weekday]}`;
    case 'firstWorkday':
      return `FREQ=MONTHLY${iv(p.interval)};BYDAY=${WORKDAYS};BYSETPOS=1`;
    case 'lastWorkday':
      return `FREQ=MONTHLY${iv(p.interval)};BYDAY=${WORKDAYS};BYSETPOS=-1`;
    case 'workdayOnOrBefore':
      return `FREQ=MONTHLY${iv(p.interval)};BYMONTHDAY=${p.day};X-WORKDAY=BEFORE`;
    case 'workdayOnOrAfter':
      return `FREQ=MONTHLY${iv(p.interval)};BYMONTHDAY=${p.day};X-WORKDAY=AFTER`;
    case 'yearly':
      return `FREQ=YEARLY${iv(p.interval)};BYMONTH=${p.month};BYMONTHDAY=${p.day}`;
    case 'raw':
      return p.rule.replace(/^RRULE:/i, '').trim().toUpperCase();
  }
}

export function serializeRuleSet(parts: RulePart[]): string {
  const lines = [...new Set(parts.map(serializePart))];
  return lines.join('\n');
}

/** A sensible starting part for each kind, used by the rule builder. */
export function defaultPart(kind: RuleKind, anchor: string): RulePart {
  const d = parseDateStr(anchor);
  const wd = ((d.getDay() + 6) % 7) as WeekdayIdx;
  switch (kind) {
    case 'daily': return { kind, interval: 1 };
    case 'weekly': return { kind, interval: 1, days: [wd] };
    case 'monthDay': return { kind, interval: 1, day: d.getDate() };
    case 'monthWeekday': return { kind, interval: 1, nth: Math.min(4, Math.ceil(d.getDate() / 7)), weekday: wd };
    case 'firstWorkday': return { kind, interval: 1 };
    case 'lastWorkday': return { kind, interval: 1 };
    case 'workdayOnOrBefore': return { kind, interval: 1, day: 15 };
    case 'workdayOnOrAfter': return { kind, interval: 1, day: 1 };
    case 'yearly': return { kind, interval: 1, month: d.getMonth() + 1, day: d.getDate() };
    case 'raw': return { kind, rule: 'FREQ=WEEKLY' };
  }
}

// ---------- Date generation ----------

/** rrule works in UTC; we feed it floating dates as UTC midnight so a calendar date never shifts. */
const toUtc = (s: string) => {
  const d = parseDateStr(s);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
};
const fromUtc = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

export function parseRule(rule: string, dtstart: string): RRule {
  const opts = RRule.parseString(rule.replace(/^RRULE:/, ''));
  return new RRule({ ...opts, dtstart: toUtc(dtstart) });
}

const daysIn = (y: number, m: number) => new Date(y, m + 1, 0).getDate();
const ymd = (y: number, m: number, d: number) => toDateStr(new Date(y, m, d));
/** 0 = Monday … 6 = Sunday */
const weekdayOf = (s: string) => (parseDateStr(s).getDay() + 6) % 7;
const isWorkday = (s: string) => weekdayOf(s) < 5;

function shiftToWorkday(s: string, dir: -1 | 1): string {
  let d = s;
  while (!isWorkday(d)) d = addDays(d, dir);
  return d;
}

/** The part's date within month m (0-based) of year y, or null when it has none. */
function pickInMonth(p: RulePart, y: number, m: number): string | null {
  const len = daysIn(y, m);
  switch (p.kind) {
    case 'monthDay':
      return ymd(y, m, p.day === -1 ? len : Math.min(p.day, len));
    case 'firstWorkday':
      return shiftToWorkday(ymd(y, m, 1), 1);
    case 'lastWorkday':
      return shiftToWorkday(ymd(y, m, len), -1);
    case 'workdayOnOrBefore':
      return shiftToWorkday(ymd(y, m, Math.min(p.day, len)), -1);
    case 'workdayOnOrAfter':
      return shiftToWorkday(ymd(y, m, Math.min(p.day, len)), 1);
    case 'monthWeekday': {
      if (p.nth === -1) {
        const last = ymd(y, m, len);
        return addDays(last, -((weekdayOf(last) - p.weekday + 7) % 7));
      }
      const first = ymd(y, m, 1);
      return addDays(first, ((p.weekday - weekdayOf(first) + 7) % 7) + 7 * (p.nth - 1));
    }
    case 'yearly':
      return m === p.month - 1 ? ymd(y, m, Math.min(p.day, len)) : null;
    default:
      return null;
  }
}

/** First date of one part strictly after `after`, counting intervals from `anchor`. */
function partNext(p: RulePart, anchor: string, after: string): string | null {
  if (p.kind === 'daily' || p.kind === 'weekly' || p.kind === 'raw') {
    const r = parseRule(serializePart(p), anchor);
    const n = r.after(toUtc(after), false);
    return n ? fromUtc(n) : null;
  }
  const a = parseDateStr(anchor);
  let y = a.getFullYear();
  let m = a.getMonth();
  let step = p.interval;
  if (p.kind === 'yearly') {
    // Start in the anchor year's target month; if that is before the anchor month, the
    // first occurrence is a year later.
    if (p.month - 1 < m) y += 1;
    m = p.month - 1;
    step = 12 * p.interval;
  }
  // A working-day shift can move a date into the neighbouring month, so look one step back.
  const startOffset = p.kind === 'workdayOnOrAfter' ? -step : 0;
  for (let i = startOffset / step; i < 5000; i++) {
    const mm = m + i * step;
    const d = pickInMonth(p, y + Math.floor(mm / 12), ((mm % 12) + 12) % 12);
    if (d && d > after && (i >= 0 || d >= anchor)) return d;
  }
  return null;
}

/** First date of the whole set strictly after `after`. */
export function nextInSet(parts: RulePart[], anchor: string, after: string): string | null {
  let best: string | null = null;
  for (const p of parts) {
    const n = partNext(p, anchor, after);
    if (n && (!best || n < best)) best = n;
  }
  return best;
}

/** Simple "every N units" with no day selection: counted from completion by calendar math. */
function simpleInterval(p: RulePart): { freq: 'd' | 'w' | 'm' | 'y'; n: number } | null {
  if (p.kind === 'daily') return { freq: 'd', n: p.interval };
  if (p.kind === 'weekly' && !p.days.length) return { freq: 'w', n: p.interval };
  if (p.kind === 'raw') {
    const k = kv(p.rule);
    if ([...k.keys()].every((x) => x === 'FREQ' || x === 'INTERVAL')) {
      const n = Math.max(1, intOr(k.get('INTERVAL'), 1));
      const f = { DAILY: 'd', WEEKLY: 'w', MONTHLY: 'm', YEARLY: 'y' }[k.get('FREQ') ?? ''] as 'd' | 'w' | 'm' | 'y' | undefined;
      if (f) return { freq: f, n };
    }
  }
  return null;
}

function addInterval(from: string, s: { freq: 'd' | 'w' | 'm' | 'y'; n: number }): string {
  if (s.freq === 'd') return addDays(from, s.n);
  if (s.freq === 'w') return addDays(from, 7 * s.n);
  const d = parseDateStr(from);
  if (s.freq === 'm') d.setMonth(d.getMonth() + s.n);
  else d.setFullYear(d.getFullYear() + s.n);
  return toDateStr(d);
}

/**
 * Next due date for a recurring task.
 * - schedule: next date of the set strictly after max(previous due, today). Missed dates are
 *   skipped, so a holiday does not leave a pile of overdue copies.
 * - after_completion: "every N days/weeks/…" counts from the completion date; parts that pick
 *   specific days (e.g. last working day) give their first date after completion.
 */
export function nextDueDate(rule: string, mode: RecurrenceMode, previousDue: string | null, completedOn: string): string | null {
  const parts = parseRuleSet(rule);
  if (mode === 'after_completion') {
    let best: string | null = null;
    for (const p of parts) {
      const s = simpleInterval(p);
      const n = s ? addInterval(completedOn, s) : partNext(p, completedOn, completedOn);
      if (n && (!best || n < best)) best = n;
    }
    return best;
  }
  const anchor = previousDue ?? completedOn;
  const after = previousDue && previousDue > completedOn ? previousDue : completedOn;
  return nextInSet(parts, anchor, after);
}

/** First date of the set on or after `from` (used when a task first gets a repeat). */
export function firstDueOnOrAfter(rule: string, from: string): string | null {
  return nextInSet(parseRuleSet(rule), from, addDays(from, -1));
}

/**
 * The next `count` dates, for the preview under the rule builder. In schedule mode the dates
 * follow the calendar from `anchor`; in after_completion mode each date assumes the task is
 * done on its due day.
 */
export function upcomingDates(rule: string, mode: RecurrenceMode, anchor: string, from: string, count = 5): string[] {
  const parts = parseRuleSet(rule);
  const out: string[] = [];
  if (mode === 'after_completion') {
    let d = from;
    for (let i = 0; i < count; i++) {
      const n = nextDueDate(rule, mode, null, d);
      if (!n) break;
      out.push(n);
      d = n;
    }
    return out;
  }
  let after = addDays(from, -1);
  for (let i = 0; i < count; i++) {
    const n = nextInSet(parts, anchor > from ? from : anchor, after);
    if (!n) break;
    out.push(n);
    after = n;
  }
  return out;
}

// ---------- Plain language ----------

const ordinal = (n: number) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${s}`;
};
const NTH = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', [-1]: 'last' } as Record<number, string>;

function every(n: number, unit: string): string {
  return n > 1 ? `every ${n} ${unit}s` : `every ${unit}`;
}

function listDays(days: WeekdayIdx[]): string {
  const names = days.map((d) => DAY_NAMES[d]!);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]!;
}

export function describePart(p: RulePart): string {
  switch (p.kind) {
    case 'daily':
      return every(p.interval, 'day');
    case 'weekly':
      if (p.days.length === 5 && p.days.every((d) => d < 5)) return p.interval > 1 ? `every working day, ${every(p.interval, 'week')}` : 'every working day';
      return p.days.length ? `${every(p.interval, 'week')} on ${listDays(p.days)}` : every(p.interval, 'week');
    case 'monthDay':
      return `${every(p.interval, 'month')} on the ${p.day === -1 ? 'last day' : ordinal(p.day)}`;
    case 'monthWeekday':
      return `${every(p.interval, 'month')} on the ${NTH[p.nth]} ${DAY_NAMES[p.weekday]}`;
    case 'firstWorkday':
      return `the first working day of ${p.interval > 1 ? `every ${p.interval} months` : 'the month'}`;
    case 'lastWorkday':
      return `the last working day of ${p.interval > 1 ? `every ${p.interval} months` : 'the month'}`;
    case 'workdayOnOrBefore':
      return `${every(p.interval, 'month')} on the ${ordinal(p.day)}, or the working day before`;
    case 'workdayOnOrAfter':
      return `${every(p.interval, 'month')} on the ${ordinal(p.day)}, or the working day after`;
    case 'yearly':
      return `${every(p.interval, 'year')} on ${p.day} ${MONTH_NAMES[p.month - 1]}`;
    case 'raw':
      try {
        return new RRule(RRule.parseString(p.rule)).toText();
      } catch {
        return p.rule;
      }
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Plain-language summary, e.g. "Every 2 weeks on Monday, counted from completion". */
export function describeRule(rule: string, mode: RecurrenceMode): string {
  let text: string;
  try {
    const parts = parseRuleSet(rule);
    const bits = parts.map(describePart);
    text = cap(bits.join(', plus '));
  } catch {
    text = rule;
  }
  return mode === 'after_completion' ? `${text}, counted from completion` : text;
}

/** Validate a stored rule; returns an error message or null. */
export function ruleError(rule: string): string | null {
  try {
    parseRuleSet(rule);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export const RECURRENCE_PRESETS: { label: string; rule: string; mode: RecurrenceMode }[] = [
  { label: 'Every day', rule: 'FREQ=DAILY', mode: 'schedule' },
  { label: 'Every working day', rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', mode: 'schedule' },
  { label: 'Every week', rule: 'FREQ=WEEKLY', mode: 'schedule' },
  { label: 'Every 2 weeks', rule: 'FREQ=WEEKLY;INTERVAL=2', mode: 'schedule' },
  { label: 'Every month', rule: 'FREQ=MONTHLY', mode: 'schedule' },
  { label: 'First working day of the month', rule: 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1', mode: 'schedule' },
  { label: 'Last working day of the month', rule: 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', mode: 'schedule' },
  { label: 'Every year', rule: 'FREQ=YEARLY', mode: 'schedule' },
  { label: '3 days after done', rule: 'FREQ=DAILY;INTERVAL=3', mode: 'after_completion' },
  { label: '1 week after done', rule: 'FREQ=WEEKLY', mode: 'after_completion' },
];
