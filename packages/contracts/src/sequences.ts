import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { enrollmentOriginKindSchema } from './followUps.ts';
import { ianaTimeZone, instant, sha256Hex, uuid } from './foundationRows.ts';

/**
 * The wire contract of the sequence editor's reads: sequences, versions and their
 * steps, template versions and enrollments (specification 11.1, 11.2).
 *
 * Each shape is here once. The routes' own tests run their real answers through
 * `wireDrift` (`./wire.ts`), and the desktop imports these schemas instead of
 * declaring its own. The objects strip rather than refuse an unknown key, for the
 * reason `./wire.ts` gives.
 *
 * The vocabularies are declared here, once, because the desktop may not import
 * `@fss/domain` (14.2); the domain imports them from here.
 */

export const STEP_CHANNELS = ['email', 'call_task'] as const;
export type StepChannel = (typeof STEP_CHANNELS)[number];

/**
 * The channels removed from the product whose stored steps are still read (lane A2).
 *
 * LinkedIn went on 25 September 2026 and migration 0018 kept `linkedin_task` as the
 * stored marker of a removed channel on a step and an execution, so a version published
 * before then can still carry one. Such
 * a step crosses the wire as channel `removed` with the channel it was — never its
 * message text — and the Mac shows it greyed and uneditable. Nothing may author one:
 * `STEP_CHANNELS` stays the draft vocabulary.
 */
export const REMOVED_STEP_CHANNELS = ['linkedin'] as const;
export type RemovedStepChannel = (typeof REMOVED_STEP_CHANNELS)[number];

const SEQUENCE_VERSION_STATES = ['draft', 'published', 'retired'] as const;
export type SequenceVersionState = (typeof SEQUENCE_VERSION_STATES)[number];

/** 11.2's terminal conditions. A version may not opt out of any of them. */
export const SEQUENCE_STOP_CONDITIONS = [
  'human_reply',
  'engaged_call',
  'opt_out_or_suppression',
  'stage_closed',
] as const;
export type SequenceStopCondition = (typeof SEQUENCE_STOP_CONDITIONS)[number];

export const STEP_NO_ANSWER_ACTIONS = ['advance', 'retry_call'] as const;

/**
 * An enrollment is live (`active`) or over. `review_required` was the fourth state
 * until migration 0021: an older release wrote it for a hold longer than seven days,
 * wave 2 (S4.1) made the scheduler resume such an enrollment on its own, and 0021
 * narrows `sequence_enrollments_state_known` to these three.
 */
const ENROLLMENT_STATES = ['active', 'completed', 'stopped'] as const;
export type EnrollmentState = (typeof ENROLLMENT_STATES)[number];

export const ENROLLMENT_END_REASONS = [
  'human_reply',
  'engaged_call',
  'opt_out',
  'firm_suppressed',
  'stage_won',
  'stage_lost',
  'direct_send',
  'send_skipped',
  'reassignment',
  'sequence_complete',
  'admin_stop',
  /**
   * A live `cold_legacy` enrollment that a later evidenced follow-up superseded
   * (migration 0025; GPT-6 review of PR 332, P1-2). Its own reason rather than
   * `admin_stop`, because no administrator did anything: the prospect asked, and the
   * old cold sequence had to end for the new one to exist. The history stays.
   */
  'superseded_by_follow_up',
  /**
   * An explicit enrollment migration (send-path v2, 30 September 2026): the enrollment
   * was superseded by a new one on another published version of the same sequence,
   * which names it in `migrated_from_enrollment_id` (migration 0026). The database has
   * admitted the value since 0025; the contract gains it here.
   */
  'migration_superseded',
] as const;
export type EnrollmentEndReason = (typeof ENROLLMENT_END_REASONS)[number];

export const STEP_COMPLETION_SOURCES = ['call_log', 'send', 'admin', 'system'] as const;
export type StepCompletionSource = (typeof STEP_COMPLETION_SOURCES)[number];

export const STEP_RESULTS = [
  'sent',
  'skipped',
  'no_email',
  'voicemail_left',
  'no_answer',
  'busy',
  'connected',
  'not_applicable',
] as const;
export type StepResult = (typeof STEP_RESULTS)[number];

/**
 * `template_versions.personalization_strategy`'s vocabulary (migration 0012). The
 * column is null for every template today and a second CHECK refuses `generated`
 * until 11.1's generator exists; the vocabulary is the column's.
 */
const PERSONALIZATION_STRATEGIES = ['deterministic', 'generated'] as const;

// ---------------------------------------------------------------------------
// The DTOs
// ---------------------------------------------------------------------------

