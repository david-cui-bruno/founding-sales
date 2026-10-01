import type { CallToBookingFixture } from './callToBookingCases.ts';

/**
 * A failing insert for every constraint `transcription_provider_jobs` has (migration 0032,
 * slice C3a). Each case breaks exactly one, inside the transaction the caller rolls back.
 */

type Fixture = CallToBookingFixture;

interface Case {
  readonly constraint: string;
  readonly run: (fixture: Fixture) => Promise<unknown>;
}

const SESSION = '00000000-0000-4000-8000-0000000032c1';
const RESERVATION = '00000000-0000-4000-8000-0000000032c2';
const ABSENT_WORKSPACE = '00000000-0000-4000-8000-0000000032c3';
const ROW = '00000000-0000-4000-8000-0000000032c4';

async function job(
  f: Fixture,
  input: {
    readonly id?: string;
    readonly workspaceId?: string;
    readonly jobName?: string;
    readonly attempt?: number;
    readonly providerKey?: string;
    readonly inputKey?: string;
    readonly state?: string;
    readonly looks?: number;
    readonly finished?: boolean;
  } = {},
): Promise<unknown> {
  const attempt = input.attempt ?? 1;
  return await f.session.query(
    `INSERT INTO transcription_provider_jobs
       (id, workspace_id, job_name, call_session_id, attempt, reservation_id, provider_key, input_key, output_key, state, looks, finished_at)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $12 THEN now() END)`,
    [
      input.id ?? null,
      input.workspaceId ?? f.seeded.alpha.workspaceId,
      input.jobName ?? 'fss-test-job-a1',
      SESSION,
      attempt,
      RESERVATION,
      input.providerKey ?? 'aws_transcribe.standard',
      input.inputKey ?? `calls/${SESSION}/attempt-${String(Math.max(1, attempt))}.mp3`,
      `calls/${SESSION}/attempt-${String(Math.max(1, attempt))}.json`,
      input.state ?? 'submitting',
      input.looks ?? 0,
      input.finished ?? false,
    ],
  );
}

export const TRANSCRIPTION_PROVIDER_JOBS_CONSTRAINT_CASES: readonly Case[] = [
  {
    constraint: 'transcription_provider_jobs_pkey',
    run: async f => {
      await job(f, { attempt: 1 });
      return await job(f, { attempt: 2 });
    },
  },
  {
    constraint: 'transcription_provider_jobs_id_unique',
    run: async f => {
      await job(f, { id: ROW, jobName: 'fss-test-job-a1', attempt: 1 });
      return await job(f, { id: ROW, jobName: 'fss-test-job-a2', attempt: 2 });
    },
  },
  {
    constraint: 'transcription_provider_jobs_one_per_attempt',
    run: async f => {
      await job(f, { jobName: 'fss-test-job-a1' });
      return await job(f, { jobName: 'fss-test-job-other' });
    },
  },
  { constraint: 'transcription_provider_jobs_workspace_id_fkey', run: async f => await job(f, { workspaceId: ABSENT_WORKSPACE }) },
  { constraint: 'transcription_provider_jobs_job_name_shape', run: async f => await job(f, { jobName: 'has a space' }) },
  { constraint: 'transcription_provider_jobs_provider_key_shape', run: async f => await job(f, { providerKey: 'AWS Transcribe' }) },
  { constraint: 'transcription_provider_jobs_keys_shape', run: async f => await job(f, { inputKey: 'elsewhere/x.mp3' }) },
  { constraint: 'transcription_provider_jobs_attempt_positive', run: async f => await job(f, { attempt: 0 }) },
  { constraint: 'transcription_provider_jobs_state_known', run: async f => await job(f, { state: 'waiting' }) },
  { constraint: 'transcription_provider_jobs_looks_nonnegative', run: async f => await job(f, { looks: -1 }) },
  { constraint: 'transcription_provider_jobs_finished_consistent', run: async f => await job(f, { state: 'collected', finished: false }) },
];
