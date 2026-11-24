import { useMemo, useState } from 'react';
import { isOpen, type Id } from '../domain/types';
import { DEFAULT_WEIGHTS, PRESETS, type UrgencyWeights } from '../domain/urgency';
import { Icon } from './Icon';
import { byUrgency, computeDerived, useNow, useSnapshot, useStore } from './state';

interface Field {
  key: keyof UrgencyWeights;
  label: string;
  help: string;
  min: number;
  max: number;
  step: number;
}

const GROUPS: { title: string; fields: Field[] }[] = [
  {
    title: 'What pushes a task up',
    fields: [
      { key: 'due', label: 'Due soon', help: 'Points at the due moment; grows as the date gets closer, and keeps growing for a week once overdue.', min: 0, max: 30, step: 0.5 },
      { key: 'dueHalfLifeDays', label: 'Due curve (days)', help: 'A task due this many days away gets half the due-soon points. Larger starts pushing earlier.', min: 0.5, max: 14, step: 0.5 },
      { key: 'priority', label: 'Priority', help: 'Points for Critical; High gets ¾, Medium ½, Low ¼.', min: 0, max: 20, step: 0.5 },
      { key: 'focus', label: 'Focus flag', help: 'Tasks you flagged for today.', min: 0, max: 40, step: 1 },
      { key: 'inProgress', label: 'In progress', help: 'Tasks you already started.', min: 0, max: 20, step: 0.5 },
      { key: 'blocking', label: 'Blocking others', help: 'Points when four or more open tasks wait on this one, less for fewer.', min: 0, max: 20, step: 0.5 },
      { key: 'context', label: 'Context match', help: 'Added when the project fits where you are now (home or office), taken off when it does not.', min: 0, max: 10, step: 0.5 },
      { key: 'age', label: 'Age', help: 'Old tasks slowly rise so nothing is forgotten.', min: 0, max: 10, step: 0.5 },
      { key: 'ageFullDays', label: 'Age reaches full after (days)', help: 'How long until a task gets all the age points.', min: 7, max: 365, step: 1 },
      { key: 'quickWin', label: 'Quick win', help: 'Tasks with a short time estimate.', min: 0, max: 10, step: 0.5 },
      { key: 'quickWinMaxMin', label: 'Quick win up to (min)', help: 'The longest estimate that still counts as a quick win.', min: 5, max: 120, step: 5 },
      { key: 'recentActivity', label: 'Recent activity', help: 'You wrote a note on it in the last 48 hours.', min: 0, max: 10, step: 0.5 },
    ],
  },
  {
    title: 'What holds a task back',
    fields: [
      { key: 'blocked', label: 'Blocked', help: 'Waiting on another open task.', min: -30, max: 0, step: 0.5 },
      { key: 'notStartable', label: 'Not yet startable', help: 'Has a start date in the future.', min: -40, max: 0, step: 1 },
    ],
  },
  {
    title: 'Bands',
    fields: [
      { key: 'bandNow', label: 'Now from', help: 'Score at which a task shows the blue Now badge.', min: 0, max: 40, step: 0.5 },
      { key: 'bandSoon', label: 'Soon from', help: 'Score at which a task shows the orange Soon badge.', min: 0, max: 40, step: 0.5 },
    ],
  },
];

const same = (a: UrgencyWeights, b: UrgencyWeights) => (Object.keys(DEFAULT_WEIGHTS) as (keyof UrgencyWeights)[]).every((k) => a[k] === b[k]);
const presetWeights = (name: string): UrgencyWeights => ({ ...DEFAULT_WEIGHTS, ...PRESETS[name] });
export const presetName = (w: UrgencyWeights) => Object.keys(PRESETS).find((n) => same(w, presetWeights(n))) ?? null;

