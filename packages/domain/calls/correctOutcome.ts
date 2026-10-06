import {attributeFirmInteraction} from '../sourcing/attribution.ts';
import {
  CALL_CADENCE,
  CALL_OUTCOME_CORRECTED_ACTION,
  CALL_PROPOSAL_CORRECTED_ACTION,
  type AppliedKey,
  type CallCorrectionAlsoHappens,
  type CallCorrectionDecision,
  type CallCorrectionEffect,
  type CallCorrectionEffectKind,
  type CallCorrectionReason,
  type CallLogCorrection,
  type CallOutcome,
  type CorrectCallOutcomeResult,
  type CorrectionEffectDecision,
  type CorrectionPreviewResponse,
  type DoNotCallChoice,
} from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { isAdminScope } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { decideFirmMutation } from '../crm/authorization.ts';
import { loadFirmForUpdate, readFirm } from '../crm/firms.ts';
import { readOpenOpportunity, setManualControlMode } from '../crm/pipeline.ts';
import { retireRoute } from '../crm/routes.ts';
import {
  CALLBACK_CANCELLED_BY_CORRECTION,
  cancelCallback,
  createCallback,
  resolveConfirmedInstant,
  scheduleCallbackForCall,
} from '../dial/callbacks.ts';
import { doNotCallStops, INBOUND_OUTCOMES } from '../dial/calls.ts';
import { callOutcomeEffects, manualReasonFor, REACHED_OUTCOMES } from '../dial/outcomes.ts';
import { databaseNow } from '../policy/clock.ts';
import { releaseHold } from '../policy/holds.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import { stopEnrollments } from '../sequences/enrollments.ts';
import { revokeFollowUpPermission } from '../sequences/followUpPermissions.ts';
import { applyManualModeStop } from '../sequences/terminalStops.ts';
import { recordSuppression } from '../suppression/events.ts';
import type { SuppressionJournal } from '../suppression/journal.ts';
import { lockTodayForFirmChange, refreshTodayForFirm } from '../today/build.ts';
import { businessDateOf, reopenCancelledTodayItem } from '../today/snapshots.ts';
import { callbackTimeNeededItemKey } from '../today/types.ts';
import { lockCallAnalysis } from './analysis.ts';
import { cancelCallTask } from './callTasks.ts';
import { analysisParkSourceId, buyingSignalEvidenceId } from './proposalApply.ts';
import { PROPOSAL_DECIDED_ACTION } from './proposalMeasure.ts';
import { CALL_CADENCE_PARKED_SOURCE, UNANSWERED_OUTCOMES, parkIfCadenceSpent, readCallCadence } from './sessions.ts';

/**
 * Correcting a logged call outcome (slice S3X, lane X2; DESIGN-S3X Part 2). No migration, no
 * new table, no new lock.
 *
 * ## The revision model
 *
 * `call_logs.outcome` is updated **in place** under the log's row lock — with the agreement
 * columns in the same statement when the agreement is undone, so migration 0036's
 * `call_logs_agreement_needs_interest` holds (contract check CC4). Every reader that derives
 * from the outcome (the cadence, the dashboard, consent evidence, Apply's callback choice,
 * Needs review, history) follows with no change. The history is one append-only
 * `audit_events` row per correction (`call.outcome_corrected`), so the original and every
 * correction stay visible with who and when.
 *
 * ## The effects, found from links that already exist (§3.2)
 *
 * Recomputed under the locks every time; there is no ledger. Each effect that conflicts with
 * the new outcome needs David's explicit decision, with nothing preselected (P3), and the
 * echoed set (kind, id, state) must be exactly the server's (`effects_changed` otherwise — a
 * callback scheduled, a permission consumed, a park opened or a late Apply in between all
 * refuse the stale review).
 *
 * | Effect | Found by | Conflicts when the new outcome… | Keep | Undo |
 * |---|---|---|---|---|
 * | callback | `callbacks.call_log_id` | is not `callback_requested` (open only) | stays | `cancelCallback` |
 * | task | `call_tasks.call_session_id` = the log's session | is unreached (open only) | stays | `cancelCallTask` |
 * | stop | `command_id` `<cmd>:handle`/`:firm`, or an earlier correction's `applied.suppressionEventIds`; not directly superseded | is not `do_not_call` | Keep stop | "Lift stop…": **lifts nothing here** (RESET A); `liftNext` |
 * | permission | `follow_up_permissions.call_log_id` (unrevoked) | is unreached | not offered | revoke, and stop the live enrollment bound to it |
 * | agreement | the log's `agreed_*` with no unrevoked permission | is unreached | not offered | the UPDATE clears it |
 * | park | open automatic `call_cadence_parked` hold at the firm | leaves the recomputed cadence below the limit | stays | `releaseHold`, audited `call.cadence_resumed` |
 * | route | the log's retired route, old outcome `wrong_number` | is not `wrong_number` | the only choice | — |
 *
 * Never changed, shown collapsed: the analysis's "pause calling" park, a deal opened from
 * the call's buying signal, and what the log did at log time (manual mode, ended
 * enrollments, the applied step).
 *
 * ## Lock order (§3.4)
 *
 * Exactly Apply's prefix plus the log row: Today (shared) → the send gate → the dialled route
 * (`FOR UPDATE`, only when the new outcome retires or stops it) → the firm → the
 * `call_analysis:<session>` lock → the session row → the `call_logs` row → effect rows. Every
 * inner command re-takes gate and firm re-entrantly in the same order.
 *
 * ## Atomic
 *
 * One savepoint around every write: the UPDATE, the undos, the new outcome's own effects, the
 * reopened Today task. An inner refusal rolls all of it back and refuses with that command's
 * code, so a refused receipt commits nothing. After the savepoint, in the same transaction:
 * the audit row, the trial rows (§3.8), the Today refresh. **No supersession is ever written**
 * (CC8): a stop marked "Lift stop…" is returned for the desktop's separate, confirmed lift.
 */

