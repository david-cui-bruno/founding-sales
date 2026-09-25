import { SENDING_STOP_LINE, TEMPLATE_VARIABLE_NAMES } from '@fss/contracts';
import { readErrorSentence } from './readError.ts';
import type {
  DraftStep,
  Enrollment,
  LinkedInCard,
  ResumeReview,
  SequenceReadSlice,
  SequenceState,
  SequenceStep,
  SequenceVersion,
  StepChannel,
  TemplateDraft,
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
  /** The stop conditions in one sentence (lane g88); the codes go behind a disclosure. */
  readonly stopSentence: string;
  /** A published version with no draft beside it may be copied into one (lane g88). */
  readonly canStartDraft: boolean;
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
  /** Whether "Review and resume" may be pressed: it opens the review, never resumes. */
  readonly canResume: boolean;
  readonly explanation: string;
  /** True while this row's review is the one open. */
  readonly reviewing: boolean;
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
  /** The open resume review (lane g88), or null. */
  readonly resumeReview: ResumeReviewPanel | null;
  /** Whether the "New sequence" and "New template" forms may be used. */
  readonly canAuthor: boolean;
  readonly notice: string | null;
}

const DAY_MILLISECONDS = 86_400_000;

function delayLabel(step: Pick<SequenceStep, 'delay'>): string {
  return step.delay.unit === 'elapsed'
    ? `${String(step.delay.hours)} h after enrollment`
    : `${String(step.delay.days)} business days after enrollment`;
}

function stepDetail(step: SequenceStep): string {
  if (step.channel === 'email') return 'Template email';
  if (step.channel === 'call_task') {
    return step.onNoAnswer === 'retry_call' ? 'Call task (try again on no answer)' : 'Call task (move on if nobody answers)';
  }
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
  options: { readonly isAdmin: boolean; readonly online: boolean; readonly hasDraft: boolean },
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
    stopSentence: STOP_SENTENCE,
    // At most one draft per sequence (`sequence_versions_one_draft`): with one open, the
    // way to change the plan is to edit that draft.
    canStartDraft: version.state === 'published' && options.isAdmin && options.online && !options.hasDraft,
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

function holdReviewRow(enrollment: Enrollment, state: SequenceState): HoldReviewRow {
  const days = Math.round((enrollment.reviewUnionMilliseconds ?? 0) / DAY_MILLISECONDS);
  return {
    enrollmentId: enrollment.id,
    heldForDays: days,
    canResume: state.online,
    explanation: `Held for about ${String(days)} days in total. Review the remaining steps before resuming; every resume performs a fresh eligibility check.`,
    reviewing: state.resumeReview?.preview.enrollmentId === enrollment.id,
  };
}

/** The whole screen, from one state. */
export function sequenceScreen(state: SequenceState): SequenceScreen {
  const options = {
    isAdmin: state.isAdmin,
    online: state.online && state.mayMutate,
    hasDraft: state.versions.some(version => version.state === 'draft'),
  };
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
      .map(enrollment => holdReviewRow(enrollment, state)),
    resumeReview: state.resumeReview === null ? null : resumeReviewPanel(state.resumeReview, state),
    canAuthor: state.isAdmin && state.online && state.mayMutate,
    notice: state.notice === null ? null : sequenceNotice(state.notice),
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
  resumeReview: null,
  notice: null,
});

// ---------------------------------------------------------------------------
// Lane g88: authoring a sequence (audit G03)
// ---------------------------------------------------------------------------

/**
 * 11.2's five terminal conditions, as the sentence the version shows (lane g88, audit
 * G08). A version may not opt out of any of them (`docs/decisions/g8-stop-conditions-are-mandatory.md`),
 * so the sentence is the same for every version; the codes themselves are behind the
 * version's disclosure for anybody who wants them.
 */
export const STOP_SENTENCE =
  'Stops by itself when they reply, a call connects, they opt out or are suppressed, or the deal is won or lost.';

/** The channels the step editor offers. LinkedIn is not one: David dropped it. */
export const EDITOR_CHANNELS = ['call_task', 'email'] as const satisfies readonly StepChannel[];

export const CHANNEL_LABELS: Readonly<Record<StepChannel, string>> = Object.freeze({
  call_task: 'Call',
  email: 'Email',
  linkedin_task: 'LinkedIn task (no longer offered)',
});

