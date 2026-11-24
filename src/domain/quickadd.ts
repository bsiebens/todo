import type { Priority, RecurrenceMode } from './types';
import { addDays, parseDateStr, pad, toDateStr } from './dates';

export type ChipKind = 'date' | 'time' | 'priority' | 'tag' | 'project' | 'repeat' | 'estimate';

export interface QuickAddResult {
  title: string;
  priority: Priority | null;
  tags: string[];
  projectPath: string | null;
  dueDate: string | null;
  dueTime: string | null;
  rule: string | null;
  mode: RecurrenceMode;
  estimateMin: number | null;
  chips: { kind: ChipKind; label: string }[];
}

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const RRULE_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};
const PRIORITIES: Record<string, Priority> = {
  '!none': 0, '!low': 1, '!1': 1, '!med': 2, '!medium': 2, '!2': 2, '!high': 3, '!3': 3, '!crit': 4, '!critical': 4, '!4': 4,
};
const UNITS: Record<string, 'd' | 'w' | 'm' | 'y'> = {
  day: 'd', days: 'd', week: 'w', weeks: 'w', month: 'm', months: 'm', year: 'y', years: 'y',
};
const FREQ = { d: 'DAILY', w: 'WEEKLY', m: 'MONTHLY', y: 'YEARLY' } as const;

function nextWeekday(today: string, dow: number): string {
  const cur = parseDateStr(today).getDay();
  return addDays(today, (dow - cur + 7) % 7);
}

function addUnit(today: string, n: number, unit: 'd' | 'w' | 'm' | 'y'): string {
  if (unit === 'd') return addDays(today, n);
  if (unit === 'w') return addDays(today, 7 * n);
  const d = parseDateStr(today);
  if (unit === 'm') d.setMonth(d.getMonth() + n);
  else d.setFullYear(d.getFullYear() + n);
  return toDateStr(d);
}

/** A date in the future: "3 dec" in late December of this year means next year only if already past. */
function dayMonth(today: string, day: number, month: number, year?: number): string | null {
  if (day < 1 || day > 31 || month < 0 || month > 11) return null;
  const t = parseDateStr(today);
  let y = year ?? t.getFullYear();
  let d = new Date(y, month, day);
  if (d.getMonth() !== month) return null;
  if (year === undefined && toDateStr(d) < today) d = new Date(++y, month, day);
  return toDateStr(d);
}

function parseTime(w: string): string | null {
  let m = /^(\d{1,2})[:.h](\d{2})$/.exec(w);
  if (m) return +m[1]! < 24 && +m[2]! < 60 ? `${pad(+m[1]!)}:${m[2]}` : null;
  m = /^(\d{1,2})h$/.exec(w);
  if (m) return +m[1]! < 24 ? `${pad(+m[1]!)}:00` : null;
  m = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/.exec(w);
  if (m) {
    let h = +m[1]! % 12;
    if (m[3] === 'pm') h += 12;
    return `${pad(h)}:${m[2] ?? '00'}`;
  }
  return null;
}

/**
 * Parse one line such as "Call accountant fri 14:00 !high #finance @Work/Admin every month".
 * Unrecognised words stay in the title. `today` is a local YYYY-MM-DD.
 */
