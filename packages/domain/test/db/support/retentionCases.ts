import type { SessionQueryable } from '../../../db/queryable.ts';
import type { TwoWorkspaces } from './fixtures.ts';
import type { SeededCrm } from './crmFixtures.ts';

/**
 * A failing insert for every constraint migration 0014 adds.
 *
 * The coverage test at the bottom of `constraints.test.ts` asks the catalog for the
 * enforced set and fails when one has no case, so this file is not optional and its
 * length is the migration's, not a choice.
 *
 * Each case is written to break exactly one constraint. Where a row would break two —
 * `retention_runs_only_a_sweep_removes` and `retention_runs_sweep_has_boundary` are
 * both about the relationship between `outcome` and the rest — the other columns are
 * set to satisfy everything else, so the error names the one under test.
 */

interface Fixture {
  readonly session: SessionQueryable;
  readonly seeded: TwoWorkspaces;
  readonly crm: SeededCrm;
}

interface Case {
  readonly constraint: string;
  readonly run: (fixture: Fixture) => Promise<unknown>;
}

const workspace = (f: Fixture): string => f.seeded.alpha.workspaceId;
const admin = (f: Fixture): string => f.seeded.alpha.admin.userId;
const salesperson = (f: Fixture): string => f.seeded.alpha.salesperson.userId;
const HASH = 'a'.repeat(64);

/** A run row that satisfies everything, for a case to break one column of. */
const run = async (f: Fixture, columns: string, values: readonly unknown[]): Promise<unknown> =>
  await f.session.query(`INSERT INTO retention_runs (workspace_id, ${columns}) VALUES ($1, ${values.map((_, index) => `$${String(index + 2)}`).join(', ')})`, [
    workspace(f),
    ...values,
  ]);

/** A previewed deletion request that satisfies everything. */
const request = async (f: Fixture, columns: string, values: readonly unknown[]): Promise<unknown> =>
  await f.session.query(
    `INSERT INTO deletion_requests (workspace_id, target_kind, firm_id, requested_by_user_id, preview, preview_hash, ${columns})
     VALUES ($1, 'firm', $2, $3, '{}'::jsonb, $4, ${values.map((_, index) => `$${String(index + 5)}`).join(', ')})`,
    [workspace(f), f.crm.alpha.firmId, admin(f), HASH, ...values],
  );

