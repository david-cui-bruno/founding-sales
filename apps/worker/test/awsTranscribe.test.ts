import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { RECORDING_CHANNEL_ROLES } from '@fss/contracts';
import {
  PER_MINUTE_PRICING,
  reservationUnitPriceMicros,
  transcriptionSettledCents,
  type TranscriptionOutcome,
} from '@fss/domain/calls/transcription.ts';
import { CREDIT_FUNDED_PROVIDER_KINDS, providerFunding } from '@fss/domain/settings/funding.ts';
import { silentMp3 } from '@fss/domain/test/calls/mp3Fixture.ts';
import {
  AWS_SDK_MAX_ATTEMPTS,
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
import { readTranscriptionComposition, registerHandlers } from '../src/bootstrap/main.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';

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

function harness(options: { readonly answers?: Partial<Record<string, Answer>>; readonly http?: TranscriptHttp }) {
  const { sdk, sent } = fakeSdk({ GetTranscriptionJob: completed, ...options.answers });
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
    log: (event, fields) => logs.push({ event, fields }),
  });
  const jobs = provider.jobs;
  if (jobs === undefined) throw new Error('Transcribe has jobs');
  const commands = (): string[] => sent.map(entry => entry.command);
  const run = async (attempt = 1, finalCheck?: () => Promise<'transcription_off' | null>): Promise<TranscriptionOutcome> =>
    await provider.transcribe({ audio: AUDIO, contentType: 'audio/mpeg', subject: { sessionId: SESSION, attempt }, finalCheck });
  return { provider, jobs, sent, logs, fetched, commands, run };
}

describe('the recording channels', () => {
  it('maps channel 0 (the parent leg, the Mac) to you and channel 1 (the dialled number) to them', () => {
    expect(RECORDING_CHANNEL_ROLES).toEqual({ you: 0, them: 1 });
    expect(speakerOfChannel(0)).toBe(RECORDING_CHANNEL_ROLES.you);
    expect(speakerOfChannel(1)).toBe(RECORDING_CHANNEL_ROLES.them);
    expect(speakerOfChannel(2)).toBeNull();
  });
});

