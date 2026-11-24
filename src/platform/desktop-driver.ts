import type { Row, SqlDriver, Statement } from '../db/driver';

/**
 * The desktop app's database: a SQLite file in the app's data folder, run by the
 * Tauri side (src-tauri/src/db.rs). Same interface as the browser worker.
 */
export async function createDesktopDriver(): Promise<SqlDriver> {
  const { invoke } = await import('@tauri-apps/api/core');
  return {
    storage: 'file',
    query: (sql, params = []) => invoke<Row[]>('db_query', { sql, params }),
    batch: (statements: Statement[]) => invoke<void>('db_batch', { statements: statements.map((s) => ({ sql: s.sql, params: s.params ?? [] })) }),
  };
}
