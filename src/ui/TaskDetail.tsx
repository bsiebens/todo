import { useEffect, useRef, useState } from 'react';
import { formatTimestamp, toDateStr } from '../domain/dates';
import { describeRule, RECURRENCE_PRESETS } from '../domain/recurrence';
import { isOpen, PRIORITY_LABELS, type Id, type Priority, type RecurrenceMode, type Task } from '../domain/types';
import { STATUS_LABELS } from '../domain/status';
import { StoreError } from '../db/store';
import { useActions } from './actions';
import { Icon } from './Icon';
import { useDerived, useSnapshot, useStore } from './state';

interface Props {
  taskId: Id;
  onSelect: (id: Id) => void;
  onClose: () => void;
  noteInputRef?: React.RefObject<HTMLTextAreaElement | null>;
  titleInputRef?: React.RefObject<HTMLInputElement | null>;
}

export function TaskDetail({ taskId, onSelect, onClose, noteInputRef, titleInputRef }: Props) {
  const store = useStore();
  const s = useSnapshot();
  const d = useDerived();
  const { changeStatus, notify } = useActions();
  const task = d.tasks.get(taskId);
  const [title, setTitle] = useState(task?.title ?? '');
  const [desc, setDesc] = useState(task?.description ?? '');
  const [tags, setTags] = useState('');
  const [note, setNote] = useState('');
  const [depError, setDepError] = useState<string | null>(null);
  const [showWhy, setShowWhy] = useState(false);

  useEffect(() => {
    if (!task) return;
    setTitle(task.title);
    setDesc(task.description);
    setTags((d.tagsByTask.get(task.id) ?? []).map((t) => t.name).join(', '));
    setDepError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, task?.updatedAt, s.taskTags]);

  if (!task) return <div className="empty">Select a task.</div>;

  const today = toDateStr(d.now);
  const open = isOpen(task);
  const blockers = d.graph.blockersOf(task.id).map((id) => d.tasks.get(id)).filter((t): t is Task => !!t);
  const dependants = d.graph.dependantsOf(task.id).map((id) => d.tasks.get(id)).filter((t): t is Task => !!t);
  const series = task.seriesId ? s.series.find((x) => x.id === task.seriesId) : undefined;
  const u = d.urgency.get(task.id);
  const notes = d.notesByTask.get(task.id) ?? [];
  const blocked = d.blocked.has(task.id);

  const update = (patch: Parameters<typeof store.updateTask>[1]) => store.updateTask(task.id, patch).catch((e) => notify(String(e)));

  const addDep = async (blockerId: Id, blockedId: Id) => {
    setDepError(null);
    try {
      await store.addDependency(blockerId, blockedId);
    } catch (e) {
      setDepError(e instanceof StoreError ? e.message : String(e));
    }
  };

  const presetValue = series ? RECURRENCE_PRESETS.findIndex((p) => p.rule === series.rrule && p.mode === series.mode) : -1;

  return (
    <div>
      <div className="detail-top">
        <button className="btn ghost backbtn" onClick={onClose}>
          <Icon name="back" size={18} /> Back
        </button>
        <span className={`status-pill s-${task.status}`}>
          {STATUS_LABELS[task.status]}
          {blocked && ' · blocked'}
        </span>
        <button
          className="iconbtn danger deletebtn"
          aria-label="Delete task"
          title="Delete task"
          onClick={async () => {
            if (confirm(`Delete "${task.title}"?`)) {
              await store.deleteTask(task.id);
              onClose();
            }
          }}
        >
          <Icon name="trash" size={18} />
        </button>
        <button className="iconbtn closebtn" aria-label="Close task" title="Close (Esc)" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <input
        ref={titleInputRef}
        className="titleinput"
        aria-label="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => title.trim() && title !== task.title && update({ title: title.trim() })}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />

      <div className="actions">
        {open && (
          <button className="btn primary" onClick={() => changeStatus(task.id, 'done')}>
            <Icon name="check" size={16} /> Done
          </button>
        )}
        {task.status === 'todo' && (
          <button className="btn" onClick={() => changeStatus(task.id, 'in_progress')}>
            <Icon name="play" size={14} /> Start
          </button>
        )}
        {task.status === 'in_progress' && (
          <button className="btn" onClick={() => changeStatus(task.id, 'todo')}>
            <Icon name="pause" size={16} /> Pause
          </button>
        )}
        {!open && <button className="btn" onClick={() => changeStatus(task.id, 'todo')}>Reopen</button>}
        <button className={`btn ${task.focus ? 'on' : ''}`} aria-pressed={task.focus} onClick={() => update({ focus: !task.focus })}>
          <Icon name="star" size={16} filled={task.focus} /> Focus
        </button>
        {open && <button className="btn" onClick={() => changeStatus(task.id, 'cancelled')}>{series ? 'Skip' : 'Cancel'}</button>}
      </div>

      <div className="card fields">
        <label htmlFor="f-pri">Priority</label>
        <select id="f-pri" value={task.priority} onChange={(e) => update({ priority: Number(e.target.value) as Priority })}>
          {([0, 1, 2, 3, 4] as Priority[]).map((p) => (
            <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>
          ))}
        </select>

        <label htmlFor="f-due">Due</label>
        <div className="inline">
          <input id="f-due" type="date" value={task.dueDate ?? ''} onChange={(e) => update({ dueDate: e.target.value || null, ...(e.target.value ? {} : { dueTime: null }) })} />
          <input type="time" aria-label="Due time" value={task.dueTime ?? ''} disabled={!task.dueDate} onChange={(e) => update({ dueTime: e.target.value || null })} />
          {task.dueDate && <button className="linkbtn" onClick={() => update({ dueDate: null, dueTime: null })}>Clear</button>}
        </div>

        <label htmlFor="f-proj">Project</label>
        <select id="f-proj" value={task.projectId ?? ''} onChange={(e) => update({ projectId: e.target.value || null })}>
          <option value="">Inbox</option>
          {d.tree.flatten().map(({ project, depth }) => (
            <option key={project.id} value={project.id}>{'  '.repeat(depth) + project.name}</option>
          ))}
        </select>

        <label htmlFor="f-tags">Tags</label>
        <input
          id="f-tags"
          placeholder="finance, waiting"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          onBlur={() => store.setTags(task.id, tags.split(',').map((x) => x.trim().replace(/^#/, '')).filter(Boolean))}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />

        <label htmlFor="f-rep">Repeats</label>
        <div>
          <select
            id="f-rep"
            value={series ? (presetValue >= 0 ? String(presetValue) : 'custom') : 'none'}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'none') store.setRecurrence(task.id, null);
              else if (v === 'custom') store.setRecurrence(task.id, { rule: series?.rrule ?? 'FREQ=WEEKLY', mode: series?.mode ?? 'schedule' });
              else store.setRecurrence(task.id, RECURRENCE_PRESETS[Number(v)]!);
            }}
          >
            <option value="none">Does not repeat</option>
            {RECURRENCE_PRESETS.map((p, i) => (
              <option key={i} value={i}>{p.label}</option>
            ))}
            <option value="custom">Custom rule…</option>
          </select>
          {series && presetValue < 0 && <CustomRule rule={series.rrule} mode={series.mode} onSave={(rule, mode) => store.setRecurrence(task.id, { rule, mode })} />}
          {series && <div className="small muted" style={{ marginTop: 4 }}>{describeRule(series.rrule, series.mode)}</div>}
        </div>

        <label htmlFor="f-start">Start after</label>
        <input id="f-start" type="date" value={task.startAfter?.slice(0, 10) ?? ''} onChange={(e) => update({ startAfter: e.target.value ? `${e.target.value}T00:00:00` : null })} />

        <label htmlFor="f-est">Estimate</label>
        <div className="inline">
          <input id="f-est" type="number" min={0} step={5} style={{ width: 90 }} value={task.estimateMin ?? ''} onChange={(e) => update({ estimateMin: e.target.value ? Number(e.target.value) : null })} />
          <span className="small muted">minutes</span>
        </div>
      </div>

      <div className="card section">
        <h3>Blocked by</h3>
        <div className="linklist">
          {blockers.map((b) => (
            <div className="linkitem" key={b.id}>
              <button className="name" onClick={() => onSelect(b.id)}>{b.title}</button>
              <span className="state badge">{isOpen(b) ? 'open' : STATUS_LABELS[b.status].toLowerCase()}</span>
              <button className="iconbtn" aria-label={`Remove ${b.title}`} onClick={() => store.removeDependency(b.id, task.id)}><Icon name="close" size={15} /></button>
            </div>
          ))}
          <TaskPicker exclude={new Set([task.id, ...blockers.map((b) => b.id)])} placeholder="Add a task this one waits on" onPick={(id) => addDep(id, task.id)} />
        </div>
        <h3 className="gap">Blocks</h3>
        <div className="linklist">
          {dependants.map((b) => (
            <div className="linkitem" key={b.id}>
              <button className="name" onClick={() => onSelect(b.id)}>{b.title}</button>
              <span className="state badge">{isOpen(b) ? 'open' : STATUS_LABELS[b.status].toLowerCase()}</span>
              <button className="iconbtn" aria-label={`Remove ${b.title}`} onClick={() => store.removeDependency(task.id, b.id)}><Icon name="close" size={15} /></button>
            </div>
          ))}
          <TaskPicker exclude={new Set([task.id, ...dependants.map((b) => b.id)])} placeholder="Add a task that waits on this one" onPick={(id) => addDep(task.id, id)} />
        </div>
        {depError && <div className="error" role="alert">{depError}</div>}
      </div>

      {u && (
        <div className="card section">
          <h3>
            Urgency {u.score.toFixed(1)} <span className={`urg ${u.band}`}>{u.band === 'now' ? 'Now' : u.band === 'soon' ? 'Soon' : 'Later'}</span>{' '}
            <button className="linkbtn push" onClick={() => setShowWhy(!showWhy)} aria-expanded={showWhy}>{showWhy ? 'Hide' : 'Why?'}</button>
          </h3>
          {showWhy && (
            <table className="breakdown">
              <tbody>
                {u.parts.map((p, i) => (
                  <tr key={i}>
                    <td>{p.factor} <span className="muted">{p.detail}</span></td>
                    <td>{p.points > 0 ? '+' : ''}{p.points.toFixed(1)}</td>
                  </tr>
                ))}
                <tr className="total"><td>Total</td><td>{u.score.toFixed(1)}</td></tr>
              </tbody>
            </table>
          )}
        </div>
      )}

      <div className="card section">
        <h3>Description</h3>
        <textarea className="desc" aria-label="Description" placeholder="Details, links, checklists (- [ ] item)" value={desc} onChange={(e) => setDesc(e.target.value)} onBlur={() => desc !== task.description && update({ description: desc })} />
      </div>

      <div className="card section">
        <h3>Notes</h3>
        <div className="noteinput">
          <textarea
            ref={noteInputRef}
            aria-label="Add a note"
            placeholder="Add a note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                store.addNote(task.id, note).then(() => setNote(''));
              }
            }}
          />
          <button className="btn" onClick={() => store.addNote(task.id, note).then(() => setNote(''))} disabled={!note.trim()}>Add</button>
        </div>
        <div className="notes">
          {notes.map((n) => (
            <div key={n.id} className={`note ${n.kind}`}>
              <div className="when">
                {formatTimestamp(n.createdAt)}
                {n.editedAt && ' · edited'}
              </div>
              <div className="text">{n.body}</div>
            </div>
          ))}
        </div>
        <div className="small muted created">Created {formatTimestamp(task.createdAt)}{task.dueDate && task.dueDate < today && open ? ' · overdue' : ''}</div>
      </div>
    </div>
  );
}

