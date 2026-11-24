import type { SqlDriver } from './driver';
import { MIGRATIONS } from './schema';

export async function migrate(db: SqlDriver): Promise<void> {
  const rows = await db.query('PRAGMA user_version');
  const current = Number(rows[0]?.user_version ?? 0);
  for (let v = current; v < MIGRATIONS.length; v++) {
    const m = MIGRATIONS[v]!;
    const sqls = Array.isArray(m)
      ? m
      : m
          .split(/;\s*$/m)
          .map((s) => s.replace(/--.*$/gm, '').trim())
          .filter(Boolean);
    const statements = sqls.map((sql) => ({ sql }));
    statements.push({ sql: `PRAGMA user_version = ${v + 1}` });
    await db.batch(statements);
  }
}
