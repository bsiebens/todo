import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { computeAnalytics, RANGES, type Analytics, type BreakdownRow, type RangeKey, type TrendPoint } from '../domain/analytics';
import { useDerived, useSnapshot } from './state';
import type { View } from './views';
import './analytics.css';

const RANGE_KEY = 'todo.analytics.range';

function loadRange(): RangeKey {
  try {
    const v = localStorage.getItem(RANGE_KEY);
    if (v && RANGES.some((r) => r.key === v)) return v as RangeKey;
  } catch {
    /* storage unavailable */
  }
  return '30d';
}

const pct = (x: number | null) => (x == null ? '–' : `${Math.round(x * 100)}%`);
const days = (x: number | null) => (x == null ? '–' : x < 1 ? `${Math.round(x * 24)} h` : `${x < 10 ? x.toFixed(1) : Math.round(x)} d`);
const num = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

export function AnalyticsView({ onNavigate }: { onNavigate: (v: View) => void }) {
  const s = useSnapshot();
  const d = useDerived();
  const [range, setRange] = useState<RangeKey>(loadRange);
  useEffect(() => {
    try {
      localStorage.setItem(RANGE_KEY, range);
    } catch {
      /* ignore */
    }
  }, [range]);

  const a = useMemo(
    () =>
      computeAnalytics({
        tasks: s.tasks,
        now: d.now,
        range,
        blocked: d.blocked,
        urgency: d.urgency,
        projectLabel: (id) => {
          const p = s.projects.find((x) => x.id === id);
          return p ? { label: d.tree.path(id), color: p.color } : null;
        },
        tagsByTask: d.tagsByTask,
      }),
    [s, d, range],
  );
  const rangeLabel = RANGES.find((r) => r.key === range)!.label.toLowerCase();
  const search = (q: string) => () => onNavigate({ kind: 'search', q });

  if (s.tasks.length === 0) {
    return (
      <div className="analytics">
        <div className="viewhead"><h1>Analytics</h1></div>
        <p className="empty">No tasks yet. Statistics appear here once you add and complete some tasks.</p>
      </div>
    );
  }

  return (
    <div className="analytics">
      <div className="viewhead an-head">
        <h1>Analytics</h1>
        <span className="segmented an-range" role="group" aria-label="Period">
          {RANGES.map((r) => (
            <button key={r.key} className={r.key === range ? 'on' : ''} aria-pressed={r.key === range} onClick={() => setRange(r.key)}>
              {r.label}
            </button>
          ))}
        </span>
      </div>

      <section aria-label="Current state">
        <div className="an-tiles">
          <Tile label="Open" value={a.counts.open} sub={`${a.counts.ready} ready to start`} onClick={() => onNavigate({ kind: 'focus' })} hint="Open tasks" />
          <Tile label="In progress" value={a.counts.inProgress} onClick={search('status:in_progress')} />
          <Tile label="Blocked" value={a.counts.blocked} sub={a.counts.deferred ? `${a.counts.deferred} scheduled for later` : undefined} />
          <Tile label="Overdue" value={a.counts.overdue} tone={a.counts.overdue ? 'bad' : undefined} sub={a.counts.dueToday ? `${a.counts.dueToday} due today` : undefined} onClick={search('due:overdue')} />
          <Tile label="Completed" value={a.period.completed} sub={`last ${rangeLabel} · ${a.counts.completed} all time`} onClick={search('status:done')} />
        </div>
      </section>

      <h2 className="an-h2">Key indicators <span className="muted">· last {rangeLabel}</span></h2>
      <div className="an-tiles kpi">
        <Tile label="Completion rate" value={pct(a.period.completionRate)} sub={`of ${a.period.created} tasks created`} hint="Share of the tasks created in this period that are done now." />
        <Tile label="On-time rate" value={pct(a.period.onTimeRate)} sub={a.period.onTimeBase ? `${a.period.onTimeBase} completed with a due date` : 'no due dates completed'} hint="Share of completed tasks with a due date that were finished by their due time." />
        <Tile label="Lead time" value={days(a.period.leadTimeMedian)} sub={`median · avg ${days(a.period.leadTimeAvg)}`} hint="Time from creating a task to completing it." />
        <Tile label="Cycle time" value={days(a.period.cycleTimeAvg)} sub="avg, started to done" hint="Time from first starting a task to completing it." />
        <Tile label="Throughput" value={num(Math.round(a.period.throughputPerWeek * 10) / 10)} sub="completed per week" />
        <Tile label="Overdue rate" value={pct(a.overdueRate)} tone={a.overdueRate && a.overdueRate > 0.25 ? 'bad' : undefined} sub={`of ${a.openWithDue} open with a due date`} hint="Overdue tasks as a share of open tasks that have a due date." />
        <Tile
          label="Backlog change"
          value={a.period.netChange > 0 ? `+${a.period.netChange}` : String(a.period.netChange)}
          sub={`${a.period.created} created · ${a.period.completed + a.period.cancelled} closed`}
          hint="Tasks created minus tasks completed or cancelled. Negative means the list is shrinking."
        />
        <Tile label="Open task age" value={days(a.openAgeAvg)} sub={a.oldestOpen ? `oldest: ${a.oldestOpen.title}` : 'average'} hint="Average time since open tasks were created." />
      </div>

      <div className="an-grid">
        <Card title="Created vs completed" wide>
          <ColumnChart
            points={a.trend}
            series={[
              { key: 'created', label: 'Created', color: 'var(--an-s1)' },
              { key: 'completed', label: 'Completed', color: 'var(--an-s2)' },
            ]}
          />
          <TrendTable trend={a.trend} />
        </Card>
        <Card title="Open tasks over time">
          <LineChart points={a.trend} value={(p) => p.open} format={(v) => String(v)} color="var(--an-s1)" label="Open" />
        </Card>
        <Card title="Completion rate over time" note={range === '7d' || range === '30d' ? 'Share of tasks created in the 7 days up to each day that are done now' : 'Share of tasks created in each period that are done now'}>
          <LineChart points={a.trend} value={(p) => p.completionRate} format={pct} yMax={1} color="var(--an-s2)" label="Completion rate" />
        </Card>
        <Card title="Open work by state">
          <StateBar a={a} />
        </Card>
        <Card title="Urgency distribution" note="Open tasks by urgency score">
          <Urgency a={a} />
        </Card>
        <Card title="By project">
          <Breakdown rows={a.byProject} range={rangeLabel} onOpen={(r) => r.key && onNavigate({ kind: 'project', id: r.key })} />
        </Card>
        <Card title="By tag">
          {a.byTag.length ? <Breakdown rows={a.byTag} range={rangeLabel} onOpen={(r) => onNavigate({ kind: 'tag', id: r.key })} /> : <p className="small muted">No tagged tasks.</p>}
        </Card>
        <Card title="By priority">
          <Breakdown rows={a.byPriority} range={rangeLabel} />
        </Card>
      </div>
    </div>
  );
}

