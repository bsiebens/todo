import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyScore } from './fuzzy';
import { addFilter, moveFilter, parseSavedFilters, removeFilter, updateFilter } from './filters';

describe('fuzzyScore', () => {
  it('matches characters in order and rejects others', () => {
    expect(fuzzyScore('gtu', 'Go to Upcoming')).not.toBeNull();
    expect(fuzzyScore('xyz', 'Go to Upcoming')).toBeNull();
  });
  it('ranks substrings and word starts first', () => {
    const items = ['Settings', 'Go to Upcoming', 'Set priority: High', 'Start task'];
    expect(fuzzyFilter('set', items, (x) => x)).toEqual(['Settings', 'Set priority: High']);
    expect(fuzzyFilter('up', items, (x) => x)[0]).toBe('Go to Upcoming');
  });
  it('returns everything (capped) for an empty query', () => {
    expect(fuzzyFilter('', [1, 2, 3], String, 2)).toEqual([1, 2]);
  });
});

describe('saved filters', () => {
  it('adds, renames, moves and removes', () => {
    let { list, id } = addFilter([], 'Due this week', ' due<7d ');
    expect(list).toEqual([{ id, name: 'Due this week', query: 'due<7d' }]);
    const b = addFilter(list, '', '#finance');
    list = b.list;
    expect(list[1]!.name).toBe('#finance');
    list = updateFilter(list, id, { name: 'This week' });
    list = moveFilter(list, b.id, -1);
    expect(list.map((f) => f.name)).toEqual(['#finance', 'This week']);
    expect(removeFilter(list, id)).toHaveLength(1);
  });
  it('ignores malformed stored values', () => {
    expect(parseSavedFilters([{ id: 'a', name: 'x', query: 'y' }, { id: 1 }, null])).toHaveLength(1);
    expect(parseSavedFilters('nope')).toEqual([]);
  });
});
