import { createHash } from 'node:crypto';
import type { AppDatabase } from '../../db/database';
import type { Clock } from '../support/clock';
import { accountCallbackSchema, type AccountCallback } from '../../../shared/contracts/dailyContract';
import { saveAccountCallbackSchema, closeAccountCallbackSchema, type SaveAccountCallback, type CloseAccountCallback } from '../../../shared/contracts/accountCallbackContract';

type Row = { id: string; account_id: string; due_on: string; note: string | null; state: string; revision: number; source_command_id: string; created_at: string; updated_at: string };
const project = (row: Row): AccountCallback => accountCallbackSchema.parse({ id: row.id, accountId: row.account_id, dueOn: row.due_on,
  note: row.note, state: row.state, revision: row.revision, sourceCommandId: row.source_command_id, createdAt: row.created_at, updatedAt: row.updated_at });

/**
 * The callbacks David promised on a call (schema 29, design D13). Saving one is an
 * entirely local record: it never dials, sends, books or queues an owner command. The
 * identity is derived from the human report that created it, so re-submitting the same
 * report after an uncertain result reaches the same row instead of minting a second
 * callback. Rows are never deleted; closing one bumps its revision in place.
 */
export class AccountCallbackRepository {
  constructor(private readonly deps: { database: AppDatabase; clock: Clock }) {}
  private get raw() { return this.deps.database.raw; }
  /** A UUID-shaped id derived from the source command and the firm; a replayed save never mints a second callback. */
  static callbackId(input: { accountId: string; sourceCommandId: string }): string {
    return `callback-${createHash('sha256').update(JSON.stringify(['account_callback', input.accountId, input.sourceCommandId])).digest('hex').slice(0, 32)}`;
  }
  /** Every open callback for the named firms, earliest promise first. Corrupt rows are skipped, never guessed at. */
  listOpen(accountIds: readonly string[]): AccountCallback[] {
    const unique = [...new Set(accountIds)];
    if (unique.length === 0) return [];
    const rows = this.raw.prepare(`SELECT id,account_id,due_on,note,state,revision,source_command_id,created_at,updated_at
      FROM pm_account_callbacks WHERE state='open' AND account_id IN (SELECT value FROM json_each(?))
      ORDER BY due_on, account_id, id`).all(JSON.stringify(unique)) as Row[];
    const callbacks: AccountCallback[] = [];
    for (const row of rows) { try { callbacks.push(project(row)); } catch { /* A corrupt local row is not a promise Today can show. */ } }
    return callbacks;
  }
  get(id: string): AccountCallback | null {
    const row = this.raw.prepare(`SELECT id,account_id,due_on,note,state,revision,source_command_id,created_at,updated_at
      FROM pm_account_callbacks WHERE id=?`).get(id) as Row | undefined;
    return row ? project(row) : null;
  }
  /** Idempotent: the same report saved twice returns the same row. A different date or note for the same report is refused. */
  save(input: SaveAccountCallback): AccountCallback {
    const request = saveAccountCallbackSchema.parse(input);
    const id = AccountCallbackRepository.callbackId(request);
    const at = this.deps.clock.now();
    const existing = this.get(id);
    if (existing) {
      if (existing.accountId !== request.accountId || existing.dueOn !== request.dueOn || existing.note !== request.note
        || existing.sourceCommandId !== request.sourceCommandId) throw new Error('account_callback_conflict');
      return existing;
    }
    if (!this.raw.prepare('SELECT 1 FROM pm_accounts WHERE id=?').get(request.accountId)) throw new Error('account_callback_unknown_account');
    this.raw.prepare('INSERT INTO pm_account_callbacks(id,account_id,due_on,note,state,revision,source_command_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, request.accountId, request.dueOn, request.note, 'open', 1, request.sourceCommandId, at, at);
    return this.get(id)!;
  }
  /** Mark a promise kept or withdrawn. Never deletes, and never moves the date or the firm. */
  close(input: CloseAccountCallback): AccountCallback {
    const request = closeAccountCallbackSchema.parse(input);
    const existing = this.get(request.id);
    if (!existing) throw new Error('account_callback_missing');
    if (existing.revision !== request.expectedRevision) throw new Error('account_callback_revision_conflict');
    if (existing.state !== 'open') throw new Error('account_callback_already_closed');
    const at = this.deps.clock.now();
    const result = this.raw.prepare('UPDATE pm_account_callbacks SET state=?,revision=?,updated_at=? WHERE id=? AND revision=?')
      .run(request.state, existing.revision + 1, at < existing.createdAt ? existing.createdAt : at, request.id, request.expectedRevision);
    if (result.changes !== 1) throw new Error('account_callback_revision_conflict');
    return this.get(request.id)!;
  }
}
