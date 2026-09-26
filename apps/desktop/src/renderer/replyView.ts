import {
  REPLY_DISPOSITIONS,
  type ReplyCandidate,
  type ReplyCard,
  type ReplyDisposition,
  type ReplyState,
} from './replyContract.ts';

/**
 * What the reply card shows, as a pure function of the state the main process sent
 * (specification 8.3, 12.4, 14.2).
 *
 * The same split G2 made in `viewModel.ts` and G6 made in `todayView.ts`, and here it
 * carries the authority boundary. 12.4 gives the model a *suggestion* and gives the
 * decision to a person; whether that holds on screen is a property of this function,
 * so it is a unit test rather than a screenshot.
 *
 * Four rules live here.
 *
 * **The suggestion is never the answer, and never a default.** `chosen` is a
 * parameter, `confirmEnabled` is false until it is non-null, and nothing in this file
 * computes it from the card. A person's click is the only thing that fills it in. See
 * `docs/decisions/g7b-the-suggestion-is-not-a-default.md`.
 *
 * **Confidence is a number on the screen and nothing else.** It appears in one label
 * and in no condition. A threshold here would be exactly the thing 12.4 refuses: a
 * model deciding, with a person's name on it.
 *
 * **What a choice will do is said before it is done.** Each disposition carries the
 * consequences `confirmReplyDisposition` actually applies — manual control, the hold
 * this message opened, a suppression on opt-out — and `not_interested` says in words
 * that Callie will not close the opportunity, because it will not (9.1).
 *
 * **A refusal is a code, and this is the one place it becomes a sentence.** The
 * window composes nothing of its own, so the words a person reads are versioned with
 * the release and one code never says two things.
 */

export interface BannerView {
  readonly tone: 'info' | 'warning' | 'blocking';
  readonly text: string;
}

export const DISPOSITION_LABELS: Readonly<Record<ReplyDisposition, string>> = Object.freeze({
  interested: 'Interested',
  referral_or_wrong_person: 'Wrong person, or referred me on',
  follow_up_later: 'Asked me to follow up later',
  not_interested: 'Not interested',
  opt_out: 'Asked not to be contacted',
  other: 'Something else',
});

/**
 * What confirming each disposition will do, in the words of the command that does it.
 *
 * Kept beside the labels rather than in the DOM so that the day
 * `confirmReplyDisposition` grows or loses a consequence, the sentence a person reads
 * before pressing the button is one edit away and one test away.
 */
export const DISPOSITION_CONSEQUENCES: Readonly<Record<ReplyDisposition, string>> = Object.freeze({
  interested:
    'Callie stops automated sending for this firm and hands it to you. It does not move the deal forward on its own.',
  referral_or_wrong_person:
    'Callie stops automated sending for this firm and hands it to you. Add the right contact on the firm page.',
  follow_up_later: 'Callie stops automated sending and books the callback you enter below.',
  not_interested:
    'Callie stops automated sending and suggests marking the deal Lost. It does not close anything — that is your call on the firm page.',
  opt_out:
    'Callie stops automated sending and records a do-not-contact for this address. Tick the box below to cover the whole firm.',
  other: 'Callie stops automated sending for this firm and hands it to you.',
});

export const CLASS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  human_reply: 'A person wrote this',
  automated: 'Automatic response',
  bounce: 'Delivery failure',
  out_of_office: 'Out of office',
  uncertain: 'Callie is not sure',
});

