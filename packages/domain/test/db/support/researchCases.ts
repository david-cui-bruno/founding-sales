import type { SessionQueryable } from '../../../db/queryable.ts';
import type { TwoWorkspaces } from './fixtures.ts';
import type { SeededCrm } from './crmFixtures.ts';

/**
 * A failing insert for every constraint migration 0022 adds.
 *
 * The coverage test at the bottom of `constraints.test.ts` asks the catalog for the
 * enforced set and fails when one has no case, so this file is not optional and its
 * length is the migration's, not a choice.
 *
 * Each case is written to break exactly **one** constraint, and the others on the
 * same row are deliberately satisfied. Where two are about the same relationship —
 * `provider_ledger_calls_nonnegative` and `provider_ledger_failures_within_calls`
 * both concern `calls` — the row is chosen so only the one under test can fire.
 * PostgreSQL evaluates a table's CHECK constraints in **name order** and reports the
 * first that fails, which is why, for example, the `research_runs_outcome_known` case
 * has to satisfy `research_runs_completion_consistent`: `c` comes before `o`.
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
const firm = (f: Fixture): string => f.crm.alpha.firmId;
/** A member of the *other* workspace: a real user id that breaks a scoped membership FK. */
const stranger = (f: Fixture): string => f.seeded.beta.admin.userId;
const ABSENT = '00000000-0000-4000-8000-0000000000ff';
const HASH = 'b'.repeat(64);

/** A settings row that satisfies everything, for a case to break one column of. */
const settings = async (f: Fixture, columns: string, values: readonly unknown[]): Promise<unknown> =>
  await f.session.query(
    `INSERT INTO research_settings (workspace_id, ${columns})
     VALUES ($1, ${values.map((_, index) => `$${String(index + 2)}`).join(', ')})`,
    [workspace(f), ...values],
  );

/** A completed run this firm can hang facts and a judgment off. */
async function seedRun(f: Fixture, revision = 1): Promise<string> {
  const { rows } = await f.session.query<{ id: string }>(
    `INSERT INTO research_runs (workspace_id, firm_id, revision, trigger, completed_at, outcome)
     VALUES ($1, $2, $3, 'sweep', now(), 'completed') RETURNING id`,
    [workspace(f), firm(f), revision],
  );
  return rows[0]?.id ?? '';
}

/** One evidence item a fact can point at. */
async function seedEvidence(f: Fixture, hash = HASH): Promise<string> {
  const { rows } = await f.session.query<{ id: string }>(
    `INSERT INTO evidence_items (workspace_id, firm_id, provider, source_reference, content_hash)
     VALUES ($1, $2, 'company_page', 'https://example.test/', $3) RETURNING id`,
    [workspace(f), firm(f), hash],
  );
  return rows[0]?.id ?? '';
}

/** A fact row that satisfies everything, for a case to break one column of. */
const fact = async (f: Fixture, overrides: Readonly<Record<string, unknown>>): Promise<unknown> => {
  const runId = overrides['run_id'] ?? (await seedRun(f));
  const evidenceId = overrides['evidence_id'] ?? (await seedEvidence(f));
  const row: Record<string, unknown> = {
    workspace_id: workspace(f),
    firm_id: firm(f),
    run_id: runId,
    evidence_id: evidenceId,
    key: 'target_fit',
    block_id: 'b1',
    quote: 'We manage residential property for owners.',
    confidence: null,
    retrieved_at: new Date().toISOString(),
    ...overrides,
  };
  const columns = Object.keys(row);
  return await f.session.query(
    `INSERT INTO firm_facts (${columns.join(', ')})
     VALUES (${columns.map((_, index) => `$${String(index + 1)}`).join(', ')})`,
    columns.map(column => row[column]),
  );
};

/** A judgment row that satisfies everything, for a case to break one column of. */
const judgment = async (f: Fixture, overrides: Readonly<Record<string, unknown>>): Promise<unknown> => {
  const runId = overrides['run_id'] ?? (await seedRun(f));
  const row: Record<string, unknown> = {
    workspace_id: workspace(f),
    firm_id: firm(f),
    run_id: runId,
    fit: 'unknown',
    problem_evidence: 'unknown',
    timing: 'unknown',
    reachability: 'unknown',
    reasons: '{}',
    call_first: false,
    likely_contact_id: null,
    ...overrides,
  };
  const columns = Object.keys(row);
  return await f.session.query(
    `INSERT INTO firm_judgments (${columns.join(', ')})
     VALUES (${columns.map((_, index) => `$${String(index + 1)}`).join(', ')})`,
    columns.map(column => row[column]),
  );
};

