import { describe, expect, it } from 'vitest';
import { ProjectTree } from './projects';
import { makeProject } from './testing';

const tree = new ProjectTree([
  makeProject({ id: 'w', name: 'Work', context: 'office', urgencyWeight: 1 }),
  makeProject({ id: 'c', name: 'Clients', parentId: 'w', urgencyWeight: 2 }),
  makeProject({ id: 'a', name: 'Acme', parentId: 'c' }),
  makeProject({ id: 'q', name: 'Q1 audit', parentId: 'a' }),
  makeProject({ id: 'h', name: 'Home', context: 'home' }),
]);

describe('ProjectTree', () => {
  it('builds paths at any depth', () => {
    expect(tree.path('q')).toBe('Work / Clients / Acme / Q1 audit');
    expect(tree.findByPath('work/clients/acme')?.id).toBe('a');
    expect(tree.findByPath('work/nope')).toBeUndefined();
  });

  it('refuses moving a project under itself or a descendant', () => {
    expect(tree.canMove('w', 'q')).toBe(false);
    expect(tree.canMove('c', 'c')).toBe(false);
    expect(tree.canMove('a', 'h')).toBe(true);
    expect(tree.canMove('a', null)).toBe(true);
  });

  it('inherits context and weight from the nearest ancestor', () => {
    expect(tree.effectiveContext('q')).toBe('office');
    expect(tree.effectiveWeight('q')).toBe(2);
    expect(tree.effectiveWeight('w')).toBe(1);
    expect(tree.effectiveContext(null)).toBe('any');
  });

  it('flattens depth-first', () => {
    expect(tree.flatten().map((x) => `${x.depth}${x.project.id}`)).toEqual(['0h', '0w', '1c', '2a', '3q']);
  });
});
