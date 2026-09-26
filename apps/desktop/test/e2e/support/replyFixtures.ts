import type { ReplyCard, ReplyState } from '../../../src/renderer/replyContract.ts';
import type { Call } from './appServer.ts';

/**
 * The Replies view's fixtures and the `callieReplies` fake's scripted answers, for the
 * one harness (`appServer.ts`).
 *
 * What these specs are for is what a person sees and can press. The rules behind it
 * are proved against a real PostgreSQL in `@fss/domain/classification`.
 *
 * No real person, firm or address appears. `example.test` is reserved by RFC 6761.
 */

export const MESSAGE_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_MESSAGE_ID = '22222222-2222-4222-8222-222222222222';
export const FIRM_ID = '33333333-3333-4333-8333-333333333333';
export const OPPORTUNITY_ID = '55555555-5555-4555-8555-555555555555';
const HOLD_ID = '88888888-8888-4888-8888-888888888888';

export function replyCard(overrides: Partial<ReplyCard> = {}): ReplyCard {
  return {
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
      candidates: [
        { opportunityId: OPPORTUNITY_ID, firmId: FIRM_ID, firmName: 'Northwind Test Holdings', selected: true },
      ],
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
  };
}

export function replyState(overrides: Partial<ReplyState> = {}): ReplyState {
  return {
    businessDate: '2026-09-21',
    businessTimeZone: 'America/New_York',
    cards: [replyCard()],
    open: null,
    online: true,
    mayMutate: true,
    classifier: { enabled: true, modelName: 'claude-opus-5', effort: 'low' },
    notice: null,
    ...overrides,
  };
}

/** `callieReplies`, scripted. What each outcome proves is in the spec that uses it. */
export function replyAnswer(state: ReplyState, method: string, argument: unknown, _calls: readonly Call[]): ReplyState {
  if (method === 'open') {
    const messageId = (argument as { messageId?: string } | null)?.messageId;
    return { ...state, open: state.cards.find(card => card.messageId === messageId) ?? null, notice: null };
  }
  if (method === 'collapse') return { ...state, open: null, notice: null };
  if (method === 'confirm') {
    // The server decides what a confirmation meant. The window asked the same way for
    // all six dispositions and is told which notice to show.
    const disposition = (argument as { disposition?: string } | null)?.disposition;
    return { ...state, open: null, notice: disposition === 'not_interested' ? 'suggests_lost' : 'confirmed' };
  }
  if (method === 'resolve' && state.open !== null) {
    // Lane g88: G7's resolution picked a conversation; the card comes back asking what
    // the reply means, with the chosen candidate marked.
    const chosen = (argument as { opportunityId?: string } | null)?.opportunityId;
    const open = state.open;
    return {
      ...state,
      open: {
        ...open,
        nextAction: 'confirm_disposition',
        impact: {
          ...open.impact,
          ambiguous: false,
          candidates: open.impact.candidates.map(candidate => ({ ...candidate, selected: candidate.opportunityId === chosen })),
        },
      },
      notice: 'resolved',
    };
  }
  return state;
}
