import { Icon, type IconName } from './Icon';
import { THEME_PREFS, useTheme, type ThemePref } from './theme';

const ICONS: Record<ThemePref, IconName> = { system: 'system', light: 'sun', dark: 'moon' };

/** Segmented System / Light / Dark control. `compact` shows icons only (sidebar footer). */
export function ThemeSwitch({ compact = false }: { compact?: boolean }) {
  const { pref, setPref } = useTheme();
  return (
    <div className={`segmented ${compact ? 'compact' : ''}`} role="radiogroup" aria-label="Appearance">
      {THEME_PREFS.map((p) => (
        <button
          key={p.value}
          role="radio"
          aria-checked={pref === p.value}
          className={pref === p.value ? 'on' : ''}
          title={compact ? `${p.label} theme` : undefined}
          aria-label={compact ? `${p.label} theme` : undefined}
          onClick={() => setPref(p.value)}
        >
          <Icon name={ICONS[p.value]} size={16} />
          {!compact && <span>{p.label}</span>}
        </button>
      ))}
    </div>
  );
}
