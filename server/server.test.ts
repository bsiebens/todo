import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryDriver } from '../src/db/node-driver';
import { Store } from '../src/db/store';
import { SyncClient } from '../src/sync/client';
import { createApp, type Mailer } from './app';
import { Auth } from './auth';
import type { Db } from './db';
import { migrate } from './db';
import { Notifier, type PushPayload, type Sender } from './notifier';
import { SyncService } from './sync';
import { testDb } from './testing';

let db: Db;
let base: string;
let close: () => Promise<void>;
let pushed: PushPayload[];
let mails: { to: string; subject: string; text: string }[];
let notifier: Notifier;
const SETUP = 'ABCD-EFGH';

beforeEach(async () => {
  db = await testDb();
  await migrate(db);
  pushed = [];
  mails = [];
  const sender: Sender = { send: async (_s, p) => void pushed.push(p) };
  const mailer: Mailer = { send: async (to, subject, text) => void mails.push({ to, subject, text }) };
  notifier = new Notifier(db, sender);
  const { server } = createApp({
    db,
    auth: new Auth(db, { appUrl: 'https://todo.example.com', setupCode: SETUP }),
    sync: new SyncService(db),
    notifier,
    vapidPublicKey: 'test-key',
    appUrl: 'https://todo.example.com',
    ownerEmail: 'me@example.com',
    mailer,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await db.close();
  };
});

afterEach(async () => {
  await close();
});

async function device(): Promise<{ store: Store; sync: SyncClient }> {
  const store = await Store.open(await createMemoryDriver());
  const sync = await SyncClient.create(store, { baseUrl: base, debounceMs: 10, pollMs: 3_600_000, WebSocket: undefined });
  return { store, sync };
}

async function post<T>(path: string, body: unknown, token?: string): Promise<{ status: number; data: T }> {
  const res = await fetch(`${base}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, data: (await res.json()) as T };
}

/** Sets up the server from device A and signs device B in with a pairing code. */
async function twoDevices() {
  const a = await device();
  const b = await device();
  const setup = await post<{ token: string; deviceId: string }>('/auth/setup', { code: SETUP.toLowerCase(), deviceName: 'Office PC' });
  expect(setup.status).toBe(200);
  await a.sync.signedInWith(setup.data);
  const code = await a.sync.api<{ code: string }>('/auth/code/create', { body: {} });
  const r = await post<{ token: string; deviceId: string }>('/auth/code/redeem', { code: code.code, deviceName: 'iPhone' });
  expect(r.status).toBe(200);
  await b.sync.signedInWith(r.data);
  return { a, b };
}

const stopAll = (...ds: { sync: SyncClient }[]) => ds.forEach((d) => d.sync.stop());

describe('sign-in', () => {
  it('needs the setup code for the first device, then refuses a second setup', async () => {
    expect((await post('/auth/setup', { code: 'WRONG-CODE', deviceName: 'x' })).status).toBe(400);
    expect((await post('/auth/setup', { code: SETUP, deviceName: 'x' })).status).toBe(200);
    expect((await post('/auth/setup', { code: SETUP, deviceName: 'y' })).status).toBe(409);
  });

  it('pairing codes work once; revoked devices are signed out', async () => {
    const { a, b } = await twoDevices();
    const devices = await a.sync.devices();
    expect(devices.map((d) => [d.name, d.current])).toEqual([
      ['Office PC', true],
      ['iPhone', false],
    ]);
    await a.sync.api(`/devices/${devices[1]!.id}`, { method: 'DELETE' });
    await b.sync.syncNow();
    expect(b.sync.status.state).toBe('signed_out');
    stopAll(a, b);
  });

  it('emails a code only to the owner address', async () => {
    await post('/auth/setup', { code: SETUP, deviceName: 'x' });
    await post('/auth/email', { email: 'someone@else.com' });
    expect(mails).toHaveLength(0);
    await post('/auth/email', { email: 'Me@Example.com' });
    expect(mails).toHaveLength(1);
    const code = /code is ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(mails[0]!.text)![1]!;
    expect(mails[0]!.text).toContain(`https://todo.example.com/#signin=${code}`);
    expect((await post('/auth/code/redeem', { code, deviceName: 'Mac' })).status).toBe(200);
    expect((await post('/auth/code/redeem', { code, deviceName: 'Mac' })).status).toBe(400);
  });

  it('rejects requests without a valid token', async () => {
    const res = await fetch(`${base}/api/sync/pull?since=0`, { headers: { authorization: 'Bearer nope' } });
    expect(res.status).toBe(401);
  });
});

