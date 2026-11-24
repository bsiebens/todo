import pg from 'pg';

export type Row = Record<string, unknown>;

export interface Queryable {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Where the database is. DATABASE_URL wins when set; otherwise the standard PGHOST,
 * PGPORT, PGUSER, PGPASSWORD and PGDATABASE variables are used. Those need no URL
 * encoding, so any password works (docker-compose.yml uses them).
 */
export function dbConfig(env: NodeJS.ProcessEnv): { ok: true; config: pg.PoolConfig } | { ok: false; error: string } {
  const url = env.DATABASE_URL?.trim();
  if (url) {
    try {
      const u = new URL(url);
      if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error('not postgres');
    } catch {
      return {
        ok: false,
        error:
          'DATABASE_URL is not a valid postgres:// address. A password with characters like # / ? @ : % must be URL-encoded there; ' +
          'easier is to leave DATABASE_URL out and set PGHOST, PGUSER, PGPASSWORD and PGDATABASE instead (deploy/docker-compose.yml does this).',
      };
    }
    return { ok: true, config: { connectionString: url } };
  }
  if (env.PGHOST?.trim()) return { ok: true, config: {} }; // pg reads the PG* variables itself
  return { ok: false, error: 'No database configured: set PGHOST, PGUSER, PGPASSWORD and PGDATABASE, or DATABASE_URL. See deploy/README.md.' };
}

/** A readable hint for the usual first-start database errors. */
export function dbErrorHint(e: unknown): string | null {
  const code = (e as { code?: string }).code;
  if (code === '28P01')
    return 'Postgres refused the password. The database keeps the password it was first created with: if you changed POSTGRES_PASSWORD afterwards, change it back (or reset the database). See "Database password" in deploy/README.md.';
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Cannot reach the database. Is the db container running and healthy? (docker compose ps)';
  if (code === '3D000') return 'The database does not exist. Check PGDATABASE / POSTGRES_DB.';
  return null;
}

export function pgDb(config: string | pg.PoolConfig): Db {
  const pool = new pg.Pool({ ...(typeof config === 'string' ? { connectionString: config } : config), max: 5 });
  return {
    async query<T extends Row>(sql: string, params?: unknown[]) {
      return (await pool.query(sql, params)).rows as T[];
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn({ query: async <T extends Row>(sql: string, params?: unknown[]) => (await client.query(sql, params)).rows as T[] });
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE account (
    id uuid PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE passkey (
    id text PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES account(id),
    public_key bytea NOT NULL,
    counter bigint NOT NULL DEFAULT 0,
    transports text[] NOT NULL DEFAULT '{}',
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz
  );
  CREATE TABLE device (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES account(id),
    name text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz,
    revoked_at timestamptz
  );
  CREATE TABLE one_time_code (
    code_hash text PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES account(id),
    kind text NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at timestamptz
  );
  -- Every accepted field change, in arrival order. Devices pull "since seq N".
  CREATE TABLE op (
    seq bigserial PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES account(id),
    entity text NOT NULL,
    entity_id text NOT NULL,
    field text NOT NULL,
    value jsonb NOT NULL,
    hlc text NOT NULL,
    device_id uuid,
    received_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX op_account_seq ON op(account_id, seq);
  -- Current winning value per field: used for merging, validation and reminders.
  CREATE TABLE field_state (
    account_id uuid NOT NULL REFERENCES account(id),
    entity text NOT NULL,
    entity_id text NOT NULL,
    field text NOT NULL,
    value jsonb NOT NULL,
    hlc text NOT NULL,
    seq bigint NOT NULL,
    PRIMARY KEY (account_id, entity, entity_id, field)
  );
  CREATE INDEX field_state_task_due ON field_state(account_id, (value #>> '{}')) WHERE entity = 'task' AND field = 'due_date';
  CREATE TABLE push_sub (
    endpoint text PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES account(id),
    device_id uuid REFERENCES device(id),
    keys jsonb NOT NULL,
    tz text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE reminder_sent (
    account_id uuid NOT NULL REFERENCES account(id),
    key text NOT NULL,
    sent_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, key)
  );
  CREATE TABLE server_kv (
    key text PRIMARY KEY,
    value jsonb NOT NULL
  );
  `,
];

export async function migrate(db: Db): Promise<void> {
  await db.query('CREATE TABLE IF NOT EXISTS schema_version (version int NOT NULL)');
  await db.tx(async (q) => {
    await q.query('LOCK TABLE schema_version IN EXCLUSIVE MODE');
    const rows = await q.query<{ version: number }>('SELECT version FROM schema_version');
    let v = rows[0]?.version ?? 0;
    if (!rows.length) await q.query('INSERT INTO schema_version (version) VALUES (0)');
    for (; v < MIGRATIONS.length; v++) {
      for (const sql of MIGRATIONS[v]!.split(/;\s*$/m).map((s) => s.replace(/--.*$/gm, '').trim()).filter(Boolean)) await q.query(sql);
      await q.query('UPDATE schema_version SET version = $1', [v + 1]);
    }
  });
}

export async function getKv<T>(db: Queryable, key: string): Promise<T | null> {
  const rows = await db.query<{ value: T }>('SELECT value FROM server_kv WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

export async function setKv(db: Queryable, key: string, value: unknown): Promise<void> {
  await db.query('INSERT INTO server_kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [key, JSON.stringify(value)]);
}
