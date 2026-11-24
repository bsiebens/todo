import { useEffect, useMemo, useState } from 'react';
import { parseDateStr } from '../domain/dates';
import {
  DAY_NAMES,
  defaultPart,
  describeRule,
  firstDueOnOrAfter,
  resolvePart,
  MONTH_NAMES,
  parseRuleSet,
  RECURRENCE_PRESETS,
  ruleError,
  serializeRuleSet,
  upcomingDates,
  type RuleKind,
  type RulePart,
  type WeekdayIdx,
} from '../domain/recurrence';
import type { RecurrenceMode, RecurrenceSeries, Task } from '../domain/types';
import { StoreError } from '../db/store';
import { Icon } from './Icon';
import { useStore } from './state';

const KIND_LABELS: { kind: RuleKind; label: string }[] = [
  { kind: 'daily', label: 'Every N days' },
  { kind: 'weekly', label: 'Weekly on days' },
  { kind: 'monthDay', label: 'Monthly on a day' },
  { kind: 'monthWeekday', label: 'Monthly on e.g. 2nd Tuesday' },
  { kind: 'firstWorkday', label: 'First working day of month' },
  { kind: 'lastWorkday', label: 'Last working day of month' },
  { kind: 'workdayOnOrBefore', label: 'Day N, or working day before' },
  { kind: 'workdayOnOrAfter', label: 'Day N, or working day after' },
  { kind: 'yearly', label: 'Yearly on a date' },
  { kind: 'raw', label: 'iCalendar rule (advanced)' },
];

const UNIT: Partial<Record<RuleKind, string>> = {
  daily: 'day',
  weekly: 'week',
  monthDay: 'month',
  monthWeekday: 'month',
  firstWorkday: 'month',
  lastWorkday: 'month',
  workdayOnOrBefore: 'month',
  workdayOnOrAfter: 'month',
  yearly: 'year',
};

