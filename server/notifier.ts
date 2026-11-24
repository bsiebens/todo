import * as webpush from 'web-push';
import { DEFAULT_REMINDERS, type ReminderSettings } from '../src/sync/protocol';
import { getKv, setKv, type Db } from './db';
import { addDays, localParts, zonedToUtc } from './tz';

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  url?: string;
}

export interface Sender {
  send(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: PushPayload): Promise<void>;
}

/** A send that failed because the browser dropped the subscription. */
export class GoneError extends Error {}

export async function webPushSender(db: Db, subject: string): Promise<{ sender: Sender; publicKey: string }> {
  let keys = await getKv<{ publicKey: string; privateKey: string }>(db, 'vapid');
  if (!keys) {
    keys = webpush.generateVAPIDKeys();
    await setKv(db, 'vapid', keys);
  }
  const k = keys;
  return {
    publicKey: k.publicKey,
    sender: {
      async send(sub, payload) {
        try {
          await webpush.sendNotification(sub, JSON.stringify(payload), { vapidDetails: { subject, publicKey: k.publicKey, privateKey: k.privateKey }, TTL: 3600 });
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) throw new GoneError('subscription gone');
          throw e;
        }
      },
    },
  };
}

interface DueTask {
  id: string;
  title: string;
  dueDate: string;
  dueTime: string | null;
}

const MISSED_WINDOW_MS = 30 * 60_000;

/**
 * Sends reminders by Web Push, once a minute: at a task's due time (minus the lead
 * time), and a morning summary of what is due today or overdue. Times without a zone
 * are read in the time zone of the device that last enabled notifications.
 */
export class Notifier {
  constructor(
    private db: Db,
    private sender: Sender,
  ) {}

  async tick(now = new Date()): Promise<number> {
    let sent = 0;
    const accounts = await this.db.query<{ account_id: string; tz: string }>(
      'SELECT DISTINCT ON (account_id) account_id, tz FROM push_sub ORDER BY account_id, updated_at DESC',
    );
    for (const { account_id: accountId, tz } of accounts) sent += await this.forAccount(accountId, tz, now);
    return sent;
  }

  private async forAccount(accountId: string, tz: string, now: Date): Promise<number> {
    const settings = await this.settings(accountId);
    const local = localParts(now, tz);
    const tasks = await this.dueTasks(accountId, addDays(local.date, 1));
    const out: { key: string; payload: PushPayload }[] = [];

    if (settings.atDueTime) {
      for (const t of tasks) {
        if (!t.dueTime) continue;
        const at = zonedToUtc(t.dueDate, t.dueTime, tz).getTime() - settings.leadMin * 60_000;
        if (at <= now.getTime() && at > now.getTime() - MISSED_WINDOW_MS) {
          out.push({
            key: `due:${t.id}:${t.dueDate}T${t.dueTime}:${settings.leadMin}`,
            payload: { title: t.title, body: settings.leadMin ? `Due at ${t.dueTime}, in ${settings.leadMin} min` : `Due now (${t.dueTime})`, tag: t.id, url: `/#task=${t.id}` },
          });
        }
      }
    }

    if (settings.digest && local.time >= settings.digestTime && local.time < addHours(settings.digestTime, 3)) {
      const today = tasks.filter((t) => t.dueDate === local.date);
      const overdue = tasks.filter((t) => t.dueDate < local.date);
      if (today.length || overdue.length) {
        const parts = [today.length && `${today.length} due today`, overdue.length && `${overdue.length} overdue`].filter(Boolean).join(', ');
        const names = [...overdue, ...today].slice(0, 3).map((t) => t.title).join(' · ');
        out.push({ key: `digest:${local.date}`, payload: { title: parts.charAt(0).toUpperCase() + parts.slice(1), body: names, tag: 'digest', url: '/' } });
      }
    }

    let sent = 0;
    for (const { key, payload } of out) {
      const claimed = await this.db.query('INSERT INTO reminder_sent (account_id, key) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1', [accountId, key]);
      if (!claimed.length) continue;
      sent += await this.sendToAccount(accountId, payload);
    }
    return sent;
  }

  async sendToAccount(accountId: string, payload: PushPayload): Promise<number> {
    const subs = await this.db.query<{ endpoint: string; keys: { p256dh: string; auth: string } }>('SELECT endpoint, keys FROM push_sub WHERE account_id = $1', [accountId]);
    let sent = 0;
    for (const s of subs) {
      try {
        await this.sender.send({ endpoint: s.endpoint, keys: s.keys }, payload);
        sent++;
      } catch (e) {
        if (e instanceof GoneError) await this.db.query('DELETE FROM push_sub WHERE endpoint = $1', [s.endpoint]);
        else console.warn('push failed', (e as Error).message);
      }
    }
    return sent;
  }

  private async settings(accountId: string): Promise<ReminderSettings> {
    const rows = await this.db.query<{ value: unknown }>(
      "SELECT value FROM field_state WHERE account_id = $1 AND entity = 'setting' AND entity_id = 'reminders' AND field = 'value'",
      [accountId],
    );
    try {
      return { ...DEFAULT_REMINDERS, ...(rows[0] ? JSON.parse(rows[0].value as string) : {}) };
    } catch {
      return DEFAULT_REMINDERS;
    }
  }

  /** Open, not deleted tasks with a due date on or before `until`. */
  private async dueTasks(accountId: string, until: string): Promise<DueTask[]> {
    const rows = await this.db.query<{ entity_id: string; field: string; value: unknown }>(
      `SELECT entity_id, field, value FROM field_state
       WHERE account_id = $1 AND entity = 'task' AND field IN ('title', 'status', 'due_date', 'due_time', 'deleted_at')
         AND entity_id IN (SELECT entity_id FROM field_state WHERE account_id = $1 AND entity = 'task' AND field = 'due_date' AND (value #>> '{}') <= $2)`,
      [accountId, until],
    );
    const byId = new Map<string, Record<string, unknown>>();
    for (const r of rows) {
      if (!byId.has(r.entity_id)) byId.set(r.entity_id, {});
      byId.get(r.entity_id)![r.field] = r.value;
    }
    const out: DueTask[] = [];
    for (const [id, f] of byId) {
      const status = (f.status as string | undefined) ?? 'todo';
      if (f.deleted_at || (status !== 'todo' && status !== 'in_progress') || typeof f.due_date !== 'string') continue;
      out.push({ id, title: (f.title as string) || 'Task', dueDate: f.due_date, dueTime: (f.due_time as string | null) ?? null });
    }
    return out.sort((a, b) => (a.dueDate + (a.dueTime ?? '')).localeCompare(b.dueDate + (b.dueTime ?? '')));
  }
}

function addHours(hm: string, h: number): string {
  const [hh, mm] = hm.split(':').map(Number) as [number, number];
  const total = Math.min(hh + h, 24);
  return `${String(total).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