function Tile({ label, value, sub, hint, tone, onClick }: { label: string; value: ReactNode; sub?: string; hint?: string; tone?: 'bad'; onClick?: () => void }) {
  const body = (
    <>
      <div className="an-tile-label">{label}</div>
      <div className={`an-tile-value ${tone ?? ''}`}>{value}</div>
      {sub && <div className="an-tile-sub">{sub}</div>}
    </>
  );
  return onClick ? (
    <button className="an-tile link" title={hint} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="an-tile" title={hint}>
      {body}
    </div>
  );
}

function Card({ title, note, wide, children }: { title: string; note?: string; wide?: boolean; children: ReactNode }) {
  return (
    <section className={`an-card ${wide ? 'wide' : ''}`}>
      <h3>{title}</h3>
      {note && <p className="an-note">{note}</p>}
      {children}
    </section>
  );
}

// ---------- charts ----------

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** A "nice" upper bound and tick list for a count axis. */
function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const stepI = Math.max(1, Math.round(step));
  const ticks: number[] = [];
  for (let v = 0; v <= max + stepI - 1e-9; v += stepI) ticks.push(v);
  if (ticks[ticks.length - 1]! < max) ticks.push(ticks[ticks.length - 1]! + stepI);
  return ticks;
}

const H = 180;
const PAD = { l: 34, r: 8, t: 8, b: 24 };

