import { useEffect, useRef, useState } from 'react';
import type { Settings } from '../db/store';
import { Icon } from './Icon';
import { useDerived, useSnapshot, useStore } from './state';

type Mode = Settings['contextMode'];

const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** "Mon–Fri" for a consecutive run, otherwise "Mon, Wed, Fri". */
function dayText(officeDays: number[]): string {
  const d = [...officeDays].sort((a, b) => a - b);
  if (!d.length) return 'no days';
  const run = d.every((x, i) => i === 0 || x === d[i - 1]! + 1);
  return run && d.length > 2 ? `${days[d[0]! - 1]}–${days[d[d.length - 1]! - 1]}` : d.map((x) => days[x - 1]).join(', ');
}

/** Home/Office pill. Opens a small menu to pick Automatic, Home or Office, with a short explanation. */
export function ContextSwitch({ className = '', onOpenSettings }: { className?: string; onOpenSettings: () => void }) {
  const store = useStore();
  const s = useSnapshot();
  const d = useDerived();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const mode = s.settings.contextMode;
  const ctx = d.context;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (m: Mode) => {
    store.saveSettings({ contextMode: m });
    setOpen(false);
  };
  const hours = `${dayText(s.settings.officeDays)}, ${s.settings.officeStart}–${s.settings.officeEnd}`;
  const options: { m: Mode; label: string; sub: string; icon: 'clock' | 'home' | 'office' }[] = [
    { m: 'auto', label: 'Automatic', sub: `Office during office hours (${hours}), home otherwise`, icon: 'clock' },
    { m: 'home', label: 'Home', sub: 'Stay at home until you change it', icon: 'home' },
    { m: 'office', label: 'Office', sub: 'Stay at the office until you change it', icon: 'office' },
  ];

  return (
    <div className={`ctxwrap ${className}`} ref={ref}>
      <button
        className="ctx"
        aria-haspopup="menu"
        aria-expanded={open}
        title={mode === 'auto' ? `${ctx === 'office' ? 'Office' : 'Home'} (automatic). Click to change.` : `${ctx === 'office' ? 'Office' : 'Home'} (set by you). Click to change.`}
        onClick={() => setOpen(!open)}
      >
        <Icon name={ctx === 'office' ? 'office' : 'home'} size={16} />
        <span className="ctx-label">{ctx === 'office' ? 'Office' : 'Home'}</span>
        {mode === 'auto' && <span className="ctx-auto">Auto</span>}
        <Icon name="chevron" size={14} className="ctx-chev" />
      </button>
      {open && (
        <div className="ctxmenu" role="menu" aria-label="Where are you?">
          <div className="ctxmenu-head">Where are you?</div>
          <p className="ctxmenu-help">
            Tasks in projects set to Home or Office move up the list when you are there and down when you are not. Set a project's context under Projects &gt; Manage.
          </p>
          {options.map((o) => (
            <button key={o.m} role="menuitemradio" aria-checked={mode === o.m} className={`ctxopt ${mode === o.m ? 'on' : ''}`} onClick={() => pick(o.m)}>
              <Icon name={o.icon} size={18} />
              <span className="ctxopt-text">
                <span className="ctxopt-label">{o.label}</span>
                <span className="ctxopt-sub">{o.sub}</span>
              </span>
              {mode === o.m && <Icon name="check" size={16} className="ctxopt-check" />}
            </button>
          ))}
          <button
            className="linkbtn ctxmenu-foot"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
          >
            Change office days and hours
          </button>
        </div>
      )}
    </div>
  );
}
