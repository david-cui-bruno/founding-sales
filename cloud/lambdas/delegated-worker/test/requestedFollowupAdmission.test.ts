import { expect, it } from 'vitest';
import { requestedCallFixture , requestedCapturedFixture, materializeRequested } from './requestedFollowupFixture';
it('actual call fixture has completed connected evidence and no fabricated inbound thread', async () => {
  const f = await requestedCallFixture();
  expect(await f.store.list('MAIL_THREAD#')).toHaveLength(0);
  expect((await f.execution.eventsAfter(null)).events.at(-1)).toMatchObject({ kind: 'manual.outcome', payload: { channel: 'call', outcome: 'connected' } });
  expect(await f.execution.readDispatch('acct', 'requested-email')).toBeNull();
});

import { dispatchIntentSchema } from '../src/dispatchRepository';
import { fingerprint } from '../src/dynamoStore';
it('first-email intent is a distinct strict threadless variant, never an optional-thread reply', async () => {
  const f = await requestedCallFixture(); const commandId = '11111111-1111-4111-8111-111111111111';
  const frozenMessage = { commandId, from: 'sender@example.invalid', to: 'recipient@example.invalid', subject: 'Requested information', body: 'Owner reviewed details.' };
  const intent = { kind: 'phone_requested_followup', commandId, requestedApprovalCommandId: '22222222-2222-4222-8222-222222222222', draftId: 'requested-draft', draftRevision: 1, pairingId: f.pairing.pairingId, mailboxSubject: 'mailbox', frozenMessage,
    action: { actionId: 'requested-email', workspaceId: 'ws', accountId: 'acct', expectedAuthorityGeneration: 1, approvalId: 'requested-approval', contentHash: fingerprint(frozenMessage), targetHash: fingerprint({ sender: frozenMessage.from, recipient: frozenMessage.to }) } };
  expect(dispatchIntentSchema.safeParse(intent).success).toBe(true);
  expect(dispatchIntentSchema.safeParse({ ...intent, frozenMessage: { ...frozenMessage, threadId: 'invented' } }).success).toBe(false);
  expect(dispatchIntentSchema.safeParse({ ...intent, kind: 'standalone_reply' }).success).toBe(false);
  expect(await f.execution.readDispatch('acct', 'requested-email')).toBeNull();
});

import { createRequestedApprovalRecord, requestedApprovalRecordSchema } from '../src/requestedFollowupApproval';
import type { RequestedFollowupDraft } from '../../../../src/shared/contracts/requestedFollowupContract';
it('capture is an exact non-executable attestation snapshot, connected alone is insufficient', async () => {
  const f = await requestedCallFixture();
  const mailContext = { scopeRevision: null as null, scopeFingerprint: null as null, inboundContextRevision: null as null, inboundContextFingerprint: fingerprint([]) };
  const context = { accountVersion: 1, researchRevision: 1, recipientBinding: { kind: 'account_route' as const, routeId: 'email', routeVersion: 1, email: 'recipient@example.invalid' }, originalCall: f.originalCall, mailContext };
  const draft: RequestedFollowupDraft = { ...context, kind: 'requested_phone_followup', id: 'requested-draft', accountId: 'acct', revision: 1, mailboxSubject: 'mailbox', sender: 'sender@example.invalid', recipient: 'recipient@example.invalid', contextRevision: fingerprint(context), subject: 'Requested information', body: 'Owner reviewed details.', evidenceIds: [f.originalCall.outcomeEventId], generation: 'edited', updatedAt: f.options.clock.now() };
  const command = { commandId: '22222222-2222-4222-8222-222222222222', workspaceId: 'ws', accountId: 'acct', expectedAuthorityGeneration: 1, expectedVersion: await f.execution.currentVersion('acct'), kind: 'approve-requested-followup', payload: { draft, expectedRemoteDraftRevision: null as null, approvalId: 'requested-approval', actionId: 'requested-email', intentCommandId: '11111111-1111-4111-8111-111111111111', request: { statement: 'recipient_requested_information_by_email', recipient: draft.recipient }, expiresAt: '2026-09-10T00:00:00.000Z' } };
  const principal = await f.auth.authenticate(`Bearer ${f.pairing.credential}`, ['commands:write']);
  const record = createRequestedApprovalRecord(command, principal, f.options.clock.now());
  expect(record).toMatchObject({ state: 'pending_preflight', materializedIntentId: null, draftSnapshot: draft, requestSnapshot: { attestationCommandId: command.commandId, recipient: draft.recipient } });
  expect(requestedApprovalRecordSchema.safeParse(record).success).toBe(true);
  expect(() => createRequestedApprovalRecord({ ...command, payload: { ...command.payload, request: undefined } }, principal, f.options.clock.now())).toThrow();
  expect(() => createRequestedApprovalRecord({ ...command, payload: { ...command.payload, request: { ...command.payload.request, recipient: 'other@example.invalid' } } }, principal, f.options.clock.now())).toThrow();
  expect(await f.execution.readDispatch('acct', 'requested-email')).toBeNull();
});