export const NO_ANSWER_LABELS: Readonly<Record<'advance' | 'retry_call', string>> = Object.freeze({
  advance: 'Move on if nobody answers',
  retry_call: 'Try the call again',
});

/** A version's steps as the editor holds them, in their order. */
export function draftStepsOf(version: SequenceVersion): DraftStep[] {
  return [...version.steps]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map(step => ({
      channel: step.channel,
      delay: step.delay.unit === 'elapsed' ? { unit: 'elapsed', hours: step.delay.hours } : { unit: 'business_days', days: step.delay.days },
      onNoAnswer: step.onNoAnswer,
      templateVersionId: step.templateVersionId,
      linkedInMessage: step.linkedInMessage,
    }));
}

/** Days after enrolment a step is due, when it counts in business days. */
function businessDaysOf(step: DraftStep | undefined): number | null {
  return step?.delay.unit === 'business_days' ? step.delay.days : null;
}

/**
 * A new step at the end: two business days after the last one, because delays count from
 * the enrolment (start-anchored, `packages/domain/src/rules/cadence.ts`) and a step added
 * at the same day as the one before it is almost never what was meant. An email starts
 * without a template, which the editor then asks for; a call moves on if nobody answers.
 */
export function newStep(channel: (typeof EDITOR_CHANNELS)[number], steps: readonly DraftStep[]): DraftStep {
  const last = businessDaysOf(steps.at(-1));
  const days = steps.length === 0 ? 0 : Math.min(365, (last ?? 0) + 2);
  return {
    channel,
    delay: { unit: 'business_days', days },
    onNoAnswer: channel === 'call_task' ? 'advance' : null,
    templateVersionId: null,
    linkedInMessage: null,
  };
}

/** The list with one step moved up (-1) or down (+1). Out of range is the list unchanged. */
export function moveStep(steps: readonly DraftStep[], index: number, by: -1 | 1): DraftStep[] {
  const target = index + by;
  if (index < 0 || index >= steps.length || target < 0 || target >= steps.length) return [...steps];
  const next = [...steps];
  const [moved] = next.splice(index, 1);
  if (moved !== undefined) next.splice(target, 0, moved);
  return next;
}

export function removeStep(steps: readonly DraftStep[], index: number): DraftStep[] {
  return steps.filter((_step, position) => position !== index);
}

export function replaceStep(steps: readonly DraftStep[], index: number, step: DraftStep): DraftStep[] {
  return steps.map((existing, position) => (position === index ? step : existing));
}

/** The approved, unretired templates an email step may name, newest first as listed. */
export function usableTemplates(templates: readonly TemplateVersion[]): readonly TemplateVersion[] {
  return templates.filter(template => template.approvedAt !== null && template.retiredAt === null);
}

/**
 * The founder default (lane g88, audit G03): a call the day of enrolment, an email two
 * business days later, and a second call two business days after that. It fills the
 * editor and nothing else — it is a draft until the person saves it, and a saved draft is
 * published only by pressing Publish. The email names the newest approved template if
 * there is one, and otherwise asks for one.
 */
export function suggestedPlan(templates: readonly TemplateVersion[]): DraftStep[] {
  const template = usableTemplates(templates)[0]?.id ?? null;
  return [
    { channel: 'call_task', delay: { unit: 'business_days', days: 0 }, onNoAnswer: 'advance', templateVersionId: null, linkedInMessage: null },
    { channel: 'email', delay: { unit: 'business_days', days: 2 }, onNoAnswer: null, templateVersionId: template, linkedInMessage: null },
    { channel: 'call_task', delay: { unit: 'business_days', days: 4 }, onNoAnswer: 'advance', templateVersionId: null, linkedInMessage: null },
  ];
}

export interface DraftIssue {
  /** The step's place in the list, or null for the draft as a whole. */
  readonly index: number | null;
  readonly text: string;
}

/**
 * What the draft would be refused for if it were saved (`validateSteps` in
 * `packages/domain/sequences/definitions.ts`, and the route's bounds). The server still
 * decides; this is the editor not sending a draft it can already see is incomplete. A
 * template that is not approved yet is not one of them: a draft may name one, and only
 * Publish refuses it.
 */