/** The two delay forms, with migration 0012's bounds. */
export const sequenceDelaySchema = z.discriminatedUnion('unit', [
  z.object({ unit: z.literal('elapsed'), hours: z.number().int().min(0).max(8760) }),
  z.object({ unit: z.literal('business_days'), days: z.number().int().min(0).max(365) }),
]);
export type SequenceDelay = z.infer<typeof sequenceDelaySchema>;

/** One step of a current channel, as `toStep` in `packages/domain/sequences/rows.ts` maps it. */
const currentSequenceStepDtoSchema = z.object({
  id: uuid,
  /** On every step, because the step table is keyed by it. D01 was a Mac that forbade it. */
  sequenceVersionId: uuid,
  ordinal: z.number().int().min(1),
  channel: z.enum(STEP_CHANNELS),
  delay: sequenceDelaySchema,
  onNoAnswer: z.enum(STEP_NO_ANSWER_ACTIONS).nullable(),
  templateVersionId: uuid.nullable(),
});

/**
 * A stored step of a removed channel, read-only (lane A2): where it sat in the version
 * and what it was, and nothing it carried. `sequenceVersionForDisplay` in
 * `packages/domain/sequences/definitions.ts` maps it.
 */
const removedSequenceStepDtoSchema = z.object({
  id: uuid,
  sequenceVersionId: uuid,
  ordinal: z.number().int().min(1),
  channel: z.literal('removed'),
  removedChannel: z.enum(REMOVED_STEP_CHANNELS),
  delay: sequenceDelaySchema,
  onNoAnswer: z.null(),
  templateVersionId: z.null(),
});

/** One step, current or removed. Before lane A2 a removed one failed the whole versions answer. */
export const sequenceStepDtoSchema = z.discriminatedUnion('channel', [
  currentSequenceStepDtoSchema,
  removedSequenceStepDtoSchema,
]);
export type SequenceStepDto = z.infer<typeof sequenceStepDtoSchema>;
export type CurrentSequenceStepDto = z.infer<typeof currentSequenceStepDtoSchema>;
export type RemovedSequenceStepDto = z.infer<typeof removedSequenceStepDtoSchema>;

export const sequenceVersionDtoSchema = z.object({
  id: uuid,
  sequenceId: uuid,
  version: z.number().int().min(1),
  state: z.enum(SEQUENCE_VERSION_STATES),
  stopConditions: z.array(z.enum(SEQUENCE_STOP_CONDITIONS)),
  publishedAt: instant.nullable(),
  retiredAt: instant.nullable(),
  steps: z.array(sequenceStepDtoSchema),
});
export type SequenceVersionDto = z.infer<typeof sequenceVersionDtoSchema>;

export const sequenceSummaryDtoSchema = z.object({
  id: uuid,
  name: z.string().min(1).max(200),
  description: z.string().max(1000).nullable(),
  archivedAt: instant.nullable(),
});
export type SequenceSummaryDto = z.infer<typeof sequenceSummaryDtoSchema>;

/** One template version, as `toTemplate` in `packages/domain/templates/templates.ts` maps it. */
export const templateVersionDtoSchema = z.object({
  id: uuid,
  templateId: uuid,
  version: z.number().int().min(1),
  name: z.string().min(1).max(200),
  subject: z.string().min(1).max(160),
  body: z.string().min(1).max(4000),
  contentHash: sha256Hex,
  footerSignOff: z.string().min(1).max(300),
  requiredVariables: z.array(z.string().min(1).max(60)),
  approvedAt: instant.nullable(),
  retiredAt: instant.nullable(),
  personalizationStrategy: z.enum(PERSONALIZATION_STRATEGIES).nullable(),
});
export type TemplateVersionDto = z.infer<typeof templateVersionDtoSchema>;

/**
 * The accepted result of `POST /templates/create` and `POST /templates/approve`: the
 * version, and the copy warnings its text raises (`TEMPLATE_WARNING_CODES` in
 * `./templates.ts`). Strings rather than the enum, so a warning added later cannot make
 * an older Mac refuse the answer.
 */
export const templateCommandResultSchema = templateVersionDtoSchema.extend({ warnings: z.array(z.string()) });

/**
 * The accepted result of `POST /templates/update` (edit in place) and of
 * `POST /templates/create` since wave 2 (S3): the version, its copy warnings, and the
 * refusal rules its text does not pass — which is why a save left it unapproved
 * (`approvedAt: null`). A save with `approve: true` is refused instead, as
 * `template_unapproved:<issue>,…`, and writes nothing.
 */
export const templateSaveResultSchema = templateCommandResultSchema.extend({ issues: z.array(z.string()) });

