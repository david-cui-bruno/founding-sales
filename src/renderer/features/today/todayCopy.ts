import type { PhoneSetupStatus } from '../../../shared/contracts/phoneSetupContract';

/** Shared Today and Settings copy for the D2 default allocation. One place, so the two screens never disagree. */
export const DEFAULT_NEW_CALL_SLOTS_COPY = 'default: 30 new firms a day';

/**
 * D6 dial modes. The saved phone setup state is the only honest signal the
 * renderer has about whether the signed helper can open Phone.app on this Mac:
 * `configured` means an inspected candidate matched the confirmed proof,
 * anything else means it did not. `unreadable` is not a contract state; it is
 * what Today says when phone setup could not be read at all, rather than
 * guessing at a success.
 *
 * `reason` is null exactly when Callie can dial. Otherwise the call card reads
 * "Callie cannot dial from this Mac: <reason>. Dial it yourself and log the
 * outcome below." and Settings shows `label` beside `card`. No state here is a
 * fixture success and none of this text is call permission.
 */
/**
 * D6 acceptance 2 (manual dial into the same outcome form) is half wired in this
 * build. `createDelegatedPhoneHandoff` now admits a hand-dialed attempt: a
 * `manual` handoff skips the helper capability gate, consumes the step's one
 * handoff under the same command identity and never dispatches
 * (`src/main/delegation/executionRouter.ts`). Two things still stand between
 * that and a control here, and neither is lane 32's to change:
 * `phoneFreshBinding` in `companyPhoneSession.ts` throws
 * 'Phone handoff readiness is not configured.' before a review exists when
 * setup is not `configured`, and `delegatedPhoneHandoffRequestSchema`
 * (`ownerCommandContract.ts`) has no optional `manual` field for the IPC request
 * to carry. Rather than promise a form it cannot open, the card says so. Delete
 * this line with those two.
 */
export const MANUAL_DIAL_NOT_WIRED = 'Logging a hand-dialed call still needs the call step\'s one handoff. The desktop can now take one for a hand-dialed attempt, but this screen cannot ask for it yet, so the outcome form below stays closed for this firm.';

/**
 * D11: "roadmap updated from measured use; next quarter planned from numbers,
 * not features". One collapsible block under the footer, plain numbers only: no
 * charts, no ranking, no targets and no praise. Every label says what the number
 * counts, because a number whose definition is vague is worse than no number.
 *
 * Two honest labels differ from the first sketch of this block:
 * - "Mornings worked", not "mornings opened". The morning list is computed at
 *   read time and never stored, so no record can say a morning was opened. This
 *   counts mornings with recorded work and the block says so in one line.
 * - "Drafts written", not "drafts sent". Nothing in this build sends a draft;
 *   saving and approving one is not sending it.
 */
export const WEEKLY_SUMMARY_COPY = Object.freeze({
  heading: 'This week',
  lastWeekHeading: 'Last week',
  unavailable: 'This week’s numbers are unavailable until the local records can be read.',
  derivation: 'Counted from the records this Mac already keeps. "Mornings" and "firms" count the ones with recorded work: a morning you opened without working it is not counted.',
  spendUnknown: 'Spend unknown',
  noHolds: 'no holds',
  labels: Object.freeze({
    mornings: 'Mornings worked',
    firms: 'Firms worked',
    callsPlaced: 'Calls placed',
    notes: 'Notes written',
    callbacksPromised: 'Callbacks promised',
    callbacksKept: 'Callbacks kept',
    drafts: 'Drafts written',
    replies: 'Replies received',
    holds: 'Holds',
  }),
  /** The same words the call outcome form uses, so the two screens never disagree about a result. */
  outcomes: Object.freeze({
    connected: 'Connected',
    interested: 'Connected, interested',
    not_interested: 'Connected, not interested',
    gatekeeper: 'Gatekeeper',
    voicemail: 'Voicemail',
    no_answer: 'No answer',
    busy: 'Busy',
    wrong_number: 'Wrong number',
  }),
  holdReasons: Object.freeze({
    requires_owner_preflight: 'follow-up needs an owner preflight',
    reply_capability_unverified: 'reply capability unverified',
    manual_only: 'LinkedIn note is manual only',
  }),
});

/**
 * The line Today puts on a firm that answered. Lane 26's rule rests the sequence
 * on the worker after a reply; the desktop only shows the state it projects, so
 * this never claims a pause the stored enrollment does not report.
 */
export function replyFirstLine(firmName: string): string {
  return `Reply received from ${firmName}`;
}
export function sequenceStateLine(state: string | null): string {
  if (state === null) return 'No sequence for this firm';
  if (state === 'paused') return 'Sequence paused';
  return `Sequence ${state.replaceAll('_', ' ')}`;
}

export type PhoneDialMode = Readonly<{ label: string; reason: string | null; card: string }>;
export type PhoneDialState = PhoneSetupStatus['state'] | 'unreadable';

export const PHONE_DIAL_MODES: Readonly<Record<PhoneDialState, PhoneDialMode>> = Object.freeze({
  configured: Object.freeze({
    label: 'Available on this Mac',
    reason: null,
    // Names the control that actually exists today, renamed to D6's wording together with the
    // button in CompanyPhoneCall.tsx so the two screens never disagree about what to press.
    card: 'Callie can dial from this Mac. "Call with Phone.app" below is the way to call, one handoff per call step; the number is here either way.',
  }),
  needs_confirmation: Object.freeze({
    label: 'Not verified',
    reason: 'a phone helper answered but nobody has confirmed it in Settings',
    card: 'The call card shows the number to dial by hand. Confirm phone setup here to let Callie open Phone.app instead.',
  }),
  unconfigured: Object.freeze({
    label: 'Not set up',
    reason: 'no phone route is confirmed in Settings',
    card: 'The call card shows the number to dial by hand. Refresh and confirm phone setup here to let Callie open Phone.app instead.',
  }),
  unavailable: Object.freeze({
    label: 'Unsupported, unsigned or unverified',
    reason: 'the signed phone helper did not answer (an unsupported macOS, an unsigned or missing helper, or a failed packaged check)',
    card: 'The call card shows the number to dial by hand. Callie cannot tell those three causes apart from the helper\'s reply alone.',
  }),
  unreadable: Object.freeze({
    label: 'Could not be read',
    reason: 'phone setup could not be read on this Mac',
    card: 'The call card shows the number to dial by hand until phone setup can be read again.',
  }),
});