/** A run row that satisfies everything, for a case to break one column of. */
const runRow = async (f: Fixture, overrides: Readonly<Record<string, unknown>>): Promise<unknown> => {
  const row: Record<string, unknown> = {
    workspace_id: workspace(f),
    firm_id: firm(f),
    revision: 1,
    trigger: 'sweep',
    requested_by_user_id: null,
    completed_at: new Date().toISOString(),
    outcome: 'completed',
    refusal_code: null,
    pages_fetched: 0,
    facts_recorded: 0,
    model_name: null,
    input_tokens: 0,
    output_tokens: 0,
    cost_cents: 0,
    brief: null,
    ...overrides,
  };
  const columns = Object.keys(row);
  return await f.session.query(
    `INSERT INTO research_runs (${columns.join(', ')})
     VALUES (${columns.map((_, index) => `$${String(index + 1)}`).join(', ')})`,
    columns.map(column => row[column]),
  );
};

/** A link row that satisfies everything. */
const link = async (f: Fixture, overrides: Readonly<Record<string, unknown>>): Promise<unknown> => {
  const row: Record<string, unknown> = {
    workspace_id: workspace(f),
    firm_id: firm(f),
    url: 'https://example.test/news',
    added_by_user_id: f.seeded.alpha.admin.userId,
    ...overrides,
  };
  const columns = Object.keys(row);
  return await f.session.query(
    `INSERT INTO firm_links (${columns.join(', ')})
     VALUES (${columns.map((_, index) => `$${String(index + 1)}`).join(', ')})`,
    columns.map(column => row[column]),
  );
};

/** A ledger row that satisfies everything. */
const ledger = async (f: Fixture, overrides: Readonly<Record<string, unknown>>): Promise<unknown> => {
  const row: Record<string, unknown> = {
    workspace_id: workspace(f),
    provider_key: 'company_page',
    business_date: '2026-09-28',
    business_time_zone: 'America/New_York',
    calls: 1,
    failures: 0,
    cost_cents: 0,
    last_failure_code: null,
    last_failure_at: null,
    ...overrides,
  };
  const columns = Object.keys(row);
  return await f.session.query(
    `INSERT INTO provider_ledger (${columns.join(', ')})
     VALUES (${columns.map((_, index) => `$${String(index + 1)}`).join(', ')})`,
    columns.map(column => row[column]),
  );
};

