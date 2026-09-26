import type { RepositoryContext } from '../db/workspaceScope.ts';
import {
  isTodayItemKind,
  type TodayCardRow,
  type TodayItemRow,
  type TodayItemStatus,
  type TodaySourceKind,
} from './types.ts';
import type { TodayItemKind, TodayLane } from '@fss/contracts';

/**
 * Reading and writing the Today tables (specification 8.2).
 *
 * Every write goes through `today_upsert_item`, the SQL function migration 0008
 * defines, rather than through an INSERT written here. That is deliberate: the same
 * function is what the callback trigger calls, so the promotion committed inside G4's
 * transaction and the 05:00 rebuild cannot disagree about what happens to a task that
 * already exists — whether a finished one is reopened, whether an active snooze wins.
 *
 * Nothing in this file computes a lane or a sort instant. `today_refresh_card` does,
 * from a row trigger, so the card is derived rather than maintained.
 */

const CARD_COLUMNS = `s.snapshot_date::text AS snapshot_date, s.firm_id, f.name AS firm_name, s.lane,
  s.sort_at, s.assigned_user_id, s.open_items, s.replies_due, s.emails_due, s.calls_due,
  s.algorithm_version`;

interface CardDbRow {
  readonly snapshot_date: string;
  readonly firm_id: string;
  readonly firm_name: string;
  readonly lane: TodayLane;
  readonly sort_at: Date;
  readonly assigned_user_id: string | null;
  readonly open_items: number;
  readonly replies_due: number;
  readonly emails_due: number;
  readonly calls_due: number;
  readonly algorithm_version: string;
  readonly [column: string]: unknown;
}

function toCard(row: CardDbRow): TodayCardRow {
  return {
    snapshotDate: row.snapshot_date,
    firmId: row.firm_id,
    firmName: row.firm_name,
    lane: row.lane,
    sortAt: row.sort_at.toISOString(),
    assignedUserId: row.assigned_user_id,
    openItems: Number(row.open_items),
    counts: {
      replies: Number(row.replies_due),
      emailsDue: Number(row.emails_due),
      callsDue: Number(row.calls_due),
    },
    algorithmVersion: row.algorithm_version,
  };
}

const ITEM_COLUMNS = `i.id, i.snapshot_date::text AS snapshot_date, i.firm_id, i.contact_id,
  c.full_name AS contact_name, i.item_key, i.kind, i.lane, i.due_at, i.status, i.automated,
  i.source_kind, i.source_id, i.snooze_until`;

interface ItemDbRow {
  readonly id: string;
  readonly snapshot_date: string;
  readonly firm_id: string;
  readonly contact_id: string | null;
  readonly contact_name: string | null;
  readonly item_key: string;
  readonly kind: string;
  readonly lane: TodayLane;
  readonly due_at: Date;
  readonly status: TodayItemStatus;
  readonly automated: boolean;
  readonly source_kind: TodaySourceKind;
  readonly source_id: string | null;
  readonly snooze_until: Date | null;
  readonly [column: string]: unknown;
}

/**
 * The task a row is, or null when its kind is one `TODAY_ITEM_KINDS` no longer has — a
 * LinkedIn task stored before 25 September 2026, which no reader lists or acts on.
 */
function toItem(row: ItemDbRow): TodayItemRow | null {
  if (!isTodayItemKind(row.kind)) return null;
  return {
    id: row.id,
    snapshotDate: row.snapshot_date,
    firmId: row.firm_id,
    contactId: row.contact_id,
    contactName: row.contact_name,
    itemKey: row.item_key,
    kind: row.kind,
    lane: row.lane,
    dueAt: row.due_at.toISOString(),
    status: row.status,
    automated: row.automated,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    snoozeUntil: row.snooze_until === null ? null : row.snooze_until.toISOString(),
  };
}

