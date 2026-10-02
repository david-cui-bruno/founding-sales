import {
  CALL_ANALYSIS_PENDING_SOURCE,
  CAPTURED_FOLLOW_UP_WINDOW_DAYS,
  PENDING_HOLD_REVIEW_AFTER_HOURS,
  type CallProposal,
  type ReviewItem,
  type ReviewListResponse,
  type ReviewProposalKind,
} from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { decideAdminOnly, decideFirmMutation } from '../crm/authorization.ts';
import { loadFirmForUpdate } from '../crm/firms.ts';
import { authoritativeAnalysis, PROPOSAL_DECIDED_ACTION } from './proposalMeasure.ts';

/**
 * Needs review (slice 3a, DESIGN-S3A §2.4): `GET /review`, a read with no job behind it.
 *
 * Three sources:
 *
 *   1. **pending-review holds open three hours or more** (`calls/pendingHold.ts`), whatever
 *      the call's facts — done when the hold is released (a log, or Dismiss);
 *   2. **review suggestions** of each call's authoritative analysis that have no decision
 *      yet (`call.proposal_decided`; Dismiss is a decline), and that the derived read does
 *      not already see as done:
 *        - `outcome_unclear`: the call has a log;
 *        - `corrected_number`, and a `wrong_number` outcome on a call already logged
 *          otherwise: the dialled number was retired after the analysis completed;
 *        - `stop_scope`: a firm suppression was recorded after the analysis completed;
 *        - `referral_contact`: a contact with that name now exists at the firm;
 *        - `callback_zone_unknown`: the call's log has a callback;
 *        - `stop_with_email` and every other review kind: Dismiss only;
 *      plus `follow_up_expired`, derived: an undecided `follow_up` more than seven days after
 *      the call, which no Apply can confirm any more;
 *   3. **open stage review items** (`stage_review_items`, 0028), resolved by id
 *      (`resolveStageReviewItem`).
 *
 * Nothing in the list blocks another call or another firm. A salesperson sees the firms
 * assigned to them; an administrator sees every firm.
 */

const LIMIT = 500;

type SessionRow = {
  readonly session_id: string;
  readonly firm_id: string;
  readonly firm_name: string;
  readonly call_log_id: string | null;
  readonly log_outcome: string | null;
  readonly route_id: string;
  readonly started: Date;
};

type AnalysisFacts = {
  readonly completed_at: Date;
  readonly version: number;
};