describe('sync', () => {
  it('uploads data that existed before sign-in and copies it to a new device', async () => {
    const a = await device();
    const t = await a.store.createTask({ title: 'Pay rent', priority: 3, dueDate: '2026-12-01', tagNames: ['home'], recurrence: { rule: 'FREQ=MONTHLY', mode: 'schedule' } });
    await a.store.ensureProjectPath('Work/Admin');
    await a.store.addNote(t, 'Ask about the new account');
    await a.store.saveSettings({ officeStart: '09:00' });
    const setup = await post<{ token: string; deviceId: string }>('/auth/setup', { code: SETUP, deviceName: 'PC' });
    await a.sync.signedInWith(setup.data);
    expect(a.sync.status.pending).toBe(0);

    const code = await a.sync.api<{ code: string }>('/auth/code/create', { body: {} });
    const b = await device();
    await b.sync.signedInWith((await post<{ token: string; deviceId: string }>('/auth/code/redeem', { code: code.code, deviceName: 'Phone' })).data);
    const sb = b.store.snapshot;
    expect(sb.tasks.map((x) => [x.title, x.priority, x.dueDate])).toEqual([['Pay rent', 3, '2026-12-01']]);
    expect(sb.tags.map((x) => x.name)).toEqual(['home']);
    expect(sb.taskTags).toEqual(a.store.snapshot.taskTags);
    expect(sb.series).toEqual(a.store.snapshot.series);
    expect(b.store.tree().path(sb.projects.find((p) => p.name === 'Admin')!.id)).toBe('Work / Admin');
    expect(sb.notes.map((n) => n.body).sort()).toEqual(['Ask about the new account', 'Created']);
    expect(sb.settings.officeStart).toBe('09:00');
    stopAll(a, b);
  });

  it('merges per field: offline edits to different fields both survive', async () => {
    const { a, b } = await twoDevices();
    const id = await a.store.createTask({ title: 'Draft Q1 plan' });
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect(b.store.task(id).title).toBe('Draft Q1 plan');

    await a.store.updateTask(id, { title: 'Draft Q1 plan v2' });
    await b.store.updateTask(id, { dueDate: '2026-12-05' });
    await b.sync.syncNow();
    await a.sync.syncNow();
    await b.sync.syncNow();
    for (const d of [a, b]) {
      expect(d.store.task(id).title).toBe('Draft Q1 plan v2');
      expect(d.store.task(id).dueDate).toBe('2026-12-05');
    }
    stopAll(a, b);
  });

  it('last writer wins on the same field, and both devices agree', async () => {
    const { a, b } = await twoDevices();
    const id = await a.store.createTask({ title: 'Original' });
    await a.sync.syncNow();
    await b.sync.syncNow();
    await a.store.updateTask(id, { title: 'From A' });
    await new Promise((r) => setTimeout(r, 5));
    await b.store.updateTask(id, { title: 'From B' });
    // A syncs last, but B's edit is newer.
    await b.sync.syncNow();
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect(a.store.task(id).title).toBe('From B');
    expect(b.store.task(id).title).toBe('From B');
    stopAll(a, b);
  });

  it('undoes a dependency that closes a loop made on two offline devices', async () => {
    const { a, b } = await twoDevices();
    const x = await a.store.createTask({ title: 'Get quote' });
    const y = await a.store.createTask({ title: 'Book builder' });
    await a.sync.syncNow();
    await b.sync.syncNow();
    await a.store.addDependency(x, y);
    await b.store.addDependency(y, x); // fine locally, B doesn't know about x→y yet
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect(b.sync.status.notices).toEqual(['This link was undone because it created a loop.']);
    await a.sync.syncNow();
    for (const d of [a, b]) expect(d.store.snapshot.deps).toEqual([{ blockerId: x, blockedId: y }]);
    stopAll(a, b);
  });

  it('undoes a project move that puts a project inside itself', async () => {
    const { a, b } = await twoDevices();
    const p = await a.store.createProject('Work');
    const q = await a.store.createProject('Clients');
    await a.sync.syncNow();
    await b.sync.syncNow();
    await a.store.updateProject(q, { parentId: p });
    await b.store.updateProject(p, { parentId: q });
    await a.sync.syncNow();
    await b.sync.syncNow();
    await a.sync.syncNow();
    for (const d of [a, b]) {
      const tree = d.store.tree();
      expect(tree.byId.get(q)!.parentId).toBe(p);
      expect(tree.byId.get(p)!.parentId).toBeNull();
    }
    expect(b.sync.status.notices[0]).toMatch(/inside itself/);
    stopAll(a, b);
  });

  it('syncs tag changes, deletions and status changes', async () => {
    const { a, b } = await twoDevices();
    const id = await a.store.createTask({ title: 'Call accountant', tagNames: ['finance', 'phone'] });
    await a.sync.syncNow();
    await b.sync.syncNow();
    await b.store.setTags(id, ['finance']);
    await b.store.setStatus(id, 'done');
    await b.sync.syncNow();
    await a.sync.syncNow();
    expect(a.store.task(id).status).toBe('done');
    const tagNames = (store: Store) => store.snapshot.taskTags.map((tt) => store.snapshot.tags.find((t) => t.id === tt.tagId)!.name);
    expect(tagNames(a.store)).toEqual(['finance']);
    await a.store.deleteTask(id);
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect(b.store.snapshot.tasks).toHaveLength(0);
    stopAll(a, b);
  });

  it('refuses invalid changes without breaking the rest of the push', async () => {
    const setup = await post<{ token: string }>('/auth/setup', { code: SETUP, deviceName: 'x' });
    const hlc = '000001700000000:0000:abc';
    const res = await post<{ accepted: number; rejected: { reason: string }[] }>(
      '/sync/push',
      {
        ops: [
          { entity: 'task', id: 't1', field: 'status', value: '"bogus"', hlc },
          { entity: 'task', id: 't1', field: 'password', value: '"x"', hlc },
          { entity: 'users', id: 't1', field: 'x', value: '1', hlc },
          { entity: 'task', id: 't1', field: 'title', value: '"Fine"', hlc },
        ],
      },
      setup.data.token,
    );
    expect(res.data.accepted).toBe(1);
    expect(res.data.rejected.map((r) => r.reason)).toEqual(['invalid', 'invalid', 'invalid']);
  });

  it('compaction keeps what a fresh device needs', async () => {
    const { a, b } = await twoDevices();
    const id = await a.store.createTask({ title: 'v1' });
    for (const v of ['v2', 'v3', 'v4']) await a.store.updateTask(id, { title: v });
    await a.sync.syncNow();
    const sync = new SyncService(db);
    expect(await sync.compact()).toBeGreaterThan(0);
    await b.sync.syncNow();
    expect(b.store.task(id).title).toBe('v4');
    stopAll(a, b);
  });
});

