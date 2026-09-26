import type { RepositoryContext } from '../db/workspaceScope.ts';
import { cancelUnproducedItems, upsertTodayItem, workspaceBusinessTimeZone } from './snapshots.ts';
import {
  CALLBACK_TIME_NEEDED_KEY_PREFIX,
  TODAY_ALGORITHM_VERSION,
  callbackTimeNeededItemKey,
  type TodaySourceKind,
} from './types.ts';
import type { TodayItemKind } from '@fss/contracts';

/**
 * Building one workspace business date's list (specification 8.2, Appendix C).
 *
 * "One workspace snapshot per workspace business date ... is built at 05:00 in the
 * configurable workspace zone. Job identity includes the algorithm version."
 *
 * The build does one thing: decide which tasks exist. It does not decide any firm's
 * lane, sort instant or counts — `today_refresh_card` does that from the tasks, in a
 * row trigger, so a build that forgot to update a card is not a shape this code can
 * take.
 *
 * ## The sources, and the two that are not here yet
 *
 * 8.2's four lanes have four sources. Two of them are rows that exist today:
 * `callbacks` (G4) and `firms` (G3a). The other two are the tables lanes G7 and G8
 * own, and neither exists. Rather than leave the lanes undefined until then, a source
 * is an interface: a lane adds a `TodaySource` to the array, declares which
 * `source_kind`s it produces, and the build calls it. The reply lane will add one; so
 * will the sequences lane. Nothing in this file changes when they do.
 *
 * Declaring the source kinds is what makes the reconciliation safe. A rebuild cancels
 * the tasks its sources no longer produce, and it may only cancel a kind that was
 * actually enumerated: a reply promoted at 09:00 by a lane that has no source in this
 * build is not something this build knows is gone.
 */

export interface TodayContribution {
  readonly firmId: string;
  readonly contactId?: string | undefined;
  /** The task's identity within the day. Built from the row that produced it. */
  readonly itemKey: string;
  readonly kind: TodayItemKind;
  readonly dueAt: string;
  readonly sourceKind: TodaySourceKind;
  readonly sourceId?: string | undefined;
  readonly automated?: boolean | undefined;
}

export interface TodaySourceInput {
  /** The workspace business date being built. */
  readonly businessDate: string;
  /** The workspace's configurable business zone (Appendix D). */
  readonly businessTimeZone: string;
  /** The instant the build is running at. Database time, passed in by the caller. */
  readonly now: string;
}

export interface TodaySource {
  readonly name: string;
  /** The `source_kind`s this source is authoritative for. The reconciliation reads it. */
  readonly sourceKinds: readonly TodaySourceKind[];
  find(context: RepositoryContext, input: TodaySourceInput): Promise<readonly TodayContribution[]>;
}

/**
 * Lane 2: callbacks (9.1, Appendix D).
 *
 * Every open callback due on or before the date being built. An overdue callback
 * moves on to today's list rather than staying on the day it was promised for, which
 * is the same rule `today_callback_changed` applies when one is confirmed.
 *
 * And every recorded "call me back" that has no callback yet (audit C13):
 * a `callback_requested` call with no `callbacks` row naming it, whose needs-a-time
 * task nobody has finished. `logCallOutcome` promotes the task the moment the call is
 * recorded; this carries it to each following day until a time is set (which creates
 * the callback) or a call is recorded against it (which finishes the task). It is a
 * `callback` source kind with no source id, because there is no callback row yet and
 * the key — `callback-time:<call log id>` — is its identity.
 */
export function callbackSource(): TodaySource {
  return {
    name: 'callbacks',
    sourceKinds: ['callback'],
    find: async (context, input) => {
      const { rows } = await context.db.query<{
        id: string;
        firm_id: string;
        contact_id: string | null;
        due_at: Date;
      }>(
        `SELECT c.id, c.firm_id, c.contact_id, c.due_at
           FROM callbacks c
           JOIN firms f ON f.workspace_id = c.workspace_id AND f.id = c.firm_id
          WHERE c.workspace_id = $1
            AND c.status = 'open'
            AND f.status = 'active'
            AND (c.due_at AT TIME ZONE $2)::date <= $3::date
          ORDER BY c.due_at, c.id`,
        [context.scope.workspaceId, input.businessTimeZone, input.businessDate],
      );
      const { rows: needingTime } = await context.db.query<{
        id: string;
        firm_id: string;
        contact_id: string | null;
        recorded_at: Date;
      }>(
        `SELECT l.id, l.firm_id, l.contact_id, l.recorded_at
           FROM call_logs l
           JOIN firms f ON f.workspace_id = l.workspace_id AND f.id = l.firm_id
          WHERE l.workspace_id = $1
            AND l.outcome = 'callback_requested'
            AND f.status = 'active'
            AND (l.recorded_at AT TIME ZONE $2)::date <= $3::date
            AND NOT EXISTS (
              SELECT 1 FROM callbacks c WHERE c.workspace_id = l.workspace_id AND c.call_log_id = l.id)
            AND NOT EXISTS (
              SELECT 1 FROM today_items t
               WHERE t.workspace_id = l.workspace_id AND t.firm_id = l.firm_id
                 AND t.item_key = $4 || l.id::text AND t.status = 'completed')
          ORDER BY l.recorded_at, l.id`,
        [context.scope.workspaceId, input.businessTimeZone, input.businessDate, CALLBACK_TIME_NEEDED_KEY_PREFIX],
      );
      return [
        ...rows.map(row => ({
          firmId: row.firm_id,
          ...(row.contact_id === null ? {} : { contactId: row.contact_id }),
          itemKey: `callback:${row.id}`,
          kind: 'callback' as const,
          dueAt: row.due_at.toISOString(),
          sourceKind: 'callback' as const,
          sourceId: row.id,
        })),
        ...needingTime.map(row => ({
          firmId: row.firm_id,
          ...(row.contact_id === null ? {} : { contactId: row.contact_id }),
          itemKey: callbackTimeNeededItemKey(row.id),
          kind: 'callback' as const,
          dueAt: row.recorded_at.toISOString(),
          sourceKind: 'callback' as const,
        })),
      ];
    },
  };
}

