import { describe, expect, it } from 'vitest';
import { DEFAULT_REMINDERS } from '../sync/protocol';
import { dueReminders, type DueTask } from './reminders';

const tz = 'Europe/Brussels';
const task = (id: string, dueDate: string, dueTime: string | null, title = id): DueTask => ({ id, title, dueDate, dueTime });
// 24 Nov 2026 is winter time in Brussels: UTC+1.
const at = (local: string) => new Date(`${local}:00+01:00`);

describe('dueReminders', () => {
  const tasks = [task('a', '2026-11-24', '14:00', 'Call accountant'), task('b', '2026-11-24', null, 'Pay bill'), task('c', '2026-11-20', null, 'Old thing')];

  it('fires at the due time and stays due for 30 minutes', () => {
    const s = { ...DEFAULT_REMINDERS, digest: false };
    expect(dueReminders(tasks, s, at('2026-11-24T13:59'), tz)).toEqual([]);
    const r = dueReminders(tasks, s, at('2026-11-24T14:00'), tz);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ key: 'due:a:2026-11-24T14:00:0', title: 'Call accountant', body: 'Due now (14:00)', url: '/#task=a' });
    expect(dueReminders(tasks, s, at('2026-11-24T14:29'), tz)).toHaveLength(1);
    expect(dueReminders(tasks, s, at('2026-11-24T14:31'), tz)).toEqual([]);
  });

  it('honours the lead time and puts it in the key', () => {
    const s = { ...DEFAULT_REMINDERS, digest: false, leadMin: 15 };
    const r = dueReminders(tasks, s, at('2026-11-24T13:45'), tz);
    expect(r.map((x) => [x.key, x.body])).toEqual([['due:a:2026-11-24T14:00:15', 'Due at 14:00, in 15 min']]);
  });

  it('sends one morning summary with overdue first', () => {
    const s = { ...DEFAULT_REMINDERS, atDueTime: false };
    expect(dueReminders(tasks, s, at('2026-11-24T07:59'), tz)).toEqual([]);
    const r = dueReminders(tasks, s, at('2026-11-24T08:05'), tz);
    expect(r).toEqual([{ key: 'digest:2026-11-24', title: '2 due today, 1 overdue', body: 'Old thing · Pay bill · Call accountant', tag: 'digest', url: '/' }]);
    expect(dueReminders(tasks, s, at('2026-11-24T11:01'), tz)).toEqual([]);
  });

  it('reads times in the given time zone', () => {
    const s = { ...DEFAULT_REMINDERS, digest: false };
    expect(dueReminders(tasks, s, new Date('2026-11-24T13:00:00Z'), tz)).toHaveLength(1);
    expect(dueReminders(tasks, s, new Date('2026-11-24T13:00:00Z'), 'UTC')).toEqual([]);
  });

  it('ignores tasks due after tomorrow', () => {
    expect(dueReminders([task('far', '2026-12-30', '08:00')], DEFAULT_REMINDERS, at('2026-11-24T08:00'), tz)).toEqual([]);
  });
});
