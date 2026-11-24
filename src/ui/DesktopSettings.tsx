import { useEffect, useState, useSyncExternalStore } from 'react';
import { desktopPrefs, isMac, launchAtLogin, setLaunchAtLogin, showNotification, subscribeDesktopPrefs, updateDesktopPrefs } from '../platform/desktop';
import { acceleratorFromEvent, displayAccelerator, type DesktopPrefs } from '../platform/desktop-core';

const usePrefs = () => useSyncExternalStore(subscribeDesktopPrefs, desktopPrefs);

function useRun() {
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<unknown>) => {
    setError(null);
    fn().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  return { error, run };
}

/** The notifications row of the Reminders card, in the desktop app. */
export function DesktopNotifications() {
  const prefs = usePrefs();
  const [tested, setTested] = useState(false);
  const { error, run } = useRun();
  return (
    <>
      <div className="setting-row">
        <div>
          <div>Notifications on this computer</div>
          <div className="small muted">{prefs.notifications ? 'On. Reminders show while ToDo runs, also when it is closed to the tray.' : 'Off. Turn on to get reminders here.'}</div>
        </div>
        <div className="actions" style={{ margin: 0 }}>
          {prefs.notifications && (
            <button className="btn" onClick={() => run(async () => (await showNotification('ToDo reminders work', 'You will get reminders like this one.'), setTested(true)))}>
              Send a test
            </button>
          )}
          <button className={`btn${prefs.notifications ? '' : ' primary'}`} onClick={() => run(() => updateDesktopPrefs({ notifications: !prefs.notifications }))}>
            {prefs.notifications ? 'Turn off' : 'Turn on'}
          </button>
        </div>
      </div>
      {tested && <p className="small muted">Sent. If nothing appeared, check that notifications for ToDo are allowed in the system settings.</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function ShortcutInput({ value, onChange }: { value: string; onChange: (acc: string) => void }) {
  const [recording, setRecording] = useState(false);
  return (
    <div className="inline">
      <input
        aria-label="Quick add shortcut"
        readOnly
        className="shortcut"
        value={recording ? 'Press the keys…' : displayAccelerator(value, isMac)}
        onFocus={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={(e) => {
          if (e.key === 'Tab') return;
          e.preventDefault();
          if (e.key === 'Escape') return (e.target as HTMLInputElement).blur();
          const acc = acceleratorFromEvent(e.nativeEvent, isMac);
          if (acc) {
            onChange(acc);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {value && (
        <button className="btn ghost" onClick={() => onChange('')}>
          Clear
        </button>
      )}
    </div>
  );
}

/** Settings that belong to this computer: shortcut, tray, start at login. */
export function DesktopSettings() {
  const prefs = usePrefs();
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const { error, run } = useRun();

  useEffect(() => {
    launchAtLogin().then(setAutostart, () => setAutostart(false));
  }, []);

  const set = (patch: Partial<DesktopPrefs>) => run(() => updateDesktopPrefs(patch));

  return (
    <div className="card">
      <div className="fields">
        <label>Quick add from anywhere</label>
        <ShortcutInput value={prefs.hotkey} onChange={(hotkey) => set({ hotkey })} />
        <label htmlFor="d-tray">Close button</label>
        <label className="toggle">
          <input id="d-tray" type="checkbox" checked={prefs.closeToTray} onChange={(e) => set({ closeToTray: e.target.checked })} /> Keep running in the {isMac ? 'menu bar' : 'tray'}
        </label>
        <label htmlFor="d-login">At login</label>
        <label className="toggle">
          <input
            id="d-login"
            type="checkbox"
            disabled={autostart === null}
            checked={!!autostart}
            onChange={(e) => {
              const on = e.target.checked;
              run(async () => (await setLaunchAtLogin(on), setAutostart(on)));
            }}
          />{' '}
          Start ToDo in the {isMac ? 'menu bar' : 'tray'}
        </label>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <p className="small muted" style={{ marginBottom: 0 }}>
        These settings are for this computer only. {isMac ? '⌘Q' : 'Ctrl+Q'} quits ToDo; you can also quit from the {isMac ? 'menu bar' : 'tray'} icon.
      </p>
    </div>
  );
}
