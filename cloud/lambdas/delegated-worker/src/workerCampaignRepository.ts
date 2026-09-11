import { z } from 'zod';
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { accountIdSchema as id, accountInstantSchema as instant, accountRouteSchema, accountSchema } from '../../../../src/shared/contracts/accountContract';
import { campaignCommandPayloadSchema, campaignCancellationEvidenceSchema, campaignEventPayloadSchema, campaignVersionSchema, enrollmentSchema, stepEvidenceSchema, type CampaignCommandPayload, type CampaignEventPayload } from '../../../../src/shared/contracts/campaignContract';
import { DynamoStore, fingerprint, integer, keyPart, type RepositoryOptions } from './dynamoStore';

export const campaignVersionKey = (value: string) => `CAMPAIGN_VERSION#${keyPart(value)}`;
export const campaignApprovalKey = (value: string) => `CAMPAIGN_APPROVAL#${keyPart(value)}`;
export const campaignEnrollmentKey = (value: string) => `CAMPAIGN_ENROLLMENT#${keyPart(value)}`;
export const campaignSlotKey = (value: string) => `CAMPAIGN_SLOT#${keyPart(value)}`;
export const campaignCapKey = (version: string, channel: string) => `CAMPAIGN_CAP#${keyPart(version)}#${channel}`;
export const campaignActionApprovalKey = (account: string, action: string) => `CAMPAIGN_ACTION_APPROVAL#${keyPart(account)}#${keyPart(action)}`;
export const campaignReservationKey = (account: string, action: string) => `CAMPAIGN_RESERVATION#${keyPart(account)}#${keyPart(action)}`;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const campaignExecutionInputSchema = z.strictObject({ workspaceId: id, accountId: id, campaignId: id, campaignRevision: integer.positive(),
  enrollmentId: id, enrollmentRevision: integer.positive(), stepId: id, actionId: id, channel: z.enum(['call', 'email', 'linkedin']),
  authorityGeneration: integer, selectedRouteId: id, contextRevision: id, contentHash: hash, targetHash: hash });
export type CampaignExecutionInput = z.infer<typeof campaignExecutionInputSchema>;
export const campaignActionApprovalSchema = campaignExecutionInputSchema.extend({ approvedAt: instant, expiresAt: instant });
const versionApprovalSchema = z.strictObject({ snapshotHash: hash, approvedAt: instant });
const slotSchema = z.strictObject({ enrollmentId: id, state: enrollmentSchema.shape.state });
export const campaignReservationSchema = z.strictObject({ input: campaignExecutionInputSchema, campaignVersionId: id, routeVersion: integer.positive(), numericContextRevision: integer, state: z.enum(['reserved', 'unknown', 'sent', 'cancelled']) });
export const campaignCapSchema = z.strictObject({ reserved: integer, sent: integer });
const terminal = (state: string) => state === 'completed' || state === 'stopped';
const requestedFollowupInputSchema = z.strictObject({ accountId: id, originalActionId: id, originalOutcomeCommandId: z.uuid() });
export type RequestedFollowupCampaignInput = z.infer<typeof requestedFollowupInputSchema>;
export type RequestedFollowupCampaignOrigin = {
  accountId: string; campaignVersionId: string; enrollmentId: string; stepId: string; actionId: string;
  originalOutcomeCommandId: string; routeId: string; routeVersion: number; executionContextId: string; contextRevision: number;
};


