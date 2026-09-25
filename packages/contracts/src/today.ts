import { z } from 'zod';
import { blockedActionKindSchema } from './reasonCodes.ts';
import { routeEligibilitySchema } from './crm.ts';
import { businessDate, e164, ianaTimeZone, instant, uuid } from './foundationRows.ts';

/**
 * The wire contract of Today: the list, one expanded firm, and the snooze answer
 * (specification 8.2; lane g78).
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
});
export type TodayTaskDto = z.infer<typeof todayTaskDtoSchema>;

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
  /** An automated send is held rather than snoozed, with the hold that blocks it (4.3). */
  z.object({ outcome: z.literal('held'), holdId: uuid, blockedActionKind: blockedActionKindSchema }),
]);
export type TodaySnoozeResult = z.infer<typeof todaySnoozeResultSchema>;
