import type { Store } from '../db/store';
import type { AuthStatus, DeviceInfo, Op, PullResponse, PushResponse } from './protocol';

export type SyncState = 'signed_out' | 'idle' | 'syncing' | 'offline' | 'error';

export interface SyncStatus {
  state: SyncState;
  lastSync: string | null;
  error: string | null;
  pending: number;
  /** Changes the server undid (for example a dependency loop), to show once. */
  notices: string[];
}

export interface SignInResult {
  token: string;
  deviceId: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Options {
  /** '' means the same origin as the app. */
  baseUrl?: string;
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  /** Delay before syncing local changes, so a burst of edits goes in one push. */
  debounceMs?: number;
  pollMs?: number;
}

const PUSH_BATCH = 500;
/** validateOp messages that mean the server is older than this app. */
const UNKNOWN_TO_SERVER = new Set(['unknown field', 'unknown entity']);
const OLD_SERVER_NOTICE = 'Your sync server is older than this app, so some changes (such as Focus picks) wait on this device. Update the server and they will sync.';

/**
 * Keeps this device in step with the sync server: pushes the local outbox, pulls
 * changes since the last cursor, and listens on a WebSocket for "changed" nudges.
 * Everything works without it; it just retries until the server is reachable.
 */
export class SyncClient {
  status: SyncStatus = { state: 'signed_out', lastSync: null, error: null, pending: 0, notices: [] };
  private warnedOldServer = false;
  private token: string | null = null;
  private listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private ws: WebSocket | null = null;
  private wsRetry = 1000;
  private stopped = true;
  private unsubStore: (() => void) | null = null;
  private base: string;
  private readonly f: typeof fetch;

  constructor(
    private store: Store,
    private opts: Options = {},
  ) {
    this.base = opts.baseUrl ?? '';
    this.f = opts.fetch ?? ((...a) => fetch(...a));
  }

  static async create(store: Store, opts: Options = {}): Promise<SyncClient> {
    const c = new SyncClient(store, opts);
    c.token = await store.getSyncState('token');
    c.status = { ...c.status, state: c.token ? 'idle' : 'signed_out', lastSync: await store.getSyncState('last_sync'), pending: await store.pendingCount() };
    return c;
  }

  /** The sync server's address; '' = the origin the app was loaded from. */
  get baseUrl() {
    return this.base;
  }

  /** Points the client at another server (desktop app). Only while signed out. */
  async setBaseUrl(url: string): Promise<void> {
    if (this.token) throw new Error('Sign out before changing the server.');
    this.base = url;
    await this.store.setSyncState('server_url', url || null);
  }

  get signedIn() {
    return !!this.token;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch };
    for (const fn of this.listeners) fn();
  }

  dismissNotices() {
    this.set({ notices: [] });
  }

  // ---------- HTTP ----------

