import { z } from 'zod';
import { holdReasonCodeSchema, instant, uuid } from '@fss/contracts';

/**
 * What the reply window is given, and the four things it may ask for
 * (specification 8.3, 12.4, 14.2).
 *
 * A third contract beside G2's `shared/contract.ts` and G6's `todayContract.ts`, for
 * the reason G6 gave: `DesktopState.today` is the *cacheable* shape, written to disk
 * encrypted for 24 hours (5.3), and a reply card is a message somebody wrote. It
 * carries a body, a subject, a person's name and a quotation from the body, so it
 * must not be able to reach the cache at all — and the way to make that structural
 * rather than remembered is for it to live in a type the cache has never heard of.
 *
 * Nothing here decides anything; every field is a shape the API already produced. The
 * one thing this file does assert is the **authority boundary**, and it asserts it by
 * omission. There is no field on `ReplyCard` a renderer could read to auto-confirm,
 * and `ReplyBridge` has no method that closes an opportunity, records a suppression,
 * releases a hold or resumes automation. 12.4 gives those to a person's confirmation
 * and to the deterministic layer; a window that cannot express them cannot drift into
 * doing them when somebody adds a convenience button.
 */

/**
 * The six dispositions a person may choose (12.4).
 *
 * Declared here rather than imported, because the desktop depends on `@fss/contracts`
 * and not on `@fss/domain` — the same reason `TODAY_LANES` is declared in
 * `todayContract.ts`. The server validates the value with its own enum, so a list
 * that drifted would be a refused command and not a wrong write.
 */
export const REPLY_DISPOSITIONS = [
  'interested',
  'referral_or_wrong_person',
  'follow_up_later',
  'not_interested',
  'opt_out',
  'other',
] as const;
export type ReplyDisposition = (typeof REPLY_DISPOSITIONS)[number];

export const REPLY_NEXT_ACTIONS = [
  'confirm_disposition',
  'resolve_ambiguity',
  'review_bounce',
  'nothing_to_do',
] as const;
export type ReplyNextAction = (typeof REPLY_NEXT_ACTIONS)[number];

export const replyHoldSchema = z.strictObject({
  holdId: uuid,
  opportunityId: uuid,
  reasonCode: holdReasonCodeSchema,
  blockedActionKinds: z.array(z.string().max(64)),
  recoveryAction: z.string().max(64).nullable(),
  recoverable: z.boolean(),
  startedAt: instant,
});
export type ReplyHold = z.infer<typeof replyHoldSchema>;

export const replySignalSchema = z.strictObject({
  rule: z.string().min(1).max(64),
  /** The rule's own evidence string, never a sentence composed by the window. */
  evidence: z.string().max(200),
  layer: z.enum(['deterministic', 'model']),
});
export type ReplySignal = z.infer<typeof replySignalSchema>;

export const replyCandidateSchema = z.strictObject({
  opportunityId: uuid,
  firmId: uuid,
  firmName: z.string().max(200),
  selected: z.boolean().nullable(),
});
export type ReplyCandidate = z.infer<typeof replyCandidateSchema>;

export const replyConfirmationSchema = z.strictObject({
  id: uuid,
  messageId: uuid,
  firmId: uuid,
  opportunityId: uuid,
  disposition: z.enum(REPLY_DISPOSITIONS),
  suggestedDisposition: z.enum(REPLY_DISPOSITIONS).nullable(),
  suggestedBy: z.enum(['deterministic', 'model', 'none']),
  corrected: z.boolean(),
  confirmedByUserId: uuid,
  consequences: z.array(z.string().max(64)),
  callbackId: uuid.nullable(),
  note: z.string().max(2000).nullable(),
  createdAt: instant,
});
export type ReplyConfirmation = z.infer<typeof replyConfirmationSchema>;

/**
 * One reply card, exactly as `/replies/card` returned it.
 *
 * `confidence` is a number the card displays. It is deliberately not a gate: nothing
 * in this window may treat a high one as permission to skip the person. 12.4's model
 * layer produces a *suggestion*, and the only thing that turns a suggestion into a
 * disposition is somebody pressing Confirm.
 */
