import type { RepositoryContext } from '../db/workspaceScope.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import { recordCrmAuditEvent } from './audit.ts';
import { loadFirmForUpdate } from './firms.ts';
import {
  clearStagePin,
  loadOpportunityForUpdate,
  moveOpportunityStage,
  openOpportunity,
  readOpenOpportunity,
  readStageByKey,
} from './pipeline.ts';
import type { OpportunityRow, PipelineStageRow } from './types.ts';

/**
 * Automatic pipeline moves: the one entry point (call-to-booking slice W, migration 0028).
 *
 * `applyStageEvidence` is the only way anything other than a person moves an
 * opportunity. It reads the evidence kind's row in `stage_rules`, and it moves an
 * opportunity only when every one of these holds:
 *
 *   * the opportunity is **open** — a closed one is never moved and never reopened; the
 *     evidence becomes a review item instead;
 *   * the target stage is **later** than the current one — never backward, never sideways;
 *   * the opportunity is **not pinned**, or the target is later than the pinned stage (a
 *     person's manual choice, `opportunity_stage_pins`); such a move clears the pin;
 *   * the same evidence (kind + id) has **not already** moved it.
 *
 * A move writes the stage event through `moveOpportunityStage`, the same statements a
 * person's `changeStage` runs, and an `opportunity_stage_evidence` row naming the
 * evidence. Anything ambiguous — no rule, no such stage in this workspace, no open
 * opportunity where one is needed — is a `stage_review_items` row, one per evidence,
 * and never a guess.
 *
 * Lock order: the send gate first (a move to Live closes the opportunity, which is a stop
 * fact), then the opportunity, then the firm — `changeStage`'s order.
 */

export interface StageEvidenceInput {
  /** The opportunity the evidence is about, when the emitter knows it. */
  readonly opportunityId?: string | undefined;
  /** Otherwise the firm: its open opportunity is used, or one is opened (see below). */
  readonly firmId?: string | undefined;
  /** A `stage_rules.evidence_kind`: `meeting.booked`, `call.interested`, … */
  readonly evidenceKind: string;
  /** The id of the thing that is the evidence: a meeting id, a call log id. */
  readonly evidenceId: string;
  readonly occurredAt: string;
  /** Codes and ids only; it is stored and shown. */
  readonly detail?: Readonly<Record<string, string | number | boolean | null>> | undefined;
}

export type StageEvidenceOutcome =
  | {
      readonly kind: 'moved';
      readonly opportunityId: string;
      readonly stageEventId: string;
      readonly fromStageKey: string | null;
      readonly toStageKey: string;
      readonly pinCleared: boolean;
    }
  | { readonly kind: 'opened'; readonly opportunityId: string; readonly toStageKey: string }
  | {
      readonly kind: 'unchanged';
      readonly opportunityId: string;
      readonly reason: 'not_forward' | 'pinned' | 'already_applied';
    }
  | { readonly kind: 'review'; readonly reviewItemId: string; readonly reason: StageReviewReason };

export type StageReviewReason =
  | 'opportunity_closed'
  | 'no_opportunity'
  | 'stage_missing'
  | 'rule_missing'
  | 'firm_unmatched'
  | 'firm_ambiguous';

interface RuleRow {
  readonly evidence_kind: string;
  readonly action: 'advance' | 'open_if_none';
  readonly target_stage_key: string;
  readonly [column: string]: unknown;
}

const REASON_PREFIX = 'evidence:';

