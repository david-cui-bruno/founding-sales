import { eventPageSchema, type EventPage } from '../../shared/contracts/delegationContract';
import type { DelegationRepository } from './delegationRepository';
import { randomUUID } from 'node:crypto';
import { accountFingerprint } from '../domain/accounts/accountEvidence';
import { accountIdSchema, accountInstantSchema } from '../../shared/contracts/accountContract';
export type SyncReport = Readonly<{ applied: number; gaps: number; cursor: string | null; ownerFresh: boolean }>;
/** A replay from the beginning is safe: C1 durably validates event identity and
 * applies each projection/cursor transactionally. No replay restores rights. */
export async function synchronizeDelegation(input: {
  repository: DelegationRepository;
  transport: SqlDelegationTransport;
  flushPending(signal: AbortSignal): Promise<void>;
  eventsAfter(cursor: string | null, signal: AbortSignal): Promise<EventPage>;
}, signal: AbortSignal): Promise<SyncReport> {
  const attempt = input.transport.begin();
  let cursor: string | null = attempt.cursor;
  let applied = 0;
  let gaps = 0;
  const finish = (complete: boolean): SyncReport => {
    try { input.transport.finish(attempt, cursor, complete); }
    catch { complete = false; }
    return { applied, gaps, cursor, ownerFresh: complete };
  };
  try {
    await input.flushPending(signal);
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      signal.throwIfAborted();
      const page = eventPageSchema.parse(await input.eventsAfter(cursor, signal));
      signal.throwIfAborted();
      for (const event of page.events) {
        const result = input.repository.applyWorkerEvent(event);
        if (result === 'applied') applied++;
        if (result === 'gap') { gaps++; return finish(false); }
      }
      if (page.complete) { cursor = page.nextCursor; return finish(true); }
      if (page.nextCursor === cursor || page.events.length === 0) return finish(false);
      cursor = page.nextCursor;
    }
  } catch { /* A failed/aborted sync is not current owner proof. */ }
  // An incomplete bounded replay cannot establish owner freshness.
  return finish(false);
}

export class SqlDelegationTransport {
  private readonly input: { database: import('../db/database').AppDatabase; workspaceId: string; pairingId: string; clock: { now(): string } };
  constructor(input: { database: import('../db/database').AppDatabase; workspaceId: string; pairingId: string; clock: { now(): string } }) {
    accountIdSchema.parse(input.workspaceId); accountIdSchema.parse(input.pairingId);
    this.input = { ...input };
  }
  private atomic<T>(run: () => T): T {
    if (this.input.database.raw.inTransaction) throw new Error('Transport requires its own transaction');
    return this.input.database.raw.transaction(run).immediate();
  }
  private validateCursor(cursor: string | null): void {
    if (cursor === null) return;
    const prefix = accountFingerprint(this.input.workspaceId);
    const match = /^([a-f0-9]{64}):([1-9][0-9]*)$/.exec(cursor);
    if (!match || match[1] !== prefix || !Number.isSafeInteger(Number(match[2]))) throw new Error('Invalid workspace transport cursor');
  }
  begin(): { revision: number; attemptId: string; cursor: string | null } {
    return this.atomic(() => {
      const previous = this.current();
      const revision = (previous?.revision ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) throw new Error('Transport revision exhausted');
      const attemptId = randomUUID(); const at = accountInstantSchema.parse(this.input.clock.now());
      const cursor = previous?.cursor ?? null; this.validateCursor(cursor);
      this.input.database.raw.prepare(`INSERT INTO delegated_transport_state(workspace_id,pairing_id,revision,cursor,completed_at,attempt_id,started_at,state)
        VALUES(?,?,?,?,NULL,?,?,'pending') ON CONFLICT(workspace_id,pairing_id) DO UPDATE SET
        revision=excluded.revision,completed_at=NULL,attempt_id=excluded.attempt_id,started_at=excluded.started_at,state='pending'`)
        .run(this.input.workspaceId, this.input.pairingId, revision, cursor, attemptId, at);
      return { revision, attemptId, cursor };
    });
  }
  current(): { state: 'pending' | 'complete' | 'failed'; completedAt: string | null; revision: number; cursor: string | null; startedAt: string } | null {
    const row = this.input.database.raw.prepare(`SELECT state,completed_at AS completedAt,revision,cursor,started_at AS startedAt
      FROM delegated_transport_state WHERE workspace_id=? AND pairing_id=?`).get(this.input.workspaceId, this.input.pairingId) as
      { state: 'pending' | 'complete' | 'failed'; completedAt: string | null; revision: number; cursor: string | null; startedAt: string } | undefined;
    if (row) this.validateCursor(row.cursor);
    return row ?? null;
  }
  finish(attempt: { revision: number; attemptId: string }, cursor: string | null, complete: boolean): void {
    this.validateCursor(cursor);
    this.atomic(() => {
      const old = this.current();
      if (old?.cursor !== null && old?.cursor !== undefined && (cursor === null || Number(cursor.split(':')[1]) < Number(old.cursor.split(':')[1]))) throw new Error('Transport cursor regression');
      const changed = this.input.database.raw.prepare(`UPDATE delegated_transport_state SET cursor=?,state=?,completed_at=?
        WHERE workspace_id=? AND pairing_id=? AND revision=? AND attempt_id=? AND state='pending'`)
        .run(cursor, complete ? 'complete' : 'failed', complete ? accountInstantSchema.parse(this.input.clock.now()) : null,
          this.input.workspaceId, this.input.pairingId, attempt.revision, attempt.attemptId);
      if (changed.changes !== 1) throw new Error('Stale transport attempt');
    });
  }
}
