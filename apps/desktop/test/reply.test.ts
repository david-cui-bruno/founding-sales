import { describe, expect, it } from 'vitest';
import { replyCardSchema, replyStateSchema, type ReplyCard, type ReplyState } from '../src/renderer/replyContract.ts';
import { buildReplyCardView, buildReplyView, candidateLabel, replyNotice } from '../src/renderer/replyView.ts';
import { REPLY_IPC_CHANNELS, createReplyBridge } from '../src/main/replyBridge.ts';
import { createAuthedClient } from '../src/main/authedClient.ts';
import type { HttpAnswer } from '../src/main/apiClient.ts';
import { classifierSettingsAnswer, confirmReplyResultAnswer, replyConfirmationAnswer } from './support/replyAnswers.ts';

/**
 * The reply card window and the bridge behind it (specification 8.3, 12.4, 14.2).
 *
 * The **view model** is pure, so the authority boundary — "the model may label; a
 * person decides" — is an assertion rather than a screenshot. Three of the tests
 * below exist only to make a future convenience impossible to add quietly: a
 * confident suggestion is still not a selection, a redacted card offers no answer,
 * and nothing anywhere closes an opportunity.
 *
 * The **bridge** is given a scripted API and a scripted session, so what is proved is
 * the wiring: the window is never handed a token, a wall-clock callback is resolved
 * against the business zone before it leaves the Mac, and a card that would have gone
 * out with the model's proposed callback instead of the person's answer is refused
 * here rather than committed.
 *
 * No real person, firm or address appears; `example.test` is reserved by RFC 6761.
 */

const MESSAGE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_MESSAGE_ID = '22222222-2222-4222-8222-222222222222';
const FIRM_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_FIRM_ID = '44444444-4444-4444-8444-444444444444';
const OPPORTUNITY_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_OPPORTUNITY_ID = '66666666-6666-4666-8666-666666666666';
const USER_ID = '77777777-7777-4777-8777-777777777777';
const HOLD_ID = '88888888-8888-4888-8888-888888888888';

function card(overrides: Partial<ReplyCard> = {}): ReplyCard {
  return replyCardSchema.parse({
    messageId: MESSAGE_ID,
    receivedAt: '2026-09-21T13:00:00.000Z',
    from: 'reception@northwind.example.test',
    subject: 'Re: introduction',
    body: { text: 'Tuesday works. Send an invite.', truncated: false },
    firmId: FIRM_ID,
    firmName: 'Northwind Test Holdings',
    opportunityId: OPPORTUNITY_ID,
    contactId: null,
    contactName: 'Dana Example',
    contactTitle: 'Operations',
    impact: {
      controlMode: 'automated',
      holds: [
        {
          holdId: HOLD_ID,
          opportunityId: OPPORTUNITY_ID,
          reasonCode: 'uncertain_reply',
          blockedActionKinds: ['email_send'],
          recoveryAction: 'confirm_reply',
          recoverable: true,
          startedAt: '2026-09-21T13:00:05.000Z',
        },
      ],
      ambiguous: false,
      candidates: [{ opportunityId: OPPORTUNITY_ID, firmId: FIRM_ID, firmName: 'Northwind Test Holdings', selected: true }],
      contactsAtFirm: 3,
    },
    deterministicClass: 'uncertain',
    signals: [{ rule: 'question_mark', evidence: 'ends with a question', layer: 'deterministic' }],
    proposedDisposition: 'interested',
    proposedBy: 'model',
    confidence: 0.88,
    supportingExcerpt: 'Tuesday works.',
    callbackProposal: null,
    modelName: 'claude-opus-5',
    promptVersion: 'g7b.replies.1',
    requiresConfirmation: true,
    confirmation: null,
    nextAction: 'confirm_disposition',
    visibility: 'assigned_or_admin',
    ...overrides,
  });
}

function state(overrides: Partial<ReplyState> = {}): ReplyState {
  return replyStateSchema.parse({
    businessDate: '2026-09-21',
    businessTimeZone: 'America/New_York',
    cards: [card()],
    open: card(),
    online: true,
    mayMutate: true,
    classifier: { enabled: true, modelName: 'claude-opus-5', effort: 'low' },
    notice: null,
    ...overrides,
  });
}