/** The workspace's configurable business zone (Appendix D). Never the host's. */
export async function workspaceBusinessTimeZone(context: RepositoryContext): Promise<string> {
  const { rows } = await context.db.query<{ zone: string }>(
    'SELECT business_time_zone AS zone FROM workspaces WHERE id = $1',
    [context.scope.workspaceId],
  );
  const zone = rows[0]?.zone;
  if (zone === undefined) throw new Error('the workspace has no business time zone');
  return zone;
}

/**
 * The workspace business date an instant falls on.
 *
 * Computed by PostgreSQL rather than by `Intl`, because the callback trigger computes
 * it the same way inside the database and the two answers have to be the same one:
 * a promotion that landed on a different date from the build would be a second card.
 */
export async function businessDateOf(context: RepositoryContext, instant: string): Promise<string> {
  const { rows } = await context.db.query<{ business_date: string }>(
    `SELECT (($2::timestamptz AT TIME ZONE w.business_time_zone)::date)::text AS business_date
       FROM workspaces w WHERE w.id = $1`,
    [context.scope.workspaceId, instant],
  );
  const date = rows[0]?.business_date;
  if (date === undefined) throw new Error('the workspace has no business time zone');
  return date;
}

export interface UpsertTodayItemInput {
  readonly businessDate: string;
  readonly firmId: string;
  readonly contactId?: string | undefined;
  readonly itemKey: string;
  readonly kind: TodayItemKind;
  readonly dueAt: string;
  readonly sourceKind: TodaySourceKind;
  readonly sourceId?: string | undefined;
  /** Work FSS performs by itself. It is held rather than snoozed (8.2). */
  readonly automated?: boolean | undefined;
}

