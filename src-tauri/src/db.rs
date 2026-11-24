//! The task database for the desktop app: one SQLite file in the app's data folder.
//! The web side talks to it through two commands that mirror its `SqlDriver`
//! (query, and a batch run in one transaction), so the same `Store` code runs on
//! top of it. A real file survives the webview clearing its storage, and doesn't
//! depend on the webview supporting OPFS.

use std::{path::Path, sync::Mutex};

use rusqlite::{types::ValueRef, Connection, ToSql};
use serde::Deserialize;
use serde_json::{Map, Number, Value};

pub struct Db(Mutex<Connection>);

#[derive(Deserialize)]
pub struct Statement {
    sql: String,
    #[serde(default)]
    params: Vec<Value>,
}

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        // Foreign keys stay off, as in the browser: synced records can arrive before the records they point to.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(Db(Mutex::new(conn)))
    }

    #[cfg(test)]
    pub fn memory() -> Self {
        Db(Mutex::new(Connection::open_in_memory().unwrap()))
    }

    pub fn query(&self, sql: &str, params: &[Value]) -> Result<Vec<Map<String, Value>>, String> {
        let conn = self.0.lock().map_err(|e| e.to_string())?;
        query(&conn, sql, params).map_err(|e| e.to_string())
    }

    pub fn batch(&self, statements: &[Statement]) -> Result<(), String> {
        let mut conn = self.0.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for s in statements {
            run(&tx, &s.sql, &s.params).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }
}

/// JSON parameters as SQLite values, the way SQLite WASM binds them: booleans become 0 or 1.
fn bind(v: &Value) -> Box<dyn ToSql> {
    match v {
        Value::Null => Box::new(rusqlite::types::Null),
        Value::Bool(b) => Box::new(*b as i64),
        Value::Number(n) => match n.as_i64() {
            Some(i) => Box::new(i),
            None => Box::new(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => Box::new(s.clone()),
        other => Box::new(other.to_string()),
    }
}

fn run(conn: &Connection, sql: &str, params: &[Value]) -> rusqlite::Result<()> {
    // A statement that returns rows (RETURNING, PRAGMA) can't go through execute().
    let mut stmt = conn.prepare(sql)?;
    let bound: Vec<Box<dyn ToSql>> = params.iter().map(bind).collect();
    let refs: Vec<&dyn ToSql> = bound.iter().map(|b| b.as_ref()).collect();
    let mut rows = stmt.query(refs.as_slice())?;
    while rows.next()?.is_some() {}
    Ok(())
}

fn query(conn: &Connection, sql: &str, params: &[Value]) -> rusqlite::Result<Vec<Map<String, Value>>> {
    let mut stmt = conn.prepare(sql)?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let bound: Vec<Box<dyn ToSql>> = params.iter().map(bind).collect();
    let refs: Vec<&dyn ToSql> = bound.iter().map(|b| b.as_ref()).collect();
    let mut rows = stmt.query(refs.as_slice())?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut obj = Map::with_capacity(names.len());
        for (i, name) in names.iter().enumerate() {
            let v = match row.get_ref(i)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) => Value::Number(n.into()),
                ValueRef::Real(f) => Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null),
                ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
                ValueRef::Blob(b) => Value::Array(b.iter().map(|x| Value::Number((*x).into())).collect()),
            };
            obj.insert(name.clone(), v);
        }
        out.push(obj);
    }
    Ok(out)
}

#[tauri::command]
pub async fn db_query(db: tauri::State<'_, Db>, sql: String, params: Option<Vec<Value>>) -> Result<Vec<Map<String, Value>>, String> {
    db.query(&sql, params.as_deref().unwrap_or(&[]))
}

#[tauri::command]
pub async fn db_batch(db: tauri::State<'_, Db>, statements: Vec<Statement>) -> Result<(), String> {
    db.batch(&statements)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trips_values_and_rolls_back_failed_batches() {
        let db = Db::memory();
        db.batch(&[Statement { sql: "CREATE TABLE t (a TEXT, b INTEGER, c REAL, d TEXT)".into(), params: vec![] }]).unwrap();
        db.batch(&[Statement { sql: "INSERT INTO t VALUES (?, ?, ?, ?)".into(), params: vec![json!("x"), json!(true), json!(1.5), Value::Null] }])
            .unwrap();
        let rows = db.query("SELECT * FROM t WHERE a = ?", &[json!("x")]).unwrap();
        assert_eq!(Value::Object(rows[0].clone()), json!({"a": "x", "b": 1, "c": 1.5, "d": null}));

        let bad = db.batch(&[
            Statement { sql: "INSERT INTO t (a) VALUES ('y')".into(), params: vec![] },
            Statement { sql: "INSERT INTO nope VALUES (1)".into(), params: vec![] },
        ]);
        assert!(bad.is_err());
        assert_eq!(db.query("SELECT count(*) AS n FROM t", &[]).unwrap()[0]["n"], json!(1));
    }

    #[test]
    fn batch_accepts_statements_that_return_rows() {
        let db = Db::memory();
        db.batch(&[
            Statement { sql: "CREATE TABLE k (key TEXT PRIMARY KEY, value TEXT)".into(), params: vec![] },
            Statement { sql: "INSERT INTO k VALUES ('node', lower(hex(randomblob(8)))) RETURNING value".into(), params: vec![] },
        ])
        .unwrap();
        assert_eq!(db.query("SELECT length(value) AS n FROM k", &[]).unwrap()[0]["n"], json!(16));
    }
}
