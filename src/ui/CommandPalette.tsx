import { useEffect, useMemo, useRef, useState } from 'react';
import { fuzzyFilter } from '../domain/fuzzy';
import { Icon, type IconName } from './Icon';

export interface Command {
  id: string;
  label: string;
  group: string;
  icon?: IconName;
  /** Extra words that should also find this command. */
  keywords?: string;
  hint?: string;
  run: () => void;
}

export const PALETTE_SHORTCUT = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘P' : 'Ctrl P';

/**
 * Keyboard command palette. `commands` is the fixed list; `dynamic` adds entries that
 * depend on what was typed (open a task, add the text as a task, search for it).
 */
export function CommandPalette({ commands, dynamic, onClose }: { commands: Command[]; dynamic: (q: string) => Command[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const fixed = fuzzyFilter(q, commands, (c) => `${c.group} ${c.label} ${c.keywords ?? ''}`, q ? 40 : 200);
    return q.trim() ? [...fixed, ...dynamic(q)] : fixed;
  }, [q, commands, dynamic]);

  useEffect(() => setIdx(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };

  return (
    <div className="modal-bg palette-bg" onClick={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Icon name="command" />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={results[idx] ? `pc-${idx}` : undefined}
            placeholder="Type a command, a task or a view…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIdx((i) => Math.min(i + 1, results.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIdx((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(results[idx]);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {results.map((c, i) => (
            <div
              key={c.id}
              id={`pc-${i}`}
              role="option"
              aria-selected={i === idx}
              className={`pitem ${i === idx ? 'on' : ''}`}
              onMouseMove={() => i !== idx && setIdx(i)}
              onClick={() => run(c)}
            >
              <Icon name={c.icon ?? 'chevron'} size={16} />
              <span className="pgroup">{c.group}</span>
              <span className="plabel">{c.label}</span>
              {c.hint && <kbd>{c.hint}</kbd>}
            </div>
          ))}
          {results.length === 0 && <div className="pempty muted">No matching commands.</div>}
        </div>
      </div>
    </div>
  );
}
