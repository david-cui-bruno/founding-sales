import { SENDING_STOP_LINE, TEMPLATE_VARIABLE_NAMES } from '@fss/contracts';
import { OFFLINE_BANNER, OFFLINE_SENTENCE, readErrorSentence } from './readError.ts';
import type {
  DraftStep,
  SequenceReadSlice,
  SequenceState,
  SequenceStep,
  SequenceVersion,
  StepChannel,
  TemplateDraft,
  TemplateVersion,
} from './sequenceContract.ts';

/**
 * The sequence editor's view model (specification 11.1, 4.3, 14.2).
 *
 * Pure: a state in, a rendering description out. Every "can this be done" is answered
 * here once and read by the page, so a control that is shown and a control that works
 * cannot disagree — and so the rules can be tested without a browser.
 *
 * Two of the answers are the ones worth reading carefully.
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
 * LinkedIn went on 25 September 2026, and migration 0019 took its stored steps with it:
 * "no step goes out as channel `removed`" (`apps/api/src/routes/sequences.ts`). The wire
 * contract keeps the variant for desktop 1.0.11, so the type still admits one and the
 * two places below name it in a line; the greyed row, its label, the publish refusal and
 * the "saving leaves this step out" hint went in 1.0.13, because nothing can produce one.
 */

export type PublishRefusal =
  | 'version_has_no_steps'
  | 'ordinals_not_contiguous'
  | 'email_step_needs_approved_template'
  | 'not_a_draft'
  | 'admin_only'
  | 'upgrade_required';

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
  enrollments: 'Callie could not read who is enrolled.',
});

/**
 * Who is working through the sequence on screen (11.2; wave 2, S4.1).
 *
 * One row per version that anybody is in, because an enrollment's own fields are ids —
 * a contact id is not a name, and a raw UUID on screen is a bug report a person cannot
 * file (D6). A count per version is what the person asking "is this sequence running?"
 * wants, and it never names anybody.
 */
export interface EnrollmentPanel {
  readonly summary: string;
  readonly rows: readonly { readonly sequenceVersionId: string; readonly line: string }[];
}

export interface SequenceScreen {
  readonly banner: string | null;
  /** The slices whose read failed, in the order the window draws them. */
  readonly unread: readonly SequenceUnreadLine[];
  readonly sequences: readonly { readonly id: string; readonly name: string; readonly selected: boolean }[];
  readonly versions: readonly VersionPanel[];
  readonly templates: readonly TemplatePanel[];
  /** Who is in flight in the chosen sequence; null before anything was read. */
  readonly enrollments: EnrollmentPanel | null;
  /** Whether the "New sequence" and "New template" forms may be used. */
  readonly canAuthor: boolean;
  readonly notice: string | null;
  /** The last template create's or approval's copy warnings, as sentences (wave 1). */
  readonly warnings: readonly string[];
}

function delayLabel(step: Pick<SequenceStep, 'delay'>): string {
  return step.delay.unit === 'elapsed'
    ? `${String(step.delay.hours)} h after enrollment`
    : `${String(step.delay.days)} business days after enrollment`;
}

function stepDetail(step: SequenceStep): string {
  // The wire type still admits it; migration 0019 means nothing sends it.
  if (step.channel === 'removed') return 'A step this version of Callie does not run';
  if (step.channel === 'email') return 'Template email';
  return step.onNoAnswer === 'retry_call' ? 'Call task (try again on no answer)' : 'Call task (move on if nobody answers)';
}

/**
 * Why a draft cannot be published, or null. Server-shaped, so the message the window
 * shows before the press is the message it would get after.
 */
export function publishRefusalFor(
  version: SequenceVersion,
  templates: readonly TemplateVersion[],
  options: { readonly isAdmin: boolean; readonly mayMutate: boolean },
): PublishRefusal | null {
  if (!options.isAdmin) return 'admin_only';
  if (!options.mayMutate) return 'upgrade_required';
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
  options: { readonly isAdmin: boolean; readonly mayMutate: boolean },
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
    // Edited in place since wave 2 (S3): `saveSteps` changes a published version's steps
    // and the edit reaches its live enrollments, so "Edit as a new draft" is gone and a
    // published version is simply editable. A retired one is not.
    editable: version.state !== 'retired' && options.isAdmin && options.mayMutate,
    canPublish: refusal === null,
    publishRefusal: refusal,
    canRetire: version.state === 'published' && options.isAdmin && options.mayMutate,
    stopConditions: version.stopConditions,
    stopSentence: STOP_SENTENCE,
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
  options: { readonly isAdmin: boolean; readonly mayMutate: boolean },
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
    editable: !approved && !retired && options.isAdmin && options.mayMutate,
    canApprove:
      !approved && !retired && options.isAdmin && options.mayMutate && footerPresent && !unsubscribeMentioned,
    footerPresent,
    unsubscribeMentioned,
  };
}

