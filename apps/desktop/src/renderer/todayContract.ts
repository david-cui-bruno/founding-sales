import { z } from 'zod';
import {
  instant,
  todayCardDtoSchema,
  todayFirmResponseSchema,
  type CALL_OUTCOMES,
  type TodayCardDto,
  type TodayFirmResponse,
  type TodayRouteDto,
  type TodayTaskDto,
} from '@fss/contracts';

/**
 * What the Today window is given, and the seven things it may ask for
 * (specification 8.2, 14.2).
 *
 * A second contract beside G2's `shared/contract.ts` rather than an extension of it,
 * and the reason is a retention rule rather than a style. `DesktopState.today` is the
 * *cache* shape: it is written to disk, encrypted, for 24 hours (5.3), and G2 made it
 * a `strictObject` with no field a body, a note or a person's name could occupy. The
 * expanded card names contacts, so it must not be cacheable — and the way to make
 * that structural rather than remembered is for the expansion to live in a type the
 * cache has never heard of.
 *
 * So: the cards come from the cache and survive an outage marked stale (4.2); the
 * tasks under a card come from the cloud and are simply absent without it.
 *
 * Like G3b's `firmWorkspaceContract.ts`, nothing here decides anything. Every field
 * is a shape the API already produced, and the window's whole job is to show it and
 * to disable what cannot be done.
 */

/*
 * The wire shapes are `@fss/contracts`' (`packages/contracts/src/today.ts`), and this
 * file only names them for the window (lane g78). Until then the list was declared
 * here and again in `todayBridge.ts`, a firm name was capped at 200 characters where a
 * firm may have 300, and a route's number was any short string rather than E.164.
 */
export { TODAY_LANES, type TodayLane } from '@fss/contracts';
export type TodayCard = TodayCardDto;
export type TodayTask = TodayTaskDto;
/**
 * One dialable route on an expanded card (9.1, 9.2). The version is the one
 * `authorizeDial` compares, so a stale card cannot dial a replaced number.
 */
export type TodayRoute = TodayRouteDto;
/**
 * One card, expanded. `callingIdentityId` is the acting salesperson's own verified
 * number, or null: 9.1 requires the identity to be theirs, so the window is told which
 * one rather than offered a choice, and null is a card with no Call button.
 */
export type TodayFirm = TodayFirmResponse;

export const todayStateSchema = z.strictObject({
  /** Null before the first read, and after a sign-out. */
  snapshotDate: z.iso.date().nullable(),
  businessTimeZone: z.string().max(64).nullable(),
  cards: z.array(todayCardDtoSchema),
  /** The card the person expanded, or null. Never cached: it names contacts. */
  expanded: todayFirmResponseSchema.nullable(),
  /** Whether the cloud answered the last time we asked. */
  online: z.boolean(),
  /** True when the cards on screen came from the 24-hour cache rather than the API. */
  stale: z.boolean(),
  /** When the shown list was fetched, or null when there is nothing to show. */
  asOf: instant.nullable(),
  /** Whether a mutating command may be attempted at all. */
  mayMutate: z.boolean(),
  /** The caller's role: an admin is shown every salesperson's list (8.2). */
  role: z.enum(['admin', 'salesperson']).nullable(),
  /** A stable code, never a sentence composed here. */
  notice: z.string().max(80).nullable(),
  /** 9.2's last clause, so the window never has to compose it. */
  handoffNotice: z.string(),
});
export type TodayState = z.infer<typeof todayStateSchema>;

export interface SnoozeRequest {
  readonly itemId: string;
  readonly reason: string;
  /** The explicit instant the task comes back. 8.2 requires one; there is no default. */
  readonly returnAt: string;
}

export interface DialRequest {
  readonly firmId: string;
  readonly contactId: string | null;
  readonly routeId: string;
  readonly routeVersion: number;
}

export interface OutcomeRequest {
  readonly firmId: string;
  readonly contactId: string | null;
  readonly routeId: string | null;
  readonly outcome: (typeof CALL_OUTCOMES)[number];
  readonly note: string;
  readonly callback: {
    readonly localDate: string;
    readonly localTime: string;
    readonly dueAt: string;
    readonly sourceTimeZone: string;
  } | null;
  readonly doNotCallCoversAllContact: boolean;
}

export interface TodayBridge {
  state(): Promise<TodayState>;
  refresh(): Promise<TodayState>;
  expand(input: { readonly firmId: string }): Promise<TodayState>;
  collapse(): Promise<TodayState>;
  snooze(input: SnoozeRequest): Promise<TodayState>;
  /** Authorize, consume and open `tel:` in one call. The renderer never sees a ticket. */
  dial(input: DialRequest): Promise<TodayState>;
  recordOutcome(input: OutcomeRequest): Promise<TodayState>;
}

declare global {
  /** The bridge the preload script installs, exactly as G2's `callie` is installed. */
  var callieToday: TodayBridge | undefined;
}