const NOTICES: Readonly<Record<string, string>> = Object.freeze({
  offline: 'Callie cannot reach the server.',
  not_signed_in: 'Sign in on the main window before reading replies.',
  client_upgrade_required: 'This version of Callie is out of date. Install the current build to continue.',
  confirmed: 'Recorded.',
  suggests_lost:
    'Recorded. This one looks lost — mark the deal Lost on the firm page if you agree. Callie will not do it for you.',
  admin_only: 'Only an admin can change that.',
  not_assigned: 'This firm is somebody else’s. Ask an admin if you need it.',
  message_unknown: 'That reply is no longer here.',
  not_classified: 'Callie has not read this message yet.',
  ambiguity_unresolved: 'Pick which conversation this reply belongs to first.',
  // Lane g88: the candidate selector.
  resolved: 'Linked to that conversation. Now say what the reply means.',
  already_resolved: 'Somebody already chose the conversation for this reply.',
  match_unknown: 'That conversation is not one of this reply’s candidates.',
  already_confirmed: 'Somebody already answered this reply.',
  callback_required: 'Enter the day and time to call back.',
  callback_not_permitted: 'A callback belongs with “asked me to follow up later”.',
  suppression_failed: 'Callie could not record the do-not-contact. Nothing was changed.',
  invalid_input: 'Callie could not read that.',
  refused: 'The server refused that.',
  unreadable_answer: 'Callie could not read the server’s answer.',
});

/** The one place a refusal code becomes English. Unknown codes are shown as-is. */
export function replyNotice(code: string): string {
  return NOTICES[code] ?? code;
}

export interface DispositionChoiceView {
  readonly disposition: ReplyDisposition;
  readonly label: string;
  readonly consequence: string;
  /** True when a rule or the model proposed it. A hint beside it, not a selection. */
  readonly suggested: boolean;
  readonly selected: boolean;
}

export interface SuggestionView {
  /** "Interested", or null when only a rule spoke. */
  readonly dispositionLabel: string | null;
  /** Which layer proposed it: a person correcting a rule is not correcting a model. */
  readonly source: 'deterministic' | 'model' | 'none';
  /** "Fairly confident (0.88)". Displayed, never compared against anything. */
  readonly confidenceLabel: string | null;
  /** The model's quotation from the message, or null when it may not be shown. */
  readonly excerpt: string | null;
  /** "claude-opus-5, prompt g7b.replies.1" — what produced it, for a person judging it. */
  readonly attribution: string | null;
}

export interface ReplyCardView {
  readonly messageId: string;
  /** The firm the reply is about, which the card opens in the Firms view. */
  readonly firmId: string;
  readonly heading: string;
  readonly fromLine: string;
  readonly subject: string | null;
  readonly bodyText: string | null;
  readonly bodyTruncated: boolean;
  /** True when Appendix F withheld the body from this member. */
  readonly redacted: boolean;
  readonly classLabel: string;
  readonly signalLines: readonly string[];
  readonly suggestion: SuggestionView | null;
  readonly impactLines: readonly string[];
  readonly choices: readonly DispositionChoiceView[];
  /** The `datetime-local` and zone to prefill, from the model's reading of the words. */
  readonly callbackPrefill: { readonly localDateTime: string; readonly timeZone: string } | null;
  readonly callbackOffered: boolean;
  readonly callbackRequired: boolean;
  readonly firmWideOptOutOffered: boolean;
  readonly confirmEnabled: boolean;
  readonly confirmLabel: string;
  readonly nextAction: ReplyCard['nextAction'];
  /** Present only while an ambiguity is unresolved; resolving it is G7's command. */
  readonly ambiguity: readonly ReplyCandidate[];
  /** Whether the candidate selector may send (lane g88): online, allowed to mutate, and allowed to read the reply. */
  readonly resolveEnabled: boolean;
  readonly banners: readonly BannerView[];
}

export interface ReplyScreenView {
  readonly heading: string;
  readonly banners: readonly BannerView[];
  readonly summaries: readonly { readonly card: ReplyCard; readonly line: string; readonly open: boolean }[];
  readonly card: ReplyCardView | null;
  readonly emptyMessage: string | null;
  /** What the workspace is paying for, for the person reading a suggestion. */
  readonly classifierLine: string | null;
}

