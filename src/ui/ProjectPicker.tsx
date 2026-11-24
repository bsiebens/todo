import { useEffect, useMemo, useRef, useState } from 'react';
import type { Id } from '../domain/types';
import { Icon } from './Icon';
import { useDerived } from './state';

interface Props {
  id?: string;
  value: Id | null;
  onChange: (projectId: Id | null) => void;
}

interface Option {
  id: Id | null;
  name: string;
  path: string;
  depth: number;
  /** For tree guides: whether each ancestor level still has siblings below this row. */
  last: boolean;
}

/**
 * Project field for the task detail. Looks like the other fields; opens a searchable tree so nested
 * projects are easy to tell apart (the native dropdown could only indent with spaces).
 */
export function ProjectPicker({ id, value, onChange }: Props) {
  const d = useDerived();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hl, setHl] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const all = useMemo<Option[]>(() => {
    const flat = d.tree.flatten().filter((x) => !x.project.archivedAt || x.project.id === value);
    return [
      { id: null, name: 'Inbox', path: 'Inbox', depth: 0, last: false },
      ...flat.map(({ project, depth }, i) => {
        const next = flat[i + 1];
        return { id: project.id, name: project.name, path: d.tree.path(project.id), depth, last: !next || next.depth < depth };
      }),
    ];
  }, [d.tree, value]);

  const term = q.trim().toLowerCase();
  const shown = term ? all.filter((o) => o.path.toLowerCase().includes(term)) : all;
  const current = all.find((o) => o.id === value) ?? all[0]!;

  useEffect(() => {
    if (!open) return;
    setQ('');
    setHl(Math.max(0, all.findIndex((o) => o.id === value)));
    setTimeout(() => search.current?.focus(), 0);
    const onDown = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${hl}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [hl, open]);

  const choose = (o: Option) => {
    if (o.id !== value) onChange(o.id);
    setOpen(false);
  };

  return (
    <div className="picker" ref={wrap}>
      <button
        id={id}
        type="button"
        className={`picker-btn ${open ? 'open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Icon name={value ? 'folder' : 'inbox'} size={16} />
        <span className="picker-value">
          {current.depth > 0 && <span className="picker-parent">{current.path.slice(0, current.path.length - current.name.length)}</span>}
          {current.name}
        </span>
        <Icon name="chevron" size={14} className="picker-chev" />
      </button>
      {open && <div className="picker-scrim" aria-hidden="true" />}
      {open && (
        <div className="picker-pop" role="dialog" aria-label="Choose project">
          <div className="picker-title">Project</div>
          <div className="picker-search">
            <Icon name="search" size={15} />
            <input
              ref={search}
              type="search"
              placeholder="Find a project"
              aria-label="Find a project"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setHl(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setHl((h) => Math.min(h + 1, shown.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setHl((h) => Math.max(h - 1, 0));
                } else if (e.key === 'Enter' && shown[hl]) {
                  e.preventDefault();
                  choose(shown[hl]!);
                } else if (e.key === 'Escape') {
                  e.stopPropagation();
                  setOpen(false);
                }
              }}
            />
          </div>
          <div className="picker-list" role="listbox" ref={list}>
            {shown.map((o, i) => (
              <button
                key={o.id ?? 'inbox'}
                type="button"
                role="option"
                data-i={i}
                aria-selected={o.id === value}
                className={`picker-opt ${i === hl ? 'hl' : ''} ${o.id === value ? 'on' : ''} ${o.id === null ? 'inbox' : ''}`}
                style={term ? undefined : { paddingLeft: 10 + o.depth * 20 }}
                onMouseEnter={() => setHl(i)}
                onClick={() => choose(o)}
              >
                {!term && o.depth > 0 && <span className="picker-guide" style={{ left: 18 + (o.depth - 1) * 20 }} aria-hidden="true" />}
                <Icon name={o.id ? 'folder' : 'inbox'} size={16} />
                <span className="picker-text">
                  <span className="picker-name">{o.name}</span>
                  {term && o.depth > 0 && <span className="picker-path">{o.path}</span>}
                </span>
                {o.id === value && <Icon name="check" size={16} className="picker-check" />}
              </button>
            ))}
            {shown.length === 0 && <div className="picker-empty">No project matches “{q}”.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
