import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RECORDING_CHANNEL_ROLES } from '@fss/contracts';
import type { TranscriptionOutcome } from '@fss/domain/calls/transcription.ts';
import { silentMp3 } from '@fss/domain/test/calls/mp3Fixture.ts';
import {
  AWS_TRANSCRIBE_PROVIDER_KEY,
  awsTranscribeTranscription,
  callAudioObjectKey,
  isServiceTranscriptUri,
  parseAwsTranscript,
  readAwsTranscribeProvider,
  speakerOfChannel,
  transcriptionJobName,
  type AwsTranscribeSdk,
  type TranscriptHttp,
} from '../src/transcription/awsTranscribeClient.ts';
import { readSelectedTranscriptionProvider } from '../src/transcription/selectProvider.ts';

/**
 * Slice C3a: the Amazon Transcribe adapter against a fake AWS SDK — the request shape, the
 * polling and its timeout, the channel mapping, the deletes on every exit, and which
 * failures are refused and which ambiguous. The transcripts are two of the coordinator's
 * real jobs of 1 October 2026 (synthetic voices; the account id scrubbed).
 */

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/awsTranscribe/${name}.json`, import.meta.url), 'utf8')) as unknown;

const AUDIO = silentMp3(15);
const SESSION = '0f6b7a52-5d43-4c3e-9b8a-2a0d1e3f4c5b';
const BUCKET = 'fss-test-call-audio-123456789012';
const URI = 'https://s3.us-east-1.amazonaws.com/aws-transcribe-us-east-1-prod/123456789012/job/asrOutput.json?X-Amz-Signature=x';

interface Sent {
  readonly command: string;
  readonly input: Record<string, unknown>;
}

type Answer = (input: Record<string, unknown>) => unknown;

/** An SDK whose two clients record every command and answer from `answers` by command name. */
function fakeSdk(answers: Partial<Record<string, Answer>>): { sdk: AwsTranscribeSdk; sent: Sent[] } {
  const sent: Sent[] = [];
  const command = (name: string) =>
    class {
      readonly name = name;
      constructor(readonly input: Record<string, unknown>) {}
    };
  class Client {
    async send(issued: unknown): Promise<unknown> {
      const { name, input } = issued as { name: string; input: Record<string, unknown> };
      sent.push({ command: name, input });
      const answer = answers[name];
      return await Promise.resolve(answer === undefined ? {} : answer(input));
    }
  }
  return {
    sent,
    sdk: {
      S3Client: Client,
      PutObjectCommand: command('PutObject'),
      DeleteObjectCommand: command('DeleteObject'),
      TranscribeClient: Client,
      StartTranscriptionJobCommand: command('StartTranscriptionJob'),
      GetTranscriptionJobCommand: command('GetTranscriptionJob'),
      DeleteTranscriptionJobCommand: command('DeleteTranscriptionJob'),
    },
  };
}

/** An SDK error the way the v3 clients throw one: a name and the HTTP status. */
const awsError = (name: string, status: number): Error => Object.assign(new Error(`${name}: details`), { name, $metadata: { httpStatusCode: status } });

const completed = (): unknown => ({ TranscriptionJob: { TranscriptionJobStatus: 'COMPLETED', Transcript: { TranscriptFileUri: URI } } });

function harness(options: {
  readonly answers?: Partial<Record<string, Answer>>;
  readonly http?: TranscriptHttp;
  readonly timeoutMs?: number;
}) {
  const { sdk, sent } = fakeSdk({ GetTranscriptionJob: completed, ...options.answers });
  let clock = 0;
  const sleeps: number[] = [];
  const logs: { event: string; fields: Readonly<Record<string, unknown>> }[] = [];
  const fetched: string[] = [];
  const provider = awsTranscribeTranscription({
    bucket: BUCKET,
    region: 'us-east-1',
    jobPrefix: 'fss-test',
    sdk,
    http:
      options.http ??
      (async url => {
        fetched.push(url);
        return await Promise.resolve(new Response(JSON.stringify(fixture('c1')), { status: 200 }));
      }),
    sleep: async milliseconds => {
      sleeps.push(milliseconds);
      clock += milliseconds;
      await Promise.resolve();
    },
    now: () => clock,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    log: (event, fields) => logs.push({ event, fields }),
  });
  const commands = (): string[] => sent.map(entry => entry.command);
  const run = async (attempt = 1, finalCheck?: () => Promise<'transcription_off' | null>): Promise<TranscriptionOutcome> =>
    await provider.transcribe({ audio: AUDIO, contentType: 'audio/mpeg', subject: { sessionId: SESSION, attempt }, finalCheck });
  return { provider, sent, sleeps, logs, fetched, commands, run };
}

describe('the recording channels', () => {
  it('maps channel 0 (the parent leg, the Mac) to you and channel 1 (the dialled number) to them', () => {
    expect(RECORDING_CHANNEL_ROLES).toEqual({ you: 0, them: 1 });
    expect(speakerOfChannel(0)).toBe(RECORDING_CHANNEL_ROLES.you);
    expect(speakerOfChannel(1)).toBe(RECORDING_CHANNEL_ROLES.them);
    expect(speakerOfChannel(2)).toBeNull();
  });
});

describe('the Transcribe transcript', () => {
  it('labels each audio segment by its channel, in time order', () => {
    const utterances = parseAwsTranscript(fixture('c1'));
    expect(utterances).not.toBeNull();
    expect(utterances?.[0]).toEqual({ speaker: 0, start: 1, end: 6.23, text: 'Hi, is this Marisol Lockerfor? This is David calling from Calais.' });
    expect(utterances?.[1]).toMatchObject({ speaker: 1, start: 6.81, text: 'Yes, this is Marisol. Um, who did you say you were with?' });
    expect(new Set(utterances?.map(utterance => utterance.speaker))).toEqual(new Set([0, 1]));
    const starts = utterances?.map(utterance => utterance.start) ?? [];
    expect([...starts].sort((left, right) => left - right)).toEqual(starts);
  });

  it('names the prospect from the channel even when the prospect speaks first', () => {
    // c5: a call the prospect's line answered first, on channel 1.
    const utterances = parseAwsTranscript(fixture('c5'));
    expect(utterances?.[0]?.speaker).toBe(RECORDING_CHANNEL_ROLES.them);
    expect(utterances?.some(utterance => utterance.speaker === RECORDING_CHANNEL_ROLES.you)).toBe(true);
  });

  it('builds the same speakers from channel_labels when there are no audio segments', () => {
    const raw = fixture('c1') as { results: Record<string, unknown> };
    const withSegments = parseAwsTranscript(raw) ?? [];
    const withoutSegments = parseAwsTranscript({ ...raw, results: { ...raw.results, audio_segments: [] } }) ?? [];
    expect(withoutSegments.length).toBeGreaterThan(0);
    const words = (speaker: number, list: typeof withSegments): string =>
      list
        .filter(utterance => utterance.speaker === speaker)
        .map(utterance => utterance.text)
        .join(' ')
        .replace(/[^a-z0-9 ]/giu, '')
        .split(/\s+/u)
        .join(' ');
    expect(words(0, withoutSegments)).toBe(words(0, withSegments));
    expect(words(1, withoutSegments)).toBe(words(1, withSegments));
    expect(withoutSegments[0]?.speaker).toBe(0);
  });

  it('refuses a transcript that does not have exactly the two channels', () => {
    const raw = fixture('c1') as { results: { channel_labels: Record<string, unknown> } & Record<string, unknown> };
    expect(parseAwsTranscript({ ...raw, results: { ...raw.results, channel_labels: { ...raw.results.channel_labels, number_of_channels: 1 } } })).toBeNull();
    expect(parseAwsTranscript({ results: { transcripts: [{ transcript: 'x' }] } })).toBeNull();
    const segments = [{ channel_label: 'ch_2', transcript: 'x', start_time: '0', end_time: '1' }];
    expect(parseAwsTranscript({ ...raw, results: { ...raw.results, audio_segments: segments } })).toBeNull();
  });
});

describe('the Amazon Transcribe provider', () => {
  it('uploads the audio, starts an en-US mp3 job with channel identification and no output bucket, polls, reads, and deletes both', async () => {
    let gets = 0;
    const h = harness({
      answers: {
        GetTranscriptionJob: () => {
          gets += 1;
          return gets < 3 ? { TranscriptionJob: { TranscriptionJobStatus: 'IN_PROGRESS' } } : completed();
        },
      },
    });
    const outcome = await h.run(1);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.utterances[0]).toMatchObject({ speaker: 0, text: 'Hi, is this Marisol Lockerfor? This is David calling from Calais.' });
    expect(outcome.language).toBe('en');
    // No media duration in the job: settled at the reservation; stored with the audio's own length.
    expect(outcome.billedSeconds).toBeNull();
    expect(outcome.durationSeconds).toBeCloseTo(15, 0);

    expect(h.commands()).toEqual([
      'PutObject',
      'StartTranscriptionJob',
      'GetTranscriptionJob',
      'GetTranscriptionJob',
      'GetTranscriptionJob',
      'DeleteObject',
      'DeleteTranscriptionJob',
    ]);
    const key = callAudioObjectKey(SESSION, 1);
    expect(key).toBe(`calls/${SESSION}/attempt-1.mp3`);
    expect(h.sent[0]?.input).toMatchObject({ Bucket: BUCKET, Key: key, ContentType: 'audio/mpeg', ServerSideEncryption: 'AES256' });
    expect(h.sent[1]?.input).toEqual({
      TranscriptionJobName: `fss-test-${SESSION}-a1`,
      LanguageCode: 'en-US',
      MediaFormat: 'mp3',
      Media: { MediaFileUri: `s3://${BUCKET}/${key}` },
      Settings: { ChannelIdentification: true },
    });
    expect(h.sent[1]?.input).not.toHaveProperty('OutputBucketName');
    expect(h.sent[5]?.input).toEqual({ Bucket: BUCKET, Key: key });
    expect(h.sent[6]?.input).toEqual({ TranscriptionJobName: `fss-test-${SESSION}-a1` });
    expect(h.fetched).toEqual([URI]);
    // The backoff: 3 s, then × 1.5.
    expect(h.sleeps).toEqual([3_000, 4_500, 6_750]);
    expect(h.provider.providerKey).toBe(AWS_TRANSCRIBE_PROVIDER_KEY);
    expect(h.provider.pricing).toEqual({ unitPriceMicros: 6_000, billedChannels: 1, perSecondMinimumSeconds: 15 });
  });

  it('gives up at the timeout as ambiguous — the job may yet be billed — and still deletes both', async () => {
    const h = harness({ answers: { GetTranscriptionJob: () => ({ TranscriptionJob: { TranscriptionJobStatus: 'IN_PROGRESS' } }) }, timeoutMs: 60_000 });
    expect(await h.run()).toEqual({ ok: false, kind: 'ambiguous', code: 'aws_transcribe_timeout' });
    expect(h.sleeps.reduce((total, wait) => total + wait, 0)).toBe(60_000);
    expect(Math.max(...h.sleeps)).toBeLessThanOrEqual(15_000);
    expect(h.commands().slice(-2)).toEqual(['DeleteObject', 'DeleteTranscriptionJob']);
  });

  it('keeps asking through a failed status read until the deadline', async () => {
    let gets = 0;
    const h = harness({
      answers: {
        GetTranscriptionJob: () => {
          gets += 1;
          if (gets === 1) throw awsError('ThrottlingException', 400);
          return completed();
        },
      },
    });
    expect((await h.run()).ok).toBe(true);
  });

  it('calls a FAILED job refused (terminal, not billed), and deletes both', async () => {
    const h = harness({ answers: { GetTranscriptionJob: () => ({ TranscriptionJob: { TranscriptionJobStatus: 'FAILED', FailureReason: 'Unsupported audio' } }) } });
    const outcome = await h.run();
    expect(outcome).toEqual({ ok: false, kind: 'refused', code: 'aws_transcribe_job_failed' });
    expect(JSON.stringify(outcome)).not.toContain('Unsupported');
    expect(h.commands().slice(-2)).toEqual(['DeleteObject', 'DeleteTranscriptionJob']);
  });

  it('calls a Start that Transcribe refused refused, and one that may have been accepted ambiguous', async () => {
    const cases: [unknown, TranscriptionOutcome][] = [
      [awsError('BadRequestException', 400), { ok: false, kind: 'refused', code: 'aws_transcribe_start_refused' }],
      [awsError('LimitExceededException', 400), { ok: false, kind: 'refused', code: 'aws_transcribe_start_refused' }],
      [awsError('ConflictException', 409), { ok: false, kind: 'ambiguous', code: 'aws_transcribe_job_exists' }],
      [awsError('InternalFailureException', 500), { ok: false, kind: 'ambiguous', code: 'aws_transcribe_start_unknown' }],
      [Object.assign(new Error('socket hang up'), { name: 'TimeoutError' }), { ok: false, kind: 'ambiguous', code: 'aws_transcribe_start_unknown' }],
    ];
    for (const [error, expected] of cases) {
      const h = harness({
        answers: {
          StartTranscriptionJob: () => {
            throw error;
          },
        },
      });
      expect(await h.run()).toEqual(expected);
      expect(h.commands()).not.toContain('GetTranscriptionJob');
      expect(h.commands()).toContain('DeleteObject');
    }
  });

  it('calls a failed upload refused and asks Transcribe nothing', async () => {
    const h = harness({
      answers: {
        PutObject: () => {
          throw awsError('AccessDenied', 403);
        },
      },
    });
    expect(await h.run()).toEqual({ ok: false, kind: 'refused', code: 'aws_transcribe_upload_failed' });
    expect(h.commands().some(command => command.includes('Transcription'))).toBe(false);
  });

  it('stops at the final settings read after the upload: nothing is started, the object is deleted (the pause boundary)', async () => {
    const h = harness({});
    const outcome = await h.run(1, async () => await Promise.resolve('transcription_off' as const));
    expect(outcome).toEqual({ ok: false, kind: 'withdrawn', reason: 'transcription_off' });
    expect(h.commands()).toEqual(['PutObject', 'DeleteObject']);
  });

  it('calls a completed job whose transcript cannot be read ambiguous, and deletes both', async () => {
    const answers: TranscriptHttp[] = [
      async () => await Promise.resolve(new Response('{"results": {}}', { status: 200 })),
      async () => await Promise.resolve(new Response('denied', { status: 403 })),
      async () => await Promise.reject(new Error('reset')),
    ];
    for (const http of answers) {
      const h = harness({ http });
      expect(await h.run()).toEqual({ ok: false, kind: 'ambiguous', code: 'aws_transcribe_transcript_unreadable' });
      expect(h.commands().slice(-2)).toEqual(['DeleteObject', 'DeleteTranscriptionJob']);
    }
    // A transcript URL that is not the service's is never fetched.
    let fetched = 0;
    const h = harness({
      answers: { GetTranscriptionJob: () => ({ TranscriptionJob: { TranscriptionJobStatus: 'COMPLETED', Transcript: { TranscriptFileUri: 'http://example.com/t.json' } } }) },
      http: async () => {
        fetched += 1;
        return await Promise.resolve(new Response('{}'));
      },
    });
    expect((await h.run()).ok).toBe(false);
    expect(fetched).toBe(0);
    expect(isServiceTranscriptUri(URI)).toBe(true);
    expect(isServiceTranscriptUri('https://amazonaws.com.example.com/x')).toBe(false);
  });

  it('logs a failed cleanup by what and the error name only, and still answers', async () => {
    const h = harness({
      answers: {
        DeleteObject: () => {
          throw awsError('AccessDenied', 403);
        },
      },
    });
    expect((await h.run()).ok).toBe(true);
    expect(h.logs).toEqual([{ event: 'aws_transcribe_cleanup_failed', fields: { what: 'object', error: 'AccessDenied' } }]);
  });

  it('deletes an earlier attempt’s job and object before a retry starts its own, under its own names', async () => {
    const h = harness({
      answers: {
        DeleteTranscriptionJob: input => {
          if (input['TranscriptionJobName'] === transcriptionJobName('fss-test', SESSION, 1)) throw awsError('BadRequestException', 400);
          return {};
        },
      },
    });
    expect((await h.run(2)).ok).toBe(true);
    expect(h.sent.slice(0, 3)).toEqual([
      { command: 'DeleteTranscriptionJob', input: { TranscriptionJobName: `fss-test-${SESSION}-a1` } },
      { command: 'DeleteObject', input: { Bucket: BUCKET, Key: `calls/${SESSION}/attempt-1.mp3` } },
      { command: 'PutObject', input: expect.objectContaining({ Key: `calls/${SESSION}/attempt-2.mp3` }) as unknown },
    ]);
    expect(h.sent.find(entry => entry.command === 'StartTranscriptionJob')?.input['TranscriptionJobName']).toBe(`fss-test-${SESSION}-a2`);
    // The earlier job's "not found" is the expected answer, not a failure worth a line.
    expect(h.logs).toEqual([]);
  });

  it('refuses empty or oversized audio without a request', async () => {
    const h = harness({});
    expect(await h.provider.transcribe({ audio: Buffer.alloc(0), contentType: 'audio/mpeg' })).toMatchObject({ kind: 'refused', code: 'audio_size' });
    expect(h.sent).toEqual([]);
  });
});

