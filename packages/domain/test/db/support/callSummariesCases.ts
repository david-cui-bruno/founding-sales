import { callSession, type CallToBookingFixture } from './callToBookingCases.ts';

/**
 * A failing insert for every constraint migration 0033 adds (`call_summaries` and
 * `provider_reservations_one_open_summary`, slice C3b). Each case breaks exactly one
 * constraint, inside the transaction the caller rolls back.
 */

type Fixture = CallToBookingFixture;

interface Case {
  readonly constraint: string;
  readonly run: (fixture: Fixture) => Promise<unknown>;
}

/** A valid uuid that is never a row. */
const ABSENT = '00000000-0000-4000-8000-0000000033a1';

async function summary(
  f: Fixture,
  input: {
    readonly sessionId?: string;
    readonly model?: string;
    readonly promptVersion?: string;
    readonly summary?: string;
    readonly nextSteps?: string;
    readonly commitments?: string;
  } = {},
): Promise<unknown> {
  return await f.session.query(
    `INSERT INTO call_summaries (workspace_id, call_session_id, model, prompt_version, summary, next_steps, commitments)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
    [
      f.seeded.alpha.workspaceId,
      input.sessionId ?? (await callSession(f)),
      input.model ?? 'claude-haiku-4-5-20251001',
      input.promptVersion ?? 'c3b.summary.1',
      input.summary ?? 'You called. They answered. You agreed to talk again.',
      input.nextSteps ?? '[]',
      input.commitments ?? '[]',
    ],
  );
}

const array = (length: number): string => JSON.stringify(Array.from({ length }, () => ({})));

export const CALL_SUMMARIES_CONSTRAINT_CASES: readonly Case[] = [
  {
    // One summary per call session.
    constraint: 'call_summaries_pkey',
    run: async f => {
      const sessionId = await callSession(f);
      await summary(f, { sessionId });
      return await summary(f, { sessionId });
    },
  },
  { constraint: 'call_summaries_session_fkey', run: async f => await summary(f, { sessionId: ABSENT }) },
  { constraint: 'call_summaries_model_shape', run: async f => await summary(f, { sessionId: ABSENT, model: 'Claude Haiku' }) },
  { constraint: 'call_summaries_prompt_version_shape', run: async f => await summary(f, { sessionId: ABSENT, promptVersion: 'v 1' }) },
  { constraint: 'call_summaries_summary_length', run: async f => await summary(f, { sessionId: ABSENT, summary: '' }) },
  { constraint: 'call_summaries_next_steps_array', run: async f => await summary(f, { sessionId: ABSENT, nextSteps: array(6) }) },
  { constraint: 'call_summaries_commitments_array', run: async f => await summary(f, { sessionId: ABSENT, commitments: '{}' }) },
  {
    constraint: 'provider_reservations_one_open_summary',
    // Two open attempts for one call's summary: the second paid obligation it must never hold.
    run: async f =>
      await f.session.query(
        `INSERT INTO provider_reservations
           (workspace_id, provider_key, subject_kind, subject_id, attempt, business_date, business_time_zone,
            cents, model_name, max_input_tokens, max_output_tokens)
         SELECT $1, 'anthropic_call_summary', 'call_summary', s.id, a, '2026-10-01', 'America/New_York',
                2, 'claude-haiku-4-5-20251001', 100, 1500
           FROM (SELECT gen_random_uuid() AS id) s, generate_series(1, 2) a`,
        [f.seeded.alpha.workspaceId],
      ),
  },
];