export const RETENTION_CONSTRAINT_CASES: readonly Case[] = [
  // ------------------------------------------------------------ retention_runs
  {
    constraint: 'retention_runs_pkey',
    run: async f => {
      const { rows } = await f.session.query<{ id: string }>(
        "INSERT INTO retention_runs (workspace_id, data_kind, period) VALUES ($1, 'raw_mime', '2026-09-20') RETURNING id",
        [workspace(f)],
      );
      return await f.session.query(
        "INSERT INTO retention_runs (workspace_id, id, data_kind, period) VALUES ($1, $2, 'audit_events', '2026-09-20')",
        [workspace(f), rows[0]?.id],
      );
    },
  },
  {
    constraint: 'retention_runs_one_per_period',
    run: async f => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await f.session.query(
          "INSERT INTO retention_runs (workspace_id, data_kind, period) VALUES ($1, 'job_payloads', '2026-09-20')",
          [workspace(f)],
        );
      }
      return null;
    },
  },
  {
    constraint: 'retention_runs_workspace_id_fkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO retention_runs (workspace_id, data_kind, period) VALUES ('00000000-0000-4000-8000-000000000000', 'raw_mime', '2026-09-20')",
      ),
  },
  {
    constraint: 'retention_runs_data_kind_known',
    run: async f => await run(f, 'data_kind, period', ['everything', '2026-09-20']),
  },
  {
    constraint: 'retention_runs_period_shape',
    run: async f => await run(f, 'data_kind, period', ['raw_mime', 'last-tuesday']),
  },
  {
    // `completed_at` is an hour ahead of the default `started_at` in every finished
    // case below, so the row breaks only the constraint it is written to break and
    // never `retention_runs_completed_not_before_started` by accident.
    constraint: 'retention_runs_outcome_known',
    run: async f =>
      await f.session.query(
        `INSERT INTO retention_runs (workspace_id, data_kind, period, outcome, completed_at)
         VALUES ($1, 'raw_mime', '2026-09-20', 'shredded', now() + INTERVAL '1 hour')`,
        [workspace(f)],
      ),
  },
  {
    // `swept` with no completion: a finished outcome that never finished.
    constraint: 'retention_runs_completion_consistent',
    run: async f =>
      await run(f, 'data_kind, period, outcome, boundary_at', ['raw_mime', '2026-09-20', 'swept', new Date()]),
  },
  {
    constraint: 'retention_runs_only_a_sweep_removes',
    run: async f =>
      await f.session.query(
        `INSERT INTO retention_runs (workspace_id, data_kind, period, outcome, completed_at, rows_deleted)
         VALUES ($1, 'audit_events', '2026-09-20', 'retained', now() + INTERVAL '1 hour', 1)`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'retention_runs_counts_not_negative',
    run: async f =>
      await f.session.query(
        `INSERT INTO retention_runs (workspace_id, data_kind, period, outcome, completed_at, boundary_at, rows_deleted)
         VALUES ($1, 'raw_mime', '2026-09-20', 'swept', now() + INTERVAL '1 hour', now(), -1)`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'retention_runs_sweep_has_boundary',
    run: async f =>
      await f.session.query(
        `INSERT INTO retention_runs (workspace_id, data_kind, period, outcome, completed_at)
         VALUES ($1, 'raw_mime', '2026-09-20', 'swept', now() + INTERVAL '1 hour')`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'retention_runs_detail_is_object',
    run: async f => await run(f, 'data_kind, period, detail', ['raw_mime', '2026-09-20', '[]']),
  },
  {
    constraint: 'retention_runs_completed_not_before_started',
    run: async f =>
      await f.session.query(
        `INSERT INTO retention_runs (workspace_id, data_kind, period, outcome, started_at, completed_at)
         VALUES ($1, 'raw_mime', '2026-09-20', 'retained', now(), now() - INTERVAL '1 hour')`,
        [workspace(f)],
      ),
  },

  // -------------------------------------------------------- deletion_requests
  {
    constraint: 'deletion_requests_pkey',
    run: async f => {
      const { rows } = await f.session.query<{ id: string }>(
        `INSERT INTO deletion_requests (workspace_id, target_kind, firm_id, requested_by_user_id, preview, preview_hash)
         VALUES ($1, 'firm', $2, $3, '{}'::jsonb, $4) RETURNING id`,
        [workspace(f), f.crm.alpha.firmId, admin(f), HASH],
      );
      return await request(f, 'id', [rows[0]?.id]);
    },
  },
  {
    constraint: 'deletion_requests_workspace_id_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO deletion_requests (workspace_id, target_kind, firm_id, requested_by_user_id, preview, preview_hash)
         VALUES ('00000000-0000-4000-8000-000000000000', 'firm', $1, $2, '{}'::jsonb, $3)`,
        [f.crm.alpha.firmId, admin(f), HASH],
      ),
  },
  {
    constraint: 'deletion_requests_firm_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO deletion_requests (workspace_id, target_kind, firm_id, requested_by_user_id, preview, preview_hash)
         VALUES ($1, 'firm', '00000000-0000-4000-8000-000000000000', $2, '{}'::jsonb, $3)`,
        [workspace(f), admin(f), HASH],
      ),
  },
  {
    // A contact from the *other* workspace's firm: the composite key refuses it.
    constraint: 'deletion_requests_contact_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO deletion_requests (workspace_id, target_kind, firm_id, contact_id, requested_by_user_id, preview, preview_hash)
         VALUES ($1, 'contact', $2, $3, $4, '{}'::jsonb, $5)`,
        [workspace(f), f.crm.alpha.firmId, f.crm.beta.contactId, admin(f), HASH],
      ),
  },
  {
    constraint: 'deletion_requests_requester_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO deletion_requests (workspace_id, target_kind, firm_id, requested_by_user_id, preview, preview_hash)
         VALUES ($1, 'firm', $2, $3, '{}'::jsonb, $4)`,
        [workspace(f), f.crm.alpha.firmId, f.seeded.beta.admin.userId, HASH],
      ),
  },
  {
    constraint: 'deletion_requests_committer_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO deletion_requests (workspace_id, target_kind, firm_id, requested_by_user_id, preview, preview_hash,
                                        state, committed_at, committed_by_user_id)
         VALUES ($1, 'firm', $2, $3, '{}'::jsonb, $4, 'committed', now() + INTERVAL '1 hour', $5)`,
        [workspace(f), f.crm.alpha.firmId, admin(f), HASH, f.seeded.beta.admin.userId],
      ),
  },
  {
    constraint: 'deletion_requests_target_kind_known',
    run: async f =>
      await f.session.query(
        `INSERT INTO deletion_requests (workspace_id, target_kind, firm_id, requested_by_user_id, preview, preview_hash)
         VALUES ($1, 'everything', $2, $3, '{}'::jsonb, $4)`,
        [workspace(f), f.crm.alpha.firmId, admin(f), HASH],
      ),
  },
  {
    // A contact target that names no contact.
    constraint: 'deletion_requests_contact_named',
    run: async f =>
      await f.session.query(
        `INSERT INTO deletion_requests (workspace_id, target_kind, firm_id, requested_by_user_id, preview, preview_hash)
         VALUES ($1, 'contact', $2, $3, '{}'::jsonb, $4)`,
        [workspace(f), f.crm.alpha.firmId, admin(f), HASH],
      ),
  },
  {
    constraint: 'deletion_requests_state_known',
    run: async f => await request(f, 'state', ['abandoned']),
  },
  {
    constraint: 'deletion_requests_commit_consistent',
    run: async f => await request(f, 'state', ['committed']),
  },
  {
    constraint: 'deletion_requests_preview_is_object',
    run: async f =>
      await f.session.query(
        `INSERT INTO deletion_requests (workspace_id, target_kind, firm_id, requested_by_user_id, preview, preview_hash)
         VALUES ($1, 'firm', $2, $3, '"counts"'::jsonb, $4)`,
        [workspace(f), f.crm.alpha.firmId, admin(f), HASH],
      ),
  },
  {
    constraint: 'deletion_requests_outcome_is_object',
    run: async f => await request(f, 'outcome', ['[]']),
  },
  {
    constraint: 'deletion_requests_preview_hash_shape',
    run: async f =>
      await f.session.query(
        `INSERT INTO deletion_requests (workspace_id, target_kind, firm_id, requested_by_user_id, preview, preview_hash)
         VALUES ($1, 'firm', $2, $3, '{}'::jsonb, 'not-a-digest')`,
        [workspace(f), f.crm.alpha.firmId, admin(f)],
      ),
  },
  {
    constraint: 'deletion_requests_command_id_bounded',
    run: async f => await request(f, 'command_id', ['   ']),
  },
  {
    constraint: 'deletion_requests_tombstones_bounded',
    run: async f =>
      await f.session.query(
        `INSERT INTO deletion_requests (workspace_id, target_kind, firm_id, requested_by_user_id, preview, preview_hash, tombstone_event_ids)
         VALUES ($1, 'firm', $2, $3, '{}'::jsonb, $4,
                 (SELECT array_agg('sup_' || n::text) FROM generate_series(1, 501) AS n))`,
        [workspace(f), f.crm.alpha.firmId, admin(f), HASH],
      ),
  },
  {
    constraint: 'deletion_requests_committed_not_before_requested',
    run: async f =>
      await f.session.query(
        `INSERT INTO deletion_requests (workspace_id, target_kind, firm_id, requested_by_user_id, preview, preview_hash,
                                        requested_at, state, committed_at, committed_by_user_id)
         VALUES ($1, 'firm', $2, $3, '{}'::jsonb, $4, now(), 'committed', now() - INTERVAL '1 hour', $3)`,
        [workspace(f), f.crm.alpha.firmId, admin(f), HASH],
      ),
  },
  {
    constraint: 'deletion_requests_one_per_command',
    run: async f => {
      for (let attempt = 0; attempt < 2; attempt += 1) await request(f, 'command_id', ['deletion-duplicate']);
      return null;
    },
  },

  // ---------------------------------------------------------------- departures
  {
    constraint: 'departures_pkey',
    run: async f => {
      const { rows } = await f.session.query<{ id: string }>(
        'INSERT INTO departures (workspace_id, user_id, requested_by_user_id) VALUES ($1, $2, $3) RETURNING id',
        [workspace(f), salesperson(f), admin(f)],
      );
      return await f.session.query(
        'INSERT INTO departures (workspace_id, id, user_id, requested_by_user_id) VALUES ($1, $2, $3, $4)',
        [workspace(f), rows[0]?.id, admin(f), salesperson(f)],
      );
    },
  },
  {
    constraint: 'departures_one_per_user',
    run: async f => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await f.session.query(
          'INSERT INTO departures (workspace_id, user_id, requested_by_user_id) VALUES ($1, $2, $3)',
          [workspace(f), salesperson(f), admin(f)],
        );
      }
      return null;
    },
  },
  {
    constraint: 'departures_workspace_id_fkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO departures (workspace_id, user_id, requested_by_user_id) VALUES ('00000000-0000-4000-8000-000000000000', $1, $2)",
        [salesperson(f), admin(f)],
      ),
  },
  {
    constraint: 'departures_user_fkey',
    run: async f =>
      await f.session.query(
        'INSERT INTO departures (workspace_id, user_id, requested_by_user_id) VALUES ($1, $2, $3)',
        [workspace(f), f.seeded.beta.salesperson.userId, admin(f)],
      ),
  },
  {
    constraint: 'departures_requester_fkey',
    run: async f =>
      await f.session.query(
        'INSERT INTO departures (workspace_id, user_id, requested_by_user_id) VALUES ($1, $2, $3)',
        [workspace(f), salesperson(f), f.seeded.beta.admin.userId],
      ),
  },
  {
    constraint: 'departures_not_self',
    run: async f =>
      await f.session.query(
        'INSERT INTO departures (workspace_id, user_id, requested_by_user_id) VALUES ($1, $2, $2)',
        [workspace(f), admin(f)],
      ),
  },
  {
    constraint: 'departures_outcome_is_object',
    run: async f =>
      await f.session.query(
        "INSERT INTO departures (workspace_id, user_id, requested_by_user_id, outcome) VALUES ($1, $2, $3, '[]'::jsonb)",
        [workspace(f), salesperson(f), admin(f)],
      ),
  },
  {
    constraint: 'departures_command_id_bounded',
    run: async f =>
      await f.session.query(
        "INSERT INTO departures (workspace_id, user_id, requested_by_user_id, command_id) VALUES ($1, $2, $3, '  ')",
        [workspace(f), salesperson(f), admin(f)],
      ),
  },
  {
    constraint: 'departures_one_per_command',
    run: async f => {
      await f.session.query(
        "INSERT INTO departures (workspace_id, user_id, requested_by_user_id, command_id) VALUES ($1, $2, $3, 'departure-duplicate')",
        [workspace(f), salesperson(f), admin(f)],
      );
      return await f.session.query(
        "INSERT INTO departures (workspace_id, user_id, requested_by_user_id, command_id) VALUES ($1, $2, $3, 'departure-duplicate')",
        [workspace(f), admin(f), salesperson(f)],
      );
    },
  },
];
