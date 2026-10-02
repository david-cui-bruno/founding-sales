import type { CallToBookingFixture } from './callToBookingCases.ts';

/**
 * A failing insert for every constraint migration 0038 adds (`firm_prepared_briefs`, lane
 * PB). Each case breaks exactly one constraint, inside the transaction the caller rolls back.
 */

type Fixture = CallToBookingFixture;

interface Case {
  readonly constraint: string;
  readonly run: (fixture: Fixture) => Promise<unknown>;
}

type Row = Readonly<Record<string, unknown>>;

/** A valid uuid that is never a row. */
const ABSENT = '00000000-0000-4000-8000-0000000038a1';

const SOURCE = { url: 'https://firm.example.test/about', label: 'Source' };

/** A valid brief for alpha's seeded firm, with `overrides` on top. */
export async function preparedBrief(f: Fixture, overrides: Row = {}): Promise<unknown> {
  const all: Record<string, unknown> = {
    workspace_id: f.seeded.alpha.workspaceId,
    firm_id: f.crm.alpha.firmId,
    brief: 'Who to ask for: unknown',
    sources: JSON.stringify([SOURCE]),
    observed_on: '2026-10-02',
    prepared_by: 'Callie research agent (web)',
    updated_by_user_id: f.seeded.alpha.admin.userId,
    ...overrides,
  };
  const names = Object.keys(all);
  return await f.session.query(
    `INSERT INTO firm_prepared_briefs (${names.join(', ')})
     VALUES (${names.map((name, index) => `$${String(index + 1)}${name === 'sources' ? '::jsonb' : ''}`).join(', ')})`,
    names.map(name => all[name]),
  );
}

export const PREPARED_BRIEFS_CONSTRAINT_CASES: readonly Case[] = [
  {
    // One brief per firm.
    constraint: 'firm_prepared_briefs_pkey',
    run: async f => {
      await preparedBrief(f);
      return await preparedBrief(f);
    },
  },
  {
    constraint: 'firm_prepared_briefs_firm_fkey',
    run: async f => await preparedBrief(f, { firm_id: ABSENT }),
  },
  {
    // Beta's admin is not a member of alpha.
    constraint: 'firm_prepared_briefs_updater_fkey',
    run: async f => await preparedBrief(f, { updated_by_user_id: f.seeded.beta.admin.userId }),
  },
  {
    constraint: 'firm_prepared_briefs_brief_bounded',
    run: async f => await preparedBrief(f, { brief: 'x'.repeat(4001) }),
  },
  {
    // A label beyond 200 characters; the walk over the elements is the function's.
    constraint: 'firm_prepared_briefs_sources_shape',
    run: async f => await preparedBrief(f, { sources: JSON.stringify([{ url: SOURCE.url, label: 'x'.repeat(201) }]) }),
  },
  {
    constraint: 'firm_prepared_briefs_prepared_by_bounded',
    run: async f => await preparedBrief(f, { prepared_by: '   ' }),
  },
  {
    constraint: 'firm_prepared_briefs_updated_not_before_created',
    run: async f => await preparedBrief(f, { created_at: '2026-10-02T12:00:00Z', updated_at: '2026-10-02T11:00:00Z' }),
  },
];
