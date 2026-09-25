import { z } from 'zod';
import { blockedActionKindSchema } from './reasonCodes.ts';
import { routeEligibilitySchema } from './crm.ts';
import { businessDate, e164, ianaTimeZone, instant, uuid } from './foundationRows.ts';

/**
 * The wire contract of Today: the list, one expanded firm, the snooze answer and the
 * pause release (specification 8.2; lanes g78 and g79).
 *
 * The Mac declared these in `apps/desktop/src/renderer/todayContract.ts`, and the list
 * a second time in `apps/desktop/src/main/todayBridge.ts`. They matched the routes, but
 * three copies of one shape is three places for the next field to be missed, and two
 * details were narrower than the server: a firm name is up to 300 characters
 * (`firmNameSchema` in `./crm.ts`) where the copies said 200, and a route's number is
 * E.164, not any short string. The vocabularies are `packages/domain/today/types.ts`'s,
 * compared with the domain's lists by `apps/api/test/wireVocabulary.test.ts`.
 *
 * The encrypted 24-hour cache keeps its own strict schema in
 * `apps/desktop/src/shared/contract.ts`: what may be written to disk is a retention
 * rule of the Mac's (5.3), not a property of the wire, and the Mac checks that every
 * list it parses here is one the cache accepts.
 */

/** 8.2's four lanes, in precedence order. */
export const TODAY_LANES = ['reply', 'callback', 'due_work', 'new_firm'] as const;
export type TodayLane = (typeof TODAY_LANES)[number];

export const TODAY_ITEM_KINDS = ['reply', 'callback', 'email_due', 'call_due', 'linkedin_due', 'new_firm'] as const;
export type TodayItemKind = (typeof TODAY_ITEM_KINDS)[number];

const firmName = z.string().min(1).max(300);

export const todayCountsSchema = z.object({
  replies: z.number().int().min(0),
  emailsDue: z.number().int().min(0),
  callsDue: z.number().int().min(0),
  linkedInDue: z.number().int().min(0),
});
export type TodayCounts = z.infer<typeof todayCountsSchema>;

export const todayCardDtoSchema = z.object({
  firmId: uuid,
  firmName,
  lane: z.enum(TODAY_LANES),
  dueAt: instant,
  counts: todayCountsSchema,
});
export type TodayCardDto = z.infer<typeof todayCardDtoSchema>;

/** `GET /today`. */
export const todayListResponseSchema = z.object({
  workspaceId: uuid,
  snapshotDate: businessDate,
  businessTimeZone: ianaTimeZone,
  cards: z.array(todayCardDtoSchema),
});
export type TodayListResponse = z.infer<typeof todayListResponseSchema>;

export const todayTaskDtoSchema = z.object({
  itemId: uuid,
  contactId: uuid.nullable(),
  contactName: z.string().max(200).nullable(),
  kind: z.enum(TODAY_ITEM_KINDS),
  lane: z.enum(TODAY_LANES),
  dueAt: instant,
  status: z.enum(['open', 'snoozed']),
  /** True when FSS performs it. The Mac offers a hold rather than a snooze (8.2). */
  automated: z.boolean(),
  snoozeUntil: instant.nullable(),
  /*
   * The card's second version (lane g79), sent only to a request with
   * `cardVersion: 2`. Optional so the first version still parses: a desktop released
   * before g79 parses the task with a strict schema of its own, and the API answers it
   * without these keys.
   *
   *  * `callbackId`: the callback behind a callback task. Recording the call against the
   *    task completes it (Appendix A "Callback confirm/complete").
   *  * `stepExecutionId`: the sequence step behind a due task. Recording the call
   *    applies the frozen step's successor or retry (9.1).
   *  * `callLogId`: "Callback — needs a time", and the recorded call that asked for it.
   *  * `pauseHoldId`: a paused automated task, and the hold its Resume releases (8.2).
   */
  callbackId: uuid.nullable().optional(),
  stepExecutionId: uuid.nullable().optional(),
  callLogId: uuid.nullable().optional(),
  pauseHoldId: uuid.nullable().optional(),
});
export type TodayTaskDto = z.infer<typeof todayTaskDtoSchema>;

/** The card version that carries the four task identities above (lane g79). */
export const TODAY_CARD_VERSION = 2;

/**
 * `POST /today/firm`'s request. Without `cardVersion` the card is G6's shape exactly;
 * any version other than 2 is a malformed request rather than a guess.
 */
export const todayFirmRequestSchema = z.strictObject({
  firmId: uuid,
  cardVersion: z.literal(TODAY_CARD_VERSION).optional(),
});
export type TodayFirmRequest = z.infer<typeof todayFirmRequestSchema>;

/**
 * One dialable route on an expanded card (9.1, 9.2). The version is the one
 * `authorizeDial` compares, so a stale card cannot dial a replaced number.
 */
export const todayRouteDtoSchema = z.object({
  routeId: uuid,
  contactId: uuid.nullable(),
  e164,
  version: z.number().int().min(1),
  eligibility: routeEligibilitySchema,
});
export type TodayRouteDto = z.infer<typeof todayRouteDtoSchema>;

/** `POST /today/firm`: one card, expanded. */
export const todayFirmResponseSchema = z.object({
  firmId: uuid,
  firmName,
  snapshotDate: businessDate,
  lane: z.enum(TODAY_LANES),
  counts: todayCountsSchema,
  tasks: z.array(todayTaskDtoSchema),
  routes: z.array(todayRouteDtoSchema),
  /** The acting salesperson's own verified number, or null: a card with no Call button. */
  callingIdentityId: uuid.nullable(),
});
export type TodayFirmResponse = z.infer<typeof todayFirmResponseSchema>;

/** What `/today/snooze` returns inside the command envelope (`SnoozeOutcome`). */
export const todaySnoozeResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('snoozed'),
    snooze: z.object({
      id: uuid,
      firmId: uuid,
      contactId: uuid.nullable(),
      itemKey: z.string().min(1),
      reason: z.string().min(1),
      returnAt: instant,
      createdByUserId: uuid,
      createdAt: instant,
      cancelledAt: instant.nullable(),
    }),
  }),
  /**
   * An automated send is paused rather than snoozed, with the hold that blocks it (4.3).
   * `scope` says what the pause covers: the task's own enrollment, or the firm when the
   * task belongs to no enrollment (lane g79, C22). Optional so an answer from an API
   * that predates it still parses.
   */
  z.object({
    outcome: z.literal('held'),
    holdId: uuid,
    blockedActionKind: blockedActionKindSchema,
    scope: z.enum(['enrollment', 'firm']).optional(),
  }),
]);
export type TodaySnoozeResult = z.infer<typeof todaySnoozeResultSchema>;

/**
 * What `/today/pause/release` returns inside the command envelope: the Resume control
 * on a paused automated task (lane g79, C22). `resume` is what the enrollment did
 * next under 4.3: resumed with its shift, still held by another hold, or sent to
 * review; `not_applicable` for a firm-scoped pause.
 */
export const todayPauseReleaseResultSchema = z.object({
  holdId: uuid,
  releasedAt: instant,
  resume: z.enum(['resume', 'still_held', 'review_required', 'not_applicable']),
});
export type TodayPauseReleaseResult = z.infer<typeof todayPauseReleaseResultSchema>;