export async function readNeedsReview(context: RepositoryContext): Promise<ReviewListResponse> {
  const actor = context.scope.actor;
  const workspace = context.scope.workspaceId;
  const ownerFilter = actor.kind === 'user' && actor.role !== 'admin' ? actor.userId : null;
  const items: ReviewItem[] = [];

  // ---- 1. Pending holds open three hours or more ------------------------------------
  const { rows: holds } = await context.db.query<{ id: string; session_id: string; firm_id: string; firm_name: string; started_at: Date }>(
    `SELECT h.id, h.source_event_id AS session_id, f.id AS firm_id, f.name AS firm_name, h.started_at
       FROM active_holds h
       LEFT JOIN call_sessions s ON s.workspace_id = h.workspace_id AND s.id::text = h.source_event_id
       -- A hold whose session is gone is still listed, at the firm it blocks, so Dismiss can
       -- reach it (review S3B, finding 2).
       JOIN firms f ON f.workspace_id = h.workspace_id AND f.id::text = coalesce(s.firm_id::text, h.scope_key)
      WHERE h.workspace_id = $1 AND h.source_event_kind = $2 AND h.released_at IS NULL
        AND h.started_at <= now() - make_interval(hours => $3)
        AND ($4::uuid IS NULL OR f.assigned_user_id = $4::uuid)
      ORDER BY h.started_at, h.id`,
    [workspace, CALL_ANALYSIS_PENDING_SOURCE, PENDING_HOLD_REVIEW_AFTER_HOURS, ownerFilter],
  );
  for (const hold of holds) {
    items.push({
      source: 'pending_hold',
      holdId: hold.id,
      callSessionId: hold.session_id,
      firmId: hold.firm_id,
      firmName: hold.firm_name,
      openedAt: hold.started_at.toISOString(),
    });
  }

  // ---- 2. Review suggestions of the authoritative analyses --------------------------
  const { rows: sessions } = await context.db.query<SessionRow>(
    `SELECT DISTINCT ON (s.id) s.id AS session_id, s.firm_id, f.name AS firm_name, s.call_log_id, l.outcome AS log_outcome,
            t.phone_route_id AS route_id, coalesce(s.answered_at, s.started_at, s.created_at) AS started
       FROM call_analyses a
       JOIN call_sessions s ON s.workspace_id = a.workspace_id AND s.id = a.call_session_id
       JOIN dial_tickets t ON t.workspace_id = s.workspace_id AND t.id = s.ticket_id
       JOIN firms f ON f.workspace_id = s.workspace_id AND f.id = s.firm_id
       LEFT JOIN call_logs l ON l.workspace_id = s.workspace_id AND l.id = s.call_log_id
      WHERE a.workspace_id = $1 AND a.origin = 'model' AND a.state = 'completed' AND f.status = 'active'
        AND ($2::uuid IS NULL OR f.assigned_user_id = $2::uuid)`,
    [workspace, ownerFilter],
  );
  const { rows: clock } = await context.db.query<{ now: Date }>('SELECT now() AS now');
  const now = clock[0]?.now ?? new Date();
  for (const session of sessions) {
    const analysis = await authoritativeAnalysis(context, session.session_id);
    if (analysis === null) continue;
    const { rows: factsRows } = await context.db.query<AnalysisFacts>(
      'SELECT completed_at, version FROM call_analyses WHERE workspace_id = $1 AND id = $2',
      [workspace, analysis.id],
    );
    const facts = factsRows[0];
    if (facts === undefined) continue;
    const { rows: decidedRows } = await context.db.query<{ key: string }>(
      `SELECT DISTINCT detail->>'key' AS key FROM audit_events
        WHERE workspace_id = $1 AND action = $2 AND subject_kind = 'call_analysis' AND subject_id = $3`,
      [workspace, PROPOSAL_DECIDED_ACTION, analysis.id],
    );
    const decided = new Set(decidedRows.map(row => row.key));
    for (const proposal of analysis.proposals) {
      if (decided.has(proposal.key)) continue;
      const reviewKind = await reviewKindOf(context, proposal, session, facts, now);
      if (reviewKind === null) continue;
      items.push({
        source: 'proposal',
        reviewKind,
        analysisId: analysis.id,
        version: analysis.version,
        proposalHash: analysis.proposalHash,
        callSessionId: session.session_id,
        firmId: session.firm_id,
        firmName: session.firm_name,
        proposal,
        completedAt: facts.completed_at.toISOString(),
      });
    }
  }

  // ---- 3. Open stage review items -----------------------------------------------------
  const { rows: stages } = await context.db.query<{
    id: string;
    firm_id: string | null;
    firm_name: string | null;
    opportunity_id: string | null;
    evidence_kind: string;
    reason: string;
    created_at: Date;
  }>(
    `SELECT i.id, i.firm_id, f.name AS firm_name, i.opportunity_id, i.evidence_kind, i.reason, i.created_at
       FROM stage_review_items i
       LEFT JOIN firms f ON f.workspace_id = i.workspace_id AND f.id = i.firm_id
      WHERE i.workspace_id = $1 AND i.resolved_at IS NULL
        AND ($2::uuid IS NULL OR f.assigned_user_id = $2::uuid)
      ORDER BY i.created_at, i.id`,
    [workspace, ownerFilter],
  );
  for (const stage of stages) {
    items.push({
      source: 'stage',
      itemId: stage.id,
      firmId: stage.firm_id,
      firmName: stage.firm_name,
      opportunityId: stage.opportunity_id,
      evidenceKind: stage.evidence_kind,
      reason: stage.reason,
      createdAt: stage.created_at.toISOString(),
    });
  }
  return { items: items.slice(0, LIMIT) };
}

