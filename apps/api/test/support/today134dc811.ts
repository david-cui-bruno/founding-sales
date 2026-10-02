/*
 * FROZEN: `packages/contracts/src/today.ts` exactly as it is at 134dc811 (production, the
 * installed desktop's contract), with only its imports pointed at `@fss/contracts` — none of
 * the imported schemas has changed since. Slice 3a's B-10 parses Today's answers with it: an
 * installed desktop has no `task` kind, so a request that did not negotiate `include=tasks`
 * must answer what this parses. Never edit it to follow the live contract.
 */
import { z } from 'zod';
import {
  blockedActionKindSchema,
  businessDate,
  callBriefSchema,
  e164,
  ianaTimeZone,
  instant,
  routeEligibilitySchema,
  uuid,
} from '@fss/contracts';

/**
 * The wire contract of Today: the list, one expanded firm, the snooze answer and the
 * pause release (specification 8.2; lanes g78 and g79).
 *
 * The Mac declared these in `apps/desktop/src/renderer/todayContract.ts`, and the list
 * a second time in `apps/desktop/src/main/todayBridge.ts`. They matched the routes, but
 * three copies of one shape is three places for the next field to be missed, and two
 * details were narrower than the server: a firm name is up to 300 characters
 * (`firmNameSchema` in `./crm.ts`) where the copies said 200, and a route's number is
 * E.164, not any short string. The vocabularies are declared here and the domain
 * imports them.
 *
 * The encrypted 24-hour cache keeps its own strict schema in
 * `apps/desktop/src/shared/contract.ts`: what may be written to disk is a retention
 * rule of the Mac's (5.3), not a property of the wire, and the Mac checks that every
 * list it parses here is one the cache accepts.
 */

/** 8.2's four lanes, in precedence order. */
export const TODAY_LANES = ['reply', 'callback', 'due_work', 'new_firm'] as const;
export type TodayLane = (typeof TODAY_LANES)[number];

export const TODAY_ITEM_KINDS = ['reply', 'callback', 'email_due', 'call_due', 'new_firm'] as const;
export type TodayItemKind = (typeof TODAY_ITEM_KINDS)[number];

const firmName = z.string().min(1).max(300);

const todayCountsSchema = z.object({
  replies: z.number().int().min(0),
  emailsDue: z.number().int().min(0),
  callsDue: z.number().int().min(0),
});

/**
 * Why a card cannot be called yet, from the firm's own record (slice S2): no number to
 * call, or no state and time zone (the calling window and the state posture both need
 * them). Codes, never sentences, and never the values themselves: the list is cached on
 * the Mac (5.3), and a code is not personal data. The dial check on the expanded card
 * still has the last word; these are the two the person can fix from Today.
 */
export const TODAY_CARD_BLOCKERS = ['no_phone', 'no_location'] as const;
export type TodayCardBlocker = (typeof TODAY_CARD_BLOCKERS)[number];

export const todayCardDtoSchema = z.object({
  firmId: uuid,
  firmName,
  lane: z.enum(TODAY_LANES),
  dueAt: instant,
  counts: todayCountsSchema,
  /**
   * Slice S2. Optional, so a list from an API before it parses; an installed desktop
   * (1.0.25 and before) parses the card with `z.object` and drops the key before its
   * strict cache sees it.
   */
  blockers: z.array(z.enum(TODAY_CARD_BLOCKERS)).optional(),
});
export type TodayCardDto = z.infer<typeof todayCardDtoSchema>;

/** `GET /today`. */
export const todayListResponseSchema = z.object({
  workspaceId: uuid,
  snapshotDate: businessDate,
  businessTimeZone: ianaTimeZone,
  cards: z.array(todayCardDtoSchema),
});

/**
 * `GET /today/calls-placed`: how many calls were placed on the workspace's own business
 * date (David, 29 September 2026).
 *
 * A read of its own rather than a field on the list. `todayListResponseSchema` is the one
 * read whose shape is also a retention decision — the Mac caches it for 24 hours (5.3)
 * against a strict schema with no field a note or an address could occupy — and a live
 * count that changes every time somebody rings off does not belong in a cache.
 */
export const callsPlacedTodayResponseSchema = z.object({
  businessDate,
  businessTimeZone: ianaTimeZone,
  calls: z.number().int().min(0),
});
export type CallsPlacedTodayResponse = z.infer<typeof callsPlacedTodayResponseSchema>;

const todayTaskDtoSchema = z.object({
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
   * The card's second version, sent only to a request with
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
  /**
   * Wave 2 (S4.1), card version 2 only: whole days a held sequence step has waited since
   * it fell due, for "held N days"; null when the step is not held. A hold of any length
   * resumes on its own once its causes clear. Optional, and stripped by desktops up to
   * 1.0.11, whose schema does not name it.
   */
  heldDays: z.number().int().min(0).nullable().optional(),
});
export type TodayTaskDto = z.infer<typeof todayTaskDtoSchema>;

/** The card version that carries the four task identities above. */
export const TODAY_CARD_VERSION = 2;

/**
 * `POST /today/firm`'s request. Without `cardVersion` the card is G6's shape exactly;
 * any version other than 2 is a malformed request rather than a guess.
 */
export const todayFirmRequestSchema = z.strictObject({
  firmId: uuid,
  cardVersion: z.literal(TODAY_CARD_VERSION).optional(),
});

/**
 * One dialable route on an expanded card (9.1, 9.2). The version is the one
 * `authorizeDial` compares, so a stale card cannot dial a replaced number.
 */
const todayRouteDtoSchema = z.object({
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
  /**
   * The call brief (lane R), or null when no research run has completed for this firm.
   *
   * Optional, and omitted from card version 1. `todayFirmResponseSchema` is a
   * `z.object`, so an installed desktop that has never heard of this key strips it
   * rather than refusing the card — which is what lets the API be deployed ahead of
   * the Macs it serves. Adding it is not a wire break.
   */
  brief: callBriefSchema.nullable().optional(),
  /**
   * The firm's editable basics (slice S2): what Today's Edit shows and changes. Optional,
   * and only in card version 2, so an installed desktop never sees it.
   */
  basics: z
    .object({
      locality: z.string().max(120).nullable(),
      regionCode: z.string().regex(/^[A-Z]{2}$/u).nullable(),
      timeZone: ianaTimeZone.nullable(),
      blockers: z.array(z.enum(TODAY_CARD_BLOCKERS)),
    })
    .optional(),
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
   * task belongs to no enrollment (C22). Optional so an answer from an API
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
 * on a paused automated task (C22). `resume` is what the enrollment did
 * next under 4.3: resumed with its shift, or still held by another hold;
 * `not_applicable` for a firm-scoped pause. `review_required` went with the seven-day
 * review (wave 2, S4.1) and with migration 0021.
 */
export const todayPauseReleaseResultSchema = z.object({
  holdId: uuid,
  releasedAt: instant,
  resume: z.enum(['resume', 'still_held', 'not_applicable']),
});
