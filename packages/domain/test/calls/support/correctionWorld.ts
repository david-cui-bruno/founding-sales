import { randomUUID } from 'node:crypto';
import type { CallCorrectionDecision, CallCorrectionEffect, CallOutcome, CorrectionPreviewResponse, DoNotCallChoice } from '@fss/contracts';
import {
  correctCallOutcome,
  previewOutcomeCorrection,
  type CorrectOutcomeInput,
  type CorrectionResult,
} from '../../../calls/correctOutcome.ts';
import type { CorrectCallOutcomeResult } from '@fss/contracts';
import { withTransaction, type SessionQueryable } from '../../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../../db/workspaceScope.ts';
import { logCallOutcome, type LogCallOutcomeInput } from '../../../dial/calls.ts';
import { recordingSuppressionJournal, type RecordingSuppressionJournal } from '../../../suppression/journal.ts';
import type { ApplyWorld, PlacedCall, TestFirm } from './applyWorld.ts';
import { lines } from '../analysisFixtures.ts';

/**
 * Helpers the S3X outcome-correction tests share, on top of lane B's apply world: logging
 * through the real `logCallOutcome`, the preview, and the correction with the conflicting set
 * echoed back with a decision per effect — exactly what the desktop's review sends.
 */

export const QUIET_CALL = lines(['Y', 'Hi, this is David from Callie.'], ['T', 'Hello?']);

/**
 * David as he is in production: the one member, the firm's assignee, the person who made the
 * call, and the workspace's admin (DESIGN-S3X §1.2). The salesperson user with the admin role,
 * so the calls he placed are his and a stop's follow-up lift is open to him.
 */
export function david(world: ApplyWorld, db: SessionQueryable = world.session): RepositoryContext {
  return repositoryContext(
    workspaceScope(world.seeded.alpha.workspaceId, { kind: 'user', userId: world.seeded.alpha.salesperson.userId, role: 'admin' }),
    db,
  );
}

/** Log a call from the form (no session), as the salesperson (or `as`). */
export async function logFormCall(
  world: ApplyWorld,
  firm: TestFirm,
  outcome: CallOutcome,
  extra: Partial<LogCallOutcomeInput> = {},
  db: SessionQueryable = world.session,
  as?: (db: SessionQueryable) => RepositoryContext,
): Promise<string> {
  const logged = await withTransaction(db, async () =>
    await logCallOutcome((as ?? world.salesperson)(db), {
      firmId: firm.firmId,
      contactId: firm.contactId,
      routeId: firm.routeId,
      outcome,
      commandId: `form-${randomUUID()}`,
      journal: recordingSuppressionJournal(),
      ...extra,
    }),
  );
  if (!logged.ok) throw new Error(`logCallOutcome: ${logged.reason}`);
  return logged.value.callLogId;
}

/** Log the outcome of a placed call (linked to its session), as the salesperson. */
export async function logPlacedCall(
  world: ApplyWorld,
  call: PlacedCall,
  outcome: CallOutcome,
  extra: Partial<LogCallOutcomeInput> = {},
  db: SessionQueryable = world.session,
): Promise<string> {
  return await logFormCall(world, call.firm, outcome, { routeId: undefined, contactId: undefined, callSessionId: call.sessionId, ...extra }, db);
}

export async function preview(
  world: ApplyWorld,
  callLogId: string,
  outcome: CallOutcome,
  context?: RepositoryContext,
): Promise<CorrectionPreviewResponse> {
  const answered = await previewOutcomeCorrection(context ?? world.salesperson(), { callLogId, outcome });
  if (!answered.ok) throw new Error(`preview: ${answered.reason}`);
  return answered.value;
}

export type Decide = (effect: CallCorrectionEffect) => CallCorrectionDecision;