const DAY_SHORT = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const DAYS_1_31 = Array.from({ length: 31 }, (_, i) => i + 1);

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function prettyDate(s: string, today: string): string {
  const d = parseDateStr(s);
  const year = d.getFullYear() !== parseDateStr(today).getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${WD[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}${year}`;
}

/** The "Repeats" field of the task detail: presets plus a builder for custom rules. */
export function RepeatField({ task, series, today, onError }: { task: Task; series: RecurrenceSeries | undefined; today: string; onError: (msg: string) => void }) {
  const store = useStore();
  const presetValue = series ? RECURRENCE_PRESETS.findIndex((p) => p.rule === series.rrule && p.mode === series.mode) : -1;
  const [editing, setEditing] = useState(false);
  useEffect(() => setEditing(false), [task.id]);

  const custom = editing || (!!series && presetValue < 0);
  const save = async (rule: string, mode: RecurrenceMode) => {
    try {
      await store.setRecurrence(task.id, { rule, mode });
    } catch (e) {
      onError(e instanceof StoreError ? e.message : String(e));
    }
  };

  return (
    <div className="rep-field">
      <select
        id="f-rep"
        value={custom ? 'custom' : series ? String(presetValue) : 'none'}
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'custom') {
            setEditing(true);
            return;
          }
          setEditing(false);
          if (v === 'none') store.setRecurrence(task.id, null);
          else void save(RECURRENCE_PRESETS[Number(v)]!.rule, RECURRENCE_PRESETS[Number(v)]!.mode);
        }}
      >
        <option value="none">Does not repeat</option>
        {RECURRENCE_PRESETS.map((p, i) => (
          <option key={i} value={i}>{p.label}</option>
        ))}
        <option value="custom">Custom…</option>
      </select>
      {custom ? (
        <RuleBuilder
          rule={series?.rrule ?? null}
          mode={series?.mode ?? 'schedule'}
          anchor={task.dueDate ?? today}
          due={task.dueDate}
          today={today}
          onSave={(rule, mode) => void save(rule, mode)}
          onCancel={series ? undefined : () => setEditing(false)}
        />
      ) : (
        series && <RuleSummary rule={series.rrule} mode={series.mode} due={task.dueDate} today={today} />
      )}
    </div>
  );
}

function RuleSummary({ rule, mode, due, today }: { rule: string; mode: RecurrenceMode; due: string | null; today: string }) {
  const { text, next } = useMemo(() => {
    try {
      // A task without a due date gets the rule's first date when the repeat is set.
      const d = due ?? firstDueOnOrAfter(rule, today);
      return { text: describeRule(rule, mode, d), next: upcomingDates(rule, mode, d, today, 4) };
    } catch {
      return { text: describeRule(rule, mode), next: [] as string[] };
    }
  }, [rule, mode, due, today]);
  return (
    <div className="rep-summary">
      <div className="small">{text}</div>
      {next.length > 0 && (
        <div className="small muted">
          {mode === 'after_completion' ? 'If done on the due date: ' : 'Next: '}
          {next.map((d) => prettyDate(d, today)).join(' · ')}
        </div>
      )}
    </div>
  );
}

function initialParts(rule: string | null, anchor: string, mode: RecurrenceMode): RulePart[] {
  if (!rule) return [defaultPart('weekly', anchor)];
  try {
    // Show "every week" as the weekday it actually uses, so what you see is what repeats.
    return parseRuleSet(rule).map((p) => (mode === 'schedule' ? resolvePart(p, anchor) : p));
  } catch {
    return [{ kind: 'raw', rule }];
  }
}

function RuleBuilder({
  rule,
  mode,
  anchor,
  due,
  today,
  onSave,
  onCancel,
}: {
  rule: string | null;
  mode: RecurrenceMode;
  anchor: string;
  due: string | null;
  today: string;
  onSave: (rule: string, mode: RecurrenceMode) => void;
  onCancel?: () => void;
}) {
  const [parts, setParts] = useState<RulePart[]>(() => initialParts(rule, anchor, mode));
  const [m, setM] = useState<RecurrenceMode>(mode);
  useEffect(() => {
    setParts(initialParts(rule, anchor, mode));
    setM(mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rule, mode]);

  const draft = serializeRuleSet(parts);
  const error = ruleError(draft);
  const dirty = draft !== rule || m !== mode;
  const setPart = (i: number, p: RulePart) => setParts(parts.map((x, j) => (j === i ? p : x)));

  return (
    <div className="rep-builder">
      {parts.map((p, i) => (
        <div key={i} className="rep-part">
          <div className="rep-row">
            {i > 0 && <span className="small muted">and</span>}
            <select aria-label={`Rule ${i + 1} type`} value={p.kind} className="rep-kind" onChange={(e) => setPart(i, defaultPart(e.target.value as RuleKind, anchor))}>
              {KIND_LABELS.map((k) => (
                <option key={k.kind} value={k.kind}>{k.label}</option>
              ))}
            </select>
            {parts.length > 1 && (
              <button className="btn ghost small" aria-label={`Remove rule ${i + 1}`} title="Remove" onClick={() => setParts(parts.filter((_, j) => j !== i))}>
                <Icon name="close" size={14} />
              </button>
            )}
          </div>
          <PartFields part={p} onChange={(np) => setPart(i, np)} />
        </div>
      ))}
      <div className="rep-row">
        <button className="btn small" onClick={() => setParts([...parts, defaultPart('lastWorkday', anchor)])}>
          <Icon name="plus" size={14} /> Add another rule
        </button>
        <span className="small muted">counted</span>
        <select aria-label="Count from" value={m} onChange={(e) => setM(e.target.value as RecurrenceMode)}>
          <option value="schedule">on schedule</option>
          <option value="after_completion">after completion</option>
        </select>
      </div>
      {error ? <div className="error">{error}</div> : <RuleSummary rule={draft} mode={m} due={due} today={today} />}
      <div className="rep-row">
        <button className="btn primary small" disabled={!!error || !dirty} onClick={() => onSave(draft, m)}>
          {rule ? 'Save repeat' : 'Set repeat'}
        </button>
        {onCancel && (
          <button className="btn ghost small" onClick={onCancel}>Cancel</button>
        )}
      </div>
    </div>
  );
}

function NumberIn({ value, onChange, label, min = 1, max = 99 }: { value: number; onChange: (n: number) => void; label: string; min?: number; max?: number }) {
  return (
    <input
      type="number"
      aria-label={label}
      className="rep-num"
      min={min}
      max={max}
      value={value}
      onChange={(e) => {
        const n = Math.round(Number(e.target.value));
        if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
      }}
    />
  );
}

function DaySelect({ value, onChange, allowLast }: { value: number; onChange: (n: number) => void; allowLast?: boolean }) {
  return (
    <select aria-label="Day of the month" value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {DAYS_1_31.map((d) => (
        <option key={d} value={d}>{d}</option>
      ))}
      {allowLast && <option value={-1}>last day</option>}
    </select>
  );
}

function PartFields({ part: p, onChange }: { part: RulePart; onChange: (p: RulePart) => void }) {
  if (p.kind === 'raw') {
    return (
      <div className="rep-row">
        <input
          aria-label="iCalendar rule"
          value={p.rule}
          onChange={(e) => onChange({ kind: 'raw', rule: e.target.value.toUpperCase() })}
          placeholder="FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2"
          style={{ flex: 1, minWidth: 0 }}
        />
      </div>
    );
  }
  const unit = UNIT[p.kind]!;
  return (
    <div className="rep-row">
      <span className="small muted">every</span>
      <NumberIn label="Interval" value={p.interval} onChange={(n) => onChange({ ...p, interval: n })} />
      <span className="small muted">{p.interval > 1 ? `${unit}s` : unit}</span>
      {p.kind === 'weekly' && (
        <span className="rep-days" role="group" aria-label="Days of the week">
          {DAY_SHORT.map((label, d) => {
            const on = p.days.includes(d as WeekdayIdx);
            return (
              <button
                key={d}
                className={`btn small${on ? ' on' : ''}`}
                aria-pressed={on}
                title={DAY_NAMES[d]}
                onClick={() => onChange({ ...p, days: (on ? p.days.filter((x) => x !== d) : [...p.days, d as WeekdayIdx]).sort() })}
              >
                {label}
              </button>
            );
          })}
        </span>
      )}
      {p.kind === 'monthDay' && (
        <>
          <span className="small muted">on day</span>
          <DaySelect value={p.day} allowLast onChange={(day) => onChange({ ...p, day })} />
        </>
      )}
      {(p.kind === 'workdayOnOrBefore' || p.kind === 'workdayOnOrAfter') && (
        <>
          <span className="small muted">on day</span>
          <DaySelect value={p.day} onChange={(day) => onChange({ ...p, day })} />
          <span className="small muted">{p.kind === 'workdayOnOrBefore' ? '(Friday before if on a weekend)' : '(Monday after if on a weekend)'}</span>
        </>
      )}
      {p.kind === 'monthWeekday' && (
        <>
          <span className="small muted">on the</span>
          <select aria-label="Which week" value={p.nth} onChange={(e) => onChange({ ...p, nth: Number(e.target.value) })}>
            <option value={1}>first</option>
            <option value={2}>second</option>
            <option value={3}>third</option>
            <option value={4}>fourth</option>
            <option value={-1}>last</option>
          </select>
          <select aria-label="Weekday" value={p.weekday} onChange={(e) => onChange({ ...p, weekday: Number(e.target.value) as WeekdayIdx })}>
            {DAY_NAMES.map((n, d) => (
              <option key={d} value={d}>{n}</option>
            ))}
          </select>
        </>
      )}
      {p.kind === 'yearly' && (
        <>
          <span className="small muted">on</span>
          <DaySelect value={p.day} onChange={(day) => onChange({ ...p, day })} />
          <select aria-label="Month" value={p.month} onChange={(e) => onChange({ ...p, month: Number(e.target.value) })}>
            {MONTH_NAMES.map((n, i) => (
              <option key={i} value={i + 1}>{n}</option>
            ))}
          </select>
        </>
      )}
    </div>
  );
}
