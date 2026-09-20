import { z } from 'zod';
import { instant, uuid, type CALL_OUTCOMES } from '@fss/contracts';

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

export const TODAY_LANES = ['reply', 'callback', 'due_work', 'new_firm'] as const;
export type TodayLane = (typeof TODAY_LANES)[number];

export const todayCountsSchema = z.strictObject({
  replies: z.number().int().min(0),
  emailsDue: z.number().int().min(0),
  callsDue: z.number().int().min(0),
  linkedInDue: z.number().int().min(0),
});

export const todayCardSchema = z.strictObject({
  firmId: uuid,
  firmName: z.string().min(1).max(200),
  lane: z.enum(TODAY_LANES),
  dueAt: instant,
  counts: todayCountsSchema,
});
export type TodayCard = z.infer<typeof todayCardSchema>;

export const todayTaskSchema = z.strictObject({
  itemId: uuid,
  contactId: uuid.nullable(),
  contactName: z.string().max(200).nullable(),
  kind: z.enum(['reply', 'callback', 'email_due', 'call_due', 'linkedin_due', 'new_firm']),
  lane: z.enum(TODAY_LANES),
  dueAt: instant,
  status: z.enum(['open', 'snoozed']),
  automated: z.boolean(),
  snoozeUntil: instant.nullable(),
});
export type TodayTask = z.infer<typeof todayTaskSchema>;

/**
 * One dialable route on an expanded card (9.1, 9.2).
 *
 * The version is here because `authorizeDial` compares it: "Authorization uses the
 * route version displayed on the card, preventing a stale client from dialing a
 * replaced or retired number." A card that sent no version would be asking the server
 * to trust whatever number it happens to hold — and it arrives with the tasks, in one
 * read at one instant, so "the version the card displays" is a version the card was
 * given rather than one it remembered.
 */
export const todayRouteSchema = z.strictObject({
  routeId: uuid,
  contactId: uuid.nullable(),
  e164: z.string().min(2).max(20),
  version: z.number().int().min(1),
  eligibility: z.enum(['candidate', 'usable', 'invalid', 'retired']),
});
export type TodayRoute = z.infer<typeof todayRouteSchema>;

export const todayFirmSchema = z.strictObject({
  firmId: uuid,
  firmName: z.string().min(1).max(200),
  snapshotDate: z.iso.date(),
  lane: z.enum(TODAY_LANES),
  counts: todayCountsSchema,
  tasks: z.array(todayTaskSchema),
  routes: z.array(todayRouteSchema),
  /**
   * The acting salesperson's own verified number, or null. 9.1 requires the identity
   * to be theirs, so the window is told which one rather than offered a choice; null
   * is a card with no Call button.
   */
  callingIdentityId: uuid.nullable(),
});
export type TodayFirm = z.infer<typeof todayFirmSchema>;

export const todayStateSchema = z.strictObject({
  /** Null before the first read, and after a sign-out. */
  snapshotDate: z.iso.date().nullable(),
  businessTimeZone: z.string().max(64).nullable(),
  cards: z.array(todayCardSchema),
  /** The card the person expanded, or null. Never cached: it names contacts. */
  expanded: todayFirmSchema.nullable(),
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
