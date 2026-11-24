import { describe, expect, it } from 'vitest';
import { dbConfig, dbErrorHint } from './db';

describe('database settings', () => {
  it('uses the PG* variables so any password works', () => {
    expect(dbConfig({ PGHOST: 'db', PGPASSWORD: 'p@ss#w/rd?:%$' })).toEqual({ ok: true, config: {} });
  });

  it('explains an unencoded password in DATABASE_URL instead of crashing', () => {
    const r = dbConfig({ DATABASE_URL: 'postgres://todo:ab#c/d@db:5432/todo' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/URL-encoded/);
  });

  it('accepts a valid DATABASE_URL and reports a missing database', () => {
    expect(dbConfig({ DATABASE_URL: 'postgres://todo:secret@db:5432/todo' })).toEqual({ ok: true, config: { connectionString: 'postgres://todo:secret@db:5432/todo' } });
    expect(dbConfig({}).ok).toBe(false);
  });

  it('gives a hint for a refused password', () => {
    expect(dbErrorHint({ code: '28P01' })).toMatch(/first created/);
  });
});
