import { toDateStr } from '../domain/dates';
import { parseQuickAdd } from '../domain/quickadd';
import type { Id } from '../domain/types';
import type { Store } from './store';

/**
 * Creates a task from one line of quick-add text ("Call accountant fri 14:00 !high
 * #finance @Work/Admin"). Without an @Project it goes to `defaults.projectId`, or
 * the Inbox. Returns null when the line has no title.
 */
export async function quickAddTask(store: Store, text: string, defaults?: { projectId?: Id | null }): Promise<Id | null> {
  const r = parseQuickAdd(text, toDateStr(new Date()));
  if (!r.title) return null;
  const projectId = r.projectPath ? await store.ensureProjectPath(r.projectPath) : (defaults?.projectId ?? null);
  return store.createTask({
    title: r.title,
    priority: r.priority ?? 0,
    dueDate: r.dueDate,
    dueTime: r.dueTime,
    projectId,
    estimateMin: r.estimateMin,
    tagNames: r.tags,
    recurrence: r.rule ? { rule: r.rule, mode: r.mode } : null,
  });
}
