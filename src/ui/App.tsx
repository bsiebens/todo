import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { addDays, toDateStr } from '../domain/dates';
import { fuzzyFilter } from '../domain/fuzzy';
import { isOpen, PRIORITY_LABELS, type Id, type Priority } from '../domain/types';
import { CommandPalette, type Command } from './CommandPalette';
import { FilterHeader, SaveFilter } from './FilterBar';
import { ImportDialog } from './ImportDialog';
import { THEME_PREFS, useTheme } from './theme';
import { TuningView } from './Tuning';
import { useActions } from './actions';
import { AnalyticsView } from './Analytics';
import { ContextSwitch } from './ContextSwitch';
import { Icon } from './Icon';
import { downloadExport, ProjectsView, SettingsView, TagsView } from './Manage';
import { QuickAdd, SHORTCUT as QUICK_SHORTCUT } from './QuickAdd';
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
  const { changeStatus, quickAdd, notify } = useActions();
  const { setPref } = useTheme();
  const sync = useSync();
  const syncStatus = useSyncStatus();
  const [view, setView] = useState<View>({ kind: 'focus' });
  const [selected, setSelected] = useState<Id | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [includeSub, setIncludeSub] = useState(true);
  const [palette, setPalette] = useState(false);
  const [importing, setImporting] = useState(false);
  const quickRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const isList = !['projects', 'tags', 'settings', 'analytics', 'urgency'].includes(view.kind);
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

  // Keyboard shortcuts (desktop): j/k move, x done, s start/pause, e edit title, n note, / search,
  // Ctrl/Cmd+K quick add, Ctrl/Cmd+P (or Ctrl/Cmd+Shift+P) command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(false);
        openQuickAdd();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      if (palette || importing) return;
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
  }, [flat, selected, d.tasks, changeStatus, navigate, openQuickAdd, view, palette, importing]);

  useEffect(() => {
    if (selected) document.querySelector(`[data-task="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const savedFilters = s.settings.savedFilters;
  const commands = useMemo<Command[]>(() => {
    const out: Command[] = [];
    const go = (label: string, v: Parameters<typeof navigate>[0], icon: Command['icon'], keywords?: string): Command => ({
      id: `go:${label}:${'id' in v ? v.id : v.kind}`,
      group: 'Go to',
      label,
      icon,
      keywords,
      run: () => navigate(v),
    });
    out.push(
      go('Focus', { kind: 'focus' }, 'focus', 'home next'),
      go('Upcoming', { kind: 'upcoming' }, 'upcoming', 'calendar'),
      go('Inbox', { kind: 'inbox' }, 'inbox'),
      go('Logbook', { kind: 'logbook' }, 'logbook', 'done completed history'),
      go('Analytics', { kind: 'analytics' }, 'chart', 'stats reports'),
      go('Search', { kind: 'search', q: '' }, 'search', 'find'),
      go('Urgency tuning', { kind: 'urgency' }, 'sliders', 'weights ranking presets score'),
      go('Settings', { kind: 'settings' }, 'settings', 'preferences sync'),
      go('Manage projects', { kind: 'projects' }, 'folder'),
      go('Manage tags', { kind: 'tags' }, 'tag'),
    );
    for (const f of savedFilters) out.push(go(f.name, { kind: 'filter', id: f.id }, 'filter', `filter ${f.query}`));
    for (const { project } of d.tree.flatten()) if (!project.archivedAt) out.push(go(d.tree.path(project.id), { kind: 'project', id: project.id }, 'folder', 'project'));
    for (const t of s.tags) out.push(go(`#${t.name}`, { kind: 'tag', id: t.id }, 'tag', 'tag'));

    out.push({ id: 'new', group: 'Task', label: 'New task', icon: 'plus', hint: QUICK_SHORTCUT, keywords: 'add create quick', run: () => setTimeout(openQuickAdd, 0) });
    const cur = selected ? d.tasks.get(selected) : undefined;
    if (cur && isList) {
      const T = `“${cur.title.length > 40 ? `${cur.title.slice(0, 40)}…` : cur.title}”`;
      const task = (id: string, label: string, icon: Command['icon'], run: () => unknown, hint?: string, keywords?: string): Command => ({ id: `task:${id}`, group: 'Task', label: `${label} ${T}`, icon, hint, keywords, run: () => void run() });
      if (isOpen(cur)) {
        out.push(task('done', 'Complete', 'check', () => changeStatus(cur.id, 'done'), 'X', 'done finish'));
        out.push(cur.status === 'in_progress' ? task('pause', 'Pause', 'pause', () => changeStatus(cur.id, 'todo'), 'S') : task('start', 'Start', 'play', () => changeStatus(cur.id, 'in_progress'), 'S', 'begin'));
        out.push(task('cancel', 'Cancel', 'close', () => changeStatus(cur.id, 'cancelled'), undefined, "won't do skip"));
      } else out.push(task('reopen', 'Reopen', 'repeat', () => changeStatus(cur.id, 'todo'), 'X'));
      out.push(task('focus', cur.focus ? 'Remove focus flag from' : 'Flag for today', 'star', () => store.updateTask(cur.id, { focus: !cur.focus }), undefined, 'focus star'));
      for (const p of [4, 3, 2, 1, 0] as Priority[]) if (p !== cur.priority) out.push(task(`p${p}`, `Priority ${PRIORITY_LABELS[p]}:`, 'flag', () => store.updateTask(cur.id, { priority: p }), undefined, 'priority'));
      const today = toDateStr(new Date());
      out.push(task('due0', 'Due today:', 'upcoming', () => store.updateTask(cur.id, { dueDate: today }), undefined, 'date schedule'));
      out.push(task('due1', 'Due tomorrow:', 'upcoming', () => store.updateTask(cur.id, { dueDate: addDays(today, 1) }), undefined, 'date schedule'));
      if (cur.dueDate) out.push(task('due-', 'Clear due date of', 'upcoming', () => store.updateTask(cur.id, { dueDate: null, dueTime: null }), undefined, 'date remove'));
      out.push(task('note', 'Add a note to', 'logbook', () => setTimeout(() => noteRef.current?.focus(), 0), 'N', 'comment'));
      out.push(
        task('delete', 'Delete', 'trash', async () => {
          if (confirm(`Delete "${cur.title}"?`)) await store.deleteTask(cur.id);
        }),
      );
    }

    if (view.kind === 'focus') out.push({ id: 'hidden', group: 'View', label: showHidden ? 'Hide blocked and later tasks' : 'Show blocked and later tasks', icon: 'lock', run: () => setShowHidden(!showHidden) });
    if (view.kind === 'search' && view.q.trim()) out.push({ id: 'savefilter', group: 'View', label: `Save “${view.q.trim()}” as a filter`, icon: 'filter', run: () => document.querySelector<HTMLButtonElement>('.filterbar .btn')?.click() });
    for (const [m, label] of [['auto', 'Automatic'], ['home', 'Home'], ['office', 'Office']] as const) {
      out.push({ id: `ctx:${m}`, group: 'Context', label: `Switch to ${label}`, icon: m === 'auto' ? 'clock' : m, keywords: 'where location', run: () => store.saveSettings({ contextMode: m }) });
    }
    for (const t of THEME_PREFS) out.push({ id: `theme:${t.value}`, group: 'Theme', label: `${t.label} theme`, icon: t.value === 'light' ? 'sun' : t.value === 'dark' ? 'moon' : 'system', keywords: 'appearance dark mode', run: () => setPref(t.value) });
    out.push({ id: 'import', group: 'Data', label: 'Import tasks from another app', icon: 'upload', keywords: 'todoist ticktick csv outlook', run: () => setImporting(true) });
    out.push({ id: 'export', group: 'Data', label: 'Export everything as JSON', icon: 'logbook', keywords: 'backup download', run: () => downloadExport(store) });
    return out;
  }, [navigate, savedFilters, d.tree, d.tasks, s.tags, selected, isList, view, showHidden, changeStatus, store, openQuickAdd, setPref]);

  const dynamicCommands = useCallback(
    (q: string): Command[] => {
      const open = fuzzyFilter(q, s.tasks.filter(isOpen), (t) => t.title, 8);
      return [
        ...open.map<Command>((t) => ({
          id: `open:${t.id}`,
          group: 'Open',
          label: t.title,
          icon: 'check',
          run: () => {
            if (!isList || view.kind === 'urgency') setView({ kind: 'focus' });
            setSelected(t.id);
          },
        })),
        {
          id: 'add',
          group: 'Add',
          label: q.trim(),
          icon: 'plus',
          keywords: q,
          run: async () => {
            const id = await quickAdd(q, { projectId: view.kind === 'project' ? view.id : null });
            if (id) notify('Task added');
          },
        },
        { id: 'search', group: 'Search', label: q.trim(), icon: 'search', keywords: q, run: () => navigate({ kind: 'search', q: q.trim() }) },
      ];
    },
    [s.tasks, isList, view, quickAdd, notify, navigate],
  );

  const defaultProject = view.kind === 'project' ? view.id : null;
  const showDetail = isList && !!selected;
  const ctx = d.context;

  const ctxButton = (cls: string) => <ContextSwitch className={cls} onOpenSettings={() => navigate({ kind: 'settings' })} />;

  return (
    <div className={`app ${showDetail ? 'hasdetail' : 'nodetail'}`}>
      <Sidebar view={view} onNavigate={navigate} open={drawer} onClose={() => setDrawer(false)} onPalette={() => { setDrawer(false); setPalette(true); }} />
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

        {!store.persistent && (
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
              {view.kind === 'settings' && <SettingsView onNavigate={navigate} onImport={() => setImporting(true)} />}
              {view.kind === 'urgency' && <TuningView />}
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
                  {view.kind === 'filter' && <FilterHeader id={view.id} onNavigate={navigate} />}
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
                      <SaveFilter query={view.q} onSaved={(id) => navigate({ kind: 'filter', id })} />
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
                      onOpenInbox={() => navigate({ kind: 'inbox' })}
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
          ['Browse', 'grid', ['project', 'inbox', 'tag', 'filter', 'projects', 'tags', 'logbook', 'analytics', 'urgency', 'settings'].includes(view.kind), () => setDrawer(true)],
          ['Search', 'search', view.kind === 'search', () => navigate({ kind: 'search', q: '' })],
        ] as const).map(([label, icon, on, go]) => (
          <button key={label} className={on ? 'active' : ''} aria-current={on ? 'page' : undefined} onClick={go}>
            <Icon name={icon} size={22} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {palette && <CommandPalette commands={commands} dynamic={dynamicCommands} onClose={() => setPalette(false)} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} onDone={() => { setImporting(false); navigate({ kind: 'focus' }); }} />}

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
