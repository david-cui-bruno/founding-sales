import {
  type ApplyKeyReason,
  type ApplyCallProposalsResult,
  type CallAnalysisResult,
  type CallFollowUp,
  type CallOutcome,
  type CallProposal,
  type CallProposalEdits,
  type CallProposalKeyResult,
  type CallProposalRefusalCode,
  type CallTranscriptUtterance,
} from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { decideFirmMutation } from '../crm/authorization.ts';
import { loadFirmForUpdate } from '../crm/firms.ts';
import { setManualControlMode } from '../crm/pipeline.ts';
import { applyStageEvidence } from '../crm/stageEvidence.ts';
import { createCallback, scheduleCallbackForCall } from '../dial/callbacks.ts';
import { confirmCapturedFollowUp, logCallOutcome, REACHED_OUTCOMES, withinCapturedFollowUpWindow } from '../dial/calls.ts';
import { openHold } from '../policy/holds.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import type { PolicyRefusalCode } from '../policy/types.ts';
import type { SuppressionJournal } from '../suppression/journal.ts';
import { lockTodayForFirmChange, refreshTodayForFirm } from '../today/build.ts';
import { lockCallAnalysis } from './analysis.ts';
import { transcriptSha256 } from './analysisModel.ts';
import { taskKey } from './analysisPolicy.ts';
import { createCallTask } from './callTasks.ts';
import { recordProposalDecisions } from './proposalMeasure.ts';
import { CALL_CADENCE_PARKED_SOURCE } from './sessions.ts';

/**
 * First-time apply-on-click (slice 3a, lane B; DESIGN-S3A §2.3): `POST /calls/proposals/apply`.
 *
 * Every effect of a post-call analysis happens only when David clicks, for the first time,
 * through an **existing** domain command, prefilled from the analysis he saw. One Apply
 * carries any subset of the analysis's `apply` proposals (opening a deal is one of those
 * ticks, with no dialog) and runs in one transaction:
 *
 *   1. **Locks**, in the one order (docs/greenfield/calling.md): Today's lock (shared) →
 *      the send gate → the dialled route whenever an **outcome** is applied (`FOR UPDATE`
 *      when it retires or suppresses the number, as `updateFirmBasics` and `retireRoute`
 *      take it; `FOR KEY SHARE` otherwise, because the call log's insert takes the route's
 *      key-share lock through its foreign key and must not take it after the firm) → the
 *      firm → `call_analysis:<session>` → the session row.
 *   2. **Freshness**: the analysis is the newest completed model analysis on the call's
 *      current transcript, and the echoed transcript hash is that transcript's
 *      (`stale_analysis`); the echoed `proposalHash` is the stored one, never recomputed
 *      (`stale_proposal`).
 *   3. **First-time rules**, in this order: `outcome` with a log → `call_already_logged`;
 *      `callback` or `follow_up` with no `outcome` and no log → `outcome_required`;
 *      `callback` when the log has any callback, cancelled included → `callback_exists`.
 *      Then a `follow_up` more than seven days after the call → `follow_up_expired` (the
 *      call's time: the session's start, never when it was logged).
 *   4. **Map** each key to its command, inside one savepoint. **Atomic**: a refusal from any
 *      of them — `follow_up_not_granted` included — undoes every write of this Apply and
 *      refuses it, naming the key (a refused command receipt commits what ran before it, so
 *      nothing may be left behind). No-op results (`already_parked`, `already_created`) are
 *      not refusals.
 *   5. **Measure** (one audit row per `applied` key; a no-op is not a decision), then
 *      `refreshTodayForFirm`.
 *
 * A retry with the same command id is answered from its receipt; a click with a different
 * id meets a first-time guard. There is no ledger.
 */

export interface ApplyCallProposalsInput {
  readonly analysisId: string;
  readonly transcriptSha256: string;
  readonly proposalHash: string;
  readonly keys: readonly string[];
  readonly edits?: CallProposalEdits | undefined;
  readonly commandId: string;
  /** Required whenever the applied outcome may suppress: the journal precedes the row (10.2). */
  readonly journal?: SuppressionJournal | undefined;
}

