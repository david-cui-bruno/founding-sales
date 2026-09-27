import {
  REPLY_DISPOSITIONS,
  type ReplyCandidate,
  type ReplyCard,
  type ReplyDisposition,
  type ReplyState,
  type ReplySummary,
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
 * **⚠ The suggestion is the starting answer, and it is labelled as one (D5.1).** The
 * owner decided on 26 September 2026 that the card should open with Callie's guess
 * already chosen, knowingly reversing G7b's "the suggestion is not a default"
 * (`docs/archive/decisions/g7b-the-suggestion-is-not-a-default.md`). `chosen` is still a
 * parameter and nothing in this file computes it from the card: the view supplies the
 * guess when a card opens, so what is selected is always a value some code chose on the
 * person's behalf and the page says whose guess it is, right beside it.
 *
 * The guards that came with the decision are the view's, in `replies/RepliesView.tsx`:
 * Confirm is a `type="button"` with no form around it, so no keystroke anywhere on the
 * card can confirm; the button names what confirming will actually do; and nothing
 * anywhere says an uncorrected confirmation means the guess was read.
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

const DISPOSITION_LABELS: Readonly<Record<ReplyDisposition, string>> = Object.freeze({
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
const DISPOSITION_CONSEQUENCES: Readonly<Record<ReplyDisposition, string>> = Object.freeze({
  interested:
    'Callie stops automated sending for this firm and hands it to you. It does not move the deal forward on its own.',
  referral_or_wrong_person:
    'Callie stops automated sending for this firm and hands it to you. Add the right contact on the firm page.',
  // The card where Callie read no day in the reply; `followUpConsequence` is the other.
  follow_up_later:
    'Callie stops automated sending. Enter a day and a time below and it books that callback; leave them empty and it is a follow-up with no date on it.',
  not_interested:
    'Callie stops automated sending and suggests marking the deal Lost. It does not close anything — that is your call on the firm page.',
  opt_out:
    'Callie stops automated sending and records a do-not-contact for this address. Tick the box below to cover the whole firm.',
  other: 'Callie stops automated sending for this firm and hands it to you.',
});

/**
 * What the Confirm button says, and it says the effect rather than the label of the
 * choice: "Confirm: Asked not to be contacted" is agreement with a classification, and
 * "Stop automation and record a do-not-contact" is the thing that is about to happen.
 * D5.1 asks for the second, because the guess arrives already selected.
 */
export const CONFIRM_LABELS: Readonly<Record<ReplyDisposition, string>> = Object.freeze({
  interested: 'Stop automated sending and take this firm over',
  referral_or_wrong_person: 'Stop automated sending and take this firm over',
  follow_up_later: 'Stop automated sending and book the callback',
  not_interested: 'Stop automated sending and record: not interested',
  opt_out: 'Stop automated sending and record a do-not-contact',
  other: 'Stop automated sending and take this firm over',
});

/** What Confirm says with no date entered for a follow-up: what will actually happen. */
export const FOLLOW_UP_WITHOUT_DATE = 'Stop automated sending and note a follow-up — no date yet';

/**
 * …except on a card where Callie read a day in the reply.
 *
 * `confirmReplyDisposition` refuses a `follow_up_later` with no callback when the model
 * proposed one (`callback_required`, `confirmations.ts`): the proposal is on the card, a
 * person clearing the field has not said what to put in its place, and the server will
 * not take silence for an answer. So the button does not offer the press — it says what
 * is missing, and stays dead until the day is there.
 */
export const CALLBACK_REQUIRED_LABEL = 'Enter the day before confirming this';
export const CALLBACK_REQUIRED_HINT =
  'Callie read a day in this reply, so this answer needs one. Type the day, or choose a different answer.';

/**
 * What confirming a follow-up will do, on this card.
 *
 * The sentence above the button and the button itself have to describe the same press.
 * On a card where the model proposed a day, `confirmReplyDisposition` refuses an empty
 * callback (`callback_required`) and the button says so (`CALLBACK_REQUIRED_LABEL`) — so
 * the consequence may not go on offering "leave them empty", which is the one branch
 * that cannot happen there. Everywhere else both branches are real, and it names both.
 */
export function followUpConsequence(callbackProposed: boolean): string {
  return callbackProposed
    ? 'Callie stops automated sending and books the callback you enter below. Callie read a day in this reply, so this answer needs one.'
    : DISPOSITION_CONSEQUENCES.follow_up_later;
}

/**
 * What the button says, and it says exactly what pressing it will do (1.0.12).
 *
 * `callbackBooked` is whether a day has actually been typed. The domain books a callback
 * **only if one was supplied** (`confirmations.ts`), so "book the callback" on an empty
 * form was a button promising something that would not happen — the one thing D5.1's
 * guard about naming the effect exists to prevent. With a date it books; without one it
 * stops automation and leaves a follow-up with no date, and the button says so.
 */
export function confirmLabel(chosen: ReplyDisposition | null, callbackBooked: boolean): string {
  if (chosen === null) return 'Choose what this reply means';
  if (chosen === 'follow_up_later' && !callbackBooked) return FOLLOW_UP_WITHOUT_DATE;
  return CONFIRM_LABELS[chosen];
}

const CLASS_LABELS: Readonly<Record<string, string>> = Object.freeze({
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

interface DispositionChoiceView {
  readonly disposition: ReplyDisposition;
  readonly label: string;
  readonly consequence: string;
  /** True when a rule or the model proposed it. A hint beside it, not a selection. */
  readonly suggested: boolean;
  readonly selected: boolean;
}

interface SuggestionView {
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
  /** What pressing Confirm will do, in the words of the command that does it. */
  readonly confirmLabel: string;
  readonly nextAction: ReplyCard['nextAction'];
  /** Present only while an ambiguity is unresolved; resolving it is G7's command. */
  readonly ambiguity: readonly ReplyCandidate[];
  /** Whether the candidate selector may send (lane g88): online, allowed to mutate, and allowed to read the reply. */
  readonly resolveEnabled: boolean;
  readonly banners: readonly BannerView[];
}

interface ReplyScreenView {
  readonly heading: string;
  readonly banners: readonly BannerView[];
  readonly summaries: readonly { readonly card: ReplySummary; readonly line: string; readonly open: boolean }[];
  readonly card: ReplyCardView | null;
  readonly emptyMessage: string | null;
  /** What the workspace is paying for, for the person reading a suggestion. */
  readonly classifierLine: string | null;
}

const REPLY_HEADING = 'Replies';
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
        consequence:
          disposition === 'follow_up_later'
            ? followUpConsequence(card.callbackProposal !== null)
            : DISPOSITION_CONSEQUENCES[disposition],
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
    // A card whose model had no guess still opens with nothing chosen, and then this
    // stays false until somebody chooses.
    confirmEnabled: mayAct && answerable && chosen !== null,
    // Without the date somebody has typed — which is the form's, not this state's — a
    // follow-up reads as the dateless one it would be. `RepliesView` calls
    // `confirmLabel` again with the field's value and shows that.
    confirmLabel: confirmLabel(chosen, false),
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

/** One line per card. Built from the summary, which has no body in it to leak. */
function summaryLine(card: ReplySummary): string {
  const who = card.contactName ?? card.from ?? 'Unknown sender';
  const what =
    card.nextAction === 'resolve_ambiguity'
      ? 'Which conversation?'
      : card.nextAction === 'review_bounce'
        ? 'Delivery failure'
        : card.confirmedDisposition !== null
          ? DISPOSITION_LABELS[card.confirmedDisposition]
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
