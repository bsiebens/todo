import { useState } from 'react';
import { addFilter, removeFilter, updateFilter } from '../domain/filters';
import type { Id } from '../domain/types';
import { useSnapshot, useStore } from './state';
import type { View } from './views';

/** Save the current search as a named filter. */
export function SaveFilter({ query, onSaved }: { query: string; onSaved: (id: Id) => void }) {
  const store = useStore();
  const s = useSnapshot();
  const [name, setName] = useState<string | null>(null);
  if (!query.trim()) return null;
  const save = async () => {
    const { list, id } = addFilter(s.settings.savedFilters, name ?? '', query);
    await store.saveSettings({ savedFilters: list });
    setName(null);
    onSaved(id);
  };
  if (name === null)
    return (
      <div className="filterbar">
        <button className="btn small" onClick={() => setName('')}>Save as filter</button>
      </div>
    );
  return (
    <div className="filterbar">
      <input
        autoFocus
        aria-label="Filter name"
        placeholder="Name, for example Due this week"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') setName(null);
        }}
      />
      <button className="btn small primary" onClick={save}>Save</button>
      <button className="btn small" onClick={() => setName(null)}>Cancel</button>
    </div>
  );
}

/** Shows a saved filter's query, with rename/edit and delete. */
export function FilterHeader({ id, onNavigate }: { id: Id; onNavigate: (v: View) => void }) {
  const store = useStore();
  const s = useSnapshot();
  const f = s.settings.savedFilters.find((x) => x.id === id);
  const [edit, setEdit] = useState<{ name: string; query: string } | null>(null);
  if (!f) return null;
  const list = s.settings.savedFilters;
  if (!edit)
    return (
      <div className="filterbar">
        <code className="small">{f.query}</code>
        <button className="btn small" onClick={() => setEdit({ name: f.name, query: f.query })}>Edit</button>
        <button
          className="btn small danger"
          onClick={async () => {
            if (!confirm(`Delete the filter "${f.name}"? Your tasks stay as they are.`)) return;
            await store.saveSettings({ savedFilters: removeFilter(list, id) });
            onNavigate({ kind: 'focus' });
          }}
        >
          Delete
        </button>
      </div>
    );
  const save = async () => {
    if (!edit.query.trim()) return;
    await store.saveSettings({ savedFilters: updateFilter(list, id, { name: edit.name.trim() || edit.query.trim(), query: edit.query.trim() }) });
    setEdit(null);
  };
  return (
    <div className="filterbar editing">
      <input aria-label="Filter name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && save()} />
      <input
        aria-label="Filter query"
        className="grow"
        value={edit.query}
        placeholder="#tag project:Work due<7d !high"
        onChange={(e) => setEdit({ ...edit, query: e.target.value })}
        onKeyDown={(e) => e.key === 'Enter' && save()}
      />
      <button className="btn small primary" onClick={save}>Save</button>
      <button className="btn small" onClick={() => setEdit(null)}>Cancel</button>
    </div>
  );
}