export function draftIssues(steps: readonly DraftStep[]): readonly DraftIssue[] {
  const issues: DraftIssue[] = [];
  if (steps.length > 50) issues.push({ index: null, text: 'A sequence has at most 50 steps.' });
  steps.forEach((step, index) => {
    const label = `Step ${String(index + 1)}`;
    if (step.channel === 'email' && step.templateVersionId === null) {
      issues.push({ index, text: `${label}: choose the template this email sends.` });
    }
    if (step.channel === 'call_task' && step.onNoAnswer === null) {
      issues.push({ index, text: `${label}: choose what happens when nobody answers.` });
    }
    const amount = step.delay.unit === 'elapsed' ? step.delay.hours : step.delay.days;
    const ceiling = step.delay.unit === 'elapsed' ? 8760 : 365;
    if (!Number.isInteger(amount) || amount < 0 || amount > ceiling) {
      issues.push({
        index,
        text: `${label}: the delay is a whole number from 0 to ${String(ceiling)} ${step.delay.unit === 'elapsed' ? 'hours' : 'business days'}.`,
      });
    }
  });
  return issues;
}

/**
 * The steps as `/sequences/versions/steps` takes them: numbered by their place, each with
 * exactly the field its channel requires and none of the others (the route's step schema
 * is strict, and `validateSteps` refuses a call step with a template).
 */
export function stepsForWire(steps: readonly DraftStep[]): readonly Readonly<Record<string, unknown>>[] {
  return steps.map((step, index) => ({
    ordinal: index + 1,
    channel: step.channel,
    delay: step.delay.unit === 'elapsed' ? { unit: 'elapsed', hours: step.delay.hours } : { unit: 'business_days', days: step.delay.days },
    ...(step.channel === 'call_task' && step.onNoAnswer !== null ? { onNoAnswer: step.onNoAnswer } : {}),
    ...(step.channel === 'email' && step.templateVersionId !== null ? { templateVersionId: step.templateVersionId } : {}),
    ...(step.channel === 'linkedin_task' && step.linkedInMessage !== null ? { linkedInMessage: step.linkedInMessage } : {}),
  }));
}

/** Whether the editor holds something other than what the draft has saved. */
export function draftChanged(version: SequenceVersion, steps: readonly DraftStep[]): boolean {
  return JSON.stringify(draftStepsOf(version)) !== JSON.stringify(steps);
}

// ---------------------------------------------------------------------------
// Lane g88: writing a template
// ---------------------------------------------------------------------------

/** What every automated email ends with (12.6): the sign-off, then the stop line. */
export function templateFooter(signOff: string): string {
  return `${signOff.trim()}\n${SENDING_STOP_LINE}`;
}

/**
 * The body a version stores: what the person typed, a blank line, and the footer. The
 * approval rule requires the body to *end* with the footer (`templateTextIssues`), so it
 * is appended here rather than left for the person to type correctly.
 */
export function composeTemplateBody(body: string, signOff: string): string {
  return `${body.trim()}\n\n${templateFooter(signOff)}`;
}

/** The part of a stored body the person typed: everything before the footer, when it is there. */
export function typedBodyOf(template: Pick<TemplateVersion, 'body' | 'footerSignOff'>): string {
  const footer = templateFooter(template.footerSignOff);
  return template.body.endsWith(footer) ? template.body.slice(0, -footer.length).trimEnd() : template.body;
}

/** The `{name}` placeholders in a subject and body, split into the ones Callie can fill and the rest. */
export function templateVariablesIn(
  subject: string,
  body: string,
): { readonly known: readonly string[]; readonly unknown: readonly string[] } {
  const names = [...`${subject}\n${body}`.matchAll(/\{([^{}]*)\}/gu)].map(match => match[1] ?? '');
  const unique = [...new Set(names)];
  const allowed = new Set<string>(TEMPLATE_VARIABLE_NAMES);
  return { known: unique.filter(name => allowed.has(name)), unknown: unique.filter(name => !allowed.has(name)) };
}

export interface TemplateFormIssue {
  readonly field: 'name' | 'subject' | 'body' | 'signOff';
  readonly text: string;
}

const countWords = (value: string): number => (value.trim().length === 0 ? 0 : value.trim().split(/\s+/u).length);

/**
 * What the form says before it sends (lane g88). The create would refuse the first four
 * and the database the unsubscribe; the approval would refuse the rest, and a version
 * that can never be approved is a version nobody needs. The server still decides both.
 */