interface Frame {
  w: number;
  innerW: number;
  innerH: number;
  x: (i: number) => number;
  band: number;
  labelEvery: number;
}

function frame(w: number, n: number): Frame {
  const innerW = Math.max(10, w - PAD.l - PAD.r);
  const band = innerW / n;
  const maxLabels = Math.max(2, Math.floor(innerW / 52));
  return { w, innerW, innerH: H - PAD.t - PAD.b, x: (i) => PAD.l + band * i, band, labelEvery: Math.ceil(n / maxLabels) };
}

function Axes({ f, points, ticks, y, fmt }: { f: Frame; points: TrendPoint[]; ticks: number[]; y: (v: number) => number; fmt: (v: number) => string }) {
  return (
    <g className="an-axis">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD.l} x2={f.w - PAD.r} y1={y(t)} y2={y(t)} className={t === 0 ? 'base' : 'grid'} />
          <text x={PAD.l - 6} y={y(t)} dy="0.32em" textAnchor="end">
            {fmt(t)}
          </text>
        </g>
      ))}
      {points.map((p, i) =>
        (points.length - 1 - i) % f.labelEvery === 0 ? (
          <text key={p.start} x={f.x(i) + f.band / 2} y={H - 6} textAnchor="middle">
            {p.label}
          </text>
        ) : null,
      )}
    </g>
  );
}

function Tooltip({ x, w, children }: { x: number; w: number; children: ReactNode }) {
  const left = Math.min(Math.max(x, 70), w - 70);
  return (
    <div className="an-tip" style={{ left }}>
      {children}
    </div>
  );
}

const rangeText = (p: TrendPoint) => (p.start === p.end ? p.label : `${p.start.slice(5).replace('-', '/')} – ${p.end.slice(5).replace('-', '/')}`);

function ColumnChart({ points, series }: { points: TrendPoint[]; series: { key: 'created' | 'completed'; label: string; color: string }[] }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...points.flatMap((p) => series.map((s) => p[s.key])));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1]!;
  const f = frame(w, points.length);
  const y = (v: number) => PAD.t + f.innerH * (1 - v / top);
  const gap = 2;
  const groupW = Math.max(2, f.band * 0.72);
  const barW = Math.max(1, (groupW - gap * (series.length - 1)) / series.length);
  const r = Math.min(4, barW / 2);

  return (
    <div className="an-chart" ref={ref} onMouseLeave={() => setHover(null)}>
      <Legend items={series} />
      {w > 0 && (
        <svg width={w} height={H} role="img" aria-label={`Created vs completed: ${points.map((p) => `${p.label} ${p.created} created, ${p.completed} completed`).join('; ')}`}>
          <Axes f={f} points={points} ticks={ticks} y={y} fmt={String} />
          {hover != null && <rect x={f.x(hover)} y={PAD.t} width={f.band} height={f.innerH} className="an-hoverband" />}
          {points.map((p, i) =>
            series.map((s, k) => {
              const v = p[s.key];
              if (!v) return null;
              const bx = f.x(i) + (f.band - groupW) / 2 + k * (barW + gap);
              const by = y(v);
              const bh = y(0) - by;
              return <path key={`${i}${s.key}`} d={roundedTop(bx, by, barW, bh, r)} fill={s.color} />;
            }),
          )}
          {points.map((p, i) => (
            <rect key={p.start} x={f.x(i)} y={PAD.t} width={f.band} height={f.innerH + PAD.b} fill="transparent" onMouseEnter={() => setHover(i)} onClick={() => setHover(i)} />
          ))}
        </svg>
      )}
      {hover != null && (
        <Tooltip x={f.x(hover) + f.band / 2} w={w}>
          <div className="an-tip-head">{rangeText(points[hover]!)}</div>
          {series.map((s) => (
            <div key={s.key} className="an-tip-row">
              <i style={{ background: s.color }} />
              {s.label}
              <b>{points[hover]![s.key]}</b>
            </div>
          ))}
        </Tooltip>
      )}
    </div>
  );
}

