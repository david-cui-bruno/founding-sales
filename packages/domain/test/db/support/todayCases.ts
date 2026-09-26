import type { SessionQueryable } from '../../../db/queryable.ts';
import type { TwoWorkspaces } from './fixtures.ts';

/**
 * A failing insert for every constraint migration 0008 adds (the Today
 * snapshot, its contact tasks and their snoozes).
 *
 * Same rules as `crmCases.ts` and `policyCases.ts`: their own file so two lanes never
 * edit the middle of one array, each case inside a transaction the caller rolls back,
 * and each row breaking exactly one thing — a row that breaks two is reported under
 * whichever check or index PostgreSQL reaches first, and the case would be testing the
 * wrong promise.
 *
 * The constraints fixture seeds workspaces and members but no CRM rows, so each case
 * makes the firm and contact it needs. No real business name appears; `example.test`
 * is reserved by RFC 6761.
 */

export interface TodayCaseFixture {
  readonly session: SessionQueryable;
  readonly seeded: TwoWorkspaces;
}

export interface TodayCase {
  readonly constraint: string;
  readonly run: (fixture: TodayCaseFixture) => Promise<unknown>;
}

const workspace = (f: TodayCaseFixture): string => f.seeded.alpha.workspaceId;
const salesperson = (f: TodayCaseFixture): string => f.seeded.alpha.salesperson.userId;
const otherWorkspaceUser = (f: TodayCaseFixture): string => f.seeded.beta.salesperson.userId;

/** A syntactically valid UUID that is never a row. */
const MISSING = '00000000-0000-4000-8000-000000000000';
const DATE = "DATE '2026-09-21'";
const AT = "TIMESTAMPTZ '2026-09-21 13:00:00+00'";

async function makeFirm(f: TodayCaseFixture, name: string): Promise<string> {
  const { rows } = await f.session.query<{ id: string }>(
    'INSERT INTO firms (workspace_id, name, assigned_user_id) VALUES ($1, $2, $3) RETURNING id',
    [workspace(f), name, salesperson(f)],
  );
  return rows[0]?.id ?? '';
}

async function makeContact(f: TodayCaseFixture, firmId: string): Promise<string> {
  const { rows } = await f.session.query<{ id: string }>(
    "INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, 'Dana Example') RETURNING id",
    [workspace(f), firmId],
  );
  return rows[0]?.id ?? '';
}

/** The columns every valid `today_items` insert needs, with one value left to the case. */
async function insertItem(
  f: TodayCaseFixture,
  firmId: string,
  overrides: {
    readonly id?: string;
    readonly itemKey?: string;
    readonly kind?: string;
    readonly status?: string;
    readonly automated?: boolean;
    readonly sourceKind?: string;
    readonly contactId?: string | null;
    readonly snoozeUntil?: string | null;
    readonly completedAt?: string | null;
    readonly createdAt?: string;
    readonly updatedAt?: string;
    readonly snapshotFirmId?: string;
  } = {},
): Promise<unknown> {
  return await f.session.query(
    `INSERT INTO today_items
       (id, workspace_id, snapshot_date, firm_id, contact_id, item_key, kind, due_at, status,
        automated, source_kind, snooze_until, completed_at, created_at, updated_at)
     VALUES (COALESCE($2::uuid, gen_random_uuid()), $1, ${DATE}, $3, $4, $5, $6, ${AT}, $7,
             $8, $9, $10::timestamptz, $11::timestamptz,
             COALESCE($12::timestamptz, now()), COALESCE($13::timestamptz, now()))`,
    [
      workspace(f),
      overrides.id ?? null,
      overrides.snapshotFirmId ?? firmId,
      overrides.contactId ?? null,
      overrides.itemKey ?? 'step-execution:one',
      overrides.kind ?? 'email_due',
      overrides.status ?? 'open',
      overrides.automated ?? false,
      overrides.sourceKind ?? 'step_execution',
      overrides.snoozeUntil ?? null,
      overrides.completedAt ?? null,
      overrides.createdAt ?? null,
      overrides.updatedAt ?? null,
    ],
  );
}

async function insertSnooze(
  f: TodayCaseFixture,
  firmId: string,
  overrides: {
    readonly id?: string;
    readonly contactId?: string | null;
    readonly itemKey?: string;
    readonly reason?: string;
    readonly returnAt?: string;
    readonly createdBy?: string;
    readonly createdAt?: string;
    readonly cancelledAt?: string | null;
    readonly cancelledBy?: string | null;
  } = {},
): Promise<unknown> {
  return await f.session.query(
    `INSERT INTO today_snoozes
       (id, workspace_id, firm_id, contact_id, item_key, reason, return_at, created_by_user_id,
        created_at, cancelled_at, cancelled_by_user_id)
     VALUES (COALESCE($2::uuid, gen_random_uuid()), $1, $3, $4, $5, $6, $7::timestamptz, $8,
             COALESCE($9::timestamptz, now()), $10::timestamptz, $11)`,
    [
      workspace(f),
      overrides.id ?? null,
      firmId,
      overrides.contactId ?? null,
      overrides.itemKey ?? 'step-execution:one',
      overrides.reason ?? 'Waiting on their board',
      overrides.returnAt ?? "2027-01-01T00:00:00Z",
      overrides.createdBy ?? salesperson(f),
      overrides.createdAt ?? null,
      overrides.cancelledAt ?? null,
      overrides.cancelledBy ?? null,
    ],
  );
}

