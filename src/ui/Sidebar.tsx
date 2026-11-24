import { isOpen } from '../domain/types';
import { useDerived, useSnapshot } from './state';
import { viewKey, type View } from './views';

interface Props {
  view: View;
  onNavigate: (v: View) => void;
  open: boolean;
}

export function Sidebar({ view, onNavigate, open }: Props) {
  const s = useSnapshot();
  const d = useDerived();
  const active = viewKey(view);
  const openTasks = s.tasks.filter(isOpen);
  const countByProject = new Map<string, number>();
  for (const t of openTasks) if (t.projectId) countByProject.set(t.projectId, (countByProject.get(t.projectId) ?? 0) + 1);
  const countByTag = new Map<string, number>();
  for (const tt of s.taskTags) if (d.tasks.get(tt.taskId) && isOpen(d.tasks.get(tt.taskId)!)) countByTag.set(tt.tagId, (countByTag.get(tt.tagId) ?? 0) + 1);

  const item = (v: View, label: string, count?: number, indent = 0) => (
    <button key={viewKey(v)} className={`nav ${active === viewKey(v) ? 'active' : ''}`} style={{ paddingLeft: 10 + indent * 14 }} onClick={() => onNavigate(v)} aria-current={active === viewKey(v) ? 'page' : undefined}>
      {label}
      {count ? <span className="count">{count}</span> : null}
    </button>
  );

  return (
    <nav className={`sidebar ${open ? 'open' : ''}`} aria-label="Views">
      {item({ kind: 'focus' }, 'Focus', openTasks.filter((t) => !d.blocked.has(t.id)).length)}
      {item({ kind: 'upcoming' }, 'Upcoming')}
      {item({ kind: 'inbox' }, 'Inbox', openTasks.filter((t) => !t.projectId).length)}
      {item({ kind: 'logbook' }, 'Logbook')}
      {item({ kind: 'analytics' }, 'Analytics')}
      <div className="navhead">
        Projects
        <button className="iconbtn small" onClick={() => onNavigate({ kind: 'projects' })}>Manage</button>
      </div>
      {d.tree.flatten().filter((x) => !x.project.archivedAt).map(({ project, depth }) => item({ kind: 'project', id: project.id }, project.name, countByProject.get(project.id), depth))}
      {s.projects.length === 0 && <div className="small muted" style={{ padding: '0 10px' }}>Type @Work/Admin in quick add to create one.</div>}
      <div className="navhead">
        Tags
        <button className="iconbtn small" onClick={() => onNavigate({ kind: 'tags' })}>Manage</button>
      </div>
      {s.tags.map((t) => item({ kind: 'tag', id: t.id }, `#${t.name}`, countByTag.get(t.id)))}
      <div className="navhead">App</div>
      {item({ kind: 'search', q: '' }, 'Search')}
      {item({ kind: 'settings' }, 'Settings')}
    </nav>
  );
}
