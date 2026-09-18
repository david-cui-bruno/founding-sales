import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { dispatchFixture } from './dispatchFixture';
import { dispatchIntentKey, templateSequencePermissionKey, type TemplateSequenceEmailIntent, type TemplateSequencePermission } from '../src/dispatchRepository';
import { replyTemplateStateKey } from '../src/territoryPolicyRepository';
import { fingerprint } from '../src/dynamoStore';
import { mailSuppressionKey } from '../src/threadIntakeRepository';
import { replyTemplateContentHash, type WorkerReplyTemplateState } from '../../../../src/shared/contracts/replyTemplateContract';
import type { Account, AccountClaim, AccountSource } from '../../../../src/shared/contracts/accountContract';

const NOW = '2026-09-09T00:04:00.000Z';
const EXCERPT = 'Alpha Residential Management. Write to recipient@example.invalid for anything about your building.';
const SUBJECT = 'A short note about maintenance calls';
const BODY = 'Callie answers maintenance calls for property managers.\n\nBest,\nDavid';
const APPROVED_HASH = replyTemplateContentHash({ id: 'T4', revision: 1, subject: SUBJECT, body: BODY });

/**
 * The cold first email of a territory sequence step, on the real worker dispatch seam: the real repository, the real
 * execution repository, the real intake barrier and the real sender cap, with an injected HTTP boundary. No real
 * network and no AWS. Nothing in this file installs, deploys or grants anything.
 */
async function templateFixture(options: { approved?: boolean; paused?: boolean; approvalRevision?: number; approvalHash?: string; claimEmail?: string } = {}) {
  const f = await dispatchFixture();
  const recipient = f.draft.recipient;
  const source: AccountSource = { id: 'source-alpha-home', url: 'https://alpha-pm.example/', fetchedAt: '2026-09-08T00:00:00.000Z',
    sha256: createHash('sha256').update(EXCERPT).digest('hex'), excerpt: EXCERPT, permitted: true };
  const claim: AccountClaim = { key: 'business_email', kind: 'fact', value: options.claimEmail ?? recipient,
    selection: 'sole_on_domain_address', evidenceIds: [source.id] };
  const account: Account = { id: 'acct', name: 'Fictional PM', domain: 'alpha-pm.example', version: 1 };
  const record = { account, routes: [], sources: [source], claims: [claim], researchRevision: 1,
    history: [{ at: NOW, account, claims: [claim], routes: [] }] };
  await f.store.transact([f.store.put('ACCOUNT#acct', record, 1)]);
  const state: WorkerReplyTemplateState = { paused: options.paused ?? false, updatedAt: NOW,
    approvals: options.approved === false ? [] : [{ templateId: 'T4', revision: options.approvalRevision ?? 1,
      subject: SUBJECT, body: BODY, contentHash: options.approvalHash ?? APPROVED_HASH, approvedAt: NOW,
      commandId: '22222222-2222-4222-8222-222222222222' }] };
  if (options.approvalHash || options.approvalRevision) {
    // A hash that does not match its own text can never be a stored approval; write the row directly for that case.
    await f.store.transact([f.store.put(replyTemplateStateKey('ws'), { ...state, approvals: state.approvals.map(approval => ({
      ...approval, revision: options.approvalRevision ?? 1, contentHash: options.approvalHash ?? APPROVED_HASH })) }, null)]);
  } else {
    await f.store.transact([f.store.put(replyTemplateStateKey('ws'), state, null)]);
  }
  const permission: TemplateSequencePermission = { basis: 'listed_business_email', id: 'template-permission', accountId: 'acct',
    recipient, sender: f.draft.sender, mailboxSubject: 'mailbox', accountVersion: 1, claimIndex: 0,
    claimFingerprint: fingerprint(claim), sourceId: source.id, sourceSha256: source.sha256,
    recordedAt: NOW, expiresAt: '2026-09-10T00:00:00.000Z' };
  const commandId = '44444444-4444-4444-8444-444444444444';
  const frozenMessage = { commandId, from: f.draft.sender, to: recipient, subject: SUBJECT, body: BODY };
  const intent: TemplateSequenceEmailIntent = { kind: 'template_sequence_email', commandId, pairingId: f.intent.pairingId,
    mailboxSubject: 'mailbox', draftId: 'template-draft', draftRevision: 1, frozenMessage,
    binding: { kind: 'account_claim', claimIndex: 0, accountVersion: 1, email: recipient },
    stepId: 'sequence-day-7', campaignVersionId: 'campaign-version', enrollmentId: 'enrollment',
    template: { templateId: 'T4', revision: 1, contentHash: APPROVED_HASH, purpose: 'short_value_note' },
    action: { workspaceId: 'ws', accountId: 'acct', actionId: 'template-action', expectedAuthorityGeneration: 1,
      approvalId: permission.id, contentHash: fingerprint(frozenMessage),
      targetHash: fingerprint({ sender: f.draft.sender, recipient }) } };
  return { ...f, claim, source, permission, intent, recipient,
    admit: async () => { await f.policy.admitTemplateSequencePermission(permission); await f.policy.admitIntent(intent); await f.execution.prepareAction({ ...intent.action, expectedVersion: 2 }); },
    reserve: () => f.policy.reservationPlan({ ...intent.action, expectedVersion: 2 }, f.access.accessEvidence) };
}

