import { toDateStr, pad } from './dates';
import { ProjectTree } from './projects';
import { parseQuickAdd } from './quickadd';
import type { Priority, Project, RecurrenceMode, Status } from './types';

/**
 * Turns exports from other to-do apps into plain task records. Supported:
 * Todoist CSV, TickTick CSV, any CSV with a title column (Outlook / Microsoft To Do,
 * spreadsheets), a plain text or Markdown list, and this app's own JSON export.
 * Sub-tasks become a Markdown checklist in the parent's description (the app has no sub-tasks).
 */

export interface ImportItem {
  title: string;
  description: string;
  priority: Priority;
  dueDate: string | null;
  dueTime: string | null;
  projectPath: string | null;
  tags: string[];
  status: Status;
  createdAt: string | null;
  completedAt: string | null;
  estimateMin: number | null;
  recurrence: { rule: string; mode: RecurrenceMode } | null;
  notes: string[];
}

export type ImportFormat = 'todoist' | 'ticktick' | 'csv' | 'text' | 'todo-json';

export const FORMAT_LABELS: Record<ImportFormat, string> = {
  todoist: 'Todoist CSV',
  ticktick: 'TickTick CSV',
  csv: 'CSV',
  text: 'Text list',
  'todo-json': 'ToDo export',
};

export interface ImportResult {
  format: ImportFormat;
  items: ImportItem[];
  warnings: string[];
}

export interface ImportFile {
  name: string;
  text: string;
}

const blank = (title: string): ImportItem => ({
  title,
  description: '',
  priority: 0,
  dueDate: null,
  dueTime: null,
  projectPath: null,
  tags: [],
  status: 'todo',
  createdAt: null,
  completedAt: null,
  estimateMin: null,
  recurrence: null,
  notes: [],
});

// ---------- CSV ----------

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes, CRLF, BOM. Also reads ; or tab separated files. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const counts = [',', ';', '\t'].map((c) => [c, firstLine.split(c).length] as const);
  const sep = counts.sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const norm = (h: string) => h.trim().toLowerCase().replace(/[_\s]+/g, ' ');

