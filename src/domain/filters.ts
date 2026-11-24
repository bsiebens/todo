import { uuidv7 } from './ids';
import type { Id } from './types';

/** A named search, kept in the synced `savedFilters` setting. The query uses the search syntax. */
export interface SavedFilter {
  id: Id;
  name: string;
  query: string;
}

export function parseSavedFilters(v: unknown): SavedFilter[] {
  if (!Array.isArray(v)) return [];
  return v.filter((f): f is SavedFilter => !!f && typeof f.id === 'string' && typeof f.name === 'string' && typeof f.query === 'string');
}

export function addFilter(list: SavedFilter[], name: string, query: string): { list: SavedFilter[]; id: Id } {
  const id = uuidv7();
  return { list: [...list, { id, name: name.trim() || query.trim(), query: query.trim() }], id };
}

export function updateFilter(list: SavedFilter[], id: Id, patch: Partial<Omit<SavedFilter, 'id'>>): SavedFilter[] {
  return list.map((f) => (f.id === id ? { ...f, ...patch } : f));
}

export function removeFilter(list: SavedFilter[], id: Id): SavedFilter[] {
  return list.filter((f) => f.id !== id);
}

export function moveFilter(list: SavedFilter[], id: Id, delta: -1 | 1): SavedFilter[] {
  const i = list.findIndex((f) => f.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}