export type ApplyRefusalCode = CallProposalRefusalCode | PolicyRefusalCode | 'not_found';

export type ApplyCallProposalsOutcome =
  | { readonly ok: true; readonly value: ApplyCallProposalsResult }
  | { readonly ok: false; readonly reason: ApplyRefusalCode; readonly keyReasons?: readonly ApplyKeyReason[] };

/** A refusal of the whole Apply; with `key`, the key that refused it. */
const refuse = (reason: ApplyRefusalCode, key?: string, detail?: string | null): ApplyCallProposalsOutcome =>
  key === undefined ? { ok: false, reason } : { ok: false, reason, keyReasons: [{ key, reason, detail: detail ?? null }] };

/** The outcomes whose effects touch the dialled route: retirement, or the number's suppression. */
const ROUTE_OUTCOMES: ReadonlySet<CallOutcome> = new Set<CallOutcome>(['wrong_number', 'do_not_call']);

/** The kinds an Apply can carry out. Every other kind is a Needs review item. */
const APPLICABLE_KINDS: ReadonlySet<CallProposal['kind']> = new Set(['outcome', 'callback', 'follow_up', 'buying_signal', 'park', 'task']);

/** The stage evidence a buying signal is: one per call, so a second click moves nothing. */
export function buyingSignalEvidenceId(sessionId: string): string {
  return `call-analysis:${sessionId}:buying_signal`;
}

/** The park hold's source id: the call that asked for the pause. */
export function analysisParkSourceId(sessionId: string): string {
  return `call-analysis-park:${sessionId}`;
}

const SAVEPOINT = 'call_proposal_apply';

class Refused extends Error {
  constructor(
    readonly reason: ApplyRefusalCode,
    readonly key?: string,
    readonly detail?: string | null,
  ) {
    super(reason);
  }
}

type LocatedAnalysis = {
  readonly call_session_id: string;
  readonly firm_id: string;
  readonly phone_route_id: string;
  readonly state: string;
  readonly proposals: CallProposal[] | null;
};

type AnalysisRow = {
  readonly id: string;
  readonly call_session_id: string;
  readonly version: number;
  readonly origin: string;
  readonly state: string;
  readonly transcript_sha256: string | null;
  readonly proposal_hash: string | null;
  readonly policy_version: string | null;
  readonly proposals: CallProposal[] | null;
  readonly result: CallAnalysisResult | null;
};

type SessionRow = {
  readonly firm_id: string;
  readonly contact_id: string | null;
  readonly ticket_id: string;
  readonly call_log_id: string | null;
  readonly started: Date;
};

type LogRow = {
  readonly id: string;
  readonly outcome: CallOutcome;
  readonly contact_id: string | null;
  readonly opportunity_id: string | null;
  readonly occurred_at: Date;
};

function effectiveOutcome(proposal: CallProposal | undefined, edits: CallProposalEdits | undefined): CallOutcome | null {
  if (proposal?.kind !== 'outcome') return null;
  return edits?.outcome?.outcome ?? proposal.params.outcome;
}

