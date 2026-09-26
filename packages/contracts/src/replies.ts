import { z } from 'zod';
import { instant, uuid } from './foundationRows.ts';
import { blockedActionKindSchema, holdReasonCodeSchema, holdRecoveryActionSchema } from './reasonCodes.ts';

/**
 * The wire contract of the reply cards and the classifier settings (specification 8.3,
 * 12.4; lane g78).
 *
 * The Mac kept its own copies of these in `apps/desktop/src/renderer/replyContract.ts`
 * and `apps/desktop/src/main/replyBridge.ts`. They matched the routes except in the
 * place that bit: the classifier's effort stopped at `high`, while the server accepts
 * `xhigh` and `max`, so a workspace configured at either read back as "no classifier"
 * (D03). The vocabularies below are the domain's — `CLASSIFIER_EFFORTS` and
 * `CLASSIFIER_MODELS` from `packages/domain/classification/types.ts`, `REPLY_CLASSES`
 * and `REPLY_DISPOSITIONS` from `packages/domain/src/rules/replyClassification.ts`,
 * `REPLY_NEXT_ACTIONS` from `packages/domain/classification/cards.ts` — and
 * `apps/api/test/wireVocabulary.test.ts` compares each with the domain's own list.
 *
 * The objects strip rather than refuse an unknown key; `./wire.ts` says why, and
 * where the strictness went instead.
 */

/** The six dispositions a person may choose (12.4). */
export const REPLY_DISPOSITIONS = [
  'interested',
  'referral_or_wrong_person',
  'follow_up_later',
  'not_interested',
  'opt_out',
  'other',
] as const;
export type ReplyDisposition = (typeof REPLY_DISPOSITIONS)[number];

/** The deterministic layer's classes (8.3). */
export const REPLY_CLASSES = ['human', 'uncertain', 'automated', 'bounce', 'opt_out'] as const;
export type ReplyClass = (typeof REPLY_CLASSES)[number];

export const REPLY_NEXT_ACTIONS = [
  'confirm_disposition',
  'resolve_ambiguity',
  'review_bounce',
  'nothing_to_do',
] as const;
export type ReplyNextAction = (typeof REPLY_NEXT_ACTIONS)[number];

const REPLY_SUGGESTION_SOURCES = ['deterministic', 'model', 'none'] as const;
const REPLY_SIGNAL_LAYERS = ['deterministic', 'model'] as const;

/**
 * What a confirmation actually did, and nothing it did not
 * (`mail_reply_confirmations_consequences_known`, migration 0011).
 */
export const REPLY_CONFIRMATION_CONSEQUENCES = [
  'opportunity_manual',
  'callback_committed',
  'handle_suppressed',
  'firm_suppressed',
  'holds_released',
  'today_item_completed',
] as const;

