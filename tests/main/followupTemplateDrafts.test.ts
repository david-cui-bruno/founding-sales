import { describe, expect, it } from 'vitest';
import { FOLLOWUP_TEMPLATE_OUTCOMES, chooseFollowupTemplate } from '../../src/main/outreach/templates/followupTemplateChoice';
import { REPLY_TEMPLATE_SEEDS, seededReplyTemplateHash, seededReplyTemplates } from '../../src/main/outreach/templates/replyTemplateSeeds';
import { createRequestedFollowupService, requestedFollowupContextRevision, validateRequestedOriginalCall, REQUESTED_CONNECTED_ONLY,
  type RequestedFollowupStore } from '../../src/main/outreach/requestedFollowupService';
import { approveRequestedFollowupSchema, type RequestedFollowupDraft } from '../../src/shared/contracts/requestedFollowupContract';
import type { ReplyTemplateId } from '../../src/shared/contracts/replyTemplateContract';
import { REQUESTED_NOW, requestedFollowupFixture } from '../fixtures/requestedFollowup';

const FIRM: { name: string; city: string | null; businessEmail: string | null } = { name: 'Lenox Property Group', city: 'Atlanta', businessEmail: 'office@lenox.example' };
const NO_EMAIL = { ...FIRM, businessEmail: null as string | null };
const templates = seededReplyTemplates(REQUESTED_NOW);
const seed = (id: ReplyTemplateId) => templates.find(template => template.id === id)!;

describe('which template a follow-up after a call uses', () => {
  it('covers every applied outcome except the ones the firm has already answered', () => {
    expect(FOLLOWUP_TEMPLATE_OUTCOMES).toEqual(['connected', 'no_answer', 'voicemail', 'busy', 'interested', 'gatekeeper']);
    for (const outcome of ['not_interested', 'wrong_number', 'opt_out', 'cancelled', 'not_called', 'unknown']) {
      expect(chooseFollowupTemplate({ outcome, note: 'Anything', callbackDate: null, firm: FIRM })).toEqual({ hold: 'outcome_needs_no_followup' });
    }
  });

  it('drafts T2 after every unreached outcome, with the firm and its city', () => {
    for (const outcome of ['voicemail', 'no_answer', 'busy', 'gatekeeper']) {
      expect(chooseFollowupTemplate({ outcome, note: null, callbackDate: null, firm: FIRM }))
        .toEqual({ templateId: 'T2', values: { firm: 'Lenox Property Group', city: 'Atlanta' } });
    }
    // A firm whose city is unknown gets no city value, and T2 does not name one.
    expect(chooseFollowupTemplate({ outcome: 'voicemail', note: null, callbackDate: null, firm: { ...FIRM, city: null } }))
      .toEqual({ templateId: 'T2', values: { firm: 'Lenox Property Group' } });
    expect(seed('T2').variables).toEqual(['firm']);
  });

  it('drafts T1 after interested only once the note is filled, and T3 when a callback was promised', () => {
    expect(chooseFollowupTemplate({ outcome: 'interested', note: null, callbackDate: null, firm: FIRM }))
      .toEqual({ hold: 'template_variable_missing', missing: ['next_step'] });
    expect(chooseFollowupTemplate({ outcome: 'interested', note: '   ', callbackDate: null, firm: FIRM }))
      .toEqual({ hold: 'template_variable_missing', missing: ['next_step'] });
    expect(chooseFollowupTemplate({ outcome: 'interested', note: 'Send the walkthrough link', callbackDate: null, firm: FIRM }))
      .toEqual({ templateId: 'T1', values: { firm: 'Lenox Property Group', city: 'Atlanta', next_step: 'Send the walkthrough link' } });
    expect(chooseFollowupTemplate({ outcome: 'connected', note: 'Not now', callbackDate: '2026-10-05', firm: FIRM }))
      .toEqual({ templateId: 'T3', values: { firm: 'Lenox Property Group', city: 'Atlanta', callback_date: '2026-10-05' } });
    expect(chooseFollowupTemplate({ outcome: 'connected', note: 'Not now', callbackDate: null, firm: FIRM }))
      .toEqual({ templateId: 'T2', values: { firm: 'Lenox Property Group', city: 'Atlanta' } });
  });

  it('holds with no_business_email rather than inventing an address, whatever the outcome', () => {
    for (const outcome of FOLLOWUP_TEMPLATE_OUTCOMES) {
      expect(chooseFollowupTemplate({ outcome, note: 'Send the walkthrough link', callbackDate: '2026-10-05', firm: NO_EMAIL }))
        .toEqual({ hold: 'no_business_email' });
    }
  });
});