/**
 * Lane 4: new firms (8.2).
 *
 * A firm whose open opportunity is still at the first stage, or which has no
 * opportunity at all — a discovered firm nobody has opened yet is exactly the thing
 * this lane is for (7.4: "Research never initiates outreach ... enrollment and first
 * contact are deliberate salesperson actions").
 *
 * "No opportunity at all" means never had one (audit C19). The join reads only
 * the open opportunity, so a firm whose opportunity was Won or Lost used to read as a
 * firm with none, and came back the next morning as a new firm to call — a client, or
 * somebody who had said no. A firm with a closed opportunity has been worked; it is not
 * new, whatever stage a later reopened opportunity stands at.
 *
 * A firm under a firm-wide do-not-contact is not on the list. 10.2 makes that
 * suppression effective immediately and database-enforced, and putting the firm on
 * somebody's morning list is the one thing it exists to prevent.
 *
 * The sort instant is the firm's creation time, so the lane is oldest first and two
 * builds of the same data choose the same order.
 */
export function newFirmSource(): TodaySource {
  return {
    name: 'new-firms',
    sourceKinds: ['firm'],
    find: async context => {
      const { rows } = await context.db.query<{ id: string; created_at: Date }>(
        `SELECT f.id, f.created_at
           FROM firms f
           LEFT JOIN opportunities o
             ON o.workspace_id = f.workspace_id AND o.firm_id = f.id AND o.status = 'open'
           LEFT JOIN pipeline_stages s
             ON s.workspace_id = o.workspace_id AND s.id = o.stage_id
          WHERE f.workspace_id = $1
            AND f.status = 'active'
            AND (o.id IS NULL OR s.position = 1)
            AND NOT EXISTS (
              SELECT 1 FROM opportunities closed
               WHERE closed.workspace_id = f.workspace_id
                 AND closed.firm_id = f.id
                 AND closed.status <> 'open'
            )
            AND NOT EXISTS (
              SELECT 1 FROM effective_suppressions e
               WHERE e.workspace_id = f.workspace_id
                 AND e.scope = 'firm'
                 AND e.canonical_key = f.id::text
            )
          ORDER BY f.created_at, f.id`,
        [context.scope.workspaceId],
      );
      return rows.map(row => ({
        firmId: row.id,
        itemKey: `firm:${row.id}`,
        kind: 'new_firm' as const,
        dueAt: row.created_at.toISOString(),
        sourceKind: 'firm' as const,
        sourceId: row.id,
      }));
    },
  };
}

/** The sources that have a table to read today. G7 and G8 add theirs to this array. */
export function defaultTodaySources(): readonly TodaySource[] {
  return [callbackSource(), newFirmSource()];
}

export interface BuildTodaySnapshotInput {
  readonly businessDate: string;
  /** Database time. The scheduler and the handler pass it; nothing here reads a clock. */
  readonly now: string;
  readonly sources?: readonly TodaySource[] | undefined;
}

export interface TodayBuildReport {
  readonly businessDate: string;
  readonly algorithmVersion: string;
  readonly written: number;
  readonly cancelled: number;
  readonly sources: readonly string[];
}

/**
 * Build the list. Idempotent: running it twice over the same data leaves the same
 * rows, which is `today.build`'s Appendix C protection ("snapshot uniqueness") and
 * the determinism property this lane is accepted on.
 */
export async function buildTodaySnapshot(
  context: RepositoryContext,
  input: BuildTodaySnapshotInput,
): Promise<TodayBuildReport> {
  const sources = input.sources ?? defaultTodaySources();
  const businessTimeZone = await workspaceBusinessTimeZone(context);
  const sourceInput: TodaySourceInput = {
    businessDate: input.businessDate,
    businessTimeZone,
    now: input.now,
  };

  const contributions: TodayContribution[] = [];
  const sourceKinds = new Set<TodaySourceKind>();
  for (const source of sources) {
    for (const kind of source.sourceKinds) sourceKinds.add(kind);
    contributions.push(...(await source.find(context, sourceInput)));
  }

  // Sorted before they are written, so two runs insert in the same order and the
  // tiebreak inside `today_refresh_card` sees the same rows in the same sequence.
  contributions.sort((left, right) =>
    left.firmId === right.firmId
      ? left.itemKey < right.itemKey
        ? -1
        : left.itemKey > right.itemKey
          ? 1
          : 0
      : left.firmId < right.firmId
        ? -1
        : 1,
  );

  const keptItemKeys: string[] = [];
  for (const contribution of contributions) {
    await upsertTodayItem(context, { businessDate: input.businessDate, ...contribution });
    keptItemKeys.push(contribution.itemKey);
  }

  const cancelled = await cancelUnproducedItems(context, {
    businessDate: input.businessDate,
    sourceKinds: [...sourceKinds],
    keptItemKeys,
  });

  return {
    businessDate: input.businessDate,
    algorithmVersion: TODAY_ALGORITHM_VERSION,
    written: contributions.length,
    cancelled,
    sources: sources.map(source => source.name),
  };
}
