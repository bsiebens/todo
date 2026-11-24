import { describe, expect, it } from 'vitest';
import type { Task } from '../domain/types';
import { acceleratorFromEvent, displayAccelerator, normalizeServerUrl, parsePrefs, pruneFired, reminderTasks, DEFAULT_PREFS } from './desktop-core';

const key = (code: string, m: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({ code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...m });

describe('acceleratorFromEvent', () => {
  it('builds Tauri accelerators', () => {
    expect(acceleratorFromEvent(key('KeyN', { ctrlKey: true, altKey: true }), false)).toBe('CommandOrControl+Alt+N');
    expect(acceleratorFromEvent(key('Space', { metaKey: true, shiftKey: true }), true)).toBe('CommandOrControl+Shift+Space');
    expect(acceleratorFromEvent(key('Digit1', { ctrlKey: true }), true)).toBe('Control+1');
    expect(acceleratorFromEvent(key('F9', { metaKey: true }), false)).toBe('Super+F9');
  });
  it('needs a real key and a modifier other than Shift', () => {
    expect(acceleratorFromEvent(key('KeyN'), false)).toBeNull();
    expect(acceleratorFromEvent(key('KeyN', { shiftKey: true }), false)).toBeNull();
    expect(acceleratorFromEvent(key('ControlLeft', { ctrlKey: true }), false)).toBeNull();
  });
});

it('displays shortcuts per platform', () => {
  expect(displayAccelerator('CommandOrControl+Alt+N', false)).toBe('Ctrl+Alt+N');
  expect(displayAccelerator('CommandOrControl+Alt+N', true)).toBe('⌘⌥N');
  expect(displayAccelerator('', false)).toBe('None');
});

it('normalizes server addresses', () => {
  expect(normalizeServerUrl(' todo.example.org/ ')).toBe('https://todo.example.org');
  expect(normalizeServerUrl('https://todo.example.org:8443/app/')).toBe('https://todo.example.org:8443/app');
  expect(normalizeServerUrl('http://192.168.1.5:8080')).toBe('http://192.168.1.5:8080');
  expect(() => normalizeServerUrl('ftp://x')).toThrow();
  expect(normalizeServerUrl('')).toBe('');
});

it('reads saved prefs with defaults for anything missing or broken', () => {
  expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
  expect(parsePrefs('{nope')).toEqual(DEFAULT_PREFS);
  expect(parsePrefs('{"hotkey":"","closeToTray":false}')).toEqual({ hotkey: '', closeToTray: false, notifications: true });
});

it('forgets shown reminders after three days', () => {
  const now = Date.parse('2026-11-24T12:00:00Z');
  expect(pruneFired({ a: now - 1000, b: now - 4 * 86_400_000 }, now)).toEqual({ a: now - 1000 });
});

it('only reminds about open tasks with a due date', () => {
  const t = (id: string, status: Task['status'], dueDate: string | null) => ({ id, title: id, status, dueDate, dueTime: '09:00' }) as Task;
  expect(reminderTasks([t('a', 'todo', '2026-11-24'), t('b', 'done', '2026-11-24'), t('c', 'in_progress', null), t('d', 'in_progress', '2026-11-25')]).map((x) => x.id)).toEqual(['a', 'd']);
});