describe('a template-mode draft through the real preparation service', () => {
  function service(outcome: 'connected' | 'voicemail' | 'interested' = 'voicemail') {
    const f = requestedFollowupFixture('a1', 1, 'Send the walkthrough link', outcome);
    const saved: RequestedFollowupDraft[] = [];
    const mailbox = { subject: 'sub1', sender: 'callie@usecallie.com' };
    const context = { account: f.record, originalCall: { command: f.command, event: f.event, handoff: f.handoff },
      mailbox, mailContext: f.draft.mailContext } as unknown as Awaited<ReturnType<RequestedFollowupStore['readContext']>>;
    const store: RequestedFollowupStore = {
      template: templateId => seed(templateId),
      readContext: () => context,
      get: (_accountId, draftId) => { const draft = saved.find(entry => entry.id === draftId); return draft ? { draft, stale: false, approval: null } : null; },
      save: draft => { saved.push(draft); return draft; },
    };
    return { f, saved, service: createRequestedFollowupService({ store, clock: { now: () => REQUESTED_NOW }, id: () => 'draft-one' }) };
  }
  const request = (f: ReturnType<typeof requestedFollowupFixture>, templateId: ReplyTemplateId, values: Record<string, string>) =>
    ({ accountId: 'a1', originalCall: f.ref, recipientBinding: { kind: 'owner_supplied' as const, email: 'office@lenox.example', originalCall: f.ref },
      expectedAccountVersion: 1, mode: 'template' as const, template: { templateId, values } });

  it('renders the stored template text after a voicemail and pins the template it used', async () => {
    const { f, service: prepared, saved } = service('voicemail');
    const result = await prepared.prepareRequestedFollowup(request(f, 'T2', { firm: 'Lenox Property Group' }), new AbortController().signal);
    expect(saved).toHaveLength(1);
    expect(result.draft.generation).toBe('template');
    expect(result.draft.subject).toBe('Tried to reach you, Lenox Property Group');
    expect(result.draft.body).toBe(seed('T2').body.replace(/\{firm\}/g, 'Lenox Property Group'));
    expect(result.draft.body).not.toContain('{');
    expect(result.draft.template).toEqual({ templateId: 'T2', revision: 1, contentHash: seededReplyTemplateHash('T2'),
      purpose: 'missed_you', values: { firm: 'Lenox Property Group' } });
    expect(result.draft.evidenceIds).toEqual([]);
    expect(result.draft.contextRevision).toBe(requestedFollowupContextRevision(result.draft));
  });

  it('refuses to draft with a variable the values do not carry', async () => {
    const { f, service: prepared, saved } = service('interested');
    await expect(prepared.prepareRequestedFollowup(request(f, 'T1', { firm: 'Lenox Property Group' }), new AbortController().signal))
      .rejects.toThrow('template_variable_missing');
    expect(saved).toEqual([]);
  });

  it('is approved for what the template is for, never for a request the recipient did not make', async () => {
    const { f, service: prepared } = service('voicemail');
    const result = await prepared.prepareRequestedFollowup(request(f, 'T2', { firm: 'Lenox Property Group' }), new AbortController().signal);
    const approval = { draft: result.draft, expectedRemoteDraftRevision: null as number | null, approvalId: 'approval-one', actionId: 'action-one',
      intentCommandId: '44444444-4444-4444-8444-444444444444', expiresAt: '2026-09-08T12:10:00.000Z' };
    expect(approveRequestedFollowupSchema.safeParse({ ...approval, request: { statement: 'missed_you', recipient: result.draft.recipient } }).success).toBe(true);
    expect(approveRequestedFollowupSchema.safeParse({ ...approval, request: { statement: 'recipient_requested_information_by_email', recipient: result.draft.recipient } }).success).toBe(false);
    expect(approveRequestedFollowupSchema.safeParse({ ...approval, request: { statement: 'after_conversation', recipient: result.draft.recipient } }).success).toBe(false);
    // A manual draft keeps the statement it always had, and may not borrow a template purpose.
    const manual = { ...approval, draft: requestedFollowupFixture().draft };
    expect(approveRequestedFollowupSchema.safeParse({ ...manual, request: { statement: 'recipient_requested_information_by_email', recipient: manual.draft.recipient } }).success).toBe(true);
    expect(approveRequestedFollowupSchema.safeParse({ ...manual, request: { statement: 'missed_you', recipient: manual.draft.recipient } }).success).toBe(false);
  });

  it('accepts a voicemail origin only for the template outcome set, never for the connected-only path', () => {
    const f = requestedFollowupFixture('a1', 1, undefined, 'voicemail');
    const evidence = { workspaceId: 'ws', accountId: 'a1', reference: f.ref, command: f.command, commandFingerprint: f.ref.commandFingerprint,
      event: f.event, handoff: f.handoff, handoffAccountId: 'a1', handoffGeneration: 0 };
    expect(() => validateRequestedOriginalCall({ ...evidence, allowedOutcomes: FOLLOWUP_TEMPLATE_OUTCOMES })).not.toThrow();
    expect(() => validateRequestedOriginalCall({ ...evidence, allowedOutcomes: REQUESTED_CONNECTED_ONLY })).toThrow('requested_call_evidence_invalid');
    expect(() => validateRequestedOriginalCall(evidence)).toThrow('requested_call_evidence_invalid');
    // The connected path is unchanged: with no explicit set, a connected origin is still accepted.
    const connected = requestedFollowupFixture();
    expect(() => validateRequestedOriginalCall({ workspaceId: 'ws', accountId: 'a1', reference: connected.ref, command: connected.command,
      commandFingerprint: connected.ref.commandFingerprint, event: connected.event, handoff: connected.handoff, handoffAccountId: 'a1', handoffGeneration: 0 })).not.toThrow();
  });

  it('never claims a template says something the seeds do not say', () => {
    for (const template of REPLY_TEMPLATE_SEEDS) expect(seed(template.id).body).toBe(template.body);
  });
});
