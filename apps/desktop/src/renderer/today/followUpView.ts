import { dueLabel } from '../homeView.ts';
import { previewBasisOf, type AgreementView, type FollowUpPreviewView, type OutcomeRequest } from '../todayContract.ts';

/**
 * The follow-up choice under an interested call, as pure functions (send-path v2, slice
 * S3).
 *
 * David, 30 September 2026: *"Include no email / one approved email / an agreed approved
 * sequence in the first calling-to-booking milestone. Show the messages and timing and
 * record the prospect's agreement. Starting an agreed sequence should not require an API
 * command."*
 *
 * So there are exactly three answers, and this file is every rule about them the card
 * needs: which command body each one is, whether the form may be sent yet, how the
 * server's preview reads as lines a person can say back on the call, and the sentence the
 * notice adds once the call is recorded. The instants are the server's
 * (`POST /calls/follow-up-preview`); nothing here computes a schedule — it only formats
 * the server's instants in the **firm's** zone, because that is the clock the person on
 * the call lives by.
 */

export const FOLLOW_UP_CHOICES = ['none', 'single_email', 'agreed_sequence'] as const;
export type FollowUpChoice = (typeof FOLLOW_UP_CHOICES)[number];

export const FOLLOW_UP_CHOICE_LABELS: Readonly<Record<FollowUpChoice, string>> = Object.freeze({
  none: 'No follow-up',
  single_email: 'One approved e-mail',
  agreed_sequence: 'An agreed sequence',
});

/** A stored draft value as a choice. Anything unrecognised is "none", the safe answer. */
export function followUpChoiceOf(value: string): FollowUpChoice {
  return (FOLLOW_UP_CHOICES as readonly string[]).includes(value) ? (value as FollowUpChoice) : 'none';
}

/** What the form has picked: the kind, and the template or sequence version chosen. */
export interface FollowUpPick {
  readonly choice: FollowUpChoice;
  readonly templateVersionId: string;
  readonly sequenceVersionId: string;
}

/**
 * The command's `followUpPermission`, or null for "none" or an incomplete pick. An agreed
 * sequence carries the basis of the preview shown — its anchor, the firm's zone and the
 * calendar version — so the server can refuse to start on a schedule nobody heard
 * (review of S3, P1-3); without a shown preview there is no agreement to send.
 */
export function followUpPermissionOf(
  pick: FollowUpPick,
  preview: FollowUpPreviewView | null,
): OutcomeRequest['followUpPermission'] {
  if (pick.choice === 'single_email' && pick.templateVersionId !== '') {
    return { scope: 'single_email', templateVersionId: pick.templateVersionId };
  }
  if (pick.choice === 'agreed_sequence' && pick.sequenceVersionId !== '' && preview !== null) {
    const basis = preview.sequenceVersionId === pick.sequenceVersionId ? previewBasisOf(preview) : null;
    if (basis !== null) return { scope: 'agreed_sequence', sequenceVersionId: pick.sequenceVersionId, previewBasis: basis };
  }
  return null;
}

/** Whether `preview` is the server's answer for exactly this firm, person and version. */
export function previewFor(
  preview: FollowUpPreviewView | null | undefined,
  at: { readonly firmId: string; readonly contactId: string | null; readonly sequenceVersionId: string },
): FollowUpPreviewView | null {
  if (preview === null || preview === undefined || at.contactId === null || at.sequenceVersionId === '') return null;
  return preview.firmId === at.firmId &&
    preview.contactId === at.contactId &&
    preview.sequenceVersionId === at.sequenceVersionId
    ? preview
    : null;
}

/**
 * What stops the follow-up part of the form from being sent, as a sentence, or null.
 *
 * An agreed sequence is recorded only once its preview has been shown: "show the messages
 * and timing" is what makes the agreement an agreement, and a plan the server would not
 * preview is a plan it would not start.
 */
