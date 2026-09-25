import { SENDING_STOP_LINE } from '@fss/contracts';
import { readErrorSentence } from './readError.ts';
import type {
  Enrollment,
  LinkedInCard,
  SequenceReadSlice,
  SequenceState,
  SequenceStep,
  SequenceVersion,
  TemplateVersion,
} from './sequenceContract.ts';

/**
 * The sequence editor's view model (specification 11.1, 11.3, 4.3, 14.2).
 *
 * Pure: a state in, a rendering description out. Every "can this be done" is answered
 * here once and read by the page, so a control that is shown and a control that works
 * cannot disagree — and so the rules can be tested without a browser.
 *
 * Four of the answers are the ones worth reading carefully.
 *
 * **Publishing is refused for a reason the window can name.** A draft with no steps,
 * a gap in the ordinals, or an email step on an unapproved template: the server
 * refuses all three, and so does this, with the same words, so the button is disabled
 * before it is pressed rather than after.
 *
 * **An approved template shows its digest and has no edit control.** 11.1 binds an
 * approval to bytes. The window that let somebody type into an approved body would be
 * a window whose save always failed, because the trigger refuses it.
 *
 * **The undo deadline is the server's.** `remainingUndoMilliseconds` compares
 * `undoUntil` with `state.asOf` — the instant the server reported — and never with
 * the Mac's clock. Appendix G 9 is a race at 9:59 and 10:00 *database* time.
 *
 * **"They replied" and "No engagement" outlive the handoff.** 11.3 keeps both
 * available "for the enrollment's life", so they are enabled whenever the enrollment
 * is live, handed off or not.
 */

export type PublishRefusal =
  | 'version_has_no_steps'
  | 'ordinals_not_contiguous'
  | 'email_step_needs_approved_template'
  | 'not_a_draft'
  | 'admin_only'
  | 'offline';

export interface StepRow {
  readonly ordinal: number;
  readonly channel: SequenceStep['channel'];
  readonly delayLabel: string;
  readonly detail: string;
  /** Set when an email step names a template that cannot be published on. */
  readonly problem: string | null;
}

export interface VersionPanel {
  readonly id: string;
  readonly version: number;
  readonly state: SequenceVersion['state'];
  readonly heading: string;
  readonly steps: readonly StepRow[];
  readonly editable: boolean;
  readonly canPublish: boolean;
  readonly publishRefusal: PublishRefusal | null;
  readonly canRetire: boolean;
  readonly stopConditions: readonly SequenceVersion['stopConditions'][number][];
}

export interface TemplatePanel {
  readonly id: string;
  readonly label: string;
  readonly subject: string;
  readonly body: string;
  readonly contentHash: string;
  readonly footer: string;
  readonly approved: boolean;
  readonly retired: boolean;
  readonly editable: boolean;
  readonly canApprove: boolean;
  /** The footer block the body must end with, and whether it does (12.6). */
  readonly footerPresent: boolean;
  readonly unsubscribeMentioned: boolean;
}

export interface LinkedInPanel {
  readonly stepExecutionId: string;
  readonly enrollmentId: string;
  readonly heading: string;
  readonly message: string;
  readonly linkedInUrl: string | null;
  readonly canOpenAndCopy: boolean;
  readonly canUndo: boolean;
  readonly remainingUndoMilliseconds: number;
  /** 11.3: never "sent". */
  readonly statusLabel: string;
  readonly canRecordResult: boolean;
}

export interface HoldReviewRow {
  readonly enrollmentId: string;
  readonly heldForDays: number;
  readonly canResume: boolean;
  readonly explanation: string;
}

/**
 * A slice the window could not read (lane g78, D06): one grey line where the slice
 * would be, and Retry.
 *
 * Until g78 a failed read was an empty list, so "this workspace has no sequences" and
 * "Callie could not ask" looked the same — which is how a parse failure on every
 * populated version went unseen. The slice stays empty (nothing stale is shown as
 * current), and the line says which read failed and why.
 */
export interface SequenceUnreadLine {
  readonly slice: SequenceReadSlice;
  readonly line: string;
}

/** Each line's first sentence, fixed so a test and a person can both find it. */
export const SEQUENCE_UNREAD: Readonly<Record<SequenceReadSlice, string>> = Object.freeze({
  sequences: 'Callie could not read the sequences.',
  versions: 'Callie could not read this sequence’s versions.',
  templates: 'Callie could not read the templates.',
  enrollments: 'Callie could not read the enrollments.',
});

