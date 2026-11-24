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
      <div className="srow">
        <div className="srow-text">
          <div className="srow-title">Notifications on this computer</div>
          <div className="srow-sub">
            {!prefs.notifications
              ? 'Off. Turn on to get reminders here.'
              : tested
                ? 'Test sent. If nothing appeared, allow notifications for ToDo in the system settings.'
                : 'On. Reminders show while ToDo runs, also when it is closed to the tray.'}
          </div>
        </div>
        <div className="srow-actions">
          {prefs.notifications && (
            <button className="btn" onClick={() => run(async () => (await showNotification('ToDo reminders work', 'You will get reminders like this one.'), setTested(true)))}>
              Send a test
            </button>
          )}
          <button className={`btn${prefs.notifications ? '' : ' primary'}`} onClick={() => run(async () => (await updateDesktopPrefs({ notifications: !prefs.notifications }), setTested(false)))}>
            {prefs.notifications ? 'Turn off' : 'Turn on'}
          </button>
        </div>
      </div>
      {error && <p className="form-error srow-msg" role="alert">{error}</p>}
    </>
  );
}

function ShortcutInput({ value, onChange }: { value: string; onChange: (acc: string) => void }) {
  const [recording, setRecording] = useState(false);
  return (
    <div className="srow-actions">
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
  const tray = isMac ? 'menu bar' : 'tray';

  useEffect(() => {
    launchAtLogin().then(setAutostart, () => setAutostart(false));
  }, []);

  const set = (patch: Partial<DesktopPrefs>) => run(() => updateDesktopPrefs(patch));

  return (
    <div className="card scard">
      <div className="srow">
        <div className="srow-text">
          <div className="srow-title">Quick add from anywhere</div>
          <div className="srow-sub">Opens a small window that adds a task to the Inbox, from any app. Click the field and press the keys you want.</div>
        </div>
        <ShortcutInput value={prefs.hotkey} onChange={(hotkey) => set({ hotkey })} />
      </div>
      <div className="srow">
        <label className="scheck">
          <input type="checkbox" checked={prefs.closeToTray} onChange={(e) => set({ closeToTray: e.target.checked })} />
          <span className="srow-text">
            <span className="srow-title">Keep running in the {tray}</span>
            <span className="srow-sub">The close button hides ToDo so reminders keep coming. {isMac ? '⌘Q' : 'Ctrl+Q'} or the {tray} icon quits.</span>
          </span>
        </label>
      </div>
      <div className="srow">
        <label className="scheck">
          <input
            type="checkbox"
            disabled={autostart === null}
            checked={!!autostart}
            onChange={(e) => {
              const on = e.target.checked;
              run(async () => (await setLaunchAtLogin(on), setAutostart(on)));
            }}
          />
          <span className="srow-text">
            <span className="srow-title">Start at login</span>
            <span className="srow-sub">Opens quietly in the {tray}.</span>
          </span>
        </label>
      </div>
      <p className="srow-note">These settings are for this computer only.</p>
      {error && <p className="form-error srow-msg" role="alert">{error}</p>}
    </div>
  );
}