describe('the reply card view model', () => {
  it('shows the suggestion and selects nothing: a confirmation is a person’s click', () => {
    const view = buildReplyCardView(state(), card(), null);
    expect(view.suggestion?.dispositionLabel).toBe('Interested');
    expect(view.suggestion?.source).toBe('model');
    expect(view.suggestion?.attribution).toBe('claude-opus-5, prompt g7b.replies.1');
    expect(view.choices.filter(choice => choice.selected)).toEqual([]);
    expect(view.choices.filter(choice => choice.suggested).map(choice => choice.disposition)).toEqual([
      'interested',
    ]);
    expect(view.confirmEnabled).toBe(false);
    expect(view.confirmLabel).toBe('Choose what this reply means');

    const chosen = buildReplyCardView(state(), card(), 'interested');
    expect(chosen.confirmEnabled).toBe(true);
    expect(chosen.confirmLabel).toBe('Confirm: Interested');
  });

  it('never treats confidence as permission', () => {
    // 12.4: the model layer may only ever suggest. A threshold in the window would be
    // the model deciding with a person's name on it, so the *only* difference a
    // confidence makes anywhere in the view is the sentence beside it.
    const sure = buildReplyCardView(state(), card({ confidence: 0.99 }), null);
    const unsure = buildReplyCardView(state(), card({ confidence: 0.12 }), null);
    expect(sure.confirmEnabled).toBe(false);
    expect(unsure.confirmEnabled).toBe(false);
    expect(sure.suggestion?.confidenceLabel).toBe('Confident (0.99)');
    expect(unsure.suggestion?.confidenceLabel).toBe('Unsure (0.12)');
    expect({ ...sure, suggestion: null }).toEqual({ ...unsure, suggestion: null });
  });

  it('offers no disposition that closes an opportunity, suppresses, or resumes automation', () => {
    const view = buildReplyCardView(state(), card(), 'not_interested');
    expect(view.choices.map(choice => choice.disposition)).toEqual([
      'interested',
      'referral_or_wrong_person',
      'follow_up_later',
      'not_interested',
      'opt_out',
      'other',
    ]);
    // The one disposition 9.1 associates with a loss says in words that Callie will
    // not act on it, because `confirmReplyDisposition` returns `suggestsLost` and
    // changes no stage.
    expect(view.choices.find(choice => choice.disposition === 'not_interested')?.consequence).toContain(
      'does not close anything',
    );
    // And a suppression is offered only where 9.1 puts it, behind the person's tick.
    expect(view.firmWideOptOutOffered).toBe(false);
    expect(buildReplyCardView(state(), card(), 'opt_out').firmWideOptOutOffered).toBe(true);
  });

  it('withholds the body and the excerpt from a member who may not read them, and offers no answer', () => {
    // Appendix F: a member who is neither the assignee nor an admin sees the envelope
    // and the impact. The excerpt is a quotation from the body and goes with it — a
    // card that redacted the body and printed a sentence of it is the same leak.
    const redacted = card({
      body: null,
      subject: null,
      contactName: null,
      supportingExcerpt: null,
      visibility: 'any_active_member',
    });
    const view = buildReplyCardView(state({ open: redacted }), redacted, 'interested');
    expect(view.bodyText).toBeNull();
    expect(view.subject).toBeNull();
    expect(view.suggestion?.excerpt).toBeNull();
    // No answer is offered at all, not a disabled one: a form they cannot fill in
    // beside a message they cannot read is an invitation to guess.
    expect(view.choices).toEqual([]);
    expect(view.confirmEnabled).toBe(false);
    expect(view.banners.map(banner => banner.text)).toContain(replyNotice('not_assigned'));
    // The impact is still there: that is the point of showing them anything.
    expect(view.impactLines.some(line => line.includes('uncertain_reply'))).toBe(true);
  });

  it('sends an unresolved ambiguity to G7’s command instead of offering a disposition', () => {
    const ambiguous = card({
      nextAction: 'resolve_ambiguity',
      impact: {
        controlMode: 'automated',
        holds: [],
        ambiguous: true,
        candidates: [
          { opportunityId: OPPORTUNITY_ID, firmId: FIRM_ID, firmName: 'Northwind Test Holdings', selected: null },
          { opportunityId: OTHER_OPPORTUNITY_ID, firmId: OTHER_FIRM_ID, firmName: 'Larkspur Test Foundry', selected: null },
        ],
        contactsAtFirm: 1,
      },
    });
    const view = buildReplyCardView(state({ open: ambiguous }), ambiguous, 'interested');
    expect(view.choices).toEqual([]);
    expect(view.confirmEnabled).toBe(false);
    expect(view.ambiguity).toHaveLength(2);
    expect(view.banners.some(banner => banner.tone === 'blocking')).toBe(true);
  });

  it('answers nothing for a bounce and nothing for a message already answered', () => {
    const bounce = buildReplyCardView(state(), card({ deterministicClass: 'bounce', nextAction: 'review_bounce' }), null);
    expect(bounce.choices).toEqual([]);
    expect(bounce.classLabel).toBe('Delivery failure');

    const answered = card({
      nextAction: 'nothing_to_do',
      requiresConfirmation: false,
      confirmation: {
        id: HOLD_ID,
        messageId: MESSAGE_ID,
        firmId: FIRM_ID,
        opportunityId: OPPORTUNITY_ID,
        disposition: 'not_interested',
        suggestedDisposition: 'interested',
        suggestedBy: 'model',
        corrected: true,
        confirmedByUserId: USER_ID,
        consequences: ['opportunity_manual', 'holds_released'],
        callbackId: null,
        note: null,
        createdAt: '2026-09-21T14:00:00.000Z',
      },
    });
    const view = buildReplyCardView(state({ open: answered }), answered, null);
    expect(view.choices).toEqual([]);
    expect(view.banners.some(banner => banner.text.includes('Callie had suggested something else'))).toBe(true);
  });

  it('fails closed when the client may not mutate, and offline is a banner rather than a disabled form (wave 1)', () => {
    const offline = buildReplyCardView(state({ online: false }), card(), 'interested');
    expect(offline.confirmEnabled).toBe(true);
    expect(offline.banners.some(banner => banner.text === replyNotice('offline'))).toBe(true);
    expect(buildReplyCardView(state({ mayMutate: false }), card(), 'interested').confirmEnabled).toBe(false);
    // Nothing is cached, so an outage is an empty lane rather than a stale card.
    const view = buildReplyView(state({ online: false, cards: [], open: null }), null);
    expect(view.emptyMessage).toBe('Callie cannot reach the server, and replies are never kept on this Mac.');
  });

  it('prefills the model’s reading of a time and still calls the field required', () => {
    const later = card({ callbackProposal: { localDateTime: '2026-09-28T09:00', timeZone: null } });
    const idle = buildReplyCardView(state({ open: later }), later, null);
    expect(idle.callbackOffered).toBe(false);
    const chosen = buildReplyCardView(state({ open: later }), later, 'follow_up_later');
    expect(chosen.callbackOffered).toBe(true);
    expect(chosen.callbackRequired).toBe(true);
    // The zone is the workspace's when the words did not name one.
    expect(chosen.callbackPrefill).toEqual({ localDateTime: '2026-09-28T09:00', timeZone: 'America/New_York' });
  });

  it('names the model the workspace pays for, and says when the reading is switched off', () => {
    expect(buildReplyView(state(), null).classifierLine).toBe(
      'Suggestions come from claude-opus-5 at low effort.',
    );
    const off = buildReplyView(state({ classifier: { enabled: false, modelName: 'claude-opus-5', effort: 'low' } }), null);
    expect(off.banners.some(banner => banner.text.includes('switched off'))).toBe(true);
  });

  it('summarises the lane without inventing an answer for anything', () => {
    const view = buildReplyView(state({ cards: [card(), card({ messageId: OTHER_MESSAGE_ID, proposedDisposition: null, proposedBy: 'none', confidence: null })] }), null);
    expect(view.summaries.map(summary => summary.line)).toEqual([
      'Northwind Test Holdings — Dana Example — Callie suggests: Interested',
      'Northwind Test Holdings — Dana Example — Needs an answer',
    ]);
    expect(view.summaries[0]?.open).toBe(true);
  });
});

