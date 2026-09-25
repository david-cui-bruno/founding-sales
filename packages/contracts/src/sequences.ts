import { z } from 'zod';
import { ianaTimeZone, instant, sha256Hex, uuid } from './foundationRows.ts';

/**
 * The wire contract of the sequence editor's reads: sequences, versions and their
 * steps, template versions, enrollments and the LinkedIn handoff (specification 11.1,
 * 11.2, 11.3; lane g78).
 *
 * Until lane g78 the Mac kept its own copies of these in
 * `apps/desktop/src/renderer/sequenceContract.ts`, and they had drifted in the way
 * that matters most: the step schema was strict and did not know `sequenceVersionId`,
 * which the API puts on every step, so every populated version failed to parse (D01);
 * the enrollment schema was strict and missed four fields the API always sends, so
 * every populated enrollment list failed too (D02). The unit fixture encoded the same
 * wrong shape (T04), so nothing went red.
 *
 * Now each shape is here once. The routes' own tests run their real answers through
 * `wireDrift` (`./wire.ts`), and the desktop imports these schemas instead of
 * declaring its own. The objects strip rather than refuse an unknown key, for the
 * reason `./wire.ts` gives.
 *
 * The vocabularies are the domain's (`packages/domain/sequences/types.ts`), spelled
 * here because the desktop may not import `@fss/domain` (14.2).
 * `apps/api/test/wireVocabulary.test.ts` compares every one of them with the domain's
 * list, so a value added on one side and not the other is a failing test.
 */

export const STEP_CHANNELS = ['email', 'call_task', 'linkedin_task'] as const;
export type StepChannel = (typeof STEP_CHANNELS)[number];

export const SEQUENCE_VERSION_STATES = ['draft', 'published', 'retired'] as const;
export type SequenceVersionState = (typeof SEQUENCE_VERSION_STATES)[number];

/** 11.2's five terminal conditions. A version may not opt out of any of them. */
export const SEQUENCE_STOP_CONDITIONS = [
  'human_reply',
  'linkedin_reply',
  'engaged_call',
  'opt_out_or_suppression',
  'stage_closed',
] as const;
export type SequenceStopCondition = (typeof SEQUENCE_STOP_CONDITIONS)[number];

export const STEP_NO_ANSWER_ACTIONS = ['advance', 'retry_call'] as const;

export const ENROLLMENT_STATES = ['active', 'review_required', 'completed', 'stopped'] as const;
export type EnrollmentState = (typeof ENROLLMENT_STATES)[number];

export const ENROLLMENT_END_REASONS = [
  'human_reply',
  'linkedin_reply',
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
  'migration_superseded',
] as const;
export type EnrollmentEndReason = (typeof ENROLLMENT_END_REASONS)[number];

export const STEP_COMPLETION_SOURCES = ['open_and_copy', 'call_log', 'send', 'admin', 'system'] as const;

export const STEP_RESULTS = [
  'handed_off',
  'sent',
  'skipped',
  'no_email',
  'voicemail_left',
  'no_answer',
  'busy',
  'connected',
  'not_applicable',
] as const;

/**
 * `template_versions.personalization_strategy`'s vocabulary (migration 0012). The
 * column is null for every template today and a second CHECK refuses `generated`
 * until 11.1's generator exists; the vocabulary is the column's.
 */
export const PERSONALIZATION_STRATEGIES = ['deterministic', 'generated'] as const;

// ---------------------------------------------------------------------------
// The DTOs
// ---------------------------------------------------------------------------

/** The two delay forms, with migration 0012's bounds. */
export const sequenceDelaySchema = z.discriminatedUnion('unit', [
  z.object({ unit: z.literal('elapsed'), hours: z.number().int().min(0).max(8760) }),
  z.object({ unit: z.literal('business_days'), days: z.number().int().min(0).max(365) }),
]);
export type SequenceDelay = z.infer<typeof sequenceDelaySchema>;

/** One step, as `toStep` in `packages/domain/sequences/rows.ts` maps it. */
export const sequenceStepDtoSchema = z.object({
  id: uuid,
  /** On every step, because the step table is keyed by it. D01 was a Mac that forbade it. */
  sequenceVersionId: uuid,
  ordinal: z.number().int().min(1),
  channel: z.enum(STEP_CHANNELS),
  delay: sequenceDelaySchema,
  onNoAnswer: z.enum(STEP_NO_ANSWER_ACTIONS).nullable(),
  templateVersionId: uuid.nullable(),
  linkedInMessage: z.string().min(1).max(1200).nullable(),
});
export type SequenceStepDto = z.infer<typeof sequenceStepDtoSchema>;

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
 * One enrollment, as `toEnrollment` maps it. The four fields a Mac once refused (D02)
 * are the ones that make an enrollment explainable: the opportunity it serves, the
 * salesperson it belongs to, and the zone and holiday calendar frozen onto every due
 * instant it will ever have.
 */
export const enrollmentDtoSchema = z.object({
  id: uuid,
  sequenceVersionId: uuid,
  opportunityId: uuid,
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
  reviewUnionMilliseconds: z.number().int().min(0).nullable(),
});
export type EnrollmentDto = z.infer<typeof enrollmentDtoSchema>;

// ---------------------------------------------------------------------------
// The answers
// ---------------------------------------------------------------------------

/** `GET /sequences`. */
export const sequencesResponseSchema = z.object({ sequences: z.array(sequenceSummaryDtoSchema) });
export type SequencesResponse = z.infer<typeof sequencesResponseSchema>;

/** `POST /sequences/versions`: every version of one sequence, newest first, with its steps. */
export const sequenceVersionsResponseSchema = z.object({ versions: z.array(sequenceVersionDtoSchema) });
export type SequenceVersionsResponse = z.infer<typeof sequenceVersionsResponseSchema>;

/** `POST /templates`. */
export const templateVersionsResponseSchema = z.object({ templates: z.array(templateVersionDtoSchema) });
export type TemplateVersionsResponse = z.infer<typeof templateVersionsResponseSchema>;

/**
 * `POST /enrollments`. `asOf` is database time, which the Mac compares the LinkedIn
 * undo deadline against (11.3) — an instant, not merely a string.
 */
export const enrollmentsResponseSchema = z.object({ asOf: instant, enrollments: z.array(enrollmentDtoSchema) });
export type EnrollmentsResponse = z.infer<typeof enrollmentsResponseSchema>;

/**
 * What `/enrollments/linkedin/complete` returns inside the command envelope:
 * `LinkedInHandoff` in `packages/domain/sequences/linkedin.ts`, which is the completed
 * step plus what the Mac copies and opens. `undoUntil` is always an instant — the
 * window is open the moment the handoff is recorded.
 */
export const linkedInHandoffResultSchema = z.object({
  stepExecutionId: uuid,
  completionSource: z.enum(STEP_COMPLETION_SOURCES),
  result: z.enum(STEP_RESULTS),
  successorExecutionId: uuid.nullable(),
  successorNotBefore: instant.nullable(),
  enrollmentCompleted: z.boolean(),
  linkedInUrl: z.string().max(400).nullable(),
  message: z.string().min(1).max(1200),
  undoUntil: instant,
});
export type LinkedInHandoffResult = z.infer<typeof linkedInHandoffResultSchema>;