export async function applyStageEvidence(
  context: RepositoryContext,
  input: StageEvidenceInput,
): Promise<StageEvidenceOutcome> {
  await lockSendGateForStopFact(context);

  const { rows: rules } = await context.db.query<RuleRow>(
    'SELECT evidence_kind, action, target_stage_key FROM stage_rules WHERE evidence_kind = $1',
    [input.evidenceKind],
  );
  const rule = rules[0];
  if (rule === undefined) {
    return await openReviewItem(context, input, 'rule_missing', {
      firmId: input.firmId ?? null,
      opportunityId: null,
    });
  }

  // ---- Which opportunity ---------------------------------------------------
  let opportunity: OpportunityRow | null = null;
  if (input.opportunityId !== undefined) {
    opportunity = await loadOpportunityForUpdate(context, input.opportunityId);
  } else if (input.firmId !== undefined) {
    const open = await readOpenOpportunity(context, input.firmId);
    opportunity = open === null ? null : await loadOpportunityForUpdate(context, open.id);
  }

  const target = await readStageByKey(context, rule.target_stage_key);

  if (opportunity === null) {
    const firmId = input.firmId;
    if (firmId === undefined) {
      return await openReviewItem(context, input, 'no_opportunity', { firmId: null, opportunityId: null });
    }
    // Closed opportunities never reopen automatically: a firm whose history is closed
    // gets a person's look, not a new pipeline row nobody asked for.
    const { rows: closed } = await context.db.query(
      `SELECT 1 FROM opportunities WHERE workspace_id = $1 AND firm_id = $2 AND status <> 'open' LIMIT 1`,
      [context.scope.workspaceId, firmId],
    );
    if (closed.length > 0) {
      return await openReviewItem(context, input, 'opportunity_closed', { firmId, opportunityId: null });
    }
    if (target === null || target.retired || target.terminal_kind !== null) {
      return await openReviewItem(context, input, target === null || target.retired ? 'stage_missing' : 'no_opportunity', {
        firmId,
        opportunityId: null,
      });
    }
    const opened = await openOpportunity(context, { firmId, stageKey: target.key });
    if (!opened.ok) return await openReviewItem(context, input, 'no_opportunity', { firmId, opportunityId: null });
    const { rows: opening } = await context.db.query<{ id: string }>(
      `SELECT id FROM opportunity_stage_events WHERE workspace_id = $1 AND opportunity_id = $2
        ORDER BY occurred_at, id LIMIT 1`,
      [context.scope.workspaceId, opened.value.id],
    );
    const openingEventId = opening[0]?.id;
    if (openingEventId !== undefined) {
      await writeEvidence(context, input, { stageEventId: openingEventId, opportunity: opened.value });
    }
    await recordCrmAuditEvent(context, {
      action: 'opportunity.opened_by_evidence',
      subjectKind: 'opportunity',
      subjectId: opened.value.id,
      detail: { firmId, evidenceKind: input.evidenceKind, evidenceId: input.evidenceId, stage: target.key },
    });
    return { kind: 'opened', opportunityId: opened.value.id, toStageKey: target.key };
  }

  const firm = await loadFirmForUpdate(context, opportunity.firm_id);
  if (firm === null || firm.status === 'merged') {
    return await openReviewItem(context, input, 'firm_unmatched', { firmId: null, opportunityId: null });
  }
  if (opportunity.status !== 'open') {
    return await openReviewItem(context, input, 'opportunity_closed', {
      firmId: opportunity.firm_id,
      opportunityId: opportunity.id,
    });
  }
  // `open_if_none` found one open: that is the existing path's answer, nothing to do.
  if (rule.action === 'open_if_none') {
    return { kind: 'unchanged', opportunityId: opportunity.id, reason: 'not_forward' };
  }

  const { rows: applied } = await context.db.query(
    `SELECT 1 FROM opportunity_stage_evidence
      WHERE workspace_id = $1 AND opportunity_id = $2 AND evidence_kind = $3 AND evidence_id = $4`,
    [context.scope.workspaceId, opportunity.id, input.evidenceKind, input.evidenceId],
  );
  if (applied.length > 0) return { kind: 'unchanged', opportunityId: opportunity.id, reason: 'already_applied' };

  if (target === null || target.retired) {
    return await openReviewItem(context, input, 'stage_missing', {
      firmId: opportunity.firm_id,
      opportunityId: opportunity.id,
    });
  }

  const current = await stageById(context, opportunity.stage_id);
  const pinned = await pinnedStage(context, opportunity.id);
  if (pinned !== null && target.position <= pinned.position) {
    return { kind: 'unchanged', opportunityId: opportunity.id, reason: 'pinned' };
  }
  if (current !== null && target.position <= current.position) {
    return { kind: 'unchanged', opportunityId: opportunity.id, reason: 'not_forward' };
  }

  const moved = await moveOpportunityStage(context, opportunity, target, `${REASON_PREFIX}${input.evidenceKind}`, undefined);
  if (moved === null) {
    return await openReviewItem(context, input, 'no_opportunity', { firmId: opportunity.firm_id, opportunityId: null });
  }
  await writeEvidence(context, input, moved);
  if (pinned !== null) await clearStagePin(context, opportunity.id);
  await recordCrmAuditEvent(context, {
    action: 'opportunity.moved_by_evidence',
    subjectKind: 'opportunity',
    subjectId: moved.opportunity.id,
    detail: {
      firmId: moved.opportunity.firm_id,
      evidenceKind: input.evidenceKind,
      evidenceId: input.evidenceId,
      fromStage: current?.key ?? null,
      toStage: target.key,
      pinCleared: pinned !== null,
    },
  });
  return {
    kind: 'moved',
    opportunityId: moved.opportunity.id,
    stageEventId: moved.stageEventId,
    fromStageKey: current?.key ?? null,
    toStageKey: target.key,
    pinCleared: pinned !== null,
  };
}

async function writeEvidence(
  context: RepositoryContext,
  input: StageEvidenceInput,
  moved: { readonly stageEventId: string; readonly opportunity: OpportunityRow },
): Promise<void> {
  await context.db.query(
    `INSERT INTO opportunity_stage_evidence
       (workspace_id, stage_event_id, opportunity_id, firm_id, evidence_kind, evidence_id, detail, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz)`,
    [
      context.scope.workspaceId,
      moved.stageEventId,
      moved.opportunity.id,
      moved.opportunity.firm_id,
      input.evidenceKind,
      input.evidenceId,
      JSON.stringify(input.detail ?? {}),
      input.occurredAt,
    ],
  );
}

