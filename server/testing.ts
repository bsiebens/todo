import { PGlite } from '@electric-sql/pglite';
import type { Db, Row } from './db';

/** Postgres in WebAssembly, for tests: no database server needed. */
export async function testDb(): Promise<Db> {
  const pg = new PGlite();
  const wrap = (q: Pick<PGlite, 'query'>) => ({
    query: async <T extends Row>(sql: string, params?: unknown[]) => (await q.query<T>(sql, params as never)).rows,
  });
  // PGlite runs one transaction at a time, so queue them.
  let chain: Promise<unknown> = Promise.resolve();
  return {
    ...wrap(pg),
    tx<T>(fn: (q: { query: Db['query'] }) => Promise<T>): Promise<T> {
      const run = chain.then(() => pg.transaction((tx) => fn(wrap(tx))));
      chain = run.catch(() => {});
      return run as Promise<T>;
    },
    close: () => pg.close(),
  };
}