  async api<T>(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.auth !== false && this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await this.f(`${this.base}/api${path}`, { method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'), headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
    const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
    // Anything but JSON (a dev server or proxy page, a 502 from a proxy) means no sync server answered.
    if (!isJson) throw new ApiError(res.ok ? 502 : res.status, 'No sync server answers at this address');
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      if (res.status === 401 && init.auth !== false && this.token) await this.forget('This device was signed out.');
      throw new ApiError(res.status, data.error ?? `Server answered ${res.status}`);
    }
    return data as T;
  }

  authStatus(): Promise<AuthStatus> {
    return this.api('/auth/status', { auth: false });
  }

  devices(): Promise<DeviceInfo[]> {
    return this.api('/devices');
  }

  // ---------- Sign-in ----------

  /** Stores a fresh device token. The next sync uploads everything not yet on the server and downloads the rest. */
  async signedInWith(r: SignInResult): Promise<void> {
    this.token = r.token;
    await this.store.setSyncState('token', r.token);
    await this.store.setSyncState('device_id', r.deviceId);
    await this.store.setSyncState('cursor', '0');
    this.set({ state: 'idle', error: null });
    this.start();
    await this.syncNow();
  }

  async signOut(): Promise<void> {
    const id = await this.store.getSyncState('device_id');
    if (id) await this.api(`/devices/${id}`, { method: 'DELETE' }).catch(() => {});
    await this.forget(null);
  }

  private async forget(error: string | null) {
    this.token = null;
    await this.store.setSyncState('token', null);
    this.stop();
    this.set({ state: 'signed_out', error });
  }

  // ---------- Running ----------

  start() {
    if (!this.token || !this.stopped) return;
    this.stopped = false;
    this.unsubStore = this.store.subscribe(() => this.schedule());
    this.poll = setInterval(() => this.syncNow(), this.opts.pollMs ?? 60_000);
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onWake);
      document.addEventListener('visibilitychange', this.onWake);
    }
    this.connect();
    void this.syncNow();
  }

  stop() {
    this.stopped = true;
    this.unsubStore?.();
    this.unsubStore = null;
    if (this.poll) clearInterval(this.poll);
    if (this.timer) clearTimeout(this.timer);
    this.poll = this.timer = null;
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onWake);
      document.removeEventListener('visibilitychange', this.onWake);
    }
    this.ws?.close();
    this.ws = null;
  }

  private onWake = () => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') {
      void this.syncNow();
      if (!this.ws) this.connect();
    }
  };

  /** After a local change: sync soon, if there is something to send. */
  private schedule() {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      const pending = await this.store.pendingCount();
      if (pending !== this.status.pending) this.set({ pending });
      if (pending) void this.syncNow();
    }, this.opts.debounceMs ?? 800);
  }

  private connect() {
    const WS = this.opts.WebSocket ?? (typeof WebSocket !== 'undefined' ? WebSocket : undefined);
    if (!WS || !this.token || this.stopped) return;
    const origin = this.base || (typeof location !== 'undefined' ? location.origin : '');
    const url = `${origin.replace(/^http/, 'ws')}/api/ws`;
    let ws: WebSocket;
    try {
      ws = new WS(url, ['todo', this.token]);
    } catch {
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.wsRetry = 1000;
    };
    ws.onmessage = () => void this.syncNow();
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (this.stopped) return;
      setTimeout(() => this.connect(), this.wsRetry);
      this.wsRetry = Math.min(this.wsRetry * 2, 60_000);
    };
  }

  /** Push, then pull. Safe to call any time; overlapping calls are merged. */
  syncNow(): Promise<void> {
    if (!this.token) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.runOnce();
      } while (this.again && this.token);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runOnce() {
    this.set({ state: 'syncing' });
    try {
      // Push the outbox in batches.
      const tooNew: Op[] = [];
      for (;;) {
        const batch = await this.store.pendingOps(PUSH_BATCH);
        if (!batch.length) break;
        const res = await this.api<PushResponse>('/sync/push', { body: { ops: batch.map((b) => b.op) } });
        this.store.observeClock(res.hlc);
        await this.store.ackOps(batch[batch.length - 1]!.seq);
        const notices = res.rejected.filter((r) => r.reason !== 'invalid').map((r) => r.message);
        if (notices.length) this.set({ notices: [...this.status.notices, ...notices] });
        for (const r of res.rejected.filter((x) => x.reason === 'invalid')) {
          // A server older than this app doesn't know a newer field yet: keep the change and send it
          // again after the server is updated, instead of losing it.
          if (UNKNOWN_TO_SERVER.has(r.message)) tooNew.push(r.op);
          else console.warn('Server refused a change', r);
        }
        if (batch.length < PUSH_BATCH) break;
      }
      if (tooNew.length) {
        await this.store.requeueOps(tooNew);
        if (!this.warnedOldServer) {
          this.warnedOldServer = true;
          this.set({ notices: [...this.status.notices, OLD_SERVER_NOTICE] });
        }
      }
      // Pull everything new.
      let cursor = Number((await this.store.getSyncState('cursor')) ?? 0);
      for (;;) {
        const res = await this.api<PullResponse>(`/sync/pull?since=${cursor}`);
        if (res.ops.length) await this.store.applyRemote(res.ops);
        if (res.cursor !== cursor) {
          cursor = res.cursor;
          await this.store.setSyncState('cursor', String(cursor));
        }
        if (!res.more) break;
      }
      const now = new Date().toISOString();
      await this.store.setSyncState('last_sync', now);
      this.set({ state: 'idle', lastSync: now, error: null, pending: await this.store.pendingCount() });
    } catch (e) {
      if (!this.token) return;
      const offline = !(e instanceof ApiError) || e.status >= 502;
      this.set({ state: offline ? 'offline' : 'error', error: offline ? null : (e as Error).message, pending: await this.store.pendingCount() });
    }
  }
}