export function parseQuickAdd(input: string, today: string): QuickAddResult {
  const words = input.trim().split(/\s+/).filter(Boolean);
  const lower = words.map((w) => w.toLowerCase());
  const used = new Array(words.length).fill(false);
  const r: QuickAddResult = {
    title: '', priority: null, tags: [], projectPath: null, dueDate: null, dueTime: null,
    rule: null, mode: 'schedule', estimateMin: null, chips: [],
  };
  const take = (i: number, n = 1) => { for (let k = i; k < i + n; k++) used[k] = true; };

  for (let i = 0; i < words.length; i++) {
    if (used[i]) continue;
    const w = lower[i]!;
    const next = lower[i + 1];

    if (w in PRIORITIES) { r.priority = PRIORITIES[w]!; take(i); continue; }
    if (/^#[^#\s]+$/.test(words[i]!)) { r.tags.push(words[i]!.slice(1)); take(i); continue; }
    if (/^@[^@\s]+$/.test(words[i]!)) { r.projectPath = words[i]!.slice(1).replace(/_/g, ' '); take(i); continue; }

    let m = /^~(\d+)(m|min|h)$/.exec(w);
    if (m) { r.estimateMin = m[2] === 'h' ? +m[1]! * 60 : +m[1]!; take(i); continue; }

    // Recurrence: "every ..." optionally followed by "after done" / "after completion".
    if (w === 'every' && next) {
      let consumed = 0;
      let rule: string | null = null;
      let firstDue: string | null = null;
      const n2 = lower[i + 2];
      if (next === 'day') { rule = 'FREQ=DAILY'; consumed = 2; firstDue = today; }
      else if (next === 'weekday' || next === 'workday') { rule = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'; consumed = 2; }
      else if (next in UNITS) { rule = `FREQ=${FREQ[UNITS[next]!]}`; consumed = 2; }
      else if (/^\d+$/.test(next) && n2 && n2 in UNITS) { rule = `FREQ=${FREQ[UNITS[n2]!]};INTERVAL=${next}`; consumed = 3; }
      else if (next === 'last' && (n2 === 'workday' || n2 === 'weekday')) { rule = 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'; consumed = 3; }
      else if (next === 'first' && (n2 === 'workday' || n2 === 'weekday')) { rule = 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1'; consumed = 3; }
      else {
        const days = next.split(',').map((d) => WEEKDAYS[d]);
        if (days.length && days.every((d) => d !== undefined)) {
          rule = `FREQ=WEEKLY;BYDAY=${days.map((d) => RRULE_DAYS[d!]).join(',')}`;
          consumed = 2;
          firstDue = days.map((d) => nextWeekday(today, d!)).sort()[0]!;
        }
      }
      if (rule) {
        if (lower[i + consumed] === 'after' && ['done', 'completion', 'completed'].includes(lower[i + consumed + 1] ?? '')) {
          r.mode = 'after_completion';
          consumed += 2;
        }
        r.rule = rule;
        if (!r.dueDate && firstDue) r.dueDate = firstDue;
        r.chips.push({ kind: 'repeat', label: words.slice(i, i + consumed).join(' ') });
        take(i, consumed);
        i += consumed - 1;
        continue;
      }
    }

    // Dates
    let date: string | null = null;
    let n = 1;
    if (w === 'today' || w === 'tod') date = today;
    else if (w === 'tomorrow' || w === 'tmr' || w === 'tom') date = addDays(today, 1);
    else if (w in WEEKDAYS) date = nextWeekday(today, WEEKDAYS[w]!);
    else if (w === 'next' && next === 'week') { date = addDays(nextWeekday(addDays(today, 1), 1), 0); n = 2; }
    else if (w === 'in' && next && /^\d+$/.test(next) && lower[i + 2]! in UNITS) { date = addUnit(today, +next, UNITS[lower[i + 2]!]!); n = 3; }
    else if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(w))) date = dayMonth(today, +m[3]!, +m[2]! - 1, +m[1]!);
    else if ((m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(w))) date = dayMonth(today, +m[1]!, +m[2]! - 1, m[3] ? +m[3] : undefined);
    else if (/^\d{1,2}$/.test(w) && next && next in MONTHS) { date = dayMonth(today, +w, MONTHS[next]!); n = 2; }
    else if (w in MONTHS && next && /^\d{1,2}$/.test(next)) { date = dayMonth(today, +next, MONTHS[w]!); n = 2; }
    if (date) {
      r.dueDate = date;
      take(i, n);
      i += n - 1;
      continue;
    }

    // Time, optionally preceded by "at"
    const t = parseTime(w === 'at' && next ? next : w);
    if (t) {
      r.dueTime = t;
      const k = w === 'at' ? 2 : 1;
      take(i, k);
      i += k - 1;
      continue;
    }
  }

  if (r.dueTime && !r.dueDate) r.dueDate = today;
  if (r.rule && !r.dueDate) r.dueDate = today;
  r.title = words.filter((_, i) => !used[i]).join(' ');

  const chips: QuickAddResult['chips'] = [];
  if (r.dueDate) chips.push({ kind: 'date', label: r.dueDate });
  if (r.dueTime) chips.push({ kind: 'time', label: r.dueTime });
  if (r.priority !== null) chips.push({ kind: 'priority', label: ['None', 'Low', 'Medium', 'High', 'Critical'][r.priority]! });
  for (const t of r.tags) chips.push({ kind: 'tag', label: `#${t}` });
  if (r.projectPath) chips.push({ kind: 'project', label: r.projectPath });
  chips.push(...r.chips);
  if (r.estimateMin !== null) chips.push({ kind: 'estimate', label: `${r.estimateMin} min` });
  r.chips = chips;
  return r;
}