/** Put one task on a day's list, or update the one already there. Returns its id. */
export async function upsertTodayItem(
  context: RepositoryContext,
  input: UpsertTodayItemInput,
): Promise<string> {
  const { rows } = await context.db.query<{ id: string }>(
    `SELECT today_upsert_item($1, $2::date, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10) AS id`,
    [
      context.scope.workspaceId,
      input.businessDate,
      input.firmId,
      input.itemKey,
      input.kind,
      input.dueAt,
      input.contactId ?? null,
      input.sourceKind,
      input.sourceId ?? null,
      input.automated ?? false,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined || id === null) throw new Error('today_upsert_item returned no row');
  return id;
}

export interface ListTodayCardsInput {
  readonly snapshotDate: string;
  /** Section 8.2: "Admins see all entries; salespeople see their own." */
  readonly assignedUserId?: string | undefined;
}

/**
 * One workspace business date's cards, in 8.2's order.
 *
 * `open_items > 0` is "Completing one item leaves the firm visible while another
 * qualifying item remains": the card stays in the table as the record of the day, and
 * leaves the list when the last task is finished.
 *
 * A merged firm's card is not returned. The record is history and the firm it points
 * at is not somewhere work can be done.
 */
export async function listTodayCards(
  context: RepositoryContext,
  input: ListTodayCardsInput,
): Promise<readonly TodayCardRow[]> {
  const { rows } = await context.db.query<CardDbRow>(
    `SELECT ${CARD_COLUMNS}
       FROM today_snapshots s
       JOIN firms f ON f.workspace_id = s.workspace_id AND f.id = s.firm_id
      WHERE s.workspace_id = $1
        AND s.snapshot_date = $2::date
        AND s.open_items > 0
        AND f.status = 'active'
        AND ($3::uuid IS NULL OR s.assigned_user_id = $3::uuid)
      ORDER BY s.lane_precedence, s.sort_at, f.name, s.firm_id`,
    [context.scope.workspaceId, input.snapshotDate, input.assignedUserId ?? null],
  );
  return rows.map(toCard);
}

export interface ListTodayItemsInput {
  readonly businessDate: string;
  readonly firmId: string;
  /** Finished tasks are excluded unless asked for; the card is about what is left. */
  readonly includeFinished?: boolean | undefined;
}

export async function listTodayItems(
  context: RepositoryContext,
  input: ListTodayItemsInput,
): Promise<readonly TodayItemRow[]> {
  const { rows } = await context.db.query<ItemDbRow>(
    `SELECT ${ITEM_COLUMNS}
       FROM today_items i
       LEFT JOIN contacts c ON c.workspace_id = i.workspace_id AND c.id = i.contact_id
      WHERE i.workspace_id = $1
        AND i.snapshot_date = $2::date
        AND i.firm_id = $3
        AND ($4::boolean IS TRUE OR i.status IN ('open', 'snoozed'))
      ORDER BY i.lane_precedence, i.due_at, i.item_key`,
    [context.scope.workspaceId, input.businessDate, input.firmId, input.includeFinished ?? false],
  );
  return rows.flatMap(row => toItem(row) ?? []);
}

/** One task by id, or null. */
export async function readTodayItem(context: RepositoryContext, itemId: string): Promise<TodayItemRow | null> {
  const { rows } = await context.db.query<ItemDbRow>(
    `SELECT ${ITEM_COLUMNS}
       FROM today_items i
       LEFT JOIN contacts c ON c.workspace_id = i.workspace_id AND c.id = i.contact_id
      WHERE i.workspace_id = $1 AND i.id = $2`,
    [context.scope.workspaceId, itemId],
  );
  const row = rows[0];
  return row === undefined ? null : toItem(row);
}

/**
 * Finish one task.
 *
 * The lanes that own the work call this in the transaction that recorded whatever
 * finished it; the callback's own completion is done by the trigger, beside the
 * callback row, for the same reason the promotion is.
 */
export async function completeTodayItem(
  context: RepositoryContext,
  input: { readonly itemId: string },
): Promise<TodayItemRow | null> {
  const { rows } = await context.db.query<{ id: string }>(
    `UPDATE today_items
        SET status = 'completed', completed_at = now(), snooze_until = NULL,
            updated_at = greatest(now(), created_at)
      WHERE workspace_id = $1 AND id = $2 AND status IN ('open', 'snoozed')
      RETURNING id`,
    [context.scope.workspaceId, input.itemId],
  );
  return rows[0] === undefined ? null : await readTodayItem(context, input.itemId);
}

/**
 * Finish every open task with this key at this firm, on any date.
 *
 * A needs-a-time callback and a sequence step's task are both carried from day to day
 * under one key, and what finishes them — a scheduled callback, a recorded call — is
 * not a question of which day's row was on screen. Returns how many were finished.
 */
export async function completeTodayItemsByKey(
  context: RepositoryContext,
  input: { readonly firmId: string; readonly itemKey: string },
): Promise<number> {
  const { rowCount } = await context.db.query(
    `UPDATE today_items
        SET status = 'completed', completed_at = now(), snooze_until = NULL,
            updated_at = greatest(now(), created_at)
      WHERE workspace_id = $1 AND firm_id = $2 AND item_key = $3 AND status IN ('open', 'snoozed')`,
    [context.scope.workspaceId, input.firmId, input.itemKey],
  );
  return rowCount ?? 0;
}

/**
 * Cancel the tasks a rebuild no longer produced.
 *
 * Only the source kinds the build actually enumerated: a reply the classification
 * lane promoted this morning is not something a build that knows nothing about
 * replies may decide is gone.
 */
export async function cancelUnproducedItems(
  context: RepositoryContext,
  input: {
    readonly businessDate: string;
    readonly sourceKinds: readonly TodaySourceKind[];
    readonly keptItemKeys: readonly string[];
  },
): Promise<number> {
  if (input.sourceKinds.length === 0) return 0;
  const { rowCount } = await context.db.query(
    `UPDATE today_items
        SET status = 'cancelled', snooze_until = NULL, updated_at = greatest(now(), created_at)
      WHERE workspace_id = $1
        AND snapshot_date = $2::date
        AND source_kind = ANY($3::text[])
        AND status IN ('open', 'snoozed')
        AND NOT (item_key = ANY($4::text[]))`,
    [context.scope.workspaceId, input.businessDate, [...input.sourceKinds], [...input.keptItemKeys]],
  );
  return rowCount ?? 0;
}