/** Plans are consumed by C1's owner/receipt/outbox transaction. This class never sends or independently owns delegated commands. */
export class WorkerCampaignRepository {
  readonly store: DynamoStore;
  constructor(options: RepositoryOptions) { this.store = new DynamoStore(options); }
  async required(key: string) { const row = await this.store.get<unknown>(key); if (!row) throw new Error('campaign_record_missing'); return row; }
  async approvedVersion(versionId: string) {
    const row = await this.required(campaignVersionKey(versionId)); const version = campaignVersionSchema.parse(row.data);
    const approvalRow = await this.required(campaignApprovalKey(versionId)); const approval = versionApprovalSchema.parse(approvalRow.data);
    if (version.id !== versionId || approval.snapshotHash !== fingerprint(version) || approval.approvedAt > this.store.now()) throw new Error('campaign_unapproved');
    return { row, approvalRow, version: { ...version, approvedAt: approval.approvedAt } };
  }
  async accountRoute(accountId: string, routeId: string) {
    const key = `ACCOUNT#${keyPart(accountId)}`; const row = await this.required(key);
    const record = z.object({ account: accountSchema, routes: z.array(accountRouteSchema) }).parse(row.data);
    const route = record.routes.filter(r => r.id === routeId && r.accountId === accountId).sort((a, b) => b.version - a.version)[0];
    if (record.account.id !== accountId || !route || route.purpose !== 'business') throw new Error('campaign_route_mismatch');
    return { key, row, route };
  }
  async evidence(enrollmentId: string) {
    const rows = await this.store.list<unknown>(`CAMPAIGN_EVIDENCE#${keyPart(enrollmentId)}#`);
    return rows.map(row => stepEvidenceSchema.parse(row.stored.data));
  }
  /** This admission capability is only exposed through explicit user approval composition, never inferred from campaign strategy approval. */
  async admitActionApproval(input: z.infer<typeof campaignActionApprovalSchema>) {
    const approval = campaignActionApprovalSchema.parse(input); this.store.workspace(approval.workspaceId);
    if (approval.approvedAt > this.store.now() || approval.expiresAt <= this.store.now()) throw new Error('campaign_evidence_expired');
    const row = await this.required(campaignEnrollmentKey(approval.enrollmentId)); const enrollment = enrollmentSchema.parse(row.data);
    const { version, row: versionRow, approvalRow } = await this.approvedVersion(enrollment.campaignVersionId);
    if (enrollment.accountId !== approval.accountId || enrollment.version !== approval.enrollmentRevision || enrollment.selectedRouteId !== approval.selectedRouteId || enrollment.executionContextId !== approval.contextRevision
      || version.campaignId !== approval.campaignId || version.version !== approval.campaignRevision || !version.cohortAccountIds.includes(approval.accountId)) throw new Error('campaign_binding_mismatch');
    await this.store.transact([this.store.put(campaignActionApprovalKey(approval.accountId, approval.actionId), approval, null),
      this.store.check(campaignEnrollmentKey(enrollment.id), row.rev), this.store.check(campaignVersionKey(version.id), versionRow.rev), this.store.check(campaignApprovalKey(version.id), approvalRow.rev)]);
  }
  /** Materialization joins these items and payload to the real owner status transaction. */
  async prepareRequestedFollowupPlan(raw: RequestedFollowupCampaignInput & { commandId: string }): Promise<{ items: TransactWriteItem[]; payload: CampaignEventPayload; origin: RequestedFollowupCampaignOrigin }> {
    const input = requestedFollowupInputSchema.extend({ commandId: z.uuid() }).parse(raw);
    const read = await this.readRequestedFollowup(input);
    if (read.enrollment.state === 'active') {
      const plan = await this.planCommand({ commandId: input.commandId, accountId: input.accountId, payload: { kind: 'campaign.state', enrollmentId: read.enrollment.id,
        expectedEnrollmentVersion: read.enrollment.version, state: 'conversation', reason: 'Individually approved requested phone follow-up' } });
      // planCommand owns both enrollment/slot writes. Keep the original reader's
      // remaining fences, never duplicate a Dynamo target with a Check and Put.
      const items = [...read.proofItems, ...plan.items];
      if (items.length > 100) throw new Error('transaction_capacity_exceeded');
      return { items, payload: plan.payload, origin: read.origin };
    }
    return { items: read.items, payload: { commandId: input.commandId, version: null, enrollment: null, evidence: null }, origin: read.origin };
  }
  /** Draft preparation/save may inspect active origin, but never changes its state or grants execution. */
  async requestedFollowupPreparationChecks(raw: RequestedFollowupCampaignInput): Promise<{ items: TransactWriteItem[]; origin: RequestedFollowupCampaignOrigin }> {
    const read = await this.readRequestedFollowup(requestedFollowupInputSchema.parse(raw));
    return { items: read.items, origin: read.origin };
  }
  /** Final reservation is strictly read-only: it cannot silently hold a resumed campaign. */
  async requestedFollowupChecks(raw: RequestedFollowupCampaignInput): Promise<{ items: TransactWriteItem[]; origin: RequestedFollowupCampaignOrigin }> {
    const read = await this.readRequestedFollowup(requestedFollowupInputSchema.parse(raw));
    if (read.enrollment.state === 'active') throw new Error('campaign_requested_followup_held');
    return { items: read.items, origin: read.origin };
  }
  private async readRequestedFollowup(input: RequestedFollowupCampaignInput) {
    const reservationKey = campaignReservationKey(input.accountId, input.originalActionId);
    const reservationRow = await this.required(reservationKey); const reservation = campaignReservationSchema.parse(reservationRow.data);
    const binding = reservation.input;
    if (reservation.state !== 'sent' || binding.channel !== 'call' || binding.accountId !== input.accountId || binding.actionId !== input.originalActionId) throw new Error('campaign_requested_followup_origin');
    const enrollmentKey = campaignEnrollmentKey(binding.enrollmentId); const enrollmentRow = await this.required(enrollmentKey); const enrollment = enrollmentSchema.parse(enrollmentRow.data);
    if (enrollment.accountId !== input.accountId || enrollment.campaignVersionId !== reservation.campaignVersionId) throw new Error('campaign_requested_followup_origin');
    if (!['active', 'conversation', 'completed'].includes(enrollment.state)) throw new Error('campaign_requested_followup_held');
    const slotKey = campaignSlotKey(input.accountId); const slotRow = await this.required(slotKey); const slot = slotSchema.parse(slotRow.data);
    if (slot.enrollmentId !== enrollment.id && !terminal(slot.state)) throw new Error('campaign_requested_followup_held');
    if (enrollment.state !== 'completed' && slot.enrollmentId !== enrollment.id) throw new Error('campaign_slot_mismatch');
    const evidenceKey = `CAMPAIGN_EVIDENCE#${keyPart(enrollment.id)}#${keyPart(input.originalOutcomeCommandId)}`;
    const evidenceRow = await this.required(evidenceKey); const evidence = stepEvidenceSchema.parse(evidenceRow.data);
    if (evidence.enrollmentId !== enrollment.id || evidence.accountId !== input.accountId || evidence.campaignVersionId !== reservation.campaignVersionId
      || evidence.actionId !== input.originalActionId || evidence.stepId !== binding.stepId || evidence.routeId !== binding.selectedRouteId || evidence.routeVersion !== reservation.routeVersion
      || evidence.executionContextId !== binding.contextRevision || evidence.contextRevision !== reservation.numericContextRevision
      || evidence.channel !== 'call' || evidence.source !== 'human' || evidence.state !== 'human_reported_sent' || evidence.outcome !== 'connected'
      || evidence.conflict || evidence.observedAt < enrollment.startedAt || evidence.observedAt > this.store.now()) throw new Error('campaign_requested_followup_origin');
    const evidenceRows = await this.evidence(enrollment.id);
    if (evidenceRows.some(e => e.conflict || e.outcome === 'opt_out')) throw new Error('campaign_requested_followup_held');
    const approved = await this.approvedVersion(enrollment.campaignVersionId);
    if (!approved.version.cohortAccountIds.includes(input.accountId) || approved.version.campaignId !== binding.campaignId || approved.version.version !== binding.campaignRevision
      || !approved.version.steps.some(step => step.id === binding.stepId && step.channel === 'call')) throw new Error('campaign_requested_followup_origin');
    const proofItems = [this.store.check(evidenceKey, evidenceRow.rev), this.store.check(campaignVersionKey(enrollment.campaignVersionId), approved.row.rev),
      this.store.check(campaignApprovalKey(enrollment.campaignVersionId), approved.approvalRow.rev)];
    let foundOriginal = false;
    for (const step of approved.version.steps) {
      const stepKey = `CAMPAIGN_STEP_RESERVATION#${keyPart(enrollment.id)}#${keyPart(step.id)}`;
      const stepRow = await this.store.get<unknown>(stepKey);
      if (!stepRow) { proofItems.push(this.store.absent(stepKey)); continue; }
      const stepBinding = z.strictObject({ actionId: id }).parse(stepRow.data);
      const actionKey = campaignReservationKey(input.accountId, stepBinding.actionId);
      const actionRow = await this.required(actionKey); const action = campaignReservationSchema.parse(actionRow.data);
      if (action.input.accountId !== input.accountId || action.input.enrollmentId !== enrollment.id || action.input.stepId !== step.id || action.input.actionId !== stepBinding.actionId
        || action.input.channel !== step.channel || action.campaignVersionId !== enrollment.campaignVersionId) throw new Error('campaign_requested_followup_origin');
      if (action.state === 'reserved' || action.state === 'unknown') throw new Error('campaign_requested_followup_unresolved');
      if (step.id === binding.stepId) {
        if (stepBinding.actionId !== input.originalActionId || actionRow.rev !== reservationRow.rev) throw new Error('campaign_requested_followup_origin');
        foundOriginal = true;
      }
      proofItems.push(this.store.check(stepKey, stepRow.rev), this.store.check(actionKey, actionRow.rev));
      if (proofItems.length > 98) throw new Error('transaction_capacity_exceeded');
    }
    if (!foundOriginal) throw new Error('campaign_requested_followup_origin');
    const items = [...proofItems, this.store.check(enrollmentKey, enrollmentRow.rev), this.store.check(slotKey, slotRow.rev)];
    if (items.length > 100) throw new Error('transaction_capacity_exceeded');
    const origin: RequestedFollowupCampaignOrigin = { accountId: input.accountId, campaignVersionId: enrollment.campaignVersionId, enrollmentId: enrollment.id,
      stepId: binding.stepId, actionId: input.originalActionId, originalOutcomeCommandId: input.originalOutcomeCommandId, routeId: evidence.routeId, routeVersion: evidence.routeVersion,
      executionContextId: evidence.executionContextId, contextRevision: evidence.contextRevision };
    return { enrollment, proofItems, items, origin };
  }
  /** Trusted C4 outcome composition. The caller commits these with the actual action outcome and outbox. */
  async prepareOutcomePlan(raw: { commandId: string; accountId: string; actionId: string; state: 'unknown' | 'provider_accepted' | 'cancelled'; observedAt: string; cancellationEvidence?: z.infer<typeof campaignCancellationEvidenceSchema> }) {
    const input = z.strictObject({ commandId: z.uuid(), accountId: id, actionId: id, state: z.enum(['unknown','provider_accepted','cancelled']), observedAt: instant, cancellationEvidence: campaignCancellationEvidenceSchema.optional() }).refine(value => !value.cancellationEvidence || value.state === 'cancelled').parse(raw);
    const reservationRow = await this.required(campaignReservationKey(input.accountId, input.actionId));
    const reservation = campaignReservationSchema.parse(reservationRow.data);
    const row = await this.required(campaignEnrollmentKey(reservation.input.enrollmentId)); const enrollment = enrollmentSchema.parse(row.data);
    return this.planCommand({ commandId: input.commandId, accountId: input.accountId, payload: { kind: 'campaign.outcome', enrollmentId: enrollment.id,
      expectedEnrollmentVersion: enrollment.version, evidence: { enrollmentId: enrollment.id, accountId: input.accountId, campaignVersionId: reservation.campaignVersionId, actionId: input.actionId, stepId: reservation.input.stepId, routeId: reservation.input.selectedRouteId, routeVersion: reservation.routeVersion,
        contextRevision: reservation.numericContextRevision, executionContextId: reservation.input.contextRevision, channel: reservation.input.channel,
        ...(input.cancellationEvidence ? { cancellationEvidence: input.cancellationEvidence } : {}), observation: 'unknown', outcome: input.state, source: 'provider', state: input.state, observedAt: input.observedAt } } });
  }
  async planCommand(input: { commandId: string; accountId: string; payload: CampaignCommandPayload }): Promise<{ items: TransactWriteItem[]; payload: CampaignEventPayload }> {
    z.uuid().parse(input.commandId); id.parse(input.accountId); const command = campaignCommandPayloadSchema.parse(input.payload);
    const items: TransactWriteItem[] = []; let payload: CampaignEventPayload = { commandId: input.commandId, version: null, enrollment: null, evidence: null };
    if (command.kind === 'campaign.version') {
      if (command.version.approvedAt !== null || !command.version.cohortAccountIds.includes(input.accountId)) throw new Error('campaign_unapproved');
      items.push(this.store.put(campaignVersionKey(command.version.id), command.version, null),
        this.store.put(`CAMPAIGN_VERSION_NUMBER#${keyPart(command.version.campaignId)}#${command.version.version}`, { id: command.version.id }, null));
      payload.version = command.version;
    } else if (command.kind === 'campaign.approve') {
      const row = await this.required(campaignVersionKey(command.campaignVersionId)); const version = campaignVersionSchema.parse(row.data);
      if (fingerprint(version) !== command.snapshotHash || command.approvedAt > this.store.now() || !version.cohortAccountIds.includes(input.accountId)) throw new Error('campaign_approval_mismatch');
      items.push(this.store.check(campaignVersionKey(version.id), row.rev), this.store.put(campaignApprovalKey(version.id), { snapshotHash: command.snapshotHash, approvedAt: command.approvedAt }, null));
      for (const channel of ['call', 'email', 'linkedin']) items.push(this.store.put(campaignCapKey(version.id, channel), { reserved: 0, sent: 0 }, null));
      payload.version = { ...version, approvedAt: command.approvedAt };
    } else if (command.kind === 'campaign.enroll') {
      const { version, row, approvalRow } = await this.approvedVersion(command.campaignVersionId);
      if (!version.cohortAccountIds.includes(input.accountId)) throw new Error('campaign_cohort_mismatch');
      const slot = await this.store.get<unknown>(campaignSlotKey(input.accountId));
      if (slot && !terminal(slotSchema.parse(slot.data).state)) throw new Error('account_already_enrolled');
      const route = await this.accountRoute(input.accountId, command.selectedRouteId);
      const enrollment = enrollmentSchema.parse({ id: command.enrollmentId, accountId: input.accountId, selectedRouteId: command.selectedRouteId, selectedRouteVersion: route.route.version, personId: route.route.personId,
        campaignVersionId: version.id, currentStepId: version.steps[0]!.id, version: 1, state: 'active', executionContextId: command.executionContextId, contextRevision: command.contextRevision, startedAt: this.store.now() });
      items.push(this.store.put(campaignEnrollmentKey(enrollment.id), enrollment, null), this.store.put(campaignSlotKey(input.accountId), { enrollmentId: enrollment.id, state: enrollment.state }, slot?.rev ?? null),
        this.store.check(campaignVersionKey(version.id), row.rev), this.store.check(campaignApprovalKey(version.id), approvalRow.rev), this.store.check(route.key, route.row.rev));
      payload.enrollment = enrollment;
    } else {
      const key = campaignEnrollmentKey(command.enrollmentId); const row = await this.required(key); const old = enrollmentSchema.parse(row.data);
      if (old.accountId !== input.accountId || old.version !== command.expectedEnrollmentVersion) throw new Error('stale_enrollment');
      if (terminal(old.state) && command.kind !== 'campaign.outcome') throw new Error('terminal_enrollment');
      const slot = await this.required(campaignSlotKey(input.accountId));
      if (!terminal(old.state) && slotSchema.parse(slot.data).enrollmentId !== old.id) throw new Error('campaign_slot_mismatch');
      const enrollment = { ...old, version: old.version + 1 };
      if (command.kind === 'campaign.state') {
        if (old.state === 'conversation' && command.state === 'active') throw new Error('conversation_requires_review');
        enrollment.state = command.state;
        if (command.state === 'active' && ['paused', 'held'].includes(old.state)) {
          const receipts = await this.store.list<unknown>(`CAMPAIGN_EVIDENCE#${keyPart(old.id)}#`);
          if (receipts.some(receipt => stepEvidenceSchema.parse(receipt.stored.data).conflict)) throw new Error('campaign_conflict_requires_review');
          const accepted = receipts.map(receipt => ({ ...receipt, evidence: stepEvidenceSchema.parse(receipt.stored.data) })).filter(({ evidence: e }) =>
            !e.conflict && e.enrollmentId === old.id && e.accountId === old.accountId && e.campaignVersionId === old.campaignVersionId && e.stepId === old.currentStepId
            && e.routeId === old.selectedRouteId && e.routeVersion === old.selectedRouteVersion && e.contextRevision === old.contextRevision && e.executionContextId === old.executionContextId
            && ['human_reported_sent', 'provider_accepted'].includes(e.state) && e.observedAt >= old.startedAt && e.observedAt <= this.store.now())
            .sort((a, b) => b.evidence.observedAt.localeCompare(a.evidence.observedAt))[0];
          if (accepted) {
            const e = accepted.evidence; const reservationKey = campaignReservationKey(old.accountId, e.actionId);
            const reservationRow = await this.required(reservationKey); const reservation = campaignReservationSchema.parse(reservationRow.data);
            if (reservation.state !== 'sent' || reservation.campaignVersionId !== old.campaignVersionId || reservation.input.enrollmentId !== old.id
              || reservation.input.accountId !== old.accountId || reservation.input.stepId !== e.stepId || reservation.input.selectedRouteId !== e.routeId
              || reservation.routeVersion !== e.routeVersion || reservation.numericContextRevision !== e.contextRevision || reservation.input.contextRevision !== e.executionContextId
              || reservation.input.channel !== e.channel) throw new Error('campaign_resume_evidence_mismatch');
            const approved = await this.approvedVersion(old.campaignVersionId);
            const index = approved.version.steps.findIndex(step => step.id === old.currentStepId);
            if (index < 0) throw new Error('campaign_step_ineligible');
            enrollment.currentStepId = approved.version.steps[index + 1]?.id ?? null;
            if (!enrollment.currentStepId) enrollment.state = 'completed';
            items.push(this.store.check(accepted.key, accepted.stored.rev), this.store.check(reservationKey, reservationRow.rev),
              this.store.check(campaignVersionKey(old.campaignVersionId), approved.row.rev), this.store.check(campaignApprovalKey(old.campaignVersionId), approved.approvalRow.rev));
          }
        }

      } else if (command.kind === 'campaign.route') {
        if (command.contextRevision <= old.contextRevision) throw new Error('stale_context');
        const route = await this.accountRoute(input.accountId, command.selectedRouteId);
        enrollment.selectedRouteId = route.route.id; enrollment.selectedRouteVersion = route.route.version; enrollment.personId = route.route.personId; enrollment.contextRevision = command.contextRevision; enrollment.executionContextId = command.executionContextId;
        items.push(this.store.check(route.key, route.row.rev));
      } else {
        let evidence = command.evidence;
        if (evidence.conflict) throw new Error('campaign_conflict_marker_untrusted');
        if (evidence.enrollmentId !== old.id || evidence.accountId !== old.accountId || evidence.campaignVersionId !== old.campaignVersionId) throw new Error('campaign_evidence_binding');
        if (evidence.observedAt > this.store.now() || evidence.observedAt < old.startedAt) throw new Error('campaign_evidence_time');
        const interruption = evidence.observation === 'replied' || ['reply', 'booked', 'opt_out'].includes(evidence.outcome);
        if (interruption && !terminal(old.state)) enrollment.state = ['booked', 'opt_out'].includes(evidence.outcome) ? 'stopped' : 'conversation';
        const reservationKey = campaignReservationKey(input.accountId, evidence.actionId);
        const reservationRow = await this.store.get<unknown>(reservationKey);
        if (!reservationRow) throw new Error('campaign_reservation_missing');
        const reservation = campaignReservationSchema.parse(reservationRow.data); const binding = reservation.input;
        if (binding.enrollmentId !== old.id || reservation.campaignVersionId !== old.campaignVersionId || binding.accountId !== input.accountId
          || binding.stepId !== evidence.stepId || binding.selectedRouteId !== evidence.routeId || binding.contextRevision !== evidence.executionContextId
          || binding.channel !== evidence.channel || reservation.routeVersion !== evidence.routeVersion || reservation.numericContextRevision !== evidence.contextRevision) throw new Error('campaign_evidence_binding');
        const definitiveManualCancellation = evidence.state === 'cancelled' && evidence.source === 'human' && evidence.observation === 'unknown'
          && (evidence.channel === 'call' && evidence.outcome === 'not_called' || evidence.channel === 'linkedin' && evidence.outcome === 'not_sent');
        const definitiveCancellation = definitiveManualCancellation || evidence.state === 'cancelled' && evidence.channel === 'email' && evidence.source === 'provider' && evidence.cancellationEvidence !== undefined;
        const actual = evidence.state === 'human_reported_sent' || evidence.state === 'provider_accepted';
        if (actual && ((evidence.channel === 'email') !== (evidence.source === 'provider') || (evidence.source === 'provider') !== (evidence.state === 'provider_accepted'))) throw new Error('campaign_outcome_source');
        const conflict = reservation.state === 'cancelled' && actual || reservation.state === 'sent' && definitiveCancellation;
        if (conflict) { evidence = { ...evidence, conflict: 'contradictory_finalized_outcome' }; if (!terminal(old.state)) enrollment.state = 'held'; }
        if (reservation.state === 'cancelled' && !conflict) throw new Error('campaign_outcome_conflict');
        const observationOnly = reservation.state === 'sent' && (evidence.observation === 'no_reply' || interruption);
        if (reservation.state === 'sent' && !observationOnly && !conflict) throw new Error('campaign_outcome_conflict');
        const currentBinding = evidence.stepId === old.currentStepId && evidence.routeId === old.selectedRouteId && evidence.routeVersion === old.selectedRouteVersion && evidence.contextRevision === old.contextRevision && evidence.executionContextId === old.executionContextId;
        if (observationOnly) {
          const previous = await this.evidence(old.id);
          const sent = previous.filter(item => item.actionId === evidence.actionId && ['human_reported_sent','provider_accepted'].includes(item.state));
          if (!sent.length || sent.some(item => item.observedAt > evidence.observedAt)) throw new Error('campaign_evidence_time');
        }
        const capKey = campaignCapKey(old.campaignVersionId, evidence.channel); const capRow = await this.required(capKey); const cap = campaignCapSchema.parse(capRow.data);
        payload.cap = { campaignVersionId: old.campaignVersionId, channel: evidence.channel, revision: capRow.rev, ...cap };
        if (actual && !observationOnly && !conflict) {
          if (reservation.state === 'sent') throw new Error('campaign_outcome_conflict');
          if (cap.reserved < 1) throw new Error('campaign_cap_conflict');
          items.push(this.store.put(capKey, { reserved: cap.reserved - 1, sent: cap.sent + 1 }, capRow.rev));
          payload.cap = { ...payload.cap, revision: capRow.rev + 1, reserved: cap.reserved - 1, sent: cap.sent + 1 };
          const { version } = await this.approvedVersion(old.campaignVersionId);
          const index = version.steps.findIndex(step => step.id === evidence.stepId);
          const next = version.steps[index + 1];
          if (old.state === 'active' && !interruption && currentBinding) {
            enrollment.currentStepId = next?.id ?? null;
            if (!next) enrollment.state = 'completed';
          }
        }
        if (definitiveCancellation && !conflict) {
          if (cap.reserved < 1) throw new Error('campaign_cap_conflict');
          items.push(this.store.put(capKey, { reserved: cap.reserved - 1, sent: cap.sent }, capRow.rev));
          payload.cap = { ...payload.cap, revision: capRow.rev + 1, reserved: cap.reserved - 1 };
        }
        if (conflict || !(actual && !observationOnly) && !definitiveCancellation) items.push(this.store.check(capKey, capRow.rev));
        const state = definitiveCancellation ? 'cancelled' : observationOnly ? reservation.state : actual ? 'sent' : evidence.state === 'unknown' ? 'unknown' : reservation.state;
        items.push(conflict ? this.store.check(reservationKey, reservationRow.rev) : this.store.put(reservationKey, { ...reservation, state }, reservationRow.rev));
        // Enqueue and unresolved evidence never advance. Only actual outcomes select the next step.
        items.push(this.store.put(`CAMPAIGN_EVIDENCE#${keyPart(old.id)}#${keyPart(input.commandId)}`, evidence, null)); payload.evidence = evidence;
      }
      payload.enrollment = enrollmentSchema.parse(enrollment);
      items.push(this.store.put(key, payload.enrollment, row.rev));
      if (!terminal(old.state)) items.push(this.store.put(campaignSlotKey(input.accountId), { enrollmentId: old.id, state: enrollment.state }, slot.rev));
    }
    payload = campaignEventPayloadSchema.parse(payload);
    return { items, payload };
  }
}