export interface SequenceScreen {
  readonly banner: string | null;
  /** The slices whose read failed, in the order the window draws them. */
  readonly unread: readonly SequenceUnreadLine[];
  readonly sequences: readonly { readonly id: string; readonly name: string; readonly selected: boolean }[];
  readonly versions: readonly VersionPanel[];
  readonly templates: readonly TemplatePanel[];
  readonly linkedIn: LinkedInPanel | null;
  readonly holdReview: readonly HoldReviewRow[];
  readonly notice: string | null;
}

const DAY_MILLISECONDS = 86_400_000;

function delayLabel(step: SequenceStep): string {
  return step.delay.unit === 'elapsed'
    ? `${String(step.delay.hours)} h after enrollment`
    : `${String(step.delay.days)} business days after enrollment`;
}

function stepDetail(step: SequenceStep): string {
  if (step.channel === 'email') return 'Template email';
  if (step.channel === 'call_task') return `Call task (${step.onNoAnswer ?? 'advance'} on no answer)`;
  return 'LinkedIn task, opened and copied by hand';
}

/**
 * Why a draft cannot be published, or null. Server-shaped, so the message the window
 * shows before the press is the message it would get after.
 */
export function publishRefusalFor(
  version: SequenceVersion,
  templates: readonly TemplateVersion[],
  options: { readonly isAdmin: boolean; readonly online: boolean },
): PublishRefusal | null {
  if (!options.isAdmin) return 'admin_only';
  if (!options.online) return 'offline';
  if (version.state !== 'draft') return 'not_a_draft';
  if (version.steps.length === 0) return 'version_has_no_steps';
  const ordinals = [...version.steps].map(step => step.ordinal).sort((left, right) => left - right);
  if (!ordinals.every((ordinal, index) => ordinal === index + 1)) return 'ordinals_not_contiguous';
  for (const step of version.steps) {
    if (step.templateVersionId === null) continue;
    const template = templates.find(candidate => candidate.id === step.templateVersionId);
    if (template === undefined || template.approvedAt === null || template.retiredAt !== null) {
      return 'email_step_needs_approved_template';
    }
  }
  return null;
}

function versionPanel(
  version: SequenceVersion,
  templates: readonly TemplateVersion[],
  options: { readonly isAdmin: boolean; readonly online: boolean },
): VersionPanel {
  const refusal = publishRefusalFor(version, templates, options);
  const steps = [...version.steps]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map(step => {
      const template =
        step.templateVersionId === null
          ? null
          : (templates.find(candidate => candidate.id === step.templateVersionId) ?? null);
      const problem =
        step.channel !== 'email'
          ? null
          : template === null
            ? 'That template version is not in this workspace.'
            : template.retiredAt !== null
              ? 'That template version is retired.'
              : template.approvedAt === null
                ? 'That template version is not approved yet.'
                : null;
      return {
        ordinal: step.ordinal,
        channel: step.channel,
        delayLabel: delayLabel(step),
        detail: stepDetail(step),
        problem,
      };
    });

  return {
    id: version.id,
    version: version.version,
    state: version.state,
    heading: `Version ${String(version.version)} — ${version.state}`,
    steps,
    // 11.1: a published version and its steps are immutable by trigger. A window
    // that offered an edit would be offering a save that cannot succeed.
    editable: version.state === 'draft' && options.isAdmin && options.online,
    canPublish: refusal === null,
    publishRefusal: refusal,
    canRetire: version.state === 'published' && options.isAdmin && options.online,
    stopConditions: version.stopConditions,
  };
}

/**
 * The block the body must end with (12.6): the sign-off, then the stop line. It
 * carried a postal address between the two until David's 22 September decision; see
 * `docs/decisions/g20-automated-email-carries-no-postal-address.md`. The stop line is
 * `@fss/contracts`' constant, which is the same bytes the server's approval rule
 * checks for, so the panel cannot drift from the rule it is describing.
 */
const FOOTER_OF = (template: TemplateVersion): string => `${template.footerSignOff}\n${SENDING_STOP_LINE}`;