/** A scripted API. Every call is recorded; every answer is chosen by the test. */
function scriptedApi(answers: Readonly<Record<string, HttpAnswer>>): {
  readonly api: ReturnType<typeof createAuthedClient>;
  readonly calls: { path: string; body: Record<string, unknown> | null; headers: Record<string, string> }[];
} {
  const calls: { path: string; body: Record<string, unknown> | null; headers: Record<string, string> }[] = [];
  const api = createAuthedClient({
    baseUrl: 'https://api.example.test/',
    clientVersion: '1.4.0',
    accessToken: async () => await Promise.resolve('token-value'),
    send: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push({
        path,
        body: init.body === undefined ? null : (JSON.parse(init.body) as Record<string, unknown>),
        headers: init.headers,
      });
      return await Promise.resolve(answers[path] ?? { status: 404, body: { error: 'not_found' } });
    },
  });
  return { api, calls };
}

const session = (overrides: Record<string, unknown> = {}) => ({
  state: async () =>
    await Promise.resolve({
      online: true,
      mayMutate: true,
      today: { businessTimeZone: 'America/New_York' },
      ...overrides,
    }),
});

const lane = (cards: readonly ReplyCard[]): HttpAnswer => ({
  status: 200,
  body: { businessDate: '2026-09-21', cards },
});
const settings: HttpAnswer = { status: 200, body: classifierSettingsAnswer() };
const confirmed: HttpAnswer = {
  status: 200,
  body: { status: 'accepted', replayed: false, result: confirmReplyResultAnswer() },
};