export const replyCardSchema = z.strictObject({
  messageId: uuid,
  receivedAt: instant,
  from: z.string().max(320).nullable(),
  subject: z.string().max(998).nullable(),
  body: z.strictObject({ text: z.string(), truncated: z.boolean() }).nullable(),
  firmId: uuid,
  firmName: z.string().max(200),
  opportunityId: uuid,
  contactId: uuid.nullable(),
  contactName: z.string().max(200).nullable(),
  contactTitle: z.string().max(200).nullable(),
  impact: z.strictObject({
    controlMode: z.enum(['automated', 'manual']),
    holds: z.array(replyHoldSchema),
    ambiguous: z.boolean(),
    candidates: z.array(replyCandidateSchema),
    contactsAtFirm: z.number().int().min(0),
  }),
  deterministicClass: z.string().max(32),
  signals: z.array(replySignalSchema),
  proposedDisposition: z.enum(REPLY_DISPOSITIONS).nullable(),
  proposedBy: z.enum(['deterministic', 'model', 'none']),
  confidence: z.number().min(0).max(1).nullable(),
  supportingExcerpt: z.string().max(500).nullable(),
  /**
   * What the model read as a time, in the words of the message. Not an instant: 12.4
   * forbids the model committing a callback, so this is a prefill for a field a
   * person fills in, and the window resolves it against the business zone the same
   * way `todayBridge` resolves a `datetime-local`.
   */
  callbackProposal: z
    .strictObject({ localDateTime: z.string().max(32), timeZone: z.string().max(64).nullable() })
    .nullable(),
  modelName: z.string().max(64).nullable(),
  promptVersion: z.string().max(64).nullable(),
  requiresConfirmation: z.boolean(),
  confirmation: replyConfirmationSchema.nullable(),
  nextAction: z.enum(REPLY_NEXT_ACTIONS),
  visibility: z.enum(['assigned_or_admin', 'any_active_member']),
});
export type ReplyCard = z.infer<typeof replyCardSchema>;

export const replyStateSchema = z.strictObject({
  /** Null before the first read, and after a sign-out. */
  businessDate: z.iso.date().nullable(),
  businessTimeZone: z.string().max(64).nullable(),
  cards: z.array(replyCardSchema),
  /** The card the person opened, or null. */
  open: replyCardSchema.nullable(),
  /** Whether the cloud answered the last time we asked. */
  online: z.boolean(),
  /** Whether a mutating command may be attempted at all (4.2: mutations fail closed). */
  mayMutate: z.boolean(),
  /** The model and effort the workspace is configured for, or null before the read. */
  classifier: z
    .strictObject({
      enabled: z.boolean(),
      modelName: z.string().max(64),
      effort: z.enum(['low', 'medium', 'high']),
    })
    .nullable(),
  /** A stable code, never a sentence composed here. */
  notice: z.string().max(80).nullable(),
});
export type ReplyState = z.infer<typeof replyStateSchema>;

/**
 * What a person is sending when they confirm.
 *
 * Every consequential field is theirs. `callback` is a wall-clock time they typed —
 * prefilled from the model's proposal when there was one, and still theirs, because
 * 12.4 will not let the model commit an instant. `firmWideOptOut` is 9.1's question
 * and nothing infers it from the wording of the reply.
 */
export interface ConfirmReplyRequest {
  readonly messageId: string;
  readonly disposition: ReplyDisposition;
  readonly callback: {
    readonly localDate: string;
    readonly localTime: string;
    readonly sourceTimeZone: string;
  } | null;
  readonly firmWideOptOut: boolean;
  readonly note: string;
}

export interface ReplyBridge {
  state(): Promise<ReplyState>;
  refresh(): Promise<ReplyState>;
  open(input: { readonly messageId: string }): Promise<ReplyState>;
  /** Put the open card away. Named for the card and not for the opportunity: 12.4
   * gives closing an opportunity to a person on the Firm page, and this window has
   * no way to ask for it. */
  collapse(): Promise<ReplyState>;
  confirm(input: ConfirmReplyRequest): Promise<ReplyState>;
}

declare global {
  /** The bridge the preload script installs, exactly as G2's `callie` is installed. */
  var callieReplies: ReplyBridge | undefined;
}