export async function applyCallProposals(
  context: RepositoryContext,
  input: ApplyCallProposalsInput,
): Promise<ApplyCallProposalsOutcome> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refuse('invalid_input');
  const selected = new Set(input.keys);
  if (selected.size === 0 || selected.size !== input.keys.length) return refuse('invalid_input');

  // ---- 0. Where the analysis is, unlocked ---------------------------------------------
  // A completed version's proposals are never written again (`completeCallAnalysis` only
  // updates a pending row), so whether a route is touched is decided exactly here, before
  // the route's lock is due. A version that is not completed is not one David can have seen.
  const { rows: located } = await context.db.query<LocatedAnalysis>(
    `SELECT a.call_session_id, s.firm_id, t.phone_route_id, a.state, a.proposals
       FROM call_analyses a
       JOIN call_sessions s ON s.workspace_id = a.workspace_id AND s.id = a.call_session_id
       JOIN dial_tickets t ON t.workspace_id = s.workspace_id AND t.id = s.ticket_id
      WHERE a.workspace_id = $1 AND a.id = $2`,
    [context.scope.workspaceId, input.analysisId],
  );
  const where = located[0];
  if (where === undefined) return refuse('not_found');
  if (where.state !== 'completed' || where.proposals === null) return refuse('stale_analysis');
  const sessionId = where.call_session_id;
  const outcomeProposal = where.proposals.find(proposal => proposal.key === 'outcome');
  const appliedOutcome = selected.has('outcome') ? effectiveOutcome(outcomeProposal, input.edits) : null;
  const touchesRoute = appliedOutcome !== null && ROUTE_OUTCOMES.has(appliedOutcome);

  // ---- 1. Locks -------------------------------------------------------------------------
  await lockTodayForFirmChange(context);
  await lockSendGateForStopFact(context);
  // Every outcome: the call log names the dialled route, so its insert takes the route's
  // key-share lock — after the firm, that is the other half of a cycle with a Basics edit
  // that holds the route and waits for the firm (review S3B, finding 1).
  if (appliedOutcome !== null) {
    await context.db.query(
      `SELECT 1 FROM phone_routes WHERE workspace_id = $1 AND id = $2 ${touchesRoute ? 'FOR UPDATE' : 'FOR KEY SHARE'}`,
      [context.scope.workspaceId, where.phone_route_id],
    );
  }
  const firm = await loadFirmForUpdate(context, where.firm_id);
  if (firm === null) return refuse('not_found');
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return refuse(decision.reason === 'not_assigned' ? 'not_assigned' : 'not_found');
  await lockCallAnalysis(context, sessionId);
  const { rows: sessions } = await context.db.query<SessionRow>(
    `SELECT firm_id, contact_id, ticket_id, call_log_id, coalesce(answered_at, started_at, created_at) AS started
       FROM call_sessions WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [context.scope.workspaceId, sessionId],
  );
  const session = sessions[0];
  if (session === undefined) return refuse('not_found');
  // Moved to another firm since the unlocked read (a merge): the click was for a call
  // that is no longer where it was shown.
  if (session.firm_id !== where.firm_id) return refuse('stale_analysis');

  // ---- 2. Freshness ---------------------------------------------------------------------
  const { rows: analyses } = await context.db.query<AnalysisRow>(
    `SELECT id, call_session_id, version, origin, state, transcript_sha256, proposal_hash, policy_version, proposals, result
       FROM call_analyses WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, input.analysisId],
  );
  const analysis = analyses[0];
  if (analysis === undefined) return refuse('not_found');
  const { rows: transcripts } = await context.db.query<{ utterances: unknown }>(
    'SELECT utterances FROM call_transcripts WHERE workspace_id = $1 AND call_session_id = $2',
    [context.scope.workspaceId, sessionId],
  );
  const transcript = transcripts[0];
  const currentSha =
    transcript === undefined
      ? null
      : transcriptSha256(Array.isArray(transcript.utterances) ? (transcript.utterances as CallTranscriptUtterance[]) : []);
  const { rows: authoritative } = await context.db.query<{ id: string }>(
    `SELECT id FROM call_analyses
      WHERE workspace_id = $1 AND call_session_id = $2 AND origin = 'model' AND state = 'completed'
        AND transcript_sha256 = $3
      ORDER BY version DESC LIMIT 1`,
    [context.scope.workspaceId, sessionId, currentSha],
  );
  if (currentSha === null || authoritative[0]?.id !== analysis.id || input.transcriptSha256 !== currentSha) {
    return refuse('stale_analysis');
  }
  if (analysis.proposal_hash === null || input.proposalHash !== analysis.proposal_hash) return refuse('stale_proposal');

  // ---- Which proposals ----------------------------------------------------------------
  const byKey = new Map((analysis.proposals ?? []).map(proposal => [proposal.key, proposal] as const));
  const chosen: CallProposal[] = [];
  for (const key of input.keys) {
    const proposal = byKey.get(key);
    if (proposal === undefined || proposal.mode !== 'apply' || !APPLICABLE_KINDS.has(proposal.kind)) {
      return refuse('proposal_unknown', key);
    }
    chosen.push(proposal);
  }
  const has = (key: string): boolean => selected.has(key);
  const callbackProposal = byKey.get('callback');
  const followUpProposal = byKey.get('follow_up');

  // ---- 3. First-time rules --------------------------------------------------------------
  const logId = session.call_log_id;
  if (has('outcome') && logId !== null) return refuse('call_already_logged', 'outcome');
  if ((has('callback') || has('follow_up')) && !has('outcome') && logId === null) {
    return refuse('outcome_required', has('callback') ? 'callback' : 'follow_up');
  }
  let log: LogRow | null = null;
  if (logId !== null) {
    const { rows: logs } = await context.db.query<LogRow>(
      'SELECT id, outcome, contact_id, opportunity_id, occurred_at FROM call_logs WHERE workspace_id = $1 AND id = $2',
      [context.scope.workspaceId, logId],
    );
    log = logs[0] ?? null;
    if (log === null) return refuse('not_found');
  }
  if (has('callback') && log !== null) {
    const { rows: callbacks } = await context.db.query('SELECT 1 FROM callbacks WHERE workspace_id = $1 AND call_log_id = $2 LIMIT 1', [
      context.scope.workspaceId,
      log.id,
    ]);
    if (callbacks.length > 0) return refuse('callback_exists', 'callback');
  }

  // Everything else that can refuse, before the first write.
  if (has('callback') && log === null && appliedOutcome !== 'callback_requested') return refuse('invalid_input', 'callback');
  const templateVersionId = input.edits?.follow_up?.templateVersionId;
  if (has('follow_up')) {
    if (templateVersionId === undefined) return refuse('invalid_input', 'follow_up');
    // The proposal's evidence is a verified quote: Them asked, or Them agreed to an offer.
    const request = analysis.result?.followUpRequest ?? null;
    if (request === null || (request.ref.side !== 'them' && request.agreed === null)) return refuse('proposal_unknown', 'follow_up');
    if (log === null && (appliedOutcome === null || !REACHED_OUTCOMES.has(appliedOutcome))) return refuse('invalid_input', 'follow_up');
    // The call's own time, never the log's: a log written late does not reopen the window
    // (review S3B, finding 3). `confirmCapturedFollowUp` and Needs review read the same.
    if (!(await withinCapturedFollowUpWindow(context, session.started))) return refuse('follow_up_expired', 'follow_up');
  }

  const callbackParams =
    callbackProposal?.kind === 'callback'
      ? (input.edits?.callback ?? {
          localDate: callbackProposal.params.localDate,
          localTime: callbackProposal.params.localTime,
          dueAt: callbackProposal.params.dueAt,
          sourceTimeZone: callbackProposal.params.sourceTimeZone,
        })
      : undefined;

  // ---- 4. Map, in one savepoint ---------------------------------------------------------
  await context.db.query(`SAVEPOINT ${SAVEPOINT}`);
  let applied: Omit<ApplyCallProposalsResult, 'analysisId' | 'callSessionId'>;
  try {
    applied = await mapKeys(context, {
      sessionId,
      firmId: where.firm_id,
      assignedUserId: firm.assigned_user_id ?? actor.userId,
      session,
      log,
      chosen,
      byKey,
      appliedOutcome,
      callbackParams,
      templateVersionId,
      followUpProposal,
      input,
    });
  } catch (error) {
    await context.db.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
    await context.db.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    if (error instanceof Refused) return refuse(error.reason, error.key, error.detail);
    throw error;
  }
  await context.db.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);

  // ---- 5. Measure, then Today -----------------------------------------------------------
  await recordProposalDecisions(
    context,
    {
      id: analysis.id,
      callSessionId: sessionId,
      version: analysis.version,
      // Both checked non-null by the freshness step above.
      proposalHash: analysis.proposal_hash ?? input.proposalHash,
      policyVersion: analysis.policy_version,
      proposals: analysis.proposals ?? [],
    },
    // Only what this click did. A no-op (`already_created`, `already_parked`) decides nothing,
    // and recording it would overwrite the first decision (review S3B, finding 8).
    applied.results
      .filter(entry => entry.result === 'applied')
      .map(entry => ({ key: entry.key, result: entry.edited ? 'edited' : 'unchanged' })),
  );
  await refreshTodayForFirm(context, { firmId: where.firm_id });
  return { ok: true, value: { analysisId: analysis.id, callSessionId: sessionId, ...applied } };
}

