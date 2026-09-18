import { validateCompanyResearchConfiguration } from '../research/companyResearchConfiguration';
import { eventPageSchema, type EventPage } from '../../shared/contracts/delegationContract';
import type { DelegationRepository } from './delegationRepository';
import { randomUUID } from 'node:crypto';
import { accountFingerprint } from '../domain/accounts/accountEvidence';
import { accountIdSchema, accountInstantSchema } from '../../shared/contracts/accountContract';
import { syncFailureSchema, SYNC_BUDGET_SECONDS } from '../../shared/contracts/ownerCommandContract';
import { z } from 'zod';
export type SyncFailure = z.infer<typeof syncFailureSchema>;
export type SyncReport = Readonly<{ applied: number; gaps: number; cursor: string | null; ownerFresh: boolean; failure: SyncFailure; detail: string | null }>;
/** One bounded sentence naming the stage that stopped a run and the error it raised. Messages here are SQLite, schema or
 * HTTP wording from this process; they never carry a credential, and the report is the only place David can read them. */
const describeStop = (stage: string, error: unknown): string => `${stage}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400);
/** One worker request. The page size the worker serves is chosen so a page always fits here. */
export const SYNC_REQUEST_TIMEOUT_MS = 15_000;
/** One whole run: the launch sync, the five-minute background sync and the Sync now button all get this.
 * The 835-event backlog David accumulated by 18 Sep needs five pages; a flat 15 s on the whole run aborted
 * page one every time and reported "Applied: 0. Gaps: 0. Owner fresh: no" while nothing moved. */
export const SYNC_BUDGET_MS = SYNC_BUDGET_SECONDS * 1_000;
/** A replay from the beginning is safe: C1 durably validates event identity and
 * applies each projection/cursor transactionally. No replay restores rights. */
export async function synchronizeDelegation(input: {
  repository: DelegationRepository;
  transport: SqlDelegationTransport;
  flushPending(signal: AbortSignal): Promise<void>;
  reconcilePending?(signal: AbortSignal): Promise<boolean>;
  eventsAfter(cursor: string | null, signal: AbortSignal): Promise<EventPage>;
}, signal: AbortSignal): Promise<SyncReport> {
  const attempt = input.transport.begin();
  let cursor: string | null = attempt.cursor;
  let applied = 0;
  let gaps = 0;
  let failure: SyncFailure = null;
  let detail: string | null = null;
  const finish = (complete: boolean): SyncReport => {
    try { input.transport.finish(attempt, cursor, complete); }
    catch (error) { complete = false; failure ??= 'transport'; detail ??= describeStop('recording the sync result', error); }
    return { applied, gaps, cursor, ownerFresh: complete, failure: complete ? null : failure ?? 'transport', detail: complete ? null : detail };
  };
  // Each complete page is checkpointed while the attempt stays pending, so an abort on page seven
  // resumes at page seven rather than page one even if the closing record write is itself lost.
  const checkpoint = () => {
    try { input.transport.checkpoint(attempt, cursor); }
    catch (error) { failure ??= 'transport'; detail ??= describeStop('saving the cursor', error); /* finish() still tries to record the cursor it reached. */ }
  };
  try {
    try { await input.flushPending(signal); }
    catch { signal.throwIfAborted(); /* Outbox refusal must not starve owner events. */ }
    let reconciled = false;
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      signal.throwIfAborted();
      let raw: EventPage;
      try { raw = await input.eventsAfter(cursor, signal); }
      catch (error) { failure = signal.aborted ? 'timeout' : 'transport'; detail = describeStop(`fetching the page after ${cursor ?? 'the start'}`, error); throw error; }
      let page: EventPage;
      try { page = eventPageSchema.parse(raw); }
      catch (error) { failure = 'invalid_event'; detail = describeStop(`reading the page after ${cursor ?? 'the start'}`, error); throw error; }
      signal.throwIfAborted();
      for (const event of page.events) {
        let result: 'applied' | 'duplicate' | 'gap';
        try { result = input.repository.applyWorkerEvent(event); }
        catch (error) {
          // A local refusal is not a transport fault: name the event so the cause is readable from the report line.
          failure = 'apply'; detail = describeStop(`recording ${event.kind} (aggregate ${event.aggregateVersion}) for ${event.accountId.slice(0, 24)}`, error);
          return finish(false);
        }
        if (result === 'applied') applied++;
        if (result === 'gap') { gaps++; failure = 'gap'; return finish(false); }
      }
      if (page.complete) {
        cursor = page.nextCursor;
        checkpoint();
        if (!reconciled && input.reconcilePending) {
          reconciled = true;
          if (await input.reconcilePending(signal)) continue;
        }
        return finish(true);
      }
      if (page.nextCursor === cursor || page.events.length === 0) { failure ??= 'transport'; detail ??= `the worker served an empty page after ${cursor ?? 'the start'} while reporting more events`; return finish(false); }
      cursor = page.nextCursor;
      checkpoint();
    }
    failure ??= 'transport'; detail ??= 'the page budget ran out before the head'; /* The bounded page budget ran out before the head. */
  } catch (error) { failure ??= signal.aborted ? 'timeout' : 'transport'; detail ??= describeStop('the run', error); /* A failed/aborted sync is not current owner proof. */ }
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
  /** Advances the cursor of the attempt that is still running. The attempt stays `pending`, so the
   * daily footer keeps reading a run in flight as in flight; only finish() settles it. */
  checkpoint(attempt: { revision: number; attemptId: string }, cursor: string | null): void {
    this.validateCursor(cursor);
    if (cursor === null) return;
    this.atomic(() => {
      const old = this.current();
      if (old?.cursor && Number(cursor.split(':')[1]) < Number(old.cursor.split(':')[1])) throw new Error('Transport cursor regression');
      const changed = this.input.database.raw.prepare(`UPDATE delegated_transport_state SET cursor=?
        WHERE workspace_id=? AND pairing_id=? AND revision=? AND attempt_id=? AND state='pending'`)
        .run(cursor, this.input.workspaceId, this.input.pairingId, attempt.revision, attempt.attemptId);
      if (changed.changes !== 1) throw new Error('Stale transport attempt');
    });
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

import { configureLocalDelegationSchema, localDelegationConfigurationRecordSchema, type LocalDelegationConfiguration } from '../../shared/contracts/ownerCommandContract';
/** Schema23 paired configuration only. This never admits a budget or execution owner. */
export class SqlDelegationConfiguration {
  private readonly input: { database: import('../db/database').AppDatabase; workspaceId: string; pairingId: string; clock: { now(): string } };
  constructor(input: { database: import('../db/database').AppDatabase; workspaceId: string; pairingId: string; clock: { now(): string } }) {
    accountIdSchema.parse(input.workspaceId); accountIdSchema.parse(input.pairingId); this.input={...input};
  }
  read(): {revision:number;configuration:LocalDelegationConfiguration;updatedAt:string}|null {
    const row=this.input.database.raw.prepare('SELECT revision,configuration_json,updated_at FROM delegated_local_configuration WHERE workspace_id=? AND pairing_id=?')
      .get(this.input.workspaceId,this.input.pairingId) as {revision:number;configuration_json:string;updated_at:string}|undefined;
    if(!row)return null;
    const result=localDelegationConfigurationRecordSchema.parse({revision:row.revision,configuration:JSON.parse(row.configuration_json),updatedAt:row.updated_at});
    if(result.configuration.research && result.configuration.research.workspaceId!==this.input.workspaceId)throw new Error('Configuration workspace mismatch');
    return result;
  }
  configure(raw:{expectedRevision:number;configuration:LocalDelegationConfiguration}) {
    const input=configureLocalDelegationSchema.parse(raw); const db=this.input.database.raw;
    if(db.inTransaction)throw new Error('Configuration requires its own transaction');
    return db.transaction(()=>{
      const previous=this.read(); if((previous?.revision??0)!==input.expectedRevision)throw new Error('Stale configuration revision');
      if(input.configuration.research && input.configuration.research.workspaceId!==this.input.workspaceId)throw new Error('Configuration workspace mismatch');
      if(input.configuration.state==='active' && input.configuration.research)validateCompanyResearchConfiguration(input.configuration.research);
      const at=accountInstantSchema.parse(this.input.clock.now());
      db.prepare(`INSERT INTO delegated_local_configuration VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,pairing_id)
        DO UPDATE SET revision=excluded.revision,configuration_json=excluded.configuration_json,updated_at=excluded.updated_at`)
        .run(this.input.workspaceId,this.input.pairingId,input.expectedRevision+1,JSON.stringify(input.configuration),at);
      return this.read()!;
    }).immediate();
  }
}
