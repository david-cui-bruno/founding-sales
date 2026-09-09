import { z } from 'zod';
import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { accountIdSchema as id, accountInstantSchema as instant, accountRouteSchema, accountSchema } from '../../../../src/shared/contracts/accountContract';
import { campaignCommandPayloadSchema, campaignEventPayloadSchema, campaignVersionSchema, enrollmentSchema, stepEvidenceSchema, type CampaignCommandPayload, type CampaignEventPayload } from '../../../../src/shared/contracts/campaignContract';
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
  /** Trusted C4 outcome composition. The caller commits these with the actual action outcome and outbox. */
  async prepareOutcomePlan(raw: { commandId: string; accountId: string; actionId: string; state: 'unknown' | 'provider_accepted' | 'cancelled'; observedAt: string }) {
    const input = z.strictObject({ commandId: z.uuid(), accountId: id, actionId: id, state: z.enum(['unknown','provider_accepted','cancelled']), observedAt: instant }).parse(raw);
    const reservationRow = await this.required(campaignReservationKey(input.accountId, input.actionId));
    const reservation = campaignReservationSchema.parse(reservationRow.data);
    const row = await this.required(campaignEnrollmentKey(reservation.input.enrollmentId)); const enrollment = enrollmentSchema.parse(row.data);
    return this.planCommand({ commandId: input.commandId, accountId: input.accountId, payload: { kind: 'campaign.outcome', enrollmentId: enrollment.id,
      expectedEnrollmentVersion: enrollment.version, evidence: { enrollmentId: enrollment.id, accountId: input.accountId, campaignVersionId: reservation.campaignVersionId, actionId: input.actionId, stepId: reservation.input.stepId, routeId: reservation.input.selectedRouteId, routeVersion: reservation.routeVersion,
        contextRevision: reservation.numericContextRevision, executionContextId: reservation.input.contextRevision, channel: reservation.input.channel,
        observation: 'unknown', outcome: input.state, source: 'provider', state: input.state, observedAt: input.observedAt } } });
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
      } else if (command.kind === 'campaign.route') {
        if (command.contextRevision <= old.contextRevision) throw new Error('stale_context');
        const route = await this.accountRoute(input.accountId, command.selectedRouteId);
        enrollment.selectedRouteId = route.route.id; enrollment.selectedRouteVersion = route.route.version; enrollment.personId = route.route.personId; enrollment.contextRevision = command.contextRevision; enrollment.executionContextId = command.executionContextId;
        items.push(this.store.check(route.key, route.row.rev));
      } else {
        const evidence = command.evidence;
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
        const observationOnly = reservation.state === 'sent' && (evidence.observation === 'no_reply' || interruption);
        if (reservation.state === 'sent' && !observationOnly) throw new Error('campaign_outcome_conflict');
        const currentBinding = evidence.stepId === old.currentStepId && evidence.routeId === old.selectedRouteId && evidence.routeVersion === old.selectedRouteVersion && evidence.contextRevision === old.contextRevision && evidence.executionContextId === old.executionContextId;
        if (observationOnly) {
          const previous = await this.evidence(old.id);
          const sent = previous.filter(item => item.actionId === evidence.actionId && ['human_reported_sent','provider_accepted'].includes(item.state));
          if (!sent.length || sent.some(item => item.observedAt > evidence.observedAt)) throw new Error('campaign_evidence_time');
        }
        const actual = evidence.state === 'human_reported_sent' || evidence.state === 'provider_accepted';
        if (actual && ((evidence.channel === 'email') !== (evidence.source === 'provider') || (evidence.source === 'provider') !== (evidence.state === 'provider_accepted'))) throw new Error('campaign_outcome_source');
        if (actual && !observationOnly) {
          if (reservation.state === 'sent' || reservation.state === 'cancelled') throw new Error('campaign_outcome_conflict');
          const capKey = campaignCapKey(old.campaignVersionId, evidence.channel); const capRow = await this.required(capKey); const cap = campaignCapSchema.parse(capRow.data);
          if (cap.reserved < 1) throw new Error('campaign_cap_conflict');
          items.push(this.store.put(capKey, { reserved: cap.reserved - 1, sent: cap.sent + 1 }, capRow.rev));
          const { version } = await this.approvedVersion(old.campaignVersionId);
          const index = version.steps.findIndex(step => step.id === evidence.stepId);
          const next = version.steps[index + 1];
          if (old.state === 'active' && !interruption && currentBinding) {
            enrollment.currentStepId = next?.id ?? null;
            if (!next) enrollment.state = 'completed';
          }
        }
        const state = observationOnly ? reservation.state : actual ? 'sent' : evidence.state === 'unknown' ? 'unknown' : reservation.state;
        items.push(this.store.put(reservationKey, { ...reservation, state }, reservationRow.rev));
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
