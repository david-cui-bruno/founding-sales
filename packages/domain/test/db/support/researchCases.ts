import type { SessionQueryable } from '../../../db/queryable.ts';
import type { TwoWorkspaces } from './fixtures.ts';

/**
 * A failing insert for every constraint the research migration adds (lane G10:
 * settings, approved providers, the provider ledger, the versioned route-eligibility
 * policy, discovery pages, firm coordinates, enrichment runs and suggestions).
 *
 * They live in their own file, appended to `cases` in constraints.test.ts, so two
 * lanes adding migrations at the same time do not both edit the middle of that array
 * — the pattern G3a established in `crmCases.ts`. The coverage test at the bottom of
 * constraints.test.ts is what makes them mandatory: a constraint with no case here
 * fails the build.
 *
 * Each case runs inside a transaction the caller rolls back, and each breaks exactly
 * one thing. "Exactly one" matters: a row that breaks two constraints is reported
 * under whichever index or check PostgreSQL reaches first, and the case would be
 * testing the wrong promise.
 *
 * No real business name, address, coordinate or number appears here.
 */

export interface ResearchCaseFixture {
  readonly session: SessionQueryable;
  readonly seeded: TwoWorkspaces;
}

export interface ResearchCase {
  readonly constraint: string;
  readonly run: (fixture: ResearchCaseFixture) => Promise<unknown>;
}

const workspace = (f: ResearchCaseFixture): string => f.seeded.alpha.workspaceId;
const otherWorkspaceUser = (f: ResearchCaseFixture): string => f.seeded.beta.salesperson.userId;

/** A syntactically valid UUID that is never a row. */
const MISSING = '00000000-0000-4000-8000-000000000000';

let sequence = 0;
/** A hash or key that is unique within one case run, so a case never trips uniqueness by accident. */
const uniqueHash = (): string => {
  sequence += 1;
  return sequence.toString(16).padStart(64, '0');
};
const uniqueLabel = (prefix: string): string => {
  sequence += 1;
  return `${prefix}${String(sequence)}`;
};

async function aFirm(f: ResearchCaseFixture): Promise<string> {
  const { rows } = await f.session.query<{ id: string }>(
    'INSERT INTO firms (workspace_id, name) VALUES ($1, $2) RETURNING id',
    [workspace(f), uniqueLabel('Research Case Firm ')],
  );
  return rows[0]?.id ?? '';
}

async function aContact(f: ResearchCaseFixture, firmId: string): Promise<string> {
  const { rows } = await f.session.query<{ id: string }>(
    'INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, $3) RETURNING id',
    [workspace(f), firmId, uniqueLabel('Research Case Contact ')],
  );
  return rows[0]?.id ?? '';
}

/** An existing policy row's id, for the primary-key case. */
async function aPolicyId(f: ResearchCaseFixture): Promise<string> {
  const { rows } = await f.session.query<{ id: string }>(
    'SELECT id FROM research_route_policies WHERE workspace_id = $1 LIMIT 1',
    [workspace(f)],
  );
  return rows[0]?.id ?? '';
}

/** One discovery page, so the unique and primary-key cases have something to collide with. */
async function aPage(f: ResearchCaseFixture): Promise<{ id: string; queryHash: string; pageHash: string }> {
  const queryHash = uniqueHash();
  const pageHash = uniqueHash();
  const { rows } = await f.session.query<{ id: string }>(
    `INSERT INTO research_pages (workspace_id, provider_key, query_hash, page_hash, query_text)
     VALUES ($1, 'places', $2, $3, 'case query') RETURNING id`,
    [workspace(f), queryHash, pageHash],
  );
  return { id: rows[0]?.id ?? '', queryHash, pageHash };
}

const insertPage = async (
  f: ResearchCaseFixture,
  columns: string,
  values: readonly unknown[],
  literals = '',
): Promise<unknown> =>
  await f.session.query(
    `INSERT INTO research_pages (workspace_id, provider_key, query_hash, page_hash, query_text${columns})
     VALUES ($1, 'places', $2, $3, 'case query'${literals})`,
    [workspace(f), uniqueHash(), uniqueHash(), ...values],
  );