export const TODAY_CONSTRAINT_CASES: readonly TodayCase[] = [
  // -------------------------------------------------------------- today_snapshots
  {
    constraint: 'today_snapshots_pkey',
    run: async f => {
      const firmId = await makeFirm(f, 'Northwind Test Holdings');
      const insert = `INSERT INTO today_snapshots (workspace_id, snapshot_date, firm_id, lane, sort_at)
                      VALUES ($1, ${DATE}, $2, 'new_firm', ${AT})`;
      await f.session.query(insert, [workspace(f), firmId]);
      return await f.session.query(insert, [workspace(f), firmId]);
    },
  },
  {
    constraint: 'today_snapshots_firm_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO today_snapshots (workspace_id, snapshot_date, firm_id, lane, sort_at)
         VALUES ($1, ${DATE}, $2, 'new_firm', ${AT})`,
        [workspace(f), MISSING],
      ),
  },
  {
    constraint: 'today_snapshots_assignee_fkey',
    run: async f => {
      const firmId = await makeFirm(f, 'Northwind Test Holdings');
      return await f.session.query(
        `INSERT INTO today_snapshots (workspace_id, snapshot_date, firm_id, lane, sort_at, assigned_user_id)
         VALUES ($1, ${DATE}, $2, 'new_firm', ${AT}, $3)`,
        [workspace(f), firmId, otherWorkspaceUser(f)],
      );
    },
  },
  {
    constraint: 'today_snapshots_lane_known',
    run: async f => {
      const firmId = await makeFirm(f, 'Northwind Test Holdings');
      return await f.session.query(
        `INSERT INTO today_snapshots (workspace_id, snapshot_date, firm_id, lane, sort_at)
         VALUES ($1, ${DATE}, $2, 'urgent', ${AT})`,
        [workspace(f), firmId],
      );
    },
  },
  {
    constraint: 'today_snapshots_counts_nonnegative',
    run: async f => {
      const firmId = await makeFirm(f, 'Northwind Test Holdings');
      return await f.session.query(
        `INSERT INTO today_snapshots (workspace_id, snapshot_date, firm_id, lane, sort_at, emails_due)
         VALUES ($1, ${DATE}, $2, 'due_work', ${AT}, -1)`,
        [workspace(f), firmId],
      );
    },
  },
  {
    constraint: 'today_snapshots_algorithm_shape',
    run: async f => {
      const firmId = await makeFirm(f, 'Northwind Test Holdings');
      return await f.session.query(
        `INSERT INTO today_snapshots (workspace_id, snapshot_date, firm_id, lane, sort_at, algorithm_version)
         VALUES ($1, ${DATE}, $2, 'new_firm', ${AT}, 'Today Algorithm 1')`,
        [workspace(f), firmId],
      );
    },
  },
  {
    constraint: 'today_snapshots_updated_not_before_built',
    run: async f => {
      const firmId = await makeFirm(f, 'Northwind Test Holdings');
      return await f.session.query(
        `INSERT INTO today_snapshots (workspace_id, snapshot_date, firm_id, lane, sort_at, built_at, updated_at)
         VALUES ($1, ${DATE}, $2, 'new_firm', ${AT},
                 TIMESTAMPTZ '2026-09-21 06:00:00+00', TIMESTAMPTZ '2026-09-21 05:00:00+00')`,
        [workspace(f), firmId],
      );
    },
  },

  // ------------------------------------------------------------------ today_items
  {
    constraint: 'today_items_pkey',
    run: async f => {
      const firmId = await makeFirm(f, 'Northwind Test Holdings');
      const id = '11111111-1111-4111-8111-111111111111';
      await insertItem(f, firmId, { id, itemKey: 'step-execution:one' });
      return await insertItem(f, firmId, { id, itemKey: 'step-execution:two' });
    },
  },
  {
    constraint: 'today_items_one_per_key',
    run: async f => {
      const firmId = await makeFirm(f, 'Northwind Test Holdings');
      await insertItem(f, firmId);
      return await insertItem(f, firmId);
    },
  },
  {
    constraint: 'today_items_firm_fkey',
    run: async f => await insertItem(f, MISSING),
  },
  {
    constraint: 'today_items_contact_fkey',
    run: async f => {
      const firmId = await makeFirm(f, 'Northwind Test Holdings');
      const otherFirmId = await makeFirm(f, 'Eastwind Test Holdings');
      const contactId = await makeContact(f, otherFirmId);
      // A task at one firm naming a person at another: the semantic composite key.
      return await insertItem(f, firmId, { contactId });
    },
  },
  {
    constraint: 'today_items_kind_known',
    run: async f => {
      const firmId = await makeFirm(f, 'Northwind Test Holdings');
      return await insertItem(f, firmId, { kind: 'coffee' });
    },
  },
  {
    constraint: 'today_items_status_known',
    run: async f => {
      const firmId = await makeFirm(f, 'Northwind Test Holdings');
      return await insertItem(f, firmId, { status: 'later' });
    },
  },
  {
    constraint: 'today_items_key_shape',
    run: async f => {
      const firmId = await makeFirm(f, 'Northwind Test Holdings');
      return await insertItem(f, firmId, { itemKey: 'step execution one!' });
    },
  },
  {
    constraint: 'today_items_source_kind_known',
    run: async f => {
      const firmId = await makeFirm(f, 'Northwind Test Holdings');
      return await insertItem(f, firmId, { sourceKind: 'a_hunch' });
    },
  },
  {
    constraint: 'today_items_automated_is_due_work',
    run: async f => {
      const firmId = await makeFirm(f, 'Northwind Test Holdings');
      // A callback is a person's work. Marking it automated would make it unsnoozeable.
      return await insertItem(f, firmId, { kind: 'callback', sourceKind: 'callback', automated: true });
    },
  },
  {
    constraint: 'today_items_snooze_consistent',
    run: async f => {
      const firmId = await makeFirm(f, 'Northwind Test Holdings');
      return await insertItem(f, firmId, { status: 'snoozed', snoozeUntil: null });
    },
  },
  {
    constraint: 'today_items_completion_consistent',
    run: async f => {
      const firmId = await makeFirm(f, 'Northwind Test Holdings');
      return await insertItem(f, firmId, { status: 'completed', completedAt: null });
    },
  },
  {
    constraint: 'today_items_updated_not_before_created',
    run: async f => {
      const firmId = await makeFirm(f, 'Northwind Test Holdings');
      return await insertItem(f, firmId, {
        createdAt: '2026-09-21T13:00:00Z',
        updatedAt: '2026-09-21T12:00:00Z',
      });
    },
  },

  // ---------------------------------------------------------------- today_snoozes
  {
    constraint: 'today_snoozes_pkey',
    run: async f => {
      const firmId = await makeFirm(f, 'Northwind Test Holdings');
      const id = '22222222-2222-4222-8222-222222222222';
      await insertSnooze(f, firmId, { id, itemKey: 'step-execution:one' });
      return await insertSnooze(f, firmId, { id, itemKey: 'step-execution:two' });
    },
  },
  {
    constraint: 'today_snoozes_one_active',
    run: async f => {
      const firmId = await makeFirm(f, 'Northwind Test Holdings');
      await insertSnooze(f, firmId);
      return await insertSnooze(f, firmId);
    },
  },
  {
    constraint: 'today_snoozes_firm_fkey',
    run: async f => await insertSnooze(f, MISSING),
  },
  {
    constraint: 'today_snoozes_contact_fkey',
    run: async f => {
      const firmId = await makeFirm(f, 'Northwind Test Holdings');
      const otherFirmId = await makeFirm(f, 'Eastwind Test Holdings');
      const contactId = await makeContact(f, otherFirmId);
      return await insertSnooze(f, firmId, { contactId });
    },
  },
  {
    constraint: 'today_snoozes_creator_fkey',
    run: async f => {
      const firmId = await makeFirm(f, 'Northwind Test Holdings');
      return await insertSnooze(f, firmId, { createdBy: otherWorkspaceUser(f) });
    },
  },
  {
    constraint: 'today_snoozes_canceller_fkey',
    run: async f => {
      const firmId = await makeFirm(f, 'Northwind Test Holdings');
      return await insertSnooze(f, firmId, {
        cancelledAt: '2026-09-21T14:00:00Z',
        cancelledBy: otherWorkspaceUser(f),
      });
    },
  },
  {
    constraint: 'today_snoozes_key_shape',
    run: async f => {
      const firmId = await makeFirm(f, 'Northwind Test Holdings');
      return await insertSnooze(f, firmId, { itemKey: 'step execution one!' });
    },
  },
  {
    constraint: 'today_snoozes_reason_bounded',
    run: async f => {
      const firmId = await makeFirm(f, 'Northwind Test Holdings');
      return await insertSnooze(f, firmId, { reason: '   ' });
    },
  },
  {
    constraint: 'today_snoozes_return_after_created',
    run: async f => {
      const firmId = await makeFirm(f, 'Northwind Test Holdings');
      return await insertSnooze(f, firmId, {
        createdAt: '2026-09-21T13:00:00Z',
        returnAt: '2026-09-21T12:00:00Z',
      });
    },
  },
  {
    constraint: 'today_snoozes_cancellation_consistent',
    run: async f => {
      const firmId = await makeFirm(f, 'Northwind Test Holdings');
      return await insertSnooze(f, firmId, { cancelledAt: '2026-09-21T14:00:00Z', cancelledBy: null });
    },
  },
];
