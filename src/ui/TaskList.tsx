import { useRef } from 'react';
import { formatDue, toDateStr } from '../domain/dates';
import { isOpen, PRIORITY_LABELS, type Id, type Task } from '../domain/types';
import { useActions } from './actions';
import { Icon } from './Icon';
import { useDerived } from './state';
import type { ViewResult } from './views';

interface Props {
  result: ViewResult;
  selected: Id | null;
  onSelect: (id: Id) => void;
  showProject: boolean;
  onToggleHidden?: () => void;
  showHidden?: boolean;
  hasAnyTasks?: boolean;
  onOpenInbox?: () => void;
}

export function TaskList({ result, selected, onSelect, showProject, onToggleHidden, showHidden, hasAnyTasks = true, onOpenInbox }: Props) {
  const total = result.sections.reduce((a, s) => a + s.tasks.length, 0);
  return (
    <>
      {result.sections.map((sec, i) => (
        <section key={i} aria-label={sec.title ?? result.title}>
          {sec.title && (
            <div className="sechead">
              {sec.title}
              <span className="seccount">{sec.tasks.length}</span>
            </div>
          )}
          {sec.tasks.length > 0 && (
            <div className="rows">
              {sec.tasks.map((t) => (
                <Row key={t.id} task={t} selected={selected === t.id} onSelect={onSelect} showProject={showProject} />
              ))}
            </div>
          )}
          {sec.tasks.length === 0 && sec.title === 'Next up' && hasAnyTasks && <div className="empty">Nothing to do right now.</div>}
        </section>
      ))}
      {total === 0 && !result.hidden && <div className="empty">No tasks here.</div>}
      {result.hidden && (result.hidden.blocked > 0 || result.hidden.later > 0) && (
        <button className="hiddenlink" onClick={onToggleHidden}>
          {showHidden ? 'Hide blocked and later' : `${result.hidden.blocked} blocked, ${result.hidden.later} later: show`}
        </button>
      )}
      {result.hidden && result.hidden.inbox > 0 && onOpenInbox && (
        <button className="hiddenlink" onClick={onOpenInbox}>
          {result.hidden.inbox} new in the Inbox to sort: open
        </button>
      )}
    </>
  );
}

function Row({ task, selected, onSelect, showProject }: { task: Task; selected: boolean; onSelect: (id: Id) => void; showProject: boolean }) {
  const d = useDerived();
  const { changeStatus } = useActions();
  const u = d.urgency.get(task.id);
  const blocked = d.blocked.has(task.id);
  const today = toDateStr(d.now);
  const tags = d.tagsByTask.get(task.id) ?? [];
  const downstream = isOpen(task) ? d.graph.openDownstream(task.id, d.tasks).length : 0;
  const ref = useRef<HTMLDivElement>(null);
  const swipe = useRef<{ x: number; y: number; dx: number } | null>(null);

  const overdue = isOpen(task) && !!task.dueDate && task.dueDate < today;
  const dueToday = isOpen(task) && task.dueDate === today;
  const meta: React.ReactNode[] = [];
  if (!isOpen(task) && task.completedAt) meta.push(<span key="st" className="badge">{task.status === 'cancelled' ? 'Cancelled' : 'Done'}</span>);
  if (task.status === 'in_progress') meta.push(<span key="st" className="badge accent"><Icon name="play" size={10} />Started</span>);
  if (task.priority > 0 && isOpen(task)) meta.push(<span key="pr" className={`prio p${task.priority}`}><Icon name="flag" size={12} />{PRIORITY_LABELS[task.priority]}</span>);
  if (blocked) meta.push(<span key="bl" className="meta warn"><Icon name="lock" size={13} />Blocked by {d.graph.openBlockers(task.id, d.tasks).map((b) => b.title).join(', ')}</span>);
  if (task.dueDate) meta.push(<span key="due" className={`meta ${overdue ? 'overdue' : dueToday ? 'today' : ''}`}><Icon name="upcoming" size={13} />{formatDue(task.dueDate, task.dueTime, today)}</span>);
  if (showProject && task.projectId) meta.push(<span key="pj" className="meta"><Icon name="folder" size={13} />{d.tree.path(task.projectId)}</span>);
  if (downstream) meta.push(<span key="ds" className="meta"><Icon name="link" size={13} />Blocks {downstream}</span>);
  if (task.seriesId) meta.push(<span key="rp" className="meta"><Icon name="repeat" size={13} />Repeats</span>);
  if (task.estimateMin) meta.push(<span key="es" className="meta"><Icon name="clock" size={13} />{task.estimateMin} min</span>);
  for (const g of tags) meta.push(<span key={`t-${g.id}`} className="tagpill">#{g.name}</span>);

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    changeStatus(task.id, isOpen(task) ? 'done' : 'todo');
  };

  // Swipe right: done. Swipe left: start or pause.
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    swipe.current = { x: e.clientX, y: e.clientY, dx: 0 };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!swipe.current) return;
    const dx = e.clientX - swipe.current.x;
    if (Math.abs(e.clientY - swipe.current.y) > 24 && Math.abs(dx) < 24) {
      swipe.current = null;
      if (ref.current) ref.current.style.transform = '';
      return;
    }
    swipe.current.dx = dx;
    if (ref.current) ref.current.style.transform = `translateX(${Math.max(-120, Math.min(120, dx))}px)`;
  };
  const onPointerUp = () => {
    const s = swipe.current;
    swipe.current = null;
    if (ref.current) ref.current.style.transform = '';
    if (!s || !isOpen(task)) return;
    if (s.dx > 90) changeStatus(task.id, 'done');
    else if (s.dx < -90) changeStatus(task.id, task.status === 'in_progress' ? 'todo' : 'in_progress');
  };

  const checkClass = !isOpen(task) ? 'done' : blocked ? 'locked' : task.status === 'in_progress' ? 'progress' : '';
  return (
    <div
      ref={ref}
      className={`row pr${isOpen(task) ? task.priority : 0} ${selected ? 'selected' : ''} ${isOpen(task) ? '' : 'closed'}`}
      onClick={() => onSelect(task.id)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      data-task={task.id}
      role="button"
      tabIndex={-1}
      aria-selected={selected}
    >
      <button className={`check ${checkClass} p${task.priority}`} onClick={toggle} aria-label={isOpen(task) ? (blocked ? 'Blocked. Complete anyway' : 'Mark done') : 'Reopen'} title={blocked ? 'Blocked' : undefined}>
        {!isOpen(task) ? <Icon name="check" size={14} /> : blocked ? <Icon name="lock" size={12} /> : null}
      </button>
      <div className="body">
        <div className={`title ${task.focus ? 'focus' : ''}`}>
          {task.focus && <Icon name="star" size={14} filled className="staricon" />}
          {task.title}
        </div>
        {meta.length > 0 && <div className="sub">{meta}</div>}
      </div>
      {u && <span className={`urg ${u.band}`} title={`Urgency ${u.score.toFixed(1)} (${u.band})`}>{u.score.toFixed(1)}</span>}
    </div>
  );
}