const SAVEPOINT = 'call_outcome_correction';

/** The outcomes whose effects touch the dialled route: the route is locked `FOR UPDATE`. */
const ROUTE_OUTCOMES: ReadonlySet<CallOutcome> = new Set<CallOutcome>(['wrong_number', 'do_not_call']);

/** Which decisions each conflicting kind may carry (§3.3 refusal 1). */
const ALLOWED_DECISIONS: Readonly<Partial<Record<CallCorrectionEffectKind, readonly CallCorrectionDecision[]>>> = {
  callback: ['keep', 'undo'],
  task: ['keep', 'undo'],
  park: ['keep', 'undo'],
  stop: ['keep', 'lift'],
  permission: ['undo'],
  agreement: ['undo'],
  route: ['keep'],
};

export type CorrectionResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

const refuse = <T>(reason: string): CorrectionResult<T> => ({ ok: false, reason });

class Refused extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

// ---------------------------------------------------------------------------
// Reading the log and its effects
// ---------------------------------------------------------------------------

type LogRow = {
  readonly id: string;
  readonly firm_id: string;
  readonly contact_id: string | null;
  readonly opportunity_id: string | null;
  readonly phone_route_id: string | null;
  readonly outcome: CallOutcome;
  readonly direction: 'outbound' | 'inbound';
  readonly actor_user_id: string;
  readonly command_id: string | null;
  readonly step_execution_id: string | null;
  readonly agreed_follow_up: string | null;
  readonly agreed_template_version_id: string | null;
  readonly agreed_sequence_version_id: string | null;
};

const LOG_COLUMNS = `id, firm_id, contact_id, opportunity_id, phone_route_id, outcome, direction, actor_user_id, command_id,
  step_execution_id, agreed_follow_up, agreed_template_version_id, agreed_sequence_version_id`;