export const REPLY_HEADING = 'Replies';
const EMPTY_LIST = 'No replies to read.';
const EMPTY_OFFLINE = 'Callie cannot reach the server, and replies are never kept on this Mac.';

function confidenceLabel(confidence: number | null): string | null {
  if (confidence === null) return null;
  const band = confidence >= 0.85 ? 'Confident' : confidence >= 0.6 ? 'Fairly confident' : 'Unsure';
  return `${band} (${confidence.toFixed(2)})`;
}

function impactLines(card: ReplyCard): readonly string[] {
  const lines: string[] = [];
  lines.push(
    card.impact.controlMode === 'automated'
      ? 'Automated sending is on for this firm.'
      : 'This firm is already yours to work by hand.',
  );
  for (const hold of card.impact.holds) {
    lines.push(
      hold.blockedActionKinds.length === 0
        ? `On hold: ${hold.reasonCode}.`
        : `On hold: ${hold.reasonCode} — ${hold.blockedActionKinds.join(', ')} paused.`,
    );
  }
  if (card.impact.contactsAtFirm > 1) {
    lines.push(`${String(card.impact.contactsAtFirm)} people at this firm are in Callie.`);
  }
  if (card.impact.ambiguous) lines.push('This reply could belong to more than one conversation.');
  return lines;
}

/**
 * One card, given what the person has chosen so far.
 *
 * `chosen` comes from the renderer's own state and starts as null. That is the
 * authority boundary: the model's suggestion is rendered beside the choices and is
 * never one of them, so a confirmation is always something a person clicked.
 */
export function buildReplyCardView(
  state: ReplyState,
  card: ReplyCard,
  chosen: ReplyDisposition | null,
): ReplyCardView {
  const banners: BannerView[] = [];
  // Appendix F: a member who may not read the message is not offered an answer to
  // it. Not a disabled form — no form. A body they cannot see and six buttons they
  // cannot press is an invitation to ask somebody to read it out to them.
  const answerable = card.nextAction === 'confirm_disposition' && card.visibility === 'assigned_or_admin';
  // Offline is a banner, not a disabled form (wave 1): a confirmation sent offline fails
  // with its own notice.
  const mayAct = state.mayMutate;

  if (card.visibility === 'any_active_member') {
    banners.push({ tone: 'warning', text: replyNotice('not_assigned') });
  }
  if (!state.online) banners.push({ tone: 'warning', text: replyNotice('offline') });
  if (card.nextAction === 'resolve_ambiguity') {
    banners.push({ tone: 'blocking', text: replyNotice('ambiguity_unresolved') });
  }
  if (card.nextAction === 'review_bounce') {
    banners.push({
      tone: 'info',
      text: 'This is a delivery failure, not a reply. Nobody wrote it, so there is nothing to answer.',
    });
  }
  if (card.confirmation !== null) {
    const answered = DISPOSITION_LABELS[card.confirmation.disposition];
    banners.push({
      tone: 'info',
      text: card.confirmation.corrected
        ? `Answered: ${answered}. Callie had suggested something else.`
        : `Answered: ${answered}.`,
    });
  }

  const suggestion: SuggestionView | null =
    card.proposedDisposition === null && card.supportingExcerpt === null
      ? null
      : {
          dispositionLabel: card.proposedDisposition === null ? null : DISPOSITION_LABELS[card.proposedDisposition],
          source: card.proposedBy,
          confidenceLabel: confidenceLabel(card.confidence),
          excerpt: card.supportingExcerpt,
          attribution:
            card.modelName === null
              ? null
              : `${card.modelName}${card.promptVersion === null ? '' : `, prompt ${card.promptVersion}`}`,
        };

  const choices = answerable
    ? REPLY_DISPOSITIONS.map(disposition => ({
        disposition,
        label: DISPOSITION_LABELS[disposition],
        consequence: DISPOSITION_CONSEQUENCES[disposition],
        suggested: card.proposedDisposition === disposition,
        selected: chosen === disposition,
      }))
    : [];

  const callbackOffered = chosen === 'follow_up_later';
  return {
    messageId: card.messageId,
    firmId: card.firmId,
    heading: card.firmName,
    fromLine:
      card.contactName === null
        ? (card.from ?? 'Unknown sender')
        : `${card.contactName}${card.contactTitle === null ? '' : ` (${card.contactTitle})`}`,
    subject: card.subject,
    bodyText: card.body?.text ?? null,
    bodyTruncated: card.body?.truncated ?? false,
    redacted: card.visibility === 'any_active_member',
    classLabel: CLASS_LABELS[card.deterministicClass] ?? card.deterministicClass,
    signalLines: card.signals.map(signal => `${signal.rule}: ${signal.evidence}`),
    suggestion,
    impactLines: impactLines(card),
    choices,
    callbackPrefill:
      card.callbackProposal === null
        ? null
        : {
            localDateTime: card.callbackProposal.localDateTime,
            timeZone: card.callbackProposal.timeZone ?? state.businessTimeZone ?? '',
          },
    callbackOffered,
    // The server refuses a confirmation that dropped a proposed callback
    // (`callback_required`), because a card that showed a time and sent none is a
    // person agreeing to something that then did not happen.
    callbackRequired: callbackOffered && card.callbackProposal !== null,
    firmWideOptOutOffered: chosen === 'opt_out',
    // Everything above may be true and this stays false until somebody chooses.
    confirmEnabled: mayAct && answerable && chosen !== null,
    confirmLabel: chosen === null ? 'Choose what this reply means' : `Confirm: ${DISPOSITION_LABELS[chosen]}`,
    nextAction: card.nextAction,
    ambiguity: card.nextAction === 'resolve_ambiguity' ? card.impact.candidates : [],
    // A member who may not read the message is not asked which conversation it is.
    resolveEnabled: mayAct && card.visibility === 'assigned_or_admin',
    banners,
  };
}