export function templateFormIssues(draft: TemplateDraft): readonly TemplateFormIssue[] {
  const issues: TemplateFormIssue[] = [];
  if (draft.name.trim() === '') issues.push({ field: 'name', text: 'Give the template a name.' });
  if (draft.subject.trim() === '') issues.push({ field: 'subject', text: 'Write a subject.' });
  else if (draft.subject.length > 160) issues.push({ field: 'subject', text: 'Keep the subject to 160 characters.' });
  else if (/[\n\r]/u.test(draft.subject)) issues.push({ field: 'subject', text: 'The subject is one line.' });
  if (draft.body.trim() === '') issues.push({ field: 'body', text: 'Write the email.' });
  if (draft.signOff.trim() === '') issues.push({ field: 'signOff', text: 'Add your sign-off, such as your name.' });
  if (/unsubscribe/iu.test(`${draft.subject}\n${draft.body}\n${draft.signOff}`)) {
    issues.push({ field: 'body', text: 'Leave out any unsubscribe link: Callie ends every email with “Reply stop”.' });
  }
  const { unknown } = templateVariablesIn(draft.subject, draft.body);
  if (unknown.length > 0) {
    issues.push({
      field: 'body',
      text: `Callie cannot fill ${unknown.map(name => `{${name}}`).join(', ')}. Use one of ${TEMPLATE_VARIABLE_NAMES.map(name => `{${name}}`).join(', ')}.`,
    });
  }
  const words = countWords(composeTemplateBody(draft.body, draft.signOff));
  if (draft.body.trim() !== '' && draft.signOff.trim() !== '' && words > 89) {
    issues.push({ field: 'body', text: `The email is ${String(words)} words with its sign-off; keep it to 89.` });
  }
  return issues;
}

/** Each reason `decideTemplateApproval` can give, as the sentence the window shows. */
export const TEMPLATE_ISSUE_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
  template_subject_empty: 'The subject is empty.',
  template_subject_too_long: 'The subject is longer than 160 characters.',
  template_subject_not_one_line: 'The subject has to be one line.',
  template_subject_url: 'The subject cannot contain a link.',
  template_body_too_long_in_characters: 'The email is longer than 4,000 characters.',
  template_body_not_plain_text: 'The email contains characters that are not plain text.',
  template_body_markup: 'The email contains markup. Write it as plain text.',
  template_body_too_long: 'The email is longer than 89 words, sign-off included.',
  template_body_multiple_urls: 'The email has more than one link.',
  template_footer_missing: 'The email does not end with the sign-off and the stop line.',
  template_required_sentence_missing: 'A sentence this workspace requires is missing.',
  template_pricing_or_guarantee_language: 'The email mentions prices, percentages or guarantees.',
  template_unknown_variable: 'The email names a variable Callie cannot fill.',
});

// ---------------------------------------------------------------------------
// Lane g88: the notices, as sentences
// ---------------------------------------------------------------------------

const SEQUENCE_NOTICES: Readonly<Record<string, string>> = Object.freeze({
  sequence_created: 'Sequence created, with an empty draft to fill in.',
  draft_created: 'A new draft, copied from the published version.',
  draft_saved: 'Draft saved.',
  template_created: 'Template saved. Approve it before a sequence can be published with it.',
  template_approved: 'Template approved.',
  published: 'Published. It can be used for new enrolments now.',
  retired: 'Retired. Nobody new can be enrolled in this version.',
  resumed: 'Resumed. The remaining steps have the dates you reviewed.',
  resume_still_held: 'Something is still holding this enrollment, so nothing moved.',
  admin_only: 'Only an administrator can change sequences and templates.',
  invalid_input: 'Callie could not save that. Check the steps and try again.',
  sequence_unknown: 'That sequence is no longer here.',
  version_unknown: 'That version is no longer here.',
  version_not_draft: 'Only a draft can be changed. Start a new draft from the published version.',
  version_not_published: 'Only a published version can be used or retired.',
  version_retired: 'That version is retired.',
  version_has_no_steps: 'Add at least one step before publishing.',
  template_unknown: 'An email step names a template that is no longer here.',
  template_retired: 'An email step names a retired template.',
  template_unapproved: 'An email step names a template that is not approved yet.',
  template_already_approved: 'That template is already approved.',
  enrollment_unknown: 'That enrollment is no longer here.',
  enrollment_not_live: 'That enrollment has ended.',
  not_assigned: 'That enrollment belongs to somebody else.',
  offline: 'Callie cannot reach the server.',
  malformed_body: 'Callie could not send that. Check the fields and try again.',
});

