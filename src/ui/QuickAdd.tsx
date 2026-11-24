import { useMemo, useState, forwardRef } from 'react';
import { formatDue, toDateStr } from '../domain/dates';
import { parseQuickAdd } from '../domain/quickadd';
import type { Id } from '../domain/types';
import { useActions } from './actions';
import { Icon } from './Icon';

interface Props {
  defaultProjectId?: Id | null;
  onCreated?: (id: Id) => void;
  autoFocus?: boolean;
}

export const SHORTCUT = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘K' : 'Ctrl K';

/** One line, parsed into chips as you type. Enter saves. */
export const QuickAdd = forwardRef<HTMLInputElement, Props>(function QuickAdd({ defaultProjectId, onCreated, autoFocus }, ref) {
  const [text, setText] = useState('');
  const { quickAdd } = useActions();
  const parsed = useMemo(() => (text.trim() ? parseQuickAdd(text, toDateStr(new Date())) : null), [text]);

  const submit = async () => {
    const id = await quickAdd(text, { projectId: defaultProjectId });
    if (id) {
      setText('');
      onCreated?.(id);
    }
  };

  return (
    <div className="quickadd">
      <span className="qa-icon" aria-hidden="true"><Icon name="plus" size={18} /></span>
      <input
        ref={ref}
        autoFocus={autoFocus}
        aria-label="Add a task"
        placeholder="Add a task: Call accountant fri 14:00 !high #finance @Work/Admin"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
        }}
      />
      <kbd className="qa-kbd" aria-hidden="true">{SHORTCUT}</kbd>
      {parsed && (parsed.chips.length > 0 || parsed.title) && (
        <div className="chips" aria-live="polite">
          {parsed.title && <span className="small muted">{parsed.title}</span>}
          {parsed.chips.map((c, i) => (
            <span className="chip" key={i}>{c.kind === 'date' ? formatDue(c.label, null, toDateStr(new Date())) : c.label}</span>
          ))}
        </div>
      )}
    </div>
  );
});