interface MapInput {
  readonly sessionId: string;
  readonly firmId: string;
  readonly assignedUserId: string;
  readonly session: SessionRow;
  readonly log: LogRow | null;
  readonly chosen: readonly CallProposal[];
  readonly byKey: ReadonlyMap<string, CallProposal>;
  readonly appliedOutcome: CallOutcome | null;
  readonly callbackParams: CallProposalEdits['callback'];
  readonly templateVersionId: string | undefined;
  readonly followUpProposal: CallProposal | undefined;
  readonly input: ApplyCallProposalsInput;
}

type KeyResult = ApplyCallProposalsResult['results'][number];

async function mapKeys(
  context: RepositoryContext,
  m: MapInput,
): Promise<Omit<ApplyCallProposalsResult, 'analysisId' | 'callSessionId'>> {
  const { input } = m;
  const selected = new Set(input.keys);
  const results: KeyResult[] = [];
  const followUps: CallFollowUp[] = [];
  const push = (proposal: CallProposal, result: CallProposalKeyResult, id: string | null, edited: boolean): void => {
    results.push({ key: proposal.key, kind: proposal.kind, result, id, edited });
  };
  const proposalOf = (key: string): CallProposal => {
    const proposal = m.byKey.get(key);
    if (proposal === undefined) throw new Refused('proposal_unknown');
    return proposal;
  };
  let callLogId = m.log?.id ?? null;

  // -- outcome, with callback and follow-up inside the one `logCallOutcome` --------------
  if (selected.has('outcome')) {
    const proposal = proposalOf('outcome');
    if (proposal.kind !== 'outcome' || m.appliedOutcome === null) throw new Refused('proposal_unknown');
    const edits = input.edits?.outcome;
    const logged = await logCallOutcome(context, {
      firmId: m.firmId,
      ...(m.session.contact_id === null ? {} : { contactId: m.session.contact_id }),
      callSessionId: m.sessionId,
      outcome: m.appliedOutcome,
      // The call happened when it was answered, not when David clicked: history.
      occurredAt: m.session.started.toISOString(),
      ...(edits?.note === undefined ? {} : { note: edits.note }),
      ...(selected.has('callback') && m.callbackParams !== undefined ? { callback: m.callbackParams } : {}),
      ...(edits?.doNotCallCoversAllContact === undefined ? {} : { doNotCallCoversAllContact: edits.doNotCallCoversAllContact }),
      ...(selected.has('follow_up') && m.templateVersionId !== undefined
        ? { followUpPermission: { scope: 'single_email' as const, templateVersionId: m.templateVersionId } }
        : {}),
      commandId: input.commandId,
      journal: input.journal,
      viaProposalApply: true,
    });
    if (!logged.ok) throw new Refused(logged.reason, 'outcome');
    // A selected follow-up whose permission was not granted is a refusal of the whole Apply,
    // never an `applied` key beside a warning (review S3B, finding 4).
    if (selected.has('follow_up') && logged.value.followUpPermissionId === null) throw notGranted(logged.value.followUps);
    callLogId = logged.value.callLogId;
    followUps.push(...logged.value.followUps);
    const outcomeEdited =
      m.appliedOutcome !== proposal.params.outcome || (edits?.doNotCallCoversAllContact ?? false) !== (proposal.params.doNotCallCoversAllContact ?? false);
    push(proposal, 'applied', callLogId, outcomeEdited);
    if (selected.has('callback')) {
      push(proposalOf('callback'), 'applied', logged.value.callbackId, callbackEdited(proposalOf('callback'), input.edits));
    }
    if (selected.has('follow_up')) push(proposalOf('follow_up'), 'applied', logged.value.followUpPermissionId, false);
  } else if (m.log !== null) {
    // -- callback on an existing log --------------------------------------------------------
    if (selected.has('callback')) {
      const params = m.callbackParams;
      if (params === undefined) throw new Refused('proposal_unknown');
      const created =
        m.log.outcome === 'callback_requested'
          ? await scheduleCallbackForCall(context, { callLogId: m.log.id, ...params })
          : await createCallback(context, {
              firmId: m.firmId,
              ...(m.log.contact_id === null ? {} : { contactId: m.log.contact_id }),
              ...(m.log.opportunity_id === null ? {} : { opportunityId: m.log.opportunity_id }),
              callLogId: m.log.id,
              assignedUserId: m.assignedUserId,
              ...params,
            });
      if (!created.ok) throw new Refused(created.reason === 'callback_already_scheduled' ? 'callback_exists' : created.reason, 'callback');
      push(proposalOf('callback'), 'applied', created.value.id, callbackEdited(proposalOf('callback'), input.edits));
    }
    // -- follow-up on an existing log: the evidence-backed seven-day path -------------------
    if (selected.has('follow_up')) {
      if (m.templateVersionId === undefined) throw new Refused('invalid_input', 'follow_up');
      const confirmed = await confirmCapturedFollowUp(context, {
        callLogId: m.log.id,
        templateVersionId: m.templateVersionId,
        commandId: input.commandId,
      });
      if (!confirmed.ok) throw new Refused(confirmed.reason, 'follow_up');
      if (confirmed.value.followUpPermissionId === null) throw notGranted(confirmed.value.followUps);
      followUps.push(...confirmed.value.followUps);
      push(proposalOf('follow_up'), 'applied', confirmed.value.followUpPermissionId, false);
    }
  }

  // -- the "Send overview" task an overview request leaves (decision 7) --------------------
  // One insertion path: when David selected the task too, the task loop below writes it,
  // once, with his edits; only an unselected overview task is written here, as proposed
  // (review S3B, finding 5).
  if (selected.has('follow_up') && m.followUpProposal?.kind === 'follow_up' && m.followUpProposal.params.requestKind === 'overview_email') {
    const quote = m.followUpProposal.params.evidence[0]?.quote;
    const key = quote === undefined ? null : taskKey(quote);
    if (key !== null && !selected.has(key)) {
      const listed = m.byKey.get(key);
      await createCallTask(context, {
        firmId: m.firmId,
        contactId: m.session.contact_id,
        callSessionId: m.sessionId,
        quoteKey: key,
        text: listed?.kind === 'task' ? listed.params.text : await overviewText(context, m.session.contact_id),
        dueAt: await wallClock(context),
      });
    }
  }

  // -- buying signal: the stage evidence, then manual mode ----------------------------------
  if (selected.has('buying_signal')) {
    const stage = await applyStageEvidence(context, {
      firmId: m.firmId,
      evidenceKind: 'call.interested',
      evidenceId: buyingSignalEvidenceId(m.sessionId),
      occurredAt: m.session.started.toISOString(),
      detail: { callSessionId: m.sessionId, analysisId: input.analysisId },
    });
    const opportunityId = stage.kind === 'review' ? null : stage.opportunityId;
    // This call's evidence is already on the opportunity (one per call): a no-op, not a
    // decision (review S3B, finding 8).
    const repeat = stage.kind === 'unchanged' && stage.reason === 'already_applied';
    if (repeat) push(proposalOf('buying_signal'), 'already_applied', opportunityId, false);
    else if (opportunityId !== null) {
      const manual = await setManualControlMode(context, {
        opportunityId,
        reason: 'buying signal on a call',
        origin: 'engaged_call',
        commandId: `${input.commandId}:buying_signal`,
      });
      if (!manual.ok) throw new Refused(manual.reason === 'not_assigned' ? 'not_assigned' : 'invalid_input', 'buying_signal');
    }
    if (!repeat) push(proposalOf('buying_signal'), 'applied', opportunityId, false);
  }

  // -- park: a cadence park the analysis asked for, once ------------------------------------
  // `already_parked` when this proposal's park was ever made — released by a Resume
  // included, because a Resume is deliberate recovery and must stick (review S3B, finding
  // 7) — or when any park (the automatic one included) is open on the firm.
  if (selected.has('park')) {
    const { rows: open } = await context.db.query<{ id: string }>(
      `SELECT id FROM active_holds
        WHERE workspace_id = $1 AND source_event_kind = $3
          AND (source_event_id = $4
               OR (scope_kind = 'firm' AND scope_key = ($2::uuid)::text AND released_at IS NULL))
        ORDER BY (source_event_id = $4) DESC, started_at, id LIMIT 1`,
      [context.scope.workspaceId, m.firmId, CALL_CADENCE_PARKED_SOURCE, analysisParkSourceId(m.sessionId)],
    );
    const existing = open[0]?.id;
    if (existing !== undefined) push(proposalOf('park'), 'already_parked', existing, false);
    else {
      const holdId = await openHold(context, {
        scopeKind: 'firm',
        scopeKey: m.firmId,
        reasonCode: 'scoped_pause',
        blockedActionKinds: ['dial_authorization'],
        sourceEventKind: CALL_CADENCE_PARKED_SOURCE,
        sourceEventId: analysisParkSourceId(m.sessionId),
        recoveryAction: 'resume_after_review',
      });
      await recordCrmAuditEvent(context, {
        action: 'call.cadence_parked',
        subjectKind: 'active_hold',
        subjectId: holdId,
        detail: { firmId: m.firmId, callSessionId: m.sessionId, origin: 'call_analysis' },
      });
      push(proposalOf('park'), 'applied', holdId, false);
    }
  }

  // -- tasks: one per spoken promise ------------------------------------------------------
  for (const proposal of m.chosen) {
    if (proposal.kind !== 'task') continue;
    const edit = input.edits?.tasks?.[proposal.key];
    const task = await createCallTask(context, {
      firmId: m.firmId,
      contactId: m.session.contact_id,
      callSessionId: m.sessionId,
      quoteKey: proposal.key,
      text: edit?.text ?? proposal.params.text,
      dueAt: edit?.dueAt ?? (await wallClock(context)),
    });
    // Edited: other words, or a due date David set (the proposal carries only a phrase).
    const edited = (edit?.text !== undefined && edit.text !== proposal.params.text) || edit?.dueAt !== undefined;
    push(proposal, task.created ? 'applied' : 'already_created', task.id, edited);
  }

  return { callLogId, results, followUps };
}

