import { isOpen, type Task } from './types';

/**
 * Focus is today's list. A star only counts on the day it was given, so Focus
 * starts empty each morning. Tasks in progress always count.
 */
export const pickedToday = (t: Task, today: string) => t.focus && t.focusDate === today;

export const inFocus = (t: Task, today: string) => isOpen(t) && (pickedToday(t, today) || t.status === 'in_progress');

/** Starred on an earlier day and still open: offered first when planning today. */
export const carriedOver = (t: Task, today: string) => isOpen(t) && t.status === 'todo' && t.focus && t.focusDate !== today;
