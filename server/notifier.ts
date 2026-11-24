import * as webpush from 'web-push';
import { DEFAULT_REMINDERS, type ReminderSettings } from '../src/sync/protocol';
import { getKv, setKv, type Db } from './db';
import { dueReminders, type DueTask } from '../src/domain/reminders';
import { addDays, localParts } from './tz';

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
    const tasks = await this.dueTasks(accountId, addDays(localParts(now, tz).date, 1));
    const out = dueReminders(tasks, settings, now, tz).map(({ key, ...payload }) => ({ key, payload }));

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

