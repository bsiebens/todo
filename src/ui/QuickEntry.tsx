import { useEffect, useMemo, useRef, useState } from 'react';
import { formatDue, toDateStr } from '../domain/dates';
import { parseQuickAdd } from '../domain/quickadd';
import { QUICK_ENTRY_DONE, QUICK_ENTRY_SAVE, type QuickEntryDone } from '../platform/desktop-core';
import { Icon } from './Icon';

async function tauri() {
  const [{ invoke }, { emitTo, listen }, { getCurrentWindow }] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/api/event'),
    import('@tauri-apps/api/window'),
  ]);
  return { invoke, emitTo, listen, win: getCurrentWindow() };
}

type Api = Awaited<ReturnType<typeof tauri>>;

/**
 * The desktop app's quick-entry window (Ctrl+Alt+N): one line, Enter saves the task
 * to the Inbox (or the @Project typed) and closes, Esc cancels. The main window
 * owns the database and does the saving, so the task shows up there and syncs at once.
 */
export function QuickEntry() {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const api = useRef<Api | null>(null);
  const busyRef = useRef(false);
  busyRef.current = busy;

  const today = toDateStr(new Date());
  const parsed = useMemo(() => (text.trim() ? parseQuickAdd(text, today) : null), [text, today]);
  const target = parsed?.projectPath ?? 'Inbox';

  useEffect(() => {
    const cleanups: (() => void)[] = [];
    let gone = false;
    const reset = async () => {
      setText('');
      setError(null);
      setBusy(false);
      // Not paired yet: nothing may be saved (and the main window shows the sign-in screen).
      const rows = await api.current!.invoke<unknown[]>('db_query', { sql: "SELECT 1 AS ok FROM sync_state WHERE key = 'token'", params: [] }).catch(() => []);
      setSignedIn(rows.length > 0);
      setTimeout(() => input.current?.focus(), 0);
    };
    tauri().then(async (t) => {
      if (gone) return;
      api.current = t;
      cleanups.push(await t.listen('quick-open', reset));
      // Clicking another app puts the window away, like Spotlight.
      cleanups.push(
        await t.win.onFocusChanged(({ payload: focused }) => {
          if (!focused && !busyRef.current) void t.win.hide();
        }),
      );
      await reset();
    });
    return () => {
      gone = true;
      cleanups.forEach((fn) => fn());
    };
  }, []);

  const hide = () => void api.current?.win.hide();

  const save = async () => {
    const t = api.current;
    if (!t || busy || !text.trim()) return;
    if (!parsed?.title) return setError('Type a name for the task.');
    setBusy(true);
    setError(null);
    const id = crypto.randomUUID();
    try {
      const done = await new Promise<QuickEntryDone>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ToDo did not answer. Try again.')), 5000);
        void t
          .listen<QuickEntryDone>(QUICK_ENTRY_DONE, (e) => {
            if (e.payload.id !== id) return;
            clearTimeout(timer);
            resolve(e.payload);
          })
          .then((unlisten) => setTimeout(unlisten, 5100));
        void t.emitTo('main', QUICK_ENTRY_SAVE, { id, text });
      });
      if (!done.ok) throw new Error(done.error ?? 'The task was not saved.');
      setText('');
      await t.win.hide();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (signedIn === false) {
    return (
      <div className="quick-entry">
        <div className="qe-signin">
          <span>Sign in to ToDo first.</span>
          <button className="btn primary" autoFocus onClick={() => (void api.current?.invoke('show_window'), hide())} onKeyDown={(e) => e.key === 'Escape' && hide()}>
            Open ToDo
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="quick-entry">
      <div className="qe-field">
        <span className="qa-icon" aria-hidden="true"><Icon name="plus" size={20} /></span>
        <input
          ref={input}
          autoFocus
          aria-label="New task"
          placeholder="New task: Call accountant fri 14:00 !high #finance"
          value={text}
          disabled={busy}
          onChange={(e) => (setText(e.target.value), setError(null))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') hide();
          }}
        />
      </div>
      <div className="qe-foot" aria-live="polite">
        {error ? (
          <span className="qe-error" role="alert">{error}</span>
        ) : (
          <span className="chips">
            {parsed?.chips
              .filter((c) => c.kind !== 'project')
              .map((c, i) => (
                <span className="chip" key={i}>{c.kind === 'date' ? formatDue(c.label, null, today) : c.label}</span>
              ))}
          </span>
        )}
        <span className="qe-hint">
          <kbd>Enter</kbd> adds to <strong>{target}</strong> · <kbd>Esc</kbd> cancels
        </span>
      </div>
    </div>
  );
}