/** Keep everything that can be kept; undo what can only be undone. */
export const keepAll: Decide = effect => (effect.decisions.includes('keep') ? 'keep' : (effect.decisions[0] ?? 'keep'));
/** Undo (or lift) everything. */
export const undoAll: Decide = effect =>
  effect.decisions.includes('undo') ? 'undo' : effect.decisions.includes('lift') ? 'lift' : (effect.decisions[0] ?? 'keep');

export interface CorrectOptions {
  readonly decide?: Decide;
  readonly reason?: CorrectOutcomeInput['reason'];
  readonly doNotCall?: DoNotCallChoice;
  readonly callback?: CorrectOutcomeInput['callback'];
  readonly db?: SessionQueryable;
  readonly context?: (db: SessionQueryable) => RepositoryContext;
  readonly commandId?: string;
  readonly journal?: RecordingSuppressionJournal;
  /** Use this preview's set rather than a fresh one (to test a stale review). */
  readonly shown?: CorrectionPreviewResponse;
}

/** Preview, then correct with the conflicting set echoed and decided by `decide`. */
export async function correct(
  world: ApplyWorld,
  callLogId: string,
  outcome: CallOutcome,
  options: CorrectOptions = {},
): Promise<CorrectionResult<CorrectCallOutcomeResult>> {
  const db = options.db ?? world.session;
  const contextOf = options.context ?? ((on: SessionQueryable) => world.salesperson(on));
  const shown = options.shown ?? (await preview(world, callLogId, outcome, contextOf(world.session)));
  const decide = options.decide ?? keepAll;
  return await withTransaction(db, async () =>
    await correctCallOutcome(contextOf(db), {
      callLogId,
      expectedOutcome: shown.currentOutcome,
      outcome,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      ...(options.doNotCall === undefined ? {} : { doNotCall: options.doNotCall }),
      ...(options.callback === undefined ? {} : { callback: options.callback }),
      effects: shown.effects
        .filter(effect => effect.conflicts)
        .map(effect => ({ kind: effect.kind, id: effect.id, state: effect.state, decision: decide(effect) })),
      commandId: options.commandId ?? `correct-${randomUUID()}`,
      journal: options.journal ?? recordingSuppressionJournal(),
    }),
  );
}

/** A callback's local fields that resolve cleanly, a week ahead, in New York. */
export function callbackFields(day = 9): { localDate: string; localTime: string; sourceTimeZone: string } {
  return { localDate: `2030-01-${String(day).padStart(2, '0')}`, localTime: '14:00', sourceTimeZone: 'America/New_York' };
}

/**
 * Four placed calls to one firm on four different days (inside the 14-day window), each
 * logged with `outcomes[i]`. Returns the calls and their log ids, in order.
 */
export async function placeSeries(
  world: ApplyWorld,
  firm: TestFirm,
  outcomes: readonly CallOutcome[],
): Promise<{ readonly calls: readonly PlacedCall[]; readonly logIds: readonly string[] }> {
  const calls: PlacedCall[] = [];
  const logIds: string[] = [];
  for (const [index, outcome] of outcomes.entries()) {
    const call = await world.placeCall(firm, QUIET_CALL, { recordingSeconds: null, transcript: false, statuses: [{ status: 'in-progress' }, { status: 'completed', seconds: 30 }] });
    await world.session.query(
      `UPDATE call_sessions SET consumed_at = $2::timestamptz, expires_at = GREATEST(expires_at, $2::timestamptz) WHERE id = $1`,
      [call.sessionId, `2026-08-${String(3 + index).padStart(2, '0')}T14:00:00Z`],
    );
    calls.push(call);
    logIds.push(await logPlacedCall(world, call, outcome, { occurredAt: `2026-08-${String(3 + index).padStart(2, '0')}T14:05:00Z` }));
  }
  return { calls, logIds };
}

export async function scalar<T>(world: ApplyWorld, sql: string, values: readonly unknown[]): Promise<T> {
  const { rows } = await world.session.query<{ v: T }>(sql, values);
  return rows[0]?.v as T;
}