/** The review kind of one undecided suggestion, or null when it is not (or no longer) review work. */
async function reviewKindOf(
  context: RepositoryContext,
  proposal: CallProposal,
  session: SessionRow,
  facts: AnalysisFacts,
  now: Date,
): Promise<ReviewProposalKind | null> {
  const workspace = context.scope.workspaceId;
  const routeRetiredSince = async (): Promise<boolean> => {
    const { rows } = await context.db.query(
      `SELECT 1 FROM phone_routes WHERE workspace_id = $1 AND id = $2 AND retired_at IS NOT NULL AND retired_at >= $3`,
      [workspace, session.route_id, facts.completed_at],
    );
    return rows.length > 0;
  };
  const hasCallback = async (): Promise<boolean> => {
    if (session.call_log_id === null) return false;
    const { rows } = await context.db.query('SELECT 1 FROM callbacks WHERE workspace_id = $1 AND call_log_id = $2 LIMIT 1', [
      workspace,
      session.call_log_id,
    ]);
    return rows.length > 0;
  };

  if (proposal.mode === 'apply') {
    // An apply suggestion is the panel's, not the list's — with two exceptions the
    // panel can no longer carry out.
    if (proposal.kind === 'follow_up') {
      const expired = now.getTime() - session.started.getTime() > CAPTURED_FOLLOW_UP_WINDOW_DAYS * 86_400_000;
      return expired ? 'follow_up_expired' : null;
    }
    if (proposal.kind === 'outcome' && proposal.params.outcome === 'wrong_number' && session.call_log_id !== null && session.log_outcome !== 'wrong_number') {
      return (await routeRetiredSince()) ? null : 'outcome';
    }
    return null;
  }

  switch (proposal.kind) {
    case 'outcome_unclear':
      return session.call_log_id !== null ? null : 'outcome_unclear';
    case 'corrected_number':
      return (await routeRetiredSince()) ? null : 'corrected_number';
    case 'stop_scope': {
      const { rows } = await context.db.query(
        // Done when a firm stop that stops calls exists since the call (migration 0037):
        // either of the two firm choices, calls or all contact.
        `SELECT 1 FROM effective_suppressions
          WHERE workspace_id = $1 AND scope = 'firm' AND canonical_key = lower($2::text) AND recorded_at >= $3
            AND channel IN ('phone', 'all')`,
        [workspace, session.firm_id, facts.completed_at],
      );
      return rows.length > 0 ? null : 'stop_scope';
    }
    case 'referral_contact': {
      const { rows } = await context.db.query(
        `SELECT 1 FROM contacts WHERE workspace_id = $1 AND firm_id = $2
            AND lower(regexp_replace(btrim(full_name), '\\s+', ' ', 'g')) = lower(regexp_replace(btrim($3::text), '\\s+', ' ', 'g'))`,
        [workspace, session.firm_id, proposal.params.name],
      );
      return rows.length > 0 ? null : 'referral_contact';
    }
    case 'callback_zone_unknown':
      return (await hasCallback()) ? null : 'callback_zone_unknown';
    default:
      return proposal.kind;
  }
}

// ---------------------------------------------------------------------------
// Stage review items
// ---------------------------------------------------------------------------

export type ResolveStageOutcome =
  | { readonly ok: true; readonly value: { readonly itemId: string; readonly resolvedAt: string } }
  | { readonly ok: false; readonly reason: 'not_found' | 'not_assigned' | 'admin_only' | 'invalid_input' };

/**
 * `POST /review/stage/resolve {itemId}`: a person looked at the evidence. Sets `resolved_at`
 * and `resolved_by_user_id`, audited. The firm's lock and assignment rule first; an item that
 * names no firm is an administrator's. Resolving one already resolved answers its instant.
 */
export async function resolveStageReviewItem(
  context: RepositoryContext,
  input: { readonly itemId: string },
): Promise<ResolveStageOutcome> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return { ok: false, reason: 'invalid_input' };
  const { rows: located } = await context.db.query<{ firm_id: string | null }>(
    'SELECT firm_id FROM stage_review_items WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, input.itemId],
  );
  const item = located[0];
  if (item === undefined) return { ok: false, reason: 'not_found' };
  if (item.firm_id === null) {
    if (!decideAdminOnly(context).permitted) return { ok: false, reason: 'admin_only' };
  } else {
    const firm = await loadFirmForUpdate(context, item.firm_id);
    if (firm === null) return { ok: false, reason: 'not_found' };
    const decision = decideFirmMutation(context, firm);
    if (!decision.permitted) return { ok: false, reason: decision.reason === 'not_assigned' ? 'not_assigned' : 'not_found' };
  }
  const { rows } = await context.db.query<{ resolved_at: Date; fresh: boolean }>(
    `UPDATE stage_review_items
        SET resolved_at = coalesce(resolved_at, now()), resolved_by_user_id = coalesce(resolved_by_user_id, $3)
      WHERE workspace_id = $1 AND id = $2
      RETURNING resolved_at, (resolved_by_user_id = $3 AND resolved_at = now()) AS fresh`,
    [context.scope.workspaceId, input.itemId, actor.userId],
  );
  const row = rows[0];
  if (row === undefined) return { ok: false, reason: 'not_found' };
  if (row.fresh) {
    await recordCrmAuditEvent(context, {
      action: 'stage_review.resolved',
      subjectKind: 'stage_review_item',
      subjectId: input.itemId,
      detail: { firmId: item.firm_id },
    });
  }
  return { ok: true, value: { itemId: input.itemId, resolvedAt: row.resolved_at.toISOString() } };
}
