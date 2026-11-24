export type Row = Record<string, unknown>;
export interface Statement {
  sql: string;
  params?: unknown[];
}

/** Minimal async SQL interface, implemented by the browser worker and by Node for tests. */
export interface SqlDriver {
  query(sql: string, params?: unknown[]): Promise<Row[]>;
  /** Runs all statements in one transaction. */
  batch(statements: Statement[]): Promise<void>;
  /** Where data lives, for the settings screen ("OPFS", "file", "memory"). */
  readonly storage: string;
}