/** Finds the header row (TickTick puts a few lines of metadata first) and returns rows as objects keyed by normalised header. */
function csvRecords(rows: string[][], mustHave: string[]): { header: string[]; records: Record<string, string>[] } | null {
  const at = rows.findIndex((r) => mustHave.some((h) => r.map(norm).includes(h)));
  if (at < 0) return null;
  const header = rows[at]!.map(norm);
  const records = rows.slice(at + 1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
  return { header, records };
}

// ---------- Dates ----------

/** Parses common date forms into a local date and optional time. Day/month order follows the app (d/m) unless the numbers make it clear. */
export function parseLooseDate(s: string, today: string): { date: string; time: string | null } | null {
  const v = s.trim();
  if (!v) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: null };
  // Full timestamps with a zone are converted to local time.
  m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(v);
  if (m) {
    if (!m[6]) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}` };
    const d = new Date(v.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    if (isNaN(d.getTime())) return null;
    return { date: toDateStr(d), time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
  }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ T,]+(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?)?$/i.exec(v);
  if (m) {
    let a = +m[1]!;
    let b = +m[2]!;
    const y = m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!;
    if (b > 12 && a <= 12) [a, b] = [b, a]; // m/d/y
    if (a > 31 || b > 12 || a < 1 || b < 1) return null;
    let time: string | null = null;
    if (m[4]) {
      let h = +m[4];
      if (m[6]) h = (h % 12) + (m[6].toLowerCase() === 'pm' ? 12 : 0);
      time = `${pad(h)}:${m[5]}`;
    }
    return { date: `${y}-${pad(b)}-${pad(a)}`, time };
  }
  // Words such as "tomorrow", "fri 14:00", "1 dec", "dec 1 2026", via the quick-add parser.
  const yearMatch = /\b(\d{4})\b/.exec(v);
  const withoutYear = v.replace(/\b\d{4}\b/, '').replace(/,/g, ' ');
  const q = parseQuickAdd(withoutYear, today);
  if (q.dueDate && !q.title && !q.rule) {
    let date = q.dueDate;
    if (yearMatch) date = `${yearMatch[1]}${date.slice(4)}`;
    return { date, time: q.dueTime };
  }
  return null;
}

// ---------- Todoist ----------

/** Todoist shows P1 as most urgent. P1 = High, P2 = Medium, P3 = Low, P4 = none. */
const TODOIST_PRIORITY: Record<string, Priority> = { '1': 3, '2': 2, '3': 1, '4': 0 };

function projectFromFileName(name: string): string | null {
  const base = name.replace(/^.*[\\/]/, '').replace(/\.csv$/i, '').replace(/\s*\[\d+\]\s*$/, '').trim();
  return base || null;
}

export function parseTodoist(rows: string[][], fileName: string, today: string): ImportResult {
  const rec = csvRecords(rows, ['type'])!;
  const warnings: string[] = [];
  const items: ImportItem[] = [];
  const base = projectFromFileName(fileName);
  let section: string | null = null;
  let parent: ImportItem | null = null;
  let last: ImportItem | null = null;
  for (const r of rec.records) {
    const type = (r.type ?? '').toLowerCase();
    const content = r.content ?? '';
    if (type === 'section') {
      section = content.replace(/:$/, '').trim() || null;
      parent = null;
      last = null;
      continue;
    }
    if (type === 'note') {
      if (last && content) last.notes.push(content);
      continue;
    }
    if (type !== 'task' || !content) continue;
    const indent = Math.max(1, Number(r.indent) || 1);
    const tags: string[] = [];
    const title = content
      .replace(/(^|\s)@([^\s@]+)/g, (_, sp: string, tag: string) => {
        tags.push(tag);
        return sp;
      })
      .replace(/\s+/g, ' ')
      .trim();
    if (indent > 1 && parent) {
      parent.description += `${parent.description && !parent.description.endsWith('\n') ? '\n' : ''}${'  '.repeat(indent - 2)}- [ ] ${title}\n`;
      continue;
    }
    const item = blank(title);
    item.description = r.description ?? '';
    item.priority = TODOIST_PRIORITY[r.priority ?? ''] ?? 0;
    item.tags = tags;
    item.projectPath = base ? (section ? `${base}/${section}` : base) : section;
    if (item.projectPath?.toLowerCase() === 'inbox') item.projectPath = null;
    const dur = Number(r.duration);
    if (dur > 0) item.estimateMin = (r['duration unit'] ?? 'minute').startsWith('day') ? dur * 480 : dur;
    const date = r.date ?? '';
    if (date) {
      const recurring = /^every\b|^ev\b/i.test(date);
      if (recurring) {
        const q = parseQuickAdd(date.replace(/^every!/i, 'every').replace(/^ev\b/i, 'every'), today);
        if (q.rule && !q.title) {
          item.recurrence = { rule: q.rule, mode: /every!/i.test(date) ? 'after_completion' : 'schedule' };
          item.dueDate = q.dueDate;
          item.dueTime = q.dueTime;
        } else warnings.push(`"${title}": repeat "${date}" was not understood, kept in the description.`);
      } else {
        const d = parseLooseDate(date, today);
        if (d) {
          item.dueDate = d.date;
          item.dueTime = d.time;
        } else warnings.push(`"${title}": date "${date}" was not understood, kept in the description.`);
      }
      if (!item.dueDate && !item.recurrence) item.description += `${item.description ? '\n\n' : ''}Todoist date: ${date}`;
    }
    items.push(item);
    parent = item;
    last = item;
  }
  return { format: 'todoist', items, warnings };
}

// ---------- TickTick ----------

const TICKTICK_PRIORITY: Record<string, Priority> = { '0': 0, '1': 1, '3': 2, '5': 3 };

export function parseTickTick(rows: string[][], today: string): ImportResult {
  const rec = csvRecords(rows, ['title'])!;
  const warnings: string[] = [];
  const items: ImportItem[] = [];
  const byId = new Map<string, ImportItem>();
  const children: { parentId: string; title: string; done: boolean }[] = [];
  for (const r of rec.records) {
    const title = r.title ?? '';
    if (!title) continue;
    const statusCode = r.status ?? '0';
    const done = statusCode === '1' || statusCode === '2';
    if (r.parentid) {
      children.push({ parentId: r.parentid, title, done });
      continue;
    }
    const item = blank(title);
    item.description = r.content ?? '';
    item.priority = TICKTICK_PRIORITY[r.priority ?? '0'] ?? 0;
    item.tags = (r.tags ?? '').split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean);
    const list = r['list name'] ?? '';
    const folder = r['folder name'] ?? '';
    item.projectPath = list && list.toLowerCase() !== 'inbox' ? (folder ? `${folder}/${list}` : list) : null;
    item.status = done ? 'done' : statusCode === '-1' ? 'cancelled' : 'todo';
    const due = parseLooseDate(r['due date'] ?? '', today);
    if (due) {
      item.dueDate = due.date;
      item.dueTime = (r['is all day'] ?? '').toLowerCase() === 'true' ? null : due.time;
    }
    const created = r['created time'] ? new Date(r['created time'].replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : null;
    if (created && !isNaN(created.getTime())) item.createdAt = created.toISOString();
    const completed = r['completed time'] ? new Date(r['completed time'].replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : null;
    if (completed && !isNaN(completed.getTime())) item.completedAt = completed.toISOString();
    const repeat = (r.repeat ?? '').replace(/^RRULE:/i, '').trim();
    if (repeat && /FREQ=/i.test(repeat)) item.recurrence = { rule: repeat.toUpperCase(), mode: 'schedule' };
    items.push(item);
    if (r.taskid) byId.set(r.taskid, item);
  }
  for (const c of children) {
    const p = byId.get(c.parentId);
    if (p) p.description += `${p.description && !p.description.endsWith('\n') ? '\n' : ''}- [${c.done ? 'x' : ' '}] ${c.title}\n`;
    else items.push(blank(c.title));
  }
  if (!rec.header.includes('title')) warnings.push('No Title column found.');
  return { format: 'ticktick', items, warnings };
}

// ---------- Generic CSV (Outlook, Microsoft To Do, spreadsheets) ----------

const COLS = {
  title: ['title', 'task', 'task name', 'name', 'subject', 'content', 'summary', 'todo'],
  description: ['description', 'notes', 'note', 'details', 'body', 'comments'],
  due: ['due', 'due date', 'deadline', 'due at', 'date'],
  time: ['due time', 'time'],
  priority: ['priority', 'importance'],
  project: ['project', 'list', 'folder', 'project name', 'list name'],
  tags: ['tags', 'labels', 'tag', 'categories', 'category'],
  status: ['status', 'state', 'completed', 'done', 'is completed'],
  completedAt: ['completed at', 'date completed', 'completed date', 'completion date'],
  estimate: ['estimate', 'estimate min', 'duration', 'minutes'],
};

function priorityWord(v: string): Priority {
  const s = v.trim().toLowerCase();
  if (!s) return 0;
  if (/^\d$/.test(s)) return Math.min(4, Math.max(0, +s)) as Priority;
  if (/crit|urgent|highest/.test(s)) return 4;
  if (/high|important/.test(s)) return 3;
  if (/med|normal/.test(s)) return /normal/.test(s) ? 0 : 2;
  if (/low/.test(s)) return 1;
  return 0;
}

export function parseGenericCsv(rows: string[][], today: string): ImportResult {
  const rec = csvRecords(rows, COLS.title);
  if (!rec) return { format: 'csv', items: [], warnings: ['No title column found. Name one column Title, Task, Name or Subject.'] };
  const pick = (r: Record<string, string>, keys: string[]) => keys.map((k) => r[k]).find((v) => v !== undefined && v !== '') ?? '';
  const warnings: string[] = [];
  const items: ImportItem[] = [];
  for (const r of rec.records) {
    const title = pick(r, COLS.title);
    if (!title) continue;
    const item = blank(title);
    item.description = pick(r, COLS.description);
    item.priority = priorityWord(pick(r, COLS.priority));
    item.projectPath = pick(r, COLS.project) || null;
    item.tags = pick(r, COLS.tags).split(/[,;]/).map((t) => t.trim().replace(/^#/, '')).filter(Boolean);
    const status = pick(r, COLS.status).toLowerCase();
    if (/^(done|completed?|complete|closed|true|yes|x|1)$/.test(status)) item.status = 'done';
    else if (/progress|^started$/.test(status)) item.status = 'in_progress';
    else if (/cancel|won't|wont/.test(status)) item.status = 'cancelled';
    const dueRaw = pick(r, COLS.due);
    if (dueRaw) {
      const d = parseLooseDate(dueRaw, today);
      if (d) {
        item.dueDate = d.date;
        item.dueTime = d.time;
      } else warnings.push(`"${title}": date "${dueRaw}" was not understood.`);
    }
    const t = pick(r, COLS.time);
    if (t && item.dueDate && /^\d{1,2}:\d{2}$/.test(t)) item.dueTime = t.padStart(5, '0');
    const comp = parseLooseDate(pick(r, COLS.completedAt), today);
    if (comp && item.status === 'todo') item.status = 'done';
    if (comp) item.completedAt = new Date(`${comp.date}T${comp.time ?? '12:00'}:00`).toISOString();
    const est = Number(pick(r, COLS.estimate));
    if (est > 0) item.estimateMin = Math.round(est);
    items.push(item);
  }
  return { format: 'csv', items, warnings };
}

// ---------- Plain text / Markdown ----------

/**
 * One task per line, read with the quick-add syntax (dates, !priority, #tags, @Project).
 * "- [x]" marks a done task, "# Heading" sets the project for the lines below it, and
 * indented lines become a checklist in the task above.
 */
export function parseText(text: string, today: string): ImportResult {
  const items: ImportItem[] = [];
  let heading: string | null = null;
  let last: ImportItem | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const indent = /^(\s*)/.exec(raw.replace(/\t/g, '  '))![1]!.length;
    const h = /^\s*#{1,6}\s+(.+?)\s*:?\s*$/.exec(raw);
    if (h) {
      heading = h[1]!.trim();
      last = null;
      continue;
    }
    let line = raw.trim();
    let done = false;
    const box = /^(?:[-*+]|\d+[.)])?\s*\[([ xX])\]\s*/.exec(line);
    if (box) {
      done = box[1] !== ' ';
      line = line.slice(box[0].length);
    } else line = line.replace(/^(?:[-*+•]|\d+[.)])\s+/, '');
    if (!line) continue;
    if (indent >= 2 && last) {
      last.description += `${'  '.repeat(Math.max(0, Math.floor(indent / 2) - 1))}- [${done ? 'x' : ' '}] ${line}\n`;
      continue;
    }
    const q = parseQuickAdd(line, today);
    const item = blank(q.title || line);
    item.priority = q.priority ?? 0;
    item.tags = q.tags;
    item.projectPath = q.projectPath ?? heading;
    item.dueDate = q.dueDate;
    item.dueTime = q.dueTime;
    item.estimateMin = q.estimateMin;
    item.recurrence = q.rule ? { rule: q.rule, mode: q.mode } : null;
    item.status = done ? 'done' : 'todo';
    items.push(item);
    last = item;
  }
  return { format: 'text', items, warnings: [] };
}

// ---------- This app's JSON export ----------

interface TodoExport {
  format: 'todo-export';
  tasks: { id: string; title: string; description: string; status: Status; priority: Priority; dueDate: string | null; dueTime: string | null; estimateMin: number | null; projectId: string | null; seriesId: string | null; createdAt: string; completedAt: string | null }[];
  projects: Project[];
  tags: { id: string; name: string }[];
  taskTags: { taskId: string; tagId: string }[];
  notes: { taskId: string; body: string; kind: string }[];
  series: { id: string; rrule: string; mode: RecurrenceMode }[];
}

export function parseTodoJson(data: TodoExport): ImportResult {
  const tree = new ProjectTree(data.projects ?? []);
  const tagName = new Map((data.tags ?? []).map((t) => [t.id, t.name]));
  const series = new Map((data.series ?? []).map((s) => [s.id, s]));
  const items = (data.tasks ?? []).map((t) => {
    const item = blank(t.title);
    item.description = t.description ?? '';
    item.priority = t.priority ?? 0;
    item.dueDate = t.dueDate;
    item.dueTime = t.dueTime;
    item.estimateMin = t.estimateMin;
    item.status = t.status ?? 'todo';
    item.createdAt = t.createdAt ?? null;
    item.completedAt = t.completedAt ?? null;
    item.projectPath = t.projectId && data.projects?.some((p) => p.id === t.projectId) ? tree.path(t.projectId, '/') : null;
    item.tags = (data.taskTags ?? []).filter((x) => x.taskId === t.id).map((x) => tagName.get(x.tagId)).filter((n): n is string => !!n);
    item.notes = (data.notes ?? []).filter((n) => n.taskId === t.id && n.kind === 'user').map((n) => n.body).reverse();
    const s = t.seriesId ? series.get(t.seriesId) : undefined;
    if (s) item.recurrence = { rule: s.rrule, mode: s.mode };
    return item;
  });
  return { format: 'todo-json', items, warnings: [] };
}

// ---------- Entry point ----------

export function detectAndParse(files: ImportFile[], today: string): ImportResult {
  const out: ImportResult = { format: 'text', items: [], warnings: [] };
  const formats = new Set<ImportFormat>();
  for (const f of files) {
    const r = parseOne(f, today);
    formats.add(r.format);
    out.items.push(...r.items);
    out.warnings.push(...(files.length > 1 ? r.warnings.map((w) => `${f.name}: ${w}`) : r.warnings));
  }
  out.format = formats.size === 1 ? [...formats][0]! : formats.has('todoist') ? 'todoist' : 'csv';
  return out;
}

function parseOne(f: ImportFile, today: string): ImportResult {
  const text = f.text.replace(/^﻿/, '');
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const data = JSON.parse(trimmed);
      if (data?.format === 'todo-export') return parseTodoJson(data);
      return { format: 'text', items: [], warnings: ['This JSON file is not a ToDo export.'] };
    } catch {
      /* not JSON, fall through */
    }
  }
  const looksCsv = /\.(csv|tsv)$/i.test(f.name) || /^[^\n]*[,;\t][^\n]*\n/.test(trimmed);
  if (looksCsv) {
    const rows = parseCsv(text);
    const firstRows = rows.slice(0, 8).map((r) => r.map(norm));
    if (firstRows.some((r) => r.includes('type') && r.includes('content') && r.includes('indent'))) return parseTodoist(rows, f.name, today);
    if (firstRows.some((r) => r.includes('title') && (r.includes('list name') || r.includes('folder name')))) return parseTickTick(rows, today);
    if (firstRows.some((r) => r.some((h) => COLS.title.includes(h)))) return parseGenericCsv(rows, today);
    if (/\.(csv|tsv)$/i.test(f.name)) return parseGenericCsv(rows, today);
  }
  return parseText(text, today);
}

/** Marks items that look like tasks you already have: same title (ignoring case) and same due date. */
export function findDuplicates(items: ImportItem[], existing: { title: string; dueDate: string | null }[]): Set<number> {
  const key = (t: string, d: string | null) => `${t.trim().toLowerCase()}|${d ?? ''}`;
  const have = new Set(existing.map((t) => key(t.title, t.dueDate)));
  const dup = new Set<number>();
  items.forEach((it, i) => {
    const k = key(it.title, it.dueDate);
    if (have.has(k)) dup.add(i);
    else have.add(k);
  });
  return dup;
}
