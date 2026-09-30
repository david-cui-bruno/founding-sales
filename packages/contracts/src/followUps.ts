import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { instant, uuid } from './foundationRows.ts';

/**
 * Evidenced follow-up permissions, and the origin an enrollment carries
 * (migration 0025; David, 29 September 2026).
 *
 * > "Record the enrollment origin alongside the supporting event, recipient, permitted
 * > follow-up, and timing. The origin label alone must not authorize sending."
 *
 * The vocabularies live here because the desktop may not import `@fss/domain` (14.2),
 * and the domain imports them from here. Every one of them repeats a CHECK in
 * `0025_follow_up_permissions.sql`; the pair is compared by
 * `packages/domain/test/db/followUpVocabulary.test.ts`, so neither can drift.
 */

/**
 * Which recorded event granted the permission.
 *
 * `conversation` is a call whose outcome was `interested`; `request` is an inbound
 * e-mail or a confirmed reply; `booking` is a confirmed meeting (reserved — no booking
 * table exists yet); `agreed_sequence` is a follow-up programme the person agreed to.
 */
export const FOLLOW_UP_PERMISSION_KINDS = ['conversation', 'request', 'booking', 'agreed_sequence'] as const;
export const followUpPermissionKindSchema = z.enum(FOLLOW_UP_PERMISSION_KINDS);
export type FollowUpPermissionKind = (typeof FOLLOW_UP_PERMISSION_KINDS)[number];

/**
 * What the permission permits — David's four sentences, as a closed set:
 *
 *   * `single_email` — "Email me an overview" permits **that** e-mail. One step, once;
 *     the dispatch claim consumes it.
 *   * `contextual_reply` — an inbound question permits a contextual reply. One reply
 *     step, and a sequence of more than one step is refused at enrollment.
 *   * `booking_communications` — a booking permits relevant booking communications.
 *     **Reserved**: `followUpPermissionSource` refuses it until a booking table exists
 *     and the evidence can be re-read.
 *   * `agreed_sequence` — an agreed follow-up sequence runs within its agreed scope: the
 *     named `sequence_id`, and no other.
 */
export const FOLLOW_UP_PERMISSION_SCOPES = [
  'single_email',
  'contextual_reply',
  'booking_communications',
  'agreed_sequence',
] as const;
export const followUpPermissionScopeSchema = z.enum(FOLLOW_UP_PERMISSION_SCOPES);
export type FollowUpPermissionScope = (typeof FOLLOW_UP_PERMISSION_SCOPES)[number];

/**
 * How long each scope's permission lasts by default, in days.
 *
 * Timing is part of the permission (David: "and timing"), so `expires_at` is NOT NULL in
 * the table and these are the numbers the granting flows use. Fourteen days is the
 * founder's own answer to "how long is an overview still the overview they asked for";
 * `agreed_sequence` has no constant, because its length is its own sequence's — the
 * permission expires when the last step of the agreed sequence would have been due
 * (`agreedSequenceExpiry`, `packages/domain/sequences/followUpPermissions.ts`).
 */
export const FOLLOW_UP_PERMISSION_WINDOW_DAYS: Readonly<Record<FollowUpPermissionScope, number | null>> =
  Object.freeze({
    single_email: 14,
    contextual_reply: 14,
    booking_communications: 30,
    agreed_sequence: null,
  });

/**
 * What an enrollment was created for (`sequence_enrollments.origin_kind`).
 *
 * `cold_legacy` is the column's DEFAULT and therefore the whole of the pre-0025
 * population: excluded from automatic sending for ever, never revived. No command
 * writes it; `enrollContact` writes one of the other two, explicitly.
 */
export const ENROLLMENT_ORIGIN_KINDS = ['cold_legacy', 'prospecting', 'follow_up'] as const;
export const enrollmentOriginKindSchema = z.enum(ENROLLMENT_ORIGIN_KINDS);
export type EnrollmentOriginKind = (typeof ENROLLMENT_ORIGIN_KINDS)[number];

/** The two origins a command may ask for. `cold_legacy` is history, not a choice. */
export const ENROLLABLE_ORIGIN_KINDS = ['prospecting', 'follow_up'] as const;
export const enrollableOriginKindSchema = z.enum(ENROLLABLE_ORIGIN_KINDS);
export type EnrollableOriginKind = (typeof ENROLLABLE_ORIGIN_KINDS)[number];

/**
 * Why a permission's one message was spent (`follow_up_permissions.consumed_reason`,
 * migration 0026). `sent`: the dispatch claim spent it. `fulfilled_by_direct_send`: the
 * salesperson sent the promised e-mail by hand, so the automated one must not follow.
 * Present exactly when `consumedAt` is.
 */