export const RESEARCH_CONSTRAINT_CASES: readonly Case[] = [
  // -------------------------------------------------------- research_settings
  {
    constraint: 'research_settings_pkey',
    run: async f => {
      await settings(f, 'enabled', [true]);
      return await settings(f, 'enabled', [false]);
    },
  },
  {
    constraint: 'research_settings_workspace_id_fkey',
    run: async f =>
      await f.session.query('INSERT INTO research_settings (workspace_id) VALUES ($1)', [ABSENT]),
  },
  {
    constraint: 'research_settings_editor_fkey',
    run: async f => await settings(f, 'updated_by_user_id', [stranger(f)]),
  },
  {
    constraint: 'research_settings_firm_ceiling_range',
    run: async f => await settings(f, 'daily_firm_ceiling', [10_001]),
  },
  {
    constraint: 'research_settings_daily_cost_nonnegative',
    run: async f => await settings(f, 'daily_cost_ceiling_cents', [-1]),
  },
  {
    constraint: 'research_settings_monthly_cost_nonnegative',
    run: async f => await settings(f, 'monthly_cost_ceiling_cents', [-1]),
  },
  {
    constraint: 'research_settings_pages_per_firm_range',
    run: async f => await settings(f, 'max_pages_per_firm', [9]),
  },
  {
    constraint: 'research_settings_page_bytes_range',
    run: async f => await settings(f, 'max_page_bytes', [1023]),
  },
  {
    constraint: 'research_settings_model_known',
    // A model with no reviewed price row in `pricing.ts` cannot be cleared, so it
    // cannot be stored either. The CHECK and the price table are the same fact.
    run: async f => await settings(f, 'model_name', ['claude-opus-5']),
  },
  {
    constraint: 'research_settings_updated_not_before_created',
    run: async f => await settings(f, 'created_at, updated_at', ['2026-09-28T12:00:00Z', '2026-09-28T11:00:00Z']),
  },

  // ------------------------------------------------------------ research_runs
  {
    constraint: 'research_runs_pkey',
    run: async f => {
      const id = await seedRun(f, 1);
      return await runRow(f, { id, revision: 2 });
    },
  },
  {
    constraint: 'research_runs_one_per_revision',
    run: async f => {
      await seedRun(f, 1);
      return await runRow(f, { revision: 1 });
    },
  },
  { constraint: 'research_runs_firm_fkey', run: async f => await runRow(f, { firm_id: ABSENT }) },
  {
    constraint: 'research_runs_requester_fkey',
    run: async f => await runRow(f, { trigger: 'user_request', requested_by_user_id: stranger(f) }),
  },
  { constraint: 'research_runs_revision_positive', run: async f => await runRow(f, { revision: 0 }) },
  { constraint: 'research_runs_trigger_known', run: async f => await runRow(f, { trigger: 'guesswork' }) },
  {
    constraint: 'research_runs_requester_consistent',
    // A sweep nobody asked for, carrying somebody's name.
    run: async f => await runRow(f, { requested_by_user_id: f.seeded.alpha.admin.userId }),
  },
  {
    constraint: 'research_runs_outcome_known',
    // `completed_at` is set so `research_runs_completion_consistent` — which comes
    // first in name order — is satisfied and the error names this one.
    run: async f => await runRow(f, { outcome: 'nearly' }),
  },
  {
    constraint: 'research_runs_completion_consistent',
    run: async f => await runRow(f, { outcome: 'running', completed_at: new Date().toISOString() }),
  },
  {
    constraint: 'research_runs_refusal_consistent',
    run: async f => await runRow(f, { outcome: 'completed', refusal_code: 'no_sources' }),
  },
  {
    constraint: 'research_runs_refusal_code_shape',
    run: async f => await runRow(f, { outcome: 'refused', refusal_code: 'NO SOURCES' }),
  },
  { constraint: 'research_runs_pages_nonnegative', run: async f => await runRow(f, { pages_fetched: -1 }) },
  { constraint: 'research_runs_facts_nonnegative', run: async f => await runRow(f, { facts_recorded: -1 }) },
  {
    constraint: 'research_runs_model_name_shape',
    run: async f => await runRow(f, { model_name: 'Claude Haiku 4.5' }),
  },
  { constraint: 'research_runs_input_tokens_nonnegative', run: async f => await runRow(f, { input_tokens: -1 }) },
  { constraint: 'research_runs_output_tokens_nonnegative', run: async f => await runRow(f, { output_tokens: -1 }) },
  { constraint: 'research_runs_cost_nonnegative', run: async f => await runRow(f, { cost_cents: -1 }) },
  {
    constraint: 'research_runs_brief_is_bounded_object',
    run: async f => await runRow(f, { brief: '["not an object"]' }),
  },

  // --------------------------------------------------------------- firm_facts
  {
    constraint: 'firm_facts_pkey',
    run: async f => {
      const runId = await seedRun(f);
      const evidenceId = await seedEvidence(f);
      const { rows } = await f.session.query<{ id: string }>(
        `INSERT INTO firm_facts (workspace_id, firm_id, run_id, evidence_id, key, block_id, quote, retrieved_at)
         VALUES ($1, $2, $3, $4, 'target_fit', 'b1', 'We manage property.', now()) RETURNING id`,
        [workspace(f), firm(f), runId, evidenceId],
      );
      // A different key, so only the primary key can fire.
      return await fact(f, { id: rows[0]?.id, run_id: runId, evidence_id: evidenceId, key: 'ownership' });
    },
  },
  {
    constraint: 'firm_facts_one_per_selection',
    run: async f => {
      const runId = await seedRun(f);
      const evidenceId = await seedEvidence(f);
      await fact(f, { run_id: runId, evidence_id: evidenceId });
      return await fact(f, { run_id: runId, evidence_id: evidenceId });
    },
  },
  { constraint: 'firm_facts_firm_fkey', run: async f => await fact(f, { firm_id: ABSENT }) },
  { constraint: 'firm_facts_run_fkey', run: async f => await fact(f, { run_id: ABSENT }) },
  { constraint: 'firm_facts_evidence_fkey', run: async f => await fact(f, { evidence_id: ABSENT }) },
  { constraint: 'firm_facts_key_shape', run: async f => await fact(f, { key: 'TargetFit' }) },
  { constraint: 'firm_facts_block_id_bounded', run: async f => await fact(f, { block_id: '  ' }) },
  { constraint: 'firm_facts_quote_present', run: async f => await fact(f, { quote: '   ' }) },
  { constraint: 'firm_facts_confidence_range', run: async f => await fact(f, { confidence: 1.5 }) },

  // ----------------------------------------------------------- firm_judgments
  {
    constraint: 'firm_judgments_pkey',
    run: async f => {
      const runId = await seedRun(f);
      await judgment(f, { run_id: runId });
      return await judgment(f, { run_id: runId });
    },
  },
  { constraint: 'firm_judgments_firm_fkey', run: async f => await judgment(f, { firm_id: ABSENT }) },
  { constraint: 'firm_judgments_run_fkey', run: async f => await judgment(f, { run_id: ABSENT }) },
  {
    constraint: 'firm_judgments_contact_fkey',
    run: async f => await judgment(f, { likely_contact_id: ABSENT }),
  },
  { constraint: 'firm_judgments_fit_known', run: async f => await judgment(f, { fit: 'probably' }) },
  {
    constraint: 'firm_judgments_problem_known',
    run: async f => await judgment(f, { problem_evidence: 'probably' }),
  },
  { constraint: 'firm_judgments_timing_known', run: async f => await judgment(f, { timing: 'probably' }) },
  {
    constraint: 'firm_judgments_reachability_known',
    // `fit` stays `unknown`, so `call_first = false` is still consistent and the
    // error names this one rather than `firm_judgments_call_first_consistent`.
    run: async f => await judgment(f, { reachability: 'probably' }),
  },
  {
    constraint: 'firm_judgments_call_first_consistent',
    // A fit, reachable firm that is not queued: the queue's rule, refused.
    run: async f => await judgment(f, { fit: 'yes', reachability: 'yes', call_first: false }),
  },
  {
    constraint: 'firm_judgments_reasons_is_object',
    run: async f => await judgment(f, { reasons: '[]' }),
  },
  {
    constraint: 'firm_judgments_reasons_bounded',
    run: async f => await judgment(f, { reasons: JSON.stringify({ fit: 'x'.repeat(1_700) }) }),
  },

  // --------------------------------------------------------------- firm_links
  {
    constraint: 'firm_links_pkey',
    run: async f => {
      const { rows } = await f.session.query<{ id: string }>(
        `INSERT INTO firm_links (workspace_id, firm_id, url, added_by_user_id)
         VALUES ($1, $2, 'https://example.test/one', $3) RETURNING id`,
        [workspace(f), firm(f), f.seeded.alpha.admin.userId],
      );
      return await link(f, { id: rows[0]?.id, url: 'https://example.test/two' });
    },
  },
  {
    constraint: 'firm_links_one_per_url',
    run: async f => {
      await link(f, {});
      return await link(f, {});
    },
  },
  { constraint: 'firm_links_firm_fkey', run: async f => await link(f, { firm_id: ABSENT }) },
  { constraint: 'firm_links_author_fkey', run: async f => await link(f, { added_by_user_id: stranger(f) }) },
  {
    constraint: 'firm_links_url_shape',
    // Plain http. A link a person adds is https or it is not added.
    run: async f => await link(f, { url: 'http://example.test/news' }),
  },

  // ----------------------------------------------------------- provider_ledger
  {
    constraint: 'provider_ledger_pkey',
    run: async f => {
      await ledger(f, {});
      return await ledger(f, {});
    },
  },
  {
    constraint: 'provider_ledger_workspace_id_fkey',
    run: async f => await ledger(f, { workspace_id: ABSENT }),
  },
  {
    constraint: 'provider_ledger_provider_key_shape',
    run: async f => await ledger(f, { provider_key: 'Company Page' }),
  },
  {
    constraint: 'provider_ledger_calls_nonnegative',
    // `failures` matches, so `provider_ledger_failures_within_calls` holds and only
    // this one can fire.
    run: async f => await ledger(f, { calls: -1, failures: -1 }),
  },
  {
    constraint: 'provider_ledger_failures_nonnegative',
    run: async f => await ledger(f, { calls: 0, failures: -1 }),
  },
  {
    constraint: 'provider_ledger_failures_within_calls',
    run: async f => await ledger(f, { calls: 0, failures: 1, last_failure_code: 'timeout', last_failure_at: new Date().toISOString() }),
  },
  { constraint: 'provider_ledger_cost_nonnegative', run: async f => await ledger(f, { cost_cents: -1 }) },
  {
    constraint: 'provider_ledger_failure_code_shape',
    run: async f =>
      await ledger(f, { failures: 1, last_failure_code: 'TIMED OUT', last_failure_at: new Date().toISOString() }),
  },
  {
    constraint: 'provider_ledger_failure_recorded',
    run: async f => await ledger(f, { failures: 1, last_failure_code: 'timeout', last_failure_at: null }),
  },
  {
    constraint: 'provider_ledger_business_time_zone_shape',
    run: async f => await ledger(f, { business_time_zone: 'eastern' }),
  },
];
