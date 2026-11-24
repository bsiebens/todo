import { dueReminders } from '../domain/reminders';
import type { Store } from '../db/store';
import { quickAddTask } from '../db/quick-add';
import { answerQuickEntry, DEFAULT_PREFS, parsePrefs, pruneFired, QUICK_ENTRY_DONE, QUICK_ENTRY_SAVE, reminderTasks, type DesktopPrefs, type QuickEntrySave } from './desktop-core';

/** True inside the Tauri desktop app (Windows, macOS, Linux); false in a browser or the installed PWA. */
export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || navigator.userAgent);

const PREFS_KEY = 'todo.desktop.prefs';
const FIRED_KEY = 'todo.desktop.reminders-shown';

let prefs: DesktopPrefs = DEFAULT_PREFS;
let registered = '';
const listeners = new Set<() => void>();

export function desktopPrefs(): DesktopPrefs {
  return prefs;
}

export function subscribeDesktopPrefs(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function invoke(cmd: string, args?: Record<string, unknown>) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(cmd, args);
}

/** The small quick-entry window, on top of whatever app is in front. */
function openQuickAdd() {
  void invoke('show_quick_entry');
}

/** Registers the global shortcut, replacing the previous one. Throws if another app already has it. */
async function registerHotkey(acc: string): Promise<void> {
  const gs = await import('@tauri-apps/plugin-global-shortcut');
  if (registered) {
    await gs.unregister(registered).catch(() => {});
    registered = '';
  }
  if (!acc) return;
  await gs.register(acc, (e) => {
    if (e.state === 'Pressed') openQuickAdd();
  });
  registered = acc;
}

/** Saves this computer's desktop settings and applies them right away. */
export async function updateDesktopPrefs(patch: Partial<DesktopPrefs>): Promise<void> {
  const next = { ...prefs, ...patch };
  if (patch.hotkey !== undefined && patch.hotkey !== registered) {
    try {
      await registerHotkey(patch.hotkey);
    } catch {
      await registerHotkey(prefs.hotkey).catch(() => {});
      throw new Error('That shortcut is already used by another app. Pick a different one.');
    }
  }
  if (patch.closeToTray !== undefined) await invoke('set_close_to_tray', { enabled: patch.closeToTray });
  if (patch.notifications) await ensureNotificationPermission();
  prefs = next;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage full or blocked: the setting lasts until restart */
  }
  for (const fn of listeners) fn();
}

export async function ensureNotificationPermission(): Promise<boolean> {
  const n = await import('@tauri-apps/plugin-notification');
  if (await n.isPermissionGranted()) return true;
  return (await n.requestPermission()) === 'granted';
}

export async function showNotification(title: string, body: string): Promise<void> {
  const n = await import('@tauri-apps/plugin-notification');
  if (!(await ensureNotificationPermission())) throw new Error('Notifications are turned off for ToDo in the system settings.');
  n.sendNotification({ title, body });
}

export async function launchAtLogin(): Promise<boolean> {
  const a = await import('@tauri-apps/plugin-autostart');
  return a.isEnabled();
}

export async function setLaunchAtLogin(on: boolean): Promise<void> {
  const a = await import('@tauri-apps/plugin-autostart');
  await (on ? a.enable() : a.disable());
}

function loadFired(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(FIRED_KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

/**
 * Checks for reminders every 30 seconds and shows each once as a native
 * notification. The desktop app doesn't use Web Push, so it works without the
 * server being reachable; the reminder settings are the synced ones.
 */
function startReminders(store: Store, signedIn: () => boolean) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const check = async () => {
    // Task titles stay hidden until the app is paired with the server.
    if (!prefs.notifications || !signedIn()) return;
    const now = new Date();
    const due = dueReminders(reminderTasks(store.snapshot.tasks), store.snapshot.settings.reminders, now, tz);
    const fired = pruneFired(loadFired(), now.getTime());
    const fresh = due.filter((r) => !fired[r.key]);
    if (!fresh.length) return;
    for (const r of fresh) {
      fired[r.key] = now.getTime();
      await showNotification(r.title, r.body).catch((e) => console.warn('notification failed', e));
    }
    try {
      localStorage.setItem(FIRED_KEY, JSON.stringify(fired));
    } catch {
      /* ignore */
    }
  };
  setInterval(check, 30_000);
  setTimeout(check, 3_000);
}

/** Wires up the desktop features. Call once, after the store is open. */
export async function startDesktop(store: Store, signedIn: () => boolean): Promise<void> {
  try {
    prefs = parsePrefs(localStorage.getItem(PREFS_KEY));
  } catch {
    prefs = DEFAULT_PREFS;
  }
  const { emitTo, listen } = await import('@tauri-apps/api/event');
  // The quick-entry window hands its line to this window, which owns the data, so the
  // new task shows up here and goes out with the next sync.
  await listen<QuickEntrySave>(QUICK_ENTRY_SAVE, async (e) => {
    const done = await answerQuickEntry(e.payload, signedIn(), (text) => quickAddTask(store, text));
    await emitTo('quick', QUICK_ENTRY_DONE, done);
  });
  await invoke('set_close_to_tray', { enabled: prefs.closeToTray }).catch(() => {});
  await registerHotkey(prefs.hotkey).catch((e) => console.warn('global shortcut not registered', e));
  // Ctrl+Q / Cmd+Q quits for real (the close button only hides to the tray).
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'q') {
      e.preventDefault();
      void invoke('quit');
    }
  });
  startReminders(store, signedIn);
}
