import { DependencyGraph } from '../src/domain/dependencies';
import { Hlc } from '../src/sync/hlc';
import { splitSetId, validateOp, type Op, type PullResponse, type PushResponse, type Rejected } from '../src/sync/protocol';
import type { Db, Queryable } from './db';

type State = {
  value: unknown;
  hlc: string;
};

/**
 * Merges pushed changes: per field, the later clock wins. Two rules span records and
 * are checked here, because two offline devices can each make a valid change that
 * together is not: a dependency loop and a project moved inside itself. The change
 * that would close the loop is undone by a newer server change, which every device
 * (the sender too) pulls.
 */
export class SyncService {
  constructor(
    private db: Db,
    readonly clock: Hlc = new Hlc('server'),
  ) {}

  async push(accountId: string, deviceId: string, ops: unknown[]): Promise<PushResponse & { changed: boolean }> {
    const rejected: Rejected[] = [];
    let accepted = 0;
    let changed = false;
    await this.db.tx(async (q) => {
      // One push at a time per account, so the loop checks see a consistent state.
      await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [accountId]);
      let deps: DependencyGraph | null = null;
      let parents: Map<string, string | null> | null = null;

      for (const raw of ops) {
        const reason = validateOp(raw);
        if (reason) {
          rejected.push({ op: raw as Op, reason: 'invalid', message: reason });
          continue;
        }
        const op = raw as Op;
        this.clock.observe(op.hlc);
        const value = JSON.parse(op.value) as unknown;
        const state = await this.state(q, accountId, op);
        if (state && state.hlc >= op.hlc) {
          accepted++; // already have it, or a newer value
          continue;
        }

        if (op.entity === 'dependency' && value === true) {
          deps ??= await this.loadDeps(q, accountId);
          const [blocker, blocked] = splitSetId(op.id)!;
          if (deps.findCycle(blocker, blocked)) {
            await this.write(q, accountId, null, { ...op, value: 'false', hlc: this.clock.now() });
            rejected.push({ op, reason: 'cycle', message: 'This link was undone because it created a loop.' });
            changed = true;
            continue;
          }
          deps.add({ blockerId: blocker, blockedId: blocked });
        }
        if (op.entity === 'dependency' && value === false && deps) {
          deps = null; // reload on next use
        }
        if (op.entity === 'project' && op.field === 'parent_id') {
          parents ??= await this.loadParents(q, accountId);
          if (typeof value === 'string' && createsProjectLoop(parents, op.id, value)) {
            await this.write(q, accountId, null, { ...op, value: JSON.stringify(state?.value ?? null), hlc: this.clock.now() });
            rejected.push({ op, reason: 'project_cycle', message: 'This move was undone because it put a project inside itself.' });
            changed = true;
            continue;
          }
          parents.set(op.id, (value as string | null) ?? null);
        }

        await this.write(q, accountId, deviceId, op);
        accepted++;
        changed = true;
      }
    });
    return { accepted, rejected, hlc: this.clock.now(), changed };
  }

  async pull(accountId: string, deviceId: string, since: number, limit = 1000): Promise<PullResponse> {
    const rows = await this.db.query<{ seq: string; entity: string; entity_id: string; field: string; value: unknown; hlc: string; device_id: string | null }>(
      'SELECT seq, entity, entity_id, field, value, hlc, device_id FROM op WHERE account_id = $1 AND seq > $2 ORDER BY seq LIMIT $3',
      [accountId, since, limit],
    );
    const cursor = rows.length ? Number(rows[rows.length - 1]!.seq) : since;
    return {
      ops: rows
        .filter((r) => r.device_id !== deviceId)
        .map((r) => ({ seq: Number(r.seq), entity: r.entity as Op['entity'], id: r.entity_id, field: r.field, value: JSON.stringify(r.value), hlc: r.hlc })),
      cursor,
      more: rows.length === limit,
    };
  }

  /** Drops log entries that a later change to the same field has replaced. Safe for any cursor. */
  async compact(): Promise<number> {
    const rows = await this.db.query(
      'DELETE FROM op o USING field_state f WHERE o.account_id = f.account_id AND o.entity = f.entity AND o.entity_id = f.entity_id AND o.field = f.field AND o.seq < f.seq RETURNING 1',
    );
    return rows.length;
  }

  private async state(q: Queryable, accountId: string, op: Op): Promise<State | null> {
    const rows = await q.query<State>('SELECT value, hlc FROM field_state WHERE account_id = $1 AND entity = $2 AND entity_id = $3 AND field = $4', [accountId, op.entity, op.id, op.field]);
    return rows[0] ?? null;
  }

  private async write(q: Queryable, accountId: string, deviceId: string | null, op: Op): Promise<void> {
    const [row] = await q.query<{ seq: string }>(
      'INSERT INTO op (account_id, entity, entity_id, field, value, hlc, device_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING seq',
      [accountId, op.entity, op.id, op.field, op.value, op.hlc, deviceId],
    );
    await q.query(
      `INSERT INTO field_state (account_id, entity, entity_id, field, value, hlc, seq) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (account_id, entity, entity_id, field) DO UPDATE SET value = excluded.value, hlc = excluded.hlc, seq = excluded.seq`,
      [accountId, op.entity, op.id, op.field, op.value, op.hlc, row!.seq],
    );
  }

  private async loadDeps(q: Queryable, accountId: string): Promise<DependencyGraph> {
    const rows = await q.query<{ entity_id: string }>(
      "SELECT entity_id FROM field_state WHERE account_id = $1 AND entity = 'dependency' AND field = 'present' AND value = 'true'::jsonb",
      [accountId],
    );
    const deps = rows.map((r) => splitSetId(r.entity_id)).filter((p): p is [string, string] => !!p);
    return new DependencyGraph(deps.map(([blockerId, blockedId]) => ({ blockerId, blockedId })));
  }

  private async loadParents(q: Queryable, accountId: string): Promise<Map<string, string | null>> {
    const rows = await q.query<{ entity_id: string; value: unknown }>(
      "SELECT entity_id, value FROM field_state WHERE account_id = $1 AND entity = 'project' AND field = 'parent_id'",
      [accountId],
    );
    return new Map(rows.map((r) => [r.entity_id, typeof r.value === 'string' ? r.value : null]));
  }
}

export function createsProjectLoop(parents: Map<string, string | null>, id: string, newParent: string): boolean {
  const seen = new Set<string>();
  for (let cur: string | null | undefined = newParent; cur; cur = parents.get(cur)) {
    if (cur === id) return true;
    if (seen.has(cur)) return false; // existing corrupt loop elsewhere; not this change's fault
    seen.add(cur);
  }
  return false;
}
