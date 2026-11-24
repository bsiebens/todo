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

  if (server === null)
    return (
      <div className="card scard">
        <div className="srow">
          <div className="srow-sub">Looking for the sync server…</div>
        </div>
      </div>
    );
  if (server === 'unreachable') {
    const local = ['localhost', '127.0.0.1'].includes(location.hostname);
    return (
      <div className="card scard">
        <div className="srow">
          <div className="srow-text">
            <div className="srow-title">
              <span className="syncdot s-offline" aria-hidden="true" /> No sync server answers at this address
            </div>
            <div className="srow-sub">
              {local ? (
                <>
                  Running locally? Start it in a second terminal with <code>npm run dev:server</code> (no database needed); the setup code is printed there.
                </>
              ) : (
                'Sync works when the app is opened from your ToDo server. If that is this address, the server may be down or restarting.'
              )}{' '}
              Your tasks are safe on this device either way.
            </div>
          </div>
          <button className="btn" onClick={check}>Try again</button>
        </div>
      </div>
    );
  }

  const codeForm = (label: string, submit: () => Promise<unknown>, button: string, primary = false) => (
    <form className="srow-form" onSubmit={(e) => (e.preventDefault(), run(submit))}>
      <input aria-label={label} placeholder="XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" autoComplete="one-time-code" />
      <button className={`btn${primary ? ' primary' : ''}`} disabled={busy || !code.trim()}>{button}</button>
    </form>
  );

  return (
    <div className="card scard">
      {status.error && <p className="form-error srow-msg" role="alert">{status.error}</p>}
      <div className="srow">
        <div className="srow-text">
          <div className="srow-title">This device</div>
          <div className="srow-sub">Sign in to keep this device in step with your others. Tasks stay here too and work offline.</div>
        </div>
        <input className="srow-input" aria-label="Device name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      </div>

      {!server.setupDone ? (
        <div className="srow">
          <div className="srow-text">
            <div className="srow-title">Set up the server</div>
            <div className="srow-sub">This is the first device. The setup code is in the server log (<code>docker compose logs app</code>).</div>
          </div>
          {codeForm('Setup code', async () => done(await sync.api('/auth/setup', { body: { code, deviceName: name }, auth: false })), 'Set up', true)}
        </div>
      ) : (
        <>
          <div className="srow">
            <div className="srow-text">
              <div className="srow-title">Passkey</div>
              <div className="srow-sub">Face ID, Touch ID or Windows Hello, if you added a passkey on another device.</div>
            </div>
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
          <div className="srow">
            <div className="srow-text">
              <div className="srow-title">One-time code</div>
              <div className="srow-sub">Shown on a signed-in device under Settings, Add a device{server.emailEnabled ? ', or sent by email' : ''}.</div>
            </div>
            {codeForm('One-time code', async () => done(await sync.api('/auth/code/redeem', { body: { code, deviceName: name }, auth: false })), 'Sign in')}
          </div>
          {server.emailEnabled && (
            <div className="srow">
              <div className="srow-text">
                <div className="srow-title">Code by email</div>
                <div className="srow-sub">{sent ? "If that is the owner's address, a code is on its way. Type it above." : 'Only the owner address receives a code.'}</div>
              </div>
              <form
                className="srow-form"
                onSubmit={(e) => (
                  e.preventDefault(),
                  run(async () => {
                    await sync.api('/auth/email', { body: { email }, auth: false });
                    setSent(true);
                  })
                )}
              >
                <input type="email" aria-label="Email address" placeholder="Email address" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
                <button className="btn" disabled={busy || !email.includes('@')}>Send code</button>
              </form>
            </div>
          )}
        </>
      )}
      {error && <p className="form-error srow-msg" role="alert">{error}</p>}
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

  const title =
    status.state === 'syncing' ? 'Syncing…' : status.state === 'offline' ? 'Server not reachable' : status.state === 'error' ? 'Sync problem' : 'Up to date';
  const sub =
    status.state === 'offline'
      ? `Will retry automatically${status.pending ? `. ${status.pending} change${status.pending === 1 ? '' : 's'} waiting` : ''}.`
      : status.state === 'error'
        ? status.error
        : `Last synced ${ago(status.lastSync)}`;
  const pairLive = pair && new Date(pair.expiresAt).getTime() > Date.now();

  return (
    <div className="card scard">
      <div className="srow">
        <div className="srow-text">
          <div className="srow-title">
            <span className={`syncdot s-${status.state}`} aria-hidden="true" /> {title}
          </div>
          <div className="srow-sub">{sub}</div>
        </div>
        <button className="btn" onClick={() => sync.syncNow()} disabled={status.state === 'syncing'}>
          <Icon name="repeat" size={15} /> Sync now
        </button>
      </div>

      <div className="srow">
        <div className="srow-text">
          <div className="srow-title">Add a device</div>
          <div className="srow-sub">
            {pairLive
              ? `On the other device, open Settings and type this code. It works once, until ${new Date(pair!.expiresAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}.`
              : 'Show a one-time code to type on the other device.'}
          </div>
        </div>
        {pairLive ? (
          <strong className="code">{pair!.code}</strong>
        ) : (
          <button className="btn" disabled={busy} onClick={() => run(async () => setPair(await sync.api('/auth/code/create', { body: {} })))}>Show code</button>
        )}
      </div>

      <div className="srow">
        <div className="srow-text">
          <div className="srow-title">Passkeys</div>
          <div className="srow-sub">Sign in on new devices with Face ID, Touch ID or Windows Hello.{passkeys.length ? '' : ' None yet.'}</div>
        </div>
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
          <Icon name="key" size={15} /> Add passkey
        </button>
        {passkeys.length > 0 && (
          <ul className="slist">
            {passkeys.map((p) => (
              <li key={p.id}>
                <Icon name="key" size={15} />
                <span className="slist-name">{p.name}</span>
                <span className="slist-meta">used {ago(p.lastUsedAt)}</span>
                <button className="btn ghost danger small" onClick={() => run(async () => (await sync.api(`/auth/passkeys/${encodeURIComponent(p.id)}`, { method: 'DELETE' }), load()))}>Remove</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="srow">
        <div className="srow-text">
          <div className="srow-title">Signed-in devices</div>
          <div className="srow-sub">Signing out keeps the tasks on that device, but stops syncing them.</div>
        </div>
        <ul className="slist">
          {devices.map((d) => (
            <li key={d.id}>
              <Icon name="system" size={15} />
              <span className="slist-name">
                {d.name}
                {d.current && <span className="chip">this device</span>}
              </span>
              {!d.current && <span className="slist-meta">seen {ago(d.lastSeenAt)}</span>}
              <button
                className="btn ghost danger small"
                onClick={() => run(async () => (d.current ? sync.signOut() : (await sync.api(`/devices/${d.id}`, { method: 'DELETE' }), load())))}
              >
                Sign out
              </button>
            </li>
          ))}
        </ul>
      </div>
      {error && <p className="form-error srow-msg" role="alert">{error}</p>}
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
    return (
      <div className="card scard">
        <div className="srow">
          <div className="srow-text">
            <div className="srow-title">Not available yet</div>
            <div className="srow-sub">Reminders are sent by the sync server, so sign in first.</div>
          </div>
        </div>
      </div>
    );
  }
  const save = (patch: Partial<typeof r>) => store.saveSettings({ reminders: { ...r, ...patch } });

  return (
    <div className="card scard">
      <div className="srow">
        <div className="srow-text">
          <div className="srow-title">Notifications on this device</div>
          <div className="srow-sub">
            {support === 'needs_home_screen'
              ? 'On iPhone and iPad, add the app to the Home Screen first (Share, Add to Home Screen), then open it from there and turn this on.'
              : support === 'unsupported'
                ? 'This browser cannot receive notifications from a web app.'
                : enabled
                  ? (tested ?? 'On. Reminders arrive even when the app is closed.')
                  : 'Off. Turn on to get reminders here.'}
          </div>
        </div>
        {support === 'ok' && (
          <div className="srow-actions">
            {enabled ? (
              <>
                <button className="btn" disabled={busy} onClick={() => run(async () => setTested((await sync.api<{ sent: number }>('/push/test', { body: {} })).sent ? 'Test sent. It should appear in a few seconds.' : 'No device is set up for notifications.'))}>
                  Send a test
                </button>
                <button className="btn" disabled={busy} onClick={() => run(async () => (await disablePush(sync), setEnabled(false), setTested(null)))}>Turn off</button>
              </>
            ) : (
              <button className="btn primary" disabled={busy || enabled === null} onClick={() => run(async () => (await enablePush(sync), setEnabled(true)))}>
                <Icon name="bell" size={15} /> Turn on
              </button>
            )}
          </div>
        )}
      </div>

      <div className="srow">
        <label className="scheck">
          <input type="checkbox" checked={r.atDueTime} onChange={(e) => save({ atDueTime: e.target.checked })} />
          <span className="srow-text">
            <span className="srow-title">Due time</span>
            <span className="srow-sub">For tasks that have a time</span>
          </span>
        </label>
        <select aria-label="When to remind" value={r.leadMin} disabled={!r.atDueTime} onChange={(e) => save({ leadMin: Number(e.target.value) })}>
          {LEADS.map((m) => (
            <option key={m} value={m}>{m ? `${m} min before` : 'At the due time'}</option>
          ))}
        </select>
      </div>

      <div className="srow">
        <label className="scheck">
          <input type="checkbox" checked={r.digest} onChange={(e) => save({ digest: e.target.checked })} />
          <span className="srow-text">
            <span className="srow-title">Morning summary</span>
            <span className="srow-sub">What is due today and overdue</span>
          </span>
        </label>
        <input type="time" aria-label="Summary time" value={r.digestTime} disabled={!r.digest} onChange={(e) => e.target.value && save({ digestTime: e.target.value })} />
      </div>
      <p className="srow-note">These settings apply to all your devices.</p>
      {error && <p className="form-error srow-msg" role="alert">{error}</p>}
    </div>
  );
}