describe('choosing the provider from the task environment', () => {
  const aws = { FSS_TRANSCRIPTION_PROVIDER: 'aws_transcribe', FSS_CALL_AUDIO_BUCKET: BUCKET, AWS_REGION: 'us-east-1', FSS_NAME_PREFIX: 'fss-test' };

  it('builds Amazon Transcribe from the bucket, the region and the name prefix, with no secret', () => {
    const chosen = readSelectedTranscriptionProvider(aws);
    expect(chosen.problem).toBeNull();
    expect(chosen.provider?.providerKey).toBe('aws_transcribe.standard');
    expect(chosen.provider?.provider).toBe('aws_transcribe');
    // Its lease is sized from its longest call (`callTranscribeLeaseSeconds`).
    expect(chosen.provider?.maxCallSeconds).toBeGreaterThan(420);
  });

  it('names the missing variable, never a value', () => {
    expect(readAwsTranscribeProvider({ ...aws, FSS_CALL_AUDIO_BUCKET: undefined }).problem).toBe('FSS_CALL_AUDIO_BUCKET');
    expect(readAwsTranscribeProvider({ ...aws, AWS_REGION: '' }).problem).toBe('AWS_REGION');
    expect(readAwsTranscribeProvider({ ...aws, FSS_NAME_PREFIX: 'Bad Prefix' }).problem).toBe('FSS_NAME_PREFIX');
    expect(readSelectedTranscriptionProvider({ ...aws, FSS_TRANSCRIPTION_PROVIDER: 'whisper' }).problem).toBe('FSS_TRANSCRIPTION_PROVIDER');
  });

  it('keeps Deepgram selectable, and the default when nothing is chosen', () => {
    expect(readSelectedTranscriptionProvider({ FSS_TRANSCRIPTION_PROVIDER: 'deepgram' }).problem).toBe('absent');
    expect(readSelectedTranscriptionProvider({}).problem).toBe('absent');
  });
});