describe('the reply bridge', () => {
  it('reads the lane, the card and the configuration, and hands the window no token', async () => {
    const { api, calls } = scriptedApi({
      '/replies': lane([card()]),
      '/replies/settings': settings,
      '/replies/card': { status: 200, body: card() },
    });
    const bridge = createReplyBridge({ api, session: session() });
    const after = await bridge.refresh();
    expect(after.cards).toHaveLength(1);
    expect(after.businessDate).toBe('2026-09-21');
    expect(after.classifier?.modelName).toBe('claude-opus-5');
    // `replyStateSchema` is a strictObject, so this is structural: there is no field
    // a token could occupy and no field this bridge could add one to.
    expect(Object.keys(after).sort()).toEqual([
      'businessDate',
      'businessTimeZone',
      'cards',
      'classifier',
      'mayMutate',
      'notice',
      'online',
      'open',
    ]);
    expect(JSON.stringify(after)).not.toContain('token-value');
    expect(calls.every(call => call.headers['authorization'] === 'Bearer token-value')).toBe(true);

    const opened = await bridge.open({ messageId: MESSAGE_ID });
    expect(opened.open?.messageId).toBe(MESSAGE_ID);
    expect((await bridge.collapse()).open).toBeNull();
  });

  it('resolves a wall-clock callback against the business zone before it leaves the Mac', async () => {
    const { api, calls } = scriptedApi({
      '/replies': lane([]),
      '/replies/settings': settings,
      '/replies/confirm': confirmed,
    });
    const bridge = createReplyBridge({ api, session: session() });
    await bridge.confirm({
      messageId: MESSAGE_ID,
      disposition: 'follow_up_later',
      callback: { localDate: '2026-09-28', localTime: '09:00', sourceTimeZone: '' },
      firmWideOptOut: false,
      note: '',
    });
    const sent = calls.find(call => call.path === '/replies/confirm')?.body;
    // September in New York is EDT (-04:00). A zone-less instant is not something the
    // server may be asked to guess at.
    expect((sent?.['callback'] as Record<string, unknown>)['dueAt']).toBe('2026-09-28T13:00:00.000Z');
    expect((sent?.['callback'] as Record<string, unknown>)['sourceTimeZone']).toBe('America/New_York');
    expect(sent?.['commandId']).toEqual(expect.any(String));
    // `firmWideOptOut` is 9.1's question and is sent only where it is asked.
    expect(sent?.['firmWideOptOut']).toBeUndefined();
  });

  it('refuses to invent the callback the model proposed', async () => {
    // The card carried a proposal; the person left the field empty. 12.4 will not let
    // the model commit an instant, so the bridge sends nothing rather than sending
    // the proposal — and the notice is the one the server would have given.
    const { api, calls } = scriptedApi({
      '/replies': lane([]),
      '/replies/settings': settings,
      '/replies/confirm': confirmed,
    });
    const bridge = createReplyBridge({ api, session: session({ today: null }) });
    const after = await bridge.confirm({
      messageId: MESSAGE_ID,
      disposition: 'follow_up_later',
      callback: { localDate: '2026-09-28', localTime: '', sourceTimeZone: '' },
      firmWideOptOut: false,
      note: '',
    });
    expect(after.notice).toBe('callback_required');
    expect(calls.some(call => call.path === '/replies/confirm')).toBe(false);
  });

  it('says a loss is suggested and offers nothing that would act on it', async () => {
    const { api } = scriptedApi({
      '/replies': lane([]),
      '/replies/settings': settings,
      '/replies/confirm': {
        status: 200,
        body: {
          status: 'accepted',
          replayed: false,
          result: confirmReplyResultAnswer({
            suggestsLost: true,
            confirmation: replyConfirmationAnswer({ disposition: 'not_interested' }),
          }),
        },
      },
    });
    const bridge = createReplyBridge({ api, session: session() });
    const after = await bridge.confirm({
      messageId: MESSAGE_ID,
      disposition: 'not_interested',
      callback: null,
      firmWideOptOut: false,
      note: '',
    });
    expect(after.notice).toBe('suggests_lost');
    expect(replyNotice('suggests_lost')).toContain('Callie will not do it for you');
    // The bridge's whole surface, and none of it closes anything. `resolve` (lane g88) is
    // G7's ambiguity resolution, which picks a conversation and answers nothing.
    expect(Object.keys(bridge).sort()).toEqual(['collapse', 'confirm', 'open', 'refresh', 'resolve', 'state']);
    expect(Object.values(REPLY_IPC_CHANNELS).sort()).toEqual([
      'callie:replies:collapse',
      'callie:replies:confirm',
      'callie:replies:open',
      'callie:replies:refresh',
      'callie:replies:resolve',
      'callie:replies:state',
    ]);
  });

  it('keeps a refused confirmation’s reason and shows no card it could not read', async () => {
    const { api } = scriptedApi({
      '/replies': lane([card()]),
      '/replies/settings': settings,
      '/replies/card': { status: 409, body: { error: 'refused', reason: 'already_confirmed' } },
    });
    const bridge = createReplyBridge({ api, session: session() });
    await bridge.refresh();
    const after = await bridge.open({ messageId: MESSAGE_ID });
    expect(after.open).toBeNull();
    expect(after.notice).toBe('already_confirmed');
    expect(replyNotice(after.notice ?? '')).toBe('Somebody already answered this reply.');
  });
});

