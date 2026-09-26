import type { RepositoryContext } from '../db/workspaceScope.ts';
import { currentCallingIdentityId } from '../dial/identities.ts';
import { businessDateOf, listTodayCards, listTodayItems, workspaceBusinessTimeZone } from './snapshots.ts';
import { TODAY_PAUSE_SOURCE_EVENT_KIND, callLogIdOfItemKey, type TodayCounts, type TodayItemRow } from './types.ts';
import type { TodayItemKind, TodayLane } from '@fss/contracts';

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
  /** True when FSS performs it. The Mac offers a pause rather than a snooze (8.2). */
  readonly automated: boolean;
  readonly snoozeUntil: string | null;
}

/**
 * A task as the expanded card's second version carries it.
 *
 * Four identities G6's task dropped, each of which a control needs:
 *
 *  * `callbackId` — the callback behind a callback task. Recording the call's outcome
 *    against the task completes it (Appendix A "Callback confirm/complete"; C17).
 *  * `stepExecutionId` — the sequence step behind a due task. A call logged against the
 *    task applies the step's configured successor or retry (9.1; C04).
 *  * `callLogId` — for "Callback — needs a time": the recorded call that asked for a
 *    callback without a confirmed instant (C13). Setting the time schedules it.
 *  * `pauseHoldId` — an automated task a person paused, and the hold the Resume
 *    control releases (8.2; C22).
 *
 * A second version rather than four more fields on the first, because the Mac parses
 * the expanded card with a strict schema: a desktop that has never heard of these
 * fields would refuse the whole card. `readTodayFirm` returns this shape and the route
 * projects it back to `TodayTaskDto` for a client that did not ask for version 2.
 */
