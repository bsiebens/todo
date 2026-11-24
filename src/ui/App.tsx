import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isOpen, type Id } from '../domain/types';
import { useActions } from './actions';
import { AnalyticsView } from './Analytics';
import { ContextSwitch } from './ContextSwitch';
import { Icon } from './Icon';
import { ProjectsView, SettingsView, TagsView } from './Manage';
import { QuickAdd } from './QuickAdd';
import { Sidebar } from './Sidebar';
import { TaskDetail } from './TaskDetail';
import { TaskList } from './TaskList';
import { useDerived, useSnapshot, useStore, useSync, useSyncStatus } from './state';
import { selectView, type View } from './views';

const isPhone = () => window.matchMedia('(max-width: 719px)').matches;

export function App() {
  const store = useStore();
  const s = useSnapshot();
  const d = useDerived();
  const { changeStatus } = useActions();
  const sync = useSync();
  const syncStatus = useSyncStatus();
  // A sign-in link from the email (#signin=CODE) opens Settings with the code filled in.
  const [linkCode] = useState(() => {
    const m = /^#signin=([A-Za-z0-9-]+)$/.exec(location.hash);
    if (m) history.replaceState(null, '', location.pathname + location.search);
    return m?.[1] ?? null;
  });
  const [view, setView] = useState<View>(() => (linkCode ? { kind: 'settings' } : { kind: 'focus' }));
  const [selected, setSelected] = useState<Id | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [includeSub, setIncludeSub] = useState(true);
  const quickRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const isList = !['projects', 'tags', 'settings', 'analytics'].includes(view.kind);
  const result = useMemo(() => (isList ? selectView(view, s, d, { showHidden, includeSub }) : null), [view, s, d, showHidden, includeSub, isList]);
  const flat = useMemo(() => result?.sections.flatMap((x) => x.tasks) ?? [], [result]);

  // A reminder notification opens its task (#task=ID).
  useEffect(() => {
    const open = (hash: string) => {
      const m = /^#task=([A-Za-z0-9-]+)$/.exec(hash);
      if (!m) return;
      setView({ kind: 'focus' });
      setSelected(m[1]!);
      history.replaceState(null, '', location.pathname + location.search);
    };
    open(location.hash);
    const onHash = () => open(location.hash);
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'open' && typeof e.data.hash === 'string') open(e.data.hash);
    };
    window.addEventListener('hashchange', onHash);
    navigator.serviceWorker?.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('hashchange', onHash);
      navigator.serviceWorker?.removeEventListener('message', onMessage);
    };
  }, []);

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

  const ctxButton = (cls: string) => <ContextSwitch className={cls} onOpenSettings={() => navigate({ kind: 'settings' })} />;

  return (
    <div className={`app ${showDetail ? 'hasdetail' : 'nodetail'}`}>
      <Sidebar view={view} onNavigate={navigate} open={drawer} onClose={() => setDrawer(false)} />
      {drawer && <div className="drawer-bg" onClick={() => setDrawer(false)} />}

      <div className="workspace">
        <header className="topbar">
          <button className="iconbtn menu" aria-label="Open menu" onClick={() => setDrawer(true)}>
            <Icon name="menu" size={20} />
          </button>
          <QuickAdd ref={quickRef} defaultProjectId={defaultProject} onCreated={(id) => !isPhone() && setSelected(id)} />
          {ctxButton('')}
          <button className="iconbtn searchbtn" aria-label="Search" title="Search (/)" onClick={() => navigate({ kind: 'search', q: '' })}>
            <Icon name="search" size={19} />
          </button>
        </header>

        {store.storage !== 'OPFS' && (
          <div role="alert" className="banner">
            Offline storage is not available here (is the app already open in another tab?). Changes in this window are not saved.
          </div>
        )}
        {syncStatus.notices.length > 0 && (
          <div role="alert" className="banner notice">
            <span>{[...new Set(syncStatus.notices)].join(' ')}</span>
            <button className="linkbtn" onClick={() => sync.dismissNotices()}>Dismiss</button>
          </div>
        )}
        <div className="main">
          <main className="list">
            <div className="list-inner">
              {view.kind === 'settings' && <SettingsView initialCode={linkCode} />}
              {view.kind === 'analytics' && <AnalyticsView onNavigate={navigate} />}
              {view.kind === 'projects' && <ProjectsView onOpen={(id) => navigate({ kind: 'project', id })} />}
              {view.kind === 'tags' && <TagsView onOpen={(id) => navigate({ kind: 'tag', id })} />}
              {result && (
                <>
                  <div className="viewhead">
                    <h1>{result.title}</h1>
                    {view.kind === 'focus' && <span className="muted viewsub">{ctx === 'office' ? 'at the office' : 'at home'}</span>}
                    {view.kind === 'project' && d.tree.descendantIds(view.id).size > 0 && (
                      <label className="toggle small muted">
                        <input type="checkbox" checked={includeSub} onChange={(e) => setIncludeSub(e.target.checked)} /> include sub-projects
                      </label>
                    )}
                    {ctxButton('phone-only')}
                  </div>
                  {view.kind === 'search' && (
                    <>
                      <div className="searchbox">
                        <Icon name="search" />
                        <input
                          ref={searchRef}
                          type="search"
                          aria-label="Search"
                          placeholder="Words, #tag, project:Work, due<7d, !high, status:done"
                          value={view.q}
                          onChange={(e) => setView({ kind: 'search', q: e.target.value })}
                        />
                      </div>
                      {!view.q && <p className="small muted hint">Filters: #tag · project:Work/Clients · due&lt;7d · due:today · due:overdue · !high · status:done or status:all</p>}
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
                    <div className="empty welcome">
                      <p><strong>No tasks yet.</strong> Tap + or type in the box at the top, for example:</p>
                      <code>Submit expense report tomorrow 17:00 !high #finance @Work/Admin</code>
                    </div>
                  )}
                </>
              )}
            </div>
          </main>

          {showDetail && (
            <aside className="detail" aria-label="Task detail">
              <TaskDetail taskId={selected!} onSelect={setSelected} onClose={() => setSelected(null)} noteInputRef={noteRef} titleInputRef={titleRef} />
            </aside>
          )}
        </div>
      </div>

      <button className="fab" aria-label="Add task" onClick={() => setSheet(true)}>
        <Icon name="plus" size={26} />
      </button>

      <nav className="tabbar" aria-label="Main">
        {([
          ['Focus', 'focus', view.kind === 'focus', () => navigate({ kind: 'focus' })],
          ['Upcoming', 'upcoming', view.kind === 'upcoming', () => navigate({ kind: 'upcoming' })],
          ['Browse', 'grid', ['project', 'inbox', 'tag', 'projects', 'tags', 'logbook', 'analytics', 'settings'].includes(view.kind), () => setDrawer(true)],
          ['Search', 'search', view.kind === 'search', () => navigate({ kind: 'search', q: '' })],
        ] as const).map(([label, icon, on, go]) => (
          <button key={label} className={on ? 'active' : ''} aria-current={on ? 'page' : undefined} onClick={go}>
            <Icon name={icon} size={22} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {sheet && (
        <div className="sheet-bg" onClick={() => setSheet(false)}>
          <div className="sheet" role="dialog" aria-label="Quick add" onClick={(e) => e.stopPropagation()}>
            <div className="grabber" aria-hidden="true" />
            <div className="sheet-title">New task</div>
            <QuickAdd autoFocus defaultProjectId={defaultProject} onCreated={() => setSheet(false)} />
            <p className="small muted">Try: tomorrow 17:00 · !high · #tag · @Work/Admin · every month · ~15m</p>
          </div>
        </div>
      )}
    </div>
  );
}
