import type { ReminderSettings } from '../sync/protocol';
import { addDays, localParts, zonedToUtc } from './tz';

/** An open task with a due date, as reminders need it. */
export interface DueTask {
  id: string;
  title: string;
  dueDate: string;
  dueTime: string | null;
}

export interface Reminder {
  /** Stable id: a reminder with the same key is shown once. */
  key: string;
  title: string;
  body: string;
  tag: string;
  url: string;
}

/** A reminder this late (computer asleep, server down) is still shown; older ones are dropped. */
export const MISSED_WINDOW_MS = 30 * 60_000;

/** The digest is sent at most this long after its time. */
const DIGEST_WINDOW_H = 3;

/**
 * Which reminders are due at `now`: a task's due time minus the lead time, and a
 * morning summary of what is due today or overdue. Times without a zone are read
 * in `tz`. The same rules run on the server (Web Push) and in the desktop app
 * (native notifications); callers remember the keys they have shown.
 */
export function dueReminders(tasks: DueTask[], settings: ReminderSettings, now: Date, tz: string): Reminder[] {
  const local = localParts(now, tz);
  const tomorrow = addDays(local.date, 1);
  const relevant = tasks.filter((t) => t.dueDate <= tomorrow);
  const out: Reminder[] = [];

  if (settings.atDueTime) {
    for (const t of relevant) {
      if (!t.dueTime) continue;
      const at = zonedToUtc(t.dueDate, t.dueTime, tz).getTime() - settings.leadMin * 60_000;
      if (at <= now.getTime() && at > now.getTime() - MISSED_WINDOW_MS) {
        out.push({
          key: `due:${t.id}:${t.dueDate}T${t.dueTime}:${settings.leadMin}`,
          title: t.title,
          body: settings.leadMin ? `Due at ${t.dueTime}, in ${settings.leadMin} min` : `Due now (${t.dueTime})`,
          tag: t.id,
          url: `/#task=${t.id}`,
        });
      }
    }
  }

  if (settings.digest && local.time >= settings.digestTime && local.time < addHours(settings.digestTime, DIGEST_WINDOW_H)) {
    const sorted = [...relevant].sort((a, b) => (a.dueDate + (a.dueTime ?? '')).localeCompare(b.dueDate + (b.dueTime ?? '')));
    const today = sorted.filter((t) => t.dueDate === local.date);
    const overdue = sorted.filter((t) => t.dueDate < local.date);
    if (today.length || overdue.length) {
      const parts = [today.length && `${today.length} due today`, overdue.length && `${overdue.length} overdue`].filter(Boolean).join(', ');
      const names = [...overdue, ...today]
        .slice(0, 3)
        .map((t) => t.title)
        .join(' · ');
      out.push({ key: `digest:${local.date}`, title: parts.charAt(0).toUpperCase() + parts.slice(1), body: names, tag: 'digest', url: '/' });
    }
  }
  return out;
}

function addHours(hm: string, h: number): string {
  const [hh, mm] = hm.split(':').map(Number) as [number, number];
  const total = Math.min(hh + h, 24);
  return `${String(total).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