async function readLog(context: RepositoryContext, callLogId: string, forUpdate: boolean): Promise<LogRow | null> {
  const { rows } = await context.db.query<LogRow>(
    `SELECT ${LOG_COLUMNS} FROM call_logs WHERE workspace_id = $1 AND id = $2 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [context.scope.workspaceId, callLogId],
  );
  return rows[0] ?? null;
}

async function sessionOfLog(context: RepositoryContext, callLogId: string): Promise<string | null> {
  const { rows } = await context.db.query<{ id: string }>(
    'SELECT id FROM call_sessions WHERE workspace_id = $1 AND call_log_id = $2 ORDER BY created_at, id LIMIT 1',
    [context.scope.workspaceId, callLogId],
  );
  return rows[0]?.id ?? null;
}

/** One earlier correction of the log, as its audit row recorded it. */
interface PriorCorrection {
  readonly revision: number;
  readonly from: CallOutcome;
  readonly to: CallOutcome;
  readonly at: string;
  readonly byUserId: string | null;
  readonly reason: CallCorrectionReason | null;
  readonly suppressionEventIds: readonly string[];
}

async function readPriorCorrections(context: RepositoryContext, callLogId: string): Promise<readonly PriorCorrection[]> {
  const { rows } = await context.db.query<{ detail: Record<string, unknown>; occurred_at: Date; actor_user_id: string | null }>(
    `SELECT detail, occurred_at, actor_user_id FROM audit_events
      WHERE workspace_id = $1 AND action = $2 AND subject_kind = 'call_log' AND subject_id = $3
      ORDER BY (detail->>'revision')::int, occurred_at, id`,
    [context.scope.workspaceId, CALL_OUTCOME_CORRECTED_ACTION, callLogId],
  );
  return rows.map(row => {
    const applied = (row.detail['applied'] ?? {}) as { suppressionEventIds?: unknown };
    const ids = Array.isArray(applied.suppressionEventIds) ? applied.suppressionEventIds.filter((id): id is string => typeof id === 'string') : [];
    return {
      revision: Number(row.detail['revision']),
      from: row.detail['from'] as CallOutcome,
      to: row.detail['to'] as CallOutcome,
      at: row.occurred_at.toISOString(),
      byUserId: row.actor_user_id,
      reason: (row.detail['reason'] ?? null) as CallCorrectionReason | null,
      suppressionEventIds: ids,
    };
  });
}

/** An applied decision row of the log's session, for provenance and the trial rows. */
interface AppliedDecision {
  readonly analysisId: string;
  readonly key: string;
  readonly kind: string | null;
  readonly type: string;
  readonly result: 'unchanged' | 'edited';
  readonly version: number;
  readonly proposalHash: string;
  readonly policyVersion: string | null;
}

interface Provenance {
  /** The outcome's applied key: the latest decision for (session, `outcome`) is applied. */
  readonly outcome: AppliedDecision | null;
  /** Effect id → the applied decision whose `effectIds` holds it, by exact id (§3.7). */
  readonly byEffectId: ReadonlyMap<string, AppliedDecision>;
}

async function readProvenance(context: RepositoryContext, sessionId: string | null): Promise<Provenance> {
  if (sessionId === null) return { outcome: null, byEffectId: new Map() };
  const { rows } = await context.db.query<{
    analysis_id: string;
    key: string;
    kind: string | null;
    type: string;
    result: string;
    effect_ids: unknown;
    version: string | null;
    proposal_hash: string | null;
    policy_version: string | null;
  }>(
    `SELECT detail->>'analysisId' AS analysis_id, detail->>'key' AS key, detail->>'kind' AS kind, detail->>'type' AS type,
            detail->>'result' AS result, detail->'effectIds' AS effect_ids, detail->>'version' AS version,
            detail->>'proposalHash' AS proposal_hash, detail->>'policyVersion' AS policy_version
       FROM audit_events
      WHERE workspace_id = $1 AND action = $2 AND subject_kind = 'call_analysis' AND detail->>'callSessionId' = $3
      ORDER BY occurred_at, id`,
    [context.scope.workspaceId, PROPOSAL_DECIDED_ACTION, sessionId],
  );
  let latestOutcome: (typeof rows)[number] | null = null;
  const byEffectId = new Map<string, AppliedDecision>();
  const toApplied = (row: (typeof rows)[number]): AppliedDecision => ({
    analysisId: row.analysis_id,
    key: row.key,
    kind: row.kind,
    type: row.type,
    result: row.result === 'edited' ? 'edited' : 'unchanged',
    version: Number(row.version ?? 0),
    proposalHash: row.proposal_hash ?? '',
    policyVersion: row.policy_version,
  });
  for (const row of rows) {
    if (row.key === 'outcome') latestOutcome = row;
    const applied = row.result === 'unchanged' || row.result === 'edited';
    // Exact ids only. An older row without `effectIds` gives no effect provenance.
    if (applied && Array.isArray(row.effect_ids)) {
      for (const id of row.effect_ids) if (typeof id === 'string') byEffectId.set(id, toApplied(row));
    }
  }
  const outcomeApplied = latestOutcome !== null && (latestOutcome.result === 'unchanged' || latestOutcome.result === 'edited');
  return { outcome: outcomeApplied && latestOutcome !== null ? toApplied(latestOutcome) : null, byEffectId };
}

/** What one discovered effect is, with what the command needs to undo it. */
interface FoundEffect extends CallCorrectionEffect {
  readonly decided?: AppliedDecision | null;
  readonly enrollmentId?: string | null;
}

interface Discovery {
  readonly effects: readonly FoundEffect[];
  readonly provenance: Provenance;
  readonly prior: readonly PriorCorrection[];
  readonly callbackTimeRequired: boolean;
  readonly hasOpenCallback: boolean;
  readonly anyCallback: boolean;
  readonly needsTimeCompleted: boolean;
  readonly openParkIds: readonly string[];
  readonly alsoHappens: readonly CallCorrectionAlsoHappens[];
}

/**
 * Every effect of the log, and whether each conflicts with `outcome` — the one function the
 * preview and the command both ask, so they cannot disagree (the command asks it under the
 * locks).
 */
async function discoverEffects(
  context: RepositoryContext,
  input: { readonly log: LogRow; readonly sessionId: string | null; readonly outcome: CallOutcome },
): Promise<Discovery> {
  const { log, sessionId, outcome } = input;
  const workspaceId = context.scope.workspaceId;
  const reached = REACHED_OUTCOMES.has(outcome);
  const admin = isAdminScope(context.scope);
  const provenance = await readProvenance(context, sessionId);
  const prior = await readPriorCorrections(context, log.id);
  const effects: FoundEffect[] = [];
  const appliedKeyOf = (id: string): AppliedKey | null => {
    const decided = provenance.byEffectId.get(id);
    return decided === undefined ? null : { analysisId: decided.analysisId, key: decided.key };
  };
  const add = (effect: Omit<FoundEffect, 'appliedKey'> & { readonly appliedKey?: AppliedKey | null }): void => {
    const appliedKey = effect.appliedKey === undefined ? appliedKeyOf(effect.id) : effect.appliedKey;
    effects.push({
      ...effect,
      appliedKey,
      decided: appliedKey === null ? null : (provenance.byEffectId.get(effect.id) ?? null),
      decisions: effect.conflicts ? effect.decisions : [],
    });
  };

  // -- callbacks ------------------------------------------------------------------------------
  const { rows: callbacks } = await context.db.query<{ id: string; status: 'open' | 'completed' | 'cancelled'; due_at: Date }>(
    'SELECT id, status, due_at FROM callbacks WHERE workspace_id = $1 AND call_log_id = $2 ORDER BY created_at, id',
    [workspaceId, log.id],
  );
  for (const callback of callbacks) {
    const conflicts = callback.status === 'open' && outcome !== 'callback_requested';
    add({ kind: 'callback', id: callback.id, state: callback.status, conflicts, decisions: ['keep', 'undo'], facts: { dueAt: callback.due_at.toISOString() } });
  }

  // -- call tasks of the session ----------------------------------------------------------------
  if (sessionId !== null) {
    const { rows: tasks } = await context.db.query<{ id: string; status: 'open' | 'done' | 'cancelled'; text: string; due_at: Date }>(
      'SELECT id, status, text, due_at FROM call_tasks WHERE workspace_id = $1 AND call_session_id = $2 ORDER BY created_at, id',
      [workspaceId, sessionId],
    );
    for (const task of tasks) {
      const conflicts = task.status === 'open' && !reached;
      add({ kind: 'task', id: task.id, state: task.status, conflicts, decisions: ['keep', 'undo'], facts: { text: task.text, dueAt: task.due_at.toISOString() } });
    }
  }

  // -- stops this log wrote, or an earlier correction of it wrote ------------------------------
  // Not directly superseded (`NOT EXISTS` a supersession of the event): the DISTINCT ON view
  // shows one representative per key and channel, so membership in it is not the test.
  const commandIds = log.command_id === null ? [] : [`${log.command_id}:handle`, `${log.command_id}:firm`];
  const correctionStops = prior.flatMap(entry => entry.suppressionEventIds);
  if (commandIds.length > 0 || correctionStops.length > 0) {
    const { rows: stops } = await context.db.query<{ event_id: string; scope: 'firm' | 'handle'; channel: 'phone' | 'email' | 'all'; canonical_key: string }>(
      `SELECT e.event_id, e.scope, e.channel, e.canonical_key
         FROM suppression_events e
        WHERE e.workspace_id = $1
          AND (e.command_id = ANY($2::text[]) OR e.event_id = ANY($3::text[]))
          AND e.supersedes_event_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM suppression_events x
                           WHERE x.workspace_id = e.workspace_id AND x.supersedes_event_id = e.event_id)
        ORDER BY e.recorded_at, e.event_id`,
      [workspaceId, commandIds, correctionStops],
    );
    for (const stop of stops) {
      add({
        kind: 'stop',
        id: stop.event_id,
        state: 'effective',
        conflicts: outcome !== 'do_not_call',
        // A salesperson is offered Keep only: the follow-up lift is the admin supersession.
        decisions: admin ? ['keep', 'lift'] : ['keep'],
        facts: { scope: stop.scope, channel: stop.channel, canonicalKey: stop.canonical_key },
      });
    }
  }

  // -- the agreement and its permissions --------------------------------------------------------
  const { rows: permissions } = await context.db.query<{
    id: string;
    scope: string;
    revoked: boolean;
    consumed_at: Date | null;
    expired: boolean;
    enrollment_id: string | null;
    enrollment_live: boolean;
  }>(
    `SELECT p.id, p.scope, p.revoked_at IS NOT NULL AS revoked, p.consumed_at, p.expires_at <= clock_timestamp() AS expired,
            p.enrollment_id, (n.id IS NOT NULL AND n.ended_at IS NULL) AS enrollment_live
       FROM follow_up_permissions p
       LEFT JOIN sequence_enrollments n ON n.workspace_id = p.workspace_id AND n.id = p.enrollment_id
      WHERE p.workspace_id = $1 AND p.call_log_id = $2
      ORDER BY p.created_at, p.id`,
    [workspaceId, log.id],
  );
  let unrevoked = 0;
  for (const permission of permissions) {
    const state = permission.revoked ? 'revoked' : permission.consumed_at !== null ? 'consumed' : permission.expired ? 'expired' : 'live';
    if (!permission.revoked) unrevoked += 1;
    effects.push({
      kind: 'permission',
      id: permission.id,
      state,
      conflicts: !permission.revoked && !reached,
      decisions: !permission.revoked && !reached ? ['undo'] : [],
      appliedKey: appliedKeyOf(permission.id),
      decided: provenance.byEffectId.get(permission.id) ?? null,
      enrollmentId: permission.enrollment_live ? permission.enrollment_id : null,
      facts: {
        permissionScope: permission.scope,
        ...(permission.consumed_at === null ? {} : { consumedAt: permission.consumed_at.toISOString() }),
        enrollmentLive: permission.enrollment_live,
      },
    });
  }
  if (log.agreed_follow_up !== null && unrevoked === 0 && !reached) {
    // The agreement alone (its grant failed, or every permission was revoked): it is still
    // cleared by the UPDATE, so it is still David's explicit decision.
    add({ kind: 'agreement', id: `agreement:${log.id}`, state: 'live', conflicts: true, decisions: ['undo'], appliedKey: null, facts: { permissionScope: log.agreed_follow_up } });
  }

  // -- parks at the firm --------------------------------------------------------------------------
  const { rows: holds } = await context.db.query<{ id: string; source_event_id: string | null }>(
    `SELECT id, source_event_id FROM active_holds
      WHERE workspace_id = $1 AND scope_kind = 'firm' AND scope_key = ($2::uuid)::text
        AND source_event_kind = $3 AND released_at IS NULL
      ORDER BY started_at, id`,
    [workspaceId, log.firm_id, CALL_CADENCE_PARKED_SOURCE],
  );
  const automatic = holds.filter(hold => hold.source_event_id === null || !hold.source_event_id.startsWith('call-analysis-park:'));
  if (automatic.length > 0) {
    // The cadence recomputed as if the correction had happened, in the window that ends at
    // the firm's latest placed call — the window `parkIfCadenceSpent` parked in.
    const { rows: latest } = await context.db.query<{ at: string | null }>(
      `SELECT to_char(max(consumed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
         FROM call_sessions WHERE workspace_id = $1 AND firm_id = $2`,
      [workspaceId, log.firm_id],
    );
    const at = latest[0]?.at ?? (await databaseNow(context));
    const cadence = await readCallCadence(context, log.firm_id, at, undefined, { callLogId: log.id, outcome });
    const conflicts = cadence.unansweredAttempts < CALL_CADENCE.unansweredLimit;
    for (const hold of automatic) add({ kind: 'park', id: hold.id, state: 'parked', conflicts, decisions: ['keep', 'undo'], facts: {} });
  }
  if (sessionId !== null) {
    const analysisPark = holds.find(hold => hold.source_event_id === analysisParkSourceId(sessionId));
    if (analysisPark !== undefined) add({ kind: 'analysis_park', id: analysisPark.id, state: 'parked', conflicts: false, decisions: [], facts: {} });
  }

  // -- the retired number --------------------------------------------------------------------------
  if (log.outcome === 'wrong_number' && log.phone_route_id !== null) {
    const { rows: routes } = await context.db.query<{ eligibility: string }>(
      'SELECT eligibility FROM phone_routes WHERE workspace_id = $1 AND id = $2',
      [workspaceId, log.phone_route_id],
    );
    if (routes[0]?.eligibility === 'retired') {
      add({ kind: 'route', id: log.phone_route_id, state: 'retired', conflicts: outcome !== 'wrong_number', decisions: ['keep'], facts: {} });
    }
  }

  // -- a deal opened from the call's buying signal ------------------------------------------------
  if (sessionId !== null) {
    const { rows: deals } = await context.db.query<{ opportunity_id: string | null }>(
      `SELECT opportunity_id FROM opportunity_stage_evidence
        WHERE workspace_id = $1 AND evidence_kind = 'call.interested' AND evidence_id = $2
       UNION ALL
       SELECT opportunity_id FROM stage_review_items
        WHERE workspace_id = $1 AND evidence_kind = 'call.interested' AND evidence_id = $2
       LIMIT 1`,
      [workspaceId, buyingSignalEvidenceId(sessionId)],
    );
    const deal = deals[0];
    if (deal !== undefined) {
      add({
        kind: 'deal',
        id: deal.opportunity_id ?? buyingSignalEvidenceId(sessionId),
        state: 'done',
        conflicts: false,
        decisions: [],
        facts: deal.opportunity_id === null ? {} : { opportunityId: deal.opportunity_id },
      });
    }
  }

  // -- what the log did at log time ------------------------------------------------------------------
  if (callOutcomeEffects(log.outcome).setsManual || log.step_execution_id !== null) {
    add({
      kind: 'history',
      id: `history:${log.id}`,
      state: 'done',
      conflicts: false,
      decisions: [],
      appliedKey: null,
      facts: {
        manualOrEnded: callOutcomeEffects(log.outcome).setsManual,
        ...(log.step_execution_id === null ? {} : { stepExecutionId: log.step_execution_id }),
      },
    });
  }

  // -- what `callback_requested` would need -----------------------------------------------------------
  const hasOpenCallback = callbacks.some(callback => callback.status === 'open');
  const anyCallback = callbacks.length > 0;
  const { rows: needsTime } = await context.db.query<{ completed: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM today_items WHERE workspace_id = $1 AND firm_id = $2 AND item_key = $3 AND status = 'completed') AS completed`,
    [workspaceId, log.firm_id, callbackTimeNeededItemKey(log.id)],
  );
  const needsTimeCompleted = needsTime[0]?.completed === true;
  // A callback row (completed or cancelled) or a fulfilled needs-a-time task means the
  // needs-a-time source ignores this log for good, so only a time produces real work.
  const callbackTimeRequired = outcome === 'callback_requested' && !hasOpenCallback && (anyCallback || needsTimeCompleted);

  const effectsOf = callOutcomeEffects(outcome);
  const alsoHappens: CallCorrectionAlsoHappens[] = [];
  if (effectsOf.setsManual) alsoHappens.push('manual_mode');
  if (outcome === 'do_not_call') alsoHappens.push('stop_recorded');
  if (outcome === 'wrong_number') alsoHappens.push('route_retired');
  if (UNANSWERED_OUTCOMES.has(outcome) && sessionId !== null) alsoHappens.push('cadence_checked');
  if (outcome === 'callback_requested' && !hasOpenCallback) alsoHappens.push(callbackTimeRequired ? 'callback_scheduled' : 'callback_needs_time');
  if (effectsOf.suggestsLost) alsoHappens.push('suggest_lost');

  return {
    effects,
    provenance,
    prior,
    callbackTimeRequired,
    hasOpenCallback,
    anyCallback,
    needsTimeCompleted,
    openParkIds: automatic.map(hold => hold.id),
    alsoHappens,
  };
}

/** The wire shape of a discovered effect. */
function publicEffect(effect: FoundEffect): CallCorrectionEffect {
  return {
    kind: effect.kind,
    id: effect.id,
    state: effect.state,
    conflicts: effect.conflicts,
    decisions: [...effect.decisions],
    appliedKey: effect.appliedKey,
    facts: effect.facts,
  };
}

function correctionsOf(prior: readonly PriorCorrection[]): CallLogCorrection[] {
  return prior.map(entry => ({ from: entry.from, to: entry.to, at: entry.at, byUserId: entry.byUserId, reason: entry.reason }));
}

/** The actor check both the preview and the command make of the log as read (§3.3, 3). */
function checkLog(context: RepositoryContext, log: LogRow): string | null {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return 'invalid_input';
  // Only the person who made the call corrects it, as `recordCallFollowUp`.
  if (log.actor_user_id !== actor.userId) return 'not_call_actor';
  return null;
}

/** §3.3, 5–7: what the target outcome must be, for this log. */
function checkTarget(log: LogRow, outcome: CallOutcome): string | null {
  if (log.outcome === outcome) return 'outcome_unchanged';
  // An incoming call was answered: it is never corrected to an unanswered outcome.
  if (log.direction === 'inbound' && !INBOUND_OUTCOMES.has(outcome)) return 'outcome_not_correctable';
  if (ROUTE_OUTCOMES.has(outcome) && log.phone_route_id === null) return 'route_not_named';
  return null;
}

// ---------------------------------------------------------------------------
// The preview
// ---------------------------------------------------------------------------

/**
 * `POST /calls/logs/correction-preview`: what correcting this log to `outcome` would meet. A
 * read with no locks; the command recomputes the same set under its locks and refuses
 * `effects_changed` if it moved.
 */
export async function previewOutcomeCorrection(
  context: RepositoryContext,
  input: { readonly callLogId: string; readonly outcome: CallOutcome },
): Promise<CorrectionResult<CorrectionPreviewResponse>> {
  if (context.scope.actor.kind !== 'user') return refuse('invalid_input');
  const log = await readLog(context, input.callLogId, false);
  if (log === null) return refuse('call_log_unknown');
  const firm = await readFirm(context, log.firm_id);
  if (firm === null) return refuse('call_log_unknown');
  const permitted = decideFirmMutation(context, firm);
  if (!permitted.permitted) return refuse(permitted.reason === 'not_assigned' ? 'not_assigned' : 'call_log_unknown');
  const refusal = checkLog(context, log) ?? checkTarget(log, input.outcome);
  if (refusal !== null) return refuse(refusal);
  const sessionId = await sessionOfLog(context, log.id);
  const found = await discoverEffects(context, { log, sessionId, outcome: input.outcome });
  const outcomeApplied = found.provenance.outcome;
  return {
    ok: true,
    value: {
      callLogId: log.id,
      currentOutcome: log.outcome,
      originalOutcome: found.prior[0]?.from ?? log.outcome,
      corrections: correctionsOf(found.prior),
      outcomeAppliedKey: outcomeApplied === null ? null : { analysisId: outcomeApplied.analysisId, key: 'outcome' },
      effects: found.effects.map(publicEffect),
      callbackTimeRequired: found.callbackTimeRequired,
      alsoHappens: [...found.alsoHappens],
    },
  };
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export interface CorrectOutcomeInput {
  readonly callLogId: string;
  readonly expectedOutcome: CallOutcome;
  readonly outcome: CallOutcome;
  readonly reason?: CallCorrectionReason | undefined;
  readonly doNotCall?: DoNotCallChoice | undefined;
  readonly callback?:
    | {
        readonly localDate: string;
        readonly localTime?: string | undefined;
        readonly sourceTimeZone: string;
        readonly dueAt?: string | undefined;
      }
    | undefined;
  readonly effects: readonly CorrectionEffectDecision[];
  readonly commandId: string;
  /** Required for a correction to `do_not_call`: the stop's journal object precedes its row. */
  readonly journal?: SuppressionJournal | undefined;
}

const effectKey = (effect: { readonly kind: string; readonly id: string; readonly state: string }): string =>
  `${effect.kind}\u0000${effect.id}\u0000${effect.state}`;

/**
 * `POST /calls/logs/correct`. See the module comment; refusals in §3.3's order, all before
 * any write.
 */
export async function correctCallOutcome(
  context: RepositoryContext,
  input: CorrectOutcomeInput,
): Promise<CorrectionResult<CorrectCallOutcomeResult>> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refuse('invalid_input');

  // ---- 1. invalid_input: the body alone ----------------------------------------------------
  if (input.doNotCall !== undefined && input.outcome !== 'do_not_call') return refuse('invalid_input');
  if (input.callback !== undefined && input.outcome !== 'callback_requested') return refuse('invalid_input');
  const seen = new Set<string>();
  for (const echoed of input.effects) {
    const key = `${echoed.kind}\u0000${echoed.id}`;
    if (seen.has(key)) return refuse('invalid_input');
    seen.add(key);
    const allowed = ALLOWED_DECISIONS[echoed.kind];
    if (allowed === undefined || !allowed.includes(echoed.decision)) return refuse('invalid_input');
  }

  // ---- Locate, unlocked ----------------------------------------------------------------------
  const located = await readLog(context, input.callLogId, false);
  if (located === null) return refuse('call_log_unknown');
  const locatedSession = await sessionOfLog(context, located.id);

  // ---- Locks: Today (shared) → gate → route → firm → analysis → session → the log ----------
  await lockTodayForFirmChange(context);
  await lockSendGateForStopFact(context);
  if (ROUTE_OUTCOMES.has(input.outcome) && located.phone_route_id !== null) {
    await context.db.query('SELECT 1 FROM phone_routes WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [
      context.scope.workspaceId,
      located.phone_route_id,
    ]);
  }
  const firm = await loadFirmForUpdate(context, located.firm_id);
  // ---- 2. call_log_unknown, 3. not_assigned ----------------------------------------------------
  if (firm === null) return refuse('call_log_unknown');
  const permitted = decideFirmMutation(context, firm);
  if (!permitted.permitted) return refuse(permitted.reason === 'not_assigned' ? 'not_assigned' : 'call_log_unknown');
  if (locatedSession !== null) {
    await lockCallAnalysis(context, locatedSession);
    await context.db.query('SELECT 1 FROM call_sessions WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [
      context.scope.workspaceId,
      locatedSession,
    ]);
  }
  const log = await readLog(context, input.callLogId, true);
  if (log === null) return refuse('call_log_unknown');
  // 3. not_call_actor
  const actorRefusal = checkLog(context, log);
  if (actorRefusal !== null) return refuse(actorRefusal);
  // ---- 4. stale_outcome: the outcome David saw, at the firm it was shown at ----------------
  if (log.firm_id !== located.firm_id || log.outcome !== input.expectedOutcome) return refuse('stale_outcome');
  // ---- 5–7. outcome_unchanged, outcome_not_correctable, route_not_named ----------------------
  const targetRefusal = checkTarget(log, input.outcome);
  if (targetRefusal !== null) return refuse(targetRefusal);
  // The session is the first log's, never reassigned: the one located is the one locked.
  const sessionId = locatedSession;

  // ---- 8. effects_changed: the fresh conflicting set is exactly the echoed one ---------------
  const found = await discoverEffects(context, { log, sessionId, outcome: input.outcome });
  const conflicting = found.effects.filter(effect => effect.conflicts);
  const serverSet = new Set(conflicting.map(effectKey));
  const echoedSet = new Set(input.effects.map(effectKey));
  if (serverSet.size !== echoedSet.size || [...serverSet].some(key => !echoedSet.has(key))) return refuse('effects_changed');
  const byKey = new Map(conflicting.map(effect => [effectKey(effect), effect] as const));
  const decided = input.effects.map(echoed => ({ echoed, effect: byKey.get(effectKey(echoed)) as FoundEffect }));

  // ---- 9. reason_required (and a reason that is not required is invalid_input) ----------------
  const outcomeApplied = found.provenance.outcome;
  const contradicted = decided.filter(entry => entry.echoed.decision !== 'keep' && entry.effect.appliedKey !== null);
  const reasonNeeded = outcomeApplied !== null || contradicted.length > 0;
  if (reasonNeeded && input.reason === undefined) return refuse('reason_required');
  if (!reasonNeeded && input.reason !== undefined) return refuse('invalid_input');

  // ---- 10. stop_needs_admin ----------------------------------------------------------------------
  const lifts = decided.filter(entry => entry.echoed.decision === 'lift');
  if (lifts.length > 0 && !isAdminScope(context.scope)) return refuse('stop_needs_admin');

  // ---- 11. the callback's time ----------------------------------------------------------------------
  let confirmedDueAt: string | null = null;
  if (input.outcome === 'callback_requested') {
    // An open callback already is the work; a second time would be a second callback.
    if (found.hasOpenCallback && input.callback !== undefined) return refuse('invalid_input');
    if (found.callbackTimeRequired && input.callback === undefined) return refuse('callback_time_required');
    if (input.callback !== undefined) {
      const resolved = resolveConfirmedInstant(input.callback);
      if (!resolved.ok) return refuse(resolved.reason);
      confirmedDueAt = resolved.dueAt;
    }
  }
  // ---- 12. a forward stop needs its journal (a lost journal write is the route's 503) ----------
  if (input.outcome === 'do_not_call' && input.journal === undefined) return refuse('invalid_input');

  const clearAgreement = !REACHED_OUTCOMES.has(input.outcome) && log.agreed_follow_up !== null;
  const now = await databaseNow(context);
  const applied = {
    suppressionEventIds: [] as string[],
    retiredRouteId: null as string | null,
    callbackId: null as string | null,
    parkHoldId: null as string | null,
    reopenedTodayItemId: null as string | null,
  };

  // ---- The writes, in one savepoint ------------------------------------------------------------
  await context.db.query(`SAVEPOINT ${SAVEPOINT}`);
  try {
    // 1. The outcome, and the agreement in the same statement when the new outcome reached nobody.
    await context.db.query(
      `UPDATE call_logs
          SET outcome = $3,
              agreed_follow_up = CASE WHEN $4 THEN NULL ELSE agreed_follow_up END,
              agreed_template_version_id = CASE WHEN $4 THEN NULL ELSE agreed_template_version_id END,
              agreed_sequence_version_id = CASE WHEN $4 THEN NULL ELSE agreed_sequence_version_id END
        WHERE workspace_id = $1 AND id = $2`,
      [context.scope.workspaceId, log.id, input.outcome, clearAgreement],
    );

    // 2. The undos. No stop is lifted here (RESET A).
    for (const { echoed, effect } of decided) {
      if (echoed.decision !== 'undo') continue;
      switch (effect.kind) {
        case 'callback': {
          const cancelled = await cancelCallback(context, { callbackId: effect.id, reason: CALLBACK_CANCELLED_BY_CORRECTION });
          if (!cancelled.ok) throw new Refused(cancelled.reason === 'callback_not_open' ? 'effects_changed' : cancelled.reason);
          break;
        }
        case 'task': {
          const cancelled = await cancelCallTask(context, { taskId: effect.id });
          if (!cancelled.ok) throw new Refused(cancelled.reason === 'task_not_open' ? 'effects_changed' : cancelled.reason);
          break;
        }
        case 'permission': {
          const revoked = await revokeFollowUpPermission(context, effect.id);
          if (!revoked.ok) throw new Refused(revoked.reason);
          if (effect.enrollmentId !== null && effect.enrollmentId !== undefined) {
            await stopEnrollments(context, { enrollmentIds: [effect.enrollmentId], reason: 'admin_stop' });
          }
          break;
        }
        case 'agreement':
          // Cleared by the UPDATE above.
          break;
        case 'park': {
          const released = await releaseHold(context, effect.id, 'scoped_pause');
          if (released === null) throw new Refused('effects_changed');
          await recordCrmAuditEvent(context, {
            action: 'call.cadence_resumed',
            subjectKind: 'active_hold',
            subjectId: effect.id,
            detail: { firmId: log.firm_id, origin: 'outcome_correction', callLogId: log.id },
          });
          break;
        }
        default:
          throw new Refused('invalid_input');
      }
    }

    // 3. What the new outcome itself means, as `logCallOutcome` applies it.
    const effectsOf = callOutcomeEffects(input.outcome);
    if (effectsOf.setsManual) {
      const opportunity = await readOpenOpportunity(context, log.firm_id);
      if (opportunity !== null && opportunity.control_mode !== 'manual') {
        const changed = await setManualControlMode(context, {
          opportunityId: opportunity.id,
          reason: manualReasonFor(input.outcome),
          origin: 'engaged_call',
          commandId: `${input.commandId}:manual`,
        });
        if (!changed.ok) throw new Refused(changed.reason === 'not_assigned' ? 'not_assigned' : 'invalid_input');
      }
      await applyManualModeStop(context, { firmId: log.firm_id, origin: 'engaged_call', cause: CALL_OUTCOME_CORRECTED_ACTION });
    }
    if (input.outcome === 'do_not_call' && input.journal !== undefined && log.phone_route_id !== null) {
      const { rows: routes } = await context.db.query<{ e164: string }>(
        'SELECT e164 FROM phone_routes WHERE workspace_id = $1 AND id = $2',
        [context.scope.workspaceId, log.phone_route_id],
      );
      const e164 = routes[0]?.e164;
      if (e164 === undefined) throw new Refused('route_unknown');
      const stops = doNotCallStops({ doNotCall: input.doNotCall });
      const handle = await recordSuppression(context, {
        scope: 'handle',
        value: e164,
        firmId: log.firm_id,
        source: 'prospect_do_not_call',
        channel: stops.handle,
        commandId: `${input.commandId}:handle`,
        journal: input.journal,
      });
      if (!handle.ok) throw new Refused(handle.reason);
      applied.suppressionEventIds.push(handle.value.eventId);
      if (stops.firm !== null) {
        const firmWide = await recordSuppression(context, {
          scope: 'firm',
          firmId: log.firm_id,
          source: 'prospect_do_not_call',
          channel: stops.firm,
          commandId: `${input.commandId}:firm`,
          journal: input.journal,
        });
        if (!firmWide.ok) throw new Refused(firmWide.reason);
        applied.suppressionEventIds.push(firmWide.value.eventId);
      }
    }
    if (effectsOf.retiresRoute && log.phone_route_id !== null) {
      const retired = await retireRoute(context, { routeKind: 'phone', routeId: log.phone_route_id, reason: 'wrong number, recorded on a call correction' });
      if (!retired.ok) throw new Refused('route_unknown');
      applied.retiredRouteId = log.phone_route_id;
    }
    if (UNANSWERED_OUTCOMES.has(input.outcome) && sessionId !== null) {
      const hold = await parkIfCadenceSpent(context, { firmId: log.firm_id, sessionId });
      if (hold !== null && !found.openParkIds.includes(hold)) applied.parkHoldId = hold;
    }
    if (input.outcome === 'callback_requested' && !found.hasOpenCallback) {
      if (input.callback !== undefined && confirmedDueAt !== null) {
        const created = !found.anyCallback
          ? await scheduleCallbackForCall(context, { callLogId: log.id, ...input.callback })
          : await createCallback(context, {
              firmId: log.firm_id,
              ...(log.contact_id === null ? {} : { contactId: log.contact_id }),
              ...(log.opportunity_id === null ? {} : { opportunityId: log.opportunity_id }),
              callLogId: log.id,
              assignedUserId: firm.assigned_user_id ?? actor.userId,
              localDate: input.callback.localDate,
              ...(input.callback.localTime === undefined ? {} : { localTime: input.callback.localTime }),
              sourceTimeZone: input.callback.sourceTimeZone,
              dueAt: confirmedDueAt,
            });
        if (!created.ok) throw new Refused(created.reason);
        applied.callbackId = created.value.id;
      } else if (!found.anyCallback && !found.needsTimeCompleted) {
        // 4. "Callback — needs a time" comes back on Today: an earlier correction's refresh
        // may have cancelled today's row, which `today_upsert_item` never reopens (S3XD 5).
        applied.reopenedTodayItemId = await reopenCancelledTodayItem(context, {
          firmId: log.firm_id,
          itemKey: callbackTimeNeededItemKey(log.id),
          businessDate: await businessDateOf(context, now),
        });
      }
    }
  } catch (error) {
    await context.db.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
    await context.db.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    if (error instanceof Refused) return refuse(error.reason);
    throw error;
  }
  await context.db.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);

  // ---- After the savepoint: the history, the trial rows, Today ------------------------------------
  const revision = found.prior.length + 1;
  const liftChosen = lifts.map(entry => entry.effect.id);
  await recordCrmAuditEvent(context, {
    action: CALL_OUTCOME_CORRECTED_ACTION,
    subjectKind: 'call_log',
    subjectId: log.id,
    detail: {
      revision,
      from: log.outcome,
      to: input.outcome,
      reason: input.reason ?? null,
      callSessionId: sessionId,
      agreementCleared: clearAgreement
        ? { scope: log.agreed_follow_up, templateVersionId: log.agreed_template_version_id, sequenceVersionId: log.agreed_sequence_version_id }
        : null,
      decisions: decided.map(entry => ({ kind: entry.effect.kind, id: entry.effect.id, decision: entry.echoed.decision })),
      applied,
      liftChosen,
    },
  });

  await attributeFirmInteraction(context,{firmId:log.firm_id,kind:'call',subjectId:log.id,sourceRevision:revision});

  // §3.8: one `call.proposal_corrected` row per distinct (analysisId, key) contradicted.
  if (input.reason !== undefined && sessionId !== null) {
    const pairs = new Map<string, { readonly decision: AppliedDecision; readonly from: string; readonly to: string }>();
    if (outcomeApplied !== null) {
      pairs.set(`${outcomeApplied.analysisId}\u0000outcome`, { decision: outcomeApplied, from: log.outcome, to: input.outcome });
    }
    for (const { echoed, effect } of contradicted) {
      const decision = effect.decided;
      if (decision === null || decision === undefined) continue;
      const pair = `${decision.analysisId}\u0000${decision.key}`;
      if (pairs.has(pair)) continue;
      pairs.set(pair, { decision, from: effect.id, to: echoed.decision === 'lift' ? 'lift_chosen' : 'undone' });
    }
    for (const { decision, from, to } of pairs.values()) {
      await recordCrmAuditEvent(context, {
        action: CALL_PROPOSAL_CORRECTED_ACTION,
        subjectKind: 'call_analysis',
        subjectId: decision.analysisId,
        detail: {
          analysisId: decision.analysisId,
          callSessionId: sessionId,
          version: decision.version,
          proposalHash: decision.proposalHash,
          policyVersion: decision.policyVersion,
          key: decision.key,
          kind: decision.kind,
          type: decision.type,
          priorResult: decision.result,
          reason: input.reason,
          correctedFrom: from,
          correctedTo: to,
          callLogId: log.id,
        },
      });
    }
  }

  await refreshTodayForFirm(context, { firmId: log.firm_id });

  return {
    ok: true,
    value: {
      callLogId: log.id,
      outcome: input.outcome,
      revision,
      applied,
      liftNext: lifts.map(entry => ({
        eventId: entry.effect.id,
        scope: entry.effect.facts.scope ?? 'handle',
        channel: entry.effect.facts.channel ?? 'all',
      })),
      suggestedStageKey: callOutcomeEffects(input.outcome).suggestsLost ? 'lost' : null,
    },
  };
}

