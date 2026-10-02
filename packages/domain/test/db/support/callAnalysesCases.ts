import { callSession, type CallToBookingFixture } from './callToBookingCases.ts';

/**
 * A failing insert for every constraint migration 0035 adds (`call_analyses` and
 * `provider_reservations_one_open_analysis`, slice 3a). Each case breaks exactly one
 * constraint, inside the transaction the caller rolls back.
 */

type Fixture = CallToBookingFixture;

interface Case {
  readonly constraint: string;
  readonly run: (fixture: Fixture) => Promise<unknown>;
}

/** A valid uuid that is never a row. */
const ABSENT = '00000000-0000-4000-8000-0000000035a1';
const SHA = 'a'.repeat(64);

type Row = Readonly<Record<string, unknown>>;

/** A valid pending model version, with `overrides` on top. */
function pendingModel(sessionId: string, version = 1): Row {
  return {
    call_session_id: sessionId,
    version,
    origin: 'model',
    requested_reason: 'transcript',
    transcript_sha256: SHA,
    model: 'claude-haiku-4-5-20251001',
    prompt_version: 'call_analysis.1',
    schema_version: 'call_analysis.schema.1',
    policy_version: 'call_policy.1',
    state: 'pending',
  };
}

/** A valid user version (David's notes), with `overrides` on top. */
function userVersion(f: Fixture, sessionId: string, version = 1): Row {
  return {
    call_session_id: sessionId,
    version,
    origin: 'user',
    requested_reason: 'user_edit',
    requested_by_user_id: f.seeded.alpha.salesperson.userId,
    state: 'completed',
    notes: '{"summary":"Notes.","facts":[]}',
    completed_at: '2026-10-01T15:00:00Z',
  };
}

async function analysis(f: Fixture, row: Row): Promise<unknown> {
  const all: Record<string, unknown> = { workspace_id: f.seeded.alpha.workspaceId, ...row };
  const names = Object.keys(all);
  const casts: Record<string, string> = { result: '::jsonb', notes: '::jsonb', proposals: '::jsonb' };
  return await f.session.query(
    `INSERT INTO call_analyses (${names.join(', ')})
     VALUES (${names.map((name, index) => `$${String(index + 1)}${casts[name] ?? ''}`).join(', ')})`,
    names.map(name => all[name]),
  );
}

const model = async (f: Fixture, overrides: Row = {}) => await analysis(f, { ...pendingModel(await callSession(f)), ...overrides });
const user = async (f: Fixture, overrides: Row = {}) => await analysis(f, { ...userVersion(f, await callSession(f)), ...overrides });

const COMPLETED: Row = { state: 'completed', result: '{}', proposals: '[]', proposal_hash: SHA, completed_at: '2026-10-01T15:00:00Z' };

export const CALL_ANALYSES_CONSTRAINT_CASES: readonly Case[] = [
  {
    constraint: 'call_analyses_pkey',
    run: async f => {
      const sessionId = await callSession(f);
      const id = '00000000-0000-4000-8000-0000000035b1';
      await analysis(f, { ...pendingModel(sessionId, 1), id });
      return await analysis(f, { ...pendingModel(sessionId, 2), ...COMPLETED, id });
    },
  },
  {
    // One row per call and version.
    constraint: 'call_analyses_one_version',
    run: async f => {
      const sessionId = await callSession(f);
      await analysis(f, { ...pendingModel(sessionId, 1), ...COMPLETED });
      return await analysis(f, { ...pendingModel(sessionId, 1) });
    },
  },
  {
    // One pending model version per call.
    constraint: 'call_analyses_one_pending',
    run: async f => {
      const sessionId = await callSession(f);
      await analysis(f, pendingModel(sessionId, 1));
      return await analysis(f, pendingModel(sessionId, 2));
    },
  },
  { constraint: 'call_analyses_session_fkey', run: async f => await analysis(f, pendingModel(ABSENT)) },
  { constraint: 'call_analyses_requester_fkey', run: async f => await user(f, { requested_by_user_id: ABSENT }) },
  { constraint: 'call_analyses_version_positive', run: async f => await model(f, { version: 0 }) },
  { constraint: 'call_analyses_origin_known', run: async f => await model(f, { origin: 'robot' }) },
  { constraint: 'call_analyses_reason_known', run: async f => await model(f, { requested_reason: 'whim' }) },
  { constraint: 'call_analyses_state_known', run: async f => await model(f, { state: 'thinking' }) },
  {
    constraint: 'call_analyses_failure_known',
    run: async f => await model(f, { state: 'failed', failure_reason: 'bad_day', completed_at: '2026-10-01T15:00:00Z' }),
  },
  { constraint: 'call_analyses_transcript_sha256_shape', run: async f => await model(f, { transcript_sha256: 'ABC' }) },
  { constraint: 'call_analyses_proposal_hash_shape', run: async f => await model(f, { ...COMPLETED, proposal_hash: 'xyz' }) },
  { constraint: 'call_analyses_model_shape', run: async f => await model(f, { model: 'Claude Haiku' }) },
  { constraint: 'call_analyses_versions_shape', run: async f => await model(f, { policy_version: 'policy 1' }) },
  { constraint: 'call_analyses_json_shape', run: async f => await model(f, { ...COMPLETED, proposals: '{}' }) },
  // A user version carries no model's fields.
  { constraint: 'call_analyses_user_shape', run: async f => await user(f, { prompt_version: 'call_analysis.1' }) },
  // A model version names what produced it.
  { constraint: 'call_analyses_model_required', run: async f => await model(f, { schema_version: null }) },
  // A completed model version has its result, proposals and hash.
  { constraint: 'call_analyses_state_shape', run: async f => await model(f, { ...COMPLETED, proposal_hash: null }) },
  {
    constraint: 'provider_reservations_one_open_analysis',
    // Two open attempts for one analysis version: the second paid obligation it must never hold.
    run: async f =>
      await f.session.query(
        `INSERT INTO provider_reservations
           (workspace_id, provider_key, subject_kind, subject_id, attempt, business_date, business_time_zone,
            cents, model_name, max_input_tokens, max_output_tokens)
         SELECT $1, 'aws_bedrock.call_analysis', 'call_analysis', s.id, a, '2026-10-01', 'America/New_York',
                3, 'claude-haiku-4-5-20251001', 10000, 3000
           FROM (SELECT gen_random_uuid() AS id) s, generate_series(1, 2) a`,
        [f.seeded.alpha.workspaceId],
      ),
  },
];