function templatePanel(
  template: TemplateVersion,
  options: { readonly isAdmin: boolean; readonly online: boolean },
): TemplatePanel {
  const approved = template.approvedAt !== null;
  const retired = template.retiredAt !== null;
  const footerPresent = template.body.includes(FOOTER_OF(template));
  const unsubscribeMentioned = /unsubscribe/iu.test(`${template.subject}\n${template.body}`);
  return {
    id: template.id,
    label: `${template.name} v${String(template.version)}`,
    subject: template.subject,
    body: template.body,
    contentHash: template.contentHash,
    footer: FOOTER_OF(template),
    approved,
    retired,
    editable: !approved && !retired && options.isAdmin && options.online,
    canApprove:
      !approved && !retired && options.isAdmin && options.online && footerPresent && !unsubscribeMentioned,
    footerPresent,
    unsubscribeMentioned,
  };
}

/** How long the undo has left, against the server's clock. Never negative. */
export function remainingUndoMilliseconds(card: LinkedInCard, asOf: string | null): number {
  if (card.undoUntil === null || asOf === null) return 0;
  const remaining = Date.parse(card.undoUntil) - Date.parse(asOf);
  return Number.isFinite(remaining) && remaining > 0 ? remaining : 0;
}

function linkedInPanel(
  card: LinkedInCard,
  state: SequenceState,
): LinkedInPanel {
  const remaining = remainingUndoMilliseconds(card, state.asOf);
  return {
    stepExecutionId: card.stepExecutionId,
    enrollmentId: card.enrollmentId,
    heading: card.contactName === null ? 'LinkedIn task' : `LinkedIn task — ${card.contactName}`,
    message: card.message,
    linkedInUrl: card.linkedInUrl,
    canOpenAndCopy: !card.handedOff && state.mayMutate && card.linkedInUrl !== null,
    canUndo: card.handedOff && remaining > 0 && state.mayMutate,
    remainingUndoMilliseconds: remaining,
    // 11.3: "FSS never claims the message was sent."
    statusLabel: card.handedOff ? 'Handed off — FSS does not know whether it was sent' : 'Not sent yet',
    // Both buttons live as long as the enrollment does.
    canRecordResult: state.mayMutate,
  };
}

function holdReviewRow(enrollment: Enrollment, mayMutate: boolean): HoldReviewRow {
  const days = Math.round((enrollment.reviewUnionMilliseconds ?? 0) / DAY_MILLISECONDS);
  return {
    enrollmentId: enrollment.id,
    heldForDays: days,
    canResume: mayMutate,
    explanation: `Held for about ${String(days)} days in total. Review the remaining steps before resuming; every resume performs a fresh eligibility check.`,
  };
}

/** The whole screen, from one state. */
export function sequenceScreen(state: SequenceState): SequenceScreen {
  const options = { isAdmin: state.isAdmin, online: state.online && state.mayMutate };
  return {
    banner: state.online
      ? null
      : 'Offline. Sequences are shown as they were; nothing can be published, approved or enrolled.',
    unread: (['sequences', 'versions', 'templates', 'enrollments'] as const).flatMap(slice => {
      const code = state.readErrors[slice];
      return code === null ? [] : [{ slice, line: `${SEQUENCE_UNREAD[slice]} ${readErrorSentence(code)}` }];
    }),
    sequences: state.sequences.map(sequence => ({
      id: sequence.id,
      name: sequence.name,
      selected: sequence.id === state.selectedSequenceId,
    })),
    versions: [...state.versions]
      .sort((left, right) => right.version - left.version)
      .map(version => versionPanel(version, state.templates, options)),
    templates: state.templates.map(template => templatePanel(template, options)),
    linkedIn: state.linkedInCard === null ? null : linkedInPanel(state.linkedInCard, state),
    holdReview: state.heldEnrollments
      .filter(enrollment => enrollment.state === 'review_required')
      .map(enrollment => holdReviewRow(enrollment, state.mayMutate)),
    notice: state.notice,
  };
}

/** The empty screen the window renders before its first answer. */
export const EMPTY_SEQUENCE_STATE: SequenceState = Object.freeze({
  online: false,
  mayMutate: false,
  isAdmin: false,
  asOf: null,
  sequences: [],
  selectedSequenceId: null,
  versions: [],
  templates: [],
  heldEnrollments: [],
  readErrors: { sequences: null, versions: null, templates: null, enrollments: null },
  linkedInCard: null,
  notice: null,
});