/** The counts the enrollment panel shows, per version of the chosen sequence. */
function enrollmentPanel(state: SequenceState): EnrollmentPanel | null {
  if (state.selectedSequenceId === null) return null;
  const numberOf = new Map(state.versions.map(version => [version.id, version.version]));
  const mine = state.enrollments.filter(entry => numberOf.has(entry.sequenceVersionId));
  const running = mine.filter(entry => entry.state === 'active').length;
  const rows = [...new Set(mine.map(entry => entry.sequenceVersionId))]
    .sort((left, right) => (numberOf.get(right) ?? 0) - (numberOf.get(left) ?? 0))
    .map(sequenceVersionId => {
      const own = mine.filter(entry => entry.sequenceVersionId === sequenceVersionId);
      const parts = [
        [own.filter(entry => entry.state === 'active').length, 'running'],
        [own.filter(entry => entry.state === 'completed').length, 'finished'],
        [own.filter(entry => entry.state === 'stopped').length, 'stopped'],
      ] as const;
      const said = parts.filter(([count]) => count > 0).map(([count, word]) => `${String(count)} ${word}`);
      return { sequenceVersionId, line: `Version ${String(numberOf.get(sequenceVersionId) ?? 0)} — ${said.join(', ')}` };
    });
  return {
    summary:
      running === 0
        ? 'Nobody is working through this sequence right now.'
        : running === 1
          ? 'One person is working through this sequence.'
          : `${String(running)} people are working through this sequence.`,
    rows,
  };
}

/** The whole screen, from one state. */
export function sequenceScreen(state: SequenceState): SequenceScreen {
  const options = {
    isAdmin: state.isAdmin,
    // Offline is the banner, not a disabled control (wave 1).
    mayMutate: state.mayMutate,
  };
  return {
    banner: state.online ? null : OFFLINE_BANNER,
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
    enrollments: enrollmentPanel(state),
    canAuthor: state.isAdmin && state.mayMutate,
    notice: state.notice === null ? null : sequenceNotice(state.notice),
    warnings: state.warnings.map(templateWarningSentence),
  };
}

/** The empty screen the window renders before its first answer. */
export const EMPTY_SEQUENCE_STATE: SequenceState = Object.freeze({
  online: false,
  mayMutate: false,
  isAdmin: false,
  sequences: [],
  selectedSequenceId: null,
  versions: [],
  templates: [],
  enrollments: [],
  readErrors: { sequences: null, versions: null, templates: null, enrollments: null },
  notice: null,
  warnings: [],
});

// ---------------------------------------------------------------------------
// Lane g88: authoring a sequence (audit G03)
// ---------------------------------------------------------------------------

/**
 * 11.2's terminal conditions, as the sentence the version shows (lane g88, audit
 * G08). A version may not opt out of any of them (`docs/decisions/g8-stop-conditions-are-mandatory.md`),
 * so the sentence is the same for every version; the codes themselves are behind the
 * version's disclosure for anybody who wants them.
 */
export const STOP_SENTENCE =
  'Stops by itself when they reply, a call connects, they opt out or are suppressed, or the deal is won or lost.';

/** The channels the step editor offers. */
export const EDITOR_CHANNELS = ['call_task', 'email'] as const satisfies readonly StepChannel[];

export const CHANNEL_LABELS: Readonly<Record<StepChannel, string>> = Object.freeze({
  call_task: 'Call',
  email: 'Email',
});

export const NO_ANSWER_LABELS: Readonly<Record<'advance' | 'retry_call', string>> = Object.freeze({
  advance: 'Move on if nobody answers',
  retry_call: 'Try the call again',
});

