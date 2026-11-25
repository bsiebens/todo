import { ENTITIES, type EntityName } from '../sync/protocol';

/** Fields added after migration 2, by the migration that adds them. Migration 2 must not mention them. */
const LATER_FIELDS: Record<string, string[]> = { task: ['focus_date'] };

const QUIET = 'WHEN (SELECT applying FROM sync_flag) = 0';
const INS = 'INSERT INTO sync_outbox (entity, entity_id, field, value)';

/** Insert and update triggers that queue each changed field of a row entity. */
function rowTriggers(name: EntityName, cols: string[]): string[] {
  const ent = ENTITIES[name];
  const values = cols.map((c) => `('${name}', new.id, '${c}', json_quote(new.${c}))`).join(', ');
  const updates = cols.map((c) => `${INS} SELECT '${name}', new.id, '${c}', json_quote(new.${c}) WHERE old.${c} IS NOT new.${c};`).join(' ');
  return [
    `CREATE TRIGGER sync_${ent.table}_ins AFTER INSERT ON ${ent.table} ${QUIET} BEGIN ${INS} VALUES ${values}; END`,
    `CREATE TRIGGER sync_${ent.table}_upd AFTER UPDATE ON ${ent.table} ${QUIET} BEGIN ${updates} END`,
  ];
}

/** Migration 3: task.focus_date, so a Focus star only counts on the day it was given. */
export function focusDateMigration(): string[] {
  return [
    'ALTER TABLE task ADD COLUMN focus_date TEXT',
    'DROP TRIGGER IF EXISTS sync_task_ins',
    'DROP TRIGGER IF EXISTS sync_task_upd',
    ...rowTriggers('task', Object.keys(ENTITIES.task.fields)),
  ];
}

/**
 * Migration 2: sync bookkeeping. Triggers on every synced table write one row per
 * changed field into sync_outbox. The Store stamps those rows with a clock in the
 * same transaction. While remote changes are applied, sync_flag.applying = 1 and the
 * triggers stay quiet.
 */
export function syncMigration(): string[] {
  const out: string[] = [
    'CREATE TABLE sync_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, entity_id TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL, hlc TEXT)',
    'CREATE TABLE field_clock (entity TEXT NOT NULL, entity_id TEXT NOT NULL, field TEXT NOT NULL, hlc TEXT NOT NULL, PRIMARY KEY (entity, entity_id, field)) WITHOUT ROWID',
    'CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    'CREATE TABLE sync_flag (applying INTEGER NOT NULL)',
    'INSERT INTO sync_flag (applying) VALUES (0)',
    "INSERT INTO sync_state (key, value) VALUES ('node', lower(hex(randomblob(8))))",
    // Two offline devices may each create a tag with the same name; a unique index would make the merge fail.
    'DROP INDEX IF EXISTS tag_name',
    'CREATE INDEX tag_name ON tag(lower(name))',
    // The phase-2 change log is replaced by sync_outbox.
    'DROP TABLE IF EXISTS change_log',
  ];
  const quiet = QUIET;
  const ins = INS;

  for (const [name, ent] of Object.entries(ENTITIES) as [EntityName, (typeof ENTITIES)[EntityName]][]) {
    if (ent.kind === 'row') {
      const later = LATER_FIELDS[name] ?? [];
      const cols = Object.keys(ent.fields).filter((c) => !later.includes(c));
      out.push(...rowTriggers(name, cols));
      // Existing data from before sync is queued once, so the first sign-in uploads it.
      out.push(`${ins} ${cols.map((c) => `SELECT '${name}', id, '${c}', json_quote(${c}) FROM ${ent.table}`).join(' UNION ALL ')}`);
    } else if (ent.kind === 'set') {
      const [a, b] = ent.columns;
      out.push(`CREATE TRIGGER sync_${ent.table}_ins AFTER INSERT ON ${ent.table} ${quiet} BEGIN ${ins} VALUES ('${name}', new.${a} || ':' || new.${b}, 'present', 'true'); END`);
      out.push(`CREATE TRIGGER sync_${ent.table}_del AFTER DELETE ON ${ent.table} ${quiet} BEGIN ${ins} VALUES ('${name}', old.${a} || ':' || old.${b}, 'present', 'false'); END`);
      out.push(`${ins} SELECT '${name}', ${a} || ':' || ${b}, 'present', 'true' FROM ${ent.table}`);
    } else {
      out.push(`CREATE TRIGGER sync_${ent.table}_ins AFTER INSERT ON ${ent.table} ${quiet} BEGIN ${ins} VALUES ('${name}', new.key, 'value', json_quote(new.value)); END`);
      out.push(`CREATE TRIGGER sync_${ent.table}_upd AFTER UPDATE ON ${ent.table} ${quiet} BEGIN ${ins} SELECT '${name}', new.key, 'value', json_quote(new.value) WHERE old.value IS NOT new.value; END`);
      out.push(`${ins} SELECT '${name}', key, 'value', json_quote(value) FROM ${ent.table}`);
    }
  }
  return out;
}