/** A candidate firm as the selector names it. A firm that could not be read is still a choice. */
export function candidateLabel(candidate: ReplyCandidate): string {
  return candidate.firmName.trim() === '' ? 'A firm Callie could not name' : candidate.firmName;
}

function summaryLine(card: ReplyCard): string {
  const who = card.contactName ?? card.from ?? 'Unknown sender';
  const what =
    card.nextAction === 'resolve_ambiguity'
      ? 'Which conversation?'
      : card.nextAction === 'review_bounce'
        ? 'Delivery failure'
        : card.confirmation !== null
          ? DISPOSITION_LABELS[card.confirmation.disposition]
          : card.proposedDisposition === null
            ? 'Needs an answer'
            : `Callie suggests: ${DISPOSITION_LABELS[card.proposedDisposition]}`;
  return `${card.firmName} — ${who} — ${what}`;
}

export function buildReplyView(state: ReplyState, chosen: ReplyDisposition | null): ReplyScreenView {
  const banners: BannerView[] = [];
  if (!state.online) banners.push({ tone: 'warning', text: replyNotice('offline') });
  if (state.notice !== null) banners.push({ tone: 'info', text: replyNotice(state.notice) });
  if (state.classifier !== null && !state.classifier.enabled) {
    banners.push({
      tone: 'info',
      text: 'Callie’s reading of replies is switched off, so these cards carry the rules only.',
    });
  }

  return {
    heading: REPLY_HEADING,
    banners,
    summaries: state.cards.map(card => ({
      card,
      line: summaryLine(card),
      open: state.open?.messageId === card.messageId,
    })),
    card: state.open === null ? null : buildReplyCardView(state, state.open, chosen),
    emptyMessage: state.cards.length > 0 ? null : state.online ? EMPTY_LIST : EMPTY_OFFLINE,
    classifierLine:
      state.classifier === null
        ? null
        : `Suggestions come from ${state.classifier.modelName} at ${state.classifier.effort} effort.`,
  };
}
