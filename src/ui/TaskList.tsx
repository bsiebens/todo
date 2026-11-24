import { useRef } from 'react';
import { formatDue, toDateStr } from '../domain/dates';
import { isOpen, type Id, type Task } from '../domain/types';
import { useActions } from './actions';
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
}

export function TaskList({ result, selected, onSelect, showProject, onToggleHidden, showHidden, hasAnyTasks = true }: Props) {
  const total = result.sections.reduce((a, s) => a + s.tasks.length, 0);
  return (
    <>
      {result.sections.map((sec, i) => (
        <section key={i} aria-label={sec.title ?? result.title}>
          {sec.title && <div className="sechead">{sec.title}</div>}
          {sec.tasks.map((t) => (
            <Row key={t.id} task={t} selected={selected === t.id} onSelect={onSelect} showProject={showProject} />
          ))}
          {sec.tasks.length === 0 && sec.title === 'Next up' && hasAnyTasks && <div className="empty">Nothing to do right now.</div>}
        </section>
      ))}
      {total === 0 && !result.hidden && <div className="empty">No tasks here.</div>}
      {result.hidden && (result.hidden.blocked > 0 || result.hidden.later > 0) && (
        <button className="hiddenlink" onClick={onToggleHidden}>
          {showHidden ? 'Hide blocked and later' : `${result.hidden.blocked} blocked, ${result.hidden.later} later: show`}
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

  const sub: React.ReactNode[] = [];
  if (task.status === 'in_progress') sub.push('Started');
  if (blocked) sub.push(`Blocked by ${d.graph.openBlockers(task.id, d.tasks).map((b) => b.title).join(', ')}`);
  if (task.dueDate) sub.push(<span key="due" className={isOpen(task) && task.dueDate < today ? 'overdue' : undefined}>{formatDue(task.dueDate, task.dueTime, today)}</span>);
  if (showProject && task.projectId) sub.push(d.tree.path(task.projectId));
  if (downstream) sub.push(`Blocks ${downstream}`);
  if (task.seriesId) sub.push('Repeats');
  if (task.estimateMin) sub.push(`${task.estimateMin} min`);
  if (tags.length) sub.push(tags.map((g) => `#${g.name}`).join(' '));
  if (!isOpen(task) && task.completedAt) sub.unshift(task.status === 'cancelled' ? 'Cancelled' : 'Done');

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
      className={`row ${selected ? 'selected' : ''} ${isOpen(task) ? '' : 'closed'}`}
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
      <button className={`check ${checkClass}`} onClick={toggle} aria-label={isOpen(task) ? (blocked ? 'Blocked. Complete anyway' : 'Mark done') : 'Reopen'} title={blocked ? 'Blocked' : undefined}>
        {!isOpen(task) ? '✓' : blocked ? '🔒' : ''}
      </button>
      <div className="body">
        <div className="title" style={{ fontWeight: task.focus ? 600 : undefined }}>
          {task.focus ? '★ ' : ''}
          {task.title}
        </div>
        {sub.length > 0 && (
          <div className="sub">
            {sub.map((x, i) => (
              <span key={i}>
                {i > 0 && ' · '}
                {x}
              </span>
            ))}
          </div>
        )}
      </div>
      {u && <span className={`urg ${u.band}`} title={`Urgency ${u.score}`}>{u.score.toFixed(1)}</span>}
    </div>
  );
}
