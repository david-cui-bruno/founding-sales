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
export type PhoneDialMode = Readonly<{ label: string; reason: string | null; card: string }>;
export type PhoneDialState = PhoneSetupStatus['state'] | 'unreadable';

export const PHONE_DIAL_MODES: Readonly<Record<PhoneDialState, PhoneDialMode>> = Object.freeze({
  configured: Object.freeze({
    label: 'Available on this Mac',
    reason: null,
    card: 'Callie can dial from this Mac. "Call with Phone.app" below stays the way to call; the number is here either way. One handoff per call step.',
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
