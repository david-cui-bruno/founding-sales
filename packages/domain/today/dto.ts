import type { RepositoryContext } from '../db/workspaceScope.ts';
import { businessDateOf, listTodayCards, listTodayItems, workspaceBusinessTimeZone } from './snapshots.ts';
import type { TodayCounts, TodayItemKind, TodayLane } from './types.ts';

/**
 * What the API returns and the Mac shows (specification 8.2, 14.1, Appendix F).
 *
 * `TodayListDto` is deliberately the exact shape of `cachedTodaySchema` in
 * `apps/desktop/src/shared/contract.ts`, which G2 wrote as a `strictObject` with no
 * field a message body, a note or an address could occupy. The Mac caches the list
 * for 24 hours (5.3), so the list is the one read whose shape is also a retention
 * decision: a field added here is a field that ends up encrypted on somebody's
 * laptop, and the strict schema on the other side is what makes that a parse failure
 * rather than a surprise.
 *
 * The expanded card is a *second* read and is not cached. Its tasks name a contact,
 * which the cache has no room for, and 4.2 says an offline client shows "its
 * unexpired cached Today view marked stale" — the cards, not the conversations
 * underneath them.
 *
 * Visibility is 8.2's, decided here and not by a route: "Admins see all entries;
 * salespeople see their own."
 */

export interface TodayCardDto {
  readonly firmId: string;
  readonly firmName: string;
  readonly lane: TodayLane;
  readonly dueAt: string;
  readonly counts: TodayCounts;
}

export interface TodayListDto {
  readonly workspaceId: string;
  readonly snapshotDate: string;
  readonly businessTimeZone: string;
  readonly cards: readonly TodayCardDto[];
}

export interface TodayTaskDto {
  readonly itemId: string;
  readonly contactId: string | null;
  readonly contactName: string | null;
  readonly kind: TodayItemKind;
  readonly lane: TodayLane;
  readonly dueAt: string;
  readonly status: 'open' | 'snoozed';
  /** True when FSS performs it. The Mac offers a hold rather than a snooze (8.2). */
  readonly automated: boolean;
  readonly snoozeUntil: string | null;
}

/**
 * One dialable number on the expanded card (9.1, 9.2).
 *
 * The version is here because `authorizeDial` compares it: "Authorization uses the
 * route version displayed on the card, preventing a stale client from dialing a
 * replaced or retired number." Sending it with the tasks rather than from a second
 * endpoint is what makes "the version the card displays" a version the card was
 * actually given, at the same instant as everything else on it.
 */
export interface TodayRouteDto {
  readonly routeId: string;
  readonly contactId: string | null;
  readonly e164: string;
  readonly version: number;
  readonly eligibility: string;
}

export interface TodayFirmDto {
  readonly firmId: string;
  readonly firmName: string;
  readonly snapshotDate: string;
  readonly lane: TodayLane;
  readonly counts: TodayCounts;
  readonly tasks: readonly TodayTaskDto[];
  readonly routes: readonly TodayRouteDto[];
  /**
   * The acting salesperson's own active verified number, or null.
   *
   * 9.1: a calling identity "must be active and owned by the acting salesperson", so
   * there is nothing here for the client to choose and no reason for it to hold a
   * list. Null is a card with no Call button, which is the honest state for an actor
   * who has not had a number verified.
   */
  readonly callingIdentityId: string | null;
}

/** Which assignee's list a scope may read, or undefined for "every one". */
function assigneeFilter(context: RepositoryContext): string | undefined {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return undefined;
  return actor.role === 'admin' ? undefined : actor.userId;
}

export interface ReadTodayInput {
  /** Database time. The business date is derived from it in the workspace zone. */
  readonly now: string;
}

export async function readTodayList(
  context: RepositoryContext,
  input: ReadTodayInput,
): Promise<TodayListDto> {
  const businessTimeZone = await workspaceBusinessTimeZone(context);
  const snapshotDate = await businessDateOf(context, input.now);
  const assignedUserId = assigneeFilter(context);
  const cards = await listTodayCards(context, {
    snapshotDate,
    ...(assignedUserId === undefined ? {} : { assignedUserId }),
  });
  return {
    workspaceId: context.scope.workspaceId,
    snapshotDate,
    businessTimeZone,
    cards: cards.map(card => ({
      firmId: card.firmId,
      firmName: card.firmName,
      lane: card.lane,
      dueAt: card.sortAt,
      counts: card.counts,
    })),
  };
}

/**
 * One card, expanded (8.2: "Expanding the card reveals contact-level tasks ordered by
 * lane precedence and due instant").
 *
 * Null when the firm has no card on that date, or has one the caller may not see. The
 * two are deliberately the same answer: telling a salesperson that a colleague's firm
 * has work on it today is the read Appendix F's first row does not grant.
 */
export async function readTodayFirm(
  context: RepositoryContext,
  input: { readonly firmId: string; readonly now: string },
): Promise<TodayFirmDto | null> {
  const snapshotDate = await businessDateOf(context, input.now);
  const assignedUserId = assigneeFilter(context);
  const cards = await listTodayCards(context, {
    snapshotDate,
    ...(assignedUserId === undefined ? {} : { assignedUserId }),
  });
  const card = cards.find(entry => entry.firmId === input.firmId);
  if (card === undefined) return null;

  const items = await listTodayItems(context, { businessDate: snapshotDate, firmId: input.firmId });

  // Unretired numbers at this firm, with the version `authorizeDial` will compare.
  // Candidates are included and marked rather than hidden: "no number" and "a number
  // nobody has confirmed" are different facts (9.1).
  const routes = await context.db.query<{
    id: string;
    contact_id: string | null;
    e164: string;
    version: number;
    eligibility: string;
  }>(
    `SELECT id, contact_id, e164, version, eligibility
       FROM phone_routes
      WHERE workspace_id = $1 AND firm_id = $2 AND eligibility <> 'retired'
      ORDER BY eligibility, e164`,
    [context.scope.workspaceId, input.firmId],
  );

  const actor = context.scope.actor;
  const identity =
    actor.kind === 'user'
      ? await context.db.query<{ id: string }>(
          `SELECT id FROM calling_identities
            WHERE workspace_id = $1 AND owner_user_id = $2 AND enabled = true
              AND verification_status = 'verified'
            ORDER BY created_at, id
            LIMIT 1`,
          [context.scope.workspaceId, actor.userId],
        )
      : { rows: [] as { id: string }[] };

  return {
    firmId: card.firmId,
    firmName: card.firmName,
    snapshotDate,
    lane: card.lane,
    counts: card.counts,
    tasks: items.map(item => ({
      itemId: item.id,
      contactId: item.contactId,
      contactName: item.contactName,
      kind: item.kind,
      lane: item.lane,
      dueAt: item.dueAt,
      status: item.status === 'snoozed' ? 'snoozed' : 'open',
      automated: item.automated,
      snoozeUntil: item.snoozeUntil,
    })),
    routes: routes.rows.map(row => ({
      routeId: row.id,
      contactId: row.contact_id,
      e164: row.e164,
      version: Number(row.version),
      eligibility: row.eligibility,
    })),
    callingIdentityId: identity.rows[0]?.id ?? null,
  };
}
