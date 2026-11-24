/// <reference lib="webworker" />
// Runs SQLite in a worker, stored in the Origin Private File System (OPFS).
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

type Req = { id: number; kind: 'query'; sql: string; params?: unknown[] } | { id: number; kind: 'batch'; statements: { sql: string; params?: unknown[] }[] };

const ready = (async () => {
  const sqlite3 = await sqlite3InitModule();
  let db;
  let storage = 'OPFS';
  try {
    const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'todo-pool' });
    db = new pool.OpfsSAHPoolDb('/todo.sqlite3');
  } catch (e) {
    console.warn('OPFS not available, data will not persist', e);
    db = new sqlite3.oo1.DB(':memory:', 'c');
    storage = 'memory';
  }
  db.exec('PRAGMA foreign_keys = ON');
  return { db, storage };
})();

ready.then(({ storage }) => postMessage({ id: 0, storage })).catch((e) => postMessage({ id: 0, error: String(e) }));

onmessage = async (ev: MessageEvent<Req>) => {
  const req = ev.data;
  try {
    const { db } = await ready;
    if (req.kind === 'query') {
      const rows = db.exec({ sql: req.sql, bind: (req.params ?? []) as never, rowMode: 'object', returnValue: 'resultRows' });
      postMessage({ id: req.id, rows });
    } else {
      db.transaction(() => {
        for (const s of req.statements) db.exec({ sql: s.sql, bind: (s.params ?? []) as never });
      });
      postMessage({ id: req.id, rows: [] });
    }
  } catch (e) {
    postMessage({ id: req.id, error: e instanceof Error ? e.message : String(e) });
  }
};
