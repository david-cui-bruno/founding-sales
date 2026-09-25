import {
  SENDING_STOP_LINE,
  type EnrollmentDto,
  type SequenceStepDto,
  type SequenceSummaryDto,
  type SequenceVersionDto,
  type TemplateVersionDto,
} from '@fss/contracts';

/**
 * The sequence editor's reads as the API answers them (lane g78, audit item T04).
 *
 * Every key the routes send, typed as `@fss/contracts`' DTOs so a missing key is a
 * compile error. Until g78 the unit suite's fixtures were built to the desktop's own
 * copy of the schema: steps without `sequenceVersionId`, enrollments without four of
 * their fields — the same wrong shape as the parser, so the suite agreed with itself
 * while every real populated answer failed (D01, D02). `test/release/sequences.check.ts`
 * now holds these to the real routes' answers key for key and type for type.
 *
 * Fictional data only: `example.test` is reserved by RFC 6761.
 */

export const SEQUENCE_IDS = Object.freeze({
  sequence: '44444444-4444-4444-8444-444444444444',
  version: '33333333-3333-4333-8333-333333333333',
  template: '11111111-1111-4111-8111-111111111111',
  templateGroup: '22222222-2222-4222-8222-222222222222',
  enrollment: '88888888-8888-4888-8888-888888888888',
  opportunity: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  firm: '99999999-9999-4999-8999-999999999999',
  contact: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  salesperson: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  stepExecution: '66666666-6666-4666-8666-666666666666',
});

export const FOOTER_SIGN_OFF = 'Sam Example';

export function sequenceSummaryAnswer(overrides: Partial<SequenceSummaryDto> = {}): SequenceSummaryDto {
  return { id: SEQUENCE_IDS.sequence, name: 'Founding outreach', description: null, archivedAt: null, ...overrides };
}

/** `toStep`: `sequenceVersionId` on every step, which is the key 1.0.4 refused. */
export function emailStepAnswer(templateVersionId: string | null, ordinal = 1, overrides: Partial<SequenceStepDto> = {}): SequenceStepDto {
  return {
    id: `55555555-5555-4555-8555-55555555555${String(ordinal)}`,
    sequenceVersionId: SEQUENCE_IDS.version,
    ordinal,
    channel: 'email',
    delay: { unit: 'elapsed', hours: 0 },
    onNoAnswer: null,
    templateVersionId,
    ...overrides,
  };
}

export function callStepAnswer(ordinal = 2, overrides: Partial<SequenceStepDto> = {}): SequenceStepDto {
  return {
    id: `55555555-5555-4555-8555-55555555556${String(ordinal)}`,
    sequenceVersionId: SEQUENCE_IDS.version,
    ordinal,
    channel: 'call_task',
    delay: { unit: 'business_days', days: 2 },
    onNoAnswer: 'advance',
    templateVersionId: null,
    ...overrides,
  };
}

export function sequenceVersionAnswer(
  steps: readonly SequenceStepDto[],
  overrides: Partial<SequenceVersionDto> = {},
): SequenceVersionDto {
  return {
    id: SEQUENCE_IDS.version,
    sequenceId: SEQUENCE_IDS.sequence,
    version: 2,
    state: 'draft',
    stopConditions: ['human_reply', 'engaged_call', 'opt_out_or_suppression', 'stage_closed'],
    publishedAt: null,
    retiredAt: null,
    steps: [...steps],
    ...overrides,
  };
}

export function templateVersionAnswer(overrides: Partial<TemplateVersionDto> = {}): TemplateVersionDto {
  return {
    id: SEQUENCE_IDS.template,
    templateId: SEQUENCE_IDS.templateGroup,
    version: 1,
    name: 'First touch',
    subject: 'A question',
    body: `Hello,\n\n${FOOTER_SIGN_OFF}\n${SENDING_STOP_LINE}`,
    contentHash: 'a'.repeat(64),
    footerSignOff: FOOTER_SIGN_OFF,
    requiredVariables: [],
    approvedAt: '2026-09-01T12:00:00.000Z',
    retiredAt: null,
    // `createTemplateVersion` records every template as deterministic until 11.1's generator exists.
    personalizationStrategy: 'deterministic',
    ...overrides,
  };
}

/** `toEnrollment`: all thirteen fields, including the four 1.0.4 refused. */
export function enrollmentAnswer(overrides: Partial<EnrollmentDto> = {}): EnrollmentDto {
  return {
    id: SEQUENCE_IDS.enrollment,
    sequenceVersionId: SEQUENCE_IDS.version,
    opportunityId: SEQUENCE_IDS.opportunity,
    firmId: SEQUENCE_IDS.firm,
    contactId: SEQUENCE_IDS.contact,
    assignedUserId: SEQUENCE_IDS.salesperson,
    state: 'active',
    startedAt: '2026-09-01T12:00:00.000Z',
    endedAt: null,
    endReason: null,
    firmTimeZone: 'America/New_York',
    holidayCalendarVersion: 'none',
    reviewUnionMilliseconds: null,
    ...overrides,
  };
}