export interface TodayTaskDtoV2 extends TodayTaskDto {
  readonly callbackId: string | null;
  readonly stepExecutionId: string | null;
  readonly callLogId: string | null;
  readonly pauseHoldId: string | null;
  /**
   * For a sequence step the worker is holding: whole days since it fell due, which is
   * how long it has been waiting ("held 3 days"). Null for anything not held. A hold of
   * any length resumes on its own once its causes clear (wave 2, S4.1), so this is
   * what the card shows instead of asking for a review.
   */
  readonly heldDays: number | null;
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

export interface TodayFirmDto<Task extends TodayTaskDto = TodayTaskDtoV2> {
  readonly firmId: string;
  readonly firmName: string;
  readonly snapshotDate: string;
  readonly lane: TodayLane;
  readonly counts: TodayCounts;
  readonly tasks: readonly Task[];
  readonly routes: readonly TodayRouteDto[];
  /**
   * The acting salesperson's own active verified number, or null.
   *
   * 9.1: a calling identity "must be active and owned by the acting salesperson", so
   * there is nothing here for the client to choose and no reason for it to hold a
   * list. Null is a card with no Call button, which is the honest state for an actor
   * who has not attested a number. With several, it is the most recently attested
   * (`currentCallingIdentityId`).
   */
  readonly callingIdentityId: string | null;
}

/**
 * The expanded card in its first shape: every task without the four identities of
 * `TodayTaskDtoV2`. What `/today/firm` answers a client that did not ask for version 2,
 * so an older desktop keeps parsing the card it always parsed.
 */
export function todayFirmVersion1(page: TodayFirmDto): TodayFirmDto<TodayTaskDto> {
  return {
    ...page,
    tasks: page.tasks.map(task => ({
      itemId: task.itemId,
      contactId: task.contactId,
      contactName: task.contactName,
      kind: task.kind,
      lane: task.lane,
      dueAt: task.dueAt,
      status: task.status,
      automated: task.automated,
      snoozeUntil: task.snoozeUntil,
    })),
  };
}

/**
 * The open Today pauses covering this firm's automated tasks, by the task they cover.
 *
 * A pause is a hold with `source_event_kind = 'today.delay_requested'`, scoped to the
 * task's enrollment or — for a hold G6 opened — to the firm. One read of the holds and
 * one of the executions, matched here: the hold's scope and blocked kind against the
 * task's enrollment and kind.
 */
async function pausesByItem(
  context: RepositoryContext,
  firmId: string,
  items: readonly TodayItemRow[],
): Promise<ReadonlyMap<string, string>> {
  const automated = items.filter(item => item.automated);
  if (automated.length === 0) return new Map();
  const { rows: holds } = await context.db.query<{
    id: string;
    scope_kind: string;
    scope_key: string;
    blocked_action_kinds: string[];
  }>(
    `SELECT h.id, h.scope_kind, h.scope_key, h.blocked_action_kinds
       FROM active_holds h
      WHERE h.workspace_id = $1
        AND h.released_at IS NULL
        AND h.source_event_kind = $2
        AND ((h.scope_kind = 'firm' AND h.scope_key = ($3::uuid)::text)
             OR (h.scope_kind = 'enrollment' AND h.scope_key IN (
                   SELECT n.id::text FROM sequence_enrollments n
                    WHERE n.workspace_id = $1 AND n.firm_id = $3::uuid)))
      ORDER BY h.started_at, h.id`,
    [context.scope.workspaceId, TODAY_PAUSE_SOURCE_EVENT_KIND, firmId],
  );
  if (holds.length === 0) return new Map();

  const executionIds = automated
    .filter(item => item.sourceKind === 'step_execution' && item.sourceId !== null)
    .map(item => item.sourceId as string);
  const { rows: executions } = await context.db.query<{ id: string; enrollment_id: string }>(
    'SELECT id, enrollment_id FROM step_executions WHERE workspace_id = $1 AND id = ANY($2::uuid[])',
    [context.scope.workspaceId, executionIds],
  );
  const enrollmentOf = new Map(executions.map(row => [row.id, row.enrollment_id]));

  const found = new Map<string, string>();
  for (const item of automated) {
    const kind = PAUSED_ACTION_KIND[item.kind];
    if (kind === null) continue;
    const enrollmentId = item.sourceId === null ? undefined : enrollmentOf.get(item.sourceId);
    const hold = holds.find(
      row =>
        row.blocked_action_kinds.includes(kind) &&
        ((row.scope_kind === 'enrollment' && row.scope_key === enrollmentId) ||
          (row.scope_kind === 'firm' && row.scope_key === item.firmId)),
    );
    if (hold !== undefined) found.set(item.id, hold.id);
  }
  return found;
}

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

/**
 * How many whole days each held step behind these tasks has waited since it fell due
 * (wave 2, S4.1). One read of the executions; a step that is not `held` is absent.
 */
async function heldDaysByExecution(
  context: RepositoryContext,
  items: readonly TodayItemRow[],
  now: string,
): Promise<ReadonlyMap<string, number>> {
  const ids = items
    .filter(item => item.sourceKind === 'step_execution' && item.sourceId !== null)
    .map(item => item.sourceId as string);
  if (ids.length === 0) return new Map();
  const { rows } = await context.db.query<{ id: string; due_at: Date }>(
    `SELECT id, due_at FROM step_executions
      WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND state = 'held'`,
    [context.scope.workspaceId, ids],
  );
  const at = Date.parse(now);
  return new Map(
    rows.map(row => [row.id, Math.max(Math.floor((at - row.due_at.getTime()) / DAY_MILLISECONDS), 0)]),
  );
}

/** The action kind a paused automated task blocks. The same table `snooze.ts` opens holds with. */
const PAUSED_ACTION_KIND: Readonly<Record<TodayItemKind, string | null>> = Object.freeze({
  reply: null,
  callback: null,
  email_due: 'email_send',
  call_due: 'call_task',
  new_firm: null,
});

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
  const pauses = await pausesByItem(context, input.firmId, items);
  const held = await heldDaysByExecution(context, items, input.now);

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

  // The same choice the settings page shows as "used for calls": the most
  // recently attested of the actor's verified, enabled numbers. One function, so the
  // card and the page cannot disagree about which line a call will leave on.
  const actor = context.scope.actor;
  const callingIdentityId = actor.kind === 'user' ? await currentCallingIdentityId(context, actor.userId) : null;

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
      callbackId: item.sourceKind === 'callback' ? item.sourceId : null,
      stepExecutionId: item.sourceKind === 'step_execution' ? item.sourceId : null,
      callLogId: callLogIdOfItemKey(item.itemKey),
      pauseHoldId: pauses.get(item.id) ?? null,
      heldDays: item.sourceKind === 'step_execution' && item.sourceId !== null ? (held.get(item.sourceId) ?? null) : null,
    })),
    routes: routes.rows.map(row => ({
      routeId: row.id,
      contactId: row.contact_id,
      e164: row.e164,
      version: Number(row.version),
      eligibility: row.eligibility,
    })),
    callingIdentityId,
  };
}
