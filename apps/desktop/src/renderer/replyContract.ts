import { z } from 'zod';
import {
  CLASSIFIER_EFFORTS,
  replyCardDtoSchema,
  type ReplyCandidateDto,
  type ReplyCardDto,
  type ReplyConfirmationDto,
  type ReplyDisposition,
  type ReplyHoldDto,
  type ReplySignalDto,
} from '@fss/contracts';

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
export type ReplyHold = ReplyHoldDto;
export type ReplySignal = ReplySignalDto;
export type ReplyCandidate = ReplyCandidateDto;
export type ReplyConfirmation = ReplyConfirmationDto;
/** One reply card, exactly as `/replies/card` returned it. */
export type ReplyCard = ReplyCardDto;

export const replyStateSchema = z.strictObject({
  /** Null before the first read, and after a sign-out. */
  businessDate: z.iso.date().nullable(),
  businessTimeZone: z.string().max(64).nullable(),
  cards: z.array(replyCardDtoSchema),
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
