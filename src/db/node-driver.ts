// Test-only driver: SQLite WASM in memory under Node.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { Row, SqlDriver, Statement } from './driver';

export async function createMemoryDriver(): Promise<SqlDriver> {
  const sqlite3 = await sqlite3InitModule();
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  // Foreign keys stay off: synced records can arrive before the records they point to.
  return {
    storage: 'memory',
    async query(sql, params = []) {
      return db.exec({ sql, bind: params as never, rowMode: 'object', returnValue: 'resultRows' }) as Row[];
    },
    async batch(statements: Statement[]) {
      db.transaction(() => {
        for (const s of statements) db.exec({ sql: s.sql, bind: (s.params ?? []) as never });
      });
    },
  };
}
