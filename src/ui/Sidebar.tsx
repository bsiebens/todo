import { isOpen } from '../domain/types';
import { Icon, type IconName } from './Icon';
import { useDerived, useSnapshot, useSyncStatus } from './state';
import { ago } from './SyncSettings';
import { ThemeSwitch } from './ThemeSwitch';
import { viewKey, type View } from './views';

interface Props {
  view: View;
  onNavigate: (v: View) => void;
  open: boolean;
  onClose: () => void;
}

export function Sidebar({ view, onNavigate, open, onClose }: Props) {
  const s = useSnapshot();
  const d = useDerived();
  const active = viewKey(view);
  const sync = useSyncStatus();
  const openTasks = s.tasks.filter(isOpen);
  const countByProject = new Map<string, number>();
  for (const t of openTasks) if (t.projectId) countByProject.set(t.projectId, (countByProject.get(t.projectId) ?? 0) + 1);
  const countByTag = new Map<string, number>();
  for (const tt of s.taskTags) if (d.tasks.get(tt.taskId) && isOpen(d.tasks.get(tt.taskId)!)) countByTag.set(tt.tagId, (countByTag.get(tt.tagId) ?? 0) + 1);

  const item = (v: View, label: string, icon: IconName, count?: number, indent = 0) => {
    const on = active === viewKey(v);
    return (
      <button key={viewKey(v)} className={`nav ${on ? 'active' : ''}`} style={indent ? { paddingLeft: 10 + indent * 16 } : undefined} onClick={() => onNavigate(v)} aria-current={on ? 'page' : undefined}>
        <Icon name={icon} size={17} />
        <span className="label">{label}</span>
        {count ? <span className="count">{count}</span> : null}
      </button>
    );
  };

  return (
    <nav className={`sidebar ${open ? 'open' : ''}`} aria-label="Views">
      <div className="brand">
        <img src="/icon.svg" alt="" width={26} height={26} />
        <span>ToDo</span>
        <button className="iconbtn drawer-close" aria-label="Close menu" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="navscroll">
        {item({ kind: 'focus' }, 'Focus', 'focus', openTasks.filter((t) => !d.blocked.has(t.id)).length)}
        {item({ kind: 'upcoming' }, 'Upcoming', 'upcoming')}
        {item({ kind: 'inbox' }, 'Inbox', 'inbox', openTasks.filter((t) => !t.projectId).length)}
        {item({ kind: 'logbook' }, 'Logbook', 'logbook')}
        {item({ kind: 'analytics' }, 'Analytics', 'chart')}
        <div className="navhead">
          <span>Projects</span>
          <button className="linkbtn" onClick={() => onNavigate({ kind: 'projects' })}>Manage</button>
        </div>
        {d.tree.flatten().filter((x) => !x.project.archivedAt).map(({ project, depth }) => item({ kind: 'project', id: project.id }, project.name, 'folder', countByProject.get(project.id), depth))}
        {s.projects.length === 0 && <div className="navhint">Type @Work/Admin in quick add to create one.</div>}
        <div className="navhead">
          <span>Tags</span>
          <button className="linkbtn" onClick={() => onNavigate({ kind: 'tags' })}>Manage</button>
        </div>
        {s.tags.map((t) => item({ kind: 'tag', id: t.id }, t.name, 'tag', countByTag.get(t.id)))}
        {s.tags.length === 0 && <div className="navhint">Type #name in quick add to tag a task.</div>}
      </div>
      <div className="sidefoot">
        {item({ kind: 'search', q: '' }, 'Search', 'search')}
        {item({ kind: 'settings' }, 'Settings', 'settings')}
        <button className="syncline nav" onClick={() => onNavigate({ kind: 'settings' })} title="Sync status">
          <span className={`syncdot s-${sync.state}`} aria-hidden="true" />
          <span className="small muted">
            {sync.state === 'signed_out'
              ? 'Not syncing'
              : sync.state === 'syncing'
                ? 'Syncing…'
                : sync.state === 'offline'
                  ? 'Offline'
                  : sync.state === 'error'
                    ? 'Sync problem'
                    : `Synced ${ago(sync.lastSync)}`}
          </span>
        </button>
        <ThemeSwitch compact />
      </div>
    </nav>
  );
}
