import { callSession, type CallToBookingFixture } from './callToBookingCases.ts';

/**
 * A failing insert for every constraint migration 0030 adds (`call_transcripts`, slice
 * C2). Each case breaks exactly one constraint, inside the transaction the caller rolls back.
 */

/** The constraint suite's fixture: the session, both workspaces, and the CRM and mail seeds. */
type Fixture = CallToBookingFixture;

interface Case {
  readonly constraint: string;
  readonly run: (fixture: Fixture) => Promise<unknown>;
}

/** A valid uuid that is never a row. */
const ABSENT = '00000000-0000-4000-8000-0000000030a1';


async function transcript(
  f: Fixture,
  input: {
    readonly sessionId?: string;
    readonly provider?: string;
    readonly model?: string;
    readonly language?: string;
    readonly duration?: number;
    readonly utterances?: string;
  } = {},
): Promise<unknown> {
  return await f.session.query(
    `INSERT INTO call_transcripts (workspace_id, call_session_id, provider, model, language, duration_seconds, utterances)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      f.seeded.alpha.workspaceId,
      input.sessionId ?? (await callSession(f)),
      input.provider ?? 'deepgram',
      input.model ?? 'nova-3',
      input.language ?? 'en',
      input.duration ?? 60,
      input.utterances ?? '[]',
    ],
  );
}

export const CALL_TRANSCRIPTS_CONSTRAINT_CASES: readonly Case[] = [
  {
    // One transcript per call session.
    constraint: 'call_transcripts_pkey',
    run: async f => {
      const sessionId = await callSession(f);
      await transcript(f, { sessionId });
      return await transcript(f, { sessionId });
    },
  },
  { constraint: 'call_transcripts_session_fkey', run: async f => await transcript(f, { sessionId: ABSENT }) },
  { constraint: 'call_transcripts_provider_shape', run: async f => await transcript(f, { sessionId: ABSENT, provider: 'Deepgram!' }) },
  { constraint: 'call_transcripts_model_shape', run: async f => await transcript(f, { sessionId: ABSENT, model: 'Nova 3' }) },
  { constraint: 'call_transcripts_language_shape', run: async f => await transcript(f, { sessionId: ABSENT, language: 'english' }) },
  { constraint: 'call_transcripts_duration_range', run: async f => await transcript(f, { sessionId: ABSENT, duration: -1 }) },
  { constraint: 'call_transcripts_utterances_array', run: async f => await transcript(f, { sessionId: ABSENT, utterances: '{}' }) },
];