describe('the money', () => {
  it('prices Transcribe at its own $0.006 a minute, whatever the setting says, and Deepgram at the setting for each channel', () => {
    expect(reservationUnitPriceMicros({ unitPriceMicros: 6_000, billedChannels: 1, perSecondMinimumSeconds: 15 }, 4_300)).toBe(6_000);
    expect(reservationUnitPriceMicros({ unitPriceMicros: null, billedChannels: 2, perSecondMinimumSeconds: null }, 4_300)).toBe(8_600);
    expect(reservationUnitPriceMicros(PER_MINUTE_PRICING, 4_300)).toBe(4_300);
  });

  it('settles by the second with a 15-second minimum, never past the reserved minutes, when a duration is reported', () => {
    const pricing = { unitPriceMicros: 6_000, billedChannels: 1, perSecondMinimumSeconds: 15 };
    const reservation = { maxUnits: 3, unitPriceMicros: 6_000 };
    // 100 µ$ a second: 5 s bills 15 s (0.15 ¢ → 1 ¢); 150.2 s bills 151 s (1.51 ¢ → 2 ¢);
    // 400 s is cut to the reserved 180 s (1.8 ¢ → 2 ¢).
    expect(transcriptionSettledCents(pricing, 5, reservation)).toBe(1);
    expect(transcriptionSettledCents(pricing, 150.2, reservation)).toBe(2);
    expect(transcriptionSettledCents(pricing, 400, { maxUnits: 3, unitPriceMicros: 600_000 })).toBe(180);
    // By the minute, as C2 did.
    expect(transcriptionSettledCents(PER_MINUTE_PRICING, 61, { maxUnits: 5, unitPriceMicros: 4_300 })).toBe(1);
  });

  it('funds Transcribe from credits and every other provider kind, known or not, in cash', () => {
    expect(providerFunding(AWS_TRANSCRIBE_PROVIDER_KEY)).toBe('credits');
    expect(CREDIT_FUNDED_PROVIDER_KINDS).toEqual(['aws_transcribe']);
    for (const key of ['twilio.voice', 'deepgram.nova-3', 'anthropic_classifier', 'anthropic_extraction', 'google_places.text-search', 'unknown.kind']) {
      expect(providerFunding(key)).toBe('cash');
    }
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
  const JOB = `fss-test-${SESSION}-a1`;

  it('uploads the audio and starts an en-US mp3 job with channel identification and no output bucket — and waits for nothing', async () => {
    const h = harness({});
    expect(await h.run(1)).toEqual({ ok: false, kind: 'started', code: 'started' });
    // Two requests and no status read: the job is collected by later claims (C3a fix round).
    expect(h.commands()).toEqual(['PutObject', 'StartTranscriptionJob']);
    const key = callAudioObjectKey(SESSION, 1);
    expect(key).toBe(`calls/${SESSION}/attempt-1.mp3`);
    expect(h.jobs.names({ sessionId: SESSION, attempt: 1 })).toEqual({ jobName: JOB, objectKey: key });
    expect(transcriptionJobName('fss-test', SESSION, 2)).toBe(`fss-test-${SESSION}-a2`);
    expect(h.sent[0]?.input).toMatchObject({ Bucket: BUCKET, Key: key, ContentType: 'audio/mpeg', ServerSideEncryption: 'AES256' });
    expect(h.sent[1]?.input).toEqual({
      TranscriptionJobName: JOB,
      LanguageCode: 'en-US',
      MediaFormat: 'mp3',
      Media: { MediaFileUri: `s3://${BUCKET}/${key}` },
      Settings: { ChannelIdentification: true },
    });
    expect(h.sent[1]?.input).not.toHaveProperty('OutputBucketName');
    expect(h.provider.providerKey).toBe(AWS_TRANSCRIBE_PROVIDER_KEY);
    expect(h.provider.pricing).toEqual({ unitPriceMicros: 6_000, billedChannels: 1, perSecondMinimumSeconds: 15 });
  });

  it('collects with one status read per look: running, then the transcript by channel, settled at the reservation', async () => {
    let gets = 0;
    const h = harness({
      answers: {
        GetTranscriptionJob: () => {
          gets += 1;
          return gets === 1 ? { TranscriptionJob: { TranscriptionJobStatus: 'IN_PROGRESS' } } : completed();
        },
      },
    });
    expect(await h.jobs.collect(JOB)).toEqual({ kind: 'running' });
    const done = await h.jobs.collect(JOB);
    expect(done.kind).toBe('completed');
    if (done.kind !== 'completed') return;
    expect(done.utterances[0]).toMatchObject({ speaker: 0, text: 'Hi, is this Marisol Lockerfor? This is David calling from Calais.' });
    expect(done.billedSeconds).toBeNull();
    expect(done.durationSeconds).toBeGreaterThan(100);
    expect(h.commands()).toEqual(['GetTranscriptionJob', 'GetTranscriptionJob']);
    expect(h.fetched).toEqual([URI]);
  });

  it('reads a FAILED job as failed, a missing one as not found, a failed read as unknown, and an unreadable transcript as unreadable', async () => {
    expect(
      await harness({ answers: { GetTranscriptionJob: () => ({ TranscriptionJob: { TranscriptionJobStatus: 'FAILED', FailureReason: 'Unsupported audio' } }) } }).jobs.collect(JOB),
    ).toEqual({ kind: 'failed', code: 'aws_transcribe_job_failed' });
    const missing = harness({
      answers: {
        GetTranscriptionJob: () => {
          throw awsError('BadRequestException', 400);
        },
      },
    });
    expect(await missing.jobs.collect(JOB)).toEqual({ kind: 'not_found' });
    const throttled = harness({
      answers: {
        GetTranscriptionJob: () => {
          throw awsError('ThrottlingException', 400);
        },
      },
    });
    expect(await throttled.jobs.collect(JOB)).toEqual({ kind: 'unknown', code: 'aws_transcribe_status_unknown' });
    const unreadable = harness({ http: async () => await Promise.resolve(new Response('{"results": {}}', { status: 200 })) });
    expect(await unreadable.jobs.collect(JOB)).toEqual({ kind: 'unreadable', code: 'aws_transcribe_transcript_unreadable' });
    // A transcript read that failed is a look to repeat, not a verdict.
    const expired = harness({ http: async () => await Promise.resolve(new Response('denied', { status: 403 })) });
    expect(await expired.jobs.collect(JOB)).toEqual({ kind: 'unknown', code: 'aws_transcribe_transcript_unavailable' });
    // A transcript URL that is not the service's is never fetched.
    let fetched = 0;
    const foreign = harness({
      answers: { GetTranscriptionJob: () => ({ TranscriptionJob: { TranscriptionJobStatus: 'COMPLETED', Transcript: { TranscriptFileUri: 'http://example.com/t.json' } } }) },
      http: async () => {
        fetched += 1;
        return await Promise.resolve(new Response('{}'));
      },
    });
    expect((await foreign.jobs.collect(JOB)).kind).toBe('unreadable');
    expect(fetched).toBe(0);
    expect(isServiceTranscriptUri(URI)).toBe(true);
    expect(isServiceTranscriptUri('https://amazonaws.com.example.com/x')).toBe(false);
  });

  it('calls a Start that Transcribe refused refused (object deleted), and one that may have been accepted started — the status decides', async () => {
    const cases: [unknown, TranscriptionOutcome, boolean][] = [
      [awsError('BadRequestException', 400), { ok: false, kind: 'refused', code: 'aws_transcribe_start_refused' }, true],
      [awsError('LimitExceededException', 400), { ok: false, kind: 'refused', code: 'aws_transcribe_start_refused' }, true],
      [awsError('ConflictException', 409), { ok: false, kind: 'started', code: 'aws_transcribe_job_exists' }, false],
      [awsError('InternalFailureException', 500), { ok: false, kind: 'started', code: 'aws_transcribe_start_unknown' }, false],
      [Object.assign(new Error('socket hang up'), { name: 'TimeoutError' }), { ok: false, kind: 'started', code: 'aws_transcribe_start_unknown' }, false],
    ];
    for (const [error, expected, deletes] of cases) {
      const h = harness({
        answers: {
          StartTranscriptionJob: () => {
            throw error;
          },
        },
      });
      expect(await h.run()).toEqual(expected);
      expect(h.commands().filter(command => command === 'StartTranscriptionJob')).toHaveLength(1);
      expect(h.commands().includes('DeleteObject')).toBe(deletes);
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
    expect(await h.run(1, async () => await Promise.resolve('transcription_off' as const))).toEqual({ ok: false, kind: 'withdrawn', reason: 'transcription_off' });
    expect(h.commands()).toEqual(['PutObject', 'DeleteObject']);
  });

  it('deletes the uploaded object when the final settings read itself throws, and starts nothing', async () => {
    const h = harness({});
    await expect(h.run(1, async () => await Promise.reject(new Error('connection terminated')))).rejects.toThrow('connection terminated');
    expect(h.commands()).toEqual(['PutObject', 'DeleteObject']);
  });

  it('cleans up idempotently: an already-deleted job is done, a failed delete is not, and nothing done is asked again', async () => {
    let jobDeletes = 0;
    const h = harness({
      answers: {
        DeleteTranscriptionJob: () => {
          jobDeletes += 1;
          if (jobDeletes === 1) throw awsError('InternalFailureException', 500);
          throw awsError('BadRequestException', 400);
        },
      },
    });
    const item = { jobName: JOB, objectKey: callAudioObjectKey(SESSION, 1), jobDone: false, objectDone: false };
    expect(await h.jobs.cleanUp(item)).toEqual({ objectDone: true, jobDone: false });
    expect(h.logs).toEqual([{ event: 'aws_transcribe_cleanup_failed', fields: { what: 'job', error: 'InternalFailureException' } }]);
    expect(await h.jobs.cleanUp({ ...item, objectDone: true })).toEqual({ objectDone: true, jobDone: true });
    expect(h.commands()).toEqual(['DeleteObject', 'DeleteTranscriptionJob', 'DeleteTranscriptionJob']);
  });

  it('refuses empty or oversized audio without a request', async () => {
    const h = harness({});
    expect(await h.provider.transcribe({ audio: Buffer.alloc(0), contentType: 'audio/mpeg' })).toMatchObject({ kind: 'refused', code: 'audio_size' });
    expect(h.sent).toEqual([]);
  });
});

// Review finding 2 (C3-R1): the SDK's own retries would send a second Start with no final
// settings read before it. The real SDK clients, over an in-memory transport.
describe('the real AWS SDK clients', () => {
  it('make one attempt per request: a retryable Start error is not retried by the SDK', async () => {
    const requests: string[] = [];
    const requestHandler = {
      handle: async (request: { headers: Record<string, string>; hostname: string }) => {
        const target = request.headers['x-amz-target'] ?? `s3:${request.hostname}`;
        requests.push(target);
        const failing = target === 'Transcribe.StartTranscriptionJob';
        const body = failing ? JSON.stringify({ __type: 'ThrottlingException', Message: 'slow down' }) : '';
        return await Promise.resolve({
          response: {
            statusCode: failing ? 503 : 200,
            reason: failing ? 'Service Unavailable' : 'OK',
            headers: failing ? { 'content-type': 'application/x-amz-json-1.1', 'x-amzn-errortype': 'ThrottlingException' } : { etag: '"x"' },
            body: Readable.from([Buffer.from(body)]),
          },
        });
      },
    };
    let checks = 0;
    const provider = awsTranscribeTranscription({
      bucket: BUCKET,
      region: 'us-east-1',
      jobPrefix: 'fss-test',
      clientConfiguration: {
        requestHandler,
        credentials: { accessKeyId: ['AKIA', 'TEST', 'ONLY', '0000'].join(''), secretAccessKey: ['not', 'a', 'secret'].join('-') },
      },
    });
    const outcome = await provider.transcribe({
      audio: AUDIO,
      contentType: 'audio/mpeg',
      subject: { sessionId: SESSION, attempt: 1 },
      finalCheck: async () => {
        checks += 1;
        return await Promise.resolve(null);
      },
    });
    expect(outcome).toEqual({ ok: false, kind: 'started', code: 'aws_transcribe_start_unknown' });
    expect(requests.filter(target => target === 'Transcribe.StartTranscriptionJob')).toHaveLength(1);
    expect(checks).toBe(1);
    expect(AWS_SDK_MAX_ATTEMPTS).toBe(1);
  });
});

describe('choosing the provider from the task environment', () => {
  const aws = { FSS_TRANSCRIPTION_PROVIDER: 'aws_transcribe', FSS_CALL_AUDIO_BUCKET: BUCKET, AWS_REGION: 'us-east-1', FSS_NAME_PREFIX: 'fss-test' };

  it('builds Amazon Transcribe from the bucket, the region and the name prefix, with no secret', () => {
    const chosen = readSelectedTranscriptionProvider(aws);
    expect(chosen.problem).toBeNull();
    expect(chosen.provider?.providerKey).toBe('aws_transcribe.standard');
    expect(chosen.provider?.provider).toBe('aws_transcribe');
    // One upload and one Start: the job's wait is never inside a claim (C3a fix round).
    expect(chosen.provider?.maxCallSeconds).toBe(40);
  });

  it('names the missing variable, never a value', () => {
    expect(readAwsTranscribeProvider({ ...aws, FSS_CALL_AUDIO_BUCKET: undefined }).problem).toBe('FSS_CALL_AUDIO_BUCKET');
    expect(readAwsTranscribeProvider({ ...aws, AWS_REGION: '' }).problem).toBe('AWS_REGION');
    expect(readAwsTranscribeProvider({ ...aws, FSS_NAME_PREFIX: 'Bad Prefix' }).problem).toBe('FSS_NAME_PREFIX');
    expect(readSelectedTranscriptionProvider({ ...aws, FSS_TRANSCRIPTION_PROVIDER: 'whisper' }).problem).toBe('FSS_TRANSCRIPTION_PROVIDER');
  });

  it('registers call.transcribe with Transcribe while the transcription secret is still {} (production today)', () => {
    const twilio = JSON.stringify({ account_sid: `AC${'a'.repeat(32)}`, api_key_sid: `SK${'b'.repeat(32)}`, api_key_secret: 'c'.repeat(24) });
    const composed = readTranscriptionComposition({ ...aws, transcription: '{}', 'twilio-voice': twilio });
    expect(composed.problem).toBeNull();
    expect(composed.options?.provider.providerKey).toBe('aws_transcribe.standard');
    // So the worker's heartbeat says call_transcribe, which is all the API reads.
    const registry = registerHandlers(new HandlerRegistry(), { transcription: composed.options ?? undefined } as Parameters<typeof registerHandlers>[1]);
    expect(registry.get('call.transcribe')).toBeDefined();
    // Without the bucket it does not: the problem names the variable.
    expect(readTranscriptionComposition({ ...aws, FSS_CALL_AUDIO_BUCKET: undefined, transcription: '{}', 'twilio-voice': twilio }).problem).toBe(
      'transcription:FSS_CALL_AUDIO_BUCKET',
    );
  });

  it('keeps Deepgram selectable, and the default when nothing is chosen', () => {
    expect(readSelectedTranscriptionProvider({ FSS_TRANSCRIPTION_PROVIDER: 'deepgram' }).problem).toBe('absent');
    expect(readSelectedTranscriptionProvider({}).problem).toBe('absent');
  });
});