async function stageById(context: RepositoryContext, stageId: string): Promise<PipelineStageRow | null> {
  const { rows } = await context.db.query<PipelineStageRow>(
    `SELECT id, workspace_id, key, display_name, position, terminal_kind, retired
       FROM pipeline_stages WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, stageId],
  );
  return rows[0] ?? null;
}

async function pinnedStage(context: RepositoryContext, opportunityId: string): Promise<PipelineStageRow | null> {
  const { rows } = await context.db.query<PipelineStageRow>(
    `SELECT s.id, s.workspace_id, s.key, s.display_name, s.position, s.terminal_kind, s.retired
       FROM opportunity_stage_pins p
       JOIN pipeline_stages s ON s.workspace_id = p.workspace_id AND s.id = p.stage_id
      WHERE p.workspace_id = $1 AND p.opportunity_id = $2`,
    [context.scope.workspaceId, opportunityId],
  );
  return rows[0] ?? null;
}

/**
 * One review item per evidence (`stage_review_items_once`): a redelivery of the same
 * evidence finds the item it already opened rather than a second.
 *
 * An item a person already **resolved** is reopened with the new reason instead (slice
 * M1). A person matching an unmatched booking resolves its `firm_unmatched` item and
 * then applies the booking's evidence; when that evidence still cannot apply — the
 * firm's opportunity is closed, say — the answer must be an open item saying so, not the
 * resolved one read back with its old reason.
 */
export async function openReviewItem(
  context: RepositoryContext,
  input: Pick<StageEvidenceInput, 'evidenceKind' | 'evidenceId' | 'detail'>,
  reason: StageReviewReason,
  subject: { readonly firmId: string | null; readonly opportunityId: string | null },
): Promise<StageEvidenceOutcome> {
  await context.db.query(
    `INSERT INTO stage_review_items (workspace_id, firm_id, opportunity_id, evidence_kind, evidence_id, reason, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT ON CONSTRAINT stage_review_items_once DO UPDATE
        SET reason = EXCLUDED.reason, firm_id = EXCLUDED.firm_id, opportunity_id = EXCLUDED.opportunity_id,
            detail = EXCLUDED.detail, created_at = now(), resolved_at = NULL, resolved_by_user_id = NULL
      WHERE stage_review_items.resolved_at IS NOT NULL`,
    [
      context.scope.workspaceId,
      subject.firmId,
      subject.firmId === null ? null : subject.opportunityId,
      input.evidenceKind,
      input.evidenceId,
      reason,
      JSON.stringify(input.detail ?? {}),
    ],
  );
  const { rows } = await context.db.query<{ id: string; reason: StageReviewReason }>(
    'SELECT id, reason FROM stage_review_items WHERE workspace_id = $1 AND evidence_kind = $2 AND evidence_id = $3',
    [context.scope.workspaceId, input.evidenceKind, input.evidenceId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('a review item just written could not be read back');
  return { kind: 'review', reviewItemId: row.id, reason: row.reason };
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export interface OpportunityValue {
  readonly monthlyCents: number;
  readonly kind: 'estimated' | 'agreed';
  readonly source: string;
  readonly recordedAt: string;
}

/**
 * Record a monthly value for an opportunity. Append-only: the latest row is the value,
 * and the history stays. `source` is a short code — `research`, `call`, `person`.
 */
export async function recordOpportunityValue(
  context: RepositoryContext,
  input: {
    readonly opportunityId: string;
    readonly monthlyCents: number;
    readonly kind: 'estimated' | 'agreed';
    readonly source: string;
  },
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: 'opportunity_unknown' | 'invalid_input' }> {
  if (!Number.isInteger(input.monthlyCents) || input.monthlyCents < 0 || input.monthlyCents > 100_000_000) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (!/^[a-z][a-z0-9_]{1,39}$/u.test(input.source)) return { ok: false, reason: 'invalid_input' };
  const actor = context.scope.actor;
  const { rowCount } = await context.db.query(
    `INSERT INTO opportunity_values (workspace_id, opportunity_id, firm_id, monthly_cents, kind, source, recorded_by_user_id)
     SELECT o.workspace_id, o.id, o.firm_id, $3, $4, $5, $6 FROM opportunities o
      WHERE o.workspace_id = $1 AND o.id = $2`,
    [
      context.scope.workspaceId,
      input.opportunityId,
      input.monthlyCents,
      input.kind,
      input.source,
      actor.kind === 'user' ? actor.userId : null,
    ],
  );
  return (rowCount ?? 0) === 1 ? { ok: true } : { ok: false, reason: 'opportunity_unknown' };
}