function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function LineChart({ points, value, format, yMax, color, label }: { points: TrendPoint[]; value: (p: TrendPoint) => number | null; format: (v: number | null) => string; yMax?: number; color: string; label: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const vals = points.map(value);
  const max = yMax ?? Math.max(1, ...vals.map((v) => v ?? 0));
  const ticks = yMax === 1 ? [0, 0.25, 0.5, 0.75, 1] : niceTicks(max);
  const top = ticks[ticks.length - 1]!;
  const f = frame(w, points.length);
  const y = (v: number) => PAD.t + f.innerH * (1 - v / top);
  const cx = (i: number) => f.x(i) + f.band / 2;

  // Split into segments at gaps (null values).
  const segs: string[] = [];
  let cur = '';
  vals.forEach((v, i) => {
    if (v == null) {
      if (cur) segs.push(cur);
      cur = '';
    } else cur += `${cur ? 'L' : 'M'}${cx(i)},${y(v)}`;
  });
  if (cur) segs.push(cur);
  const hasData = vals.some((v) => v != null);

  return (
    <div className="an-chart" ref={ref} onMouseLeave={() => setHover(null)}>
      {w > 0 && (
        <svg width={w} height={H} role="img" aria-label={`${label}: ${points.map((p, i) => `${p.label} ${format(vals[i]!)}`).join('; ')}`}>
          <Axes f={f} points={points} ticks={ticks} y={y} fmt={(v) => (yMax === 1 ? `${v * 100}%` : String(v))} />
          {hover != null && <line x1={cx(hover)} x2={cx(hover)} y1={PAD.t} y2={PAD.t + f.innerH} className="an-crosshair" />}
          {segs.map((d) => (
            <path key={d} d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {vals.map((v, i) =>
            v != null && (hover === i || points.length <= 13 || vals[i - 1] == null && vals[i + 1] == null) ? (
              <circle key={i} cx={cx(i)} cy={y(v)} r={hover === i ? 5 : 3} fill={color} className="an-dot" />
            ) : null,
          )}
          {points.map((p, i) => (
            <rect key={p.start} x={f.x(i)} y={PAD.t} width={f.band} height={f.innerH + PAD.b} fill="transparent" onMouseEnter={() => setHover(i)} onClick={() => setHover(i)} />
          ))}
          {!hasData && (
            <text x={PAD.l + f.innerW / 2} y={PAD.t + f.innerH / 2} textAnchor="middle" className="an-empty">
              No data in this period
            </text>
          )}
        </svg>
      )}
      {hover != null && (
        <Tooltip x={cx(hover)} w={w}>
          <div className="an-tip-head">{rangeText(points[hover]!)}</div>
          <div className="an-tip-row">
            <i style={{ background: color }} />
            {label}
            <b>{format(vals[hover]!)}</b>
          </div>
        </Tooltip>
      )}
    </div>
  );
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="an-legend">
      {items.map((s) => (
        <span key={s.label}>
          <i style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

function TrendTable({ trend }: { trend: TrendPoint[] }) {
  return (
    <details className="an-table">
      <summary>Show as table</summary>
      <div className="an-scroll">
        <table>
          <thead>
            <tr>
              <th>Period</th>
              <th>Created</th>
              <th>Completed</th>
              <th>Open at end</th>
              <th>Completion rate</th>
            </tr>
          </thead>
          <tbody>
            {trend.map((p) => (
              <tr key={p.start}>
                <td>{rangeText(p)}</td>
                <td>{p.created}</td>
                <td>{p.completed}</td>
                <td>{p.open}</td>
                <td>{pct(p.completionRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function StateBar({ a }: { a: Analytics }) {
  const parts = [
    { label: 'In progress', n: a.counts.inProgress, color: 'var(--an-s1)' },
    { label: 'Ready', n: a.counts.ready, color: 'var(--an-s3)' },
    { label: 'Blocked', n: a.counts.blocked, color: 'var(--an-s2)' },
    { label: 'Scheduled later', n: a.counts.deferred, color: 'var(--an-neutral)' },
  ];
  const total = a.counts.open;
  if (!total) return <p className="small muted">Nothing open. Nice.</p>;
  return (
    <>
      <div className="an-stack" role="img" aria-label={parts.map((p) => `${p.label} ${p.n}`).join(', ')}>
        {parts.map((p) => (p.n ? <span key={p.label} style={{ flexGrow: p.n, background: p.color }} title={`${p.label}: ${p.n}`} /> : null))}
      </div>
      <table className="an-rows">
        <tbody>
          {parts.map((p) => (
            <tr key={p.label}>
              <td>
                <i className="an-swatch" style={{ background: p.color }} />
                {p.label}
              </td>
              <td className="n">{p.n}</td>
              <td className="n muted">{pct(p.n / total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Urgency({ a }: { a: Analytics }) {
  const max = Math.max(1, ...a.urgencyHistogram.map((b) => b.count));
  const bands = [
    { key: 'now' as const, label: 'Now' },
    { key: 'soon' as const, label: 'Soon' },
    { key: 'later' as const, label: 'Later' },
  ];
  if (!a.counts.open) return <p className="small muted">No open tasks.</p>;
  return (
    <>
      <div className="an-bands">
        {bands.map((b) => (
          <div key={b.key} className={`an-band ${b.key}`}>
            <span className="urg-dot" />
            {b.label}
            <b>{a.urgencyBands[b.key]}</b>
          </div>
        ))}
      </div>
      <div className="an-hist" role="img" aria-label={a.urgencyHistogram.map((b) => `score ${b.from} to ${b.to}: ${b.count}`).join(', ')}>
        {a.urgencyHistogram.map((b) => (
          <div key={b.from} className="an-hist-col" title={`Score ${b.from} to ${b.to}: ${b.count} task${b.count === 1 ? '' : 's'}`}>
            <span className="an-hist-n">{b.count || ''}</span>
            <span className={`an-hist-bar ${b.band}`} style={{ height: `${(b.count / max) * 100}%` }} />
            <span className="an-hist-x">{b.from}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function Breakdown({ rows, range, onOpen }: { rows: BreakdownRow[]; range: string; onOpen?: (r: BreakdownRow) => void }) {
  const LIMIT = 8;
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, LIMIT);
  const max = Math.max(1, ...rows.map((r) => r.open));
  if (!rows.length) return <p className="small muted">Nothing to show.</p>;
  return (
    <>
      <table className="an-rows an-break">
        <thead>
          <tr>
            <th />
            <th className="n">Open</th>
            <th className="n" title="Overdue">Late</th>
            <th className="n" title={`Completed in the last ${range}`}>Done</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.key}>
              <td className="lbl">
                {onOpen && r.key ? (
                  <button className="an-linkbtn" onClick={() => onOpen(r)}>
                    {r.label}
                  </button>
                ) : (
                  <span>{r.label}</span>
                )}
                <span className="an-meter" aria-hidden>
                  <span className="open" style={{ width: `${((r.open - r.overdue) / max) * 100}%` }} />
                  {r.overdue > 0 && <span className="late" style={{ width: `${(r.overdue / max) * 100}%` }} />}
                </span>
              </td>
              <td className="n">{r.open}</td>
              <td className={`n ${r.overdue ? 'bad' : 'muted'}`}>{r.overdue}</td>
              <td className="n">{r.completed}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > LIMIT && (
        <button className="hiddenlink small" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      )}
    </>
  );
}