/**
 * One notice as a sentence. A refused approval arrives as `template_unapproved:` and the
 * issues (`apps/api/src/routes/templates.ts`), and every issue is named, because an author
 * fixing one rule at a time is a worse day than one fixing four at once. A code with no
 * sentence is shown as it is, which is how the existing LinkedIn notices already read.
 */
export function sequenceNotice(code: string): string {
  if (code.startsWith('template_unapproved:')) {
    const issues = code
      .slice('template_unapproved:'.length)
      .split(',')
      .filter(issue => issue.length > 0)
      .map(issue => TEMPLATE_ISSUE_SENTENCES[issue] ?? issue);
    return `Not approved. ${issues.join(' ')}`.trim();
  }
  return SEQUENCE_NOTICES[code] ?? code;
}

// ---------------------------------------------------------------------------
// Lane g88: the resume review (audit G06)
// ---------------------------------------------------------------------------

export interface ResumeReviewStepRow {
  readonly label: string;
  readonly from: string;
  readonly to: string;
  readonly moved: boolean;
}

export interface ResumeReviewPanel {
  readonly enrollmentId: string;
  readonly heading: string;
  readonly summary: string;
  readonly holdLines: readonly string[];
  readonly steps: readonly ResumeReviewStepRow[];
  /** "Resume with these dates" — the final action, and the only one that resumes. */
  readonly canConfirm: boolean;
  readonly confirmLabel: string;
  readonly zoneLine: string;
}

/** An instant as the firm's own wall clock: "Thu, Sep 24, 9:00 AM". */
export function firmClock(instant: string, zone: string): string {
  const at = new Date(instant);
  if (!Number.isFinite(at.getTime())) return instant;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(at);
  } catch {
    return instant;
  }
}

function daysText(milliseconds: number): string {
  const days = milliseconds / DAY_MILLISECONDS;
  if (days >= 1) {
    const rounded = Math.round(days * 10) / 10;
    return `${String(rounded)} ${rounded === 1 ? 'day' : 'days'}`;
  }
  const hours = Math.round(milliseconds / 3_600_000);
  return `${String(hours)} ${hours === 1 ? 'hour' : 'hours'}`;
}

/**
 * The review, as the window draws it: what held the enrollment, then every remaining step
 * with the date it has now and the date a confirmation gives it, in the firm's zone — the
 * zone every due instant of the enrollment was resolved in. Nothing here computes a date:
 * `proposedDueAt` is the server's, from the function the confirmation runs.
 */
export function resumeReviewPanel(review: ResumeReview, state: SequenceState): ResumeReviewPanel {
  const preview = review.preview;
  const zone = preview.firmTimeZone;
  const stillHeld = preview.kind === 'still_held';
  const summary = stillHeld
    ? 'Something is still holding this enrollment, so resuming now would move nothing. It carries on by itself when the hold clears.'
    : preview.shiftMilliseconds > 0
      ? `Held for ${daysText(preview.unionMilliseconds)} in all. Resuming moves every remaining step ${daysText(preview.shiftMilliseconds)} later, to the dates below, and checks each step again before it runs.`
      : 'Nothing held this enrollment long enough to move its steps. Resuming keeps the dates below and checks each step again before it runs.';
  return {
    enrollmentId: preview.enrollmentId,
    heading: 'Review before resuming',
    summary,
    holdLines: preview.holds.map(
      hold =>
        `${hold.reasonCode.replaceAll('_', ' ')}: ${firmClock(hold.startedAt, zone)} to ${
          hold.releasedAt === null ? 'still open' : firmClock(hold.releasedAt, zone)
        }`,
    ),
    steps: preview.steps.map(step => ({
      label: `Step ${String(step.ordinal)} · ${CHANNEL_LABELS[step.channel]}${step.state === 'held' ? ' (held)' : ''}`,
      from: firmClock(step.dueAt, zone),
      to: firmClock(step.proposedDueAt, zone),
      moved: step.proposedDueAt !== step.dueAt,
    })),
    canConfirm: !stillHeld && state.online && state.mayMutate,
    confirmLabel: 'Resume with these dates',
    zoneLine: `Times are the firm’s (${zone}). An email still waits for its sending window.`,
  };
}

export { delayLabel };
