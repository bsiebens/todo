import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { useCallback, useEffect, useState } from 'react';
import type { SignInResult } from '../sync/client';
import type { AuthStatus, DeviceInfo } from '../sync/protocol';
import { currentSubscription, disablePush, enablePush, pushSupport } from '../sync/push';
import { Icon } from './Icon';
import { useSnapshot, useStore, useSync, useSyncStatus } from './state';

export function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows PC' : /Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return browser ? `${os}, ${browser}` : os;
}

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

const errText = (e: unknown) => {
  const name = (e as { name?: string }).name;
  if (name === 'NotAllowedError' || name === 'AbortError') return 'The passkey prompt was cancelled.';
  return e instanceof Error ? e.message : String(e);
};

function useBusy() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

export function SyncSettings({ initialCode }: { initialCode?: string | null }) {
  const status = useSyncStatus();
  return (
    <>
      <h2>Sync and sign-in</h2>
      {status.state === 'signed_out' ? <SignIn initialCode={initialCode} /> : <SignedIn />}
      <h2>Reminders</h2>
      <Reminders />
    </>
  );
}

function SignIn({ initialCode }: { initialCode?: string | null }) {
  const sync = useSync();
  const status = useSyncStatus();
  const [server, setServer] = useState<AuthStatus | 'unreachable' | null>(null);
  const [name, setName] = useState(defaultDeviceName);
  const [code, setCode] = useState(initialCode ?? '');
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const { busy, error, run } = useBusy();

  const check = useCallback(() => {
    setServer(null);
    sync.authStatus().then(setServer, () => setServer('unreachable'));
  }, [sync]);
  useEffect(check, [check]);

  const done = (r: SignInResult) => sync.signedInWith(r);

  if (server === null) return <div className="card muted small">Looking for the sync server…</div>;
  if (server === 'unreachable') {
    const local = ['localhost', '127.0.0.1'].includes(location.hostname);
    return (
      <div className="card">
        <p className="small" style={{ marginTop: 0 }}>
          <strong>No sync server answers at this address</strong>, so there is nowhere to enter a code yet. Your tasks are safe on this device either way.
        </p>
        {local ? (
          <p className="small muted">
            Running locally? Start the sync server in a second terminal with <code>npm run dev:server</code> (no database needed), then press Try again. The setup code is printed in that terminal.
          </p>
        ) : (
          <p className="small muted">Sync works when the app is opened from your ToDo server (for example https://todo.your-domain). If that is this address, the server may be down or restarting.</p>
        )}
        <div className="actions" style={{ marginBottom: 0 }}>
          <button className="btn" onClick={check}>Try again</button>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      {status.error && <p className="form-error" role="alert">{status.error}</p>}
      <p className="small muted" style={{ marginTop: 0 }}>
        Sign in to keep this device in step with your others. Tasks stay on this device too and keep working offline.
      </p>
      <div className="fields">
        <label htmlFor="devname">This device</label>
        <input id="devname" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      </div>

      {!server.setupDone ? (
        <>
          <h3 className="subhead">Set up the server</h3>
          <p className="small muted">This is the first device. Enter the setup code from the server log (<code>docker compose logs app</code>).</p>
          <form className="inline-form" onSubmit={(e) => (e.preventDefault(), run(async () => done(await sync.api('/auth/setup', { body: { code, deviceName: name }, auth: false }))))}>
            <input aria-label="Setup code" placeholder="XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" autoComplete="off" />
            <button className="btn primary" disabled={busy || !code.trim()}>Set up</button>
          </form>
        </>
      ) : (
        <>
          <div className="actions" style={{ marginTop: 14 }}>
            <button
              className="btn primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const { flowId, options } = await sync.api<{ flowId: string; options: never }>('/auth/passkey/login/options', { body: {}, auth: false });
                  const response = await startAuthentication({ optionsJSON: options });
                  await done(await sync.api('/auth/passkey/login/verify', { body: { flowId, response, deviceName: name }, auth: false }));
                })
              }
            >
              <Icon name="key" size={16} /> Sign in with a passkey
            </button>
          </div>
          <h3 className="subhead">Or use a one-time code</h3>
          <p className="small muted">Get one on a signed-in device under Settings, Sync, Add a device{server.emailEnabled ? ', or by email below' : ''}.</p>
          <form className="inline-form" onSubmit={(e) => (e.preventDefault(), run(async () => done(await sync.api('/auth/code/redeem', { body: { code, deviceName: name }, auth: false }))))}>
            <input aria-label="One-time code" placeholder="XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" autoComplete="one-time-code" />
            <button className="btn" disabled={busy || !code.trim()}>Sign in</button>
          </form>
          {server.emailEnabled && (
            <form
              className="inline-form"
              onSubmit={(e) => (
                e.preventDefault(),
                run(async () => {
                  await sync.api('/auth/email', { body: { email }, auth: false });
                  setSent(true);
                })
              )}
            >
              <input type="email" aria-label="Email address" placeholder="Your email address" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
              <button className="btn" disabled={busy || !email.includes('@')}>Email me a code</button>
            </form>
          )}
          {sent && <p className="small muted">If that is the owner's address, a code is on its way. Type it above.</p>}
        </>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

function SignedIn() {
  const sync = useSync();
  const status = useSyncStatus();
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [passkeys, setPasskeys] = useState<{ id: string; name: string; lastUsedAt: string | null }[]>([]);
  const [pair, setPair] = useState<{ code: string; expiresAt: string } | null>(null);
  const [, tick] = useState(0);
  const { busy, error, run } = useBusy();

  const load = useCallback(() => {
    sync.devices().then(setDevices, () => {});
    sync.api<typeof passkeys>('/auth/passkeys').then(setPasskeys, () => {});
  }, [sync]);
  useEffect(load, [load]);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const label =
    status.state === 'syncing'
      ? 'Syncing…'
      : status.state === 'offline'
        ? `Server not reachable, will retry${status.pending ? `. ${status.pending} change${status.pending === 1 ? '' : 's'} waiting` : ''}`
        : status.state === 'error'
          ? `Sync problem: ${status.error}`
          : `Up to date, last synced ${ago(status.lastSync)}`;

  return (
    <div className="card">
      <div className="setting-row">
        <div className="syncline">
          <span className={`syncdot s-${status.state}`} aria-hidden="true" />
          <span>{label}</span>
        </div>
        <button className="btn" onClick={() => sync.syncNow()} disabled={status.state === 'syncing'}>Sync now</button>
      </div>

      <h3 className="subhead">Add a device</h3>
      {pair && new Date(pair.expiresAt).getTime() > Date.now() ? (
        <p className="small">
          On the other device, open Settings, Sync and type <strong className="code">{pair.code}</strong>. It works once, until{' '}
          {new Date(pair.expiresAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}.
        </p>
      ) : (
        <div className="actions">
          <button className="btn" disabled={busy} onClick={() => run(async () => setPair(await sync.api('/auth/code/create', { body: {} })))}>Show a one-time code</button>
        </div>
      )}

      <h3 className="subhead">Passkeys</h3>
      {passkeys.length ? (
        <ul className="plainlist">
          {passkeys.map((p) => (
            <li key={p.id}>
              <span>{p.name}</span>
              <span className="small muted">used {ago(p.lastUsedAt)}</span>
              <button className="btn ghost danger" onClick={() => run(async () => (await sync.api(`/auth/passkeys/${encodeURIComponent(p.id)}`, { method: 'DELETE' }), load()))}>Remove</button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">No passkeys yet. A passkey lets you sign in on new devices with Face ID, Touch ID or Windows Hello.</p>
      )}
      <div className="actions">
        <button
          className="btn"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const name = defaultDeviceName();
              const { flowId, options } = await sync.api<{ flowId: string; options: never }>('/auth/passkey/register/options', { body: { name } });
              const response = await startRegistration({ optionsJSON: options });
              await sync.api('/auth/passkey/register/verify', { body: { flowId, response, name } });
              load();
            })
          }
        >
          <Icon name="key" size={16} /> Add a passkey on this device
        </button>
      </div>

      <h3 className="subhead">Signed-in devices</h3>
      <ul className="plainlist">
        {devices.map((d) => (
          <li key={d.id}>
            <span>
              {d.name}
              {d.current && <span className="chip" style={{ marginLeft: 6 }}>this device</span>}
            </span>
            <span className="small muted">{d.current ? '' : `seen ${ago(d.lastSeenAt)}`}</span>
            {!d.current && (
              <button className="btn ghost danger" onClick={() => run(async () => (await sync.api(`/devices/${d.id}`, { method: 'DELETE' }), load()))}>Sign out</button>
            )}
          </li>
        ))}
      </ul>
      <div className="actions">
        <button className="btn danger" onClick={() => run(() => sync.signOut())}>Sign out this device</button>
      </div>
      <p className="small muted" style={{ marginBottom: 0 }}>Signing out keeps the tasks on this device, but stops syncing them.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

const LEADS = [0, 5, 10, 15, 30, 60];

function Reminders() {
  const store = useStore();
  const sync = useSync();
  const status = useSyncStatus();
  const r = useSnapshot().settings.reminders;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [tested, setTested] = useState<string | null>(null);
  const { busy, error, run } = useBusy();
  const support = typeof window === 'undefined' ? 'unsupported' : pushSupport();

  useEffect(() => {
    if (support !== 'ok') return;
    currentSubscription().then((s) => setEnabled(!!s && Notification.permission === 'granted'), () => setEnabled(false));
  }, [support, status.state]);

  if (status.state === 'signed_out') {
    return <div className="card small muted">Reminders are sent by the sync server, so sign in first.</div>;
  }
  const save = (patch: Partial<typeof r>) => store.saveSettings({ reminders: { ...r, ...patch } });

  return (
    <div className="card">
      <div className="setting-row">
        <div>
          <div>Notifications on this device</div>
          <div className="small muted">
            {support === 'needs_home_screen'
              ? 'On iPhone and iPad, add the app to the Home Screen first (Share, Add to Home Screen), then open it from there and turn this on.'
              : support === 'unsupported'
                ? 'This browser cannot receive notifications from a web app.'
                : enabled
                  ? 'On. Reminders arrive even when the app is closed.'
                  : 'Off. Turn on to get reminders here.'}
          </div>
        </div>
        {support === 'ok' && (
          <div className="actions" style={{ margin: 0 }}>
            {enabled ? (
              <>
                <button className="btn" disabled={busy} onClick={() => run(async () => setTested((await sync.api<{ sent: number }>('/push/test', { body: {} })).sent ? 'Sent. It should appear in a few seconds.' : 'No device is set up for notifications.'))}>
                  Send a test
                </button>
                <button className="btn" disabled={busy} onClick={() => run(async () => (await disablePush(sync), setEnabled(false)))}>Turn off</button>
              </>
            ) : (
              <button className="btn primary" disabled={busy || enabled === null} onClick={() => run(async () => (await enablePush(sync), setEnabled(true)))}>
                <Icon name="bell" size={16} /> Turn on
              </button>
            )}
          </div>
        )}
      </div>
      {tested && <p className="small muted">{tested}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}

      <div className="fields" style={{ marginTop: 14 }}>
        <label htmlFor="rem-due">Due time</label>
        <div className="inline">
          <label className="toggle">
            <input id="rem-due" type="checkbox" checked={r.atDueTime} onChange={(e) => save({ atDueTime: e.target.checked })} /> Remind me
          </label>
          <select aria-label="When" value={r.leadMin} disabled={!r.atDueTime} onChange={(e) => save({ leadMin: Number(e.target.value) })}>
            {LEADS.map((m) => (
              <option key={m} value={m}>{m ? `${m} min before` : 'at the due time'}</option>
            ))}
          </select>
        </div>
        <label htmlFor="rem-digest">Morning</label>
        <div className="inline">
          <label className="toggle">
            <input id="rem-digest" type="checkbox" checked={r.digest} onChange={(e) => save({ digest: e.target.checked })} /> Summary of today and overdue at
          </label>
          <input type="time" aria-label="Summary time" value={r.digestTime} disabled={!r.digest} onChange={(e) => e.target.value && save({ digestTime: e.target.value })} />
        </div>
      </div>
      <p className="small muted" style={{ marginBottom: 0 }}>These settings apply to all your devices. Tasks without a time are only in the morning summary.</p>
    </div>
  );
}
