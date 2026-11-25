export type Id = string;

export type Status = 'todo' | 'in_progress' | 'done' | 'cancelled';
export type Priority = 0 | 1 | 2 | 3 | 4; // none, low, medium, high, critical
export type Context = 'home' | 'office' | 'any';

export interface Task {
  id: Id;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  dueDate: string | null; // YYYY-MM-DD
  dueTime: string | null; // HH:MM, null = any time that day
  startAfter: string | null; // ISO datetime
  estimateMin: number | null;
  projectId: Id | null;
  seriesId: Id | null;
  /** Starred for Focus. Only counts on the day in focusDate (Focus starts empty each morning). */
  focus: boolean;
  focusDate: string | null; // YYYY-MM-DD the task was put in Focus
  sortKey: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export type NoteKind = 'user' | 'system';

export interface Note {
  id: Id;
  taskId: Id;
  body: string;
  kind: NoteKind;
  createdAt: string;
  editedAt: string | null;
}

export interface Project {
  id: Id;
  parentId: Id | null;
  name: string;
  color: string | null;
  context: Context | null; // null = inherit
  urgencyWeight: number | null; // null = inherit
  sortKey: string;
  archivedAt: string | null;
}

export interface Tag {
  id: Id;
  name: string;
  color: string | null;
  urgencyWeight: number;
}

export interface Dependency {
  blockerId: Id;
  blockedId: Id;
}

export type RecurrenceMode = 'schedule' | 'after_completion';

export interface RecurrenceSeries {
  id: Id;
  rrule: string; // iCalendar RRULE body, e.g. FREQ=WEEKLY;BYDAY=MO
  mode: RecurrenceMode;
}

export const PRIORITY_LABELS: Record<Priority, string> = {
  0: 'None',
  1: 'Low',
  2: 'Medium',
  3: 'High',
  4: 'Critical',
};

export const isOpen = (t: Pick<Task, 'status'>) => t.status === 'todo' || t.status === 'in_progress';