describe('reminders', () => {
  async function subscribed() {
    const { a, b } = await twoDevices();
    await a.sync.api('/push/subscribe', { body: { subscription: { endpoint: 'https://push.example.com/1', keys: { p256dh: 'k', auth: 'a' } }, tz: 'Europe/Brussels' } });
    return { a, b };
  }

  it('sends a reminder at the due time in the device time zone, once', async () => {
    const { a, b } = await subscribed();
    await a.store.createTask({ title: 'Submit expense report', dueDate: '2026-12-01', dueTime: '17:00' });
    await a.store.createTask({ title: 'Later', dueDate: '2026-12-01', dueTime: '18:00' });
    await a.sync.syncNow();
    // 17:00 in Brussels on 1 Dec is 16:00 UTC.
    expect(await notifier.tick(new Date('2026-12-01T15:59:00Z'))).toBe(0);
    expect(await notifier.tick(new Date('2026-12-01T16:00:30Z'))).toBe(1);
    expect(await notifier.tick(new Date('2026-12-01T16:01:30Z'))).toBe(0);
    expect(pushed[0]).toMatchObject({ title: 'Submit expense report', body: 'Due now (17:00)' });
    stopAll(a, b);
  });

  it('honours the lead time and skips finished tasks', async () => {
    const { a, b } = await subscribed();
    await a.store.saveSettings({ reminders: { atDueTime: true, leadMin: 15, digest: false, digestTime: '08:00' } });
    const done = await a.store.createTask({ title: 'Done already', dueDate: '2026-12-01', dueTime: '17:00' });
    await a.store.setStatus(done, 'done');
    await a.store.createTask({ title: 'Call back', dueDate: '2026-12-01', dueTime: '17:00' });
    await a.sync.syncNow();
    expect(await notifier.tick(new Date('2026-12-01T15:45:10Z'))).toBe(1);
    expect(pushed.map((p) => p.title)).toEqual(['Call back']);
    expect(pushed[0]!.body).toBe('Due at 17:00, in 15 min');
    stopAll(a, b);
  });

  it('sends a morning summary of what is due today and overdue', async () => {
    const { a, b } = await subscribed();
    await a.store.createTask({ title: 'Water plants', dueDate: '2026-11-30' });
    await a.store.createTask({ title: 'Pay rent', dueDate: '2026-12-01' });
    await a.store.createTask({ title: 'Next week', dueDate: '2026-12-08' });
    await a.sync.syncNow();
    expect(await notifier.tick(new Date('2026-12-01T06:59:00Z'))).toBe(0); // 07:59 local
    expect(await notifier.tick(new Date('2026-12-01T07:00:00Z'))).toBe(1);
    expect(pushed[0]).toMatchObject({ title: '1 due today, 1 overdue', body: 'Water plants · Pay rent' });
    expect(await notifier.tick(new Date('2026-12-01T07:05:00Z'))).toBe(0);
    stopAll(a, b);
  });
});
