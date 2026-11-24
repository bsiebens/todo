import type { Dependency, Id, Task } from './types';
import { isOpen } from './types';

/** Index of "blocker blocks [blocked...]" and the reverse. */
export class DependencyGraph {
  private blocks = new Map<Id, Set<Id>>();
  private blockedBy = new Map<Id, Set<Id>>();

  constructor(deps: Iterable<Dependency>) {
    for (const d of deps) this.add(d);
  }

  add({ blockerId, blockedId }: Dependency) {
    if (!this.blocks.has(blockerId)) this.blocks.set(blockerId, new Set());
    if (!this.blockedBy.has(blockedId)) this.blockedBy.set(blockedId, new Set());
    this.blocks.get(blockerId)!.add(blockedId);
    this.blockedBy.get(blockedId)!.add(blockerId);
  }

  blockersOf(id: Id): Id[] {
    return [...(this.blockedBy.get(id) ?? [])];
  }

  dependantsOf(id: Id): Id[] {
    return [...(this.blocks.get(id) ?? [])];
  }

  /**
   * Adding "blocker blocks blocked" closes a loop if blocker can already be
   * reached from blocked by following blocks-links, or if they are the same task.
   * Returns the loop path (blocked ... blocker) when refused, else null.
   */
  findCycle(blockerId: Id, blockedId: Id): Id[] | null {
    if (blockerId === blockedId) return [blockerId];
    const prev = new Map<Id, Id>();
    const seen = new Set<Id>([blockedId]);
    const stack: Id[] = [blockedId];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const next of this.blocks.get(cur) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        prev.set(next, cur);
        if (next === blockerId) {
          const path: Id[] = [next];
          let p = cur;
          while (p !== blockedId) {
            path.unshift(p);
            p = prev.get(p)!;
          }
          path.unshift(blockedId);
          return path;
        }
        stack.push(next);
      }
    }
    return null;
  }

  wouldCreateCycle(blockerId: Id, blockedId: Id): boolean {
    return this.findCycle(blockerId, blockedId) !== null;
  }

  /** Open tasks that block this one. */
  openBlockers(id: Id, tasks: Map<Id, Task>): Task[] {
    return this.blockersOf(id)
      .map((b) => tasks.get(b))
      .filter((t): t is Task => !!t && isOpen(t));
  }

  isBlocked(id: Id, tasks: Map<Id, Task>): boolean {
    return this.openBlockers(id, tasks).length > 0;
  }

  /** All open tasks reachable downstream (this task blocks them directly or further down). */
  openDownstream(id: Id, tasks: Map<Id, Task>): Task[] {
    const out: Task[] = [];
    const seen = new Set<Id>([id]);
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const next of this.blocks.get(cur) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        const t = tasks.get(next);
        if (t && isOpen(t)) out.push(t);
        stack.push(next);
      }
    }
    return out;
  }
}