function CustomRule({ rule, mode, onSave }: { rule: string; mode: RecurrenceMode; onSave: (rule: string, mode: RecurrenceMode) => void }) {
  const [r, setR] = useState(rule);
  const [m, setM] = useState(mode);
  useEffect(() => {
    setR(rule);
    setM(mode);
  }, [rule, mode]);
  return (
    <div className="inline" style={{ marginTop: 6 }}>
      <input aria-label="iCalendar rule" value={r} onChange={(e) => setR(e.target.value.toUpperCase())} placeholder="FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2" style={{ flex: 1, minWidth: 180 }} />
      <select aria-label="Count from" value={m} onChange={(e) => setM(e.target.value as RecurrenceMode)}>
        <option value="schedule">on schedule</option>
        <option value="after_completion">after completion</option>
      </select>
      <button className="btn" onClick={() => onSave(r, m)}>Save</button>
    </div>
  );
}

/** Search-to-add an open task. */
function TaskPicker({ exclude, placeholder, onPick }: { exclude: Set<Id>; placeholder: string; onPick: (id: Id) => void }) {
  const s = useSnapshot();
  const [q, setQ] = useState('');
  const [hl, setHl] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  const matches = q.trim()
    ? s.tasks.filter((t) => isOpen(t) && !exclude.has(t.id) && t.title.toLowerCase().includes(q.toLowerCase())).slice(0, 8)
    : [];
  const pick = (id: Id) => {
    onPick(id);
    setQ('');
  };
  return (
    <div className="rel">
      <input
        ref={ref}
        value={q}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => {
          setQ(e.target.value);
          setHl(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setHl((h) => Math.min(h + 1, matches.length - 1));
          if (e.key === 'ArrowUp') setHl((h) => Math.max(h - 1, 0));
          if (e.key === 'Enter' && matches[hl]) pick(matches[hl]!.id);
          if (e.key === 'Escape') setQ('');
        }}
        style={{ width: '100%' }}
      />
      {matches.length > 0 && (
        <div className="suggest" role="listbox">
          {matches.map((t, i) => (
            <button key={t.id} className={i === hl ? 'hl' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(t.id)} role="option" aria-selected={i === hl}>
              {t.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
