import type { Row, SqlDriver, Statement } from './driver';

export function createWorkerDriver(): Promise<SqlDriver> {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  let nextId = 1;
  const pending = new Map<number, { resolve: (rows: Row[]) => void; reject: (e: Error) => void }>();

  return new Promise((resolveInit, rejectInit) => {
    worker.onmessage = (ev) => {
      const { id, rows, error, storage } = ev.data as { id: number; rows?: Row[]; error?: string; storage?: string };
      if (id === 0) {
        if (error) return rejectInit(new Error(error));
        const driver: SqlDriver = {
          storage: storage ?? 'unknown',
          query(sql, params) {
            return send({ kind: 'query', sql, params });
          },
          async batch(statements: Statement[]) {
            await send({ kind: 'batch', statements });
          },
        };
        return resolveInit(driver);
      }
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve(rows ?? []);
    };
    worker.onerror = (e) => rejectInit(new Error(e.message));
  });

  function send(msg: Record<string, unknown>): Promise<Row[]> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, ...msg });
    });
  }
}