/** A selected follow-up whose permission was not granted: the Apply's refusal, with why. */
function notGranted(followUps: readonly CallFollowUp[]): Refused {
  const entry = followUps.find(followUp => followUp.kind === 'follow_up_not_granted');
  const reason = entry !== undefined && 'reason' in entry && typeof entry.reason === 'string' ? entry.reason : null;
  return new Refused('follow_up_not_granted', 'follow_up', reason === null ? null : reason.slice(0, 64));
}

function callbackEdited(proposal: CallProposal, edits: CallProposalEdits | undefined): boolean {
  if (proposal.kind !== 'callback' || edits?.callback === undefined) return false;
  const edited = edits.callback;
  return (
    edited.localDate !== proposal.params.localDate ||
    edited.localTime !== proposal.params.localTime ||
    edited.sourceTimeZone !== proposal.params.sourceTimeZone
  );
}

async function wallClock(context: RepositoryContext): Promise<string> {
  const { rows } = await context.db.query<{ now: Date }>('SELECT clock_timestamp() AS now');
  return (rows[0]?.now ?? new Date()).toISOString();
}

async function overviewText(context: RepositoryContext, contactId: string | null): Promise<string> {
  if (contactId === null) return 'Send overview';
  const { rows } = await context.db.query<{ full_name: string | null }>(
    'SELECT full_name FROM contacts WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, contactId],
  );
  const name = rows[0]?.full_name?.replace(/\s+/gu, ' ').trim() ?? '';
  return (name.length === 0 ? 'Send overview' : `Send overview to ${name}`).slice(0, 300);
}