describe('the classifier line at every effort the server accepts (lane g78, D03)', () => {
  it('reads xhigh and max, which 1.0.4 turned into "no classifier"', async () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const { api } = scriptedApi({
        '/replies': lane([card()]),
        '/replies/settings': { status: 200, body: classifierSettingsAnswer({ effort }) },
      });
      const after = await createReplyBridge({ api, session: session() }).refresh();
      expect(after.classifier, effort).toEqual({ enabled: true, modelName: 'claude-opus-5', effort });
      expect(buildReplyView(after, null).classifierLine, effort).toBe(`Suggestions come from claude-opus-5 at ${effort} effort.`);
    }
  });

  it('keeps the caps and the update metadata on the server', async () => {
    const { api } = scriptedApi({
      '/replies': lane([card()]),
      '/replies/settings': {
        status: 200,
        body: classifierSettingsAnswer({ effort: 'max', updatedByUserId: USER_ID, updatedAt: '2026-09-21T12:00:00.000Z' }),
      },
    });
    const after = await createReplyBridge({ api, session: session() }).refresh();
    expect(Object.keys(after.classifier ?? {}).sort()).toEqual(['effort', 'enabled', 'modelName']);
  });
});

describe('the candidate selector (lane g88, audit G07)', () => {
  const ambiguous = (): ReplyCard =>
    card({
      nextAction: 'resolve_ambiguity',
      impact: {
        controlMode: 'automated',
        holds: [],
        ambiguous: true,
        candidates: [
          { opportunityId: OPPORTUNITY_ID, firmId: FIRM_ID, firmName: 'Northwind Test Holdings', selected: null },
          { opportunityId: OTHER_OPPORTUNITY_ID, firmId: OTHER_FIRM_ID, firmName: '', selected: null },
        ],
        contactsAtFirm: 1,
      },
    });

  it('offers every candidate, names one it could not read, and only to a member who may read the reply', () => {
    const view = buildReplyCardView(state(), ambiguous(), null);
    expect(view.ambiguity.map(candidate => candidate.opportunityId)).toEqual([OPPORTUNITY_ID, OTHER_OPPORTUNITY_ID]);
    expect(view.resolveEnabled).toBe(true);
    expect(view.choices).toEqual([]);
    expect(candidateLabel(view.ambiguity[1] ?? ambiguous().impact.candidates[0]!)).toBe('A firm Callie could not name');
    expect(buildReplyCardView(state(), ambiguous(), null).confirmEnabled).toBe(false);
    expect(buildReplyCardView(state({ mayMutate: false }), ambiguous(), null).resolveEnabled).toBe(false);
    expect(buildReplyCardView(state(), { ...ambiguous(), visibility: 'any_active_member' }, null).resolveEnabled).toBe(false);
  });

  it('sends G7’s resolution with human false, keeps the card open and reads it again', async () => {
    const answers: Record<string, HttpAnswer> = {
      '/messages/resolve-ambiguity': { status: 200, body: { status: 'accepted', replayed: false, result: {} } },
      '/replies': lane([ambiguous()]),
      '/replies/settings': settings,
      '/replies/card': { status: 200, body: ambiguous() },
    };
    const { api, calls } = scriptedApi(answers);
    const bridge = createReplyBridge({ api, session: session() });
    await bridge.refresh();
    await bridge.open({ messageId: MESSAGE_ID });
    // After the resolution the server answers with the resolved card.
    answers['/replies'] = lane([card()]);
    answers['/replies/card'] = { status: 200, body: card() };
    const answer = await bridge.resolve({ messageId: MESSAGE_ID, opportunityId: OTHER_OPPORTUNITY_ID });
    expect(calls.map(call => call.path)).toEqual([
      '/replies',
      '/replies/settings',
      '/replies/card',
      '/messages/resolve-ambiguity',
      '/replies',
      '/replies/settings',
      '/replies/card',
    ]);
    const sent = calls.find(call => call.path === '/messages/resolve-ambiguity');
    expect(sent?.body).toMatchObject({ messageId: MESSAGE_ID, selectedOpportunityId: OTHER_OPPORTUNITY_ID, human: false });
    expect(typeof sent?.body?.['commandId']).toBe('string');
    expect(answer.notice).toBe('resolved');
    expect(answer.open?.nextAction).toBe('confirm_disposition');
    expect(replyNotice('resolved')).toContain('Now say what the reply means');
  });

  it('sends nothing for an opportunity that is not one of the card’s candidates', async () => {
    const { api, calls } = scriptedApi({
      '/replies': lane([ambiguous()]),
      '/replies/settings': settings,
      '/replies/card': { status: 200, body: ambiguous() },
    });
    const bridge = createReplyBridge({ api, session: session() });
    await bridge.open({ messageId: MESSAGE_ID });
    const answer = await bridge.resolve({ messageId: MESSAGE_ID, opportunityId: HOLD_ID });
    expect(answer.notice).toBe('match_unknown');
    expect(calls.map(call => call.path)).not.toContain('/messages/resolve-ambiguity');
  });
});
