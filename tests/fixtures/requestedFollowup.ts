import { campaignVersionSchema, enrollmentSchema, stepEvidenceSchema } from '../../src/shared/contracts/campaignContract';
import { campaignReservationSchema } from '../../cloud/lambdas/delegated-worker/src/workerCampaignRepository';
import { accountFingerprint } from '../../src/main/domain/accounts/accountEvidence';
import { ownerCommandSchema, manualHandoffSchema, ownerSourceConfigurationSchema } from '../../src/shared/contracts/ownerCommandContract';
import { workerEventSchema } from '../../src/shared/contracts/delegationContract';
import { accountRecordSchema } from '../../src/shared/contracts/accountRecordContract';
import { originalCallRefSchema, requestedFollowupDraftSchema } from '../../src/shared/contracts/requestedFollowupContract';
import { requestedFollowupContextRevision } from '../../src/main/outreach/requestedFollowupService';
export const REQUESTED_NOW = '2026-09-08T12:00:00.000Z';
/** Synthetic immutable records for repository/unit tests only. Normal activation
 * acceptance must create these through the authenticated owner producer. */
export function requestedFollowupFixture(accountId = 'a1', accountVersion = 1, replyText?: string) {
  const hash = accountFingerprint('fictional-call'), commandId = '33333333-3333-4333-8333-333333333333';
  const handoff = manualHandoffSchema.parse({ handoffId: 'h1', actionId: 'call1', channel: 'call', routeId: 'phone1', routeVersion: 1,
    targetHash: hash, contentHash: hash, contextRevision: hash, expiresAt: '2026-09-08T12:05:00.000Z', campaign: { campaignId: 'campaign1', campaignRevision: 1, enrollmentId: 'enroll1', enrollmentRevision: 1, stepId: 'call-step' } });
  const command = ownerCommandSchema.parse({ commandId, workspaceId: 'ws', accountId, expectedAuthorityGeneration: 0, expectedVersion: 1, kind: 'complete-manual',
    payload: { handoffId: handoff.handoffId, targetHash: handoff.targetHash, outcome: { actionId: handoff.actionId, channel: 'call', outcome: 'connected', observedAt: REQUESTED_NOW, evidenceRef: 'owner-call-note', ...(replyText === undefined ? {} : { replyText }) } } });
  if (command.kind !== 'complete-manual') throw new Error('fixture command');
  const receipt = { commandId, status: 'applied' as const, authorityGeneration: 0, aggregateVersion: 2, reason: null as null };
  const version = campaignVersionSchema.parse({ id: 'version1', campaignId: 'campaign1', version: 1, audienceHash: hash, offer: 'Fictional information', objective: 'meeting', cohortAccountIds: [accountId], approvedAt: null, steps: [{ id: 'call-step', channel: 'call', condition: 'initial', delayHours: 0 }], capScope: 'campaign_version_lifetime', channelCaps: { call: 2, email: 0, linkedin: 0 }, contentPolicyHash: hash });
  const enrollment = enrollmentSchema.parse({ id: 'enroll1', accountId, selectedRouteId: 'phone1', selectedRouteVersion: 1, personId: null, campaignVersionId: version.id, currentStepId: null, version: 2, state: 'completed', executionContextId: hash, contextRevision: 1, startedAt: REQUESTED_NOW });
  const evidence = stepEvidenceSchema.parse({ enrollmentId: 'enroll1', accountId, campaignVersionId: version.id, stepId: 'call-step', routeId: 'phone1', routeVersion: 1, outcome: 'connected', observedAt: REQUESTED_NOW, observation: 'unknown', source: 'human', executionContextId: hash, contextRevision: 1, state: 'human_reported_sent', actionId: 'call1', channel: 'call' });
  const reservation = campaignReservationSchema.parse({ input: { workspaceId: 'ws', accountId, ...handoff.campaign, actionId: 'call1', channel: 'call', authorityGeneration: 0, selectedRouteId: 'phone1', contextRevision: hash, contentHash: hash, targetHash: hash }, campaignVersionId: version.id, routeVersion: 1, numericContextRevision: 1, state: 'sent' });
  const event = workerEventSchema.parse({ id: 'outcome1', workspaceId: 'ws', accountId, authorityGeneration: 0, aggregateVersion: 2, kind: 'manual.outcome', payload: command.payload.outcome, receipt, campaign: { commandId, version: null, enrollment, evidence } });
  const handoffEvent = workerEventSchema.parse({ id: 'handoff1', workspaceId: 'ws', accountId, authorityGeneration: 0, aggregateVersion: 1, kind: 'manual.handoff', payload: handoff,
    receipt: { ...receipt, commandId: '22222222-2222-4222-8222-222222222222', aggregateVersion: 1 } });
  const ref = originalCallRefSchema.parse({ commandId, handoffId: handoff.handoffId, actionId: handoff.actionId, commandFingerprint: accountFingerprint(command), outcomeEventId: event.id, outcomeEventHash: accountFingerprint(event) });
  const account = { id: accountId, name: 'Fictional PM', domain: null as null, version: accountVersion };
  const record = accountRecordSchema.parse({ account, history: [{ at: REQUESTED_NOW, account, claims: [], routes: [] }], sources: [], claims: [], routes: [], researchRevision: 1 });
  const source = ownerSourceConfigurationSchema.parse({ version: 1, workspaceId: 'ws', accountId, pairingId: '11111111-1111-4111-8111-111111111111', revision: 1, state: 'paused', mailboxSubject: 'sub1', calendarId: null, research: null });
  let draft = requestedFollowupDraftSchema.parse({ kind: 'requested_phone_followup', id: 'requested1', accountId, revision: 1, mailboxSubject: 'sub1', sender: 'founder@fixture.invalid', recipient: 'pm@fixture.invalid',
    recipientBinding: { kind: 'owner_supplied', email: 'pm@fixture.invalid', originalCall: ref }, accountVersion, researchRevision: 1, contextRevision: hash, originalCall: ref,
    mailContext: { scopeRevision: null, scopeFingerprint: null, inboundContextRevision: null, inboundContextFingerprint: accountFingerprint([]) }, subject: 'Requested information', body: 'Thank you for speaking with me.', evidenceIds: [`call:${event.id}`], generation: 'edited', updatedAt: REQUESTED_NOW });
  draft = { ...draft, contextRevision: requestedFollowupContextRevision(draft) };
  return { version, enrollment, evidence, reservation, handoff, handoffEvent, command, receipt, event, ref, record, source, draft };
}