/** A version's steps as the editor holds them, in their order. */
export function draftStepsOf(version: SequenceVersion): DraftStep[] {
  return [...version.steps]
    .sort((left, right) => left.ordinal - right.ordinal)
    .flatMap(step => (step.channel === 'removed' ? [] : [step]))
    .map(step => ({
      channel: step.channel,
      delay: step.delay.unit === 'elapsed' ? { unit: 'elapsed', hours: step.delay.hours } : { unit: 'business_days', days: step.delay.days },
      onNoAnswer: step.onNoAnswer,
      templateVersionId: step.templateVersionId,
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
    { channel: 'call_task', delay: { unit: 'business_days', days: 0 }, onNoAnswer: 'advance', templateVersionId: null },
    { channel: 'email', delay: { unit: 'business_days', days: 2 }, onNoAnswer: null, templateVersionId: template },
    { channel: 'call_task', delay: { unit: 'business_days', days: 4 }, onNoAnswer: 'advance', templateVersionId: null },
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
  }));
}

/** Whether the editor holds something other than what the version has saved. */
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
  return issues;
}

/**
 * What the form suggests and does not insist on (wave 1). More than 89 words used to
 * refuse the approval; it is copy advice, so the server now answers it as a warning and
 * approves, and the form says it under the email and still saves.
 */
export function templateFormWarnings(draft: TemplateDraft): readonly string[] {
  const words = countWords(composeTemplateBody(draft.body, draft.signOff));
  if (draft.body.trim() === '' || draft.signOff.trim() === '' || words <= 89) return [];
  return [`The email is ${String(words)} words with its sign-off. Shorter emails get more replies; 89 or fewer is the suggestion.`];
}

/**
 * The server's copy warnings (`TEMPLATE_WARNING_CODES`), as the sentences the window
 * shows after a create or an approval that went ahead anyway. A code this build does
 * not know is shown as it came.
 */
export const TEMPLATE_WARNING_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
  template_body_too_long: 'The email is longer than 89 words, sign-off included.',
  template_body_multiple_urls: 'The email has more than one link.',
  template_subject_url: 'The subject contains a link.',
  template_pricing_or_guarantee_language: 'The email mentions prices, percentages or guarantees.',
});

export function templateWarningSentence(code: string): string {
  return TEMPLATE_WARNING_SENTENCES[code] ?? code;
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
  template_sign_off_repeats_stop_line: 'The sign-off repeats the stop line; the footer adds that line itself.',
  template_required_sentence_missing: 'A sentence this workspace requires is missing.',
  template_pricing_or_guarantee_language: 'The email mentions prices, percentages or guarantees.',
  template_unknown_variable: 'The email names a variable Callie cannot fill.',
});

// ---------------------------------------------------------------------------
// Lane g88: the notices, as sentences
// ---------------------------------------------------------------------------

const SEQUENCE_NOTICES: Readonly<Record<string, string>> = Object.freeze({
  sequence_created: 'Sequence created, with an empty version to fill in.',
  steps_saved: 'Saved.',
  template_saved: 'Template saved and approved.',
  published: 'Published. It can be used for new enrolments now.',
  retired: 'Retired. Nobody new can be enrolled in this version.',
  admin_only: 'Only an administrator can change sequences and templates.',
  invalid_input: 'Callie could not save that. Check the steps and try again.',
  sequence_unknown: 'That sequence is no longer here.',
  version_unknown: 'That version is no longer here.',
  version_not_published: 'Only a published version can be used or retired.',
  version_retired: 'That version is retired. Start a new one instead.',
  version_has_no_steps: 'Add at least one step before publishing.',
  step_in_use: 'A step that has already run cannot change its channel or be removed. Add a step instead.',
  template_unknown: 'An email step names a template that is no longer here.',
  template_retired: 'An email step names a retired template.',
  template_unapproved: 'An email step names a template that is not approved yet.',
  offline: OFFLINE_SENTENCE,
  malformed_body: 'Callie could not send that. Check the fields and try again.',
});

/**
 * One notice as a sentence. A refused save-and-approve arrives as `template_unapproved:`
 * and the issues (`apps/api/src/routes/templates.ts`), and every issue is named, because
 * an author fixing one rule at a time is a worse day than one fixing four at once. A code
 * with no sentence is shown as it is.
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

export { delayLabel };