/** The model ids `classifier_settings_model_known` accepts. */
export const CLASSIFIER_MODELS = ['claude-opus-5', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001'] as const;
export type ClassifierModel = (typeof CLASSIFIER_MODELS)[number];

/** `output_config.effort` as sent. All five; D03 was a Mac that knew three. */
export const CLASSIFIER_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ClassifierEffort = (typeof CLASSIFIER_EFFORTS)[number];

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

const replyHoldDtoSchema = z.object({
  holdId: uuid,
  opportunityId: uuid,
  reasonCode: holdReasonCodeSchema,
  blockedActionKinds: z.array(blockedActionKindSchema),
  recoveryAction: holdRecoveryActionSchema.nullable(),
  recoverable: z.boolean(),
  startedAt: instant,
});
export type ReplyHoldDto = z.infer<typeof replyHoldDtoSchema>;

const replySignalDtoSchema = z.object({
  /** A rule name. Open, because the model layer names its own signals. */
  rule: z.string().min(1),
  /**
   * The rule's own evidence string, never a sentence composed by the window. Unbounded
   * here because nothing bounds it where it is written (`packages/domain/classification/store.ts`).
   */
  evidence: z.string(),
  layer: z.enum(REPLY_SIGNAL_LAYERS),
});
export type ReplySignalDto = z.infer<typeof replySignalDtoSchema>;

const replyCandidateDtoSchema = z.object({
  opportunityId: uuid,
  firmId: uuid,
  /** Empty when the candidate firm could not be read; a firm name is at most 300 characters. */
  firmName: z.string().max(300),
  selected: z.boolean().nullable(),
});
export type ReplyCandidateDto = z.infer<typeof replyCandidateDtoSchema>;

const replyConfirmationDtoSchema = z.object({
  id: uuid,
  messageId: uuid,
  firmId: uuid,
  opportunityId: uuid,
  disposition: z.enum(REPLY_DISPOSITIONS),
  suggestedDisposition: z.enum(REPLY_DISPOSITIONS).nullable(),
  suggestedBy: z.enum(REPLY_SUGGESTION_SOURCES),
  corrected: z.boolean(),
  confirmedByUserId: uuid,
  consequences: z.array(z.enum(REPLY_CONFIRMATION_CONSEQUENCES)),
  callbackId: uuid.nullable(),
  note: z.string().max(2000).nullable(),
  createdAt: instant,
});
export type ReplyConfirmationDto = z.infer<typeof replyConfirmationDtoSchema>;

/**
 * One reply card, as `readReplyCard` in `packages/domain/classification/cards.ts`
 * builds it.
 *
 * `confidence` is a number the card displays and never a gate: 12.4's model layer
 * produces a suggestion, and only a person pressing Confirm turns it into a
 * disposition.
 */
export const replyCardDtoSchema = z.object({
  messageId: uuid,
  receivedAt: instant,
  from: z.string().nullable(),
  subject: z.string().nullable(),
  body: z.object({ text: z.string(), truncated: z.boolean() }).nullable(),
  firmId: uuid,
  firmName: z.string().min(1).max(300),
  opportunityId: uuid,
  contactId: uuid.nullable(),
  contactName: z.string().max(200).nullable(),
  contactTitle: z.string().max(200).nullable(),
  impact: z.object({
    controlMode: z.enum(['automated', 'manual']),
    holds: z.array(replyHoldDtoSchema),
    ambiguous: z.boolean(),
    candidates: z.array(replyCandidateDtoSchema),
    contactsAtFirm: z.number().int().min(0),
  }),
  deterministicClass: z.enum(REPLY_CLASSES),
  signals: z.array(replySignalDtoSchema),
  proposedDisposition: z.enum(REPLY_DISPOSITIONS).nullable(),
  proposedBy: z.enum(REPLY_SUGGESTION_SOURCES),
  confidence: z.number().min(0).max(1).nullable(),
  supportingExcerpt: z.string().max(500).nullable(),
  /**
   * What the model read as a time, in the words of the message. Not an instant: 12.4
   * forbids the model committing a callback, so this is a prefill for a field a person
   * fills in. The bounds are the model's answer schema's
   * (`packages/domain/classification/schema.ts`): the Mac's copy said 32 characters
   * for text the model may write 120 of, which would have hidden the whole card.
   */
  callbackProposal: z.object({ localDateTime: z.string().max(120), timeZone: z.string().max(64).nullable() }).nullable(),
  /** The model that produced the stored suggestion. Open: an old row may name a retired model. */
  modelName: z.string().max(64).nullable(),
  promptVersion: z.string().max(64).nullable(),
  requiresConfirmation: z.boolean(),
  confirmation: replyConfirmationDtoSchema.nullable(),
  nextAction: z.enum(REPLY_NEXT_ACTIONS),
  visibility: z.enum(['assigned_or_admin', 'any_active_member']),
});
export type ReplyCardDto = z.infer<typeof replyCardDtoSchema>;

// ---------------------------------------------------------------------------
// The answers
// ---------------------------------------------------------------------------

/** `POST /replies`: today's reply lane. `POST /replies/card` answers one `replyCardDtoSchema`. */
export const replyListResponseSchema = z.object({
  businessDate: z.iso.date(),
  cards: z.array(replyCardDtoSchema),
});

/** `POST /replies/settings`: `ClassifierSettings` in `packages/domain/classification/types.ts`. */
export const classifierSettingsResponseSchema = z.object({
  enabled: z.boolean(),
  modelName: z.enum(CLASSIFIER_MODELS),
  effort: z.enum(CLASSIFIER_EFFORTS),
  maxOutputTokens: z.number().int().min(1),
  dailyCallCap: z.number().int().min(0),
  updatedByUserId: uuid.nullable(),
  updatedAt: instant.nullable(),
});
export type ClassifierSettingsResponse = z.infer<typeof classifierSettingsResponseSchema>;

/** What `/replies/confirm` returns inside the command envelope. */
export const confirmReplyResultSchema = z.object({
  confirmation: replyConfirmationDtoSchema,
  /** 9.1: a suggestion, and it stays one. Closing is a separate, deliberate command. */
  suggestsLost: z.boolean(),
  releasedHoldIds: z.array(uuid),
});
export type ConfirmReplyResult = z.infer<typeof confirmReplyResultSchema>;
