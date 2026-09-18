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
 * D6 acceptance 2 (manual dial into the same outcome form) is NOT wired in this
 * build. The outcome form opens on a consumed handoff, and the only path that
 * consumes one runs `createDelegatedPhoneHandoff`, which refuses before it
 * submits anything unless the helper capability is `available`
 * (`src/main/delegation/executionRouter.ts`, the `capability.state !== 'available'`
 * gate). Letting a hand-dialed attempt consume the step's one handoff needs a
 * mode on `delegatedPhoneHandoffRequestSchema` and a control in
 * `CompanyPhoneCall.tsx` — neither is lane 27's to change. Rather than promise
 * a form it cannot open, the card says so. Delete this line with the mechanism.
 */
export const MANUAL_DIAL_NOT_WIRED = 'Logging a hand-dialed call still needs the call step\'s one handoff, which this build can only take through the helper. Until that changes the outcome form below stays closed for this firm.';

export type PhoneDialMode = Readonly<{ label: string; reason: string | null; card: string }>;
export type PhoneDialState = PhoneSetupStatus['state'] | 'unreadable';

export const PHONE_DIAL_MODES: Readonly<Record<PhoneDialState, PhoneDialMode>> = Object.freeze({
  configured: Object.freeze({
    label: 'Available on this Mac',
    reason: null,
    // Names the control that actually exists today. D6 prefers "Call with Phone.app" for it, but the
    // button lives in CompanyPhoneCall.tsx, so renaming it and this line together is the coordinator's.
    card: 'Callie can dial from this Mac. "Begin phone handoff" below is the way to call, one handoff per call step; the number is here either way.',
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
