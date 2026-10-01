import type { CallToBookingFixture } from './callToBookingCases.ts';

/**
 * A failing insert for every constraint `transcription_provider_jobs` has (migration 0032,
 * slice C3a fix round). Each case breaks exactly one, inside the transaction the caller
 * rolls back.
 */

type Fixture = CallToBookingFixture;

interface Case {
  readonly constraint: string;
  readonly run: (fixture: Fixture) => Promise<unknown>;
}

const SESSION = '00000000-0000-4000-8000-0000000032c1';
const RESERVATION = '00000000-0000-4000-8000-0000000032c2';
const ABSENT_WORKSPACE = '00000000-0000-4000-8000-0000000032c3';

async function job(
  f: Fixture,
  input: {
    readonly workspaceId?: string;
    readonly jobName?: string;
    readonly attempt?: number;
    readonly providerKey?: string;
    readonly objectKey?: string | null;
    readonly state?: string;
    readonly polls?: number;
    readonly finished?: boolean;
  } = {},
): Promise<unknown> {
  return await f.session.query(
    `INSERT INTO transcription_provider_jobs
       (workspace_id, job_name, call_session_id, attempt, reservation_id, provider_key, object_key, state, polls, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $10 THEN now() END)`,
    [
      input.workspaceId ?? f.seeded.alpha.workspaceId,
      input.jobName ?? 'fss-test-job-a1',
      SESSION,
      input.attempt ?? 1,
      RESERVATION,
      input.providerKey ?? 'aws_transcribe.standard',
      input.objectKey === undefined ? 'calls/x/attempt-1.mp3' : input.objectKey,
      input.state ?? 'submitting',
      input.polls ?? 0,
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
    constraint: 'transcription_provider_jobs_one_per_attempt',
    run: async f => {
      await job(f, { jobName: 'fss-test-job-a1' });
      return await job(f, { jobName: 'fss-test-job-other' });
    },
  },
  { constraint: 'transcription_provider_jobs_workspace_id_fkey', run: async f => await job(f, { workspaceId: ABSENT_WORKSPACE }) },
  { constraint: 'transcription_provider_jobs_job_name_shape', run: async f => await job(f, { jobName: 'has a space' }) },
  { constraint: 'transcription_provider_jobs_provider_key_shape', run: async f => await job(f, { providerKey: 'AWS Transcribe' }) },
  { constraint: 'transcription_provider_jobs_object_key_shape', run: async f => await job(f, { objectKey: 'calls/../x y.mp3' }) },
  { constraint: 'transcription_provider_jobs_attempt_positive', run: async f => await job(f, { attempt: 0 }) },
  { constraint: 'transcription_provider_jobs_state_known', run: async f => await job(f, { state: 'waiting' }) },
  { constraint: 'transcription_provider_jobs_counts_nonnegative', run: async f => await job(f, { polls: -1 }) },
  { constraint: 'transcription_provider_jobs_finished_consistent', run: async f => await job(f, { state: 'collected', finished: false }) },
];
