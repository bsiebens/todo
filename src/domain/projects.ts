import type { Context, Id, Project } from './types';

export class ProjectTree {
  readonly byId: Map<Id, Project>;
  private children = new Map<Id | null, Project[]>();

  constructor(projects: Iterable<Project>) {
    this.byId = new Map();
    for (const p of projects) this.byId.set(p.id, p);
    for (const p of this.byId.values()) {
      const key = p.parentId && this.byId.has(p.parentId) ? p.parentId : null;
      if (!this.children.has(key)) this.children.set(key, []);
      this.children.get(key)!.push(p);
    }
    for (const list of this.children.values()) list.sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.name.localeCompare(b.name));
  }

  childrenOf(id: Id | null): Project[] {
    return this.children.get(id) ?? [];
  }

  /** Root first. Guards against a corrupt loop in stored data. */
  ancestry(id: Id): Project[] {
    const out: Project[] = [];
    const seen = new Set<Id>();
    let cur = this.byId.get(id);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      out.unshift(cur);
      cur = cur.parentId ? this.byId.get(cur.parentId) : undefined;
    }
    return out;
  }

  path(id: Id, sep = ' / '): string {
    return this.ancestry(id).map((p) => p.name).join(sep);
  }

  descendantIds(id: Id): Set<Id> {
    const out = new Set<Id>();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const c of this.childrenOf(cur)) {
        if (out.has(c.id)) continue;
        out.add(c.id);
        stack.push(c.id);
      }
    }
    return out;
  }

  /** Moving `id` under `newParentId` is refused if the new parent is itself or one of its descendants. */
  canMove(id: Id, newParentId: Id | null): boolean {
    if (newParentId === null) return true;
    if (newParentId === id) return false;
    return !this.descendantIds(id).has(newParentId);
  }

  /** Nearest explicit setting walking up the tree. */
  effectiveContext(id: Id | null): Context {
    if (!id) return 'any';
    for (const p of this.ancestry(id).reverse()) if (p.context) return p.context;
    return 'any';
  }

  effectiveWeight(id: Id | null): number {
    if (!id) return 0;
    for (const p of this.ancestry(id).reverse()) if (p.urgencyWeight !== null) return p.urgencyWeight;
    return 0;
  }

  /** Find a project by a path like "Work/Clients/Acme" (case-insensitive). */
  findByPath(path: string): Project | undefined {
    const parts = path.split('/').map((s) => s.trim().toLowerCase()).filter(Boolean);
    let parent: Id | null = null;
    let found: Project | undefined;
    for (const part of parts) {
      found = this.childrenOf(parent).find((p) => p.name.toLowerCase() === part);
      if (!found) return undefined;
      parent = found.id;
    }
    return found;
  }

  /** Depth-first flattening for tree views. */
  flatten(): { project: Project; depth: number }[] {
    const out: { project: Project; depth: number }[] = [];
    const walk = (parent: Id | null, depth: number) => {
      for (const p of this.childrenOf(parent)) {
        out.push({ project: p, depth });
        walk(p.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }
}