const insertRun = async (
  f: ResearchCaseFixture,
  columns: string,
  literals: string,
  firmId?: string,
): Promise<unknown> => {
  const firm = firmId ?? (await aFirm(f));
  return await f.session.query(
    `INSERT INTO research_firm_runs (workspace_id, firm_id, revision${columns})
     VALUES ($1, $2, 1${literals})`,
    [workspace(f), firm],
  );
};

const insertSuggestion = async (
  f: ResearchCaseFixture,
  columns: string,
  literals: string,
  values: readonly unknown[] = [],
): Promise<unknown> => {
  const firmId = await aFirm(f);
  return await f.session.query(
    `INSERT INTO research_suggestions (workspace_id, firm_id, proposed_value, provider_key, dedupe_key${columns})
     VALUES ($1, $2, 'a proposed value', 'places', $3${literals})`,
    [workspace(f), firmId, uniqueLabel('dedupe-'), ...values],
  );
};

export const RESEARCH_CONSTRAINT_CASES: readonly ResearchCase[] = [
  // ------------------------------------------------------ research_settings
  {
    constraint: 'research_settings_pkey',
    run: async f =>
      // The trigger on `workspaces` already seeded one row for this workspace.
      await f.session.query('INSERT INTO research_settings (workspace_id) VALUES ($1)', [workspace(f)]),
  },
  {
    constraint: 'research_settings_workspace_id_fkey',
    run: async f => await f.session.query('INSERT INTO research_settings (workspace_id) VALUES ($1)', [MISSING]),
  },
  {
    constraint: 'research_settings_editor_fkey',
    run: async f =>
      // A member of the *other* workspace may not be recorded as this one's editor.
      await f.session.query('UPDATE research_settings SET updated_by_user_id = $2 WHERE workspace_id = $1', [
        workspace(f),
        otherWorkspaceUser(f),
      ]),
  },
  {
    constraint: 'research_settings_page_ceiling_range',
    run: async f =>
      await f.session.query('UPDATE research_settings SET daily_page_ceiling = -1 WHERE workspace_id = $1', [
        workspace(f),
      ]),
  },
  {
    constraint: 'research_settings_firm_ceiling_range',
    run: async f =>
      await f.session.query('UPDATE research_settings SET daily_firm_ceiling = 100001 WHERE workspace_id = $1', [
        workspace(f),
      ]),
  },
  {
    constraint: 'research_settings_cost_ceiling_nonnegative',
    run: async f =>
      await f.session.query('UPDATE research_settings SET daily_cost_ceiling_micros = -1 WHERE workspace_id = $1', [
        workspace(f),
      ]),
  },
  {
    constraint: 'research_settings_pages_per_firm_range',
    run: async f =>
      await f.session.query('UPDATE research_settings SET max_pages_per_firm = 0 WHERE workspace_id = $1', [
        workspace(f),
      ]),
  },
  {
    constraint: 'research_settings_page_bytes_range',
    run: async f =>
      await f.session.query('UPDATE research_settings SET max_page_bytes = 1023 WHERE workspace_id = $1', [
        workspace(f),
      ]),
  },
  {
    constraint: 'research_settings_updated_not_before_created',
    run: async f =>
      await f.session.query(
        `UPDATE research_settings
            SET created_at = TIMESTAMPTZ '2026-03-01 00:00:00+00', updated_at = TIMESTAMPTZ '2026-01-01 00:00:00+00'
          WHERE workspace_id = $1`,
        [workspace(f)],
      ),
  },

  // ----------------------------------------------------- research_providers
  {
    constraint: 'research_providers_pkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO research_providers (workspace_id, provider_key, kind, display_name) VALUES ($1, 'places', 'discovery', 'A second Places')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'research_providers_workspace_id_fkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO research_providers (workspace_id, provider_key, kind, display_name) VALUES ($1, 'elsewhere', 'discovery', 'Nowhere')",
        [MISSING],
      ),
  },
  {
    constraint: 'research_providers_editor_fkey',
    run: async f =>
      await f.session.query(
        "UPDATE research_providers SET updated_by_user_id = $2 WHERE workspace_id = $1 AND provider_key = 'places'",
        [workspace(f), otherWorkspaceUser(f)],
      ),
  },
  {
    constraint: 'research_providers_key_shape',
    run: async f =>
      await f.session.query(
        "INSERT INTO research_providers (workspace_id, provider_key, kind, display_name) VALUES ($1, 'Places', 'discovery', 'Capitalised')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'research_providers_kind_known',
    run: async f =>
      await f.session.query(
        "INSERT INTO research_providers (workspace_id, provider_key, kind, display_name) VALUES ($1, 'oracle', 'divination', 'Unknown kind')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'research_providers_display_name_present',
    run: async f =>
      await f.session.query(
        "INSERT INTO research_providers (workspace_id, provider_key, kind, display_name) VALUES ($1, 'blank', 'discovery', '   ')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'research_providers_cost_nonnegative',
    run: async f =>
      await f.session.query(
        "UPDATE research_providers SET cost_per_call_micros = -1 WHERE workspace_id = $1 AND provider_key = 'places'",
        [workspace(f)],
      ),
  },
  {
    constraint: 'research_providers_ceiling_range',
    run: async f =>
      await f.session.query(
        "UPDATE research_providers SET daily_call_ceiling = 100001 WHERE workspace_id = $1 AND provider_key = 'places'",
        [workspace(f)],
      ),
  },
  {
    constraint: 'research_providers_retention_consistent',
    run: async f =>
      // Terms forbid retention, and no expiry says how long the evidence may live.
      await f.session.query(
        "UPDATE research_providers SET terms_allow_retention = false, retention_days = NULL WHERE workspace_id = $1 AND provider_key = 'places'",
        [workspace(f)],
      ),
  },
  {
    constraint: 'research_providers_retention_days_range',
    run: async f =>
      await f.session.query(
        "UPDATE research_providers SET retention_days = 0 WHERE workspace_id = $1 AND provider_key = 'places'",
        [workspace(f)],
      ),
  },
  {
    constraint: 'research_providers_updated_not_before_created',
    run: async f =>
      await f.session.query(
        `UPDATE research_providers
            SET created_at = TIMESTAMPTZ '2026-03-01 00:00:00+00', updated_at = TIMESTAMPTZ '2026-01-01 00:00:00+00'
          WHERE workspace_id = $1 AND provider_key = 'places'`,
        [workspace(f)],
      ),
  },

  // ----------------------------------------------- research_provider_ledger
  {
    constraint: 'research_provider_ledger_pkey',
    run: async f => {
      await f.session.query(
        `INSERT INTO research_provider_ledger (workspace_id, provider_key, business_date, business_time_zone)
         VALUES ($1, 'places', DATE '2026-09-20', 'America/New_York')`,
        [workspace(f)],
      );
      return await f.session.query(
        `INSERT INTO research_provider_ledger (workspace_id, provider_key, business_date, business_time_zone)
         VALUES ($1, 'places', DATE '2026-09-20', 'America/New_York')`,
        [workspace(f)],
      );
    },
  },
  {
    constraint: 'research_provider_ledger_provider_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO research_provider_ledger (workspace_id, provider_key, business_date, business_time_zone)
         VALUES ($1, 'never_approved', DATE '2026-09-20', 'America/New_York')`,
        [workspace(f)],
      ),
  },
  {
    // A negative call count cannot be isolated: `failures <= calls` makes every
    // non-negative failure count illegal beside it, so this row breaks the failure
    // check too. PostgreSQL reports the constraints of a relation in name order, and
    // `calls_nonnegative` sorts first, which is the one under test.
    constraint: 'research_provider_ledger_calls_nonnegative',
    run: async f =>
      await f.session.query(
        `INSERT INTO research_provider_ledger (workspace_id, provider_key, business_date, business_time_zone, calls, failures)
         VALUES ($1, 'places', DATE '2026-09-20', 'America/New_York', -1, -1)`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'research_provider_ledger_failures_nonnegative',
    run: async f =>
      await f.session.query(
        `INSERT INTO research_provider_ledger (workspace_id, provider_key, business_date, business_time_zone, calls, failures)
         VALUES ($1, 'places', DATE '2026-09-20', 'America/New_York', 0, -1)`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'research_provider_ledger_failures_within_calls',
    run: async f =>
      await f.session.query(
        `INSERT INTO research_provider_ledger (workspace_id, provider_key, business_date, business_time_zone, calls, failures)
         VALUES ($1, 'places', DATE '2026-09-20', 'America/New_York', 0, 1)`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'research_provider_ledger_cost_nonnegative',
    run: async f =>
      await f.session.query(
        `INSERT INTO research_provider_ledger (workspace_id, provider_key, business_date, business_time_zone, cost_micros)
         VALUES ($1, 'places', DATE '2026-09-20', 'America/New_York', -1)`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'research_provider_ledger_failure_code_shape',
    run: async f =>
      await f.session.query(
        `INSERT INTO research_provider_ledger (workspace_id, provider_key, business_date, business_time_zone,
                                               calls, failures, last_failure_code, last_failure_at)
         VALUES ($1, 'places', DATE '2026-09-20', 'America/New_York', 1, 1, 'Provider Rejected', now())`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'research_provider_ledger_failure_recorded',
    run: async f =>
      await f.session.query(
        `INSERT INTO research_provider_ledger (workspace_id, provider_key, business_date, business_time_zone,
                                               calls, failures, last_failure_code)
         VALUES ($1, 'places', DATE '2026-09-20', 'America/New_York', 1, 1, 'provider_rejected')`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'research_provider_ledger_business_time_zone_shape',
    run: async f =>
      await f.session.query(
        `INSERT INTO research_provider_ledger (workspace_id, provider_key, business_date, business_time_zone)
         VALUES ($1, 'places', DATE '2026-09-20', 'EST5EDT?')`,
        [workspace(f)],
      ),
  },

  // ------------------------------------------------ research_route_policies
  {
    constraint: 'research_route_policies_pkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO research_route_policies (id, workspace_id, version, minimum_association_confidence)
         VALUES ($2, $1, 'route-policy.9', 0.900)`,
        [workspace(f), await aPolicyId(f)],
      ),
  },
  {
    constraint: 'research_route_policies_workspace_id_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO research_route_policies (workspace_id, version, minimum_association_confidence)
         VALUES ($1, 'route-policy.9', 0.900)`,
        [MISSING],
      ),
  },
  {
    constraint: 'research_route_policies_version_unique',
    run: async f =>
      await f.session.query(
        `INSERT INTO research_route_policies (workspace_id, version, minimum_association_confidence)
         VALUES ($1, 'route-policy.1', 0.900)`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'research_route_policies_author_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO research_route_policies (workspace_id, version, minimum_association_confidence, created_by_user_id)
         VALUES ($1, 'route-policy.9', 0.900, $2)`,
        [workspace(f), otherWorkspaceUser(f)],
      ),
  },
  {
    constraint: 'research_route_policies_version_shape',
    run: async f =>
      await f.session.query(
        `INSERT INTO research_route_policies (workspace_id, version, minimum_association_confidence)
         VALUES ($1, 'Route Policy 9', 0.900)`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'research_route_policies_confidence_range',
    run: async f =>
      await f.session.query(
        `INSERT INTO research_route_policies (workspace_id, version, minimum_association_confidence)
         VALUES ($1, 'route-policy.9', 1.500)`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'research_route_policies_trusted_sources_known',
    run: async f =>
      await f.session.query(
        `INSERT INTO research_route_policies (workspace_id, version, minimum_association_confidence, trusted_sources)
         VALUES ($1, 'route-policy.9', 0.900, ARRAY['a_model']::text[])`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'research_route_policies_note_bounded',
    run: async f =>
      await f.session.query(
        `INSERT INTO research_route_policies (workspace_id, version, minimum_association_confidence, note)
         VALUES ($1, 'route-policy.9', 0.900, '   ')`,
        [workspace(f)],
      ),
  },

  // --------------------------------------------------------- research_pages
  {
    constraint: 'research_pages_pkey',
    run: async f => {
      const page = await aPage(f);
      return await f.session.query(
        `INSERT INTO research_pages (id, workspace_id, provider_key, query_hash, page_hash, query_text)
         VALUES ($2, $1, 'places', $3, $4, 'case query')`,
        [workspace(f), page.id, uniqueHash(), uniqueHash()],
      );
    },
  },
  {
    constraint: 'research_pages_one_per_result',
    run: async f => {
      const page = await aPage(f);
      return await f.session.query(
        `INSERT INTO research_pages (workspace_id, provider_key, query_hash, page_hash, query_text)
         VALUES ($1, 'places', $2, $3, 'the same page again')`,
        [workspace(f), page.queryHash, page.pageHash],
      );
    },
  },
  {
    constraint: 'research_pages_provider_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO research_pages (workspace_id, provider_key, query_hash, page_hash, query_text)
         VALUES ($1, 'never_approved', $2, $3, 'case query')`,
        [workspace(f), uniqueHash(), uniqueHash()],
      ),
  },
  {
    constraint: 'research_pages_requester_fkey',
    run: async f => await insertPage(f, ', requested_by_user_id', [otherWorkspaceUser(f)], ', $4'),
  },
  {
    constraint: 'research_pages_query_hash_shape',
    run: async f =>
      await f.session.query(
        `INSERT INTO research_pages (workspace_id, provider_key, query_hash, page_hash, query_text)
         VALUES ($1, 'places', 'not-a-digest', $2, 'case query')`,
        [workspace(f), uniqueHash()],
      ),
  },
  {
    constraint: 'research_pages_page_hash_shape',
    run: async f =>
      await f.session.query(
        `INSERT INTO research_pages (workspace_id, provider_key, query_hash, page_hash, query_text)
         VALUES ($1, 'places', $2, 'NOT-A-DIGEST', 'case query')`,
        [workspace(f), uniqueHash()],
      ),
  },
  {
    constraint: 'research_pages_query_text_present',
    run: async f =>
      await f.session.query(
        `INSERT INTO research_pages (workspace_id, provider_key, query_hash, page_hash, query_text)
         VALUES ($1, 'places', $2, $3, '   ')`,
        [workspace(f), uniqueHash(), uniqueHash()],
      ),
  },
  {
    constraint: 'research_pages_page_token_bounded',
    run: async f => await insertPage(f, ', page_token', [], ", '   '"),
  },
  {
    constraint: 'research_pages_outcome_known',
    run: async f => await insertPage(f, ', outcome, completed_at, refusal_code', [], ", 'abandoned', now(), 'gave_up'"),
  },
  {
    constraint: 'research_pages_completion_consistent',
    run: async f => await insertPage(f, ', outcome, completed_at', [], ", 'running', now()"),
  },
  {
    constraint: 'research_pages_refusal_consistent',
    run: async f => await insertPage(f, ', outcome, completed_at', [], ", 'failed', now()"),
  },
  {
    constraint: 'research_pages_refusal_code_shape',
    run: async f =>
      await insertPage(f, ', outcome, completed_at, refusal_code', [], ", 'failed', now(), 'Provider Rejected'"),
  },
  {
    constraint: 'research_pages_candidate_count_nonnegative',
    run: async f => await insertPage(f, ', candidate_count, firms_created', [], ', -1, -1'),
  },
  {
    constraint: 'research_pages_firms_created_within_candidates',
    run: async f => await insertPage(f, ', candidate_count, firms_created', [], ', 0, 1'),
  },
  {
    constraint: 'research_pages_evidence_recorded_nonnegative',
    run: async f => await insertPage(f, ', evidence_recorded', [], ', -1'),
  },
  {
    constraint: 'research_pages_cost_nonnegative',
    run: async f => await insertPage(f, ', cost_micros', [], ', -1'),
  },
  {
    constraint: 'research_pages_skipped_is_object',
    run: async f => await insertPage(f, ', skipped', [], ", '[]'::jsonb"),
  },

  // ---------------------------------------------------------- firm_locations
  {
    constraint: 'firm_locations_pkey',
    run: async f => {
      const firmId = await aFirm(f);
      const insert = `INSERT INTO firm_locations (workspace_id, firm_id, latitude, longitude, provider_key, source_reference, retrieved_at)
         VALUES ($1, $2, 10.00000, 20.00000, 'places', 'place-ref', now())`;
      await f.session.query(insert, [workspace(f), firmId]);
      return await f.session.query(insert, [workspace(f), firmId]);
    },
  },
  {
    constraint: 'firm_locations_firm_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO firm_locations (workspace_id, firm_id, latitude, longitude, provider_key, source_reference, retrieved_at)
         VALUES ($1, $2, 10.00000, 20.00000, 'places', 'place-ref', now())`,
        [workspace(f), MISSING],
      ),
  },
  {
    constraint: 'firm_locations_latitude_range',
    run: async f =>
      await f.session.query(
        `INSERT INTO firm_locations (workspace_id, firm_id, latitude, longitude, provider_key, source_reference, retrieved_at)
         VALUES ($1, $2, 91.00000, 20.00000, 'places', 'place-ref', now())`,
        [workspace(f), await aFirm(f)],
      ),
  },
  {
    constraint: 'firm_locations_longitude_range',
    run: async f =>
      await f.session.query(
        `INSERT INTO firm_locations (workspace_id, firm_id, latitude, longitude, provider_key, source_reference, retrieved_at)
         VALUES ($1, $2, 10.00000, 181.00000, 'places', 'place-ref', now())`,
        [workspace(f), await aFirm(f)],
      ),
  },
  {
    constraint: 'firm_locations_provider_key_shape',
    run: async f =>
      await f.session.query(
        `INSERT INTO firm_locations (workspace_id, firm_id, latitude, longitude, provider_key, source_reference, retrieved_at)
         VALUES ($1, $2, 10.00000, 20.00000, 'Places', 'place-ref', now())`,
        [workspace(f), await aFirm(f)],
      ),
  },
  {
    constraint: 'firm_locations_source_reference_present',
    run: async f =>
      await f.session.query(
        `INSERT INTO firm_locations (workspace_id, firm_id, latitude, longitude, provider_key, source_reference, retrieved_at)
         VALUES ($1, $2, 10.00000, 20.00000, 'places', '   ', now())`,
        [workspace(f), await aFirm(f)],
      ),
  },
  {
    constraint: 'firm_locations_updated_not_before_created',
    run: async f =>
      await f.session.query(
        `INSERT INTO firm_locations (workspace_id, firm_id, latitude, longitude, provider_key, source_reference,
                                     retrieved_at, created_at, updated_at)
         VALUES ($1, $2, 10.00000, 20.00000, 'places', 'place-ref', now(),
                 TIMESTAMPTZ '2026-03-01 00:00:00+00', TIMESTAMPTZ '2026-01-01 00:00:00+00')`,
        [workspace(f), await aFirm(f)],
      ),
  },

  // ----------------------------------------------------- research_firm_runs
  {
    constraint: 'research_firm_runs_pkey',
    run: async f => {
      const firmId = await aFirm(f);
      const { rows } = await f.session.query<{ id: string }>(
        'INSERT INTO research_firm_runs (workspace_id, firm_id, revision) VALUES ($1, $2, 1) RETURNING id',
        [workspace(f), firmId],
      );
      return await f.session.query(
        'INSERT INTO research_firm_runs (id, workspace_id, firm_id, revision) VALUES ($3, $1, $2, 2)',
        [workspace(f), firmId, rows[0]?.id],
      );
    },
  },
  {
    constraint: 'research_firm_runs_one_per_revision',
    run: async f => {
      const firmId = await aFirm(f);
      await f.session.query('INSERT INTO research_firm_runs (workspace_id, firm_id, revision) VALUES ($1, $2, 1)', [
        workspace(f),
        firmId,
      ]);
      return await f.session.query(
        'INSERT INTO research_firm_runs (workspace_id, firm_id, revision) VALUES ($1, $2, 1)',
        [workspace(f), firmId],
      );
    },
  },
  {
    constraint: 'research_firm_runs_firm_fkey',
    run: async f =>
      await f.session.query('INSERT INTO research_firm_runs (workspace_id, firm_id, revision) VALUES ($1, $2, 1)', [
        workspace(f),
        MISSING,
      ]),
  },
  {
    constraint: 'research_firm_runs_revision_positive',
    run: async f =>
      await f.session.query('INSERT INTO research_firm_runs (workspace_id, firm_id, revision) VALUES ($1, $2, 0)', [
        workspace(f),
        await aFirm(f),
      ]),
  },
  {
    constraint: 'research_firm_runs_outcome_known',
    run: async f => await insertRun(f, ', outcome, completed_at, refusal_code', ", 'abandoned', now(), 'gave_up'"),
  },
  {
    constraint: 'research_firm_runs_completion_consistent',
    run: async f => await insertRun(f, ', outcome, completed_at', ", 'running', now()"),
  },
  {
    constraint: 'research_firm_runs_refusal_consistent',
    run: async f => await insertRun(f, ', outcome, completed_at', ", 'refused', now()"),
  },
  {
    constraint: 'research_firm_runs_refusal_code_shape',
    run: async f =>
      await insertRun(f, ', outcome, completed_at, refusal_code', ", 'refused', now(), 'Firm Suppressed'"),
  },
  {
    constraint: 'research_firm_runs_evidence_nonnegative',
    run: async f => await insertRun(f, ', evidence_recorded', ', -1'),
  },
  {
    constraint: 'research_firm_runs_suggestions_nonnegative',
    run: async f => await insertRun(f, ', suggestions_created', ', -1'),
  },
  {
    constraint: 'research_firm_runs_routes_nonnegative',
    run: async f => await insertRun(f, ', routes_promoted', ', -1'),
  },
  {
    constraint: 'research_firm_runs_cost_nonnegative',
    run: async f => await insertRun(f, ', cost_micros', ', -1'),
  },

  // --------------------------------------------------- research_suggestions
  {
    constraint: 'research_suggestions_pkey',
    run: async f => {
      const firmId = await aFirm(f);
      const { rows } = await f.session.query<{ id: string }>(
        `INSERT INTO research_suggestions (workspace_id, firm_id, kind, proposed_value, provider_key, dedupe_key)
         VALUES ($1, $2, 'contact', 'Someone Example', 'places', 'first') RETURNING id`,
        [workspace(f), firmId],
      );
      return await f.session.query(
        `INSERT INTO research_suggestions (id, workspace_id, firm_id, kind, proposed_value, provider_key, dedupe_key)
         VALUES ($3, $1, $2, 'contact', 'Someone Else Example', 'places', 'second')`,
        [workspace(f), firmId, rows[0]?.id],
      );
    },
  },
  {
    constraint: 'research_suggestions_one_per_finding',
    run: async f => {
      const firmId = await aFirm(f);
      const insert = `INSERT INTO research_suggestions (workspace_id, firm_id, kind, proposed_value, provider_key, dedupe_key)
         VALUES ($1, $2, 'contact', 'Someone Example', 'places', 'the-same-finding')`;
      await f.session.query(insert, [workspace(f), firmId]);
      return await f.session.query(insert, [workspace(f), firmId]);
    },
  },
  {
    constraint: 'research_suggestions_firm_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO research_suggestions (workspace_id, firm_id, kind, proposed_value, provider_key, dedupe_key)
         VALUES ($1, $2, 'contact', 'Someone Example', 'places', 'missing-firm')`,
        [workspace(f), MISSING],
      ),
  },
  {
    constraint: 'research_suggestions_contact_fkey',
    run: async f => {
      // A contact at one firm may not be named by a suggestion about another.
      const otherFirm = await aFirm(f);
      const contactId = await aContact(f, otherFirm);
      return await f.session.query(
        `INSERT INTO research_suggestions (workspace_id, firm_id, contact_id, kind, proposed_value, provider_key, dedupe_key)
         VALUES ($1, $2, $3, 'contact', 'Someone Example', 'places', 'crossed-firms')`,
        [workspace(f), await aFirm(f), contactId],
      );
    },
  },
  {
    constraint: 'research_suggestions_evidence_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO research_suggestions (workspace_id, firm_id, kind, proposed_value, provider_key, dedupe_key, evidence_id)
         VALUES ($1, $2, 'contact', 'Someone Example', 'places', 'missing-evidence', $3)`,
        [workspace(f), await aFirm(f), MISSING],
      ),
  },
  {
    constraint: 'research_suggestions_duplicate_firm_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO research_suggestions (workspace_id, firm_id, kind, proposed_value, provider_key, dedupe_key, duplicate_firm_id)
         VALUES ($1, $2, 'duplicate_firm', 'looks like a duplicate', 'places', 'missing-twin', $3)`,
        [workspace(f), await aFirm(f), MISSING],
      ),
  },
  {
    constraint: 'research_suggestions_reviewer_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO research_suggestions (workspace_id, firm_id, kind, proposed_value, provider_key, dedupe_key,
                                           state, reviewed_by_user_id, reviewed_at)
         VALUES ($1, $2, 'contact', 'Someone Example', 'places', 'foreign-reviewer', 'accepted', $3, now())`,
        [workspace(f), await aFirm(f), otherWorkspaceUser(f)],
      ),
  },
  {
    constraint: 'research_suggestions_kind_known',
    run: async f => await insertSuggestion(f, ', kind', ", 'a_hunch'"),
  },
  {
    constraint: 'research_suggestions_field_key_consistent',
    run: async f =>
      // A contact suggestion has no canonical field to fill.
      await insertSuggestion(f, ', kind, field_key', ", 'contact', 'website'"),
  },
  {
    constraint: 'research_suggestions_field_key_shape',
    run: async f => await insertSuggestion(f, ', kind, field_key', ", 'canonical_field', 'Website'"),
  },
  {
    constraint: 'research_suggestions_duplicate_consistent',
    run: async f => await insertSuggestion(f, ', kind', ", 'duplicate_firm'"),
  },
  {
    constraint: 'research_suggestions_duplicate_not_self',
    run: async f => {
      const firmId = await aFirm(f);
      return await f.session.query(
        `INSERT INTO research_suggestions (workspace_id, firm_id, kind, proposed_value, provider_key, dedupe_key, duplicate_firm_id)
         VALUES ($1, $2, 'duplicate_firm', 'itself', 'places', 'self-twin', $2)`,
        [workspace(f), firmId],
      );
    },
  },
  {
    constraint: 'research_suggestions_proposed_value_present',
    run: async f => {
      const firmId = await aFirm(f);
      return await f.session.query(
        `INSERT INTO research_suggestions (workspace_id, firm_id, kind, proposed_value, provider_key, dedupe_key)
         VALUES ($1, $2, 'contact', '   ', 'places', 'blank-value')`,
        [workspace(f), firmId],
      );
    },
  },
  {
    constraint: 'research_suggestions_confidence_range',
    run: async f => await insertSuggestion(f, ', kind, confidence', ", 'contact', 1.500"),
  },
  {
    constraint: 'research_suggestions_provider_key_shape',
    run: async f => {
      const firmId = await aFirm(f);
      return await f.session.query(
        `INSERT INTO research_suggestions (workspace_id, firm_id, kind, proposed_value, provider_key, dedupe_key)
         VALUES ($1, $2, 'contact', 'Someone Example', 'Places', 'bad-provider')`,
        [workspace(f), firmId],
      );
    },
  },
  {
    constraint: 'research_suggestions_dedupe_key_present',
    run: async f => {
      const firmId = await aFirm(f);
      return await f.session.query(
        `INSERT INTO research_suggestions (workspace_id, firm_id, kind, proposed_value, provider_key, dedupe_key)
         VALUES ($1, $2, 'contact', 'Someone Example', 'places', '   ')`,
        [workspace(f), firmId],
      );
    },
  },
  {
    constraint: 'research_suggestions_state_known',
    run: async f => await insertSuggestion(f, ', kind, state', ", 'contact', 'nearly_accepted'"),
  },
  {
    constraint: 'research_suggestions_only_facts_apply',
    run: async f =>
      // Only a canonical field may be applied without a person. A contact never is.
      await insertSuggestion(f, ', kind, state', ", 'contact', 'applied'"),
  },
  {
    constraint: 'research_suggestions_review_consistent',
    run: async f => await insertSuggestion(f, ', kind, state', ", 'contact', 'accepted'"),
  },
  {
    constraint: 'research_suggestions_review_time_recorded',
    run: async f => {
      const firmId = await aFirm(f);
      return await f.session.query(
        `INSERT INTO research_suggestions (workspace_id, firm_id, kind, proposed_value, provider_key, dedupe_key,
                                           state, reviewed_by_user_id)
         VALUES ($1, $2, 'contact', 'Someone Example', 'places', 'no-review-time', 'accepted', $3)`,
        [workspace(f), firmId, f.seeded.alpha.admin.userId],
      );
    },
  },
  {
    constraint: 'research_suggestions_review_note_bounded',
    run: async f => await insertSuggestion(f, ', kind, review_note', ", 'contact', '   '"),
  },
  {
    constraint: 'research_suggestions_updated_not_before_created',
    run: async f =>
      await insertSuggestion(
        f,
        ', kind, created_at, updated_at',
        ", 'contact', TIMESTAMPTZ '2026-03-01 00:00:00+00', TIMESTAMPTZ '2026-01-01 00:00:00+00'",
      ),
  },
];
