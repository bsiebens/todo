import { useMemo, useState } from 'react';
import type { Context } from '../domain/types';
import type { Store } from '../db/store';
import { useActions } from './actions';
import { Icon } from './Icon';
import { presetName } from './Tuning';
import type { View } from './views';
import { SyncSettings } from './SyncSettings';
import { ThemeSwitch } from './ThemeSwitch';
import { currentContext, useNow, useSnapshot, useStore } from './state';

export function downloadExport(store: Store) {
  const blob = new Blob([store.exportJson()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `todo-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function SettingsView({ initialCode, onNavigate, onImport }: { initialCode?: string | null; onNavigate: (v: View) => void; onImport: () => void }) {
  const store = useStore();
  const s = useSnapshot();
  const now = useNow();

  const st = s.settings;
  return (
    <div className="settings">
      <div className="viewhead"><h1>Settings</h1></div>

      <SyncSettings initialCode={initialCode} />

      <h2>Appearance</h2>
      <div className="card">
        <div className="setting-row">
          <div>
            <div>Theme</div>
            <div className="small muted">System follows your device's light or dark setting. Saved on this device only.</div>
          </div>
          <ThemeSwitch full />
        </div>
      </div>

      <h2>Home or office</h2>
      <div className="card">
      <p className="card-help">
        Your context tells the app where you are. Tasks in projects set to <b>Office</b> rank higher while you are at the office and lower at home, and the
        other way round for <b>Home</b>. Give a project its context under <b>Projects &gt; Manage</b> (sub-projects inherit it). <b>Automatic</b> switches to
        Office during the days and hours below. You can also switch any time with the Home/Office button at the top of the screen.
      </p>
      <div className="fields">
        <label htmlFor="ctx">Context</label>
        <select id="ctx" value={st.contextMode} onChange={(e) => store.saveSettings({ contextMode: e.target.value as typeof st.contextMode })}>
          <option value="auto">Automatic, now {currentContext(st, now) === 'office' ? 'Office' : 'Home'}</option>
          <option value="home">Always home</option>
          <option value="office">Always office</option>
        </select>
        <label>Office days</label>
        <div className="inline">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((n, i) => (
            <label key={n} className="daychip">
              <input
                type="checkbox"
                checked={st.officeDays.includes(i + 1)}
                onChange={(e) => store.saveSettings({ officeDays: e.target.checked ? [...st.officeDays, i + 1].sort() : st.officeDays.filter((x) => x !== i + 1) })}
              />{' '}
              {n}
            </label>
          ))}
        </div>
        <label>Office hours</label>
        <div className="inline">
          <input type="time" aria-label="Office start" value={st.officeStart} onChange={(e) => store.saveSettings({ officeStart: e.target.value })} />
          <span>to</span>
          <input type="time" aria-label="Office end" value={st.officeEnd} onChange={(e) => store.saveSettings({ officeEnd: e.target.value })} />
        </div>
      </div>
      </div>

      <h2>Urgency</h2>
      <div className="card">
        <div className="setting-row">
          <div>
            <div>Ranking: {presetName(s.settings.weights) ?? 'Custom weights'}</div>
            <div className="small muted">Choose a preset or tune each factor, with a live preview of your list.</div>
          </div>
          <button className="btn" onClick={() => onNavigate({ kind: 'urgency' })}>
            <Icon name="sliders" size={16} /> Tune
          </button>
        </div>
      </div>

      <h2>Data</h2>
      <div className="card">
      <p className="small muted" style={{ marginTop: 0 }}>
        Stored on this device ({store.storage === 'OPFS' ? 'browser private storage, kept offline' : 'memory only: this browser does not allow offline storage, data is lost on reload'}).
      </p>
      <div className="actions">
        <button className="btn" onClick={onImport}>
          <Icon name="upload" size={16} /> Import from another app
        </button>
        <button className="btn" onClick={() => downloadExport(store)}>Export everything as JSON</button>
      </div>
      <p className="small muted">Import reads Todoist and TickTick CSV exports, Outlook and other CSV task lists, plain text lists and ToDo JSON exports.</p>
      </div>
    </div>
  );
}

export function ProjectsView({ onOpen }: { onOpen: (id: string) => void }) {
  const store = useStore();
  const s = useSnapshot();
  const { notify } = useActions();
  const tree = useMemo(() => store.tree(), [s, store]);
  const [name, setName] = useState('');
  const [parent, setParent] = useState('');

  const add = async () => {
    if (!name.trim()) return;
    await store.createProject(name, parent || null);
    setName('');
  };

  return (
    <div className="settings">
      <div className="viewhead"><h1>Projects</h1></div>
      <div className="addrow">
        <input placeholder="New project name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <select aria-label="Parent project" value={parent} onChange={(e) => setParent(e.target.value)}>
          <option value="">Top level</option>
          {tree.flatten().map(({ project, depth }) => (
            <option key={project.id} value={project.id}>{'  '.repeat(depth) + project.name}</option>
          ))}
        </select>
        <button className="btn primary" onClick={add}>Add project</button>
      </div>
      <div className="card tree">
        {tree.flatten().map(({ project: p, depth }) => (
          <div className="node" key={p.id} style={{ paddingLeft: depth * 18 }}>
            <input
              className="pname"
              aria-label="Project name"
              defaultValue={p.name}
              onBlur={(e) => e.target.value.trim() && e.target.value !== p.name && store.updateProject(p.id, { name: e.target.value.trim() })}
            />
            <select
              aria-label="Parent"
              value={p.parentId ?? ''}
              onChange={(e) => store.updateProject(p.id, { parentId: e.target.value || null }).catch((err) => notify(err.message))}
            >
              <option value="">Top level</option>
              {tree.flatten().filter((x) => x.project.id !== p.id).map(({ project, depth: dd }) => (
                <option key={project.id} value={project.id} disabled={!tree.canMove(p.id, project.id)}>{'  '.repeat(dd) + project.name}</option>
              ))}
            </select>
            <select aria-label="Context" value={p.context ?? ''} onChange={(e) => store.updateProject(p.id, { context: (e.target.value || null) as Context | null })}>
              <option value="">Context: inherit ({tree.effectiveContext(p.parentId)})</option>
              <option value="office">Office</option>
              <option value="home">Home</option>
              <option value="any">Any</option>
            </select>
            <input
              type="number"
              step={0.5}
              style={{ width: 80 }}
              aria-label="Urgency weight"
              title="Urgency weight (empty = inherit)"
              placeholder="inherit"
              defaultValue={p.urgencyWeight ?? ''}
              onBlur={(e) => store.updateProject(p.id, { urgencyWeight: e.target.value === '' ? null : Number(e.target.value) })}
            />
            <button className="btn" onClick={() => onOpen(p.id)}>Open</button>
            <button
              className="btn danger"
              onClick={() => confirm(`Delete "${p.name}"? Its tasks and sub-projects move up one level.`) && store.deleteProject(p.id)}
            >
              Delete
            </button>
          </div>
        ))}
        {s.projects.length === 0 && <p className="muted">No projects yet.</p>}
      </div>
    </div>
  );
}

export function TagsView({ onOpen }: { onOpen: (id: string) => void }) {
  const store = useStore();
  const s = useSnapshot();
  return (
    <div className="settings">
      <div className="viewhead"><h1>Tags</h1></div>
      <p className="small muted">A tag's weight is added to the urgency of every task that has it, for example -5 for #waiting.</p>
      <div className="card tree">
        {s.tags.map((t) => (
          <div className="node" key={t.id}>
            <input className="pname" aria-label="Tag name" defaultValue={t.name} onBlur={(e) => e.target.value.trim() && e.target.value !== t.name && store.updateTag(t.id, { name: e.target.value.trim() })} />
            <input type="number" step={0.5} style={{ width: 80 }} aria-label="Urgency weight" defaultValue={t.urgencyWeight} onBlur={(e) => store.updateTag(t.id, { urgencyWeight: Number(e.target.value) || 0 })} />
            <button className="btn" onClick={() => onOpen(t.id)}>Open</button>
            <button className="btn danger" onClick={() => confirm(`Delete #${t.name}?`) && store.deleteTag(t.id)}>Delete</button>
          </div>
        ))}
        {s.tags.length === 0 && <p className="muted">No tags yet. Type #name in quick add.</p>}
      </div>
    </div>
  );
}