it('actual capture remains non-executable until one joined materialization preserves standalone call provenance', async () => {
  const f = await requestedCapturedFixture();
  expect(await f.execution.readDispatch('acct', 'requested-email')).toBeNull();
  expect(await f.store.list('DISPATCH_PERMISSION#')).toHaveLength(0);
  const intent = await materializeRequested(f);
  expect(await f.execution.readDispatch('acct', 'requested-email')).toMatchObject({ state: 'prepared', reservation: null });
  expect(await f.policy.loadRequestedMaterializedIntent(f.command.commandId)).toEqual(intent);
  expect(f.dynamo.inspect('CAMPAIGN_ENROLLMENT#call-enrollment')).toMatchObject({ state: 'conversation' });
  expect(f.dynamo.inspect('CAMPAIGN_CAP#call-version#email')).toEqual({ reserved: 0, sent: 0 });
  expect(await f.store.list('MAIL_THREAD#')).toHaveLength(0);
  await expect(f.policy.planRequestedAdmission(f.command.commandId)).rejects.toThrow('requested_already_materialized');
});
it.each(['expiry', 'paused', 'revoked', 'draft', 'suppression', 'conflict', 'new-inbound'] as const)('captured submission never materializes after %s', async variant => {
  const f = await requestedCapturedFixture();
  if (variant === 'expiry') f.advance('2026-09-11T00:00:00.000Z');
  if (variant === 'paused' || variant === 'revoked') await f.execution.applyCommand({ commandId: `change-${variant}`, workspaceId: 'ws', accountId: 'acct', expectedAuthorityGeneration: 1, expectedVersion: await f.execution.currentVersion('acct'), kind: variant === 'paused' ? 'pause' : 'revoke', payload: { reason: 'owner decision' } });
  if (variant === 'draft') { const key = 'MAIL_REQUESTED_DRAFT#acct#requested-draft'; const row = (await f.store.get<Record<string, unknown>>(key))!; await f.store.transact([f.store.put(key, { ...row.data, body: 'Changed content' }, row.rev)]); }
  if (variant === 'suppression' || variant === 'conflict') await f.store.transact([f.store.put(variant === 'suppression' ? 'MAIL_SUPPRESSION#acct' : 'DISPATCH_CONFLICT#acct', { accountId: 'acct' }, null)]);
  if (variant === 'new-inbound') { const checkpoint = (await f.threads.checkpoint('acct', 'mailbox'))!; await f.threads.beginPoll('acct', 'mailbox', 'new-inbound'); await f.threads.applyPage({ complete: true, nextCursor: { ...checkpoint, historyId: '2' }, threads: [{ accountId: 'acct', mailboxSubject: 'mailbox', provider: 'gmail', providerThreadId: 'new-thread', messages: [{ id: 'new-message', threadId: 'new-thread', rfcMessageId: '<new@example.invalid>', references: [], from: ['recipient@example.invalid'], to: ['sender@example.invalid'], cc: [], date: f.options.clock.now(), subject: 'New facts', bodyParts: [{ mimeType: 'text/plain', text: 'Please consider this update', truncated: false }] }] }] }, checkpoint, 'new-inbound'); }
  await expect(f.policy.planRequestedAdmission(f.command.commandId)).rejects.toThrow();
  expect(await f.execution.readDispatch('acct', 'requested-email')).toBeNull(); expect(await f.store.list('DISPATCH_PERMISSION#')).toHaveLength(0);
});
