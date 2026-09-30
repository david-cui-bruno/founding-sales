import { z } from 'zod';
import {
  CLASSIFIER_EFFORTS,
  REPLY_DISPOSITIONS,
  REPLY_NEXT_ACTIONS,
  instant,
  replyCardDtoSchema,
  uuid,
  type ReplyCandidateDto,
  type ReplyCardDto,
  type ReplyDisposition,
} from '@fss/contracts';

/**
 * What the reply window is given, and the things it may ask for
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

/*
 * The wire shapes are `@fss/contracts`' (`packages/contracts/src/replies.ts`), and this
 * file only names them for the window (lane g78). Until then it declared its own
 * copies, and the classifier's effort stopped at `high` while the server accepts
 * `xhigh` and `max`: a workspace configured at either read back as no classifier at
 * all (D03). The vocabularies there are the domain's, compared with the domain's own
 * lists by the API's tests, so a value the server gains is a failing test in its CI
 * rather than a card that silently does not parse on a Mac.
 */
export {
  CLASSIFIER_EFFORTS,
  REPLY_DISPOSITIONS,
  REPLY_NEXT_ACTIONS,
  replyCardDtoSchema as replyCardSchema,
  type ClassifierEffort,
  type ReplyDisposition,
  type ReplyNextAction,
} from '@fss/contracts';
export type ReplyCandidate = ReplyCandidateDto;
/** One reply card, exactly as `/replies/card` returned it. */
export type ReplyCard = ReplyCardDto;

/**
 * One row of the lane, and **it cannot hold a message body** (1.0.12).
 *
 * `GET /replies` answers full cards, bodies and all, and until 1.0.12 the main process
 * kept that whole list in memory for as long as the app was open: closing a card cleared
 * the open one and left the rest, and `replies.state` could hand them back after a
 * sign-out. What the list on screen actually shows is one line per card — the firm, who
 * wrote, and what Callie makes of it — so that is all this shape can carry, and the body
 * is dropped where the answer is parsed rather than where it is drawn.
 *
 * A body exists in exactly one place after this: `open`, the card somebody is reading.
 */
export const replySummarySchema = z.strictObject({
  messageId: uuid,
  receivedAt: instant,
  firmId: uuid,
  firmName: z.string().min(1).max(300),
  /** The sender as the list names them; never the message. */
  from: z.string().max(320).nullable(),
  contactName: z.string().max(200).nullable(),
  nextAction: z.enum(REPLY_NEXT_ACTIONS),
  proposedDisposition: z.enum(REPLY_DISPOSITIONS).nullable(),
  /** What was confirmed, if it was; the note and the consequences stay on the server. */
  confirmedDisposition: z.enum(REPLY_DISPOSITIONS).nullable(),
});
export type ReplySummary = z.infer<typeof replySummarySchema>;

/** One wire card, reduced to the line the lane shows. The only place this is done. */
export function replySummaryOf(card: ReplyCardDto): ReplySummary {
  return {
    messageId: card.messageId,
    receivedAt: card.receivedAt,
    firmId: card.firmId,
    firmName: card.firmName,
    from: card.from,
    contactName: card.contactName,
    nextAction: card.nextAction,
    proposedDisposition: card.proposedDisposition,
    confirmedDisposition: card.confirmation?.disposition ?? null,
  };
}

export const replyStateSchema = z.strictObject({
  /** Null before the first read, and after a sign-out. */
  businessDate: z.iso.date().nullable(),
  businessTimeZone: z.string().max(64).nullable(),
  /** The lane, as lines. No body reaches the window except the open card's. */
  cards: z.array(replySummarySchema),
  /** The card the person opened, or null. */
  open: replyCardDtoSchema.nullable(),
  /** Whether the cloud answered the last time we asked. */
  online: z.boolean(),
  /** Whether a mutating command may be attempted at all (4.2: mutations fail closed). */
  mayMutate: z.boolean(),
  /**
   * The model and effort the workspace is configured for, or null before the read. A
   * projection of `/replies/settings`: the caps and the update metadata are the
   * server's business, and the window shows these three.
   */
  classifier: z
    .strictObject({
      enabled: z.boolean(),
      modelName: z.string().max(64),
      effort: z.enum(CLASSIFIER_EFFORTS),
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
  /**
   * Whether this confirmation grants a contextual-reply permission (migration 0025).
   * The form's default is `true` for `interested` and `follow_up_later`, because an
   * inbound question permits a contextual reply; the server ignores it for the rest.
   */
  readonly grantFollowUp: boolean;
}

/**
 * The conversation a person chose for an ambiguous reply (lane g88, audit G07): one of the
 * card's own candidates, by its opportunity.
 */
export interface ResolveReplyRequest {
  readonly messageId: string;
  readonly opportunityId: string;
}