export const FOLLOW_UP_CONSUMED_REASONS = ['sent', 'fulfilled_by_direct_send'] as const;
export const followUpConsumedReasonSchema = z.enum(FOLLOW_UP_CONSUMED_REASONS);
export type FollowUpConsumedReason = (typeof FOLLOW_UP_CONSUMED_REASONS)[number];

/** What a call may agree to. A callback is not one of them (`call_logs_agreement_needs_interest`). */
export const CALL_AGREED_FOLLOW_UPS = ['single_email', 'agreed_sequence'] as const;
export const callAgreedFollowUpSchema = z.enum(CALL_AGREED_FOLLOW_UPS);
export type CallAgreedFollowUp = (typeof CALL_AGREED_FOLLOW_UPS)[number];

/** The rule names the system itself may grant under, in place of a user id. */
export const FOLLOW_UP_GRANT_RULES = ['reply_confirmation', 'call_outcome'] as const;
export type FollowUpGrantRule = (typeof FOLLOW_UP_GRANT_RULES)[number];

/**
 * One permission on the wire. The evidence ids travel because the firm page links to
 * them: a permission a person cannot trace back to the event that granted it is the
 * label David refused to let authorize anything.
 */
export const followUpPermissionDtoSchema = z.object({
  id: uuid,
  firmId: uuid,
  contactId: uuid,
  kind: followUpPermissionKindSchema,
  scope: followUpPermissionScopeSchema,
  callLogId: uuid.nullable(),
  mailMessageId: uuid.nullable(),
  bookingReference: z.string().nullable(),
  /** What the permission is bound to: the bytes, the version, and the one run. */
  templateVersionId: uuid.nullable(),
  sequenceVersionId: uuid.nullable(),
  enrollmentId: uuid.nullable(),
  maxSteps: z.number().int().nullable(),
  grantedAt: instant,
  expiresAt: instant,
  grantedByUserId: uuid.nullable(),
  grantedByRule: z.string().nullable(),
  consumedAt: instant.nullable(),
  revokedAt: instant.nullable(),
  note: z.string().nullable(),
});
export type FollowUpPermissionDto = z.infer<typeof followUpPermissionDtoSchema>;

const command = { commandId: commandIdSchema, clientVersion: semanticVersionSchema };

/**
 * `POST /follow-up-permissions`.
 *
 * **Exactly one** piece of evidence, and the *evidence* decides the kind and the scope:
 * a client that could name them could name `agreed_sequence` over a callback log
 * (GPT-6 review of PR 332, P0-1), so they are not fields. The command re-reads the
 * evidence row — its outcome, its firm, its recipient, and what it records as agreed —
 * and refuses anything it does not support.
 */
export const createFollowUpPermissionCommandSchema = z.strictObject({
  ...command,
  firmId: uuid,
  contactId: uuid,
  callLogId: uuid.optional(),
  mailMessageId: uuid.optional(),
  bookingReference: z.string().min(1).max(200).optional(),
  note: z.string().min(1).max(2000).optional(),
});

/** `POST /follow-up-permissions/:id/revoke` — the id travels in the body, as every command's does. */
export const revokeFollowUpPermissionCommandSchema = z.strictObject({
  ...command,
  permissionId: uuid,
});

/**
 * A person takes a firm over by hand: `POST /opportunities/manual`
 * (`salesperson_command`, the origin no production caller wrote before P1-1).
 */
export const takeOverOpportunityCommandSchema = z.strictObject({
  ...command,
  opportunityId: uuid,
  reason: z.string().min(1).max(2000),
});

/**
 * The user chooses to keep the evidenced follow-up automation running after their own
 * direct Gmail send: `POST /opportunities/keep-following-up` (P1-1). A direct send is a
 * takeover unless this command says otherwise; the opportunity stays manual either way.
 */
export const keepFollowingUpCommandSchema = z.strictObject({
  ...command,
  opportunityId: uuid,
  reason: z.string().min(1).max(2000),
});

/**
 * An administrator classifies an opportunity whose manual mode predates
 * `control_mode_origin` (P1-1). Never a blanket backfill: one opportunity, one
 * administrator, one reason, one audit row — and only where the origin is NULL, so a
 * recorded takeover can never be downgraded to a signal.
 */
export const classifyControlModeOriginCommandSchema = z.strictObject({
  ...command,
  opportunityId: uuid,
  origin: z.enum(['human_reply', 'engaged_call', 'direct_send', 'salesperson_command']),
  reason: z.string().min(1).max(2000),
});

/** `GET /firms/:id/follow-up-permissions`, as a POST read like the other firm reads. */
export const followUpPermissionsResponseSchema = z.object({
  asOf: instant,
  permissions: z.array(followUpPermissionDtoSchema),
});
export type FollowUpPermissionsResponse = z.infer<typeof followUpPermissionsResponseSchema>;