/** Urgency tuning: presets, every weight with an explanation, and a live preview of how the top of the list moves. */
export function TuningView() {
  const store = useStore();
  const s = useSnapshot();
  const now = useNow();
  const saved = s.settings.weights;
  const [draft, setDraft] = useState<UrgencyWeights>(saved);
  const [open, setOpen] = useState<Id | null>(null);
  const dirty = !same(draft, saved);
  const active = presetName(draft);

  const { rows, total } = useMemo(() => {
    const openTasks = s.tasks.filter(isOpen);
    const before = computeDerived(s, now, saved);
    const after = computeDerived(s, now, draft);
    const oldRank = new Map([...openTasks].sort(byUrgency(before)).map((t, i) => [t.id, i]));
    const ranked = [...openTasks].sort(byUrgency(after));
    return {
      total: ranked.length,
      rows: ranked.slice(0, 15).map((t, i) => ({ t, u: after.urgency.get(t.id)!, move: (oldRank.get(t.id) ?? i) - i, was: before.urgency.get(t.id)!.score })),
    };
  }, [s, now, saved, draft]);

  const set = (k: keyof UrgencyWeights, v: number) => setDraft({ ...draft, [k]: v });

  return (
    <div className="settings tuning">
      <div className="viewhead">
        <h1>Urgency tuning</h1>
      </div>
      <p className="card-help">
        Every open task gets a score from the factors below; Focus and every list sort by it. Pick a preset or move the sliders, and the preview shows how
        your list would change before you save. Tag and project weights are set under Tags and Projects.
      </p>

      <div className="presets" role="radiogroup" aria-label="Preset">
        {Object.keys(PRESETS).map((name) => (
          <button key={name} role="radio" aria-checked={active === name} className={`btn ${active === name ? 'on' : ''}`} onClick={() => setDraft(presetWeights(name))}>
            {name}
          </button>
        ))}
        {!active && <span className="chip">Custom</span>}
      </div>

      <div className="tuning-grid">
        <div>
          {GROUPS.map((g) => (
            <section key={g.title} className="card">
              <h2 className="cardtitle">{g.title}</h2>
              <div className="weights">
                {g.fields.map((f) => (
                  <WeightRow key={f.key} f={f} value={draft[f.key]} changed={draft[f.key] !== saved[f.key]} onChange={(v) => set(f.key, v)} />
                ))}
              </div>
            </section>
          ))}
        </div>

        <section className="card preview-card" aria-label="Preview">
          <div className="preview-head">
            <h2 className="cardtitle">Preview: your top {Math.min(15, total)}</h2>
            {dirty && <span className="small muted">compared with your saved weights</span>}
          </div>
          <ol className="preview">
            {rows.map(({ t, u, move, was }, i) => (
              <li key={t.id}>
                <button className="prow" aria-expanded={open === t.id} onClick={() => setOpen(open === t.id ? null : t.id)}>
                  <span className="prank">{i + 1}</span>
                  <span className={`urg ${u.band}`}>{u.score.toFixed(1)}</span>
                  <span className="ptitle">{t.title}</span>
                  {dirty && move !== 0 && (
                    <span className={`pmove ${move > 0 ? 'up' : 'down'}`} title={`Was ${was.toFixed(1)}`}>
                      <Icon name={move > 0 ? 'arrowUp' : 'arrowDown'} size={13} />
                      {Math.abs(move)}
                    </span>
                  )}
                </button>
                {open === t.id && (
                  <table className="breakdown">
                    <tbody>
                      {u.parts.map((p) => (
                        <tr key={p.factor}>
                          <td>{p.factor}</td>
                          <td className="muted">{p.detail}</td>
                          <td className={p.points < 0 ? 'neg' : ''}>{p.points > 0 ? '+' : ''}{p.points.toFixed(1)}</td>
                        </tr>
                      ))}
                      {u.parts.length === 0 && (
                        <tr>
                          <td className="muted">No factors apply.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                )}
              </li>
            ))}
            {rows.length === 0 && <li className="muted">Add some tasks to see the ranking.</li>}
          </ol>
        </section>
      </div>

      <div className={`savebar ${dirty ? 'show' : ''}`}>
        <span className="small">{dirty ? 'Unsaved changes. Saving applies them on all your devices.' : 'Saved.'}</span>
        <button className="btn" disabled={!dirty} onClick={() => setDraft(saved)}>Undo changes</button>
        <button className="btn primary" disabled={!dirty} onClick={() => store.saveSettings({ weights: draft })}>Save weights</button>
      </div>
    </div>
  );
}

function WeightRow({ f, value, changed, onChange }: { f: Field; value: number; changed: boolean; onChange: (v: number) => void }) {
  const id = `w-${f.key}`;
  return (
    <>
      <label htmlFor={id} className={changed ? 'changed' : ''}>
        {f.label}
        <span className="whelp">{f.help}</span>
      </label>
      <input id={id} type="range" min={f.min} max={f.max} step={f.step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <output htmlFor={id}>{value}</output>
    </>
  );
}