describe('the cold first email of a territory sequence step', () => {
  it('admits the intent with no thread, reserves once against the approved template and the cited claim, and sends once', async () => {
    const t = await templateFixture(); await t.admit();
    const plan = await t.reserve();
    const keys = plan.finalize().map(item => item.ConditionCheck?.Key?.sk?.S ?? item.Put?.Item?.sk?.S);
    // The claim, the standing approval and the recorded permission are all fenced in the same reservation, and the
    // sender cap and its ramp anchor are consumed there too. No thread key is required or read.
    expect(keys).toContain('ACCOUNT#acct');
    expect(keys).toContain(replyTemplateStateKey('ws'));
    expect(keys).toContain(templateSequencePermissionKey('acct', 'template-permission'));
    expect(keys).toContain(dispatchIntentKey(t.intent.commandId));
    expect(keys).toContain('DISPATCH_CAP#sender%40example.invalid#2026-09-09');
    expect(keys.some(key => key?.startsWith('MAIL_THREAD#'))).toBe(false);
    expect(new Set(keys).size).toBe(keys.length);

    const sent = await t.service().dispatch(t.intent.commandId);
    expect(sent).toMatchObject({ status: 'provider_accepted', providerIdentity: { messageId: 'sent1' } });
    // One send per step: the same command id never sends again, and the action index admits one intent per action.
    await t.service().dispatch(t.intent.commandId);
    expect(t.sends()).toBe(1);
    const evidence = await t.policy.sendEvidence(t.intent.commandId);
    expect(evidence.map(item => item.state)).toEqual(['provider_accepted']);
  });

  it('holds with template_not_approved when the approval is absent, paused, a different revision or a different hash', async () => {
    for (const options of [{ approved: false }, { paused: true }, { approvalRevision: 2 }, { approvalHash: 'b'.repeat(64) }]) {
      const t = await templateFixture(options); await t.admit();
      await expect(t.reserve()).rejects.toThrow('template_not_approved');
      expect((await t.service().dispatch(t.intent.commandId))).toEqual({ status: 'held', reason: 'template_not_approved' });
      expect(t.sends()).toBe(0);
    }
  });

  it('holds with no_business_email when the claim no longer names the recipient', async () => {
    const t = await templateFixture(); await t.admit();
    const record = t.dynamo.inspect('ACCOUNT#acct') as { account: Account; claims: AccountClaim[] };
    await t.store.transact([t.store.put('ACCOUNT#acct', { ...record,
      claims: [{ ...t.claim, value: 'someone.else@alpha-pm.example' }] }, 2)]);
    await expect(t.reserve()).rejects.toThrow('no_business_email');
    expect((await t.service().dispatch(t.intent.commandId))).toEqual({ status: 'held', reason: 'no_business_email' });
    expect(t.sends()).toBe(0);
  });

  it('refuses a permission whose claim, source or sha the account record does not actually carry', async () => {
    const t = await templateFixture();
    await expect(t.policy.admitTemplateSequencePermission({ ...t.permission, recipient: 'invented@alpha-pm.example' })).rejects.toThrow('no_business_email');
    await expect(t.policy.admitTemplateSequencePermission({ ...t.permission, claimIndex: 1 })).rejects.toThrow('no_business_email');
    await expect(t.policy.admitTemplateSequencePermission({ ...t.permission, sourceSha256: 'c'.repeat(64) })).rejects.toThrow('no_business_email');
    await expect(t.policy.admitTemplateSequencePermission({ ...t.permission, claimFingerprint: 'd'.repeat(64) })).rejects.toThrow('no_business_email');
    await expect(t.policy.admitTemplateSequencePermission({ ...t.permission, accountVersion: 2 })).rejects.toThrow('no_business_email');
    // A source whose stored excerpt no longer hashes to its recorded sha256 is not evidence of anything.
    const record = t.dynamo.inspect('ACCOUNT#acct') as { sources: AccountSource[] };
    await t.store.transact([t.store.put('ACCOUNT#acct', { ...record, sources: [{ ...t.source, excerpt: 'rewritten' }] }, 2)]);
    await expect(t.policy.admitTemplateSequencePermission(t.permission)).rejects.toThrow('no_business_email');
  });

  it('holds on a revoked permission, an opted-out firm and a reached sender cap, and never sends on any of them', async () => {
    const revoked = await templateFixture(); await revoked.admit();
    await revoked.policy.revokeTemplateSequencePermission('acct', 'template-permission');
    await expect(revoked.reserve()).rejects.toThrow('dispatch_suppressed');
    expect((await revoked.service().dispatch(revoked.intent.commandId)).reason).toBe('dispatch_suppressed');
    expect(revoked.sends()).toBe(0);

    const suppressed = await templateFixture(); await suppressed.admit();
    await suppressed.store.transact([suppressed.store.put(mailSuppressionKey('acct'), { reason: 'opt_out' }, null)]);
    await expect(suppressed.reserve()).rejects.toThrow();
    expect(suppressed.sends()).toBe(0);

    const capped = await templateFixture(); await capped.admit();
    await capped.policy.configureCaps({ sender: capped.draft.sender, dailyLimit: 0 }, 1);
    await expect(capped.reserve()).rejects.toThrow('dispatch_cap_reached');
    expect((await capped.service().dispatch(capped.intent.commandId))).toEqual({ status: 'held', reason: 'dispatch_cap_reached' });
    expect(capped.sends()).toBe(0);
  });

  it('refuses an intent whose frozen message is not the one its action hashes, or whose recipient is not the bound claim', async () => {
    const t = await templateFixture();
    await expect(t.policy.admitIntent({ ...t.intent, frozenMessage: { ...t.intent.frozenMessage, body: 'Unapproved edit' } })).rejects.toThrow('dispatch_identity_conflict');
    await expect(t.policy.admitIntent({ ...t.intent, action: { ...t.intent.action, targetHash: 'e'.repeat(64) } })).rejects.toThrow('dispatch_identity_conflict');
    // The recipient of the frozen message must be the address the binding names, not merely a valid address.
    const mismatched = { ...t.intent, frozenMessage: { ...t.intent.frozenMessage, to: 'other@alpha-pm.example' } };
    const rebound = { ...mismatched, action: { ...t.intent.action, contentHash: fingerprint(mismatched.frozenMessage),
      targetHash: fingerprint({ sender: t.draft.sender, recipient: 'other@alpha-pm.example' }) } };
    await t.policy.admitTemplateSequencePermission(t.permission);
    await t.policy.admitIntent(rebound);
    await t.execution.prepareAction({ ...rebound.action, expectedVersion: 2 });
    await expect(t.policy.reservationPlan({ ...rebound.action, expectedVersion: 2 }, t.access.accessEvidence)).rejects.toThrow('no_business_email');
  });
});
