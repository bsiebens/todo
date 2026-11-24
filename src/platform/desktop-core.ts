import type { DueTask } from '../domain/reminders';
import { isOpen, type Task } from '../domain/types';

/** Settings that belong to this computer only (not synced). */
export interface DesktopPrefs {
  /** Global shortcut that opens quick add, as a Tauri accelerator ("CommandOrControl+Alt+N"); '' = none. */
  hotkey: string;
  /** The window's close button hides ToDo to the tray instead of quitting. */
  closeToTray: boolean;
  /** Show reminders as desktop notifications. */
  notifications: boolean;
}

export const DEFAULT_PREFS: DesktopPrefs = { hotkey: 'CommandOrControl+Alt+N', closeToTray: true, notifications: true };

export function parsePrefs(raw: string | null): DesktopPrefs {
  try {
    const v = raw ? (JSON.parse(raw) as Partial<DesktopPrefs>) : {};
    return {
      hotkey: typeof v.hotkey === 'string' ? v.hotkey : DEFAULT_PREFS.hotkey,
      closeToTray: typeof v.closeToTray === 'boolean' ? v.closeToTray : DEFAULT_PREFS.closeToTray,
      notifications: typeof v.notifications === 'boolean' ? v.notifications : DEFAULT_PREFS.notifications,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** Tasks that can get a reminder: open, with a due date. */
export function reminderTasks(tasks: Task[]): DueTask[] {
  return tasks.filter((t) => isOpen(t) && t.dueDate).map((t) => ({ id: t.id, title: t.title || 'Task', dueDate: t.dueDate!, dueTime: t.dueTime }));
}

/** Keys of reminders already shown, with when; entries older than `keepMs` are dropped. */
export function pruneFired(fired: Record<string, number>, now: number, keepMs = 3 * 86_400_000): Record<string, number> {
  return Object.fromEntries(Object.entries(fired).filter(([, t]) => now - t < keepMs));
}

const KEY_NAMES: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
};

/**
 * A global shortcut from a key press, or null while only modifiers are down or
 * no modifier is held (a bare letter would fire while typing anywhere).
 */
export function acceleratorFromEvent(e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>, mac: boolean): string | null {
  let key: string | undefined;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.code)) key = e.code;
  else key = KEY_NAMES[e.code];
  if (!key) return null;
  const mods: string[] = [];
  // "CommandOrControl" is Cmd on a Mac and Ctrl elsewhere, so the setting reads right on both.
  if (mac ? e.metaKey : e.ctrlKey) mods.push('CommandOrControl');
  if (mac && e.ctrlKey) mods.push('Control');
  if (!mac && e.metaKey) mods.push('Super');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (!mods.length || (mods.length === 1 && mods[0] === 'Shift')) return null;
  return [...mods, key].join('+');
}

/** How a shortcut is shown to people: "Ctrl+Alt+N" on Windows, "⌘⌥N" on a Mac. */
export function displayAccelerator(acc: string, mac: boolean): string {
  if (!acc) return 'None';
  const parts = acc.split('+');
  if (mac) {
    const sym: Record<string, string> = { CommandOrControl: '⌘', Control: '⌃', Alt: '⌥', Shift: '⇧', Super: '⌘' };
    return parts.map((p) => sym[p] ?? p).join('');
  }
  const word: Record<string, string> = { CommandOrControl: 'Ctrl', Super: 'Win' };
  return parts.map((p) => word[p] ?? p).join('+');
}

/** Turns what someone typed into a server address: https by default, no trailing slash. */
export function normalizeServerUrl(input: string): string {
  let s = input.trim();
  if (!s) return '';
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Use an https:// address.');
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}
