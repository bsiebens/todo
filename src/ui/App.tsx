import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isOpen, type Id } from '../domain/types';
import { useActions } from './actions';
import { ProjectsView, SettingsView, TagsView } from './Manage';
import { QuickAdd } from './QuickAdd';
import { Sidebar } from './Sidebar';
import { TaskDetail } from './TaskDetail';
import { TaskList } from './TaskList';
import { useDerived, useSnapshot, useStore } from './state';
import { selectView, type View } from './views';

const isPhone = () => window.matchMedia('(max-width: 719px)').matches;

export function App() {
  const store = useStore();
  const s = useSnapshot();
  const d = useDerived();
  const { changeStatus } = useActions();
  const [view, setView] = useState<View>({ kind: 'focus' });
  const [selected, setSelected] = useState<Id | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [includeSub, setIncludeSub] = useState(true);
  const quickRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const isList = !['projects', 'tags', 'settings'].includes(view.kind);
  const result = useMemo(() => (isList ? selectView(view, s, d, { showHidden, includeSub }) : null), [view, s, d, showHidden, includeSub, isList]);
  const flat = useMemo(() => result?.sections.flatMap((x) => x.tasks) ?? [], [result]);

  // Drop the selection if the task disappears (deleted).
  useEffect(() => {
    if (selected && !d.tasks.has(selected)) setSelected(null);
  }, [selected, d.tasks]);

  const navigate = useCallback((v: View) => {
    setView(v);
    setDrawer(false);
    if (isPhone()) setSelected(null);
    if (v.kind === 'search') setTimeout(() => searchRef.current?.focus(), 0);
  }, []);

  const openQuickAdd = useCallback(() => {
    if (isPhone()) setSheet(true);
    else quickRef.current?.focus();
  }, []);

  // Keyboard shortcuts (desktop): j/k move, x done, s start/pause, e edit title, n note, / search, Ctrl/Cmd+K quick add.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openQuickAdd();
        return;
      }
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.ctrlKey || e.metaKey || e.altKey) return;
      const idx = selected ? flat.findIndex((t) => t.id === selected) : -1;
      const cur = selected ? d.tasks.get(selected) : undefined;
      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          if (flat.length) setSelected(flat[Math.min(idx + 1, flat.length - 1)]!.id);
          break;
        case 'k':
        case 'ArrowUp':
          if (flat.length) setSelected(flat[Math.max(idx - 1, 0)]!.id);
          break;
        case 'x':
          if (cur) changeStatus(cur.id, isOpen(cur) ? 'done' : 'todo');
          break;
        case 's':
          if (cur && isOpen(cur)) changeStatus(cur.id, cur.status === 'in_progress' ? 'todo' : 'in_progress');
          break;
        case 'e':
          titleRef.current?.focus();
          break;
        case 'n':
          e.preventDefault();
          noteRef.current?.focus();
          break;
        case '/':
          e.preventDefault();
          navigate({ kind: 'search', q: view.kind === 'search' ? view.q : '' });
          break;
        case 'Escape':
          setSelected(null);
          break;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flat, selected, d.tasks, changeStatus, navigate, openQuickAdd, view]);

  useEffect(() => {
    if (selected) document.querySelector(`[data-task="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const defaultProject = view.kind === 'project' ? view.id : null;
  const showDetail = isList && !!selected;
  const ctx = d.context;

  return (
    <div className="app">
      <header className="topbar">
        <button className="btn menu" aria-label="Open menu" onClick={() => setDrawer(true)}>☰</button>
        <QuickAdd ref={quickRef} defaultProjectId={defaultProject} onCreated={(id) => !isPhone() && setSelected(id)} />
        <span className="ctxwrap">
          <button
            className="ctx"
            title="Current context. Click to switch."
            onClick={() => store.saveSettings({ contextMode: s.settings.contextMode === 'auto' ? (ctx === 'office' ? 'home' : 'office') : 'auto' })}
          >
            {ctx === 'office' ? 'Office' : 'Home'}
            {s.settings.contextMode === 'auto' ? '' : ' (fixed)'}
          </button>
        </span>
        <button className="btn searchbtn" onClick={() => navigate({ kind: 'search', q: '' })}>Search</button>
      </header>

      {store.storage !== 'OPFS' && (
        <div role="alert" style={{ background: 'var(--soon-soft)', padding: '6px 12px', fontSize: 13, borderBottom: '1px solid var(--soon)' }}>
          Offline storage is not available here (is the app already open in another tab?). Changes in this window are not saved.
        </div>
      )}
      <div className={`main ${showDetail ? 'hasdetail' : 'nodetail'}`}>
        <Sidebar view={view} onNavigate={navigate} open={drawer} />
        {drawer && <div className="drawer-bg" onClick={() => setDrawer(false)} />}

        <main className="list">
          {view.kind === 'settings' && <SettingsView />}
          {view.kind === 'projects' && <ProjectsView onOpen={(id) => navigate({ kind: 'project', id })} />}
          {view.kind === 'tags' && <TagsView onOpen={(id) => navigate({ kind: 'tag', id })} />}
          {result && (
            <>
              <h1>
                {result.title}
                {view.kind === 'focus' && <span className="small muted" style={{ fontWeight: 400 }}>{ctx === 'office' ? 'at the office' : 'at home'}</span>}
                {view.kind === 'project' && d.tree.descendantIds(view.id).size > 0 && (
                  <label className="small muted" style={{ fontWeight: 400 }}>
                    <input type="checkbox" style={{ minHeight: 0 }} checked={includeSub} onChange={(e) => setIncludeSub(e.target.checked)} /> include sub-projects
                  </label>
                )}
              </h1>
              {view.kind === 'search' && (
                <>
                  <input
                    ref={searchRef}
                    style={{ width: '100%', marginBottom: 6 }}
                    aria-label="Search"
                    placeholder="Search: words, #tag, project:Work, due<7d, !high, status:done"
                    value={view.q}
                    onChange={(e) => setView({ kind: 'search', q: e.target.value })}
                  />
                  {!view.q && <p className="small muted">Filters: #tag · project:Work/Clients · due&lt;7d · due:today · due:overdue · !high · status:done or status:all</p>}
                </>
              )}
              {(view.kind !== 'search' || view.q) && (
                <TaskList
                  hasAnyTasks={s.tasks.length > 0}
                  result={result}
                  selected={selected}
                  onSelect={setSelected}
                  showProject={view.kind !== 'project'}
                  showHidden={showHidden}
                  onToggleHidden={() => setShowHidden(!showHidden)}
                />
              )}
              {s.tasks.length === 0 && view.kind === 'focus' && (
                <div className="empty">
                  <p>No tasks yet. Tap + or type in the box at the top, for example:</p>
                  <p><code>Submit expense report tomorrow 17:00 !high #finance @Work/Admin</code></p>
                </div>
              )}
            </>
          )}
        </main>

        {showDetail && (
          <aside className="detail" aria-label="Task detail">
            <TaskDetail taskId={selected!} onSelect={setSelected} onClose={() => setSelected(null)} noteInputRef={noteRef} titleInputRef={titleRef} />
          </aside>
        )}
      </div>

      <button className="fab" aria-label="Add task" onClick={() => setSheet(true)}>+</button>

      <nav className="tabbar" aria-label="Main">
        <button className={view.kind === 'focus' ? 'active' : ''} onClick={() => navigate({ kind: 'focus' })}>Focus</button>
        <button className={view.kind === 'upcoming' ? 'active' : ''} onClick={() => navigate({ kind: 'upcoming' })}>Upcoming</button>
        <button className={['project', 'inbox', 'tag', 'projects', 'tags', 'logbook', 'settings'].includes(view.kind) ? 'active' : ''} onClick={() => setDrawer(true)}>Browse</button>
        <button className={view.kind === 'search' ? 'active' : ''} onClick={() => navigate({ kind: 'search', q: '' })}>Search</button>
      </nav>

      {sheet && (
        <div className="sheet-bg" onClick={() => setSheet(false)}>
          <div className="sheet" role="dialog" aria-label="Quick add" onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Quick add</div>
            <QuickAdd autoFocus defaultProjectId={defaultProject} onCreated={() => setSheet(false)} />
            <p className="small muted">Try: tomorrow 17:00 · !high · #tag · @Work/Admin · every month · ~15m</p>
          </div>
        </div>
      )}
    </div>
  );
}