export function followUpProblem(
  pick: FollowUpPick,
  preview: FollowUpPreviewView | null,
  /** The last request for this pick came back with no answer (review of S3, P2-b). */
  failed = false,
): string | null {
  if (pick.choice === 'single_email' && pick.templateVersionId === '') return 'Choose the e-mail they agreed to.';
  if (pick.choice !== 'agreed_sequence') return null;
  if (pick.sequenceVersionId === '') return 'Choose the sequence they agreed to.';
  if (preview === null && failed) return 'Callie could not read what that sequence would send. Try again.';
  if (preview === null) return 'Callie is reading what that sequence would send.';
  if (preview.refusal !== null) return `Callie cannot start that sequence here: ${enrolRefusalSentence(preview.refusal)}.`;
  return null;
}

/** One line of the preview: what is sent or done, and when, in the firm's zone. */
export interface PreviewRow {
  readonly ordinal: number;
  readonly what: string;
  readonly when: string;
}

export function previewRows(preview: FollowUpPreviewView): readonly PreviewRow[] {
  return preview.steps.map(step => ({
    ordinal: step.ordinal,
    what:
      step.channel === 'call_task'
        ? 'A call'
        : `E-mail — ${step.templateName ?? 'an approved template'}${step.subject === null ? '' : `: “${step.subject}”`}`,
    when: firmLocalLabel(step.estimatedAt, preview.firmTimeZone),
  }));
}

/** "Thu 1 Oct, 08:00 EDT": the instant on the firm's own clock, with the zone named. */
export function firmLocalLabel(instant: string, zone: string): string {
  const label = dueLabel(instant, zone === '' ? null : zone, null);
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
      .formatToParts(new Date(Date.parse(instant)))
      .find(part => part.type === 'timeZoneName')?.value;
    return name === undefined ? label : `${label} ${name}`;
  } catch {
    return label;
  }
}

/**
 * Why an agreed sequence did not start, or cannot: the enrolment's refusal codes (and
 * the preview's, which are the same ones), as the end of a sentence.
 */
const ENROL_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  firm_zone_unknown: 'the firm’s time zone is not known yet',
  opportunity_unknown: 'the firm has no open opportunity',
  opportunity_not_open: 'the firm’s opportunity is closed',
  contact_already_enrolled: 'this person is already in a sequence',
  contact_unknown: 'that person is not at this firm any more',
  firm_already_enrolled: 'someone else at this firm is already in a prospecting sequence',
  follow_up_not_permitted: 'the agreement did not permit it',
  version_unknown: 'that sequence is not one of this workspace’s',
  version_not_published: 'that sequence version is not published',
  version_retired: 'that sequence version was retired',
  version_has_no_steps: 'that sequence has no steps',
  step_unknown: 'that sequence has a step Callie no longer runs',
  not_assigned: 'the firm is not assigned to you',
  firm_unknown: 'the firm is not on your list',
  enrollment_failed: 'the enrolment failed',
  stale_preview: 'the dates changed after you previewed them',
  agreement_not_recorded: 'the agreement could not be recorded on the call',
});

export function enrolRefusalSentence(code: string): string {
  return ENROL_REFUSALS[code] ?? code;
}

/**
 * The line the notice adds once the call is recorded: what was agreed, by name, and —
 * for a sequence — whether it started, or why not. Null when nothing was agreed.
 */
export function agreementSentence(agreement: AgreementView | null | undefined): string | null {
  if (agreement === null || agreement === undefined) return null;
  if (agreement.scope === 'single_email') {
    return agreement.granted
      ? `Agreed on the call: one e-mail, “${agreement.name}”.`
      : `Agreed on the call: one e-mail, “${agreement.name}” — but Callie was not given permission to send it.`;
  }
  if (!agreement.granted && agreement.reason === 'stale_preview') {
    // Review of S3, round 2, P1-B: nothing was granted, and the card itself is the way
    // on — the firm page has no preview to read the new dates from.
    return `The call is recorded, but the sequence “${agreement.name}” did not start: its dates changed after you previewed them. Read them the new dates on the card and press Record the agreed dates.`;
  }
  if (!agreement.granted) {
    return `Agreed on the call: the sequence “${agreement.name}” — not started, because Callie was not given permission for it.`;
  }
  if (agreement.started === true) return `Agreed on the call: the sequence “${agreement.name}”. It has started.`;
  const why = agreement.reason === null ? '' : `: ${enrolRefusalSentence(agreement.reason)}`;
  return `Agreed on the call: the sequence “${agreement.name}”. It did not start${why}. Start it from the firm’s page.`;
}