/**
 * One enrollment, as `toEnrollment` maps it. The four fields a Mac once refused (D02)
 * are the ones that make an enrollment explainable: the opportunity it serves, the
 * salesperson it belongs to, and the zone and holiday calendar frozen onto every due
 * instant it will ever have.
 */
export const enrollmentDtoSchema = z.object({
  id: uuid,
  sequenceVersionId: uuid,
  opportunityId: uuid.nullable(),
  outreachPlanId: uuid.nullable().default(null),
  firmId: uuid,
  contactId: uuid,
  assignedUserId: uuid,
  state: z.enum(ENROLLMENT_STATES),
  startedAt: instant,
  endedAt: instant.nullable(),
  endReason: z.enum(ENROLLMENT_END_REASONS).nullable(),
  firmTimeZone: ianaTimeZone,
  /** `sequence_enrollments_calendar_version_shape`, migration 0012. */
  holidayCalendarVersion: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/u),
  /**
   * Always `null` since migration 0021, which made the column null-only along with the
   * `review_required` state it belonged to. The field stays because desktop 1.0.14
   * parses the enrollment row strictly and would throw on its absence.
   */
  reviewUnionMilliseconds: z.null(),
  /**
   * Migration 0025. `cold_legacy` on every enrollment that existed before it, and the
   * fail-closed default for anything that forgets to say. Additive on the wire: these
   * objects strip rather than refuse an unknown key, so an older Mac ignores both.
   */
  originKind: enrollmentOriginKindSchema,
  permissionId: uuid.nullable(),
});
export type EnrollmentDto = z.infer<typeof enrollmentDtoSchema>;

/**
 * `POST /enrollments/migrate` (send-path v2, slice S2): supersede one live enrollment
 * with a new one on another published version of the same sequence, carrying the
 * completed prefix and scheduling only the next remaining ordinal.
 *
 * `permissionId` is the fresh permission a `follow_up` enrollment needs for the target
 * version (an `agreed_sequence` never moves on its original agreement); a prospecting
 * enrollment migrates without one. `changeNote` is the person's reason, audited.
 */
export const enrollmentMigrateCommandSchema = z.strictObject({
  commandId: commandIdSchema,
  clientVersion: semanticVersionSchema,
  enrollmentId: uuid,
  targetSequenceVersionId: uuid,
  permissionId: uuid.optional(),
  changeNote: z.string().trim().min(1).max(2000).optional(),
});
export type EnrollmentMigrateCommand = z.infer<typeof enrollmentMigrateCommandSchema>;

/**
 * The accepted answer to `POST /enrollments/migrate`. `carriedOrdinals` are the
 * completed steps the new enrollment inherits (1..k); `nextOrdinal` is the one step it
 * scheduled (k + 1). `rescheduledTo` is the instant step k + 1 was moved to when its
 * planned instant (the target's delay from the original anchor) had already passed — its
 * delay counted from the migration instead (PR 335 review, P1-6) — and null when the plan
 * was kept or there is no next step. A plain object, so a later field does not break an
 * older Mac.
 */
export const enrollmentMigrateResultSchema = z.object({
  oldEnrollmentId: uuid,
  newEnrollmentId: uuid,
  carriedOrdinals: z.array(z.number().int().min(1)),
  nextOrdinal: z.number().int().min(1),
  rescheduledTo: instant.nullable(),
});
export type EnrollmentMigrateResult = z.infer<typeof enrollmentMigrateResultSchema>;

// ---------------------------------------------------------------------------
// The answers
// ---------------------------------------------------------------------------

/** `GET /sequences`. */
export const sequencesResponseSchema = z.object({ sequences: z.array(sequenceSummaryDtoSchema) });

/** `POST /sequences/versions`: every version of one sequence, newest first, with its steps. */
export const sequenceVersionsResponseSchema = z.object({ versions: z.array(sequenceVersionDtoSchema) });

/** `POST /templates`. */
export const templateVersionsResponseSchema = z.object({ templates: z.array(templateVersionDtoSchema) });

/** `POST /enrollments`. `asOf` is database time — an instant, not merely a string. */
export const enrollmentsResponseSchema = z.object({ asOf: instant, enrollments: z.array(enrollmentDtoSchema) });

// ---------------------------------------------------------------------------
// Step executions
//
// The resume review (audit G06) and its two shapes went with the 1.0.14 minimum (lane
// W3-C2): a long hold resumes on its own since wave 2 (S4.1), so there is nothing for a
// person to confirm and `/enrollments/resume/preview` had no caller.
// ---------------------------------------------------------------------------

export type StepExecutionState = 'pending' | 'held' | 'dispatched' | 'completed' | 'cancelled';

