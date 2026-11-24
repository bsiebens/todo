import { describe, expect, it } from 'vitest';
import { nextThemePref, parseThemePref, resolveTheme } from './theme';

describe('theme', () => {
  it('follows the system setting by default', () => {
    expect(parseThemePref(null)).toBe('system');
    expect(parseThemePref('nonsense')).toBe('system');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('a manual choice overrides the system setting', () => {
    expect(parseThemePref('dark')).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('cycles System, Light, Dark', () => {
    expect(nextThemePref('system')).toBe('light');
    expect(nextThemePref('light')).toBe('dark');
    expect(nextThemePref('dark')).toBe('system');
  });
});
